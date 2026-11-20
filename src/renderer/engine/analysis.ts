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
