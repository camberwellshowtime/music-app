import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'

// ── Conversions ───────────────────────────────────────────────────────────────

function hzToMidi(hz) {
  if (!hz || hz <= 0) return null
  return 69 + 12 * Math.log2(hz / 440)
}

function semitoneDiff(hzA, hzB) {
  if (!hzA || !hzB) return null
  const diff = Math.abs(12 * Math.log2(hzA / hzB)) % 12
  return Math.min(diff, 12 - diff)
}

function fmt(s) {
  if (!isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

// ── Canvas piano-roll ─────────────────────────────────────────────────────────

const CANVAS_H = 160
const WINDOW_SECS = 8
const MIDI_LOW  = 48   // C3
const MIDI_HIGH = 84   // C6
const MIDI_RANGE = MIDI_HIGH - MIDI_LOW

function midiToY(midi, height) {
  return ((MIDI_HIGH - midi) / MIDI_RANGE) * height
}

function drawPianoRoll(ctx, width, height, notes, livePitches, currentTime, octaveShift) {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, 0, width, height)

  const secToX = (t) => ((t - currentTime + WINDOW_SECS * 0.35) / WINDOW_SECS) * width
  const noteH = Math.max(7, height / MIDI_RANGE)

  for (let midi = MIDI_LOW; midi <= MIDI_HIGH; midi++) {
    if (midi % 12 === 0) {
      const y = midiToY(midi, height)
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke()
    }
  }

  const nowX = secToX(currentTime)
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath(); ctx.moveTo(nowX, 0); ctx.lineTo(nowX, height); ctx.stroke()
  ctx.setLineDash([])

  if (notes && notes.length > 0) {
    const t0 = currentTime - WINDOW_SECS * 0.35
    const t1 = currentTime + WINDOW_SECS * 0.65
    // Binary search: find first note whose start is at or after t0
    let lo = 0, hi = notes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (notes[mid].t < t0) lo = mid + 1
      else hi = mid
    }
    // Step back one in case a note started before t0 but is still playing
    const startIdx = Math.max(0, lo - 1)
    for (let i = startIdx; i < notes.length; i++) {
      const note = notes[i]
      if (note.t > t1) break
      if (note.end < t0) continue
      const midi = hzToMidi(note.hz)
      if (!midi) continue
      const bx = Math.max(0, secToX(note.t))
      const bw = Math.min(width, secToX(note.end) - 2) - bx
      if (bw <= 0) continue
      const isCurrent = note.t <= currentTime && currentTime <= note.end
      ctx.fillStyle = isCurrent ? 'rgba(203,213,225,0.85)' : 'rgba(100,116,139,0.55)'
      ctx.beginPath()
      ctx.roundRect(bx, midiToY(midi, height) - noteH / 2, bw, noteH, 3)
      ctx.fill()
    }
  }

  if (livePitches && livePitches.length > 0) {
    const shiftMult = Math.pow(2, octaveShift)
    for (const { t, hz } of livePitches) {
      if (!hz) continue
      const shiftedHz = hz * shiftMult
      const midi = hzToMidi(shiftedHz)
      if (!midi) continue
      const x = secToX(t)
      const y = midiToY(midi, height)
      const alpha = Math.max(0, 1 - (currentTime - t) / 2.5)
      ctx.fillStyle = `rgba(251,191,36,${alpha * 0.9})`
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

// ── Pitch accuracy indicator ──────────────────────────────────────────────────

function accuracyLabel(pct) {
  if (pct >= 90) return 'sounding great'
  if (pct >= 75) return 'tracking well'
  if (pct >= 55) return 'getting there'
  if (pct >= 35) return 'keep going'
  return 'warming up'
}

// ── Orientation detection ─────────────────────────────────────────────────────

function checkLandscape() {
  return window.innerWidth > window.innerHeight && window.innerHeight < 500
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SingAlong({
  song, currentTime, isPlaying, melodyUrl, onClose,
  // Playback controls for landscape view
  duration, onPlayPause, bookmarks, onSeek,
  loopActive, loopStart, loopEnd, onLoopToggle,
}) {
  const canvasRef        = useRef(null)
  const canvasLsRef      = useRef(null)
  const animRef          = useRef(null)
  const streamRef        = useRef(null)
  const analyserRef      = useRef(null)
  const audioCtxRef      = useRef(null)
  const bufferRef        = useRef(null)
  const livePitchesRef   = useRef([])
  const matchFramesRef   = useRef(0)
  const totalFramesRef   = useRef(0)
  const octaveVotesRef   = useRef([])
  const octaveLockedRef  = useRef(false)
  // Pitch detection worker
  const workerRef        = useRef(null)
  const workerBusyRef    = useRef(false)
  const livePitchRef     = useRef(null)   // { hz, ts } set by worker
  // Refs that mirror props/state so the rAF loop never needs to re-register
  const currentTimeRef   = useRef(currentTime)
  const isPlayingRef     = useRef(isPlaying)
  const notesRef         = useRef(null)
  const octaveShiftRef   = useRef(0)
  const isLandscapeRef   = useRef(false)

  const [notes,       setNotes]       = useState(null)
  const [micState,    setMicState]    = useState('idle')
  const [accuracy,    setAccuracy]    = useState(null)
  const [octaveShift, setOctaveShift] = useState(0)
  const [isLandscape, setIsLandscape] = useState(checkLandscape)

  // Keep refs in sync with props / state
  useEffect(() => { currentTimeRef.current = currentTime }, [currentTime])
  useEffect(() => { isPlayingRef.current   = isPlaying   }, [isPlaying])
  useEffect(() => { notesRef.current       = notes       }, [notes])
  useEffect(() => { octaveShiftRef.current = octaveShift }, [octaveShift])
  useEffect(() => { isLandscapeRef.current = isLandscape }, [isLandscape])

  useEffect(() => {
    const update = () => setIsLandscape(checkLandscape())
    window.addEventListener('resize', update)
    screen.orientation?.addEventListener('change', update)
    return () => {
      window.removeEventListener('resize', update)
      screen.orientation?.removeEventListener('change', update)
    }
  }, [])

  useEffect(() => {
    octaveVotesRef.current  = []
    octaveLockedRef.current = false
    setOctaveShift(0)
  }, [melodyUrl])

  useEffect(() => {
    if (!melodyUrl) return
    fetch(melodyUrl)
      .then(r => r.ok ? r.json() : null)
      .then(notes => setNotes(notes))
      .catch(() => setNotes(null))
  }, [melodyUrl])

  const startMic = useCallback(async () => {
    setMicState('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const ctx    = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0
      source.connect(analyser)
      streamRef.current   = stream
      audioCtxRef.current = ctx
      analyserRef.current = analyser
      bufferRef.current   = new Float32Array(analyser.fftSize)

      const worker = new Worker(new URL('./pitch-worker.js', import.meta.url), { type: 'module' })
      worker.onmessage = ({ data }) => {
        livePitchRef.current  = data   // { hz, ts }
        workerBusyRef.current = false
      }
      workerRef.current = worker

      setMicState('active')
    } catch {
      setMicState('denied')
    }
  }, [])

  const stopMic = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close()
    workerRef.current?.terminate()
    streamRef.current = audioCtxRef.current = analyserRef.current = bufferRef.current = null
    workerRef.current = null
    workerBusyRef.current = false
    livePitchRef.current  = null
    setMicState('idle')
  }, [])

  useEffect(() => () => { stopMic(); cancelAnimationFrame(animRef.current) }, [stopMic])

  // Single long-lived rAF loop — no dependency churn.
  // All live values are read via refs so this effect runs exactly once.
  useEffect(() => {
    const refHzAt = (t) => {
      const notes = notesRef.current
      if (!notes || notes.length === 0) return null
      let lo = 0, hi = notes.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (notes[mid].t <= t) lo = mid; else hi = mid - 1
      }
      const n = notes[lo]
      return (n && t >= n.t && t <= n.end) ? n.hz : null
    }

    const frame = () => {
      animRef.current = requestAnimationFrame(frame)

      const now = currentTimeRef.current

      // Dispatch audio to worker when idle — non-blocking
      if (analyserRef.current && bufferRef.current && workerRef.current && !workerBusyRef.current) {
        analyserRef.current.getFloatTimeDomainData(bufferRef.current)
        let rms = 0
        for (const v of bufferRef.current) rms += v * v
        if (Math.sqrt(rms / bufferRef.current.length) > 0.01) {
          workerBusyRef.current = true
          workerRef.current.postMessage({ buf: bufferRef.current, sampleRate: audioCtxRef.current.sampleRate })
        } else {
          livePitchRef.current = null   // silence — expire last pitch immediately
        }
      }

      // Only use pitch if it was detected within the last 150 ms
      const pitchResult = livePitchRef.current
      const livePitch = (pitchResult && Date.now() - pitchResult.ts < 150) ? pitchResult.hz : null

      if (livePitch) livePitchesRef.current.push({ t: now, hz: livePitch })
      // Trim expired entries from the front in-place — no array allocation
      const pitches = livePitchesRef.current
      let cutIdx = 0
      while (cutIdx < pitches.length && now - pitches[cutIdx].t >= 3) cutIdx++
      if (cutIdx > 0) pitches.splice(0, cutIdx)

      if (isPlayingRef.current) {
        const refHz = refHzAt(now)
        if (refHz && livePitch) {
          if (!octaveLockedRef.current) {
            const rawST = 12 * Math.log2(refHz / livePitch)
            const guess = Math.round(rawST / 12)
            if (guess >= -2 && guess <= 2) {
              octaveVotesRef.current.push(guess)
              if (octaveVotesRef.current.length >= 20) {
                const counts = {}
                for (const v of octaveVotesRef.current) counts[v] = (counts[v] ?? 0) + 1
                const mode = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0])
                octaveLockedRef.current = true
                setOctaveShift(mode)
              }
            }
          }
          totalFramesRef.current++
          if (semitoneDiff(livePitch, refHz) <= 2) matchFramesRef.current++
          if (totalFramesRef.current % 30 === 0) {
            setAccuracy(Math.round(100 * matchFramesRef.current / totalFramesRef.current))
          }
        }
      }

      // Draw only the currently visible canvas
      const canvas = isLandscapeRef.current ? canvasLsRef.current : canvasRef.current
      if (canvas) {
        const w = canvas.offsetWidth, h = canvas.offsetHeight
        if (w > 0 && h > 0) {
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
          drawPianoRoll(canvas.getContext('2d'), w, h, notesRef.current, pitches, now, octaveShiftRef.current)
        }
      }
    }

    animRef.current = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(animRef.current)
  }, [])   // intentionally empty — all values read via refs

  const hasMelody = !!notes
  const micActive = micState === 'active'
  const hasLoop   = loopStart !== null && loopEnd !== null

  const octaveControls = micActive && (
    <div className='flex items-center gap-0.5'>
      <button
        onClick={() => { setOctaveShift(v => Math.max(-2, v - 1)); octaveLockedRef.current = true }}
        className='w-7 h-7 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors text-sm flex items-center justify-center'
      >−</button>
      <span className='text-[10px] tabular-nums text-gray-500 w-8 text-center leading-none'>
        {octaveShift === 0 ? 'oct' : octaveShift > 0 ? `+${octaveShift}` : octaveShift}
      </span>
      <button
        onClick={() => { setOctaveShift(v => Math.min(2, v + 1)); octaveLockedRef.current = true }}
        className='w-7 h-7 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors text-sm flex items-center justify-center'
      >+</button>
    </div>
  )

  const micButton = (
    <>
      {hasMelody && micState === 'idle' && (
        <button onClick={startMic} className='text-xs px-3 py-1.5 rounded-full bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors'>
          Use mic
        </button>
      )}
      {micState === 'requesting' && <span className='text-xs text-gray-500'>Waiting…</span>}
      {micActive && (
        <button onClick={stopMic} className='flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors'>
          <span className='w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse inline-block' />
          Mic on
        </button>
      )}
      {micState === 'denied' && <span className='text-xs text-red-400/70'>Mic denied</span>}
    </>
  )

  const rollLabels = (
    <>
      <div className='absolute left-1 top-1 bottom-1 flex flex-col justify-between pointer-events-none'>
        <span className='text-gray-700 text-[9px] leading-none'>C6</span>
        <span className='text-gray-700 text-[9px] leading-none'>C3</span>
      </div>
      <div className='absolute right-2 bottom-1.5 flex items-center gap-3 pointer-events-none'>
        <div className='flex items-center gap-1'>
          <div className='w-4 h-1 rounded-full bg-slate-400/70' />
          <span className='text-[9px] text-gray-600'>melody</span>
        </div>
        <div className='flex items-center gap-1'>
          <div className='w-2 h-2 rounded-full bg-amber-400/80' />
          <span className='text-[9px] text-gray-600'>you</span>
        </div>
      </div>
    </>
  )

  return (
    <>
      {/* ── Landscape fullscreen overlay (portal → body so z-index isn't trapped by player panel) */}
      {createPortal(<div className={`fixed inset-0 z-50 bg-gray-950 flex flex-col ${isLandscape ? '' : 'hidden'}`}>

        {/* Top bar */}
        <div className='flex items-center gap-2 px-3 shrink-0 border-b border-gray-800/60' style={{ height: 44 }}>
          {/* Song title */}
          <span className='text-xs text-gray-400 truncate' style={{ maxWidth: '22%' }}>{song?.title}</span>

          {/* Playback */}
          <div className='flex items-center gap-2 shrink-0'>
            <button
              onClick={onPlayPause}
              className='w-8 h-8 flex items-center justify-center rounded-full bg-gray-800 hover:bg-gray-700 text-white transition-colors text-base'
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
            <span className='text-xs tabular-nums text-gray-500 shrink-0'>
              {fmt(currentTime)} / {fmt(duration)}
            </span>
          </div>

          {/* Loop toggle — only shown when loop points exist */}
          {hasLoop && (
            <button
              onClick={onLoopToggle}
              className={`text-xs px-2 py-1 rounded transition-colors shrink-0 ${loopActive ? 'text-green-400 bg-green-900/30' : 'text-gray-600 hover:text-gray-400'}`}
              title='Toggle loop'
            >
              ↺
            </button>
          )}

          {/* Accuracy */}
          {accuracy !== null && (
            <span className='text-xs text-gray-500 truncate hidden sm:block'>{accuracyLabel(accuracy)}</span>
          )}

          <div className='flex-1' />

          {/* Mic + octave */}
          {octaveControls}
          {micButton}

          {/* Close */}
          <button
            onClick={onClose}
            className='text-gray-600 hover:text-gray-300 transition-colors text-sm w-8 h-8 flex items-center justify-center shrink-0'
            aria-label='Close sing-along'
          >✕</button>
        </div>

        {/* Bookmark chips — seek to a section quickly */}
        {bookmarks?.length > 0 && (
          <div className='flex gap-1.5 px-3 py-1.5 overflow-x-auto shrink-0 border-b border-gray-800/40 scrollbar-none'>
            {bookmarks.map(bm => (
              <button
                key={bm._id}
                onClick={() => onSeek(bm.time)}
                className={`shrink-0 text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
                  loopActive && (bm.time === loopStart || bm.time === loopEnd)
                    ? 'border-green-700 text-green-400 bg-green-900/20'
                    : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                }`}
              >
                {bm.label}
              </button>
            ))}
          </div>
        )}

        {/* Canvas */}
        <div className='relative flex-1 min-h-0'>
          <canvas ref={canvasLsRef} className='w-full h-full block' />
          {rollLabels}
          {!hasMelody && (
            <div className='absolute inset-0 flex items-center justify-center text-xs text-gray-600'>
              No melody data for this song
            </div>
          )}
        </div>
      </div>, document.body)}

      {/* ── Portrait panel ───────────────────────────────────────────────── */}
      <div className={`flex flex-col bg-gray-950 border-b border-gray-800 ${isLandscape ? 'hidden' : ''}`}>
        <div className='flex items-center justify-between px-4 py-2 border-b border-gray-800/60'>
          <div className='flex items-center gap-3'>
            <span className='text-xs font-medium text-gray-400 uppercase tracking-wide'>Sing along</span>
            {accuracy !== null && (
              <span className='text-xs text-gray-500'>
                {accuracyLabel(accuracy)}
                <span className='ml-1.5 text-gray-600'>({accuracy}%)</span>
              </span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            {octaveControls}
            {micButton}
            <button onClick={onClose} className='text-gray-600 hover:text-gray-300 transition-colors text-sm px-1 leading-none' aria-label='Close sing-along'>✕</button>
          </div>
        </div>

        {!hasMelody ? (
          <div className='flex items-center justify-center h-24 text-xs text-gray-600'>
            No melody data available for this song yet
          </div>
        ) : (
          <div className='relative' style={{ height: CANVAS_H }}>
            <canvas ref={canvasRef} className='w-full h-full' style={{ display: 'block' }} />
            {rollLabels}
          </div>
        )}
      </div>
    </>
  )
}
