# Teenage Engineering × Winamp — vibedeck UI Design Profile

Extracted directly from `teenage.engineering` (`root.css` & `te013.css` — the EP–133 K.O. II
guide stylesheet) plus physical EP–133 hardware finishes, adapted for a **live, tactile DJ
instrument** with Winamp-style musical personality.

---

## 1. Teenage Engineering's Actual CSS DNA (Verified)

| Property | Actual TE Value | Why It Feels Distinct |
|---|---|---|
| **Primary ink** | `#0f0e12` (`--te-black`) | Deep cool-carbon, never flat `#000000` |
| **Canvas / Chassis** | `#f1f2f2` / `#f5f5f5` (web) · `#dedcd5` (EP–133 ABS) | Matte industrial putty / aluminum paper |
| **Dark hardware** | `#272727` (keycaps) · `#090a0d` (hybrid LCD glass) | High-contrast obsidian display cutouts |
| **Neutral ladder** | `#e5e5e5` · `#cccccc` · `#b2b2b2` · `#a1a7af` · `#767676` · `#4d4d4d` | Hairline structural grids |
| **5 Signal Accents** | **`#f05a24`** Orange · **`#0071bb`** Blue · **`#006837`** Green · **`#b81d13`** Red · **`#fab413`** Yellow | Strictly functional hardware state coding (Dieter Rams / Braun school) |
| **Border radius** | **`0px`** on containers, **`1px–2px`** on keycaps | Sharp, machined edges — never soft SaaS pills |
| **Shadows** | Zero drop shadows; **`inset 0 -2px 0 rgba(0,0,0,0.45)`** on buttons | Physical keycap travel instead of floating cards |
| **Rules** | `0.5px` (Retina) / `1px` crisp solid hairlines | Technical datasheet & silkscreen precision |
| **Case convention** | **all-lowercase** headings (`vibedeck k.o. ii`, `((1))`) + **ALL-CAPS** hardware silkscreen (`PLAY`, `FADER`, `SYNC`, `SHIFT`) | Unmistakable Stockholm manual voice |

---

## 2. Font Stack Recommendation for vibedeck's UI

Teenage Engineering's website uses proprietary custom cuts of **Univers** (`UniversTE20T`
weight `100` thin & `UniversTE40L` weight `300` light) paired with **`TechnoType`** for
hardware legends. We shouldn't rip their private `.woff2` files — here are the cleanest
legal equivalents that nail the exact optical geometry:

### Recommended UI Font Stack (bundle via `@fontsource` for offline cross-platform Electron)
1. **Primary Display & Headings (`--font-sans`)**:
   - **Best open-source match**: **`Inter` (weights 200 / 300 / 500)** or **`IBM Plex Sans` (300 / 500 / 700)** — crisp neo-grotesque proportions, clean ultra-light headlines.
   - **Best macOS zero-download native**: `"Helvetica Neue"` (weight `200`/`300` for lowercase headings — Univers's 1957 Swiss sibling!).
2. **Hardware Silkscreen Legends (`--font-silk`)**:
   - **Best open-source match**: **`Barlow` / `Barlow Condensed` (600 / 700)** — engineered directly from DIN 1451 highway/industrial typography (dead ringer for `TechnoType` & EP–133 legends).
   - **macOS native**: `"DIN Alternate"` (already installed on macOS!).
3. **Hybrid LCD Digits, BPM, Bars, MIDI & Timestamps (`--font-mono`)**:
   - **Best open-source match**: **`Geist Mono`** (`GeistMono Nerd Font Mono`, weights `400 / 700`, `font-variant-numeric: tabular-nums`) — ultra-crisp Swiss neo-grotesque monospace with razor-sharp zero/one legibility and rock-solid tabular alignment so `127.0 BPM` and `BAR 17.1` never jitter while playing!
   - *(Optional Winamp/LCD flourish)*: **`DSEG7` / `Share Tech Mono` / `Silkscreen`** strictly for the large BPM / BAR segment digits inside the obsidian LCD window!

---

## 3. Marrying Teenage Engineering Precision + Winamp Soul (Making Deck A Feel Alive)

Pure TE web style is minimalist to the point of austere (`100` weight text on white).
Pure Winamp is expressive, reactive, and **visibly alive with the music**. Putting the two
together gives vibedeck a genuinely iconic personality:

1. **Physical Chassis + Obsidian "Super-Segment LCD" Windows**:
   - Frame each deck like a real piece of molded hardware (either **EP–133 Light Putty `#dedcd5`** for daytime/desk matching OR **Dark Carbon `#191a1f`** for dark booths — toggleable with 1 theme switch!).
   - Recess the **Timing/Key HUD** and **Dual Waveforms** inside sharp `0px`-radius **obsidian `#090a0d` glass windows** with thin machined inner bezels (`1px solid #000`). Everything inside the glass glows like the EP–133's hybrid LCD: crisp white (`#f4f4f0`) BPM, **TE Signal Orange (`#f05a24`)** on Deck A, **TE Signal Blue (`#0071bb`)** on Deck B, **Signal Yellow (`#fab413`)** for Bar 1 / Cue.
2. **Winamp Personality & Live Musical Reactivity**:
   - **Live Beat-Reactive Segment VU + Mini Spectrum Strip** right inside the LCD HUD (20 discrete glowing LCD blocks dancing to real-time `AnalyserNode` FFT/RMS — orange → yellow → red clip LEDs, pure Winamp joy inside a TE super-segment display!).
   - **Animated "Super-Segment" Deck Icons** (like the K.O. II's 66 LCD icons!): a pulsing sync chevron when phase-locked, a tiny spinning tape-reel / vinyl glyph when Deck A runs, a glowing padlock when Key Lock engages, flashing red `● REC` segment when recording!
   - **Tactile Chunky Keycaps**: Deck controls look and feel like physical EP–133 buttons — sharp `0px`–`1px` corners, top colored silkscreen accent bars, `inset 0 -3px 0 rgba(0,0,0,0.45)` bottom lip that physically depresses `translateY(1.5px)` when clicked OR when pressed on your K.O. II hardware! (Imagine pressing pad `.` on the physical K.O. II and watching the matching on-screen orange keycap physically press down in real time!)
   - **Custom Machined Fader Caps**: Replace default browser `<input type="range">` sliders with flat slotted hardware fader tracks + rectangular dark fader caps with an orange/blue center notch line (identical to the EP–133's physical fader!).

Ready-to-use CSS variables live in [te-theme-tokens.css](te-theme-tokens.css).
