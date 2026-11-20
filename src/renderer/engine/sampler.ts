/**
 * 8-slot one-shot sampler (kicks, claps, tones, anything short).
 * Hits choke the previous hit on the same slot, pad velocity scales the hit,
 * and the whole bus runs straight to master — independent of the crossfader,
 * like an SP-6 style sampler.
 */

interface Slot {
  name: string
  path: string
  buffer: AudioBuffer | null
  gain: GainNode
  active: AudioBufferSourceNode | null
}

export class Sampler {
  readonly output: GainNode
  private slots: Slot[] = []

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.output = ctx.createGain()
    this.output.gain.value = 0.9
    this.output.connect(dest)
    for (let i = 0; i < 8; i++) {
      const gain = ctx.createGain()
      gain.connect(this.output)
      this.slots.push({ name: '', path: '', buffer: null, gain, active: null })
    }
  }

  get count(): number {
    return this.slots.length
  }

  isLoaded(i: number): boolean {
    return !!this.slots[i]?.buffer
  }

  info(i: number): { name: string; path: string } | null {
    const s = this.slots[i]
    return s && s.buffer ? { name: s.name, path: s.path } : null
  }

  load(i: number, name: string, path: string, buffer: AudioBuffer): void {
    const s = this.slots[i]
    if (!s) return
    s.name = name
    s.path = path
    s.buffer = buffer
  }

  clear(i: number): void {
    const s = this.slots[i]
    if (!s) return
    try {
      s.active?.stop()
    } catch {
      /* already stopped */
    }
    s.active = null
    s.buffer = null
    s.name = ''
    s.path = ''
  }

  /** velocity 0..1 (from pad velocity, or 1 for keyboard/UI) */
  trigger(i: number, velocity = 1): void {
    const s = this.slots[i]
    if (!s || !s.buffer) return
    try {
      s.active?.stop()
    } catch {
      /* already stopped */
    }
    try {
      s.active?.disconnect()
    } catch {
      /* noop */
    }
    const src = this.ctx.createBufferSource()
    src.buffer = s.buffer
    src.connect(s.gain)
    s.gain.gain.value = Math.max(0.05, Math.min(1, velocity))
    src.start()
    s.active = src
    src.onended = () => {
      if (s.active === src) s.active = null
    }
  }

  setMaster(v: number): void {
    this.output.gain.value = Math.min(1, Math.max(0, v))
  }
}
