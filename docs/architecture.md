# vibedeck architecture (ASCII)

## 1. Signal path — what one sample travels through

```
 file on disk                     SoundCloud (OAuth 2.1 + PKCE)
    │                                        │
    │ IPC read                        progressive MP3 via main-process proxy
    ▼                                        ▼
 decodeAudioData  ──────────────►  decodeAudioData
 (full file → Float32 AudioBuffer, ~21 MB/min stereo — see memory below)
    │
    ▼
╔══════════════════════════ DECK (A / B) ═══════════════════════════════╗
║                                                                        ║
║  playback source (one of three, swapped per mode):                    ║
║                                                                        ║
║   plain            AudioBufferSourceNode (rate = chipmunk resample)    ║
║   key lock ON  ┌─► Signalsmith Stretch  [MIT WASM/AudioWorklet]        ║
║                │   rate = tempo change, pitch intact;                  ║
║                │   native loopStart/loopEnd; fallback = WSOLA worklet  ║
║   stems        │   4× (source→gain) drums bass other vocals            ║
║                │      (replace the full mix; no key lock)              ║
║                └────────────┬───────────────────────────────────────┐  ║
║                             ▼                                       │  ║
║  loops/rolls    scheduler: next iteration's sources start() at the   │  ║
║                 exact boundary time; virtual position keeps running  │  ║
║                             ▼                                       ▼  ║
║  TRIM (preGain ±12dB) ─► EQ (low/mid/high) ─► FX: filter (LP|HP)      │  ║
║                                            └► delay ⇄ feedback        │  ║
║                                            └► reverb (generated IR)   │  ║
║                             ▼                                          │ ║
║  VOL (channel fader) ─────────────────────────────────────────────┐    │ ║
╚══════════════════════════════════════════════════════════════════│════╝
                                                                   │
     deck A ═══► crossfader (equal-power curve) ◄═══ deck B        │ cue tap
                       │                                            ▼
                       ▼                                        CUE BUS ──► ch 3/4
                   MASTER ──► merger ──► ch 1/2 ──► output  (split-cue mode)
                       ▲
     sampler (8 pads) ─┘   auto-gain sets TRIM on load (−14 LUFS target)
```

## 2. Memory architecture — who owns RAM, and the tiers down

```
   decoded PCM cost = sampleRate × channels × 4 bytes × seconds ≈ 21 MB / min (stereo)

   allocations                     AudioMemory  (budget: 1.25 GB)
  ┌────────────────┐              ┌─────────────────────────────────────────┐
  │ deck A buffers │─ protected ─►│ registry: id → { label, bytes,          │
  │ deck B buffers │─ protected ─►│             lastUsed, release? }        │
  │ SC stream      │─ evictable ─►│ enforce(protected): evict LRU entries   │
  │ cache (session)│   release()─►│ with release hooks until under budget   │
  └────────────────┘   drops buf  └───────────────────────┬─────────────────┘
       key-lock engine keeps 1 private copy/channel ──────┤
                                                          ▼
                                     header meter:  AUDIO 412M / 1.3G

   waveform: peak mip-pyramid (L0=512-sample buckets, each level 4× coarser)
   ──► redraw cost O(pixels) at any zoom, never O(track)

 RAM floor per 5-min stereo track          plain          with 4 stems
 ─────────────────────────────────────────────────────────────────────
 T0  today      Float32 all-in-RAM        106 MB          530 MB
 T1  int16 store + mono stems + drop        53 MB          ~106 MB
     main mix while stems play
 T2  windowed file paging              ~30 MB fixed ring — any file length
     (10s pages, playhead−20s…+40s, dropBuffers() behind the playhead;
      WAV via byte-range decode, FLAC/MP3 via WASM decoders in Workers)
```

## 3. Control plane

```
 keyboard ─┐
 UI click ─┼─► action ids ("deckA.hotcue3") ─┬─► deck / mixer / fx methods
 MIDI note─┘   one namespace, three triggers  │
 (K.O. II pads = notes 36–83, preset;        └─► sync controller: tempo lock
  wizard walks the id list)                       + phase PLL (±3% clamp)
```
