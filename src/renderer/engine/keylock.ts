import workletSrc from './keylock-worklet.js?raw'

/**
 * Key-lock engine seam. Two implementations:
 *
 * 1. Signalsmith Stretch (preferred) — off-the-shelf MIT DSP core with an
 *    official WASM/AudioWorklet build. `rate` is pitch-preserving playback
 *    rate, `semitones` independent, native loopStart/loopEnd, and
 *    addBuffers/dropBuffers streaming (the Tier-2 memory foundation).
 * 2. The hand-rolled WSOLA worklet (fallback) — keeps working if the package
 *    fails to load in some environment.
 */

export interface KLEngine {
  onPosition?: (posSec: number) => void
  onEnded?: () => void
  play(posSec: number, rate: number): void
  stop(): void
  seek(posSec: number): void
  setRate(rate: number): void
  setLoop(startSec: number, lenSec: number): void
  clearLoop(): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// primary: signalsmith stretch
// ---------------------------------------------------------------------------

import type { StretchNode } from 'signalsmith-stretch'

class SignalsmithKL implements KLEngine {
  onPosition?: (posSec: number) => void
  onEnded?: () => void
  private loopOn = false
  private ended = false
  private node: StretchNode
  private duration: number

  private constructor(node: StretchNode, duration: number) {
    this.node = node
    this.duration = duration
    node.setUpdateInterval(0.08, () => {
      const t = node.inputTime
      this.onPosition?.(t)
      if (!this.loopOn && !this.ended && t >= duration - 0.05) {
        this.ended = true
        this.onEnded?.()
      }
    })
  }

  static async create(ctx: AudioContext, buffer: AudioBuffer, dest: AudioNode): Promise<SignalsmithKL> {
    const mod = await import('signalsmith-stretch')
    const node = await mod.SignalsmithStretch(ctx, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, buffer.numberOfChannels)]
    })
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c).slice())
    }
    await node.addBuffers(channels)
    node.connect(dest)
    return new SignalsmithKL(node, buffer.duration)
  }

  play(posSec: number, rate: number): void {
    this.ended = false
    this.node.schedule({ active: true, input: posSec, rate })
  }

  stop(): void {
    this.node.schedule({ active: false })
  }

  seek(posSec: number): void {
    this.ended = false
    this.node.schedule({ input: posSec })
  }

  setRate(rate: number): void {
    this.node.schedule({ rate })
  }

  setLoop(startSec: number, lenSec: number): void {
    this.loopOn = true
    this.node.schedule({ loopStart: startSec, loopEnd: startSec + lenSec })
  }

  clearLoop(): void {
    this.loopOn = false
    this.node.schedule({ loopStart: 0, loopEnd: 0 })
  }

  dispose(): void {
    try {
      this.node.schedule({ active: false })
    } catch {
      /* node may be gone */
    }
    try {
      this.node.disconnect()
    } catch {
      /* noop */
    }
  }
}

// ---------------------------------------------------------------------------
// fallback: hand-rolled WSOLA worklet
// ---------------------------------------------------------------------------

let modulePromise: Promise<void> | null = null

function loadWorkletModule(ctx: AudioContext): Promise<void> {
  if (!modulePromise) {
    const url = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }))
    modulePromise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
  }
  return modulePromise
}

export class WorkletKL implements KLEngine {
  onPosition?: (posSec: number) => void
  onEnded?: () => void
  private node: AudioWorkletNode

  private constructor(node: AudioWorkletNode) {
    this.node = node
    node.port.onmessage = (e) => {
      const m = e.data as { type: string; position?: number }
      if (m.type === 'position' && typeof m.position === 'number') this.onPosition?.(m.position)
      else if (m.type === 'ended') this.onEnded?.()
    }
  }

  static async create(ctx: AudioContext, buffer: AudioBuffer, dest: AudioNode): Promise<WorkletKL> {
    await loadWorkletModule(ctx)
    const node = new AudioWorkletNode(ctx, 'keylock-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, buffer.numberOfChannels)]
    })
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c).slice())
    }
    node.port.postMessage({ type: 'init', channels }, channels.map((c) => c.buffer))
    node.connect(dest)
    return new WorkletKL(node)
  }

  play(posSec: number, rate: number): void {
    this.node.port.postMessage({ type: 'play', position: posSec, rate })
  }

  stop(): void {
    this.node.port.postMessage({ type: 'stop' })
  }

  seek(posSec: number): void {
    this.node.port.postMessage({ type: 'seek', position: posSec })
  }

  setRate(rate: number): void {
    this.node.port.postMessage({ type: 'rate', rate })
  }

  setLoop(startSec: number, lenSec: number): void {
    this.node.port.postMessage({ type: 'loop', start: startSec, len: lenSec })
  }

  clearLoop(): void {
    this.node.port.postMessage({ type: 'loop', start: null })
  }

  dispose(): void {
    try {
      this.node.port.postMessage({ type: 'stop' })
    } catch {
      /* node may be gone */
    }
    try {
      this.node.disconnect()
    } catch {
      /* noop */
    }
  }
}

// ---------------------------------------------------------------------------
// selector
// ---------------------------------------------------------------------------

let signalsmithFailed = false

export async function createKL(ctx: AudioContext, buffer: AudioBuffer, dest: AudioNode): Promise<KLEngine> {
  if (!signalsmithFailed) {
    try {
      return await SignalsmithKL.create(ctx, buffer, dest)
    } catch (e) {
      signalsmithFailed = true
      console.warn('bendwave: signalsmith-stretch unavailable, using WSOLA fallback', e)
    }
  }
  return WorkletKL.create(ctx, buffer, dest)
}
