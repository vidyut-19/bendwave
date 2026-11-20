# vibedeck

A vibe-coded, stem-aware DJ tool. Two Web Audio decks, automatic beatgrids, tempo + phase
auto-sync, keyboard control, and MIDI-learn for anything with pads and faders — built with a
Teenage Engineering K.O. II in mind, but happy with any class-compliant USB MIDI controller.

## What works today (v0.2)

- **Two decks + mixer**: play/pause, CDJ-style cue (hold to preview, release to return),
  set-cue, pitch fader (±8%), pitch bend, 3-band EQ per deck, equal-power crossfader, master.
- **Waveform + beatgrid**: scrolling zoomable waveform per deck with beat lines, downbeats,
  cue and hot-cue markers. Click/drag to seek, wheel to zoom.
- **Hot cues**: 4 per deck, per-track persistent, colored, shown on the waveform —
  keyboard (`A S D F` / `J K L ;`, shift to set, alt-click to clear) or MIDI-learned pads.
- **Sync with drift lock**: SYNC matches tempo + phase, then a soft PLL keeps the slave
  locked to the master while both play. SYNC again (or any manual pitch/scrub) releases.
- **Key lock (experimental)**: WSOLA time-stretcher in an AudioWorklet — change tempo,
  keep pitch. Full-mix decks only (not with stems); ~70ms lookahead; honest at small
  pitch ranges, warbly at extremes.
- **Loops & loop rolls**: 1/2/4/8-beat loops quantized to the beatgrid. Default mode is
  momentary rolls (hold the pad, the loop plays while the virtual position keeps advancing —
  release and you land where the track would have been, the classic roll transition).
  LATCH mode turns the pads into toggling auto-loops. Active loops render as a shaded region
  on the waveform. Works with stems; with key lock the worklet loops internally.
- **FX rack per deck**: DJ filter (LP/HP combo knob, double-click to reset), beat-synced
  delay with wet/feedback controls and switchable fraction (1/4, 1/2, 3/4, 1/1), reverb,
  and a momentary **echo out** (`G`/`H` — hold for the transition, release to let it ring).
- **Channel volume faders + input trim** per deck (post-FX volume, pre-EQ ±12dB trim).
- **Split-cue headphone monitoring**: per-deck CUE buttons + SPLIT CUE mode routes master
  on channels 1/2 and the cue bus on 3/4 — pair with a macOS Aggregate Device
  (speakers + headphones) to pre-listen like a real mixer.
- **K.O. II preset**: documented pad map (groups A–D, notes 36–83) loaded with one click,
  plus an auto-map wizard for faders/knobs — see [docs/ko2-mapping.md](docs/ko2-mapping.md).
- **Memory architecture**: decoded-audio budget manager (1.25 GB default) with LRU
  eviction for stream caches, peak mip-pyramids so waveform redraw is O(pixels) at any
  zoom, and a live `AUDIO used/budget` meter in the header. Full design — including the
  int16 sample-store and windowed file-paging tiers — in [docs/memory.md](docs/memory.md).
- **Off-the-shelf DSP core**: key lock now runs on **Signalsmith Stretch** (MIT, official
  WASM/AudioWorklet build) — the same node's streaming API is the foundation for the
  memory tiers above. The hand-rolled WSOLA worklet remains as automatic fallback.
- **Drop-and-play**: drag WAV/FLAC/MP3/AIFF/M4A anywhere, or use "add tracks…".
- **Instant BPM**: an in-browser onset/autocorrelation beatgrid estimator runs the moment a
  track loads — no dependencies required.
- **Stems (optional)**: with `demucs` + `librosa` installed, each new track is re-analyzed by
  the python sidecar: better BPM + offset, musical key (Camelot), and 4 separated stems
  (drums / bass / other / vocals). Stems load onto the deck as sample-aligned layers with
  per-stem faders.
- **Keyboard control** (see map below).
- **MIDI learn**: click *learn* next to any action, then touch a pad/knob/fader on your
  controller. Bindings persist. Absolute CCs can drive the crossfader.
- **Crate**: tracks, BPM, key, cue points, hot cues and stem status persist in
  `~/Library/Application Support/vibedeck/crate.json`.
- **Streaming-ready**: SoundCloud integration built in — OAuth 2.1 + PKCE login, search,
  streaming, decode to in-memory AudioBuffer, beatgrid + sync + waveform + cues all work on
  streamed tracks. Stems are intentionally disabled on streamed content (their API terms
  forbid it — the code enforces `stemsAllowed: false`). Setup:
  [docs/streaming.md](docs/streaming.md).

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
| `R` | Deck A sync (toggle lock) | | `U` | Deck B sync (toggle lock) |
| `1` / `2` | Deck A bend −/+ | | `9` / `0` | Deck B bend −/+ |
| `3` | Deck A key lock | | `8` | Deck B key lock |
| `A` `S` `D` `F` | Deck A hot cues 1–4 | | `J` `K` `L` `;` | Deck B hot cues 1–4 |
| `Shift` + hotcue key | Set that hot cue | | `,` / `.` | Crossfader left/right |
| `G` / `H` | Deck A/B echo out (hold) | | `Space` | Crossfader center |
| `Z` / `/` | Deck A/B headphone cue | | `X` | Split cue on/off |
| `4`–`7` | Deck A loop rolls 1/2/4/8 | | `B` `N` `M` `'` | Deck B loop rolls 1/2/4/8 |
| `T` / `Y` | Deck A/B loop latch mode | | wheel on waveform | zoom in/out |

## Architecture

ASCII diagrams of the signal path, memory tiers, and control plane live in
[docs/architecture.md](docs/architecture.md).

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
  matched to the master's current beat phase, seeking to the nearest beat) + an ongoing
  drift lock (proportional phase correction, ±3% clamp, 5Hz update) while both decks play.
- **Key lock** = `keylock-worklet.js`, a WSOLA-style granular time-stretcher in an
  AudioWorklet (Hann-windowed overlap-add + cross-correlation grain alignment). Audio runs
  ~70ms ahead of the position math; the worklet reports its true audible position back to
  the deck to keep the numbers honest. Falls back to plain resampling if worklets fail.
- **Stems are precomputed, not real-time**: separation runs once at ingestion; the deck then
  plays 4 sample-aligned buffers with gain nodes. The live path does zero ML, so sync/latency
  behave exactly like a normal track. Key lock is unavailable while stems are loaded.
- Stem WAVs land in `~/Library/Application Support/vibedeck/stems/<id>/…`.
- **Streaming**: `src/renderer/sources/provider.ts` defines the seam; research on
  SoundCloud/Spotify/TIDAL/YouTube lives in [docs/streaming.md](docs/streaming.md).

## Roadmap

- [x] SoundCloud provider (OAuth 2.1 + PKCE, progressive stream → PCM, session-only cache, stems gated off)
- [ ] TIDAL catalog enrichment (BPM/key backfill for the crate)
- [ ] Beatgrid editing (tap tempo, nudge offset, half/double buttons)
- [ ] Loop rolls (beat-loop 1/2/4/8 with worklet-friendly seek logic)
- [ ] Waveform overview strip + library search/sort
- [ ] Stem-aware recording of the master bus
- [ ] Better key lock (phase vocoder or Rubber Band offline pre-render)
- [ ] Analysis queue with progress UI for big crate imports

## Study material / credits

- [Mixxx](https://mixxx.org) — open-source DJ engine; read it for beatgrids, sync, keylock
- [Demucs](https://github.com/adefossez/demucs) — stem separation
- [librosa](https://librosa.org) — tempo/key analysis
- [aubio](https://aubio.org) — fast onset/tempo detection (C, WASM builds exist)

## Legal note

Stem separation and beatgrids for personal performance use are fine. Distributing separated
acapellas or remixes of copyrighted tracks is a rights issue — yours, not the code's.
