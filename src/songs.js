export const songs = [
  { id: '1.1', title: "You're Stuck With Us",    vocalsFile: "1.1 You're Stuck With Us.mp3",        noVocalsFile: "1.1 Youre Stuck With Us (No Vocals).mp3",           isolatedFile: '1.1.mp3' },
  { id: '1.6', title: 'Happiest Place on Earth', vocalsFile: '1.6 Happiest Place on Earth.mp3',     noVocalsFile: '1.6 Happiest Place on Earth (No Vocals).mp3',       isolatedFile: '1.6.mp3' },
  { id: '2.2', title: 'A Real Song',             vocalsFile: '2.2 A Real Song.mp3',                 noVocalsFile: '2.2 A Real Song (No Vocals).mp3',                   isolatedFile: '2.2.mp3' },
  { id: '2.4', title: 'A Real Song (Reprise)',   vocalsFile: '2.4 A Real Song (Reprise).mp3',       noVocalsFile: '2.4 A Real Song (Reprise) (No Vocals).mp3',         isolatedFile: null },
  { id: '2.7', title: 'In A Funk',               vocalsFile: '2.7 In A Funk.mp3',                   noVocalsFile: '2.7 In A Funk (No Vocals).mp3',                     isolatedFile: null },
  { id: '3.3', title: 'One of Us',               vocalsFile: '3.3 One of Us.mp3',                   noVocalsFile: '3.3 One of Us (No Vocals).mp3',                     isolatedFile: '3.3.mp3' },
  { id: '3.6', title: 'Into the Sky',            vocalsFile: '3.6 Into the Sky.mp3',                noVocalsFile: '3.6 Into the Sky (No Vocals).mp3',                  isolatedFile: '3.6.mp3' },
  { id: '4.3', title: 'Panic Takes Over',        vocalsFile: '4.3 Panic Takes Over.mp3',            noVocalsFile: '4.3 Panic Takes Over (No Vocals).mp3',              isolatedFile: '4.3.mp3' },
  { id: '5.0', title: 'Entracte',                vocalsFile: '5.0 Entracte.mp3',                    noVocalsFile: null,                                                isolatedFile: null },
  { id: '5.1', title: 'Make You Happy',          vocalsFile: '5.1 Make You Happy.mp3',              noVocalsFile: '5.1 Make You Happy (No Vocals).mp3',                isolatedFile: '5.1.mp3' },
  { id: '5.6', title: 'Back in My Day',          vocalsFile: '5.6 Back in My Day.mp3',              noVocalsFile: '5.6 Back in My Day (No Vocals).mp3',                isolatedFile: '5.6.mp3' },
  { id: '6.2', title: 'Never Be Sad Again',      vocalsFile: '6.2 Never Be Sad Again.mp3',          noVocalsFile: '6.2 Never Be Sad Again (No Vocals).mp3',            isolatedFile: '6.2.mp3' },
  { id: '6.6', title: 'Stop the Music',          vocalsFile: '6.6 Stop the Music.mp3',              noVocalsFile: '6.6 Stop the Music (No Vocals).mp3',                isolatedFile: '6.6.mp3' },
  { id: '7.2', title: 'Tower, Tower',            vocalsFile: '7.2 Tower, Tower.mp3',                noVocalsFile: '7.2 Tower, Tower (No Vocals).mp3',                  isolatedFile: '7.2.mp3' },
  { id: '7.4', title: 'Megamix Part 1',          vocalsFile: '7.4 Megamix Part 1.mp3',              noVocalsFile: '7.4 Megamix Part 1 (No Vocals).mp3',                isolatedFile: null,        precacheAudio: true },
  { id: '8.1', title: 'Scarves of Blue',         vocalsFile: '8.1 Scarves of Blue (2026).mp3',      noVocalsFile: '8.1 Scarves of Blue (No Vocals).mp3',               isolatedFile: '8.1.mp3' },
]

export function vocalsUrl(song) {
  return `/vocals/${encodeURIComponent(song.vocalsFile)}`
}

export function noVocalsUrl(song) {
  if (!song.noVocalsFile) return null
  return `/no-vocals/${encodeURIComponent(song.noVocalsFile)}`
}

export function songUrls(song) {
  return [vocalsUrl(song), noVocalsUrl(song), isolatedUrl(song)].filter(Boolean)
}

export function songById(id) {
  return songs.find(s => s.id === id)
}

export function lyricsUrl(song) {
  return `/lyrics/${song.id}.html`
}

export function isolatedUrl(song) {
  if (!song.isolatedFile) return null
  return `/vocals-isolated/${encodeURIComponent(song.isolatedFile)}`
}

export function melodyUrl(song) {
  return `/melody/${song.id}.json`
}
