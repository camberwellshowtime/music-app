// Seed section bookmarks into the remote CouchDB.
// PouchDB in the browser will sync them down automatically.
//
// For songs present in bookmarks-seed.js:
//   1. Backs up all existing bookmark docs → scripts/backups/bookmarks-<timestamp>.json
//   2. Deletes their existing bookmark docs from the DB
//   3. Inserts the new ones (including source annotation if present)
//
// Songs not in the seed file are left untouched.
//
// Usage:
//   bun scripts/seed-bookmarks.js
//   COUCH_USER=admin COUCH_PASS=secret bun scripts/seed-bookmarks.js

import { mkdir, writeFile } from 'node:fs/promises'
import { seedBookmarks } from '../src/data/bookmarks-seed.js'

const DB_URL = process.env.COUCH_URL ?? 'https://cst-casting-db.camberwellshowtime.com/db/music-2026'

const headers = { 'Content-Type': 'application/json' }
if (process.env.COUCH_USER && process.env.COUCH_PASS) {
  const creds = btoa(`${process.env.COUCH_USER}:${process.env.COUCH_PASS}`)
  headers['Authorization'] = `Basic ${creds}`
}

// ── 1. Fetch all existing docs ────────────────────────────────────────────────

const allDocsRes = await fetch(`${DB_URL}/_all_docs?include_docs=true`, { headers })
if (!allDocsRes.ok) {
  console.error(`Failed to fetch existing docs: ${allDocsRes.status} ${await allDocsRes.text()}`)
  process.exit(1)
}
const { rows } = await allDocsRes.json()
const allBookmarks = rows.filter(r => r.doc?.type === 'bookmark').map(r => r.doc)

// ── 2. Backup ─────────────────────────────────────────────────────────────────

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupDir = new URL('../backups', import.meta.url).pathname
await mkdir(backupDir, { recursive: true })
const backupPath = `${backupDir}/bookmarks-${timestamp}.json`
await writeFile(backupPath, JSON.stringify(allBookmarks, null, 2))
console.log(`Backed up ${allBookmarks.length} existing bookmark(s) → ${backupPath}`)

// ── 3. Delete existing bookmarks for songs we're about to seed ────────────────

const songIdsToSeed = new Set(seedBookmarks.map(b => b.songId))
const toDelete = allBookmarks
  .filter(d => songIdsToSeed.has(d.songId))
  .map(d => ({ _id: d._id, _rev: d._rev, _deleted: true }))

if (toDelete.length > 0) {
  const delRes = await fetch(`${DB_URL}/_bulk_docs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ docs: toDelete }),
  })
  if (!delRes.ok) {
    console.error(`Failed to delete old bookmarks: ${delRes.status} ${await delRes.text()}`)
    process.exit(1)
  }
  const delResults = await delRes.json()
  const delErrors = delResults.filter(r => r.error)
  if (delErrors.length) {
    console.error('Some deletes failed:')
    delErrors.forEach(e => console.error(`  ${e.id}: ${e.error} — ${e.reason}`))
  }
  console.log(`Removed ${toDelete.length - delErrors.length} old bookmark(s) for ${songIdsToSeed.size} song(s)`)
}

// ── 4. Insert new bookmarks ───────────────────────────────────────────────────

const docs = seedBookmarks.map(({ songId, time, label, source }) => ({
  type: 'bookmark',
  songId,
  time,
  label,
  ...(source ? { source } : {}),
}))

const bulkRes = await fetch(`${DB_URL}/_bulk_docs`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ docs }),
})
if (!bulkRes.ok) {
  console.error(`Bulk insert failed: ${bulkRes.status} ${await bulkRes.text()}`)
  process.exit(1)
}

const results = await bulkRes.json()
const errors  = results.filter(r => r.error)
if (errors.length) {
  console.error('Some inserts failed:')
  errors.forEach(e => console.error(`  ${e.id}: ${e.error} — ${e.reason}`))
}

const ok = results.length - errors.length
const withSource = docs.filter(d => d.source).length
console.log(`Seeded ${ok} bookmark(s) across ${songIdsToSeed.size} song(s) (${withSource} with source annotation)`)
