import { songs, melodyUrl, vocalsUrl, noVocalsUrl } from './songs.js'

const APP_CACHE   = 'music-app-v1'
const AUDIO_CACHE = 'music-audio-v1'
const KNOWN_CACHES = new Set([APP_CACHE, AUDIO_CACHE])

const MELODY_URLS = songs.map(melodyUrl)
const AUDIO_PRECACHE_URLS = songs
  .filter(s => s.precacheAudio)
  .flatMap(s => [vocalsUrl(s), noVocalsUrl(s)].filter(Boolean))

async function getMissing(cache, urls) {
  return (await Promise.all(urls.map(async url => (await cache.match(url)) ? null : url))).filter(Boolean)
}

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  clients.forEach(c => c.postMessage(msg))
}

self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    await self.clients.claim()
    await broadcast({ type: 'sw-activated' })

    // Delete any caches from old versions
    const names = await caches.keys()
    await Promise.all(names.filter(n => !KNOWN_CACHES.has(n)).map(n => caches.delete(n)))

    const cache = await caches.open(AUDIO_CACHE)

    // Pre-cache melody JSONs (small, needed offline for sing-along)
    const missingMelody = await getMissing(cache, MELODY_URLS)
    await Promise.all(missingMelody.map(url =>
      fetch(url).then(r => { if (r.ok) return cache.put(url, r) }).catch(() => {})
    ))

    // Pre-cache audio for new songs so installed apps get them without needing to play first
    const missingAudio = await getMissing(cache, AUDIO_PRECACHE_URLS)
    await Promise.all(missingAudio.map(url =>
      fetch(url).then(r => { if (r.ok) return cache.put(url, r) }).catch(() => {})
    ))
  })())
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (
    url.pathname.startsWith('/vocals/') ||
    url.pathname.startsWith('/no-vocals/') ||
    url.pathname.startsWith('/vocals-isolated/')
  ) {
    e.respondWith(handleAudio(e.request))
    return
  }
  e.respondWith(handleApp(e.request))
})

async function handleAudio(request) {
  const cache = await caches.open(AUDIO_CACHE)
  const rangeHeader = request.headers.get('Range')
  const cached = await cache.match(new Request(request.url))

  if (cached) {
    return rangeHeader ? serveRange(cached, rangeHeader) : cached
  }

  return fetch(request)
}

async function serveRange(response, rangeHeader) {
  const buffer = await response.arrayBuffer()
  const total  = buffer.byteLength
  const match  = /bytes=(\d+)-(\d*)/.exec(rangeHeader)

  if (!match) {
    return new Response(buffer, {
      status: 200,
      headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'audio/mpeg', 'Accept-Ranges': 'bytes' },
    })
  }

  const start = parseInt(match[1])
  const end   = match[2] ? parseInt(match[2]) : total - 1

  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type':   response.headers.get('Content-Type') ?? 'audio/mpeg',
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges':  'bytes',
    },
  })
}

async function handleApp(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(APP_CACHE)
      await cache.put(request, response.clone())
    }
    return response
  } catch {
    const cache  = await caches.open(APP_CACHE)
    const cached = await cache.match(request)
    if (cached) return cached
    if (request.mode === 'navigate') {
      const index = (await cache.match('/')) ?? (await cache.match('/index.html'))
      if (index) return index
    }
    return new Response('Offline', { status: 503 })
  }
}
