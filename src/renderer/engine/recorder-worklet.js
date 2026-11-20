// vibedeck master-bus recorder worklet. Accumulates ~8192-frame chunks before
// posting to the main thread (posting every 128-frame quantum would be ~340
// messages/sec), so recording RAM stays flat regardless of set length.

const CHUNK = 8192

class RecProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.bufL = new Float32Array(CHUNK)
    this.bufR = new Float32Array(CHUNK)
    this.fill = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const l = input[0]
    const r = input[1] || input[0]
    let i = 0
    while (i < l.length) {
      const n = Math.min(l.length - i, CHUNK - this.fill)
      this.bufL.set(l.subarray(i, i + n), this.fill)
      this.bufR.set(r.subarray(i, i + n), this.fill)
      this.fill += n
      i += n
      if (this.fill === CHUNK) {
        this.port.postMessage({ l: this.bufL.slice(0), r: this.bufR.slice(0) })
        this.fill = 0
      }
    }
    return true
  }
}

registerProcessor('rec-processor', RecProcessor)
