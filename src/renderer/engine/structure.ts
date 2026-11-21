import type { BeatGrid } from './deck'

/**
 * Instant bar-synchronous song arrangement & vibe analyzer.
 *
 * Runs directly on the decoded AudioBuffer in ~20-40ms (zero ML, zero Python):
 *  1. Splits mono audio with fast 1-pole IIR filters into Sub (30-130Hz),
 *     Low (130-350Hz), Mid (350-3000Hz), and High (>3000Hz) bands, measuring
 *     per-bar RMS dB + 16th-note groove pulse.
 *  2. References every band to its own 88th-percentile peak and clamps to
 *     [-22, +3] dB so silence / full bass-cuts never wreck normalization.
 *  3. Runs multi-scale Foote checkerboard novelty (4 & 8 bar kernels) + direct
 *     2-bar step changes with 4/8-bar phrase preference to locate boundaries.
 *  4. Classifies segments into INTRO, GROOVE, BREAK, BUILD, DROP, OUTRO and
 *     extracts a compact TrackVibe vector for Next-Up curation.
 */

export type SectionLabel = 'INTRO' | 'GROOVE' | 'BREAK' | 'BUILD' | 'DROP' | 'OUTRO'

export interface TrackSection {
  label: SectionLabel
  /** 0-based bar indices relative to Bar 1 (grid.offset) */
  barStart: number
  barEnd: number
  /** seconds in track time */
  tStart: number
  tEnd: number
  /** 0..1 relative loudness & sub-bass presence within this track */
  energy: number
  bass: number
  /** true when Demucs vocals stem has significant energy in this section */
  hasVocals?: boolean
}

export interface TrackVibe {
  /** 0..1 overall drive / density */
  energy: number
  /** 0..1 sub-bass weight */
  bass: number
  /** 0..1 high-frequency brightness */
  brightness: number
  /** 0..1 dynamic contrast between drops & breakdowns */
  dynamics: number
}

export const SECTION_COLORS: Record<SectionLabel, { bg: string; fg: string; border: string }> = {
  INTRO:  { bg: 'rgba(56,189,248,0.22)',  fg: '#7dd3fc', border: '#38bdf8' },
  GROOVE: { bg: 'rgba(20,184,166,0.22)',  fg: '#5eead4', border: '#14b8a6' },
  BREAK:  { bg: 'rgba(245,158,11,0.22)',  fg: '#fcd34d', border: '#f59e0b' },
  BUILD:  { bg: 'rgba(251,146,60,0.26)',  fg: '#fdba74', border: '#fb923c' },
  DROP:   { bg: 'rgba(244,63,94,0.28)',   fg: '#fda4af', border: '#f43f5e' },
  OUTRO:  { bg: 'rgba(129,140,248,0.22)', fg: '#a5b4fc', border: '#818cf8' }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))))
  return s[idx]
}

function linearSlope(arr: number[]): number {
  const n = arr.length
  if (n < 3) return 0
  const mx = (n - 1) / 2
  let my = 0
  for (let i = 0; i < n; i++) my += arr[i]
  my /= n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = i - mx
    num += dx * (arr[i] - my)
    den += dx * dx
  }
  return den > 0 ? num / den : 0
}

function checkerboardNovelty(S: Float32Array, n: number, L: number): Float32Array {
  const out = new Float32Array(n)
  if (n <= 2 * L) return out
  const size = 2 * L
  const K = new Float32Array(size * size)
  let kAbsSum = 0
  const sig2 = 2 * (L * 0.65) * (L * 0.65)
  for (let y = 0; y < size; y++) {
    const dy = y - L + 0.5
    for (let x = 0; x < size; x++) {
      const dx = x - L + 0.5
      const sign = (x < L) === (y < L) ? 1 : -1
      const v = sign * Math.exp(-(dx * dx + dy * dy) / sig2)
      K[y * size + x] = v
      kAbsSum += Math.abs(v)
    }
  }
  for (let i = 0; i < K.length; i++) K[i] /= kAbsSum

  for (let c = L; c < n - L; c++) {
    let acc = 0
    for (let y = 0; y < size; y++) {
      const row = (c - L + y) * n + (c - L)
      const kRow = y * size
      for (let x = 0; x < size; x++) acc += S[row + x] * K[kRow + x]
    }
    out[c] = acc > 0 ? acc : 0
  }
  return out
}

export function analyzeStructure(
  buffer: AudioBuffer,
  grid?: BeatGrid
): { sections: TrackSection[]; vibe: TrackVibe } {
  const bpm = grid && grid.bpm > 0 ? grid.bpm : 120
  const offset = grid?.offset ?? 0
  const bpb = grid?.beatsPerBar ?? 4
  const sr = buffer.sampleRate
  const dur = buffer.duration
  const barDur = (60 / bpm) * bpb
  const nBars = Math.floor((dur - offset) / barDur)

  const defaultVibe: TrackVibe = { energy: 0.5, bass: 0.5, brightness: 0.5, dynamics: 0.3 }
  if (nBars < 8) {
    return {
      sections: [{ label: 'DROP', barStart: 0, barEnd: Math.max(1, nBars), tStart: 0, tEnd: dur, energy: 0.8, bass: 0.8 }],
      vibe: defaultVibe
    }
  }

  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null
  const totalLen = buffer.length

  // Fast 2x-strided single pass with 3 cascaded 1-pole filters -> 4 bands:
  // Sub (<130Hz), Low (130-350Hz), Mid (350-3000Hz), High (>3000Hz)
  const stride = 2
  const effSr = sr / stride
  const aSub = 1 - Math.exp((-2 * Math.PI * 130) / effSr)
  const aLow = 1 - Math.exp((-2 * Math.PI * 350) / effSr)
  const aMid = 1 - Math.exp((-2 * Math.PI * 3000) / effSr)

  let lpSub = 0
  let lpLow = 0
  let lpMid = 0

  // Per-bar raw features: [rmsDb, subDb, lowDb, midDb, hiDb, pulse]
  const raw: number[][] = Array.from({ length: nBars }, () => [0, 0, 0, 0, 0, 0])
  const subBlockRms = new Float32Array(16)

  // Warm up filters through pre-offset audio if any
  const preEnd = Math.min(totalLen, Math.max(0, Math.floor(offset * sr)))
  for (let i = 0; i < preEnd; i += stride) {
    const x = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i]
    lpSub += aSub * (x - lpSub)
    lpLow += aLow * (x - lpLow)
    lpMid += aMid * (x - lpMid)
  }

  let trackSumSq = 0
  let trackSubSq = 0
  let trackHiSq = 0
  let trackCount = 0

  for (let b = 0; b < nBars; b++) {
    const s0 = Math.max(0, Math.floor((offset + b * barDur) * sr))
    const s1 = Math.min(totalLen, Math.floor((offset + (b + 1) * barDur) * sr))
    const span = s1 - s0
    if (span < 128) continue

    let sumRms = 0
    let sumSub = 0
    let sumLow = 0
    let sumMid = 0
    let sumHi = 0
    let cnt = 0
    subBlockRms.fill(0)
    const subLen = Math.max(1, Math.floor(span / 16))

    for (let i = s0; i < s1; i += stride) {
      const x = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i]
      lpSub += aSub * (x - lpSub)
      lpLow += aLow * (x - lpLow)
      lpMid += aMid * (x - lpMid)
      const vSub = lpSub
      const vLow = lpLow - lpSub
      const vMid = lpMid - lpLow
      const vHi = x - lpMid

      const x2 = x * x
      sumRms += x2
      sumSub += vSub * vSub
      sumLow += vLow * vLow
      sumMid += vMid * vMid
      sumHi += vHi * vHi
      const sb = Math.min(15, Math.floor((i - s0) / subLen))
      subBlockRms[sb] += x2
      cnt++
    }

    if (cnt === 0) continue
    const rms = Math.sqrt(sumRms / cnt)
    const sub = Math.sqrt(sumSub / cnt)
    const low = Math.sqrt(sumLow / cnt)
    const mid = Math.sqrt(sumMid / cnt)
    const hi = Math.sqrt(sumHi / cnt)

    trackSumSq += sumRms
    trackSubSq += sumSub
    trackHiSq += sumHi
    trackCount += cnt

    let mSub = 0
    for (let k = 0; k < 16; k++) {
      subBlockRms[k] = Math.sqrt(subBlockRms[k] / Math.max(1, cnt / 16))
      mSub += subBlockRms[k]
    }
    mSub /= 16
    let vSub = 0
    for (let k = 0; k < 16; k++) {
      const d = subBlockRms[k] - mSub
      vSub += d * d
    }
    const pulse = Math.sqrt(vSub / 16) / (rms + 1e-6)

    raw[b] = [
      20 * Math.log10(rms + 1e-7),
      20 * Math.log10(sub + 1e-7),
      20 * Math.log10(low + 1e-7),
      20 * Math.log10(mid + 1e-7),
      20 * Math.log10(hi + 1e-7),
      Math.min(1.5, Math.max(0, pulse))
    ]
  }

  // Reference each dB feature to its 88th percentile & clamp [-22, +3] dB
  const R: number[][] = Array.from({ length: nBars }, () => [0, 0, 0, 0, 0, 0])
  const refs = [0, 0, 0, 0, 0]
  for (let c = 0; c < 5; c++) {
    refs[c] = percentile(raw.map((r) => r[c]), 88)
    for (let b = 0; b < nBars; b++) {
      R[b][c] = Math.max(-22, Math.min(3, raw[b][c] - refs[c]))
    }
  }
  for (let b = 0; b < nBars; b++) R[b][5] = raw[b][5]

  // Active-bar z-score normalization
  const activeIdx: number[] = []
  for (let b = 0; b < nBars; b++) if (R[b][0] > -18) activeIdx.push(b)
  const sampleIdx = activeIdx.length >= 4 ? activeIdx : Array.from({ length: nBars }, (_, i) => i)

  const mu = [0, 0, 0, 0, 0, 0]
  const sd = [0, 0, 0, 0, 0, 0]
  const minSd = [1.5, 2.5, 2.0, 2.0, 2.0, 0.15]
  for (let c = 0; c < 6; c++) {
    for (const i of sampleIdx) mu[c] += R[i][c]
    mu[c] /= sampleIdx.length
    let acc = 0
    for (const i of sampleIdx) {
      const d = R[i][c] - mu[c]
      acc += d * d
    }
    sd[c] = Math.max(minSd[c], Math.sqrt(acc / sampleIdx.length))
  }

  const weights = [1.7, 2.1, 0.9, 1.3, 1.1, 0.5]
  const Fu: number[][] = Array.from({ length: nBars }, (_, b) => {
    const v = [0, 0, 0, 0, 0, 0]
    let n2 = 0
    for (let c = 0; c < 6; c++) {
      v[c] = ((R[b][c] - mu[c]) / sd[c]) * weights[c]
      n2 += v[c] * v[c]
    }
    const norm = Math.sqrt(n2) + 1e-6
    for (let c = 0; c < 6; c++) v[c] /= norm
    return v
  })

  // Self-similarity matrix
  const S = new Float32Array(nBars * nBars)
  for (let i = 0; i < nBars; i++) {
    const fi = Fu[i]
    for (let j = i; j < nBars; j++) {
      const fj = Fu[j]
      let dot = 0
      for (let c = 0; c < 6; c++) dot += fi[c] * fj[c]
      S[i * nBars + j] = dot
      S[j * nBars + i] = dot
    }
  }

  const nov4 = checkerboardNovelty(S, nBars, 4)
  const nov8 = checkerboardNovelty(S, nBars, 8)
  let max4 = 1e-6
  let max8 = 1e-6
  for (let i = 0; i < nBars; i++) {
    if (nov4[i] > max4) max4 = nov4[i]
    if (nov8[i] > max8) max8 = nov8[i]
  }

  // Direct 2-bar step change detector
  const step = new Float32Array(nBars)
  let maxStep = 1e-6
  for (let i = 2; i < nBars - 2; i++) {
    const dRms = Math.abs(0.5 * (R[i][0] + R[i + 1][0]) - 0.5 * (R[i - 2][0] + R[i - 1][0]))
    const dSub = Math.abs(0.5 * (R[i][1] + R[i + 1][1]) - 0.5 * (R[i - 2][1] + R[i - 1][1]))
    const dMid = Math.abs(0.5 * (R[i][3] + R[i + 1][3]) - 0.5 * (R[i - 2][3] + R[i - 1][3]))
    const dHi = Math.abs(0.5 * (R[i][4] + R[i + 1][4]) - 0.5 * (R[i - 2][4] + R[i - 1][4]))
    const v = dRms * 1.2 + dSub * 0.75 + dMid * 0.45 + dHi * 0.45
    step[i] = v
    if (v > maxStep) maxStep = v
  }

  const score = new Array<number>(nBars).fill(0)
  for (let i = 0; i < nBars; i++) {
    const nov = 0.55 * (nov4[i] / max4) + 0.45 * (nov8[i] / max8)
    let sc = 0.6 * nov + 0.4 * (step[i] / maxStep)
    if (i % 8 === 0) sc *= 1.28
    else if (i % 4 === 0) sc *= 1.12
    score[i] = sc
  }

  const thresh = Math.max(0.3, percentile(score, 76))
  const peaks: number[] = []
  for (let i = 4; i < nBars - 3; i++) {
    if (score[i] < thresh) continue
    let isMax = true
    for (let j = Math.max(0, i - 3); j < Math.min(nBars, i + 4); j++) {
      if (score[j] > score[i]) {
        isMax = false
        break
      }
    }
    if (!isMax) continue
    if (peaks.length === 0 || i - peaks[peaks.length - 1] >= 4) {
      peaks.push(i)
    } else if (score[i] > score[peaks[peaks.length - 1]]) {
      peaks[peaks.length - 1] = i
    }
  }

  const bounds = [0, ...peaks, nBars]
  interface RawSeg {
    b0: number
    b1: number
    rms: number
    sub: number
    mid: number
    hi: number
    rmsSlope: number
    hiSlope: number
    label: SectionLabel
  }

  const segs: RawSeg[] = []
  for (let idx = 0; idx < bounds.length - 1; idx++) {
    const a = bounds[idx]
    const b = bounds[idx + 1]
    const len = Math.max(1, b - a)
    let rRms = 0
    let rSub = 0
    let rMid = 0
    let rHi = 0
    const rmsArr: number[] = []
    const hiArr: number[] = []
    for (let k = a; k < b; k++) {
      rRms += R[k][0]
      rSub += R[k][1]
      rMid += R[k][3]
      rHi += R[k][4]
      rmsArr.push(R[k][0])
      hiArr.push(R[k][4])
    }
    segs.push({
      b0: a,
      b1: b,
      rms: rRms / len,
      sub: rSub / len,
      mid: rMid / len,
      hi: rHi / len,
      rmsSlope: linearSlope(rmsArr),
      hiSlope: linearSlope(hiArr),
      label: 'GROOVE'
    })
  }

  // Pass 1: classify DROP / BREAK / GROOVE
  for (const s of segs) {
    const bassIn = s.sub >= -3.8
    const bassOut = s.sub <= -7.5
    const highCut = s.hi <= -6.5
    const loud = s.rms >= -2.3
    const quiet = s.rms <= -5.0
    const fullMid = s.mid >= -3.5

    if (loud && bassIn && (fullMid || s.rms >= -1.2)) s.label = 'DROP'
    else if (bassOut || quiet || (highCut && s.rms < -1.8)) s.label = 'BREAK'
    else s.label = 'GROOVE'
  }

  // Guarantee at least one DROP on flat-mastered tracks
  if (!segs.some((s) => s.label === 'DROP') && segs.length > 0) {
    const best = Math.max(...segs.map((s) => s.rms))
    for (const s of segs) {
      if (s.rms >= best - 1.5 && s.sub >= -5.0) s.label = 'DROP'
    }
  }

  // Pass 2: INTRO & OUTRO
  if (segs.length > 0 && segs[0].label !== 'DROP') segs[0].label = 'INTRO'
  if (segs.length >= 2 && segs[segs.length - 1].label !== 'DROP') {
    const last = segs[segs.length - 1]
    const windDown = last.rms <= -3.0 || last.sub <= -5.5 || last.rmsSlope < -0.15
    if (windDown && last.b1 - last.b0 <= 36) last.label = 'OUTRO'
  }

  // Pass 3: BUILDUP before a DROP
  for (let i = 0; i < segs.length - 1; i++) {
    const cur = segs[i]
    const nxt = segs[i + 1]
    if (nxt.label === 'DROP' && (cur.label === 'BREAK' || cur.label === 'GROOVE')) {
      const rising = cur.rmsSlope > 0.18 || cur.hiSlope > 0.2
      const dropJump = nxt.rms - cur.rms >= 2.0 || nxt.sub - cur.sub >= 5.0
      const len = cur.b1 - cur.b0
      if (rising || (cur.label === 'BREAK' && dropJump && len <= 12)) {
        cur.label = 'BUILD'
      }
    }
  }

  // Merge adjacent identical labels
  const merged: TrackSection[] = []
  for (const s of segs) {
    const energy = Math.min(1, Math.max(0, (s.rms + 18) / 18))
    const bass = Math.min(1, Math.max(0, (s.sub + 18) / 18))
    const tStart = Math.max(0, offset + s.b0 * barDur)
    const tEnd = Math.min(dur, offset + s.b1 * barDur)
    if (merged.length > 0 && merged[merged.length - 1].label === s.label) {
      const prev = merged[merged.length - 1]
      prev.barEnd = s.b1
      prev.tEnd = tEnd
      prev.energy = (prev.energy + energy) / 2
      prev.bass = (prev.bass + bass) / 2
    } else {
      merged.push({ label: s.label, barStart: s.b0, barEnd: s.b1, tStart, tEnd, energy, bass })
    }
  }

  // Compact TrackVibe fingerprint (0..1 per dimension)
  const overallRms = Math.sqrt(trackSumSq / Math.max(1, trackCount))
  const overallSub = Math.sqrt(trackSubSq / Math.max(1, trackCount))
  const overallHi = Math.sqrt(trackHiSq / Math.max(1, trackCount))
  const rmsDb = 20 * Math.log10(overallRms + 1e-7)
  const rmsActive = sampleIdx.map((i) => R[i][0])
  const dynSpan = percentile(rmsActive, 90) - percentile(rmsActive, 20)

  const vibe: TrackVibe = {
    energy: Math.min(1, Math.max(0, (rmsDb + 20) / 14)),
    bass: Math.min(1, Math.max(0, (overallSub / (overallRms + 1e-6)) * 1.4)),
    brightness: Math.min(1, Math.max(0, (overallHi / (overallRms + 1e-6)) * 3.2)),
    dynamics: Math.min(1, Math.max(0, dynSpan / 12))
  }

  return { sections: merged, vibe }
}

/**
 * Once Demucs vocals stem is available, measure vocals presence per section so
 * the DJ sees VOX badges and gets vocal-clash warnings during transitions.
 */
export function annotateVocals(sections: TrackSection[], vocalsBuf: AudioBuffer): void {
  if (!sections.length || vocalsBuf.length < 100) return
  const sr = vocalsBuf.sampleRate
  const ch0 = vocalsBuf.getChannelData(0)
  const rmsPerSec: number[] = []
  for (const s of sections) {
    const i0 = Math.max(0, Math.floor(s.tStart * sr))
    const i1 = Math.min(ch0.length, Math.floor(s.tEnd * sr))
    let acc = 0
    let n = 0
    for (let i = i0; i < i1; i += 8) {
      acc += ch0[i] * ch0[i]
      n++
    }
    rmsPerSec.push(n > 0 ? Math.sqrt(acc / n) : 0)
  }
  const peakVox = Math.max(...rmsPerSec, 0.04)
  for (let i = 0; i < sections.length; i++) {
    sections[i].hasVocals = rmsPerSec[i] > Math.max(0.035, peakVox * 0.36)
  }
}

/** Pick up to 4 useful DJ hot cues from the track's detected arrangement. */
export function pickAutoCues(sections: TrackSection[]): (number | null)[] {
  const cues: (number | null)[] = [null, null, null, null]
  if (!sections.length) return cues

  const drops = sections.filter((s) => s.label === 'DROP')
  const breaks = sections.filter((s) => s.label === 'BREAK' || s.label === 'BUILD')

  // Pad 1: Track Bar 1 / Intro start
  cues[0] = sections[0].tStart
  // Pad 2: First Drop (or 2nd section)
  if (drops[0] && drops[0].tStart > cues[0] + 1) cues[1] = drops[0].tStart
  else if (sections[1]) cues[1] = sections[1].tStart
  // Pad 3: Main Breakdown / Buildup after first drop
  const midBreak = breaks.find((b) => b.tStart > (cues[1] ?? 0) + 4) ?? breaks[0]
  if (midBreak && !cues.some((c) => c != null && Math.abs(c - midBreak.tStart) < 2)) {
    cues[2] = midBreak.tStart
  }
  // Pad 4: Second Drop or Outro
  const secondDrop = drops.find((d) => d.tStart > (cues[1] ?? 0) + 8)
  const outro = sections.find((s) => s.label === 'OUTRO')
  const fourth = secondDrop ?? outro
  if (fourth && !cues.some((c) => c != null && Math.abs(c - fourth.tStart) < 2)) {
    cues[3] = fourth.tStart
  }
  return cues
}
