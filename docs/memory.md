# vibedeck memory architecture

Status: design + Tier 0 implemented (Nov 2026). This is the plan for making audio memory
deliberate instead of "decodeAudioData and hope".

## The arithmetic that drives everything

Decoded PCM costs **`sampleRate × channels × 4 bytes` per second**:

| Content | RAM |
|---|---|
| 1 min stereo @44.1k (Float32) | ~21 MB |
| 5 min track | ~106 MB |
| 5 min track **with 4 stems** (main kept + drums/bass/other/vocals) | **~530 MB** |
| Two decks, both stemmed 5-min tracks | ~1.06 GB |
| + key-lock engine copy of the mix (per deck) | +~106 MB |
| 90-min mix WAV, stereo | ~1.9 GB |

Everything below exists to keep those numbers bounded and visible.

## Current-state audit (what Tier 0 fixes)

1. **No accounting**: nothing knows how much decoded audio is alive. → fixed: `AudioMemory`.
2. **Unbounded SoundCloud session cache**: every streamed track ever played this session
   stays decoded. → fixed: cache entries register with the budget and evict LRU.
3. **O(peaks) waveform redraw at far zoom**: one flat peaks array scanned per pixel column;
   zoomed out, each column scans thousands of buckets at 60fps. → fixed: peak mip-pyramid,
   redraw is O(pixels) at any zoom.
4. **Key-lock copy**: exactly one copy exists (channel `slice()` transferred into the engine)
   — already minimal, now counted in usage (approximation until Tier 1).

## Tier 0 — implemented now

```
AudioMemory (engine/memory.ts)
  ├── registry: id → { label, bytes, lastUsed, release? }
  ├── bytesOf(...buffers)        // sr × ch × 4 × length
  ├── track/touch/release        // decks touch every tick; entries are LRU-ordered
  ├── enforce(protectedIds)      // evicts non-protected LRU until under budget
  └── usage()                    // feeds the header meter: AUDIO 412M / 1.3G
```

Rules:
- Budget: **1.25 GB** default for decoded audio (`AudioMemory` constructor).
- **Protected** = the track currently on deck A or B. Those buffers can't actually be freed
  (decks hold references), so they're never eviction candidates.
- Evictable today: SoundCloud session cache (release hook deletes the provider cache entry —
  a re-load just re-streams). This is the template for every future cache.
- Meter in the header updates 1Hz; evictions log.

## Tier 1 — halve the floor (int16 sample store)

Move track storage from `AudioBuffer` (Float32) to planar **Int16** inside the playback
engine's WASM/heap memory:

- 2 bytes/sample instead of 4 → the whole table above halves. 96 dB SNR, ~20 bits of
  dynamic range headroom above any club rig's noise floor — sonically a non-issue for DJ use.
- With the off-the-shelf engine (see DSP appendix) the flow is:
  `decodeAudioData → copy→Int16 → addBuffers() → drop the AudioBuffer`.
- Stems get the same treatment; additionally offer a **mono-stems option** (halve again —
  stems exist to be filtered, not admired).
- When stems are active the main-mix buffer is droppable entirely (playback uses stems),
  taking a stemmed deck from 5× to 2.5× (int16) or 1.25× (int16+mono) of stereo size.

## Tier 2 — bounded RAM for unbounded files (windowed paging)

Target: RAM footprint independent of file length. The streaming primitives are already in
the engine node (`addBuffers()` appends, `dropBuffers(toSeconds)` releases behind the
playhead).

```
PageStore (per deck, file-backed)
  ├── page size: ~10 s of PCM (~8.5 MB stereo int16)
  ├── ring: keep [playhead − 20 s, playhead + 40 s] decoded (≈ 8 pages)
  ├── decode-ahead: fill ring from file slices off-thread
  ├── seek = page fault: drop ring, decode nearest page first, resume
  └── eviction: dropBuffers() behind the playhead every boundary
```

Format realities:
- **WAV**: trivial — `fs.read` the byte range, wrap a header, decode. Can ship first.
- **FLAC/MP3/M4A**: need frame-accurate demux. Options: `flac`/`mpg123-decoder` WASM
  decoders running in a Worker (decodeAudioData **cannot run in a Worker** — no
  AudioContext there; WASM decoders are the worker-friendly path), or an audio-only
  ffmpeg.wasm (~5 MB) as the universal decoder.
- Stems: same paging per stem layer (5 parallel rings), or pre-transcode stems to FLAC on
  disk at ingestion (they're currently WAV — 4× disk waste).

Concurrency model: decoding in Workers; feeding the engine on the main thread via
transferred ArrayBuffers (no SharedArrayBuffer needed — see notes).

## Tier 3 — process hygiene

- Electron renderer currently hosts audio + UI + analysis. `AudioContext` cannot live in a
  utility process, so full isolation is off the table; instead move **all decode/peaks/
  beatgrid work into Workers** (WASM decoders make this possible) so the audio thread only
  ever receives ready buffers.
- Cap V8 heap (`--js-flags=--max-old-space-size=2048`) at packaging time so GC pressure
  from the crate/UI can't balloon unbounded (decoded AudioBuffers live outside this heap,
  but analysis temporaries don't).
- rAF discipline (already mostly holds): tick allocates nothing; waveform draw uses
  prebuilt mip levels.

## SharedArrayBuffer: why not

Zero-copy main↔worklet sharing needs `crossOriginIsolated`, which needs COOP/COEP headers —
awkward for `file://` in Electron. We don't need it: **transfer-based double-buffering**
(post the next chunk, transfer ownership, allocate the next) gives the same streaming
behavior with one extra buffer in flight. SAB is only worth revisiting if we later move
paging into a Worker and want lock-free handoff.

## DSP core appendix (the other question)

Why hand-roll WSOLA when these exist:

| Library | License | Web story | Quality @ ±8% | Notes |
|---|---|---|---|---|
| **Signalsmith Stretch** | **MIT** | **official WASM/AudioWorklet, npm, 0 deps** | excellent (rated near élastique-class in a 2025 blind test) | `rate`+`semitones` independent, native loops, `addBuffers`/`dropBuffers` streaming — effectively a deck engine |
| Rubber Band | GPL / commercial | community WASM (`rubberband-wasm`) | excellent, industry pedigree | GPL is fine for a private app; commercial license needed to distribute closed |
| SoundTouch | LGPL | `soundtouchjs` | acceptable | time-domain; doubles/misses kicks — below DJ standard |
| zplane élastique | commercial | none public | the commercial gold standard (licensed by major DJ software) | $$$$ — what "real Serato" money buys |

**Decision**: key lock now runs on **Signalsmith Stretch** (`signalsmith-stretch` npm) with
the hand-rolled WSOLA worklet kept as automatic fallback. Longer term the same node's
streaming API is the foundation for Tier 2 paging — one dependency, two problems.

## Monitoring

- Header meter (`AUDIO used / budget`).
- Eviction log lines.
- Electron DevTools → Memory / Task Manager (Process memory ∆) for ground truth.
