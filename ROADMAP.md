# vibedeck — Master Feature Roadmap & Architecture Plan

The thesis: **Co-Pilot, not Autopilot.** Compute the 80% of DJ preparation and cognitive
load that *can* be computed cleanly (acoustic fingerprinting, song structure, harmonic/
tempo/vibe path planning, transition recipes, and automated envelope previews) — while
keeping expressive performance, taste, and live override on your hands and K.O. II.

---

## How the pillars connect (one unified pipeline)

```
  Audio File / Crate
         │
         ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ 1. DEEP ACOUSTIC FINGERPRINT (fast pure DSP + ID3/Serato + Stems)  │
  │    • Exact BeatGrid (Serato tag / librosa / manual SET 1)           │
  │    • Key + Camelot + Key Confidence (tonal vs percussive)           │
  │    • Arrangement (INTRO / GROOVE / BREAK / BUILD / DROP / OUTRO)    │
  │    • Groove (4-on-the-floor score, Swing ratio)                     │
  │    • Timbre (MFCCs, centroid, crest/dynamics, stereo width)         │
  │    • Per-section Intro/Outro percussiveness (natural ∅ drum zones)  │
  │    • Vocal Activity Map & Stem Balance (once Demucs finishes)       │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
  ┌─────────────────────────────────┐   ┌─────────────────────────────────┐
  │ 2. SET PATH PLANNER             │   │ 3. INTELLIGENT TRANSITION       │
  │    (Graph-Theoretic Engine)     │   │    ENGINE                       │
  │    • Directed Key–Tempo–Timbre  │   │    • Mix-in / Mix-out cues      │
  │      graph on actual crate      │   │    • 4B / 8B / 16B loop sizing  │
  │    • Beam Search + 2-opt        │   │    • Filter move (HPF vs LPF)   │
  │      (strictly no repeats!)     │   │    • Kick / Bass ownership      │
  │    • Target Energy Arcs         │   │    • Stem isolation moves       │
  │      (Warmup→Peak→Cool, Climb)  │   │      (Drums-only ∅ reset,       │
  │    • Crate Clustering &         │   │       Acapella / Inst swap)     │
  │      Bridge-Track Discovery     │   │    • Vocal-clash prevention     │
  └──────────────────┬──────────────┘   └──────────────────┬──────────────┘
                     │                                     │
                     └──────────────────┬──────────────────┘
                                        ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ 4. AUTOMATED TRANSITION CURVES + LIVE DECKS (Spotify Mix + Stems)   │
  │    • Stacked dual-waveform Transition Editor (10ms nudge, loopable) │
  │    • Visual Volume / EQ / Filter / Stem envelopes over waveforms    │
  │    • Live execution ("RUN 8B TRANSITION") + instant manual override │
  │    • Auto tempo-ramp across overlap, return to native BPM after     │
  │    • Saveable transition recipes per track-pair in crate            │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Pillar 1 — Deep Acoustic Fingerprint (`v1.3`)

Everything downstream gets smarter as the per-track fingerprint gets richer. All Tier-A
features run in `<60ms` pure DSP on load (or piggyback on Demucs stems):

- [ ] **Groove profile**:
  - **4-on-the-floor score** (low-band autocorrelation at 1-beat vs 2-beat lag — separates straight house/techno kicks from hip-hop/afro/breakbeats)
  - **Swing ratio** (offbeat 16th-note onset offset: `0.50` straight vs `0.58+` Kaytranada/hip-hop swing — warns before clashing swung into straight!)
- [ ] **Timbre & Texture vector**:
  - **13-dim MFCC mean** (compact "sounds like the same room" timbre distance)
  - **Spectral centroid & roll-off** (warm/dark vs bright/airy)
  - **Crest factor / Dynamic range** (brickwall club master vs dynamic live recording)
  - **Stereo width** (Mid/Side RMS ratio — mono punch vs wide ambient)
- [ ] **Key confidence score**: correlation margin between #1 and #2 keys (knows when harmonic matching is strict vs optional)
- [ ] **Percussive-vs-Harmonic ratio per section**: auto-flags pure drum intros/outros as **natural $\varnothing$ null-node resets** (safe to mix across clashing keys)
- [ ] **Vocal density % & per-bar vocal envelope** (from Demucs `vocals` stem — prevents vocal-on-vocal clashes down to the bar)
- [ ] **Optional Tier-B ML tagger (later)**: Essentia Discogs-EffNet ONNX sidecar (~30 MB) for genuine instrument & sub-genre tags (sax, Rhodes, 303 acid, afro-house, French touch)

---

## Pillar 2 — Graph-Theoretic Set Path Planner (`v1.4`)

Turns your crate into a navigable musical map — grounded in `The_Perfect_DJ_Set.pdf`,
adapted for real DJ constraints (no repeated songs, coupled key+BPM moves, acoustic
energy instead of key brightness):

- [ ] **Actual Crate Graph Engine**:
  - Log-tempo distance $\Delta\tau = \log_2(\text{BPM}_2/\text{BPM}_1)$ with half/double-time wrap
  - Directed Camelot wheel weights (`+1 LIFT` / `+2 BOOST` ≠ `-1 COOL`), modulated by **key confidence** and **intro/outro percussiveness**
  - MFCC timbre distance + groove (swing / 4-on-the-floor) compatibility + dynamic-range continuity
  - **Built-in $\varnothing$ Stem Reset edges**: any stemmed track can jump anywhere on the Camelot wheel via a 4-bar Drums-only stem loop at a configurable penalty
- [ ] **No-Repeat Set Solver (Beam Search + 2-opt, `<15ms`)**:
  - Pick an opener (and optional closer or must-include peak track)
  - Choose or draw a **Target Energy Arc**: *Warmup → Peak → Cooldown*, *Steady Climb*, *Two-Peak Festival*, *Chill Groove*
  - Outputs an ordered setlist with exact transition quality scores, energy/BPM sparkline, and Camelot path
- [ ] **Crate Clustering & Bridge Discovery**:
  - Spectral/agglomerative clustering on the crate graph surfaces natural **mini-sets** (e.g., *118–124 Soulful House*, *126–132 Peak Afro/Tech*, *72–104 Hip-Hop*)
  - Highlights **Bridge Tracks** (tracks that connect two clusters cleanly)
- [ ] **Pin / Lock / Re-solve live**: lock tracks you already played or want next, click "Re-plan rest of set" mid-gig!
- [ ] **Set History & DJ Diagnostics (later)**: log played transitions to build personal style stats (BPM envelope, Camelot distribution, favorite transition types)

---

## Pillar 3 — Intelligent Transition Engine (`v1.4–v1.5`)

Connects the acoustic fingerprint + arrangement + stems to **decide** the exact transition
technique (not generic advice):

- [ ] **Rule + Score Decision Engine**:
  - **Bass Swap (Center EQ / Bass Stem)**: both sections have strong sub-bass + compatible key + matched groove
  - **HPF Out + Echo Tail**: outgoing has heavier bass/energy while incoming opens on a bass-light intro/build
  - **LPF In (Filter Open)**: incoming starts bright/busy while outgoing holds the groove
  - **4-Bar / 8-Bar Loop Extension**: automatically triggers when incoming intro is shorter than target overlap (or outgoing runs out before the drop — fixing Spotify Mix's #1 complaint!)
  - **Drums-Only $\varnothing$ Stem Reset**: triggered automatically when crossing a Camelot clash or big BPM jump on stemmed tracks — isolates outgoing `DRM`, loops 4B, fades in incoming
  - **Acapella / Instrumental Stem Blend**: when both tracks have stems and compatible keys, isolate incoming `VOX` over outgoing `DRM+BAS`, or strip outgoing `VOX` immediately on vocal-clash detection
  - **Semitone Key Transpose** (via Signalsmith Stretch `semitones`): offer `±1 semitone` pitch shift when it converts a Camelot clash into an exact harmonic match!
- [ ] **Confidence & Rationale**: every suggested move shows *why* (e.g. `SWING MATCH 0.51 · +1 LIFT 9A→10A · B intro 8B bass-free → HPF out A`)

---

## Pillar 4 — Automated Transition Curves ("Spotify Mix, Supercharged") (`v1.5`)

Takes the best part of Spotify's Mix beta (visual automation curves + instant preview)
and removes every Spotify limitation (works anywhere in the song, supports loops, stems,
and live hardware override):

- [ ] **Stacked Dual-Waveform Transition View (modal or dockable strip)**:
  - Outgoing deck on top, incoming deck on bottom, beat-aligned with `±10ms` nudge arrows
  - Adjustable transition length (`2B`, `4B`, `8B`, `16B`) + optional **auto-loop** if either track needs runway
- [ ] **Visual Automation Envelopes overlaid on waveforms**:
  - **Volume curve** (Smooth Equal-Power, Linear, Overlap, Quick Cut)
  - **3-Band EQ curve** (Center Bass Swap, Quick Bass Cut, 3-Band Fade)
  - **Filter curve** (HPF out, LPF in, Cross-Filter HPF-in/LPF-out)
  - **Stem curves** (4 independent envelopes for `DRM / BAS / OTH / VOX` on both decks — e.g. drop `VOX` at bar 1, swap `BAS` at bar 5, cut `DRM` at bar 8!)
  - **Auto Tempo Ramp**: smoothly matches incoming BPM across the overlap, then gradually ramps to native BPM after the outgoing deck exits
- [ ] **Live Execution Engine (`AudioParam` scheduled automation)**:
  - **`PREVIEW`** (audition the transition in headphones / cue bus first!)
  - **`ARM / RUN TRANSITION`**: executes the exact curves on the live Web Audio graph at the next bar/section boundary
  - **Touch-to-Override**: touching any physical fader, EQ, filter, stem slider, or K.O. II pad immediately yields that parameter back to manual control (never fights your hands!)
- [ ] **Saveable Transition Recipes**: store customized `(trackA, trackB)` transition curves in the crate so rehearsed blends replay identically in a live set

---

## Pillar 5 — Core DJ Craft & Hardware Polish (Ongoing)

The unglamorous things that make the booth feel rock-solid:

- [ ] **Level Meters & Clip Indicators**: per-channel stereo VU meters + master meter + red clip LED (zero blind gain staging)
- [ ] **MIDI Clock Out (24 PPQN)**: lock the **K.O. II's onboard sequencer** to vibedeck's live deck BPM so your K.O. II patterns play tight in time with the mix
- [ ] **External Audio Input Channel**: bring the K.O. II's USB/line audio into vibedeck (`getUserMedia`) as a live mixer channel with EQ, filter, and FX
- [ ] **Jog Wheel / Platter Mode**: relative-encoder + touch-capacitive scratch/nudge handling ready for a used DDJ-FLX4 (plus FLX4 MIDI preset)
- [ ] **Beatgrid Tap Tempo + Manual BPM input**: direct numeric BPM edit + tap tempo alongside existing `SET 1` / `◀1` / `1▶` / `½×` / `2×`
- [ ] **Loop Boundary Crossfades**: 5ms equal-power micro-crossfade at loop wrap points to eliminate ticks on non-zero crossings
- [ ] **Stem-Compatible Key Lock**: run Signalsmith Stretch across stem buses (or single post-stem-mix stretch node!) so **stems + key lock work together**!
- [ ] **Memory Architecture Tier 1 & 2** (see [docs/memory.md](docs/memory.md)): Int16 sample store, FLAC stems on disk (saves 50% SSD space vs WAV), and windowed paging for 60+ min mixes
- [ ] **Codebase Hygiene**: split `src/renderer/main.ts` into focused modules (`actions.ts`, `copilot-ui.ts`, `midi-ui.ts`, `ingest.ts`) + Vitest unit suite covering beatgrid, sync phase math, Camelot wheel, structure segmentation, and path planner
- [ ] **Custom App Icon & Polish**: bespoke macOS `.icns` icon + DMG background artwork
