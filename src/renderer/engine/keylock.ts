import workletSrc from './keylock-worklet.js?raw'

let modulePromise: Promise<void> | null = null

/**
 * Loads the keylock worklet module once per context. The source is embedded
 * as a string and served from a blob URL so it works both from the vite dev
 * server and from file:// in the packaged app.
 */
function loadModule(ctx: AudioContext): Promise<void> {
  if (!modulePromise) {
    const url = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }))
    modulePromise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
  }
  return modulePromise
}

/**
 * Realtime key-lock source node. Owns a copy of the track's channel data and
 * generates time-stretched, pitch-preserved audio itself (see
 * keylock-worklet.js). ~70ms of lookahead latency; position reports come back
 * over the port so the deck can keep its math honest.
 */
export class KeylockNode {
  private node: AudioWorkletNode
  onPosition?: (posSec: number) => void
  onEnded?: () => void

  private constructor(node: AudioWorkletNode) {
    this.node = node
    node.port.onmessage = (e) => {
      const m = e.data as { type: string; position?: number }
      if (m.type === 'position' && typeof m.position === 'number') this.onPosition?.(m.position)
      else if (m.type === 'ended') this.onEnded?.()
    }
  }

  static async create(ctx: AudioContext, buffer: AudioBuffer, dest: AudioNode): Promise<KeylockNode> {
    await loadModule(ctx)
    const node = new AudioWorkletNode(ctx, 'keylock-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, buffer.numberOfChannels)]
    })
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())
    node.port.postMessage({ type: 'init', channels }, channels.map((c) => c.buffer))
    node.connect(dest)
    return new KeylockNode(node)
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

  /** Loop inside the worklet (OLА smooths the loop point). */
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
