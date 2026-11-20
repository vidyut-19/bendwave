# K.O. II as a vibedeck controller

The EP-133 K.O. II is a class-compliant USB MIDI device. Its pads send MIDI notes on
fixed, documented numbers (from teenage engineering's own guide), so vibedeck ships a
preset that works out of the box — plus a wizard for the faders/knobs.

## Make the pads silent

Pads trigger the K.O. II's own sounds when pressed. To use it as a pure DJ controller,
open an empty project, or set each pad's sound to `000` in sound edit (shift+sound →
select pad → sound value 000) — TE's documented trick for silent MIDI pads.

## Pad preset (MIDI panel → "load K.O. II preset")

Pads send on channel 1 by default (per-pad channel is configurable in sound edit;
vibedeck's preset binds channel 1).

### Group A — deck A (notes 36–47)

| Pad | Note | Action |
|---|---|---|
| A0 | 36 | deck A play/pause |
| A-enter | 37 | deck A cue (hold) |
| A1 | 38 | deck A set cue |
| A2 | 39 | deck A sync |
| A3–A6 | 40–43 | deck A hot cues 1–4 |
| A7 | 44 | deck A echo out (hold) |
| A8 | 45 | deck A delay on/off |
| A9 | 46 | deck A delay fraction (1/4→1/2→3/4→1/1) |
| A10 | 47 | deck A reverb on/off |

### Group B — deck A setters + loops (notes 48–59)

| Pad | Note | Action |
|---|---|---|
| B0–B3 | 48–51 | set deck A hot cues 1–4 |
| B4 | 52 | deck A headphone cue |
| B5 | 53 | deck A key lock |
| B6–B9 | 54–57 | deck A loop rolls 1/2/4/8 (hold) |
| B10 | 58 | deck A loop exit |
| B11 | 59 | deck A loop latch mode |

### Group C — deck B (notes 60–71)

Same layout as group A, one octave up, mapped to deck B (play 60, cue 61, set cue 62,
sync 63, hot cues 64–67, echo 68, delay 69, fraction 70, reverb 71).

### Group D — deck B setters + loops (notes 72–83)

Set hot cues 1–4 (72–75), headphone cue (76), key lock (77), loop rolls 1/2/4/8 (78–81),
loop exit (82), loop latch (83).

## Fader and X/Y knobs

Hardware reality: the K.O. II has **one context-assignable FADER** (hold FADER + press a
pad to reassign it — the 12 parameters are printed above the pads: Tune, Velocity, Mod,
Attack, Release, Pan, LPF, HPF, FX Send, Level, Pitch, Time) and **two knobs (X/Y)**,
which are context-sensitive for the K.O. II's own modes.

What they transmit over USB MIDI is not fully documented — pads definitely send notes
(36–83); CC transmission from the fader/knobs depends on assignment and firmware. Find out
in seconds with **watch mode**: MIDI panel → `watch midi` → move every control; the log
prints each message (`CC ch1 ctrl 1 = 64`). Anything that shows up can be bound with
*learn*.

Good bets to try (then bind what transmits):

- FADER assigned to **Mod** (classic CC #1) → bind to `mix.crossfade` or a deck volume
- FADER assigned to **Level** → group volume, may transmit
- X / Y knobs → `deckA.filter` / `deckB.filter`, or `deckA.tempo` / `deckB.tempo`
  (tempo = full ±8% pitch fader), or EQ bands (`deckX.eqLow/eqMid/eqHigh`)

Everything continuous in vibedeck is learnable: tempo, EQ (3 bands), filter, trim,
volume, delay wet/feedback, crossfader, sampler volume. Momentary pads cover transport,
hot cues, loops, FX toggles, echo-out, cue-mix.

## The K.O. II's own FX panel, two ways

**1. Map vibedeck's FX to its controls** (software): pads already trigger delay/reverb/
echo-out per the preset above; knobs/fader can ride wet, feedback and filter via learn.

**2. Use the K.O. II as an outboard FX unit for vibedeck** (hardware): the K.O. II is
also a USB audio device with live-input processing — its guide lists *live input FX* and
system setting 511 (`smp > usb > mon`: sampler + live monitoring). Routing recipe:

```
vibedeck deck → macOS multi-output device → K.O. II USB input
K.O. II live input FX (punch-in pads + X/Y) → K.O. II line out → speakers
```

Set the K.O. II to live monitoring (system code 511), send one vibedeck channel (e.g. via
an aggregate device channel) into it, smash its pressure-sensitive punch-in FX, and cable
its line out back to your rig. USB round-trip adds some latency — fine for a send/FX
channel, not for the main mix path.

## Sequencer

The K.O. II's sequencer can drive external MIDI (pads send notes from patterns). Vibedeck
does not yet send **MIDI clock**, so its patterns can't lock to deck BPM automatically —
that's on the roadmap (`clock out at deck tempo`); until then, match tempos by hand or
let the K.O. II be clock master (system 102) and set vibedeck's decks to match.

## Notes

- Velocity: pad velocity affects nothing in vibedeck; any press = full trigger.
- Keys mode remaps notes chromatically (0–127) — leave the K.O. II in pad mode.
- The preset replaces all existing bindings; learn-mode additions afterwards stick.
