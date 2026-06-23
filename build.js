#!/usr/bin/env bun
import plugin from 'bun-plugin-tailwind'
import { existsSync } from 'fs'
import { rm, mkdir } from 'fs/promises'
import path from 'path'

const outdir = path.join(process.cwd(), 'dist')
const vocalsDir = 'vocals-128'
const noVocalsDir = 'no-vocals-128'

// Clean dist/
if (existsSync(outdir)) {
  console.log('Cleaning dist/')
  await rm(outdir, { recursive: true, force: true })
}

const start = performance.now()

// Build app (HTML entrypoints) and service worker in parallel
const [appResult, swResult] = await Promise.all([
  Bun.build({
    entrypoints: ['src/index.html'],
    outdir,
    plugins: [plugin],
    minify: true,
    target: 'browser',
    sourcemap: 'linked',
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.BUN_PUBLIC_SYNC_ENABLED': JSON.stringify(process.env.BUN_PUBLIC_SYNC_ENABLED ?? 'false'),
    },
  }),
  Bun.build({
    entrypoints: ['src/sw.js'],
    outdir,
    minify: true,
    target: 'browser',
    naming: '[name].[ext]',
  }),
])

if (!appResult.success) {
  console.error('App build failed:', appResult.logs)
  process.exit(1)
}
if (!swResult.success) {
  console.error('SW build failed:', swResult.logs)
  process.exit(1)
}

// Copy pre-converted 128kbps MP3s and lyrics to dist/
await mkdir(`${outdir}/vocals`, { recursive: true })
await mkdir(`${outdir}/no-vocals`, { recursive: true })
await mkdir(`${outdir}/lyrics`, { recursive: true })

async function copyGlob(pattern, inputDir, outputDir) {
  const tasks = []
  for await (const file of new Bun.Glob(pattern).scan({ cwd: inputDir, onlyFiles: true })) {
    tasks.push(Bun.write(path.join(outputDir, file), Bun.file(path.join(inputDir, file))))
  }
  await Promise.all(tasks)
}

console.log('\nCopying audio, lyrics and PWA assets…')
await Promise.all([
  copyGlob('*.mp3', vocalsDir, `${outdir}/vocals`),
  copyGlob('*.mp3', noVocalsDir, `${outdir}/no-vocals`),
  copyGlob('*.html', 'src/lyrics', `${outdir}/lyrics`),
  Bun.write(`${outdir}/manifest.json`, Bun.file('src/manifest.json')),
  Bun.write(`${outdir}/icon-180.png`, Bun.file('src/icon-180.png')),
  Bun.write(`${outdir}/icon-192.png`, Bun.file('src/icon-192.png')),
  Bun.write(`${outdir}/icon-512.png`, Bun.file('src/icon-512.png')),
])

const elapsed = ((performance.now() - start) / 1000).toFixed(1)
console.log(`\nBuild complete in ${elapsed}s`)
