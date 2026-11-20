# Hardware guide — what you actually need

## Tier 0: everything you already own ($0)

```
                    USB-C (data + power)
  laptop ──────────────────────────────── K.O. II
    │                                        │ line out (3.5mm)
    │ headphone jack                         │
    ▼                                        ▼
  wired earbuds/headphones                 your speaker
  = CUE (what you pre-listen to)          = MASTER (the room hears this)
```

The K.O. II is a class-compliant USB audio device — macOS can send audio *to* it and it
plays out its line-out jack. One-time setup:

1. On the K.O. II: system code **511** (`smp > usb > mon`) so USB audio is live-monitored:
   SHIFT+ERASE (system) → 511 → ENTER.
2. macOS: Audio MIDI Setup → **Create Aggregate Device** → tick *EP-133* first, then
   *Built-in Output*. Set the aggregate as the default output device.
   Device order matters: ch 1/2 = K.O. II (master), ch 3/4 = headphone jack (cue).
3. vibedeck: **SPLIT CUE** on (mixer), then the per-deck **CUE** button to pre-listen.

Notes:
- Wired headphones/earbuds into the laptop are required — you listed none, so any
  wired pair you own works to start.
- Sony WH-1000XM4 tip: they work **passively over the cable even powered off** — for DJing,
  power them off (or disable BT) so they can't wander back to a phone, and consider ANC off
  while learning so you hear the room alongside the cue.
- **Don't use Bluetooth** for anything in the chain — 150ms+ latency makes cueing
  impossible. Aux only.
- Caveats of this tier: aggregate devices can drift/click occasionally; the K.O. II
  DAC is fine but not an audio-interface DAC; and a single aux speaker is mono-ish.
  All totally fine for practice.
- Bonus: the K.O. II's own sounds come out the same line out — its pads/sequencer are
  already "in the mix" on your speaker.

## Tier 1: a real USB audio interface (~$30–70)

Any cheap interface with a stereo out (e.g. Behringer UCA222-class, RCA or 3.5mm out)
replaces the K.O. II as the DAC: aggregate = interface (master) + laptop jack (cue).
Cleaner clock, keeps the K.O. II free to be pure instrument, ~3.5mm-to-RCA cable maybe.

## Tier 2: the jog-wheel controller you said is coming (~$200 used)

A used DDJ-FLX4-class controller is the everything-at-once upgrade: hardware audio
interface with proper master/cue outputs, jog wheels, pitch faders, EQ knobs, pads,
channel faders, crossfader. All of it is mappable with vibedeck's MIDI learn (watch mode
reveals anything undocumented); ask and a FLX4 preset gets baked in like the K.O. II one.

## Nice-to-haves (later, in order of impact)

1. Decent closed-back headphones (audio-technical M40x-class) — beatmatching lives here
2. A second speaker / pair of powered monitors — stereo + actual low end
3. USB-C hub if the laptop runs out of ports
4. Stems cache SSD if your crate grows big (stems are ~4× track size on disk)
