import { Deck } from './deck'

/** Equal-power crossfader between the two deck channels. */
export class Mixer {
  readonly inputA: GainNode
  readonly inputB: GainNode
  position = 0.5
  private ctx: AudioContext

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.ctx = ctx
    this.inputA = ctx.createGain()
    this.inputB = ctx.createGain()
    this.inputA.connect(dest)
    this.inputB.connect(dest)
    this.setCrossfade(0.5)
  }

  setCrossfade(x: number): void {
    const p = Math.min(Math.max(x, 0), 1)
    this.position = p
    const t = this.ctx.currentTime
    this.inputA.gain.setTargetAtTime(Math.cos((p * Math.PI) / 2), t, 0.01)
    this.inputB.gain.setTargetAtTime(Math.sin((p * Math.PI) / 2), t, 0.01)
  }

  nudge(dir: number): void {
    this.setCrossfade(this.position + dir * 0.06)
  }
}

/**
 * Two decks, a mixer, and a headphone-cue path.
 *
 * Split cue: when enabled, output is routed through a 4-channel merger —
 * master on channels 1/2, headphone cue bus on channels 3/4. Pair it with a
 * macOS Aggregate Device (speakers + headphones) set as the system output so
 * the context actually exposes four channels.
 */
export class DJEngine {
  readonly ctx: AudioContext
  readonly master: GainNode
  readonly mixer: Mixer
  readonly deckA: Deck
  readonly deckB: Deck
  readonly cueBus: GainNode
  private cueA: GainNode
  private cueB: GainNode
  private merger: ChannelMergerNode | null = null
  splitCue = false

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.85
    this.master.connect(this.ctx.destination)
    this.mixer = new Mixer(this.ctx, this.master)
    this.deckA = new Deck('A', this.ctx, this.mixer.inputA)
    this.deckB = new Deck('B', this.ctx, this.mixer.inputB)

    // headphone cue taps each deck post-FX, pre-crossfader
    this.cueBus = this.ctx.createGain()
    this.cueA = this.ctx.createGain()
    this.cueA.gain.value = 0
    this.cueB = this.ctx.createGain()
    this.cueB.gain.value = 0
    this.deckA.output.connect(this.cueA)
    this.deckB.output.connect(this.cueB)
    this.cueA.connect(this.cueBus)
    this.cueB.connect(this.cueBus)
  }

  setCueMix(id: 'A' | 'B', on: boolean): void {
    ;(id === 'A' ? this.cueA : this.cueB).gain.value = on ? 1 : 0
  }

  isCueMix(id: 'A' | 'B'): boolean {
    return (id === 'A' ? this.cueA : this.cueB).gain.value > 0.5
  }

  setSplitCue(on: boolean): boolean {
    if (on === this.splitCue) return this.splitCue
    if (on) {
      try {
        this.master.disconnect(this.ctx.destination)
      } catch {
        /* not connected */
      }
      const m = this.ctx.createChannelMerger(4)
      this.master.connect(m, 0, 0)
      this.master.connect(m, 0, 1)
      this.cueBus.connect(m, 0, 2)
      this.cueBus.connect(m, 0, 3)
      m.connect(this.ctx.destination)
      this.merger = m
      this.splitCue = true
    } else {
      if (this.merger) {
        try {
          this.merger.disconnect()
        } catch {
          /* noop */
        }
        this.merger = null
      }
      try {
        this.master.disconnect(this.ctx.destination)
      } catch {
        /* not connected */
      }
      this.master.connect(this.ctx.destination)
      this.splitCue = false
    }
    return this.splitCue
  }

  resume(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }
}
