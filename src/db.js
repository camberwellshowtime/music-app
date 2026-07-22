import PouchDB from 'pouchdb-browser'

const DB_NAME = 'music-2026'
const DB_REMOTE_URL = 'https://cst-casting-db.camberwellshowtime.com/db/'

export const db = new PouchDB(DB_NAME)

let syncHandler = null
let syncStatusCb = null

export function onSyncStatus(cb) {
  syncStatusCb = cb
}

export function startSync() {
  if (syncHandler) return
  const url = `${DB_REMOTE_URL}${DB_NAME}`
  syncStatusCb?.('syncing')
  syncHandler = db.sync(url, { live: true, retry: true })
    .on('active',  ()    => syncStatusCb?.('syncing'))
    .on('paused',  (err) => syncStatusCb?.(err ? 'error' : 'connected'))
    .on('error',   ()    => syncStatusCb?.('error'))
    .on('denied',  ()    => syncStatusCb?.('error'))
}

export function stopSync() {
  syncHandler?.cancel()
  syncHandler = null
}

export async function pullOnce() {
  const url = `${DB_REMOTE_URL}${DB_NAME}`
  return new Promise((resolve, reject) => {
    db.replicate.from(url)
      .on('complete', resolve)
      .on('error', reject)
  })
}

export async function addBookmark(songId, time, label) {
  await db.post({ type: 'bookmark', songId, time, label })
}

export async function deleteBookmark(bookmark) {
  await db.remove(bookmark._id, bookmark._rev)
}

export async function updateBookmark(bookmark, { time, label }) {
  await db.put({ ...bookmark, time, label })
}

if (process.env.BUN_PUBLIC_SYNC_ENABLED === 'true') {
  startSync()
}
