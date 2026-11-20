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

export class DJEngine {
  readonly ctx: AudioContext
  readonly master: GainNode
  readonly mixer: Mixer
  readonly deckA: Deck
  readonly deckB: Deck

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.85
    this.master.connect(this.ctx.destination)
    this.mixer = new Mixer(this.ctx, this.master)
    this.deckA = new Deck('A', this.ctx, this.mixer.inputA)
    this.deckB = new Deck('B', this.ctx, this.mixer.inputB)
  }

  resume(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }
}
