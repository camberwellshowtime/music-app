import { useState, useEffect, useCallback } from 'react'
import { db, startSync, stopSync, onSyncStatus } from './db'
import { songs, songUrls } from './songs'

const AUDIO_CACHE = 'music-audio-v1'

export function useBookmarks(songId) {
  const [bookmarks, setBookmarks] = useState([])

  useEffect(() => {
    if (!songId) { setBookmarks([]); return }
    const load = () =>
      db.allDocs({ include_docs: true }).then(result =>
        setBookmarks(
          result.rows
            .map(r => r.doc)
            .filter(d => d.type === 'bookmark' && d.songId === songId)
            .sort((a, b) => a.time - b.time)
        )
      )
    load()
    const changes = db.changes({ live: true, since: 'now', include_docs: true })
      .on('change', () => load())
    return () => { changes.cancel() }
  }, [songId])

  return bookmarks
}

const SYNC_FORCE_ON = process.env.BUN_PUBLIC_SYNC_ENABLED === 'true'

export function useSync() {
  const [enabled, setEnabled] = useState(() => SYNC_FORCE_ON || localStorage.getItem('sync-enabled') === 'true')
  const [status, setStatus] = useState(() => (SYNC_FORCE_ON || localStorage.getItem('sync-enabled') === 'true') ? 'syncing' : 'off')

  useEffect(() => {
    let timer = null
    onSyncStatus((s) => {
      clearTimeout(timer)
      if (s === 'syncing') {
        timer = setTimeout(() => setStatus('syncing'), 1500)
      } else {
        setStatus(s)
      }
    })
    if (enabled) startSync()
    else stopSync()
    return () => { onSyncStatus(null); clearTimeout(timer) }
  }, [enabled])

  const toggle = () => {
    if (SYNC_FORCE_ON) return
    setEnabled(prev => {
      const next = !prev
      localStorage.setItem('sync-enabled', String(next))
      if (!next) setStatus('off')
      return next
    })
  }

  return { enabled, toggle, status, forceOn: SYNC_FORCE_ON }
}

export function useDownloads() {
  const [downloaded, setDownloaded] = useState(new Set())
  const [downloading, setDownloading] = useState(new Set())

  const refresh = useCallback(async () => {
    if (!('caches' in window)) return
    const cache = await caches.open(AUDIO_CACHE)
    const keys = await cache.keys()
    const paths = new Set(keys.map(k => new URL(k.url).pathname))
    setDownloaded(new Set(songs.filter(s => songUrls(s).every(url => paths.has(url))).map(s => s.id)))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const download = useCallback(async (song) => {
    if (!('caches' in window)) return
    setDownloading(prev => new Set([...prev, song.id]))
    try {
      const cache = await caches.open(AUDIO_CACHE)
      await Promise.all(songUrls(song).map(async url => {
        const res = await fetch(url)
        if (res.ok) await cache.put(url, res)
      }))
    } finally {
      setDownloading(prev => { const n = new Set(prev); n.delete(song.id); return n })
      await refresh()
    }
  }, [refresh])

  const downloadAll = useCallback(async () => {
    if (!('caches' in window)) return
    const cache = await caches.open(AUDIO_CACHE)
    for (const song of songs) {
      const results = await Promise.all(songUrls(song).map(url => cache.match(url)))
      if (results.some(r => !r)) await download(song)
    }
  }, [download])

  return { downloaded, downloading, download, downloadAll, refresh }
}
