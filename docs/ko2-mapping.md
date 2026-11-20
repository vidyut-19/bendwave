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

### Group B — deck A setters (notes 48–59)

| Pad | Note | Action |
|---|---|---|
| B0–B3 | 48–51 | set deck A hot cues 1–4 |
| B4 | 52 | deck A headphone cue |
| B5 | 53 | deck A key lock |

### Group C — deck B (notes 60–71)

Same layout as group A, one octave up, mapped to deck B (play 60, cue 61, set cue 62,
sync 63, hot cues 64–67, echo 68, delay 69, fraction 70, reverb 71).

### Group D — deck B setters (notes 72–83)

Set hot cues 1–4 (72–75), headphone cue (76), key lock (77).

## Faders and knobs

The K.O. II's faders and X/Y knobs aren't publicly documented as sending standard MIDI
CC, so bind them with **learn** or the **auto-map wizard** (MIDI panel). Suggested
assignment, DJ-style:

- Group A fader → deck A volume
- Group B fader → deck A filter
- Group C fader → deck B volume
- Group D fader → deck B filter
- X knob → crossfader
- Y knob → master

The wizard walks 29 actions in a fixed, sensible order (transport, hot cues, FX,
filters, volumes, crossfader) — touch each control once and you're mapped.

## Notes

- Velocity: pad velocity affects nothing in vibedeck; any press = full trigger.
- Keys mode remaps notes chromatically (0–127) — leave the K.O. II in pad mode.
- The preset replaces all existing bindings; learn-mode additions afterwards stick.
