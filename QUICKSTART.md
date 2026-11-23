# bendwave — run it tonight

Zero-to-mixing guide. Feature reference lives in [README.md](README.md); deep docs in
[docs/](docs/). This page is just: get it running, plug in the K.O. II, play.

---

## 1. Run the app

### From the DMG (recommended)

1. Copy **bendwave.app** to `/Applications`
2. First launch: **right-click → Open** (it's unsigned — macOS remembers after that)
3. Done. Skip to §2.

### From source (development)

```bash
git clone git@github.com:vidyut-19/bendwave.git
cd bendwave
npm install
npm run dev
```

Requires Node 18+. Builds a fresh DMG anytime with `npm run dist`
(→ `release/bendwave-<version>-arm64.dmg`).

## 2. First-launch setup (in the app, one time)

The header shows two buttons until analysis is installed:

- **install analysis env** — librosa (better BPM + musical key). Small, quick.
- **+ stems** — adds demucs + torch (~2 GB, one time). pip output streams into the
  LOG panel. Stem faders appear on decks once a track has been analyzed.

Optional — SoundCloud streaming: see [docs/streaming.md](docs/streaming.md) for the
one-time app registration + `soundcloud.config.json`.

Nothing installed yet? The app still works — built-in browser BPM covers
beatmatching and sync.

## 3. Wire the rig (your hardware: laptop, K.O. II, speaker, wired headphones)

```
laptop ──USB-C──► K.O. II ──line out──aux cable──► speaker    = MASTER
  └──headphone jack──► wired headphones                          = CUE (pre-listen)
```

One-time setup:

1. **K.O. II**: SHIFT+ERASE → `511` → ENTER — live-monitors USB audio
2. **macOS**: Audio MIDI Setup → `+` → *Create Aggregate Device* → tick **EP-133
   first**, then *Built-in Output* → right-click it → *Use This Device For Sound Output*
3. **bendwave**: mixer panel → **SPLIT CUE** on (`X`)

Check: track on deck A plays through the speaker; deck B's **CUE** button (`/`) puts
B in your headphones only. Full details: [docs/hardware.md](docs/hardware.md).

> No Bluetooth anywhere — the latency kills cueing. Aux only.

## 4. Set up the K.O. II as the controller

1. **Connect** USB-C (same cable as audio — MIDI rides along, class-compliant)
2. **Silence its pads** so DJing doesn't trigger the onboard sampler: load an empty
   project, or set each pad's sound to `000` (SHIFT+SOUND → select pad → value 000)
3. **Load the preset**: MIDI panel → **load K.O. II preset**. Pads are documented
   MIDI notes, so this works instantly:

| Group | Pads do |
|---|---|
| **A** | deck A: play / cue / set-cue / sync / hot cues 1–4 / echo-out / delay / delay-size / reverb |
| **B** | deck A: set hot cues 1–4 / headphone cue / key lock / loop rolls 1-2-4-8 / loop exit / latch |
| **C** | deck B: same as A, one octave up |
| **D** | deck B: same as B, one octave up |

4. **Knobs / the big fader**: what they transmit isn't documented by teenage
   engineering — use MIDI panel → **watch midi**, move them, read the log, then
   **learn** them to whatever you want (tempo, EQ, filter, crossfader…).
5. **Auto-map wizard**: walks 30+ actions in order if you'd rather re-map from
   scratch. Sampler pads are velocity-sensitive.

Full map + the punch-in-FX-as-outboard trick: [docs/ko2-mapping.md](docs/ko2-mapping.md).

## 5. First mix in 60 seconds

1. **Drag two audio files** anywhere into the window (WAV/MP3/FLAC/AIFF)
2. `Q` — deck A plays. Load deck B (auto-loads on second drop), `U` — **sync** locks
   tempo + phase to A
3. Pre-listen: CUE on B (`/`), find your spot (waveform drag, `[` / `]` beat-jump)
4. Bring B in: ride the **crossfader** (`,`. `.` nudge, `Space` centers — or a MIDI
   fader via `mix.crossfade`)
5. Take A out with flavor: sweep A's **FLT** toward high-pass, hold `G`
   (**echo-out**), tap `4` (**1-beat roll**), release, fade A's VOL down
6. `V` — **record** the whole thing to `~/Music/bendwave/`

Hot cues: `A S D F` (deck A) / `J K L ;` (deck B); Shift+key sets them. Loops:
`4–7` (A) / `B N M '` (B). Sampler: drop samples on the mixer pads, fire with
Shift+1–8 or velocity pads. Full key map: [README.md](README.md#keyboard-map).

## 6. If something's off

| Symptom | Fix |
|---|---|
| No sound | Aggregate device selected as system output? EP-133 ticked **first**? |
| Cue hears everything / nothing | SPLIT CUE on? Deck CUE button lit? |
| "bendwave is damaged" | Unsigned app: right-click → Open |
| No stems faders | Header → **+ stems** finished? Track needs re-load after install |
| K.O. II pads do nothing | MIDI panel shows the device? Preset loaded? Pad channel set to 1? |
| Knobs won't map | They may not transmit — confirm with **watch midi** |
| `npm install` electron errors | The postinstall self-heals; if not, see `scripts/ensure-electron.mjs` |
