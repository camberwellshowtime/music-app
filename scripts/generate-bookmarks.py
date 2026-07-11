#!/usr/bin/env python3
"""
Generate section bookmarks by aligning lyrics sections against Whisper STT
on isolated vocal tracks, then snapping to a beat just before each section.

Pipeline:
  lyrics HTML  →  section names + first-words probe
  isolated MP3 →  Whisper word-level timestamps
  beats.json   →  snap raw timestamp to nearest clean beat
                  (offset ~1 s back so the listener gets a run-in)

Outputs: src/data/bookmarks-seed.js

Usage:
  python3 scripts/generate-bookmarks.py                     # all songs, parallel
  python3 scripts/generate-bookmarks.py 1.1 3.6             # specific songs
  python3 scripts/generate-bookmarks.py --model turbo       # faster/larger model
  python3 scripts/generate-bookmarks.py --run-in 0.5        # shorter run-in
  python3 scripts/generate-bookmarks.py --workers 4         # limit parallelism
"""

import sys, json, re, argparse, multiprocessing as mp
from pathlib import Path
from html.parser import HTMLParser
import difflib

# ── Paths ─────────────────────────────────────────────────────────────────────

REPO     = Path(__file__).parent.parent
BEATS_F  = REPO / 'src/data/beats.json'
LYRICS_D = REPO / 'src/lyrics'
VOCALS_D = REPO / 'vocals-isolated-128'
OUT_F    = REPO / 'src/data/bookmarks-seed.js'

PROBE_LEN = 8    # lyric words used to locate each section in Whisper output
MIN_GAP_S = 5.0  # minimum seconds between consecutive section starts

# ── Section name abbreviations ────────────────────────────────────────────────

def abbreviate(raw: str) -> str:
    """'Verse 1 (S.A.D.)' → 'V1',  'Pre-Chorus 2' → 'Pre-C2',  'Post Chorus' → 'Post Chorus'"""
    name = re.sub(r'\s*\([^)]*\)', '', raw).strip()  # strip "(S.A.D.)" etc.
    if m := re.match(r'^verse\s+(\d+)$', name, re.I):        return f'V{m[1]}'
    if m := re.match(r'^chorus\s+(\d+)$', name, re.I):       return f'C{m[1]}'
    if m := re.match(r'^pre[- ]chorus\s+(\d+)$', name, re.I): return f'Pre-C{m[1]}'
    if m := re.match(r'^bridge\s+(\d+)$', name, re.I):       return f'B{m[1]}'
    if m := re.match(r'^section\s+(\d+)$', name, re.I):      return f'S{m[1]}'
    return name

# ── Lyrics HTML parser ────────────────────────────────────────────────────────

class LyricsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sections: list[dict] = []
        self._h2_buf: str | None = None
        self._text_buf: str | None = None

    def handle_starttag(self, tag, attrs):
        if tag == 'h2':
            self._h2_buf = ''
        elif tag in ('li', 'p', 'td') and self.sections:
            self._text_buf = ''
        elif tag == 'br' and self._text_buf is not None:
            self._text_buf += ' '

    def handle_endtag(self, tag):
        if tag == 'h2' and self._h2_buf is not None:
            raw = self._h2_buf.strip()
            self.sections.append({'name': raw, 'label': abbreviate(raw), 'words': []})
            self._h2_buf = None
        elif tag in ('li', 'p', 'td') and self._text_buf is not None:
            if self.sections:
                self.sections[-1]['words'].extend(_normalize(self._text_buf))
            self._text_buf = None

    def handle_data(self, data):
        if self._h2_buf is not None:
            self._h2_buf += data
        elif self._text_buf is not None:
            data = re.sub(r'^[A-Z][A-Z\s.]*:\s*', '', data)   # drop "ALL:", "TOWN:" etc.
            data = re.sub(r'^\s*\d+\.\s+', '', data)            # drop "18. " table prefixes
            self._text_buf += data

def _normalize(text: str) -> list[str]:
    """Lowercase, strip punctuation/stage-directions, return meaningful words."""
    text = text.lower()
    text = re.sub(r"[''`]", "'", text)
    text = re.sub(r'\(.*?\)', ' ', text)   # drop stage directions: (Quietly)
    text = re.sub(r'[^a-z0-9\' ]', ' ', text)
    return [w for w in text.split() if len(w) > 1]

def parse_lyrics(path: Path) -> list[dict]:
    p = LyricsParser()
    p.feed(path.read_text())
    return [s for s in p.sections if s['words']]

# ── Beat snapping ─────────────────────────────────────────────────────────────

def snap_to_beat(t: float, beats: list[float]) -> float:
    """Return the beat timestamp at-or-before t."""
    lo, hi = 0, len(beats) - 1
    while lo < hi:
        mid = (lo + hi + 1) >> 1
        if beats[mid] <= t: lo = mid
        else: hi = mid - 1
    # Snap forward if we're within 15% of the next beat (Whisper often timestamps
    # words a fraction late, so this corrects tiny drift at the boundary).
    if lo + 1 < len(beats):
        gap = beats[lo + 1] - beats[lo]
        if beats[lo + 1] - t < gap * 0.15:
            return round(beats[lo + 1], 3)
    return round(beats[lo], 3)

# ── Whisper transcription ─────────────────────────────────────────────────────

def _transcribe(audio_path: str, model) -> tuple[list[dict], list[str]]:
    """Run Whisper on audio_path. Returns (word_list, log_lines)."""
    logs = [f'  Transcribing {Path(audio_path).name}…']
    result = model.transcribe(
        audio_path,
        language='en',
        word_timestamps=True,
        verbose=False,
    )
    words = []
    for seg in result['segments']:
        for w in seg.get('words', []):
            clean = re.sub(r"[''`]", "'", w['word'].lower().strip())
            clean = re.sub(r'[^a-z0-9\' ]', '', clean).strip()
            if len(clean) > 1:
                words.append({'word': clean, 'start': w['start'], 'end': w['end']})
    return words, logs

# ── Section alignment ─────────────────────────────────────────────────────────

def find_section(probe: list[str], whisper_words: list[dict], after: float) -> float | None:
    """Slide probe across whisper_words after `after` seconds; return best start time."""
    cands = [w for w in whisper_words if w['start'] >= after]
    if len(cands) < PROBE_LEN or len(probe) < 3:
        return None

    probe_str = ' '.join(probe[:PROBE_LEN])
    wlist = [w['word'] for w in cands]

    best_score, best_time = 0.0, None
    for i in range(len(wlist) - PROBE_LEN + 1):
        window = ' '.join(wlist[i : i + PROBE_LEN])
        score  = difflib.SequenceMatcher(None, probe_str, window, autojunk=False).ratio()
        if score > best_score:
            best_score = score
            best_time  = cands[i]['start']

    return best_time if best_score >= 0.40 else None

# ── Multiprocessing worker ────────────────────────────────────────────────────

_worker_model = None   # initialised once per worker process

def _worker_init(model_name: str):
    global _worker_model
    import whisper, warnings
    warnings.filterwarnings('ignore')  # suppress fp16 CPU warning
    _worker_model = whisper.load_model(model_name)

def _worker_task(task: dict) -> dict:
    """Runs in a worker process. Returns {song_id, bookmarks, logs}."""
    song_id  = task['song_id']
    beats    = task['beats']
    sections = task['sections']
    audio    = task['audio_path']
    run_in   = task['run_in']
    source   = task['source']

    logs = [f'\n── {song_id} ───────────────────────────────────────']

    words, xlogs = _transcribe(audio, _worker_model)
    logs.extend(xlogs)
    logs.append(f'  {len(sections)} sections, {len(words)} Whisper words')

    bookmarks, min_time = [], 0.0
    for sec in sections:
        probe = sec['words'][:PROBE_LEN]
        raw_t = find_section(probe, words, after=min_time)
        if raw_t is None:
            logs.append(f'    ✗ {sec["label"]:20s}  — no match  (probe: {" ".join(probe[:4])}…)')
            continue
        target  = max(0.0, raw_t - run_in)
        snapped = 0.0 if target == 0.0 else (snap_to_beat(target, beats) if beats else round(target, 3))
        bookmarks.append({'songId': song_id, 'time': snapped, 'label': sec['label'], 'source': source})
        logs.append(f'    ✓ {sec["label"]:20s}  raw {raw_t:.2f}s  →  beat {snapped:.2f}s')
        min_time = raw_t + MIN_GAP_S

    return {'song_id': song_id, 'bookmarks': bookmarks, 'logs': logs}

# ── Output ────────────────────────────────────────────────────────────────────

def write_output(new_bookmarks: list[dict], processed_ids: set):
    """Write bookmarks-seed.js, preserving existing entries for untouched songs."""
    kept = []
    if OUT_F.exists():
        for m in re.finditer(
            r"\{\s*songId:\s*'([^']+)',\s*time:\s*([\d.]+),\s*label:\s*'([^']+)'(?:,\s*source:\s*'([^']*)')?\s*\}",
            OUT_F.read_text()
        ):
            sid, time, label, src = m[1], float(m[2]), m[3], m[4]
            if sid not in processed_ids:
                entry = {'songId': sid, 'time': time, 'label': label}
                if src: entry['source'] = src
                kept.append(entry)

    combined = sorted(kept + new_bookmarks, key=lambda b: (b['songId'], b['time']))

    def esc(s): return s.replace("'", "\\'")
    lines = []
    for b in combined:
        src_part = f", source: '{esc(b['source'])}'" if b.get('source') else ''
        lines.append(f"  {{ songId: '{esc(b['songId'])}', time: {b['time']}, label: '{esc(b['label'])}'{src_part} }}")

    OUT_F.write_text('export const seedBookmarks = [\n' + ',\n'.join(lines) + '\n]\n')
    print(f'\nWrote {len(combined)} bookmarks ({len(new_bookmarks)} new/updated) → {OUT_F}')

# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('songs',      nargs='*',          help='Song IDs to process (default: all)')
    ap.add_argument('--model',    default='medium',    help='Whisper model (tiny/base/small/medium/large/turbo)')
    ap.add_argument('--run-in',   type=float, default=1.0, metavar='SECS',
                    help='Seconds before section start to place bookmark (default: 1.0)')
    ap.add_argument('--workers',  type=int, default=None, metavar='N',
                    help='Parallel worker processes (default: one per song, up to CPU count)')
    args = ap.parse_args()

    beats_db = json.loads(BEATS_F.read_text())
    all_ids  = sorted(p.stem for p in VOCALS_D.glob('*.mp3'))
    song_ids = args.songs or all_ids

    bad = [s for s in song_ids if s not in all_ids]
    if bad:
        ap.error(f'No isolated vocal for: {", ".join(bad)}')

    source = f'whisper-{args.model}'

    # Build tasks (lyrics parsing happens here in the main process)
    tasks = []
    for sid in song_ids:
        lyrics_path = LYRICS_D / f'{sid}.html'
        audio_path  = VOCALS_D / f'{sid}.mp3'
        if not lyrics_path.exists():
            print(f'[{sid}] No lyrics, skipping.')
            continue
        sections = parse_lyrics(lyrics_path)
        beats    = beats_db.get(sid, {}).get('beats', [])
        tasks.append({
            'song_id':    sid,
            'beats':      beats,
            'sections':   sections,
            'audio_path': str(audio_path),
            'run_in':     args.run_in,
            'source':     source,
        })

    n_workers = min(args.workers or mp.cpu_count(), len(tasks))
    print(f'Processing {len(tasks)} songs with {n_workers} worker(s), model="{args.model}"…')
    print(f'(Each worker loads Whisper independently — model cached after first run)\n')

    new_bookmarks = []
    with mp.Pool(processes=n_workers, initializer=_worker_init, initargs=(args.model,)) as pool:
        for result in pool.imap_unordered(_worker_task, tasks):
            for line in result['logs']:
                print(line)
            new_bookmarks.extend(result['bookmarks'])

    write_output(new_bookmarks, set(song_ids))

if __name__ == '__main__':
    main()
