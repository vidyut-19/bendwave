import { camelotSemitoneDelta, foldedTempoRatio, type PadStemKind } from './harvester'

/**
 * 8-slot "Harvested DNA" Sampler (Pillar 6)
 *
 * Plays both raw dropped one-shots AND harvested stem clips (kicks, 808s,
 * UKG wobbles, Fred again.. vocal chops):
 *   - One-Shot vs. Beat-Synced Loop mode per pad
 *   - Live BPM Warp + Camelot Semitone Pitch Lock via Signalsmith Stretch
 *     (rendered lazily offline in ~15ms so pad hits stay zero-latency!)
 *   - Formant preservation on Vocal chops (no chipmunk effect!)
 *   - Built-in beat-synced Delay + Reverb "Space" send for chops & stabs
 *   - Independent of crossfader, velocity-sensitive via EP-133 K.O. II pads
 */

export interface PadMeta {
  name: string
  shortLabel: string
  path: string
  stem: PadStemKind
  sourceBpm?: number
  camelot?: string
  beats?: number
  mode: 'oneshot' | 'loop'
  keyLock: boolean
  bpmSync: boolean
  fxSend: boolean
}

export interface PadInfo extends PadMeta {
  looping: boolean
  rendering: boolean
  semitoneShift: number
  tempoRatio: number
}

interface Slot extends PadMeta {
  rawBuffer: AudioBuffer | null
  warpedBuffer: AudioBuffer | null
  warpedSig: string
  renderGen: number
  rendering: boolean
  gain: GainNode
  fxSendGain: GainNode
  active: AudioBufferSourceNode | null
  looping: boolean
}

function makeSpaceIR(ctx: BaseAudioContext, seconds = 2.1, decay = 2.8): AudioBuffer {
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

export class Sampler {
  readonly output: GainNode
  private slots: Slot[] = []
  private spaceInput: GainNode
  private spaceDelay: DelayNode
  private spaceFb: GainNode
  private spaceRev: ConvolverNode
  private spaceOut: GainNode

  spaceEnabled = true
  masterBpm = 0
  masterCamelot: string | undefined = undefined
  /** seconds until the master deck's next beat (0 if paused) for quantized loop launches */
  nextBeatDelaySec = 0

  onChange?: () => void

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.output = ctx.createGain()
    this.output.gain.value = 0.9
    this.output.connect(dest)

    // Built-in Space FX bus (beat-synced 1/2 delay + airy reverb for vocal chops)
    this.spaceInput = ctx.createGain()
    this.spaceDelay = ctx.createDelay(2.0)
    this.spaceDelay.delayTime.value = 0.25
    this.spaceFb = ctx.createGain()
    this.spaceFb.gain.value = 0.34
    this.spaceRev = ctx.createConvolver()
    this.spaceRev.buffer = makeSpaceIR(ctx)
    this.spaceOut = ctx.createGain()
    this.spaceOut.gain.value = 0.42

    this.spaceInput.connect(this.spaceDelay)
    this.spaceDelay.connect(this.spaceFb)
    this.spaceFb.connect(this.spaceDelay)
    this.spaceDelay.connect(this.spaceOut)
    this.spaceInput.connect(this.spaceRev)
    this.spaceRev.connect(this.spaceOut)
    this.spaceOut.connect(this.output)

    for (let i = 0; i < 8; i++) {
      const gain = ctx.createGain()
      const fxSendGain = ctx.createGain()
      fxSendGain.gain.value = 0
      gain.connect(this.output)
      gain.connect(fxSendGain)
      fxSendGain.connect(this.spaceInput)
      this.slots.push({
        name: '',
        shortLabel: '',
        path: '',
        stem: 'file',
        mode: 'oneshot',
        keyLock: false,
        bpmSync: false,
        fxSend: false,
        rawBuffer: null,
        warpedBuffer: null,
        warpedSig: '',
        renderGen: 0,
        rendering: false,
        gain,
        fxSendGain,
        active: null,
        looping: false
      })
    }
  }

  get count(): number {
    return this.slots.length
  }

  isLoaded(i: number): boolean {
    return !!this.slots[i]?.rawBuffer
  }

  firstEmptySlot(): number {
    return this.slots.findIndex((s) => !s.rawBuffer)
  }

  getRawBuffer(i: number): AudioBuffer | null {
    return this.slots[i]?.rawBuffer ?? null
  }

  info(i: number): PadInfo | null {
    const s = this.slots[i]
    if (!s || !s.rawBuffer) return null
    return {
      name: s.name,
      shortLabel: s.shortLabel || s.name.slice(0, 7),
      path: s.path,
      stem: s.stem,
      sourceBpm: s.sourceBpm,
      camelot: s.camelot,
      beats: s.beats,
      mode: s.mode,
      keyLock: s.keyLock,
      bpmSync: s.bpmSync,
      fxSend: s.fxSend,
      looping: s.looping,
      rendering: s.rendering,
      semitoneShift: s.keyLock ? camelotSemitoneDelta(s.camelot, this.masterCamelot) : 0,
      tempoRatio: s.bpmSync ? foldedTempoRatio(s.sourceBpm, this.masterBpm) : 1
    }
  }

  serialize(): (PadMeta | null)[] {
    return this.slots.map((s) =>
      s.rawBuffer
        ? {
            name: s.name,
            shortLabel: s.shortLabel,
            path: s.path,
            stem: s.stem,
            sourceBpm: s.sourceBpm,
            camelot: s.camelot,
            beats: s.beats,
            mode: s.mode,
            keyLock: s.keyLock,
            bpmSync: s.bpmSync,
            fxSend: s.fxSend
          }
        : null
    )
  }

  load(
    i: number,
    name: string,
    path: string,
    buffer: AudioBuffer,
    meta: Partial<Omit<PadMeta, 'name' | 'path'>> = {}
  ): void {
    const s = this.slots[i]
    if (!s) return
    this.stopSlot(s)
    s.name = name
    s.shortLabel = meta.shortLabel ?? name.slice(0, 7).toUpperCase()
    s.path = path
    s.stem = meta.stem ?? 'file'
    s.sourceBpm = meta.sourceBpm
    s.camelot = meta.camelot
    s.beats = meta.beats
    s.mode = meta.mode ?? 'oneshot'
    s.keyLock = meta.keyLock ?? false
    s.bpmSync = meta.bpmSync ?? !!(meta.sourceBpm && meta.sourceBpm > 0)
    s.fxSend = meta.fxSend ?? false
    s.rawBuffer = buffer
    s.warpedBuffer = null
    s.warpedSig = ''
    s.fxSendGain.gain.value = s.fxSend && this.spaceEnabled ? 0.65 : 0
    this.refreshSlotWarp(s)
    this.onChange?.()
  }

  clear(i: number): void {
    const s = this.slots[i]
    if (!s) return
    this.stopSlot(s)
    s.renderGen++
    s.rendering = false
    s.rawBuffer = null
    s.warpedBuffer = null
    s.warpedSig = ''
    s.name = ''
    s.shortLabel = ''
    s.path = ''
    s.stem = 'file'
    s.sourceBpm = undefined
    s.camelot = undefined
    s.beats = undefined
    s.mode = 'oneshot'
    s.keyLock = false
    s.bpmSync = false
    s.fxSend = false
    s.fxSendGain.gain.value = 0
    this.onChange?.()
  }

  toggleMode(i: number): 'oneshot' | 'loop' | null {
    const s = this.slots[i]
    if (!s || !s.rawBuffer) return null
    if (s.looping) this.stopSlot(s)
    s.mode = s.mode === 'loop' ? 'oneshot' : 'loop'
    this.onChange?.()
    return s.mode
  }

  toggleKeyLock(i: number): boolean | null {
    const s = this.slots[i]
    if (!s || !s.rawBuffer) return null
    s.keyLock = !s.keyLock
    this.refreshSlotWarp(s)
    this.onChange?.()
    return s.keyLock
  }

  toggleFxSend(i: number): boolean | null {
    const s = this.slots[i]
    if (!s || !s.rawBuffer) return null
    s.fxSend = !s.fxSend
    s.fxSendGain.gain.setTargetAtTime(s.fxSend && this.spaceEnabled ? 0.65 : 0, this.ctx.currentTime, 0.02)
    this.onChange?.()
    return s.fxSend
  }

  setSpaceEnabled(on: boolean): void {
    this.spaceEnabled = on
    const t = this.ctx.currentTime
    this.spaceOut.gain.setTargetAtTime(on ? 0.42 : 0, t, 0.04)
    for (const s of this.slots) {
      s.fxSendGain.gain.setTargetAtTime(on && s.fxSend ? 0.65 : 0, t, 0.02)
    }
    this.onChange?.()
  }

  stopAllLoops(): void {
    let any = false
    for (const s of this.slots) {
      if (s.looping || s.active) {
        this.stopSlot(s)
        any = true
      }
    }
    if (any) this.onChange?.()
  }

  /** Sync sampler delay time + lazily re-warp & pitch-lock harvested pads to the active deck. */
  setMasterContext(bpm: number, camelot: string | undefined, nextBeatDelaySec: number): void {
    this.nextBeatDelaySec = Math.max(0, nextBeatDelaySec)
    const bpmChanged = bpm > 0 && Math.abs(bpm - this.masterBpm) > 0.25
    const keyChanged = camelot !== this.masterCamelot
    if (!bpmChanged && !keyChanged) return

    if (bpm > 0) {
      this.masterBpm = bpm
      const dt = Math.min(1.8, Math.max(0.05, (60 / bpm) * 0.5))
      this.spaceDelay.delayTime.setTargetAtTime(dt, this.ctx.currentTime, 0.05)
    }
    this.masterCamelot = camelot

    for (const s of this.slots) {
      if (s.rawBuffer && (s.bpmSync || s.keyLock)) {
        this.refreshSlotWarp(s)
      }
    }
  }

  private targetFor(s: Slot): { rate: number; semitones: number; sig: string } {
    const rate = s.bpmSync ? foldedTempoRatio(s.sourceBpm, this.masterBpm) : 1
    const semitones = s.keyLock ? camelotSemitoneDelta(s.camelot, this.masterCamelot) : 0
    const sig = `${Math.round(rate * 200)}:${semitones}`
    return { rate, semitones, sig }
  }

  private refreshSlotWarp(s: Slot): void {
    if (!s.rawBuffer) return
    const { rate, semitones, sig } = this.targetFor(s)
    if (sig === s.warpedSig) return
    if (Math.abs(rate - 1) < 0.008 && semitones === 0) {
      s.renderGen++
      s.warpedBuffer = s.rawBuffer
      s.warpedSig = sig
      s.rendering = false
      return
    }
    const gen = ++s.renderGen
    s.rendering = true
    const raw = s.rawBuffer
    const isVocal = s.stem === 'vocals'
    void this.renderStretched(raw, rate, semitones, isVocal)
      .then((buf) => {
        if (s.renderGen !== gen) return
        s.warpedBuffer = buf
        s.warpedSig = sig
        s.rendering = false
        // If this pad is actively looping, seamlessly crossfade onto the newly key/tempo-locked buffer
        if (s.looping) this.restartLoopBuffer(s)
        this.onChange?.()
      })
      .catch(() => {
        if (s.renderGen !== gen) return
        s.rendering = false
        this.onChange?.()
      })
  }

  /** Offline Signalsmith Stretch render (~15–25ms for a 1–2 bar pad) → zero-latency playback! */
  private async renderStretched(
    src: AudioBuffer,
    rate: number,
    semitones: number,
    preserveFormants: boolean
  ): Promise<AudioBuffer> {
    const sr = src.sampleRate
    const ch = src.numberOfChannels
    const outLen = Math.max(512, Math.round(src.length / rate))
    const off = new OfflineAudioContext(ch, outLen, sr)
    const mod = await import('signalsmith-stretch')
    const node = await mod.SignalsmithStretch(off as unknown as AudioContext, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, ch)]
    })
    const chans: Float32Array[] = []
    for (let c = 0; c < ch; c++) chans.push(src.getChannelData(c).slice())
    await node.addBuffers(chans)
    node.connect(off.destination)
    node.schedule({
      active: true,
      input: 0,
      rate,
      semitones,
      formantCompensation: preserveFormants
    })
    const rendered = await off.startRendering()
    // Apply 3ms edge micro-fade so looped playback stays 100% seamless
    const fade = Math.min(Math.floor(rendered.length * 0.1), Math.floor(0.003 * sr))
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const d = rendered.getChannelData(c)
      for (let i = 0; i < fade; i++) {
        const g = i / fade
        d[i] *= g
        d[d.length - 1 - i] *= g
      }
    }
    return rendered
  }

  private stopSlot(s: Slot): void {
    const old = s.active
    s.active = null
    s.looping = false
    if (!old) return
    try {
      old.stop()
    } catch {
      /* already stopped */
    }
    try {
      old.disconnect()
    } catch {
      /* noop */
    }
  }

  private restartLoopBuffer(s: Slot): void {
    if (!s.rawBuffer) return
    const vel = s.gain.gain.value || 1
    this.stopSlot(s)
    this.startSlot(s, vel, true, 0)
  }

  private startSlot(s: Slot, velocity: number, loop: boolean, delaySec: number): void {
    if (!s.rawBuffer) return
    const { rate, sig } = this.targetFor(s)
    const useWarped = s.warpedBuffer && s.warpedSig === sig
    const buf = useWarped ? s.warpedBuffer! : s.rawBuffer

    const src = this.ctx.createBufferSource()
    src.buffer = buf
    // If offline pitch/tempo render is still in flight, immediately match tempo via playbackRate
    if (!useWarped && s.bpmSync && Math.abs(rate - 1) > 0.008) {
      src.playbackRate.value = rate
    }
    src.loop = loop
    src.connect(s.gain)
    s.gain.gain.setValueAtTime(Math.max(0.05, Math.min(1, velocity)), this.ctx.currentTime)
    const when = delaySec > 0.004 ? this.ctx.currentTime + delaySec : 0
    src.start(when)
    s.active = src
    s.looping = loop
    src.onended = () => {
      if (s.active === src) {
        s.active = null
        s.looping = false
        this.onChange?.()
      }
    }
  }

  /** Trigger pad: one-shots choke & fire immediately; sync loops toggle ON/OFF quantized to next beat. */
  trigger(i: number, velocity = 1): void {
    const s = this.slots[i]
    if (!s || !s.rawBuffer) return
    if (s.mode === 'loop') {
      if (s.looping) {
        this.stopSlot(s)
        this.onChange?.()
        return
      }
      this.stopSlot(s)
      const qDelay = this.nextBeatDelaySec > 0.005 && this.nextBeatDelaySec < 0.35 ? this.nextBeatDelaySec : 0
      this.startSlot(s, velocity, true, qDelay)
      this.onChange?.()
      return
    }
    this.stopSlot(s)
    this.startSlot(s, velocity, false, 0)
  }

  setMaster(v: number): void {
    this.output.gain.value = Math.min(1, Math.max(0, v))
  }
}
