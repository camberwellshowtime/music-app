import { useState, useEffect, useRef, Fragment } from 'react'
import { songs, songById, vocalsUrl, noVocalsUrl, isolatedUrl, lyricsUrl, melodyUrl } from './songs'
import SingAlong from './SingAlong'
import GestureMenu from './GestureMenu'
import { addBookmark, deleteBookmark, updateBookmark, createMashup, deleteMashup as deleteMashupDoc, updateMashupCues, pullOnce } from './db'
import { useBookmarks, useDownloads, useMashups, useSync } from './hooks'

const isStandalone = window.matchMedia('(display-mode: standalone)').matches || !!navigator.standalone

const _saved = (() => {
  try {
    const s = sessionStorage.getItem('music-restore')
    if (s) sessionStorage.removeItem('music-restore')
    return s ? JSON.parse(s) : null
  } catch { return null }
})()

const _hadController = !!navigator.serviceWorker?.controller

function fmt(s) {
  if (!isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

function BookmarkPill({ bm, loopStart, loopEnd, onSeek, onMenu, onGesture }) {
  const timerRef = useRef(null)
  const suppressRef = useRef(false)
  const dotsRef = useRef(null)

  const dotsPos = () => {
    const r = dotsRef.current?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  }

  const handlePointerDown = (e) => {
    if (e.button > 0) return // left button / touch only
    const x = e.clientX, y = e.clientY
    const pid = e.pointerId

    const cleanup = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
    }

    const onMove = (ev) => {
      if (ev.pointerId !== pid) return
      if (Math.hypot(ev.clientX - x, ev.clientY - y) > 10) {
        clearTimeout(timerRef.current)
        timerRef.current = null
        cleanup()
      }
    }

    const onUp = (ev) => {
      if (ev.pointerId !== pid) return
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      cleanup()
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null
      suppressRef.current = true
      cleanup()
      navigator.vibrate?.(20)
      const pos = dotsPos()
      onGesture(bm, pos?.x ?? x, pos?.y ?? y, pid)
    }, 400)

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
  }

  return (
    <span
      className={`flex items-center bg-gray-700 rounded-full text-xs select-none ${loopStart === bm.time ? 'ring-1 ring-green-500/60' : loopEnd === bm.time ? 'ring-1 ring-orange-500/60' : ''}`}
      onPointerDown={handlePointerDown}
      onContextMenu={e => e.preventDefault()}
    >
      <button
        onClick={() => { if (suppressRef.current) { suppressRef.current = false; return }; onSeek(bm.time) }}
        className='pl-2.5 pr-1 py-1 hover:text-white transition-colors whitespace-nowrap'
        title={fmt(bm.time)}
      >
        {bm.label}
      </button>
      <button
        ref={dotsRef}
        onClick={e => { e.stopPropagation(); onMenu(bm) }}
        className='pl-1 pr-2.5 py-1 text-gray-500 hover:text-white transition-colors'
        aria-label='Bookmark options'
      >⋯</button>
    </span>
  )
}

export default function App() {
  const [currentId, setCurrentId] = useState(_saved?.currentId ?? null)
  const [mode, setMode] = useState(_saved?.mode ?? 'vocals')
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [addingBookmark, setAddingBookmark] = useState(false)
  const [labelInput, setLabelInput] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState(null)
  const [loopActive, setLoopActive] = useState(_saved?.loopActive ?? false)
  const [loopStart, setLoopStart] = useState(_saved?.loopStart ?? null)
  const [loopEnd, setLoopEnd] = useState(_saved?.loopEnd ?? null)
  const [showLyrics, setShowLyrics] = useState(_saved?.showLyrics ?? false)
  const [lyricsHtml, setLyricsHtml] = useState(null)
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [singMode, setSingMode] = useState(false)
  const [editingBookmark, setEditingBookmark] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [editTime, setEditTime] = useState(0)
  const [bookmarkMenu, setBookmarkMenu] = useState(null)
  const [gestureMenu, setGestureMenu] = useState(null)

  // Mashup state
  const [editingCue, setEditingCue] = useState(null)
  const [editCueLabel, setEditCueLabel] = useState('')
  const [editCueStart, setEditCueStart] = useState(0)
  const [editCueEnd, setEditCueEnd] = useState(null)
  const [mashupPanelOpen, setMashupPanelOpen] = useState(false)
  const [activeMashupId, setActiveMashupId] = useState(() => localStorage.getItem('mashup-active-id'))
  const [mashupPlaying, setMashupPlaying] = useState(false)
  const [mashupCueIdx, setMashupCueIdx] = useState(0)
  const [creatingMashup, setCreatingMashup] = useState(false)
  const [newMashupName, setNewMashupName] = useState('')
  const [newMashupAuthor, setNewMashupAuthor] = useState(() => localStorage.getItem('mashup-author') ?? '')
  const pendingDeleteRef = useRef(null)
  const vocalsRef = useRef(null)
  const noVocalsRef = useRef(null)
  const isolatedRef = useRef(null)
  const pendingSeek = useRef(
    _saved?.currentId && _saved?.currentTime > 0
      ? { time: _saved.currentTime, play: false }
      : null
  )
  const loopStartRef = useRef(_saved?.loopStart ?? null)
  const loopEndRef = useRef(_saved?.loopEnd ?? null)
  const loopActiveRef = useRef(_saved?.loopActive ?? false)
  const pendingSwReload = useRef(false)
  const doReloadRef = useRef(null)
  const lyricsPushedRef = useRef(false)
  const bookmarkMenuPushedRef = useRef(false)
  const editBookmarkPushedRef = useRef(false)

  // Mashup refs
  const songDurationsRef = useRef({})
  const mashupPanelPushedRef = useRef(false)
  const mashupPlayingRef = useRef(false)
  const mashupCueIdxRef = useRef(0)
  const mashupCuesRef = useRef([])
  const advanceMashupRef = useRef(null)
  const activeCueRef = useRef(null)
  const activeMashupRef = useRef(null)
  const playerBarRef = useRef(null)
  const [playerHeight, setPlayerHeight] = useState(0)
  const wakeLockRef = useRef(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [dragging, setDragging] = useState(null) // { fromIdx, dropIdx }
  const draggingRef = useRef(null)

  const currentSong = currentId ? songById(currentId) : null
  const currentIdx = songs.findIndex(s => s.id === currentId)
  const allBookmarks = useBookmarks(currentId)
  const bookmarks = allBookmarks.filter(bm => bm._id !== pendingDeleteId)
  const { downloaded, downloading, download, downloadAll, refresh } = useDownloads()
  const { toggle: toggleSync, status: syncStatus, forceOn: syncForceOn } = useSync()
  const loopStartLabel = bookmarks.find(bm => bm.time === loopStart)?.label
  const loopEndLabel = bookmarks.find(bm => bm.time === loopEnd)?.label

  const mashups = useMashups()
  const activeMashup = mashups.find(m => m._id === activeMashupId) ?? null
  // Keep cues ref in sync every render so timeupdate always has fresh data
  mashupCuesRef.current = activeMashup?.cues ?? []
  activeMashupRef.current = activeMashup

  doReloadRef.current = () => {
    sessionStorage.setItem('music-restore', JSON.stringify({
      currentId,
      currentTime: vocalsRef.current?.currentTime ?? 0,
      mode,
      showLyrics,
      loopStart,
      loopEnd,
      loopActive,
    }))
    window.location.reload()
  }

  useEffect(() => {
    const sw = navigator.serviceWorker
    if (!sw) return
    const handler = (e) => {
      if (e.data?.type === 'sw-activated') {
        refresh()
        if (!_hadController) { pullOnce().catch(() => {}); return }
        if (vocalsRef.current && !vocalsRef.current.paused) {
          pendingSwReload.current = true
        } else {
          doReloadRef.current()
        }
      }
    }
    sw.addEventListener('message', handler)
    return () => sw.removeEventListener('message', handler)
  }, [refresh])

  useEffect(() => { if (isStandalone) downloadAll() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = () => pullOnce().catch(() => {})
    window.addEventListener('appinstalled', handler)
    return () => window.removeEventListener('appinstalled', handler)
  }, [])

  useEffect(() => {
    if (showLyrics) {
      history.pushState({ lyrics: true }, '')
      lyricsPushedRef.current = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = () => {
      if (editBookmarkPushedRef.current) {
        editBookmarkPushedRef.current = false
        setEditingBookmark(null)
      } else if (bookmarkMenuPushedRef.current) {
        bookmarkMenuPushedRef.current = false
        setBookmarkMenu(null)
      } else if (mashupPanelPushedRef.current) {
        mashupPanelPushedRef.current = false
        setMashupPanelOpen(false)
        setCreatingMashup(false)
      } else if (lyricsPushedRef.current) {
        lyricsPushedRef.current = false
        setShowLyrics(false)
      }
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  useEffect(() => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    const is = isolatedRef.current
    if (!va || !nv || !currentSong) return
    const pending = pendingSeek.current
    pendingSeek.current = null
    va.pause(); nv.pause(); is?.pause()
    va.dataset.songId = currentId
    va.src = vocalsUrl(currentSong)
    nv.src = noVocalsUrl(currentSong) ?? vocalsUrl(currentSong)
    if (is) {
      const isoUrl = isolatedUrl(currentSong)
      if (isoUrl) { is.src = isoUrl; is.load() }
      else is.src = ''
    }
    va.load(); nv.load()
    if (pending) {
      let vaReady = false, nvReady = false
      const tryStart = () => {
        if (!vaReady || !nvReady) return
        va.currentTime = pending.time
        nv.currentTime = pending.time
        if (is && is.src) is.currentTime = pending.time
        if (pending.play) {
          va.play().catch(() => {})
          nv.play().catch(() => {})
          if (is && is.src) is.play().catch(() => {})
        }
      }
      va.addEventListener('canplay', () => { vaReady = true; tryStart() }, { once: true })
      nv.addEventListener('canplay', () => { nvReady = true; tryStart() }, { once: true })
      nv.addEventListener('error',   () => { nvReady = true; tryStart() }, { once: true })
    }
  }, [currentId])

  useEffect(() => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    const is = isolatedRef.current
    if (!va || !nv) return
    va.muted  = mode !== 'vocals';    va.volume  = mode === 'vocals'      ? 1 : 0
    nv.muted  = mode !== 'no-vocals'; nv.volume  = mode === 'no-vocals'   ? 1 : 0
    if (is) { is.muted = mode !== 'vocals-only'; is.volume = mode === 'vocals-only' ? 1 : 0 }
  }, [mode])

  useEffect(() => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    if (!va || !nv) return
    const onTime = () => {
      setCurrentTime(va.currentTime)
      if (mashupPlayingRef.current) {
        const cues = mashupCuesRef.current
        const cue = cues[mashupCueIdxRef.current]
        if (cue?.endTime != null && va.currentTime >= cue.endTime) {
          advanceMashupRef.current?.()
        }
      } else {
        if (loopActiveRef.current &&
            loopStartRef.current !== null && loopEndRef.current !== null &&
            loopEndRef.current > loopStartRef.current &&
            va.currentTime >= loopEndRef.current) {
          va.currentTime = loopStartRef.current
          nv.currentTime = loopStartRef.current
          if (isolatedRef.current?.src) isolatedRef.current.currentTime = loopStartRef.current
        }
      }
    }
    const setPositionState = () => {
      if (!('mediaSession' in navigator)) return
      try {
        navigator.mediaSession.setPositionState?.({
          duration: isFinite(va.duration) ? va.duration : 0,
          playbackRate: va.playbackRate ?? 1,
          position: Math.min(va.currentTime, isFinite(va.duration) ? va.duration : va.currentTime),
        })
      } catch {}
    }
    const onDuration = () => {
      const d = isFinite(va.duration) ? va.duration : 0
      setDuration(d)
      if (d > 0) {
        const id = va.dataset.songId
        if (id) songDurationsRef.current[id] = d
      }
      setPositionState()
    }
    const onPlay = () => {
      setIsPlaying(true)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
      setPositionState()
    }
    const onPause = () => {
      setIsPlaying(false)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
      if (pendingSwReload.current) doReloadRef.current()
    }
    const onEnded = () => {
      nv.pause()
      isolatedRef.current?.pause()
      if (pendingSwReload.current) { doReloadRef.current(); return }
      if (mashupPlayingRef.current) {
        advanceMashupRef.current?.()
        return
      }
      setCurrentId(prev => {
        const idx = songs.findIndex(s => s.id === prev)
        if (idx < songs.length - 1) {
          pendingSeek.current = { time: 0, play: true }
          setMode('vocals')
          return songs[idx + 1].id
        }
        return prev
      })
    }
    va.addEventListener('timeupdate', onTime)
    va.addEventListener('loadedmetadata', onDuration)
    va.addEventListener('durationchange', onDuration)
    va.addEventListener('play', onPlay)
    va.addEventListener('pause', onPause)
    va.addEventListener('ended', onEnded)
    return () => {
      va.removeEventListener('timeupdate', onTime)
      va.removeEventListener('loadedmetadata', onDuration)
      va.removeEventListener('durationchange', onDuration)
      va.removeEventListener('play', onPlay)
      va.removeEventListener('pause', onPause)
      va.removeEventListener('ended', onEnded)
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      const va = vocalsRef.current
      const nv = noVocalsRef.current
      const is = isolatedRef.current
      if (!va || va.paused) return
      if (nv && Math.abs(va.currentTime - nv.currentTime) > 0.03) nv.currentTime = va.currentTime
      if (is?.src && Math.abs(va.currentTime - is.currentTime) > 0.03) is.currentTime = va.currentTime
    }, 500)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    loopStartRef.current = null
    loopEndRef.current = null
    loopActiveRef.current = false
    setLoopStart(null)
    setLoopEnd(null)
    setLoopActive(false)
    const song = songById(currentId)
    if (song && !song.isolatedFile) setMode(m => m === 'vocals-only' ? 'vocals' : m)
    return () => {
      if (pendingDeleteRef.current) {
        clearTimeout(pendingDeleteRef.current.timer)
        deleteBookmark(pendingDeleteRef.current.bookmark)
        pendingDeleteRef.current = null
      }
    }
  }, [currentId])

  const playSong = (song) => {
    if (song.id === currentId) {
      vocalsRef.current?.play().catch(() => {})
      noVocalsRef.current?.play().catch(() => {})
      if (isolatedRef.current?.src) isolatedRef.current.play().catch(() => {})
      return
    }
    stopMashup()
    pendingSeek.current = { time: 0, play: true }
    setCurrentId(song.id)
    setMode('vocals')
    setCurrentTime(0)
    setDuration(0)
  }

  const togglePlay = () => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    const is = isolatedRef.current
    if (!va || !currentSong) return
    if (va.paused) {
      va.play().catch(() => {})
      nv?.play().catch(() => {})
      if (is?.src) is.play().catch(() => {})
    } else {
      va.pause()
      nv?.pause()
      is?.pause()
    }
  }

  const seek = (time) => {
    if (vocalsRef.current) vocalsRef.current.currentTime = time
    if (noVocalsRef.current) noVocalsRef.current.currentTime = time
    if (isolatedRef.current?.src) isolatedRef.current.currentTime = time
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setPositionState?.({
          duration: isFinite(vocalsRef.current?.duration) ? vocalsRef.current.duration : 0,
          playbackRate: 1,
          position: time,
        })
      } catch {}
    }
  }

  // advanceMashupRef updated every render so it always captures current closures
  advanceMashupRef.current = () => {
    const cues = mashupCuesRef.current
    const nextIdx = mashupCueIdxRef.current + 1
    if (nextIdx >= cues.length) {
      mashupPlayingRef.current = false
      setMashupPlaying(false)
      mashupCueIdxRef.current = 0
      setMashupCueIdx(0)
      return
    }
    const next = cues[nextIdx]
    mashupCueIdxRef.current = nextIdx
    setMashupCueIdx(nextIdx)
    if (next.songId === currentId) {
      seek(next.time)
    } else {
      pendingSeek.current = { time: next.time, play: true }
      setCurrentId(next.songId)
      setMode('vocals')
      setCurrentTime(0)
      setDuration(0)
    }
  }

  const seekInMashupRef = useRef(null)
  seekInMashupRef.current = (delta) => {
    const cues = mashupCuesRef.current
    const idx = mashupCueIdxRef.current
    const cue = cues[idx]
    if (!cue) return
    const currentT = vocalsRef.current?.currentTime ?? cue.time
    const wasPlaying = !vocalsRef.current?.paused

    const jumpTo = (cueIdx, time) => {
      const target = cues[cueIdx]
      if (!target) return
      mashupCueIdxRef.current = cueIdx
      setMashupCueIdx(cueIdx)
      if (target.songId === currentId) {
        seek(time)
      } else {
        pendingSeek.current = { time, play: wasPlaying }
        setCurrentId(target.songId)
        setMode('vocals')
        setCurrentTime(0)
        setDuration(0)
      }
    }

    if (delta < 0) {
      const availBefore = currentT - cue.time
      if (-delta <= availBefore) {
        seek(currentT + delta)
      } else {
        const prev = cues[idx - 1]
        if (!prev) { seek(cue.time); return }
        const remainder = -delta - availBefore
        const prevEnd = prev.endTime ?? songDurationsRef.current[prev.songId] ?? null
        const landTime = prevEnd != null ? Math.max(prev.time, prevEnd - remainder) : prev.time
        jumpTo(idx - 1, landTime)
      }
    } else {
      if (cue.endTime == null) { seek(currentT + delta); return }
      const availAfter = cue.endTime - currentT
      if (delta <= availAfter) {
        seek(currentT + delta)
      } else {
        const next = cues[idx + 1]
        if (!next) { advanceMashupRef.current?.(); return }
        jumpTo(idx + 1, next.time + (delta - availAfter))
      }
    }
  }

  const switchMode = (newMode) => {
    if (newMode === mode || !currentSong) return
    setMode(newMode)
  }

  const prevSong = () => {
    if (currentIdx <= 0) return
    stopMashup()
    pendingSeek.current = { time: 0, play: !vocalsRef.current?.paused }
    setCurrentId(songs[currentIdx - 1].id)
    setMode('vocals')
  }

  const nextSong = () => {
    if (currentIdx >= songs.length - 1) return
    stopMashup()
    pendingSeek.current = { time: 0, play: !vocalsRef.current?.paused }
    setCurrentId(songs[currentIdx + 1].id)
    setMode('vocals')
  }

  const handleDeleteBookmark = (bm) => {
    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timer)
      deleteBookmark(pendingDeleteRef.current.bookmark)
    }
    const timer = setTimeout(() => {
      deleteBookmark(bm)
      pendingDeleteRef.current = null
      setPendingDeleteId(null)
    }, 5000)
    pendingDeleteRef.current = { bookmark: bm, timer }
    setPendingDeleteId(bm._id)
  }

  const handleUndoDelete = () => {
    if (!pendingDeleteRef.current) return
    clearTimeout(pendingDeleteRef.current.timer)
    pendingDeleteRef.current = null
    setPendingDeleteId(null)
  }

  const handleAddBookmark = async () => {
    if (!currentId || !labelInput.trim()) return
    await addBookmark(currentId, vocalsRef.current?.currentTime ?? 0, labelInput.trim())
    setLabelInput('')
    setAddingBookmark(false)
  }

  const handleBookmarkKeyDown = (e) => {
    if (e.key === 'Enter') handleAddBookmark()
    if (e.key === 'Escape') { setAddingBookmark(false); setLabelInput('') }
  }

  const openGestureMenu = (bm, anchorX, anchorY, pointerId) => {
    setBookmarkMenu(null)
    // bottomOffset: distance from viewport bottom to popup bottom edge
    // Place arrow tip just above the ⋯ button (anchorY = button centre Y from top)
    const bottomOffset = window.innerHeight - anchorY + 12
    setGestureMenu({ bookmark: bm, anchorX, touchOrigin: { x: anchorX, y: anchorY }, bottomOffset, pointerId })
  }

  const closeGestureMenu = () => setGestureMenu(null)

  const openBookmarkMenu = (bm) => {
    setGestureMenu(null)
    history.pushState({ bookmarkMenu: true }, '')
    bookmarkMenuPushedRef.current = true
    setBookmarkMenu(bm)
  }

  const closeBookmarkMenu = () => {
    setBookmarkMenu(null)
    if (bookmarkMenuPushedRef.current) {
      bookmarkMenuPushedRef.current = false
      history.back()
    }
  }

  const openEditBookmark = (bm) => {
    history.pushState({ editBookmark: true }, '')
    editBookmarkPushedRef.current = true
    setEditingBookmark(bm)
    setEditLabel(bm.label)
    setEditTime(bm.time)
  }

  const openEditFromMenu = (bm) => {
    setBookmarkMenu(null)
    if (bookmarkMenuPushedRef.current) {
      // Replace the bookmark-menu history entry rather than popping+pushing,
      // which would fire a popstate that sees editBookmarkPushedRef=true and close the modal.
      history.replaceState({ editBookmark: true }, '')
      bookmarkMenuPushedRef.current = false
    } else {
      history.pushState({ editBookmark: true }, '')
    }
    editBookmarkPushedRef.current = true
    setEditingBookmark(bm)
    setEditLabel(bm.label)
    setEditTime(bm.time)
  }

  const closeEditBookmark = () => {
    setEditingBookmark(null)
    if (editBookmarkPushedRef.current) {
      editBookmarkPushedRef.current = false
      history.back()
    }
  }

  const handleSaveBookmark = async () => {
    if (!editingBookmark || !editLabel.trim()) return
    await updateBookmark(editingBookmark, { label: editLabel.trim(), time: editTime })
    closeEditBookmark()
  }

  const nudgeTime = (delta) => {
    setEditTime(t => Math.max(0, Math.min(duration, t + delta)))
  }

  const handleEditKeyDown = (e) => {
    if (e.key === 'Enter') handleSaveBookmark()
    if (e.key === 'Escape') closeEditBookmark()
  }

  const clearLoop = () => {
    loopStartRef.current = null
    loopEndRef.current = null
    loopActiveRef.current = false
    setLoopStart(null)
    setLoopEnd(null)
    setLoopActive(false)
  }

  const openLyrics = () => {
    history.pushState({ lyrics: true }, '')
    lyricsPushedRef.current = true
    setShowLyrics(true)
  }

  const closeLyrics = () => {
    setShowLyrics(false)
    if (lyricsPushedRef.current) {
      lyricsPushedRef.current = false
      history.back()
    }
  }

  useEffect(() => {
    if (!currentSong || !showLyrics) { setLyricsHtml(null); return }
    setLyricsHtml(null)
    setLyricsLoading(true)
    fetch(lyricsUrl(currentSong))
      .then(r => r.ok ? r.text() : null)
      .then(html => { setLyricsHtml(html); setLyricsLoading(false) })
      .catch(() => { setLyricsHtml(null); setLyricsLoading(false) })
  }, [currentId, showLyrics])

  const setLoopA = (bm) => {
    loopStartRef.current = bm.time
    setLoopStart(bm.time)
    loopActiveRef.current = true
    setLoopActive(true)
  }

  const setLoopB = (bm) => {
    loopEndRef.current = bm.time
    setLoopEnd(bm.time)
    loopActiveRef.current = true
    setLoopActive(true)
  }

  useEffect(() => {
    if (mashupPlaying) activeCueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [mashupCueIdx, mashupPlaying])

  // ── Mashup handlers ────────────────────────────────────────────────────────

  const stopMashup = () => {
    mashupPlayingRef.current = false
    setMashupPlaying(false)
    mashupCueIdxRef.current = 0
    setMashupCueIdx(0)
  }

  const playMashupFromStart = () => {
    if (!activeMashup || activeMashup.cues.length === 0) return
    const cue = activeMashup.cues[0]
    mashupCueIdxRef.current = 0
    setMashupCueIdx(0)
    mashupPlayingRef.current = true
    setMashupPlaying(true)
    if (cue.songId === currentId) {
      seek(cue.time)
      vocalsRef.current?.play().catch(() => {})
      noVocalsRef.current?.play().catch(() => {})
      if (isolatedRef.current?.src) isolatedRef.current.play().catch(() => {})
    } else {
      pendingSeek.current = { time: cue.time, play: true }
      setCurrentId(cue.songId)
      setMode('vocals')
    }
  }

  const jumpToMashupCue = (idx) => {
    const cues = activeMashup?.cues ?? []
    const cue = cues[idx]
    if (!cue) return
    mashupCueIdxRef.current = idx
    setMashupCueIdx(idx)
    const wasPlaying = !vocalsRef.current?.paused
    if (cue.songId === currentId) {
      seek(cue.time)
    } else {
      pendingSeek.current = { time: cue.time, play: wasPlaying }
      setCurrentId(cue.songId)
      setMode('vocals')
    }
  }

  const addCueFromBookmark = async (bm) => {
    if (!activeMashup || !currentId) return
    const nextBm = bookmarks.find(b => b.time > bm.time)
    const endTime = nextBm?.time ?? null
    const cueLabel = `${bm.label} · ${currentSong?.title ?? currentId}`
    const newCue = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, songId: currentId, time: bm.time, endTime, label: cueLabel }
    await updateMashupCues(activeMashup, [...(activeMashup.cues ?? []), newCue])
  }

  const openEditCue = (cue) => {
    setEditingCue(cue)
    setEditCueLabel(cue.label)
    setEditCueStart(cue.time)
    setEditCueEnd(cue.endTime)
  }

  const closeEditCue = () => setEditingCue(null)

  const handleSaveCue = async () => {
    if (!activeMashup || !editingCue || !editCueLabel.trim()) return
    const newCues = activeMashup.cues.map(c =>
      c.id === editingCue.id
        ? { ...c, label: editCueLabel.trim(), time: editCueStart, endTime: editCueEnd }
        : c
    )
    await updateMashupCues(activeMashup, newCues)
    closeEditCue()
  }

  const nudgeCueStart = (delta) => {
    setEditCueStart(t => {
      const next = Math.max(0, t + delta)
      return editCueEnd !== null && next >= editCueEnd ? t : next
    })
  }

  const nudgeCueEnd = (delta) => {
    setEditCueEnd(t => t === null ? null : Math.max(editCueStart + 1, t + delta))
  }

  const handleEditCueKeyDown = (e) => {
    if (e.key === 'Enter') handleSaveCue()
    if (e.key === 'Escape') closeEditCue()
  }

  const removeMashupCue = async (cueId) => {
    if (!activeMashup) return
    const newCues = activeMashup.cues.filter(c => c.id !== cueId)
    await updateMashupCues(activeMashup, newCues)
    if (mashupCueIdxRef.current >= newCues.length) {
      const next = Math.max(0, newCues.length - 1)
      mashupCueIdxRef.current = next
      setMashupCueIdx(next)
    }
  }

  const handleCreateMashup = async () => {
    const name = newMashupName.trim()
    const author = newMashupAuthor.trim() || 'Unknown'
    if (!name) return
    localStorage.setItem('mashup-author', author)
    const mashup = await createMashup(name, author)
    setActiveMashupId(mashup._id)
    localStorage.setItem('mashup-active-id', mashup._id)
    setCreatingMashup(false)
    setNewMashupName('')
  }

  const handleCreateKeyDown = (e) => {
    if (e.key === 'Enter') handleCreateMashup()
    if (e.key === 'Escape') setCreatingMashup(false)
  }

  const selectMashup = (id) => {
    setActiveMashupId(id)
    localStorage.setItem('mashup-active-id', id)
    stopMashup()
  }

  const handleDeleteMashup = async (mashup) => {
    await deleteMashupDoc(mashup)
    if (activeMashupId === mashup._id) {
      setActiveMashupId(null)
      localStorage.removeItem('mashup-active-id')
      stopMashup()
    }
  }

  const startCueDrag = (fromIdx, e) => {
    e.preventDefault()
    const state = { fromIdx, dropIdx: fromIdx }
    draggingRef.current = state
    setDragging({ ...state })

    const onMove = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const row = el?.closest('[data-cueidx]')
      let di = draggingRef.current?.dropIdx ?? fromIdx
      if (row) {
        const idx = parseInt(row.dataset.cueidx, 10)
        if (!isNaN(idx)) {
          const r = row.getBoundingClientRect()
          di = ev.clientY < r.top + r.height / 2 ? idx : idx + 1
        }
      }
      if (draggingRef.current) draggingRef.current.dropIdx = di
      setDragging(d => d ? { ...d, dropIdx: di } : null)
    }

    const onUp = async () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      const s = draggingRef.current
      draggingRef.current = null
      setDragging(null)
      const mashup = activeMashupRef.current
      if (!s || !mashup) return
      const { fromIdx: from, dropIdx: to } = s
      if (from === to || from + 1 === to) return
      const cues = [...mashup.cues]
      const [item] = cues.splice(from, 1)
      cues.splice(to > from ? to - 1 : to, 0, item)
      await updateMashupCues(mashup, cues)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const openMashupPanel = () => {
    history.pushState({ mashupPanel: true }, '')
    mashupPanelPushedRef.current = true
    setMashupPanelOpen(true)
  }

  const closeMashupPanel = () => {
    setMashupPanelOpen(false)
    setCreatingMashup(false)
    if (mashupPanelPushedRef.current) {
      mashupPanelPushedRef.current = false
      history.back()
    }
  }

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (mashupPlaying && activeMashup) {
      const cue = activeMashup.cues[mashupCueIdx]
      ms.metadata = new MediaMetadata({
        title: activeMashup.name,
        artist: cue?.label ?? '',
        album: 'The Happy Place 2026',
      })
    } else if (currentSong) {
      ms.metadata = new MediaMetadata({
        title: currentSong.title,
        album: 'The Happy Place 2026',
      })
    } else {
      ms.metadata = null
    }
  }, [currentId, mashupPlaying, activeMashupId, mashupCueIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.setActionHandler('play', () => {
      vocalsRef.current?.play().catch(() => {})
      noVocalsRef.current?.play().catch(() => {})
      if (isolatedRef.current?.src) isolatedRef.current.play().catch(() => {})
    })
    ms.setActionHandler('pause', () => {
      vocalsRef.current?.pause()
      noVocalsRef.current?.pause()
      isolatedRef.current?.pause()
    })
    ms.setActionHandler('previoustrack', () => {
      if (mashupPlayingRef.current) jumpToMashupCue(mashupCueIdxRef.current - 1)
      else prevSong()
    })
    ms.setActionHandler('nexttrack', () => {
      if (mashupPlayingRef.current) advanceMashupRef.current?.()
      else nextSong()
    })
    ms.setActionHandler('seekbackward', (d) => {
      const skip = d.seekOffset ?? 5
      if (mashupPlayingRef.current) seekInMashupRef.current(-skip)
      else seek(Math.max(0, (vocalsRef.current?.currentTime ?? 0) - skip))
    })
    ms.setActionHandler('seekforward', (d) => {
      const skip = d.seekOffset ?? 5
      if (mashupPlayingRef.current) seekInMashupRef.current(skip)
      else seek(Math.min(vocalsRef.current?.duration ?? 0, (vocalsRef.current?.currentTime ?? 0) + skip))
    })
    return () => {
      for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward']) {
        try { ms.setActionHandler(a, null) } catch {}
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = playerBarRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const h = entries[0].borderBoxSize?.[0]?.blockSize ?? entries[0].contentRect.height
      setPlayerHeight(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const acquireWakeLock = async () => {
    if (!('wakeLock' in navigator)) return
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen')
      wakeLockRef.current.addEventListener('release', () => {
        wakeLockRef.current = null
        setWakeLockActive(false)
      })
      setWakeLockActive(true)
    } catch {}
  }

  const toggleWakeLock = async () => {
    if (wakeLockRef.current) {
      await wakeLockRef.current.release()
    } else {
      await acquireWakeLock()
    }
  }

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible' && wakeLockActive && !wakeLockRef.current) {
        acquireWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [wakeLockActive])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className='min-h-screen bg-gray-950 text-gray-100 flex flex-col'>
      <audio ref={vocalsRef} preload='metadata' playsInline />
      <audio ref={noVocalsRef} preload='metadata' playsInline />
      <audio ref={isolatedRef} preload='metadata' playsInline />

      {bookmarkMenu && (
        <div className='fixed inset-0 z-50 flex flex-col justify-end' onClick={closeBookmarkMenu}>
          <div className='bg-gray-800 rounded-t-2xl shadow-2xl' onClick={e => e.stopPropagation()}>
            <div className='px-5 pt-5 pb-3 border-b border-gray-700/60'>
              <div className='text-sm font-semibold text-white'>{bookmarkMenu.label}</div>
              <div className='text-xs text-gray-400 tabular-nums mt-0.5'>{fmt(bookmarkMenu.time)}</div>
            </div>
            <div className='py-1'>
              <button onClick={() => { seek(bookmarkMenu.time); closeBookmarkMenu() }} className='w-full text-left px-5 py-4 text-sm text-gray-200 active:bg-gray-700'>
                Seek to {bookmarkMenu.label} ({fmt(bookmarkMenu.time)})
              </button>
              <button onClick={() => { setLoopA(bookmarkMenu); closeBookmarkMenu() }} className={`w-full text-left px-5 py-4 text-sm active:bg-gray-700 ${loopStart === bookmarkMenu.time ? 'text-green-400' : 'text-gray-200'}`}>
                {loopStart === bookmarkMenu.time ? '✓ Loop start' : 'Set loop start'}
              </button>
              <button onClick={() => { setLoopB(bookmarkMenu); closeBookmarkMenu() }} className={`w-full text-left px-5 py-4 text-sm active:bg-gray-700 ${loopEnd === bookmarkMenu.time ? 'text-orange-400' : 'text-gray-200'}`}>
                {loopEnd === bookmarkMenu.time ? '✓ Loop end' : 'Set loop end'}
              </button>
              {activeMashup && (
                <button onClick={() => { addCueFromBookmark(bookmarkMenu); closeBookmarkMenu() }} className='w-full text-left px-5 py-4 text-sm text-purple-400 active:bg-gray-700'>
                  Add to mashup "{activeMashup.name}"
                </button>
              )}
              <button onClick={() => openEditFromMenu(bookmarkMenu)} className='w-full text-left px-5 py-4 text-sm text-gray-200 active:bg-gray-700'>
                Edit
              </button>
              <button onClick={() => { handleDeleteBookmark(bookmarkMenu); closeBookmarkMenu() }} className='w-full text-left px-5 py-4 text-sm text-red-400 active:bg-gray-700'>
                Delete
              </button>
            </div>
            <div className='pb-8' />
          </div>
        </div>
      )}

      {gestureMenu && (
        <GestureMenu
          bookmark={gestureMenu.bookmark}
          anchorX={gestureMenu.anchorX}
          touchOrigin={gestureMenu.touchOrigin}
          bottomOffset={gestureMenu.bottomOffset}
          mode='gesture'
          loopStart={loopStart}
          loopEnd={loopEnd}
          onLoopA={(bm) => setLoopA(bm)}
          onLoopB={(bm) => setLoopB(bm)}
          onEdit={(bm) => openEditBookmark(bm)}
          onDelete={(bm) => handleDeleteBookmark(bm)}
          onClose={closeGestureMenu}
          pointerId={gestureMenu.pointerId}
          activeMashupName={activeMashup?.name}
          onMashup={(bm) => addCueFromBookmark(bm)}
        />
      )}

      {editingBookmark && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60' onClick={closeEditBookmark}>
          <div className='bg-gray-800 rounded-xl p-5 w-72 shadow-2xl' onClick={e => e.stopPropagation()}>
            <h3 className='text-sm font-semibold text-white mb-4'>Edit bookmark</h3>
            <input
              autoFocus
              value={editLabel}
              onChange={e => setEditLabel(e.target.value)}
              onKeyDown={handleEditKeyDown}
              placeholder='Label…'
              className='w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 outline-none focus:border-gray-400 mb-4'
            />
            <div className='flex items-center gap-2 mb-5'>
              <span className='text-xs text-gray-400 shrink-0'>Time</span>
              <div className='flex items-center gap-1 flex-1 justify-center'>
                {[-5, -1, 1, 5].map(d => (
                  <button
                    key={d}
                    onClick={() => nudgeTime(d)}
                    className='text-xs px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors tabular-nums'
                  >{d > 0 ? `+${d}s` : `${d}s`}</button>
                ))}
              </div>
              <span className='text-xs text-white tabular-nums w-8 text-right'>{fmt(editTime)}</span>
            </div>
            <div className='flex gap-2'>
              <button onClick={closeEditBookmark} className='flex-1 text-sm py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors'>Cancel</button>
              <button onClick={handleSaveBookmark} className='flex-1 text-sm py-2 rounded-lg bg-white text-gray-900 hover:bg-gray-200 font-medium transition-colors'>Save</button>
            </div>
          </div>
        </div>
      )}

      {editingCue && (
        <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/60' onClick={closeEditCue}>
          <div className='bg-gray-800 rounded-xl p-5 w-80 shadow-2xl' onClick={e => e.stopPropagation()}>
            <h3 className='text-sm font-semibold text-white mb-4'>Edit cue</h3>
            <input
              autoFocus
              value={editCueLabel}
              onChange={e => setEditCueLabel(e.target.value)}
              onKeyDown={handleEditCueKeyDown}
              placeholder='Label…'
              className='w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 outline-none focus:border-gray-400 mb-4'
            />
            <div className='flex items-center gap-2 mb-3'>
              <span className='text-xs text-gray-400 w-8 shrink-0'>Start</span>
              <div className='flex items-center gap-1 flex-1 justify-center'>
                {[-5, -1, 1, 5].map(d => (
                  <button key={d} onClick={() => nudgeCueStart(d)} className='text-xs px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors tabular-nums'>
                    {d > 0 ? `+${d}s` : `${d}s`}
                  </button>
                ))}
              </div>
              <span className='text-xs text-white tabular-nums w-10 text-right'>{fmt(editCueStart)}</span>
            </div>
            <div className='flex items-center gap-2 mb-5'>
              <span className='text-xs text-gray-400 w-8 shrink-0'>End</span>
              {editCueEnd === null ? (
                <div className='flex-1 flex items-center gap-2'>
                  <span className='text-xs text-gray-500 flex-1 italic'>until song ends</span>
                  <button onClick={() => setEditCueEnd(editCueStart + 30)} className='text-xs px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors'>Set</button>
                </div>
              ) : (
                <>
                  <div className='flex items-center gap-1 flex-1 justify-center'>
                    {[-5, -1, 1, 5].map(d => (
                      <button key={d} onClick={() => nudgeCueEnd(d)} className='text-xs px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors tabular-nums'>
                        {d > 0 ? `+${d}s` : `${d}s`}
                      </button>
                    ))}
                  </div>
                  <span className='text-xs text-white tabular-nums w-10 text-right'>{fmt(editCueEnd)}</span>
                  <button onClick={() => setEditCueEnd(null)} className='text-xs text-gray-500 hover:text-white transition-colors leading-none' title='Clear end time'>✕</button>
                </>
              )}
            </div>
            <div className='flex gap-2'>
              <button onClick={closeEditCue} className='flex-1 text-sm py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors'>Cancel</button>
              <button onClick={handleSaveCue} disabled={!editCueLabel.trim()} className='flex-1 text-sm py-2 rounded-lg bg-white text-gray-900 hover:bg-gray-200 font-medium transition-colors disabled:opacity-40'>Save</button>
            </div>
          </div>
        </div>
      )}

      {mashupPanelOpen && (
        <div className='fixed inset-0 z-50 flex flex-col justify-end' onClick={closeMashupPanel}>
          <div className='bg-gray-800 rounded-t-2xl shadow-2xl max-h-[80vh] flex flex-col' onClick={e => e.stopPropagation()}>
            <div className='px-5 pt-5 pb-3 border-b border-gray-700/60 flex items-center justify-between shrink-0'>
              <h2 className='text-sm font-semibold text-white'>Mashups</h2>
              <button onClick={closeMashupPanel} className='text-gray-500 hover:text-white text-lg leading-none px-1'>✕</button>
            </div>

            {creatingMashup ? (
              <div className='px-5 py-4 space-y-3'>
                <p className='text-xs text-gray-400 font-medium uppercase tracking-wide'>New mashup</p>
                {!localStorage.getItem('mashup-author') && (
                  <input
                    autoFocus
                    value={newMashupAuthor}
                    onChange={e => setNewMashupAuthor(e.target.value)}
                    onKeyDown={handleCreateKeyDown}
                    placeholder='Your name…'
                    className='w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 outline-none focus:border-gray-400'
                  />
                )}
                <input
                  autoFocus={!!localStorage.getItem('mashup-author')}
                  value={newMashupName}
                  onChange={e => setNewMashupName(e.target.value)}
                  onKeyDown={handleCreateKeyDown}
                  placeholder='Mashup name…'
                  className='w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 outline-none focus:border-gray-400'
                />
                <div className='flex gap-2 pt-1'>
                  <button onClick={() => setCreatingMashup(false)} className='flex-1 text-sm py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors'>Cancel</button>
                  <button onClick={handleCreateMashup} disabled={!newMashupName.trim()} className='flex-1 text-sm py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium transition-colors disabled:opacity-40'>Create</button>
                </div>
              </div>
            ) : (
              <div className='overflow-y-auto flex-1'>
                {activeMashup && (
                  <div className='px-5 py-4 border-b border-gray-700/40'>
                    <div className='flex items-start justify-between mb-3 gap-3'>
                      <div className='min-w-0'>
                        <div className='text-sm font-semibold text-white truncate'>{activeMashup.name}</div>
                        <div className='text-xs text-gray-400'>by {activeMashup.author}</div>
                      </div>
                      <div className='flex gap-2 shrink-0'>
                        {mashupPlaying ? (
                          <button onClick={stopMashup} className='text-xs px-3 py-1.5 rounded-lg border border-red-800/60 bg-red-900/30 text-red-400 transition-colors'>Stop</button>
                        ) : (
                          <button
                            onClick={() => { playMashupFromStart(); closeMashupPanel() }}
                            disabled={activeMashup.cues.length === 0}
                            className='text-xs px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors disabled:opacity-40'
                          >Play</button>
                        )}
                        <button onClick={() => handleDeleteMashup(activeMashup)} className='text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-800/60 transition-colors'>Delete</button>
                      </div>
                    </div>
                    {activeMashup.cues.length === 0 ? (
                      <p className='text-xs text-gray-500 py-1'>No cues yet — use ⋯ on any bookmark to add one.</p>
                    ) : (
                      <div className='flex flex-col gap-1.5'>
                        {dragging?.dropIdx === 0 && <div className='h-0.5 bg-purple-500 rounded mx-1 shrink-0' />}
                        {activeMashup.cues.map((cue, i) => {
                          const isDragging = dragging?.fromIdx === i
                          return (
                            <Fragment key={cue.id}>
                              <div
                                data-cueidx={i}
                                className={[
                                  'flex items-center gap-2 text-xs rounded-lg px-2 py-2 select-none',
                                  mashupPlaying && mashupCueIdx === i ? 'bg-purple-900/50 ring-1 ring-purple-700/60' : 'bg-gray-700/60',
                                  isDragging ? 'opacity-30 pointer-events-none' : '',
                                ].join(' ')}
                              >
                                <span
                                  className='text-gray-600 hover:text-gray-400 px-1 shrink-0 cursor-grab active:cursor-grabbing text-sm leading-none'
                                  style={{ touchAction: 'none' }}
                                  onPointerDown={e => startCueDrag(i, e)}
                                >⠿</span>
                                <span className='text-gray-500 w-4 tabular-nums shrink-0'>{i + 1}</span>
                                <span className={`flex-1 truncate ${mashupPlaying && mashupCueIdx === i ? 'text-purple-200' : 'text-gray-300'}`}>{cue.label}</span>
                                <span className='text-gray-500 tabular-nums shrink-0'>
                                  {fmt(cue.time)}{cue.endTime != null ? `–${fmt(cue.endTime)}` : ''}
                                </span>
                                <button onClick={() => { jumpToMashupCue(i); closeMashupPanel() }} className='text-gray-500 hover:text-white px-1 shrink-0' aria-label='Jump to cue'>▶</button>
                                <button onClick={() => openEditCue(cue)} className='text-gray-500 hover:text-white px-1 shrink-0' aria-label='Edit cue'>✎</button>
                                <button onClick={() => removeMashupCue(cue.id)} className='text-gray-600 hover:text-red-400 px-1 shrink-0' aria-label='Remove cue'>✕</button>
                              </div>
                              {dragging?.dropIdx === i + 1 && <div className='h-0.5 bg-purple-500 rounded mx-1 shrink-0' />}
                            </Fragment>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}

                <div className='px-5 py-4'>
                  <div className='flex items-center justify-between mb-3'>
                    <p className='text-xs text-gray-400 font-medium uppercase tracking-wide'>
                      {activeMashup ? 'Other mashups' : 'Saved mashups'}
                    </p>
                    <button onClick={() => setCreatingMashup(true)} className='text-xs text-purple-400 hover:text-purple-300 transition-colors'>+ New</button>
                  </div>
                  {mashups.filter(m => m._id !== activeMashupId).length === 0 ? (
                    <p className='text-xs text-gray-500'>{activeMashup ? 'No other mashups.' : 'No mashups yet.'}</p>
                  ) : (
                    <div className='space-y-0.5'>
                      {mashups.filter(m => m._id !== activeMashupId).map(m => (
                        <div key={m._id} className='flex items-center gap-3 py-2.5 border-b border-gray-700/30 last:border-0'>
                          <button onClick={() => selectMashup(m._id)} className='flex-1 text-left min-w-0'>
                            <div className='text-sm text-gray-200 truncate'>{m.name}</div>
                            <div className='text-xs text-gray-500'>by {m.author} · {m.cues.length} cue{m.cues.length !== 1 ? 's' : ''}</div>
                          </button>
                          <button onClick={() => handleDeleteMashup(m)} className='text-xs text-gray-600 hover:text-red-400 transition-colors shrink-0 px-1'>Delete</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className='pb-8 shrink-0' />
          </div>
        </div>
      )}

      <header className='sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between gap-3'>
        <h1 className='text-base font-bold text-white shrink-0'>The Happy Place</h1>
        <div className='flex items-center gap-2'>
          {!isStandalone && downloaded.size < songs.length && (
            <button
              onClick={downloadAll}
              className='text-xs px-3 py-1.5 rounded-full bg-gray-700 hover:bg-gray-600 transition-colors whitespace-nowrap'
            >
              Download all
            </button>
          )}
          {'wakeLock' in navigator && (
            <button
              onClick={toggleWakeLock}
              title={wakeLockActive ? 'Screen stay-on: on' : 'Screen stay-on: off'}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${wakeLockActive ? 'border-amber-500 text-amber-400' : 'border-gray-600 text-gray-500 hover:text-white hover:border-gray-400'}`}
            >☀</button>
          )}
          <button
            onClick={toggleSync}
            title={syncForceOn ? `Sync always on (${syncStatus})` : syncStatus === 'off' ? 'Sync off — tap to enable' : `Sync ${syncStatus} — tap to disable`}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              syncStatus === 'connected' ? 'border-green-600 text-green-400' :
              syncStatus === 'syncing'   ? 'border-blue-600 text-blue-400' :
              syncStatus === 'error'     ? 'border-orange-600 text-orange-400' :
                                          'border-gray-600 text-gray-500 hover:text-white hover:border-gray-400'
            }`}
          >
            {syncStatus === 'connected' ? '⇅ Synced' :
             syncStatus === 'syncing'   ? '↻ Syncing' :
             syncStatus === 'error'     ? '⚠ Sync' :
                                         '⇅ Sync'}
          </button>
          <button
            onClick={() => mashupPanelOpen ? closeMashupPanel() : openMashupPanel()}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${(mashupPanelOpen || mashupPlaying) ? 'border-purple-500 text-purple-400' : 'border-gray-600 text-gray-500 hover:text-white hover:border-gray-400'}`}
          >
            Mashups
          </button>
        </div>
      </header>

      <main className='flex-1 overflow-y-auto' style={{ paddingBottom: currentSong ? playerHeight : 0 }}>
        {showLyrics && currentSong ? (
          <div className='px-4 py-4'>
            <div className='flex justify-end mb-2'>
              <button
                onClick={closeLyrics}
                className='text-gray-500 hover:text-white transition-colors text-lg leading-none px-1'
                aria-label='Close lyrics'
              >✕</button>
            </div>
            {lyricsLoading ? (
              <p className='text-gray-500 text-sm'>Loading…</p>
            ) : lyricsHtml ? (
              <div className='lyrics-content' dangerouslySetInnerHTML={{ __html: lyricsHtml }} />
            ) : (
              <p className='text-gray-500 text-sm'>No lyrics available for this song.</p>
            )}
          </div>
        ) : null}
        <div className={showLyrics && currentSong ? 'hidden' : ''}>
        {songs.map(song => {
          const isActive = song.id === currentId
          const isDownloaded = downloaded.has(song.id)
          const isDownloading = downloading.has(song.id)
          return (
            <div
              key={song.id}
              className={`flex items-center gap-3 px-4 py-3.5 border-b border-gray-800/60 cursor-pointer select-none transition-colors ${isActive ? 'bg-gray-800' : 'hover:bg-gray-900'}`}
              onClick={() => playSong(song)}
            >
              <span className='text-gray-500 text-sm w-10 shrink-0 tabular-nums'>{song.id}</span>
              <span className={`flex-1 text-sm ${isActive ? 'text-white font-medium' : 'text-gray-200'}`}>
                {song.title}
              </span>
              {!isStandalone && (
                <button
                  onClick={e => { e.stopPropagation(); if (!isDownloaded && !isDownloading) download(song) }}
                  disabled={isDownloading}
                  className={`w-7 h-7 flex items-center justify-center rounded-full shrink-0 transition-colors text-sm ${isDownloaded ? 'text-green-400 cursor-default' : isDownloading ? 'text-gray-500 cursor-default' : 'text-gray-500 hover:text-white hover:bg-gray-700'}`}
                  title={isDownloaded ? 'Downloaded' : isDownloading ? 'Downloading…' : 'Download for offline'}
                >
                  {isDownloaded ? '✓' : isDownloading ? '…' : '↓'}
                </button>
              )}
            </div>
          )
        })}
        </div>
      </main>

      {mashupPlaying && activeMashup && (() => {
        const cues = activeMashup.cues
        let totalSecs = 0, hasUnknown = false
        for (const c of cues) {
          if (c.endTime != null) {
            totalSecs += c.endTime - c.time
          } else {
            const songDur = songDurationsRef.current[c.songId]
            if (songDur) totalSecs += songDur - c.time
            else hasUnknown = true
          }
        }
        const durStr = (cues.length > 0 && totalSecs > 0) ? (hasUnknown ? `~${fmt(totalSecs)}+` : fmt(totalSecs)) : null
        return (
        <div className='fixed inset-0 z-20 bg-gray-950 flex flex-col' style={{ paddingBottom: playerHeight }}>
          <div className='px-4 py-3 bg-gray-900 border-b border-purple-900/50 flex items-center gap-3 shrink-0'>
            <div className='flex-1 min-w-0'>
              <div className='text-[10px] text-purple-400 font-medium uppercase tracking-widest'>Mashup</div>
              <div className='text-white font-bold text-base leading-tight truncate'>{activeMashup.name}</div>
              <div className='text-xs text-gray-500 leading-tight'>
                by {activeMashup.author}{durStr ? <span className='ml-2 tabular-nums'>{durStr}</span> : null}
              </div>
            </div>
            <button
              onClick={stopMashup}
              className='shrink-0 text-xs px-3 py-1.5 rounded-lg border border-red-800/60 bg-red-900/20 text-red-400 hover:bg-red-900/40 transition-colors'
            >Stop</button>
          </div>
          <div className='flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-1.5'>
            {dragging?.dropIdx === 0 && <div className='h-0.5 bg-purple-500 rounded mx-1 shrink-0' />}
            {activeMashup.cues.map((cue, i) => {
              const isActive = mashupCueIdx === i
              const isPast = i < mashupCueIdx
              const isDragging = dragging?.fromIdx === i
              return (
                <Fragment key={cue.id}>
                  <div
                    data-cueidx={i}
                    ref={isActive ? activeCueRef : null}
                    onClick={() => !dragging && jumpToMashupCue(i)}
                    className={[
                      'flex items-center gap-2 px-2 py-2.5 rounded-xl transition-colors cursor-pointer select-none',
                      isActive ? 'bg-purple-900/50 ring-1 ring-purple-700/60' : isPast ? 'bg-gray-800/20 opacity-40' : 'bg-gray-800/40 hover:bg-gray-700/50',
                      isDragging ? 'opacity-30 pointer-events-none' : '',
                    ].join(' ')}
                  >
                    <span
                      className='text-gray-600 hover:text-gray-400 px-1 shrink-0 cursor-grab active:cursor-grabbing text-base leading-none'
                      style={{ touchAction: 'none' }}
                      onPointerDown={e => startCueDrag(i, e)}
                      onClick={e => e.stopPropagation()}
                    >⠿</span>
                    <span className={`text-xs tabular-nums w-5 shrink-0 text-right ${isActive ? 'text-purple-400 font-bold' : 'text-gray-600'}`}>{i + 1}</span>
                    <span className={`flex-1 text-sm truncate ${isActive ? 'text-white font-medium' : 'text-gray-400'}`}>{cue.label}</span>
                    <span className={`text-xs tabular-nums shrink-0 ${isActive ? 'text-purple-300' : 'text-gray-600'}`}>
                      {fmt(cue.time)}{cue.endTime != null ? `–${fmt(cue.endTime)}` : ''}
                    </span>
                  </div>
                  {dragging?.dropIdx === i + 1 && <div className='h-0.5 bg-purple-500 rounded mx-1 shrink-0' />}
                </Fragment>
              )
            })}
          </div>
        </div>
        )
      })()}

      {currentSong && (
        <div ref={playerBarRef} className='fixed bottom-0 left-0 right-0 z-30 bg-gray-900 border-t border-gray-700 shadow-2xl'>
          {singMode && (
            <SingAlong
              song={currentSong}
              currentTime={currentTime}
              isPlaying={isPlaying}
              melodyUrl={melodyUrl(currentSong)}
              onClose={() => setSingMode(false)}
              duration={duration}
              onPlayPause={togglePlay}
              bookmarks={bookmarks}
              onSeek={seek}
              loopActive={loopActive}
              loopStart={loopStart}
              loopEnd={loopEnd}
              onLoopToggle={() => setLoopActive(v => { loopActiveRef.current = !v; return !v })}
            />
          )}
        <div className='px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] space-y-2.5'>
          <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3'>
            {mashupPlaying && activeMashup ? (
              <div className='min-w-0'>
                <div className='text-[10px] text-purple-400 font-medium uppercase tracking-widest'>Mashup</div>
                <div className='text-white font-semibold text-sm leading-tight truncate'>{activeMashup.name}</div>
              </div>
            ) : (
              <div className='min-w-0'>
                <div className='text-xs text-gray-500 tabular-nums'>{currentSong.id}</div>
                <div className='text-white font-semibold text-sm leading-tight truncate'>{currentSong.title}</div>
              </div>
            )}
            <div className='flex items-center gap-2 shrink-0'>
              <button
                onClick={() => showLyrics ? closeLyrics() : openLyrics()}
                className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${showLyrics ? 'border-blue-500 text-blue-400' : 'border-gray-600 text-gray-500 hover:text-white hover:border-gray-400'}`}
              >
                Lyrics
              </button>
              <button
                onClick={() => setSingMode(v => !v)}
                className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${singMode ? 'border-amber-500 text-amber-400' : 'border-gray-600 text-gray-500 hover:text-white hover:border-gray-400'}`}
              >
                Sing
              </button>
<div className='flex rounded-lg overflow-hidden border border-gray-600 text-xs'>
                <button
                  onClick={() => switchMode('vocals')}
                  className={`px-2 py-1.5 sm:px-3 transition-colors ${mode === 'vocals' ? 'bg-white text-gray-900 font-semibold' : 'text-gray-400 hover:text-white'}`}
                >
                  Vocals
                </button>
                <button
                  onClick={() => switchMode('no-vocals')}
                  className={`px-2 py-1.5 sm:px-3 transition-colors ${mode === 'no-vocals' ? 'bg-white text-gray-900 font-semibold' : 'text-gray-400 hover:text-white'}`}
                >
                  No vocals
                </button>
                {currentSong?.isolatedFile && (
                  <button
                    onClick={() => switchMode('vocals-only')}
                    className={`px-2 py-1.5 sm:px-3 transition-colors ${mode === 'vocals-only' ? 'bg-white text-gray-900 font-semibold' : 'text-gray-400 hover:text-white'}`}
                  >
                    Vocals only
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className='flex items-center gap-2'>
            <span className='text-xs text-gray-500 tabular-nums w-9 text-right'>{fmt(currentTime)}</span>
            <input
              type='range'
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={e => seek(Number(e.target.value))}
              className='flex-1 h-1 accent-white cursor-pointer'
            />
            <span className='text-xs text-gray-500 tabular-nums w-9'>{fmt(duration)}</span>
          </div>

          {mashupPlaying && activeMashup && (
            <div className='flex items-center justify-center gap-2 -mt-1'>
              <span className='text-xs text-purple-400 tabular-nums shrink-0'>{mashupCueIdx + 1}/{activeMashup.cues.length}</span>
              <span className='text-xs text-purple-300 truncate max-w-[180px]'>{activeMashup.cues[mashupCueIdx]?.label ?? ''}</span>
              <button onClick={stopMashup} className='text-xs text-gray-500 hover:text-white transition-colors leading-none shrink-0'>✕</button>
            </div>
          )}

          {loopActive && !mashupPlaying && (
            <div className='flex items-center justify-center gap-2 -mt-1'>
              <span className='text-xs text-blue-400 tabular-nums'>
                ↺ {loopStart !== null ? (loopStartLabel ?? fmt(loopStart)) : '?'} → {loopEnd !== null ? (loopEndLabel ?? fmt(loopEnd)) : '?'}
              </span>
              <button onClick={clearLoop} className='text-xs text-gray-500 hover:text-white transition-colors leading-none'>✕</button>
            </div>
          )}

          <div className='flex items-center gap-4'>
            <div className='flex items-center gap-3 shrink-0'>
              <button
                onClick={mashupPlaying ? () => jumpToMashupCue(mashupCueIdx - 1) : prevSong}
                disabled={mashupPlaying ? mashupCueIdx <= 0 : currentIdx <= 0}
                className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors' aria-label='Previous'>⏮</button>
              <button
                onClick={mashupPlaying ? () => seekInMashupRef.current(-5) : () => seek(Math.max(0, currentTime - 5))}
                disabled={!currentSong}
                className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors text-xs tabular-nums'
                aria-label='Rewind 5 seconds'
              >−5s</button>
              <button onClick={togglePlay} className='w-9 h-9 rounded-full bg-white text-gray-900 flex items-center justify-center hover:bg-gray-200 transition-colors' aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button
                onClick={mashupPlaying ? () => seekInMashupRef.current(5) : () => seek(Math.min(duration, currentTime + 5))}
                disabled={!currentSong}
                className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors text-xs tabular-nums'
                aria-label='Skip forward 5 seconds'
              >+5s</button>
              <button
                onClick={mashupPlaying ? () => jumpToMashupCue(mashupCueIdx + 1) : nextSong}
                disabled={mashupPlaying ? mashupCueIdx >= (activeMashup?.cues.length ?? 1) - 1 : currentIdx >= songs.length - 1}
                className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors' aria-label='Next'>⏭</button>
              <button onClick={clearLoop} className={`text-base transition-colors ${loopActive ? 'text-blue-400' : 'text-gray-500 hover:text-white'}`} aria-label='Clear loop'>↺</button>
            </div>

            <div className='flex-1 flex items-center gap-1.5 overflow-x-auto min-w-0' style={{ scrollbarWidth: 'none' }}>
              {bookmarks.map(bm => (
                <BookmarkPill
                  key={bm._id}
                  bm={bm}
                  loopStart={loopStart}
                  loopEnd={loopEnd}
                  onSeek={seek}
                  onMenu={openBookmarkMenu}
                  onGesture={openGestureMenu}
                />
              ))}
              {pendingDeleteId ? (
                <span className='flex items-center gap-1.5 text-xs text-gray-400'>
                  <span>Removed</span>
                  <button onClick={handleUndoDelete} className='text-blue-400 hover:text-blue-300 font-medium'>Undo</button>
                </span>
              ) : addingBookmark ? (
                <div className='flex items-center gap-1'>
                  <input
                    autoFocus
                    value={labelInput}
                    onChange={e => setLabelInput(e.target.value)}
                    onKeyDown={handleBookmarkKeyDown}
                    placeholder='Name…'
                    className='text-xs bg-gray-800 border border-gray-600 rounded px-2 py-1 w-24 text-white placeholder-gray-500 outline-none focus:border-gray-400'
                  />
                  <button onClick={handleAddBookmark} className='text-xs text-green-400 hover:text-green-300 px-1'>✓</button>
                  <button onClick={() => { setAddingBookmark(false); setLabelInput('') }} className='text-xs text-gray-500 hover:text-gray-300 px-1'>✕</button>
                </div>
              ) : (
                <button onClick={() => setAddingBookmark(true)} className='text-xs text-gray-600 hover:text-gray-300 transition-colors whitespace-nowrap'>
                  + bookmark
                </button>
              )}
            </div>
          </div>
        </div>
        </div>
      )}
    </div>
  )
}
