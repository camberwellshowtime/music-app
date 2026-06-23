import PouchDB from 'pouchdb-browser'

const DB_NAME = 'music-2026'
const DB_REMOTE_URL = 'https://cst-casting-db.camberwellshowtime.com/db/'

export const db = new PouchDB(DB_NAME)

let syncHandler = null

export function startSync() {
  if (syncHandler) return
  const url = `${DB_REMOTE_URL}${DB_NAME}`
  syncHandler = db.sync(url, { live: true, retry: true })
}

export function stopSync() {
  syncHandler?.cancel()
  syncHandler = null
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
