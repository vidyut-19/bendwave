/**
 * Per-deck FX: DJ filter (LP/HP combo), beat-synced delay with feedback,
 * reverb, and a momentary "echo out".
 *
 * Signal: input → LP → HP → output, with delay and reverb fed from HP in
 * parallel (wet gains gate them). Delay time derives from the deck's effective
 * BPM × beat fraction, updated live so it stays locked while the pitch fader
 * moves.
 *
 * flush() cleanly zeroes and rebuilds the delay & convolver nodes (reusing the
 * cached impulse response) so pausing or loading a new track never leaves
 * runaway feedback tails or bleeds stale echoes back on resume.
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
  if (f === 0.25) return '♬ 1/4'
  if (f === 0.5) return '♪ 1/2'
  if (f === 0.75) return '♪· 3/4'
  return '♩ 1/1'
}

export class FXUnit {
  readonly input: GainNode
  readonly output: GainNode
  private lp: BiquadFilterNode
  private hp: BiquadFilterNode
  private delay!: DelayNode
  private fb: GainNode
  private delayWet: GainNode
  private ir: AudioBuffer
  private reverb!: ConvolverNode
  private reverbWet: GainNode
  private lastBpm = 120
  private lastDelaySec = 0.25
  private flushed = false

  delayOn = false
  reverbOn = false
  delayFrac = 0.5
  wetLevel = 0.55
  fbLevel = 0.5
  echoActive = false
  filterVal = 0

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

    this.fb = ctx.createGain()
    this.fb.gain.value = 0
    this.delayWet = ctx.createGain()
    this.delayWet.gain.value = 0
    this.ir = makeIR(ctx, 2.8, 2.6)
    this.reverbWet = ctx.createGain()
    this.reverbWet.gain.value = 0

    this.input.connect(this.lp)
    this.lp.connect(this.hp)
    this.hp.connect(this.output)
    this.delayWet.connect(this.output)
    this.reverbWet.connect(this.output)

    this.mountDelayNode()
    this.mountReverbNode()
  }

  private mountDelayNode(): void {
    const d = this.ctx.createDelay(MAX_DELAY)
    d.delayTime.value = this.lastDelaySec
    this.hp.connect(d)
    d.connect(this.fb)
    this.fb.connect(d)
    d.connect(this.delayWet)
    this.delay = d
  }

  private mountReverbNode(): void {
    const rev = this.ctx.createConvolver()
    rev.buffer = this.ir
    this.hp.connect(rev)
    rev.connect(this.reverbWet)
    this.reverb = rev
  }

  private ramp(param: AudioParam, value: number, tc: number): void {
    const t = this.ctx.currentTime
    param.cancelScheduledValues(t)
    param.setTargetAtTime(value, t, tc)
  }

  /** -1..1: negative sweeps lowpass, positive sweeps highpass, 0 = bypass */
  setFilter(v: number): void {
    const x = Math.min(1, Math.max(-1, v))
    this.filterVal = x
    if (x < 0) {
      const f = 22050 * Math.pow(150 / 22050, -x)
      this.ramp(this.lp.frequency, f, 0.02)
      this.ramp(this.hp.frequency, 10, 0.02)
    } else {
      const f = 10 * Math.pow(8000 / 10, x)
      this.ramp(this.hp.frequency, f, 0.02)
      this.ramp(this.lp.frequency, 22050, 0.02)
    }
  }

  setDelay(on: boolean): void {
    this.delayOn = on
    if (this.flushed) return
    if (on) this.applyDelayTime(false)
    if (!this.echoActive) {
      this.ramp(this.delayWet.gain, on ? this.wetLevel : 0, 0.05)
      this.ramp(this.fb.gain, on ? this.fbLevel : 0, 0.05)
    }
  }

  cycleDelayFrac(): number {
    const i = DELAY_FRACS.indexOf(this.delayFrac)
    this.delayFrac = DELAY_FRACS[(i + 1) % DELAY_FRACS.length]
    this.applyDelayTime(true)
    return this.delayFrac
  }

  setWet(v: number): void {
    this.wetLevel = Math.min(1, Math.max(0, v))
    if (this.delayOn && !this.echoActive && !this.flushed) {
      this.ramp(this.delayWet.gain, this.wetLevel, 0.04)
    }
  }

  setFb(v: number): void {
    this.fbLevel = Math.min(0.9, Math.max(0, v))
    if (this.delayOn && !this.echoActive && !this.flushed) {
      this.ramp(this.fb.gain, this.fbLevel, 0.04)
    }
  }

  setReverb(on: boolean): void {
    this.reverbOn = on
    if (this.flushed) return
    this.ramp(this.reverbWet.gain, on ? 0.35 : 0, 0.08)
  }

  private applyDelayTime(smooth: boolean): void {
    if (!this.lastBpm || this.lastBpm <= 0) return
    const dt = Math.min(MAX_DELAY, Math.max(0.02, (60 / this.lastBpm) * this.delayFrac))
    this.lastDelaySec = dt
    const t = this.ctx.currentTime
    this.delay.delayTime.cancelScheduledValues(t)
    if (smooth) this.delay.delayTime.setTargetAtTime(dt, t, 0.04)
    else this.delay.delayTime.setValueAtTime(dt, t)
  }

  /** keep delay locked to the deck's effective tempo */
  setBpm(bpm: number): void {
    if (!bpm || bpm <= 0) return
    this.lastBpm = bpm
    this.applyDelayTime(true)
  }

  /** momentary transition FX: big wet + hot feedback while held */
  echoOutEngage(): void {
    this.echoActive = true
    this.flushed = false
    this.applyDelayTime(false)
    this.ramp(this.delayWet.gain, 0.95, 0.02)
    this.ramp(this.fb.gain, 0.85, 0.02)
  }

  /** release: let the tail ring out, then restore previous delay state */
  echoOutRelease(): void {
    if (!this.echoActive) return
    this.echoActive = false
    if (this.flushed) return
    // slow ramps so repeats decay naturally instead of cutting off
    this.ramp(this.fb.gain, this.delayOn ? this.fbLevel : 0, 0.55)
    this.ramp(this.delayWet.gain, this.delayOn ? this.wetLevel : 0, 0.85)
  }

  /**
   * Immediately silence and clear delay + reverb buffers (called on pause,
   * cue-stop, or track load). Preserves toggle states (delayOn / reverbOn) so
   * restore() cleanly re-arms them when playback resumes — with zero stale tail!
   */
  flush(): void {
    this.flushed = true
    this.echoActive = false
    const t = this.ctx.currentTime
    this.fb.gain.cancelScheduledValues(t)
    this.fb.gain.setValueAtTime(0, t)
    this.delayWet.gain.cancelScheduledValues(t)
    this.delayWet.gain.setValueAtTime(0, t)
    this.reverbWet.gain.cancelScheduledValues(t)
    this.reverbWet.gain.setValueAtTime(0, t)

    // Detach old DelayNode & ConvolverNode and mount fresh silent buffers
    try {
      this.hp.disconnect(this.delay)
      this.fb.disconnect(this.delay)
      this.delay.disconnect()
    } catch {
      /* noop */
    }
    try {
      this.hp.disconnect(this.reverb)
      this.reverb.disconnect()
    } catch {
      /* noop */
    }
    this.mountDelayNode()
    this.mountReverbNode()
  }

  /** Re-engage toggled FX cleanly when playback starts/resumes. */
  restore(): void {
    if (!this.flushed) return
    this.flushed = false
    this.applyDelayTime(false)
    if (this.delayOn) {
      this.ramp(this.delayWet.gain, this.wetLevel, 0.025)
      this.ramp(this.fb.gain, this.fbLevel, 0.025)
    }
    if (this.reverbOn) {
      this.ramp(this.reverbWet.gain, 0.35, 0.04)
    }
  }
}
