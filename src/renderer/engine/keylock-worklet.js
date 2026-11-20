// vibedeck key lock processor — WSOLA-style time-domain time-stretcher.
//
// Plays grains of the source at 1:1 speed (pitch preserved) and re-positions
// them on the output timeline with overlap-add, so tempo can change without
// changing key. Grain placement is nudged by a cross-correlation search
// (WSOLA-lite) to keep transients coherent. Experimental quality: fine at
// small pitch-fader ranges, obviously artificial at extremes.
//
// Loaded via addModule(blobUrl) from the raw file contents — see keylock.ts.

const GRAIN = 3072 // grain size in samples (~70ms @ 44.1k)
const HOP = GRAIN >> 1 // 50% overlap-add hop
const SEARCH = 256 // WSOLA search radius (samples)
const SEARCH_STEP = 64
const CORR = 128 // correlation length for WSOLA matching

class KeylockProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.channels = null // Float32Array[] source channel data
    this.chCount = 2
    this.len = 0
    this.rate = 1
    this.playing = false
    this.loop = null // { start, len } in samples
    this.fifo = null // per-channel output ring buffer
    this.fifoLen = GRAIN * 4
    this.fifoRead = 0
    this.fifoWrite = 0
    this.fifoFill = 0 // unplayed output frames in fifo
    this.readPos = 0 // input read position (samples, float)
    this.prevTail = null // unwindowed tail of previous grain (WSOLA reference)
    this.outFrames = 0
    this.endedSent = false
    this.env = null // Hann window
    this.port.onmessage = (e) => this.onMsg(e.data)
  }

  onMsg(m) {
    switch (m.type) {
      case 'init': {
        this.channels = m.channels
        this.chCount = this.channels.length
        this.len = this.channels[0].length
        this.fifo = []
        for (let c = 0; c < this.chCount; c++) this.fifo.push(new Float32Array(this.fifoLen))
        this.env = new Float32Array(GRAIN)
        for (let i = 0; i < GRAIN; i++) {
          this.env[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN)
        }
        this.prevTail = new Float32Array(HOP)
        this.resetStream(0)
        break
      }
      case 'play':
        this.rate = m.rate
        this.resetStream(m.position)
        this.playing = true
        this.endedSent = false
        break
      case 'stop':
        this.playing = false
        break
      case 'seek':
        this.resetStream(m.position)
        break
      case 'rate':
        this.rate = m.rate
        break
      case 'loop':
        if (m.start == null) {
          this.loop = null
        } else {
          this.loop = { start: m.start * sampleRate, len: m.len * sampleRate }
        }
        break
    }
  }

  resetStream(sec) {
    this.readPos = Math.max(0, Math.min(sec * sampleRate, this.len - 1))
    this.fifoRead = 0
    this.fifoWrite = 0
    this.fifoFill = 0
    this.outFrames = 0
    if (this.fifo) {
      for (let c = 0; c < this.chCount; c++) this.fifo[c].fill(0)
    }
    if (this.prevTail) this.prevTail.fill(0)
  }

  // Find the offset near readPos whose content best matches the previous
  // grain's tail, so the overlap-add crossfade lands on similar waveform.
  bestOffset() {
    if (Math.abs(this.rate - 1) < 0.001 || !this.channels) return 0
    const ch0 = this.channels[0]
    const base = Math.floor(this.readPos)
    if (base < 0 || base + CORR + SEARCH >= this.len) return 0
    let best = 0
    let bestScore = -Infinity
    for (let off = -SEARCH; off <= SEARCH; off += SEARCH_STEP) {
      const s = base + off
      if (s < 0) continue
      let score = 0
      for (let i = 0; i < CORR; i++) score += this.prevTail[i] * ch0[s + i]
      if (score > bestScore) {
        bestScore = score
        best = off
      }
    }
    return best
  }

  produceGrain() {
    let start = Math.floor(this.readPos) + this.bestOffset()
    if (start < 0) start = 0
    const maxStart = Math.max(0, this.len - GRAIN)
    if (start > maxStart) start = maxStart

    for (let c = 0; c < this.chCount; c++) {
      const src = this.channels[c]
      const dst = this.fifo[c]
      for (let i = 0; i < GRAIN; i++) {
        const idx = (this.fifoWrite + i) % this.fifoLen
        const s = start + i
        dst[idx] += (s < this.len ? src[s] : 0) * this.env[i]
      }
    }
    // keep unwindowed tail for the next WSOLA match
    const ch0 = this.channels[0]
    for (let i = 0; i < HOP; i++) {
      const s = start + HOP + i
      this.prevTail[i] = s < this.len ? ch0[s] : 0
    }

    this.fifoWrite = (this.fifoWrite + HOP) % this.fifoLen
    this.readPos += HOP * this.rate
    this.fifoFill += HOP
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const n = out[0] ? out[0].length : 128

    if (!this.channels || !this.fifo || !this.playing) {
      for (let c = 0; c < out.length; c++) out[c].fill(0)
      return true
    }

    // keep the fifo topped up (~one grain of lookahead = ~70ms latency)
    while (this.fifoFill < GRAIN + 512 && (this.readPos < this.len || this.loop)) {
      if (this.loop) {
        const end = this.loop.start + this.loop.len
        while (this.readPos >= end) this.readPos -= this.loop.len
        if (this.readPos < this.loop.start) this.readPos = this.loop.start
      }
      this.produceGrain()
    }

    let playedAny = false
    for (let i = 0; i < n; i++) {
      if (this.fifoFill <= 0) {
        for (let c = 0; c < out.length; c++) out[c].fill(0, i)
        break
      }
      playedAny = true
      for (let c = 0; c < out.length; c++) {
        const f = this.fifo[c < this.chCount ? c : this.chCount - 1]
        out[c][i] = f[this.fifoRead]
      }
      for (let c = 0; c < this.chCount; c++) this.fifo[c][this.fifoRead] = 0
      this.fifoRead = (this.fifoRead + 1) % this.fifoLen
      this.fifoFill--
      this.outFrames++
    }

    if (!playedAny && this.readPos >= this.len && !this.loop && !this.endedSent) {
      this.endedSent = true
      this.playing = false
      this.port.postMessage({ type: 'ended' })
    }

    // periodic audible-position report (input domain, fifo-compensated)
    if (this.playing && this.outFrames % 2048 < n) {
      const audibleIn = this.readPos - this.fifoFill * this.rate
      this.port.postMessage({ type: 'position', position: Math.max(0, audibleIn / sampleRate) })
    }
    return true
  }
}

registerProcessor('keylock-processor', KeylockProcessor)
