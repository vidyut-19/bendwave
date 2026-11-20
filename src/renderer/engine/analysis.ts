import type { BeatGrid } from './deck'

/**
 * Zero-dependency browser beatgrid: RMS-energy onset envelope + autocorrelation
 * tempo induction + grid-phase fit. Good enough to play with; the python
 * sidecar (tools/analyze.py, librosa) is the better analyst when installed.
 */
export function computeBeatGrid(buffer: AudioBuffer, minBpm = 70, maxBpm = 180): BeatGrid {
  const sr = buffer.sampleRate
  const n = Math.min(buffer.length, Math.floor(Math.min(buffer.duration, 90) * sr))
  if (n < sr * 4) return { bpm: 0, offset: 0 } // too short to analyze honestly

  const mono = new Float32Array(n)
  const ch = buffer.numberOfChannels
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < n; i++) mono[i] += d[i] / ch
  }

  const hop = 512
  const frames = Math.floor(n / hop)
  const env = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let acc = 0
    const st = f * hop
    for (let i = st; i < st + hop; i++) acc += mono[i] * mono[i]
    env[f] = Math.sqrt(acc / hop)
  }

  const flux = new Float32Array(frames)
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, env[f] - env[f - 1])

  const fps = sr / hop
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * fps))
  const maxLag = Math.ceil((60 / minBpm) * fps)
  let bestLag = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0
    for (let f = lag; f < frames; f++) acc += flux[f] * flux[f - lag]
    const bpm = (60 * fps) / lag
    // gentle preference for club tempi to reduce half/double-time picks
    acc *= Math.exp(-0.5 * Math.pow((bpm - 128) / 45, 2))
    if (acc > bestScore) {
      bestScore = acc
      bestLag = lag
    }
  }

  let bpm = (60 * fps) / bestLag
  while (bpm < minBpm) bpm *= 2
  while (bpm > maxBpm) bpm /= 2

  const beatFrames = Math.max(1, Math.round((60 / bpm) * fps))
  let bestPhase = 0
  let bestSum = -Infinity
  for (let p = 0; p < beatFrames; p++) {
    let acc = 0
    for (let f = p; f < frames; f += beatFrames) acc += flux[f]
    if (acc > bestSum) {
      bestSum = acc
      bestPhase = p
    }
  }

  return {
    bpm: Math.round(bpm * 100) / 100,
    offset: Math.round(((bestPhase * hop) / sr) * 1000) / 1000
  }
}

/**
 * Block-RMS loudness with gating — an LUFS approximation (no K-weighting).
 * 100ms blocks, -70 dB absolute gate, -10 LU relative gate, per ITU-R BS.1770's
 * shape. Plenty accurate for matching track levels; cheap enough to run in the
 * same ingest pass as the beatgrid.
 */
export function computeLoudness(buffer: AudioBuffer): number {
  const sr = buffer.sampleRate
  const blockLen = Math.max(1, Math.floor(sr * 0.1))
  const chs = Math.min(2, buffer.numberOfChannels)
  const datas: Float32Array[] = []
  for (let c = 0; c < chs; c++) datas.push(buffer.getChannelData(c))
  const n = buffer.length
  const energies: number[] = []
  for (let st = 0; st + blockLen <= n; st += blockLen) {
    let acc = 0
    for (const d of datas) {
      for (let i = st; i < st + blockLen; i++) acc += d[i] * d[i]
    }
    energies.push(acc / (blockLen * chs))
  }
  const gated = energies.filter((e) => e > 1e-7)
  if (gated.length === 0) return -Infinity
  const mean1 = gated.reduce((a, b) => a + b, 0) / gated.length
  const relThresh = mean1 / 10 // -10 LU relative gate
  const kept = gated.filter((e) => e > relThresh)
  const mean = kept.length > 0 ? kept.reduce((a, b) => a + b, 0) / kept.length : mean1
  return -0.691 + 10 * Math.log10(mean)
}

/** loudness we normalize tracks to (streaming-standard reference) */
export const TARGET_LUFS = -14

/** recommended trim in dB, clamped to the ±12 dB trim range */
export function autoGainDb(lufs: number, target = TARGET_LUFS): number {
  if (!isFinite(lufs)) return 0
  return Math.max(-12, Math.min(12, target - lufs))
}
