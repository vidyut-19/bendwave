import { KeylockNode } from './keylock'

export interface BeatGrid {
  /** beats per minute */
  bpm: number
  /** seconds from track start to the first beat */
  offset: number
}

export interface Stems {
  drums?: string
  bass?: string
  vocals?: string
  other?: string
}

export interface Track {
  id: string
  name: string
  path: string
  durationSec: number
  sampleRate: number
  grid?: BeatGrid
  key?: string
  camelot?: string
  stems?: Stems
  /** main cue point (seconds), persisted in the crate */
  cue?: number
  /** 4 hot cue points (seconds or null), persisted in the crate */
  hotCues?: (number | null)[]
  analyzedAt?: string
  analysisSource?: 'browser' | 'sidecar'
}

export const STEM_ORDER = ['drums', 'bass', 'other', 'vocals'] as const
export type StemName = (typeof STEM_ORDER)[number]

/**
 * A single deck. Plays one track — either the full mix, 4 sample-aligned stem
 * layers, or (experimental) through the key-lock time-stretcher — through an
 * EQ strip into the mixer.
 *
 * Position math: position = startPos + (ctx.currentTime - startedAt) * effRate.
 * Whenever tempo or bend changes we "rebase" (startPos = position now) and then
 * push the new rate onto live sources, so playback never restarts.
 */
export class Deck {
  readonly id: 'A' | 'B'
  private ctx: AudioContext
  private buffer: AudioBuffer | null = null
  private stemLayers: { buffer: AudioBuffer; gain: GainNode }[] = []
  private sources: AudioBufferSourceNode[] = []
  private startedAt = 0
  private startPos = 0
  private cueHolding = false

  /** experimental pitch-preserving playback (full-mix decks only, no stems) */
  keylock = false
  private kl: KeylockNode | null = null
  private klBusy = false
  onEnded?: () => void
  onKeylockError?: (msg: string) => void

  tempoRate = 1
  bendDelta = 0
  playing = false
  cuePoint = 0
  hotCues: (number | null)[] = [null, null, null, null]
  track: Track | null = null

  private preGain: GainNode
  private low: BiquadFilterNode
  private mid: BiquadFilterNode
  private high: BiquadFilterNode
  readonly output: GainNode

  constructor(id: 'A' | 'B', ctx: AudioContext, dest: AudioNode) {
    this.id = id
    this.ctx = ctx
    this.preGain = ctx.createGain()
    this.low = ctx.createBiquadFilter()
    this.low.type = 'lowshelf'
    this.low.frequency.value = 250
    this.mid = ctx.createBiquadFilter()
    this.mid.type = 'peaking'
    this.mid.frequency.value = 1200
    this.mid.Q.value = 0.8
    this.high = ctx.createBiquadFilter()
    this.high.type = 'highshelf'
    this.high.frequency.value = 4000
    this.output = ctx.createGain()
    this.preGain.connect(this.low)
    this.low.connect(this.mid)
    this.mid.connect(this.high)
    this.high.connect(this.output)
    this.output.connect(dest)
  }

  get hasAudio(): boolean {
    return this.buffer !== null
  }

  get duration(): number {
    return this.buffer?.duration ?? 0
  }

  get audioBuffer(): AudioBuffer | null {
    return this.buffer
  }

  get effRate(): number {
    return Math.max(0.05, this.tempoRate * (1 + this.bendDelta))
  }

  get position(): number {
    if (!this.playing) return this.startPos
    return this.startPos + (this.ctx.currentTime - this.startedAt) * this.effRate
  }

  get effectiveBpm(): number | undefined {
    return this.track?.grid ? this.track.grid.bpm * this.effRate : undefined
  }

  get stemCount(): number {
    return this.stemLayers.length
  }

  setEQ(lowDb: number, midDb: number, highDb: number): void {
    this.low.gain.value = lowDb
    this.mid.gain.value = midDb
    this.high.gain.value = highDb
  }

  async load(track: Track, buffer: AudioBuffer, stemBuffers: AudioBuffer[] = []): Promise<void> {
    this.stopSources()
    if (this.kl) {
      this.kl.dispose()
      this.kl = null
    }
    this.playing = false
    this.cueHolding = false
    this.track = track
    this.buffer = buffer
    this.setStemBuffers(stemBuffers)
    if (!Array.isArray(track.hotCues) || track.hotCues.length !== 4) {
      track.hotCues = [null, null, null, null]
    }
    this.hotCues = track.hotCues
    this.cuePoint = track.cue ?? 0
    this.startPos = 0
    this.tempoRate = 1
    this.bendDelta = 0
  }

  /** Swaps stem layers; when non-empty, stems replace the full mix on playback. */
  setStemBuffers(buffers: AudioBuffer[]): void {
    for (const l of this.stemLayers) l.gain.disconnect()
    this.stemLayers = buffers.map((b) => {
      const g = this.ctx.createGain()
      g.connect(this.preGain)
      return { buffer: b, gain: g }
    })
    if (this.playing) {
      const p = this.position
      this.stopSources()
      if (this.kl) this.kl.stop()
      this.startSources(p)
    }
  }

  setStemGain(i: number, v: number): void {
    const l = this.stemLayers[i]
    if (l) l.gain.gain.value = v
  }

  play(): void {
    if (this.playing || !this.hasAudio) return
    if (this.startPos >= this.duration - 0.05) this.startPos = 0
    this.playing = true
    this.startedAt = this.ctx.currentTime
    if (this.useKeylock()) {
      void this.startKeylock(this.startPos)
    } else {
      this.startSources(this.startPos)
    }
  }

  pause(): void {
    if (!this.playing) return
    const p = this.position
    this.stopSources()
    if (this.kl) this.kl.stop()
    this.playing = false
    this.startPos = p
  }

  seek(pos: number): void {
    const p = Math.min(Math.max(pos, 0), Math.max(0, this.duration - 0.01))
    if (this.playing) {
      this.stopSources()
      this.startPos = p
      this.startedAt = this.ctx.currentTime
      if (this.useKeylock()) {
        if (this.kl) this.kl.seek(p)
        else void this.startKeylock(p)
      } else {
        this.startSources(p)
      }
    } else {
      this.startPos = p
      if (this.kl) this.kl.seek(p)
    }
  }

  setTempoRate(rate: number): void {
    this.rebase()
    this.tempoRate = rate
    this.applyRate()
  }

  /** Temporary rate offset (pitch bend). Pass 0 to release. */
  bend(delta: number): void {
    this.rebase()
    this.bendDelta = delta
    this.applyRate()
  }

  private rebase(): void {
    if (!this.playing) return
    this.startPos = this.position
    this.startedAt = this.ctx.currentTime
  }

  private applyRate(): void {
    if (this.kl && this.useKeylock()) {
      this.kl.setRate(this.effRate)
      return
    }
    for (const s of this.sources) s.playbackRate.value = this.effRate
  }

  /** CDJ-style cue: press while playing stops and returns; press while stopped plays from cue; release returns. */
  cuePress(): void {
    if (!this.hasAudio) return
    if (this.playing) {
      this.pause()
      this.seek(this.cuePoint)
      this.cueHolding = false
    } else {
      this.seek(this.cuePoint)
      this.play()
      this.cueHolding = true
    }
  }

  cueRelease(): void {
    if (this.cueHolding) {
      this.pause()
      this.seek(this.cuePoint)
      this.cueHolding = false
    }
  }

  setCueHere(): void {
    this.cuePoint = Math.min(Math.max(this.position, 0), this.duration)
    if (this.track) this.track.cue = this.cuePoint
  }

  /**
   * Sync to another deck: match effective BPM, then phase-align the nearest
   * beat of this deck's grid to the master's current beat phase.
   */
  syncTo(master: Deck): boolean {
    const mg = master.track?.grid
    const sg = this.track?.grid
    if (!mg || !sg || !this.hasAudio || !master.hasAudio) return false

    const masterEffBpm = mg.bpm * master.effRate
    this.setTempoRate(masterEffBpm / sg.bpm)

    const mBeat = 60 / masterEffBpm
    const sBeat = 60 / (sg.bpm * this.effRate)
    const mPhase = ((((master.position + mg.offset) / mBeat) % 1) + 1) % 1
    const target = sBeat * mPhase - sg.offset
    const k = Math.round((this.position - target) / sBeat)
    let pos = target + k * sBeat
    if (pos < 0) pos += sBeat
    this.seek(pos)
    return true
  }

  /** Toggle pitch-preserving playback. Returns false when stems make it unavailable. */
  setKeylock(on: boolean): boolean {
    if (on && this.stemLayers.length > 0) return false
    if (this.keylock === on) return true
    this.keylock = on
    if (this.playing) {
      const p = this.position
      this.stopSources()
      if (this.kl) this.kl.stop()
      this.startPos = p
      this.startedAt = this.ctx.currentTime
      if (on) void this.startKeylock(p)
      else this.startSources(p)
    }
    return true
  }

  private useKeylock(): boolean {
    return this.keylock && !!this.buffer && this.stemLayers.length === 0
  }

  private async startKeylock(pos: number): Promise<void> {
    if (this.klBusy) return
    this.klBusy = true
    try {
      if (!this.kl && this.buffer) {
        this.kl = await KeylockNode.create(this.ctx, this.buffer, this.preGain)
        this.kl.onPosition = (p) => {
          if (this.playing) {
            this.startPos = p
            this.startedAt = this.ctx.currentTime
          }
        }
        this.kl.onEnded = () => {
          if (this.playing) {
            this.playing = false
            this.startPos = this.duration
            this.onEnded?.()
          }
        }
      }
      if (this.playing && this.useKeylock()) this.kl?.play(pos, this.effRate)
    } catch (e) {
      this.keylock = false
      this.onKeylockError?.(String(e))
      if (this.playing) this.startSources(this.position)
    } finally {
      this.klBusy = false
    }
  }

  private startSources(from: number): void {
    const rate = this.effRate
    const mk = (buf: AudioBuffer, dest: AudioNode): AudioBufferSourceNode => {
      const s = this.ctx.createBufferSource()
      s.buffer = buf
      s.playbackRate.value = rate
      s.connect(dest)
      const off = Math.min(from, Math.max(0, buf.duration - 1e-4))
      s.start(0, off)
      return s
    }
    const list: AudioBufferSourceNode[] = []
    if (this.stemLayers.length > 0) {
      for (const l of this.stemLayers) list.push(mk(l.buffer, l.gain))
    } else if (this.buffer) {
      list.push(mk(this.buffer, this.preGain))
    }
    this.sources = list
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
      try {
        s.disconnect()
      } catch {
        /* noop */
      }
    }
    this.sources = []
  }
}
