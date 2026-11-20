/**
 * Per-deck FX: DJ filter (LP/HP combo), beat-synced delay with feedback,
 * reverb, and a momentary "echo out".
 *
 * Signal: input → LP → HP → output, with delay and reverb fed from HP in
 * parallel (wet gains gate them). Delay time derives from the deck's effective
 * BPM × beat fraction, updated live so it stays locked while the pitch fader
 * moves.
 */

const MAX_DELAY = 3.9

function makeIR(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate
  const len = Math.max(1, Math.floor(rate * seconds))
  const ir = ctx.createBuffer(2, len, rate)
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c)
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
    }
  }
  return ir
}

const DELAY_FRACS = [0.25, 0.5, 0.75, 1]

export function delayFracLabel(f: number): string {
  if (f === 0.25) return '1/4'
  if (f === 0.5) return '1/2'
  if (f === 0.75) return '3/4'
  return '1/1'
}

export class FXUnit {
  readonly input: GainNode
  readonly output: GainNode
  private lp: BiquadFilterNode
  private hp: BiquadFilterNode
  private delay: DelayNode
  private fb: GainNode
  private delayWet: GainNode
  private reverb: ConvolverNode
  private reverbWet: GainNode

  delayOn = false
  reverbOn = false
  delayFrac = 0.5
  wetLevel = 0.55
  fbLevel = 0.5
  echoActive = false

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.lp = ctx.createBiquadFilter()
    this.lp.type = 'lowpass'
    this.lp.frequency.value = 22050
    this.lp.Q.value = 0.9
    this.hp = ctx.createBiquadFilter()
    this.hp.type = 'highpass'
    this.hp.frequency.value = 10
    this.hp.Q.value = 0.9
    this.delay = ctx.createDelay(MAX_DELAY)
    this.delay.delayTime.value = 0.35
    this.fb = ctx.createGain()
    this.fb.gain.value = 0
    this.delayWet = ctx.createGain()
    this.delayWet.gain.value = 0
    this.reverb = ctx.createConvolver()
    this.reverb.buffer = makeIR(ctx, 2.8, 2.6)
    this.reverbWet = ctx.createGain()
    this.reverbWet.gain.value = 0

    this.input.connect(this.lp)
    this.lp.connect(this.hp)
    this.hp.connect(this.output)

    // delay loop: hp → delay → fb → delay, tapped by delayWet
    this.hp.connect(this.delay)
    this.delay.connect(this.fb)
    this.fb.connect(this.delay)
    this.delay.connect(this.delayWet)
    this.delayWet.connect(this.output)

    // reverb
    this.hp.connect(this.reverb)
    this.reverb.connect(this.reverbWet)
    this.reverbWet.connect(this.output)
  }

  /** -1..1: negative sweeps lowpass, positive sweeps highpass, 0 = bypass */
  setFilter(v: number): void {
    const x = Math.min(1, Math.max(-1, v))
    const t = this.ctx.currentTime
    if (x < 0) {
      const f = 22050 * Math.pow(150 / 22050, -x)
      this.lp.frequency.setTargetAtTime(f, t, 0.02)
      this.hp.frequency.setTargetAtTime(10, t, 0.02)
    } else {
      const f = 10 * Math.pow(8000 / 10, x)
      this.hp.frequency.setTargetAtTime(f, t, 0.02)
      this.lp.frequency.setTargetAtTime(22050, t, 0.02)
    }
  }

  setDelay(on: boolean): void {
    this.delayOn = on
    const t = this.ctx.currentTime
    this.delayWet.gain.setTargetAtTime(on ? this.wetLevel : 0, t, 0.08)
    this.fb.gain.setTargetAtTime(on ? this.fbLevel : 0, t, 0.08)
  }

  cycleDelayFrac(): number {
    const i = DELAY_FRACS.indexOf(this.delayFrac)
    this.delayFrac = DELAY_FRACS[(i + 1) % DELAY_FRACS.length]
    return this.delayFrac
  }

  setWet(v: number): void {
    this.wetLevel = Math.min(1, Math.max(0, v))
    if (this.delayOn && !this.echoActive) {
      this.delayWet.gain.setTargetAtTime(this.wetLevel, this.ctx.currentTime, 0.05)
    }
  }

  setFb(v: number): void {
    this.fbLevel = Math.min(0.9, Math.max(0, v))
    if (this.delayOn && !this.echoActive) {
      this.fb.gain.setTargetAtTime(this.fbLevel, this.ctx.currentTime, 0.05)
    }
  }

  setReverb(on: boolean): void {
    this.reverbOn = on
    this.reverbWet.gain.setTargetAtTime(on ? 0.35 : 0, this.ctx.currentTime, 0.1)
  }

  /** keep delay locked to the deck's effective tempo */
  setBpm(bpm: number): void {
    if (!bpm || bpm <= 0) return
    const dt = Math.min(MAX_DELAY, Math.max(0.02, (60 / bpm) * this.delayFrac))
    this.delay.delayTime.setTargetAtTime(dt, this.ctx.currentTime, 0.05)
  }

  /** momentary transition FX: big wet + hot feedback while held */
  echoOutEngage(): void {
    this.echoActive = true
    const t = this.ctx.currentTime
    this.delayWet.gain.setTargetAtTime(0.95, t, 0.02)
    this.fb.gain.setTargetAtTime(0.85, t, 0.02)
  }

  /** release: let the tail ring out, then restore previous delay state */
  echoOutRelease(): void {
    this.echoActive = false
    const t = this.ctx.currentTime
    // slow ramps so repeats decay naturally instead of cutting off
    this.fb.gain.setTargetAtTime(this.delayOn ? this.fbLevel : 0, t, 0.6)
    this.delayWet.gain.setTargetAtTime(this.delayOn ? this.wetLevel : 0, t, 0.9)
  }
}
