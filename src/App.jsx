import { useState, useEffect, useRef } from 'react'
import { songs, songById, vocalsUrl, noVocalsUrl, lyricsUrl } from './songs'
import { addBookmark, deleteBookmark, updateBookmark } from './db'
import { useBookmarks, useDownloads } from './hooks'

const isStandalone = window.matchMedia('(display-mode: standalone)').matches || !!navigator.standalone

// Read saved restore state once on page load (cleared immediately so it's consumed once)
const _saved = (() => {
  try {
    const s = sessionStorage.getItem('music-restore')
    if (s) sessionStorage.removeItem('music-restore')
    return s ? JSON.parse(s) : null
  } catch { return null }
})()

// If a SW was already controlling the page on load, any future sw-activated is an update
const _hadController = !!navigator.serviceWorker?.controller

function fmt(s) {
  if (!isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
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
  const [editingBookmark, setEditingBookmark] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [editTime, setEditTime] = useState(0)
  const [bookmarkMenu, setBookmarkMenu] = useState(null)
  const pendingDeleteRef = useRef(null)
  const vocalsRef = useRef(null)
  const noVocalsRef = useRef(null)
  // Initialise with saved seek position so the [currentId] effect picks it up on first mount
  const pendingSeek = useRef(
    _saved?.currentId && _saved?.currentTime > 0
      ? { time: _saved.currentTime, play: false }
      : null
  )
  const loopStartRef = useRef(_saved?.loopStart ?? null)
  const loopEndRef = useRef(_saved?.loopEnd ?? null)
  const pendingSwReload = useRef(false)
  const doReloadRef = useRef(null)

  const currentSong = currentId ? songById(currentId) : null
  const currentIdx = songs.findIndex(s => s.id === currentId)
  const allBookmarks = useBookmarks(currentId)
  const bookmarks = allBookmarks.filter(bm => bm._id !== pendingDeleteId)
  const { downloaded, downloading, download, downloadAll, refresh } = useDownloads()
  const loopStartLabel = bookmarks.find(bm => bm.time === loopStart)?.label
  const loopEndLabel = bookmarks.find(bm => bm.time === loopEnd)?.label

  // Keep doReload fresh every render so it always captures current state
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
        if (!_hadController) return // first install — no need to reload
        if (vocalsRef.current && !vocalsRef.current.paused) {
          pendingSwReload.current = true // defer until music stops
        } else {
          doReloadRef.current()
        }
      }
    }
    sw.addEventListener('message', handler)
    return () => sw.removeEventListener('message', handler)
  }, [refresh])

  useEffect(() => { if (isStandalone) downloadAll() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load both audio elements when song changes
  useEffect(() => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    if (!va || !nv || !currentSong) return
    const pending = pendingSeek.current
    pendingSeek.current = null
    va.pause()
    nv.pause()
    va.src = vocalsUrl(currentSong)
    nv.src = noVocalsUrl(currentSong) ?? vocalsUrl(currentSong)
    va.load()
    nv.load()
    if (pending) {
      va.addEventListener('canplay', () => {
        va.currentTime = pending.time
        nv.currentTime = pending.time
        if (pending.play) {
          va.play().catch(() => {})
          nv.play().catch(() => {})
        }
      }, { once: true })
    }
  }, [currentId])

  // Switch which element is audible — no seeking needed
  useEffect(() => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    if (!va || !nv) return
    va.volume = mode === 'vocals' ? 1 : 0
    nv.volume = mode === 'vocals' ? 0 : 1
  }, [mode])

  // Audio events — drive state from vocals element (master)
  useEffect(() => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    if (!va || !nv) return
    const onTime = () => {
      setCurrentTime(va.currentTime)
      if (loopStartRef.current !== null && loopEndRef.current !== null &&
          loopEndRef.current > loopStartRef.current &&
          va.currentTime >= loopEndRef.current) {
        va.currentTime = loopStartRef.current
        nv.currentTime = loopStartRef.current
      }
    }
    const onDuration = () => setDuration(isFinite(va.duration) ? va.duration : 0)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => {
      setIsPlaying(false)
      if (pendingSwReload.current) doReloadRef.current()
    }
    const onEnded = () => {
      nv.pause()
      if (pendingSwReload.current) { doReloadRef.current(); return }
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

  // Periodic drift correction — keep no-vocals locked to vocals
  useEffect(() => {
    const interval = setInterval(() => {
      const va = vocalsRef.current
      const nv = noVocalsRef.current
      if (!va || !nv || va.paused) return
      if (Math.abs(va.currentTime - nv.currentTime) > 0.05) {
        nv.currentTime = va.currentTime
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    loopStartRef.current = null
    loopEndRef.current = null
    setLoopStart(null)
    setLoopEnd(null)
    setLoopActive(false)
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
      return
    }
    pendingSeek.current = { time: 0, play: true }
    setCurrentId(song.id)
    setMode('vocals')
    setCurrentTime(0)
    setDuration(0)
  }

  const togglePlay = () => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    if (!va || !currentSong) return
    if (va.paused) {
      va.play().catch(() => {})
      nv?.play().catch(() => {})
    } else {
      va.pause()
      nv?.pause()
    }
  }

  const seek = (time) => {
    if (vocalsRef.current) vocalsRef.current.currentTime = time
    if (noVocalsRef.current) noVocalsRef.current.currentTime = time
  }

  const switchMode = (newMode) => {
    if (newMode === mode || !currentSong) return
    setMode(newMode)
  }

  const prevSong = () => {
    if (currentIdx <= 0) return
    pendingSeek.current = { time: 0, play: !vocalsRef.current?.paused }
    setCurrentId(songs[currentIdx - 1].id)
    setMode('vocals')
  }

  const nextSong = () => {
    if (currentIdx >= songs.length - 1) return
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

  const openEditBookmark = (bm) => {
    setEditingBookmark(bm)
    setEditLabel(bm.label)
    setEditTime(bm.time)
  }

  const handleSaveBookmark = async () => {
    if (!editingBookmark || !editLabel.trim()) return
    await updateBookmark(editingBookmark, { label: editLabel.trim(), time: editTime })
    setEditingBookmark(null)
  }

  const nudgeTime = (delta) => {
    setEditTime(t => Math.max(0, Math.min(duration, t + delta)))
  }

  const handleEditKeyDown = (e) => {
    if (e.key === 'Enter') handleSaveBookmark()
    if (e.key === 'Escape') setEditingBookmark(null)
  }

  const clearLoop = () => {
    loopStartRef.current = null
    loopEndRef.current = null
    setLoopStart(null)
    setLoopEnd(null)
    setLoopActive(false)
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
    setLoopActive(true)
  }

  const setLoopB = (bm) => {
    loopEndRef.current = bm.time
    setLoopEnd(bm.time)
    setLoopActive(true)
  }

  return (
    <div className='min-h-screen bg-gray-950 text-gray-100 flex flex-col'>
      <audio ref={vocalsRef} preload='metadata' />
      <audio ref={noVocalsRef} preload='metadata' />

      {bookmarkMenu && (
        <div className='fixed inset-0 z-50 flex flex-col justify-end' onClick={() => setBookmarkMenu(null)}>
          <div className='bg-gray-800 rounded-t-2xl shadow-2xl' onClick={e => e.stopPropagation()}>
            <div className='px-5 pt-5 pb-3 border-b border-gray-700/60'>
              <div className='text-sm font-semibold text-white'>{bookmarkMenu.label}</div>
              <div className='text-xs text-gray-400 tabular-nums mt-0.5'>{fmt(bookmarkMenu.time)}</div>
            </div>
            <div className='py-1'>
              <button onClick={() => { seek(bookmarkMenu.time); setBookmarkMenu(null) }} className='w-full text-left px-5 py-4 text-sm text-gray-200 active:bg-gray-700'>
                Seek to {bookmarkMenu.label} ({fmt(bookmarkMenu.time)})
              </button>
              <button onClick={() => { setLoopA(bookmarkMenu); setBookmarkMenu(null) }} className={`w-full text-left px-5 py-4 text-sm active:bg-gray-700 ${loopStart === bookmarkMenu.time ? 'text-green-400' : 'text-gray-200'}`}>
                {loopStart === bookmarkMenu.time ? '✓ Loop start' : 'Set loop start'}
              </button>
              <button onClick={() => { setLoopB(bookmarkMenu); setBookmarkMenu(null) }} className={`w-full text-left px-5 py-4 text-sm active:bg-gray-700 ${loopEnd === bookmarkMenu.time ? 'text-orange-400' : 'text-gray-200'}`}>
                {loopEnd === bookmarkMenu.time ? '✓ Loop end' : 'Set loop end'}
              </button>
              <button onClick={() => { openEditBookmark(bookmarkMenu); setBookmarkMenu(null) }} className='w-full text-left px-5 py-4 text-sm text-gray-200 active:bg-gray-700'>
                Edit
              </button>
              <button onClick={() => { handleDeleteBookmark(bookmarkMenu); setBookmarkMenu(null) }} className='w-full text-left px-5 py-4 text-sm text-red-400 active:bg-gray-700'>
                Delete
              </button>
            </div>
            <div className='pb-8' />
          </div>
        </div>
      )}

      {editingBookmark && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60' onClick={() => setEditingBookmark(null)}>
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
              <button onClick={() => setEditingBookmark(null)} className='flex-1 text-sm py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors'>Cancel</button>
              <button onClick={handleSaveBookmark} className='flex-1 text-sm py-2 rounded-lg bg-white text-gray-900 hover:bg-gray-200 font-medium transition-colors'>Save</button>
            </div>
          </div>
        </div>
      )}

      <header className='sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between gap-3'>
        <h1 className='text-base font-bold text-white shrink-0'>The Happy Place</h1>
        {!isStandalone && downloaded.size < songs.length && (
          <button
            onClick={downloadAll}
            className='text-xs px-3 py-1.5 rounded-full bg-gray-700 hover:bg-gray-600 transition-colors whitespace-nowrap'
          >
            Download all
          </button>
        )}
      </header>

      <main className={`flex-1 overflow-y-auto ${currentSong ? 'pb-52' : ''}`}>
        {showLyrics && currentSong ? (
          <div className='px-4 py-4'>
            <div className='flex justify-end mb-2'>
              <button
                onClick={() => setShowLyrics(false)}
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

      {currentSong && (
        <div className='fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 px-4 pt-3 pb-5 space-y-2.5 shadow-2xl'>
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0'>
              <div className='text-xs text-gray-500 tabular-nums'>{currentSong.id}</div>
              <div className='text-white font-semibold text-sm leading-tight truncate'>{currentSong.title}</div>
            </div>
            <div className='flex items-center gap-2 shrink-0'>
              <button
                onClick={() => setShowLyrics(prev => !prev)}
                className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${showLyrics ? 'border-blue-500 text-blue-400' : 'border-gray-600 text-gray-500 hover:text-white hover:border-gray-400'}`}
              >
                Lyrics
              </button>
              <div className='flex rounded-lg overflow-hidden border border-gray-600 text-xs'>
                <button
                  onClick={() => switchMode('vocals')}
                  className={`px-3 py-1.5 transition-colors ${mode === 'vocals' ? 'bg-white text-gray-900 font-semibold' : 'text-gray-400 hover:text-white'}`}
                >
                  Vocals
                </button>
                <button
                  onClick={() => switchMode('no-vocals')}
                  className={`px-3 py-1.5 transition-colors ${mode === 'no-vocals' ? 'bg-white text-gray-900 font-semibold' : 'text-gray-400 hover:text-white'}`}
                >
                  No vocals
                </button>
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

          {loopActive && (
            <div className='flex items-center justify-center gap-2 -mt-1'>
              <span className='text-xs text-blue-400 tabular-nums'>
                ↺ {loopStart !== null ? (loopStartLabel ?? fmt(loopStart)) : '?'} → {loopEnd !== null ? (loopEndLabel ?? fmt(loopEnd)) : '?'}
              </span>
              <button onClick={clearLoop} className='text-xs text-gray-500 hover:text-white transition-colors leading-none'>✕</button>
            </div>
          )}

          <div className='flex items-center gap-4'>
            <div className='flex items-center gap-3 shrink-0'>
              <button onClick={prevSong} disabled={currentIdx <= 0} className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors' aria-label='Previous'>⏮</button>
              <button onClick={togglePlay} className='w-9 h-9 rounded-full bg-white text-gray-900 flex items-center justify-center hover:bg-gray-200 transition-colors' aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button onClick={nextSong} disabled={currentIdx >= songs.length - 1} className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors' aria-label='Next'>⏭</button>
              <button onClick={clearLoop} className={`text-base transition-colors ${loopActive ? 'text-blue-400' : 'text-gray-500 hover:text-white'}`} aria-label='Clear loop'>↺</button>
            </div>

            <div className='flex-1 flex items-center gap-1.5 flex-wrap min-w-0'>
              {bookmarks.map(bm => (
                <span key={bm._id} className={`flex items-center bg-gray-700 rounded-full text-xs ${loopStart === bm.time ? 'ring-1 ring-green-500/60' : loopEnd === bm.time ? 'ring-1 ring-orange-500/60' : ''}`}>
                  <button onClick={() => seek(bm.time)} className='pl-2.5 pr-1 py-1 hover:text-white transition-colors whitespace-nowrap' title={fmt(bm.time)}>
                    {bm.label}
                  </button>
                  <button onClick={() => setBookmarkMenu(bm)} className='pl-1 pr-2.5 py-1 text-gray-500 hover:text-white transition-colors' aria-label='Bookmark options'>⋯</button>
                </span>
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
      )}
    </div>
  )
}
