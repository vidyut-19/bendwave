import workletSrc from './recorder-worklet.js?raw'

let modulePromise: Promise<void> | null = null

function loadModule(ctx: AudioContext): Promise<void> {
  if (!modulePromise) {
    const url = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }))
    modulePromise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
  }
  return modulePromise
}

/**
 * Records the master bus to a streaming 16-bit WAV on disk (chunks go over
 * IPC as they're produced, so memory stays flat no matter how long the set
 * runs). SoundCloud-streamed tracks must not be recorded (their API terms) —
 * the caller enforces that gate.
 */
export class Recorder {
  recording = false
  private node: AudioWorkletNode | null = null
  private frames = 0
  private startedAt = 0

  constructor(private ctx: AudioContext) {}

  get elapsed(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0
  }

  async start(src: AudioNode): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (this.recording) return { ok: false, error: 'already recording' }
    const api = window.vibedeck
    if (!api) return { ok: false, error: 'not running under electron' }
    try {
      await loadModule(this.ctx)
      const started = await api.recStart()
      if (!started.ok || !started.path) {
        return { ok: false, error: started.error ?? 'could not open file' }
      }
      this.frames = 0
      this.node = new AudioWorkletNode(this.ctx, 'rec-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        outputChannelCount: []
      })
      this.node.port.onmessage = (e) => {
        const m = e.data as { l: Float32Array; r: Float32Array }
        const n = m.l.length
        const inter = new Int16Array(n * 2)
        for (let i = 0; i < n; i++) {
          let l = m.l[i]
          let r = m.r[i]
          l = l < -1 ? -1 : l > 1 ? 1 : l
          r = r < -1 ? -1 : r > 1 ? 1 : r
          inter[i * 2] = (l * 32767) | 0
          inter[i * 2 + 1] = (r * 32767) | 0
        }
        this.frames += n
        void api.recWrite(new Uint8Array(inter.buffer))
      }
      src.connect(this.node)
      this.recording = true
      this.startedAt = performance.now()
      return { ok: true, path: started.path }
    } catch (e) {
      this.node = null
      return { ok: false, error: String(e) }
    }
  }

  async stop(): Promise<string | null> {
    if (!this.recording) return null
    this.recording = false
    try {
      this.node?.disconnect()
    } catch {
      /* noop */
    }
    this.node = null
    const frames = this.frames
    const rate = this.ctx.sampleRate
    const r = await window.vibedeck?.recFinish(frames, rate)
    return r?.path ?? null
  }
}
