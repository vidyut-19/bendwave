# vibedeck

A vibe-coded, stem-aware DJ tool. Two Web Audio decks, automatic beatgrids, tempo + phase
auto-sync, keyboard control, and MIDI-learn for anything with pads and faders — built with a
Teenage Engineering K.O. II in mind, but happy with any class-compliant USB MIDI controller.

## What works today (v0.1)

- **Two decks + mixer**: play/pause, CDJ-style cue (hold to preview, release to return),
  set-cue, pitch fader (±8%), pitch bend, 3-band EQ per deck, equal-power crossfader, master.
- **Drop-and-play**: drag WAV/FLAC/MP3/AIFF/M4A anywhere, or use "add tracks…".
- **Instant BPM**: an in-browser onset/autocorrelation beatgrid estimator runs the moment a
  track loads — no dependencies required.
- **Auto-sync**: SYNC matches the other deck's effective BPM and phase-aligns the beatgrid.
- **Stems (optional)**: with `demucs` + `librosa` installed, each new track is re-analyzed by
  the python sidecar: better BPM + offset, musical key (Camelot), and 4 separated stems
  (drums / bass / other / vocals). Stems load onto the deck as sample-aligned layers with
  per-stem faders.
- **Keyboard control** (see map below).
- **MIDI learn**: click *learn* next to any action, then touch a pad/knob/fader on your
  controller. Bindings persist. Absolute CCs can drive the crossfader.
- **Crate**: tracks, BPM, key, stem status persist in `~/Library/Application Support/vibedeck/crate.json`.

## Quickstart

```bash
npm install
npm run dev        # vite + electron with hot reload on the renderer
```

For the full ingestion pipeline (better BPM, key detection, stems):

```bash
pip install librosa soundfile
pip install demucs   # optional, pulls torch — needed for stems
```

Without these, vibedeck still works: browser-side BPM estimation covers beatmatching and sync.

## Keyboard map

| Key | Action | | Key | Action |
|---|---|---|---|---|
| `Q` | Deck A play/pause | | `P` | Deck B play/pause |
| `W` | Deck A cue (hold) | | `O` | Deck B cue (hold) |
| `E` | Deck A set cue | | `I` | Deck B set cue |
| `R` | Deck A sync | | `U` | Deck B sync |
| `1` / `2` | Deck A bend −/+ | | `9` / `0` | Deck B bend −/+ |
| `,` / `.` | Crossfader left/right | | `Space` | Crossfader center |

## Architecture

```
electron/main.ts            window, IPC: file dialog, audio reads, crate JSON, sidecar spawn
electron/preload.ts         contextBridge (incl. webUtils path for drag & drop)
src/renderer/
  engine/deck.ts            deck: sources, position math, rate/bend, cue, sync, stem layers
  engine/engine.ts          audio context, master, mixer (equal-power crossfade)
  engine/analysis.ts        browser beatgrid: RMS onset envelope → autocorrelation → phase fit
  crate/store.ts            crate persistence (JSON via IPC, debounced)
  midi/midi.ts              Web MIDI learn router (bindings in localStorage)
  ui.ts, style.css          vanilla DOM UI
tools/analyze.py            sidecar: librosa (bpm/offset/key/camelot) + demucs (4 stems)
```

Design notes:

- **Position math**: `position = startPos + (ctx.currentTime − startedAt) × effRate`. Rate
  changes rebase the anchor and push `playbackRate` onto live sources, so tempo changes never
  glitch or restart playback.
- **Sync** = tempo lock (`rate = masterEffBpm / trackBpm`) + phase alignment (grid phase
  matched to the master's current beat phase, seeking to the nearest beat). No ongoing drift
  correction yet — see roadmap.
- **Stems are precomputed, not real-time**: separation runs once at ingestion; the deck then
  plays 4 sample-aligned buffers with gain nodes. The live path does zero ML, so sync/latency
  behave exactly like a normal track.
- Stem WAVs land in `~/Library/Application Support/vibedeck/stems/<id>/…`.

## Roadmap

- [ ] Waveform + beatgrid rendering, click-to-seek
- [ ] Hot cues (4 per deck, pads + MIDI)
- [ ] Drift-correcting sync (PLL-style micro-nudge while both decks play)
- [ ] Key lock: AudioWorklet phase vocoder or offline Rubber Band–style stretch
- [ ] Real-time stem separation for un-analyzed tracks (ONNX / CoreML sidecar)
- [ ] Stem-aware recording of the master bus
- [ ] Crate: search, sort, playlists, analysis queue with progress

## Study material / credits

- [Mixxx](https://mixxx.org) — open-source DJ engine; read it for beatgrids, sync, keylock
- [Demucs](https://github.com/adefossez/demucs) — stem separation
- [librosa](https://librosa.org) — tempo/key analysis
- [aubio](https://aubio.org) — fast onset/tempo detection (C, WASM builds exist)

## Legal note

Stem separation and beatgrids for personal performance use are fine. Distributing separated
acapellas or remixes of copyrighted tracks is a rights issue — yours, not the code's.
