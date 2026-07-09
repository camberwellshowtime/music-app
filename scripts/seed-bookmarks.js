// One-off script: seed section bookmarks into the remote CouchDB.
// PouchDB in the browser will sync them down automatically.
//
// Usage:
//   bun scripts/seed-bookmarks.js
//   COUCH_USER=admin COUCH_PASS=secret bun scripts/seed-bookmarks.js

import { seedBookmarks } from '../src/data/bookmarks-seed.js'

const DB_URL = process.env.COUCH_URL ?? 'https://cst-casting-db.camberwellshowtime.com/db/music-2026'

const headers = { 'Content-Type': 'application/json' }
if (process.env.COUCH_USER && process.env.COUCH_PASS) {
  const creds = btoa(`${process.env.COUCH_USER}:${process.env.COUCH_PASS}`)
  headers['Authorization'] = `Basic ${creds}`
}

// 1. Fetch existing docs to find which songs already have bookmarks
const allDocsRes = await fetch(`${DB_URL}/_all_docs?include_docs=true`, { headers })
if (!allDocsRes.ok) {
  const text = await allDocsRes.text()
  console.error(`Failed to fetch existing docs: ${allDocsRes.status} ${text}`)
  process.exit(1)
}
const { rows } = await allDocsRes.json()
const seededSongs = new Set(
  rows.filter(r => r.doc?.type === 'bookmark').map(r => r.doc.songId)
)

const toInsert = seedBookmarks.filter(bm => !seededSongs.has(bm.songId))

if (toInsert.length === 0) {
  console.log('Nothing to seed — all songs already have bookmarks.')
  process.exit(0)
}

const skipped = [...new Set(seedBookmarks.map(b => b.songId))].filter(id => seededSongs.has(id))
if (skipped.length) console.log(`Skipping (already seeded): ${skipped.join(', ')}`)

// 2. Bulk insert
const docs = toInsert.map(({ songId, time, label }) => ({ type: 'bookmark', songId, time, label }))
const bulkRes = await fetch(`${DB_URL}/_bulk_docs`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ docs }),
})
if (!bulkRes.ok) {
  const text = await bulkRes.text()
  console.error(`Bulk insert failed: ${bulkRes.status} ${text}`)
  process.exit(1)
}

const results = await bulkRes.json()
const errors = results.filter(r => r.error)
if (errors.length) {
  console.error('Some docs failed to insert:')
  errors.forEach(e => console.error(`  ${e.id}: ${e.error} — ${e.reason}`))
}

const ok = results.length - errors.length
console.log(`Seeded ${ok} bookmarks across ${[...new Set(toInsert.map(b => b.songId))].length} songs.`)
