import { STEM_ORDER, type Deck } from './deck'

/**
 * MIR-Driven Stem-to-Pad DNA Harvester (Pillar 6 v2)
 *
 * Replaces arbitrary Hz/amplitude gates with genre-agnostic MIR analysis:
 *   - 12-bin Chromagram Self-Similarity Matrix (Bartsch & Wakefield / Müller
 *     audio thumbnailing) to locate true recurring hooks on OTH, BAS & VOX
 *   - Spectral Tonality (1 - flatness) + Chroma Novelty to separate crisp
 *     synth riffs & chord stabs from noisy risers / Demucs bleed
 *   - Transient Isolation + Pre-Hit Quietness to pick clean wet kicks & hits
 *   - Maximal Marginal Relevance (cosine diversity < 0.72) so VOX 1 & VOX 2
 *     are NEVER the same chorus repeated twice
 *   - Sample-accurate Leading-Silence Auto-Trim on one-shots so every pad
 *     fires at 0.0 ms attack with zero lag when augmenting a live beat
 *   - Ranked candidate pools per stem to power Serato-Sample-style Pin + Re-Roll
 */

export type PadStemKind = 'drums' | 'bass' | 'other' | 'vocals' | 'mix' | 'file'

export interface HarvestedClip {
  name: string
  shortLabel: string
  stem: PadStemKind
  buffer: AudioBuffer
  sourceBpm?: number
  camelot?: string
  beats?: number
  mode: 'oneshot' | 'loop'
  keyLock: boolean
  fxSend: boolean
  /** Start time in source track (seconds), useful for display & diagnostics */
  sourceSec?: number
}

export interface TrackHarvestPools {
  trackId: string
  drums: HarvestedClip[]
  bass: HarvestedClip[]
  other: HarvestedClip[]
  vocals: HarvestedClip[]
}

const CAMELOT_RE = /^(\d{1,2})([AB])$/

/**
 * Shortest semitone shift [-5..+6] from `fromCam` to `toCam` on the Camelot
 * circle of fifths. Each +1 clockwise step = +7 semitones (mod 12).
 * Relative major/minor (e.g. 8A ↔ 8B) share the exact same scale → 0 st.
 */
export function camelotSemitoneDelta(fromCam?: string, toCam?: string): number {
  if (!fromCam || !toCam) return 0
  const a = CAMELOT_RE.exec(fromCam.trim().toUpperCase())
  const b = CAMELOT_RE.exec(toCam.trim().toUpperCase())
  if (!a || !b) return 0
  const n1 = Number(a[1])
  const n2 = Number(b[1])
  let st = (((n2 - n1) * 7) % 12 + 12) % 12
  if (st > 6) st -= 12
  return st
}

/** Half/double-time aware tempo ratio (keeps extreme 73→132 jumps musical). */
export function foldedTempoRatio(sourceBpm?: number, targetBpm?: number): number {
  if (!sourceBpm || !targetBpm || sourceBpm <= 0 || targetBpm <= 0) return 1
  let r = targetBpm / sourceBpm
  while (r > 1.414) r /= 2
  while (r < 0.707) r *= 2
  return Math.max(0.65, Math.min(1.5, r))
}

function hzToNoteName(hz: number): string {
  if (!hz || hz < 20 || hz > 400) return ''
  const midi = Math.round(69 + 12 * Math.log2(hz / 440))
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

// --- Compact radix-2 Cooley-Tukey FFT for Chroma, Spectral Envelope & Tonality ---

function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length
  let j = 0
  for (let i = 1; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + half] = uRe - vRe
        im[i + k + half] = uIm - vIm
        const nRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nRe
      }
    }
  }
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

function l2Norm(v: Float32Array): void {
  let sq = 0
  for (let i = 0; i < v.length; i++) sq += v[i] * v[i]
  const inv = 1 / (Math.sqrt(sq) + 1e-8)
  for (let i = 0; i < v.length; i++) v[i] *= inv
}

/**
 * Trim dead air from the front of a one-shot slice so the actual acoustic
 * transient hits at sample 0 (0.0 ms lag when finger-drumming over a live beat!).
 * Scans in 1ms hops until amplitude exceeds 8% of slice peak, then backs up 2ms.
 */
export function trimLeadingSilence(ctx: BaseAudioContext, buf: AudioBuffer, maxTrimSec = 0.45): AudioBuffer {
  const sr = buf.sampleRate
  const ch = buf.numberOfChannels
  const c0 = buf.getChannelData(0)
  const c1 = ch > 1 ? buf.getChannelData(1) : null

  let peak = 0
  for (let i = 0; i < buf.length; i += 2) {
    const v = Math.max(Math.abs(c0[i]), c1 ? Math.abs(c1[i]) : 0)
    if (v > peak) peak = v
  }
  if (peak < 1e-4) return buf

  const thresh = Math.max(0.015, peak * 0.085)
  const maxIdx = Math.min(buf.length - Math.floor(0.12 * sr), Math.floor(maxTrimSec * sr))
  let onset = 0
  const win = Math.max(16, Math.floor(0.002 * sr))
  for (let i = 0; i < maxIdx; i += win) {
    let m = 0
    for (let k = 0; k < win && i + k < buf.length; k++) {
      const v = Math.max(Math.abs(c0[i + k]), c1 ? Math.abs(c1[i + k]) : 0)
      if (v > m) m = v
    }
    if (m >= thresh) {
      onset = Math.max(0, i - Math.floor(0.002 * sr)) // keep 2ms pre-attack cushion
      break
    }
  }
  if (onset < Math.floor(0.004 * sr)) return buf

  const newLen = Math.max(256, buf.length - onset)
  const out = ctx.createBuffer(ch, newLen, sr)
  const fadeIn = Math.min(Math.floor(newLen * 0.1), Math.max(16, Math.floor(0.002 * sr)))
  for (let c = 0; c < ch; c++) {
    const src = buf.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0; i < newLen; i++) {
      let g = 1
      if (i < fadeIn) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn)
      dst[i] = src[onset + i] * g
    }
  }
  return out
}

/**
 * Copy a time window out of `src` with raised-cosine micro-fades (default 4ms).
 * When `trimStart` is true (one-shots), trims leading dead air so hits fire at 0ms!
 */
export function sliceAudioBuffer(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  startSec: number,
  durSec: number,
  fadeMs = 4,
  trimStart = false
): AudioBuffer {
  const sr = src.sampleRate
  const start = Math.max(0, Math.min(src.length - 1, Math.floor(startSec * sr)))
  const len = Math.max(256, Math.min(src.length - start, Math.floor(durSec * sr)))
  const ch = src.numberOfChannels
  const out = ctx.createBuffer(ch, len, sr)
  const fade = Math.min(Math.floor(len * 0.2), Math.max(16, Math.floor((fadeMs / 1000) * sr)))

  for (let c = 0; c < ch; c++) {
    const inp = src.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0; i < len; i++) {
      let g = 1
      if (i < fade) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade)
      else if (i >= len - fade) g = 0.5 - 0.5 * Math.cos((Math.PI * (len - 1 - i)) / fade)
      dst[i] = inp[start + i] * g
    }
  }
  return trimStart ? trimLeadingSilence(ctx, out, Math.min(0.45, durSec * 0.45)) : out
}

// --- MIR Window Feature Extractor (Chroma12 + Spec8 + Tonality + Onset + SSM) ---

interface MirWindow {
  t: number
  dur: number
  rms: number
  peak: number
  preRms: number
  /** Clean entry score: high when preceded by breath/space then strong attack */
  entryClean: number
  /** Rhythmic modulation variance across 8 sub-blocks */
  modVar: number
  /** 1 - spectralFlatness (high for pitched synths/chords/vocals, low for noisy wash) */
  tonality: number
  /** 12-bin L2-normalized chromagram (harmony/melody) */
  chroma: Float32Array
  /** 8-band L2-normalized log spectral profile (timbre) */
  spec: Float32Array
  /** Harmonic change vs previous window (chord stabs / new phrase entries) */
  chromaNovelty: number
  /** Repetition fitness across the song (audio thumbnailing hook score!) */
  repFitness: number
}

const NFFT = 1024
const HANN = (() => {
  const w = new Float32Array(NFFT)
  for (let i = 0; i < NFFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NFFT - 1))
  return w
})()

function extractMirWindows(buf: AudioBuffer, times: number[], dur: number): MirWindow[] {
  const sr = buf.sampleRate
  const ch0 = buf.getChannelData(0)
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null
  const dec = Math.max(1, Math.round(sr / 11025))
  const dsr = sr / dec
  const bins = NFFT / 2 + 1

  // Precompute bin -> chroma pitch class (0..11) and bin -> 8 log bands
  const binChroma = new Int8Array(bins).fill(-1)
  const binBand = new Int8Array(bins).fill(-1)
  const fMin = 55
  const fMax = dsr * 0.48
  const logSpan = Math.log(fMax / fMin)
  for (let k = 1; k < bins; k++) {
    const hz = (k * dsr) / NFFT
    if (hz >= 65 && hz <= 2400) {
      const midi = Math.round(69 + 12 * Math.log2(hz / 440))
      binChroma[k] = ((midi % 12) + 12) % 12
    }
    if (hz >= fMin && hz <= fMax) {
      binBand[k] = Math.min(7, Math.floor((Math.log(hz / fMin) / logSpan) * 8))
    }
  }

  const re = new Float32Array(NFFT)
  const im = new Float32Array(NFFT)
  const out: MirWindow[] = []

  const sampleMono = (idx: number) => (ch1 ? 0.5 * (ch0[idx] + ch1[idx]) : ch0[idx])

  for (const t of times) {
    const s0 = Math.max(0, Math.floor(t * sr))
    const s1 = Math.min(buf.length, Math.floor((t + dur) * sr))
    if (s1 - s0 < NFFT * dec) continue

    // RMS, peak, and 8-sub-block modulation variance
    let sq = 0
    let peak = 0
    let n = 0
    const sub = new Float64Array(8)
    const subN = new Int32Array(8)
    const span = s1 - s0
    for (let i = s0; i < s1; i += dec) {
      const v = sampleMono(i)
      const av = Math.abs(v)
      if (av > peak) peak = av
      sq += v * v
      n++
      const b = Math.min(7, Math.floor(((i - s0) * 8) / span))
      sub[b] += v * v
      subN[b]++
    }
    const rms = Math.sqrt(sq / Math.max(1, n))
    let meanSub = 0
    const env = new Float64Array(8)
    for (let b = 0; b < 8; b++) {
      env[b] = Math.sqrt(sub[b] / Math.max(1, subN[b]))
      meanSub += env[b]
    }
    meanSub /= 8
    let vAcc = 0
    for (let b = 0; b < 8; b++) vAcc += (env[b] - meanSub) * (env[b] - meanSub)
    const modVar = Math.sqrt(vAcc / 8) / (meanSub + 1e-6)

    // Pre-window RMS (120ms just before t) to score clean entries after breath/space
    const p0 = Math.max(0, s0 - Math.floor(0.12 * sr))
    let pSq = 0
    let pN = 0
    for (let i = p0; i < s0; i += dec) {
      const v = sampleMono(i)
      pSq += v * v
      pN++
    }
    const preRms = pN > 0 ? Math.sqrt(pSq / pN) : rms
    const entryClean = rms > 0.01 ? Math.max(0, Math.min(1, (rms - preRms * 0.7) / (rms + 1e-6))) : 0

    // Average 4 evenly spaced FFT frames inside the window → Chroma12, Spec8, Tonality
    const chroma = new Float32Array(12)
    const spec = new Float32Array(8)
    let flatSum = 0
    const nFrames = 4
    const frameSpan = Math.max(1, s1 - s0 - NFFT * dec)
    for (let fr = 0; fr < nFrames; fr++) {
      const fStart = s0 + Math.floor((fr / Math.max(1, nFrames - 1)) * frameSpan)
      for (let k = 0; k < NFFT; k++) {
        re[k] = sampleMono(Math.min(buf.length - 1, fStart + k * dec)) * HANN[k]
        im[k] = 0
      }
      fftRadix2(re, im)
      let logS = 0
      let linS = 0
      let cnt = 0
      for (let k = 1; k < bins; k++) {
        const p = re[k] * re[k] + im[k] * im[k]
        const mag = Math.sqrt(p)
        const cIdx = binChroma[k]
        if (cIdx >= 0) chroma[cIdx] += mag
        const bIdx = binBand[k]
        if (bIdx >= 0) spec[bIdx] += mag
        if (k >= 12 && k <= 240) {
          logS += Math.log(p + 1e-12)
          linS += p
          cnt++
        }
      }
      flatSum += cnt > 0 ? Math.exp(logS / cnt) / (linS / cnt + 1e-12) : 0.5
    }
    const flatness = flatSum / nFrames
    const tonality = Math.max(0, Math.min(1, 1 - Math.pow(flatness, 0.35)))
    for (let b = 0; b < 8; b++) spec[b] = Math.log1p(spec[b])
    l2Norm(chroma)
    l2Norm(spec)

    out.push({
      t,
      dur,
      rms,
      peak,
      preRms,
      entryClean,
      modVar,
      tonality,
      chroma,
      spec,
      chromaNovelty: 0,
      repFitness: 0
    })
  }

  // Compute Chroma Novelty (harmonic change from previous window) & Self-Similarity Repetition Fitness
  const minSepSec = Math.max(4, dur * 4)
  for (let i = 0; i < out.length; i++) {
    if (i > 0) {
      out[i].chromaNovelty = Math.max(0, 1 - cosineSim(out[i].chroma, out[i - 1].chroma))
    }
    if (out[i].rms < 0.018) continue
    // Top-3 non-adjacent cosine matches = how strongly this phrase recurs as a hook!
    let top1 = 0
    let top2 = 0
    let top3 = 0
    for (let j = 0; j < out.length; j++) {
      if (Math.abs(out[i].t - out[j].t) < minSepSec) continue
      if (out[j].rms < 0.018) continue
      const sim = 0.65 * cosineSim(out[i].chroma, out[j].chroma) + 0.35 * cosineSim(out[i].spec, out[j].spec)
      if (sim > top1) { top3 = top2; top2 = top1; top1 = sim }
      else if (sim > top2) { top3 = top2; top2 = sim }
      else if (sim > top3) { top3 = sim }
    }
    out[i].repFitness = (top1 + top2 + top3) / 3
  }
  return out
}

/**
 * Maximal Marginal Relevance selector: picks high-scoring candidates that are
 * genuinely DISTINCT in chroma + spectral timbre (never chorus copy #2!).
 */
function pickDiverseWindows(
  scored: { w: MirWindow; score: number }[],
  maxCount: number,
  maxCosSim = 0.74,
  minTimeGapSec = 3.0
): MirWindow[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score)
  const chosen: MirWindow[] = []
  for (const cand of sorted) {
    if (chosen.some((p) => Math.abs(p.t - cand.w.t) < minTimeGapSec)) continue
    const tooSimilar = chosen.some((p) => {
      const sim = 0.6 * cosineSim(p.chroma, cand.w.chroma) + 0.4 * cosineSim(p.spec, cand.w.spec)
      return sim >= maxCosSim
    })
    if (tooSimilar) continue
    chosen.push(cand.w)
    if (chosen.length >= maxCount) break
  }
  return chosen
}

/**
 * Find clean isolated drum / transient hits via attack sharpness + pre-hit quietness
 * + clean decay (zero arbitrary Hz gates — works for wet kicks, dry kicks & trap snares!).
 */
function findCleanDrumHits(drm: AudioBuffer, maxCount: number, hitDurSec: number): { t: number; score: number; label: string }[] {
  const sr = drm.sampleRate
  const ch0 = drm.getChannelData(0)
  const ch1 = drm.numberOfChannels > 1 ? drm.getChannelData(1) : null
  const hop = Math.max(64, Math.floor(sr * 0.008)) // 8ms frames
  const fStart = Math.floor((drm.duration * 0.08 * sr) / hop)
  const fEnd = Math.min(Math.floor(drm.length / hop) - 25, Math.floor(((drm.duration - hitDurSec - 0.5) * sr) / hop))
  if (fEnd <= fStart + 20) return []

  const env = new Float32Array(fEnd - fStart)
  const loEnv = new Float32Array(fEnd - fStart)
  const aLp = 1 - Math.exp((-2 * Math.PI * 160) / (sr / 4))
  let lp = 0
  for (let f = 0; f < env.length; f++) {
    const i0 = (fStart + f) * hop
    let sq = 0
    let loSq = 0
    let n = 0
    for (let k = 0; k < hop; k += 4) {
      const idx = i0 + k
      const v = ch1 ? 0.5 * (ch0[idx] + ch1[idx]) : ch0[idx]
      lp += aLp * (v - lp)
      sq += v * v
      loSq += lp * lp
      n++
    }
    env[f] = Math.sqrt(sq / Math.max(1, n))
    loEnv[f] = Math.sqrt(loSq / Math.max(1, n))
  }

  const cands: { t: number; score: number; loShare: number }[] = []
  const bodyFrames = Math.max(6, Math.floor(0.14 / 0.008))
  const tailFrames = Math.max(6, Math.floor(0.28 / 0.008))
  for (let f = 4; f < env.length - tailFrames - 2; f++) {
    const attack = env[f]
    if (attack < 0.1) continue
    if (attack < env[f - 1] || attack < env[f + 1]) continue
    const pre = Math.max(env[f - 2], env[f - 3])
    const jump = attack - pre
    if (jump < 0.06) continue
    // Isolation ratio: strong attack vs quiet pre-hit & clean decay tail
    const preClean = 1 / (1 + (pre / (attack + 1e-6)) * 3.5)
    let body = 0
    let loBody = 0
    for (let k = 0; k < bodyFrames; k++) {
      body += env[f + k]
      loBody += loEnv[f + k]
    }
    body /= bodyFrames
    loBody /= bodyFrames
    let tail = 0
    for (let k = bodyFrames; k < tailFrames; k++) tail += env[f + k]
    tail /= Math.max(1, tailFrames - bodyFrames)
    const decayClean = Math.min(1.3, body / (tail + 0.04))
    const loShare = loBody / (body + 1e-6)
    const score = (jump * 0.5 + body * 0.5) * preClean * (0.65 + 0.35 * Math.min(1.5, decayClean))
    const t = Math.max(0, ((fStart + f) * hop) / sr - 0.004)
    cands.push({ t, score, loShare })
  }

  cands.sort((a, b) => b.score - a.score)
  const picked: { t: number; score: number; label: string }[] = []
  // Pick diverse drum hits (prefer 1 low-end kick + 1 contrasting snare/perc hit if present!)
  for (const c of cands) {
    if (picked.some((p) => Math.abs(p.t - c.t) < 1.5)) continue
    const label = c.loShare >= 0.42 ? 'KICK' : 'DRM HIT'
    // For slot #2, prefer contrasting drum type if possible
    if (picked.length === 1 && picked[0].label === label && cands.some((x) => (x.loShare >= 0.42 ? 'KICK' : 'DRM HIT') !== label && x.score > c.score * 0.55)) {
      continue
    }
    picked.push({ t: c.t, score: c.score, label })
    if (picked.length >= maxCount) break
  }
  return picked
}

/** Find clean isolated single bass / 808 hits with parabolic sub-pitch estimation. */
function findCleanBassHits(bas: AudioBuffer, durSec: number, maxCount: number): { t: number; peakHz: number; score: number }[] {
  const sr = bas.sampleRate
  const d = bas.getChannelData(0)
  const hop = Math.max(64, Math.floor(sr * 0.01))
  const startFrame = Math.floor((bas.duration * 0.08 * sr) / hop)
  const endFrame = Math.min(Math.floor(d.length / hop) - 10, Math.floor(((bas.duration - durSec - 0.5) * sr) / hop))
  if (endFrame <= startFrame + 10) return []

  const env = new Float32Array(endFrame - startFrame)
  for (let f = 0; f < env.length; f++) {
    const i0 = (startFrame + f) * hop
    let sq = 0
    for (let k = 0; k < hop; k += 2) {
      const v = d[i0 + k]
      sq += v * v
    }
    env[f] = Math.sqrt(sq / (hop / 2))
  }

  const cands: { t: number; score: number }[] = []
  const holdFrames = Math.max(8, Math.floor(Math.min(0.45, durSec * 0.6) / 0.01))
  for (let f = 2; f < env.length - holdFrames; f++) {
    const pre = Math.min(env[f - 1], env[f - 2])
    const jump = env[f] - pre
    if (jump < 0.07) continue
    let body = 0
    for (let k = 0; k < holdFrames; k++) body += env[f + k]
    body /= holdFrames
    if (body < 0.14) continue
    const quietBonus = pre < 0.08 ? 1.3 : 1.0
    const score = (jump * 0.55 + body * 0.45) * quietBonus
    const t = Math.max(0, ((startFrame + f) * hop) / sr - 0.008)
    cands.push({ t, score })
  }
  cands.sort((a, b) => b.score - a.score)

  const out: { t: number; peakHz: number; score: number }[] = []
  for (const c of cands) {
    if (out.some((p) => Math.abs(p.t - c.t) < 2.0)) continue
    // Parabolic-interpolated normalized autocorrelation for sub-0.2Hz pitch estimate
    const a0 = Math.floor((c.t + 0.08) * sr)
    const win = Math.min(Math.floor(0.28 * sr), d.length - a0)
    let peakHz = 0
    if (win > 4096) {
      const step = 4
      const effSr = sr / step
      const minLag = Math.floor(effSr / 105)
      const maxLag = Math.min(Math.floor(win / step) - 4, Math.ceil(effSr / 27))
      const corr = new Float64Array(maxLag + 2)
      let bestLag = 0
      let bestCorr = -Infinity
      for (let lag = minLag; lag <= maxLag; lag++) {
        let acc = 0
        const lim = Math.floor(win / step) - lag
        for (let i = 0; i < lim; i++) acc += d[a0 + i * step] * d[a0 + (i + lag) * step]
        const norm = acc / Math.max(1, lim)
        corr[lag] = norm
        if (norm > bestCorr) {
          bestCorr = norm
          bestLag = lag
        }
      }
      if (bestLag > minLag && bestLag < maxLag) {
        const y0 = corr[bestLag - 1]
        const y1 = corr[bestLag]
        const y2 = corr[bestLag + 1]
        const denom = y0 - 2 * y1 + y2
        const shift = Math.abs(denom) > 1e-12 ? 0.5 * ((y0 - y2) / denom) : 0
        peakHz = effSr / (bestLag + Math.max(-0.5, Math.min(0.5, shift)))
      } else if (bestLag > 0) {
        peakHz = effSr / bestLag
      }
    }
    out.push({ t: c.t, peakHz, score: c.score })
    if (out.length >= maxCount) break
  }
  return out
}

/**
 * Grab a beat-quantized slice from a specific stem (or full mix) at a given time.
 * One-shots auto-trim leading silence so hits fire at 0.0ms lag!
 */
export function grabStemSlice(
  ctx: BaseAudioContext,
  deck: Deck,
  stemIdx: number | 'mix',
  opts: { startSec?: number; beats?: number } = {}
): HarvestedClip | null {
  if (!deck.hasAudio || !deck.track) return null
  const track = deck.track
  const grid = track.grid
  const bpm = grid && grid.bpm > 0 ? grid.bpm : 120
  const beatDur = 60 / bpm
  const offset = grid?.offset ?? 0

  let src: AudioBuffer | null = null
  let stem: PadStemKind = 'mix'
  if (stemIdx !== 'mix' && deck.stemCount === 4) {
    src = deck.getStemBuffer(stemIdx)
    stem = STEM_ORDER[stemIdx] ?? 'mix'
  } else {
    src = deck.audioBuffer ?? deck.getStemBuffer(0)
    stem = 'mix'
  }
  if (!src) return null

  const defaultBeats = stem === 'drums' ? 1 : stem === 'bass' ? 4 : 2
  const beats = Math.max(0.5, Math.min(16, opts.beats ?? defaultBeats))
  const rawStart = opts.startSec ?? deck.audiblePosition
  const k = Math.round((rawStart - offset) / beatDur)
  const snappedStart = Math.max(0, Math.min(src.duration - beatDur * 0.5, offset + k * beatDur))
  const dur = beats * beatDur
  const isLoop = stem === 'bass' || beats >= 4

  const buffer = sliceAudioBuffer(
    ctx,
    src,
    Math.max(0, snappedStart - (isLoop ? 0 : 0.002)),
    dur,
    stem === 'drums' ? 2 : 4,
    !isLoop // trim leading silence on one-shots for 0ms attack!
  )

  const stemTag =
    stem === 'drums'
      ? beats <= 1
        ? 'KICK'
        : `DRM ${beats}B`
      : stem === 'bass'
        ? `BAS ${beats >= 4 ? `${beats / 4}B` : `${beats}b`}`
        : stem === 'vocals'
          ? `VOX ${beats}B`
          : stem === 'other'
            ? `OTH ${beats}B`
            : `MIX ${beats}B`

  return {
    name: `${track.name} · ${stemTag}`,
    shortLabel: stemTag,
    stem,
    buffer,
    sourceBpm: bpm,
    camelot: track.camelot,
    beats,
    mode: isLoop ? 'loop' : 'oneshot',
    keyLock: stem !== 'drums',
    fxSend: stem === 'vocals' || stem === 'other',
    sourceSec: snappedStart
  }
}

/**
 * Build ranked, cosine-diverse MIR candidate pools for ALL 4 stems of a track.
 * Cached per track so clicking HARVEST repeatedly instantly re-rolls through
 * genuinely distinct musical gems (hooks, chord stabs, ad-libs, drum/808 hits)!
 */
export function buildHarvestPools(ctx: BaseAudioContext, deck: Deck): TrackHarvestPools {
  const track = deck.track!
  const pools: TrackHarvestPools = { trackId: track.id, drums: [], bass: [], other: [], vocals: [] }
  if (!deck.hasAudio || !track) return pools

  const grid = track.grid
  const bpm = grid && grid.bpm > 0 ? grid.bpm : 120
  const beatDur = 60 / bpm
  const bpb = grid?.beatsPerBar ?? 4
  const barDur = beatDur * bpb
  const offset = grid?.offset ?? 0
  const nBars = Math.max(1, Math.floor((deck.duration - offset) / barDur))
  const bStart = Math.max(1, Math.floor(nBars * 0.08))
  const bEnd = Math.max(bStart + 1, Math.min(nBars - 1, Math.floor(nBars * 0.92)))

  // Build bar-aligned & half-bar-aligned time grids (capped to <= 90 windows for <40ms speed!)
  const barStep = Math.max(1, Math.floor((bEnd - bStart) / 64))
  const barTimes: number[] = []
  for (let b = bStart; b < bEnd; b += barStep) barTimes.push(offset + b * barDur)

  const halfBarTimes: number[] = []
  const hbStep = Math.max(1, Math.floor(((bEnd - bStart) * 2) / 88))
  let hbIdx = 0
  for (let b = bStart; b < bEnd; b++) {
    for (let sub = 0; sub < 2; sub++) {
      if (hbIdx % hbStep === 0) halfBarTimes.push(offset + b * barDur + sub * (beatDur * 2))
      hbIdx++
    }
  }

  if (deck.stemCount === 4) {
    const drm = deck.getStemBuffer(0)
    const bas = deck.getStemBuffer(1)
    const oth = deck.getStemBuffer(2)
    const vox = deck.getStemBuffer(3)

    // 1. DRM POOL — Clean isolated transient hits (wet kicks, dry kicks, snares)
    if (drm) {
      const hitDur = Math.min(0.75, Math.max(0.4, beatDur))
      const hits = findCleanDrumHits(drm, 4, hitDur)
      hits.forEach((h, idx) => {
        const tag = idx === 0 ? h.label : `${h.label} ${idx + 1}`
        pools.drums.push({
          name: `${track.name} · ${tag}`,
          shortLabel: tag,
          stem: 'drums',
          buffer: sliceAudioBuffer(ctx, drm, h.t, hitDur, 2, true),
          sourceBpm: bpm,
          camelot: track.camelot,
          beats: 1,
          mode: 'oneshot',
          keyLock: false,
          fxSend: false,
          sourceSec: h.t
        })
      })
    }

    // 2. BAS POOL — Self-Similarity recurring 1-bar groove loop + isolated single-note / 808 one-shot
    if (bas) {
      const barWins = extractMirWindows(bas, barTimes, barDur)
      const scoredLoops = barWins
        .filter((w) => w.rms > 0.03)
        .map((w) => ({
          w,
          // Hook repetition fitness + low-end groove energy + wobble/rhythmic variance
          score: w.rms * (0.45 + 0.55 * w.repFitness) * (0.7 + 0.35 * Math.min(1.5, w.modVar))
        }))
      const diverseLoops = pickDiverseWindows(scoredLoops, 3, 0.80, barDur * 2)

      const hitDur = Math.min(0.95, Math.max(0.65, beatDur * 1.1))
      const singleHits = findCleanBassHits(bas, hitDur, 2)
      const fp = track.fingerprint
      const is808 = !!fp && fp.subShare >= 0.48 && fp.peakSubHz <= 46 && fp.fourOnFloor < 0.35

      const mkSingle = (h: { t: number; peakHz: number }, idx: number): HarvestedClip => {
        const note = hzToNoteName(h.peakHz || fp?.peakSubHz || 0)
        const base = is808 ? (note ? `808 ${note}` : '808') : note ? `BAS ${note}` : 'BAS HIT'
        const tag = idx === 0 ? base : `${base}·${idx + 1}`
        return {
          name: `${track.name} · ${tag}`,
          shortLabel: tag,
          stem: 'bass',
          buffer: sliceAudioBuffer(ctx, bas, h.t, hitDur, 4, true),
          sourceBpm: undefined, // keep natural 808/bass decay; pitch-lock to live Camelot key!
          camelot: track.camelot,
          beats: 1,
          mode: 'oneshot',
          keyLock: true,
          fxSend: false,
          sourceSec: h.t
        }
      }
      const mkLoop = (w: MirWindow, idx: number): HarvestedClip => {
        const tag = idx === 0 ? (is808 ? '808 1B' : 'BAS 1B') : `BAS ${idx + 1}`
        return {
          name: `${track.name} · ${tag}`,
          shortLabel: tag,
          stem: 'bass',
          buffer: sliceAudioBuffer(ctx, bas, w.t, barDur, 5, false),
          sourceBpm: bpm,
          camelot: track.camelot,
          beats: bpb,
          mode: 'loop',
          keyLock: true,
          fxSend: false,
          sourceSec: w.t
        }
      }

      // On 808 trap tracks lead with the isolated 808 one-shot then loop; on groove/house lead with the 1-bar loop then single note!
      if (is808 && singleHits.length > 0) {
        pools.bass.push(mkSingle(singleHits[0], 0))
        diverseLoops.forEach((w, i) => pools.bass.push(mkLoop(w, i)))
        if (singleHits[1]) pools.bass.push(mkSingle(singleHits[1], 1))
      } else {
        if (diverseLoops[0]) pools.bass.push(mkLoop(diverseLoops[0], 0))
        if (singleHits[0]) pools.bass.push(mkSingle(singleHits[0], 0))
        diverseLoops.slice(1).forEach((w, i) => pools.bass.push(mkLoop(w, i + 1)))
      }
    }

    // 3. OTH POOL — Synth Hooks (Chroma SSM + Tonality) & Clean Chord Stabs (Chroma Novelty + Onset!)
    if (oth) {
      const othBarWins = extractMirWindows(oth, barTimes, barDur)
      const scoredRiffs = othBarWins
        .filter((w) => w.rms > 0.025 && w.tonality > 0.22)
        .map((w) => ({
          w,
          // Recurring melodic/harmonic riff: repetition fitness × tonality × clean energy
          score: w.rms * (0.35 + 0.65 * w.repFitness) * (0.35 + 0.65 * w.tonality)
        }))
      const riffs = pickDiverseWindows(scoredRiffs, 3, 0.72, barDur * 2)

      const othStabWins = extractMirWindows(oth, halfBarTimes, beatDur * 2)
      const scoredStabs = othStabWins
        .filter((w) => w.rms > 0.028 && w.tonality > 0.25)
        .map((w) => ({
          w,
          // Crisp chord stab: harmonic change (chromaNovelty) × clean attack entry × pitched tonality
          score: w.rms * (0.4 + 0.6 * w.tonality) * (0.45 + 0.55 * w.chromaNovelty) * (0.55 + 0.45 * w.entryClean)
        }))
      const stabs = pickDiverseWindows(scoredStabs, 3, 0.68, barDur * 2)

      // Interleave Signature Riff Loop & Clean Chord Stabs so Roll 1 = Hook Riff, Roll 2 = Chord Stab, etc.!
      const maxPairs = Math.max(riffs.length, stabs.length)
      for (let i = 0; i < maxPairs; i++) {
        if (riffs[i]) {
          const tag = i === 0 ? 'SYN 1B' : `SYN ${i + 1}`
          pools.other.push({
            name: `${track.name} · ${tag}`,
            shortLabel: tag,
            stem: 'other',
            buffer: sliceAudioBuffer(ctx, oth, riffs[i].t, barDur, 5, false),
            sourceBpm: bpm,
            camelot: track.camelot,
            beats: bpb,
            mode: 'loop',
            keyLock: true,
            fxSend: true,
            sourceSec: riffs[i].t
          })
        }
        if (stabs[i]) {
          const tag = i === 0 ? 'CHORD' : `STAB ${i + 1}`
          pools.other.push({
            name: `${track.name} · ${tag}`,
            shortLabel: tag,
            stem: 'other',
            buffer: sliceAudioBuffer(ctx, oth, stabs[i].t, beatDur * 2, 4, true),
            sourceBpm: bpm,
            camelot: track.camelot,
            beats: 2,
            mode: 'oneshot',
            keyLock: true,
            fxSend: true,
            sourceSec: stabs[i].t
          })
        }
      }
    }

    // 4. VOX POOL — Hook via Chroma/Spectral SSM + Strict Cosine-Diverse Contrasting Chops (never same chorus twice!)
    if (vox) {
      const voxWins = extractMirWindows(vox, halfBarTimes, beatDur * 2)
      const scoredVox = voxWins
        .filter((w) => w.rms > 0.028 && w.peak > 0.09)
        .map((w) => ({
          w,
          // Prioritize clean phrase start (silence/breath before syllable), pitched voice tonality, and hook repetition
          score: w.rms * (0.45 + 0.55 * w.repFitness) * (0.5 + 0.5 * w.entryClean) * (0.5 + 0.5 * w.tonality)
        }))
      // Prefer distinct vocal melody/timbre (0.72), falling back to 0.84 if a solo singer shares uniform timbre
      let diverseVox = pickDiverseWindows(scoredVox, 5, 0.72, barDur * 2)
      if (diverseVox.length < 2) {
        diverseVox = pickDiverseWindows(scoredVox, 4, 0.84, barDur * 3)
      }
      diverseVox.forEach((w, idx) => {
        const tag = idx === 0 ? 'VOX HK' : `VOX ${idx + 1}`
        pools.vocals.push({
          name: `${track.name} · ${tag}`,
          shortLabel: tag,
          stem: 'vocals',
          buffer: sliceAudioBuffer(ctx, vox, w.t, beatDur * 2, 5, true),
          sourceBpm: bpm,
          camelot: track.camelot,
          beats: 2,
          mode: 'oneshot',
          keyLock: true,
          fxSend: true,
          sourceSec: w.t
        })
      })
    }
  } else if (deck.audioBuffer) {
    // Full-mix fallback (no stems yet)
    const mix = deck.audioBuffer
    const barWins = extractMirWindows(mix, barTimes, barDur)
    const scored = barWins
      .filter((w) => w.rms > 0.03)
      .map((w) => ({ w, score: w.rms * (0.45 + 0.55 * w.repFitness) }))
    const diverse = pickDiverseWindows(scored, 4, 0.72, barDur * 2)
    diverse.forEach((w, idx) => {
      pools.other.push({
        name: `${track.name} · LOOP ${idx + 1}`,
        shortLabel: `MIX ${idx + 1}`,
        stem: 'mix',
        buffer: sliceAudioBuffer(ctx, mix, w.t, barDur, 5, false),
        sourceBpm: bpm,
        camelot: track.camelot,
        beats: bpb,
        mode: 'loop',
        keyLock: true,
        fxSend: false,
        sourceSec: w.t
      })
    })
  }

  return pools
}

/**
 * Pick one balanced 4-pad set (DRM + BAS + OTH + VOX) for a given `rollIndex`
 * (0 = top hook picks, 1 = next cosine-diverse chord stab / vocal contrast / alt bass, etc.!).
 * Falls back cleanly if a track lacks vocals or synths so you always get rich musical gems.
 */
export function selectHarvestRoll(pools: TrackHarvestPools, rollIndex: number): HarvestedClip[] {
  const out: HarvestedClip[] = []
  const used = new Set<HarvestedClip>()
  const take = (arr: HarvestedClip[], idx: number): boolean => {
    if (!arr.length) return false
    const c = arr[idx % arr.length]
    if (used.has(c)) return false
    used.add(c)
    out.push(c)
    return true
  }

  // Balanced 4-stem kit: 1 DRM + 1 BAS + 1 OTH + 1 VOX!
  take(pools.drums, rollIndex)
  take(pools.bass, rollIndex)
  take(pools.other, rollIndex)
  take(pools.vocals, rollIndex)

  // If a stem was empty (e.g. instrumental track with no VOX, or raw trap with sparse OTH),
  // top up to 4 clips using the next-best distinct candidate from BAS / VOX / OTH!
  for (const fallback of [pools.bass, pools.vocals, pools.other, pools.drums]) {
    if (out.length >= 4) break
    take(fallback, rollIndex + 1)
  }
  return out
}

/** Convenience one-call wrapper (Roll 0). */
export function autoHarvestDeck(ctx: BaseAudioContext, deck: Deck): HarvestedClip[] {
  return selectHarvestRoll(buildHarvestPools(ctx, deck), 0)
}

/** Encode any AudioBuffer into a clean 16-bit PCM WAV file (for pad persistence & K.O. II export). */
export function encodeWav16(buf: AudioBuffer): Uint8Array {
  const numCh = Math.min(2, buf.numberOfChannels)
  const sr = buf.sampleRate
  const frames = buf.length
  const dataBytes = frames * numCh * 2
  const out = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(out)

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, numCh, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * numCh * 2, true)
  v.setUint16(32, numCh * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, dataBytes, true)

  const chs = Array.from({ length: numCh }, (_, c) => buf.getChannelData(c))
  let pos = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chs[c][i]))
      v.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      pos += 2
    }
  }
  return new Uint8Array(out)
}
