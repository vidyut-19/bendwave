import type { BeatGrid } from './deck'

/**
 * Deep Acoustic Fingerprint — pure TypeScript DSP (~35-60ms per 4-min track).
 *
 * Extracts the physical, rhythmic, timbral, and structural traits that drive
 * Set Path Planning and the Intelligent Transition Engine:
 *   - Sub-bass anatomy: peakSubHz (38Hz 808 vs 54Hz house kick), subSustain (0.04 tight vs 0.49 rolling)
 *   - Spectral balance: sub (25-55Hz), kick (55-95Hz), mid (400-3kHz), air (3k-10kHz), centroidHz
 *   - Rhythmic DNA: 16-step low-end groove vector, 4-on-the-floor score, symmetric 16th-note swing ratio
 *   - Production feel: crestDb (dynamics), stereoWidth (side/mid), loudness-normalized dancefloor energy
 *   - Timbre vector: 13-dim MFCC mean (256-pt radix-2 FFT + 26-band Mel filterbank + DCT-II)
 *   - Natural null-node (∅) percussive intro/outro scores, gated by RMS energy so quiet fades don't fool it
 */

export interface TrackFingerprint {
  /** Loudness-normalized perceived dancefloor energy (0..1) — immune to brickwall mastering bias */
  danceEnergy: number
  /** Peak frequency in 28–110 Hz (e.g. 38 Hz deep 808 vs 54 Hz house kick) */
  peakSubHz: number
  /** Sub-bass duty cycle (p50/p95 of 25ms <105Hz envelope: 0.04 tight kick, 0.49 rolling sub) */
  subSustain: number
  /** Spectral power shares (0..1) */
  subShare: number
  kickShare: number
  midShare: number
  airShare: number
  /** Spectral centroid in Hz (warm ~1200 Hz vs bright ~3200 Hz) */
  centroidHz: number
  /** Dynamic headroom in dB (p99/RMS; low ~8 dB brickwalled, high ~12+ dB dynamic) */
  crestDb: number
  /** Stereo width (Side RMS / Mid RMS: ~0.07 mono 808, ~0.30 wide house) */
  stereoWidth: number
  /** 4-on-the-floor kick regularity (0..1) */
  fourOnFloor: number
  /** Symmetric 16th-note swing ratio (~0.50 straight, ~0.64–0.68 UKG triplet shuffle) */
  swing16: number
  /** 16-step bar-folded normalized low-end (<130Hz) groove pattern */
  groove16: number[]
  /** 13-dim mean MFCC timbre vector for "same room" sonic clustering */
  mfcc: number[]
  /** Energy-gated percussive/atonal drum-tool score (0..1) for first & last 8 bars */
  introNull: number
  outroNull: number
  /** Relative energy of first 8 bars & last 8 bars (vs track active RMS) */
  introEnergy: number
  outroEnergy: number
  /** Relative sub-bass of first 8 bars & last 8 bars */
  introSub: number
  outroSub: number
}

// --- Compact in-place radix-2 Cooley-Tukey FFT (power-of-two real input) ---

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

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1)
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))))]
}

export function computeFingerprint(buffer: AudioBuffer, grid?: BeatGrid): TrackFingerprint {
  const sr = buffer.sampleRate
  const dur = buffer.duration
  const n = buffer.length
  const bpm = grid && grid.bpm > 0 ? grid.bpm : 120
  const offset = grid?.offset ?? 0
  const bpb = grid?.beatsPerBar ?? 4

  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null

  // Downsample mono & side by integer factor to ~11025-12000 Hz for fast FFT & envelope passes
  const dec = Math.max(1, Math.round(sr / 12000))
  const dsr = sr / dec
  const dn = Math.floor(n / dec)
  const mono = new Float32Array(dn)
  let midSq = 0
  let sideSq = 0
  const activeStart = Math.floor(dn * 0.2)
  const activeEnd = Math.max(activeStart + 1, Math.floor(dn * 0.8))

  for (let i = 0; i < dn; i++) {
    const idx = i * dec
    const l = ch0[idx]
    const r = ch1 ? ch1[idx] : l
    const m = 0.5 * (l + r)
    const s = 0.5 * (l - r)
    mono[i] = m
    if (i >= activeStart && i < activeEnd) {
      midSq += m * m
      sideSq += s * s
    }
  }
  const activeLen = Math.max(1, activeEnd - activeStart)
  const activeRms = Math.sqrt(midSq / activeLen)
  const stereoWidth = Math.min(1, Math.sqrt(sideSq / activeLen) / (activeRms + 1e-7))

  // Crest factor (p99 abs / active RMS in dB)
  const sampleAbs: number[] = []
  const absStep = Math.max(1, Math.floor(activeLen / 4000))
  for (let i = activeStart; i < activeEnd; i += absStep) sampleAbs.push(Math.abs(mono[i]))
  const p99 = percentile(sampleAbs, 99)
  const crestDb = Math.max(4, Math.min(24, 20 * Math.log10((p99 + 1e-7) / (activeRms + 1e-7))))

  // --- 1. Averaged 1024-pt FFT across active body -> sub anatomy, centroid, 13-dim MFCC, spectral flux ---
  const nfft = 1024
  const bins = nfft / 2 + 1
  const win = new Float32Array(nfft)
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1))

  // Build 26-band Mel filterbank on [40 Hz .. dsr/2]
  const nMel = 26
  const melMin = hzToMel(40)
  const melMax = hzToMel(dsr * 0.48)
  const melBins = new Int32Array(nMel + 2)
  for (let m = 0; m < nMel + 2; m++) {
    const hz = melToHz(melMin + ((melMax - melMin) * m) / (nMel + 1))
    melBins[m] = Math.min(bins - 1, Math.max(0, Math.round((hz * nfft) / dsr)))
  }

  const re = new Float32Array(nfft)
  const im = new Float32Array(nfft)
  const avgPsd = new Float64Array(bins)
  const prevMag = new Float32Array(bins)
  const melLogAvg = new Float64Array(nMel)
  let fluxAcc = 0
  let flatAcc = 0
  let nFrames = 0

  // Sample up to 160 evenly spaced frames across the active body (~10ms total!)
  const maxFrames = 160
  const hop = Math.max(nfft >> 1, Math.floor((activeEnd - activeStart - nfft) / maxFrames))
  for (let st = activeStart; st + nfft <= activeEnd; st += hop) {
    for (let i = 0; i < nfft; i++) {
      re[i] = mono[st + i] * win[i]
      im[i] = 0
    }
    fftRadix2(re, im)

    let frameFlux = 0
    let frameMagSum = 0
    let logSum = 0
    let linSum = 0
    for (let k = 1; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k]
      const mag = Math.sqrt(p)
      avgPsd[k] += p
      if (nFrames > 0) {
        const d = mag - prevMag[k]
        if (d > 0) frameFlux += d
      }
      prevMag[k] = mag
      frameMagSum += mag
      logSum += Math.log(p + 1e-12)
      linSum += p
    }
    if (nFrames > 0) fluxAcc += frameFlux / (frameMagSum + 1e-7)
    flatAcc += Math.exp(logSum / (bins - 1)) / (linSum / (bins - 1) + 1e-12)

    // Mel band log energies
    for (let m = 0; m < nMel; m++) {
      const a = melBins[m]
      const c = melBins[m + 1]
      const b = melBins[m + 2]
      let e = 0
      for (let k = a; k < c; k++) e += ((k - a) / Math.max(1, c - a)) * (re[k] * re[k] + im[k] * im[k])
      for (let k = c; k <= b; k++) e += ((b - k) / Math.max(1, b - c)) * (re[k] * re[k] + im[k] * im[k])
      melLogAvg[m] += Math.log(e + 1e-10)
    }
    nFrames++
  }

  const invF = 1 / Math.max(1, nFrames)
  for (let k = 0; k < bins; k++) avgPsd[k] *= invF
  for (let m = 0; m < nMel; m++) melLogAvg[m] *= invF

  // DCT-II -> 13 MFCC coefficients
  const mfcc: number[] = []
  for (let c = 0; c < 13; c++) {
    let acc = 0
    for (let m = 0; m < nMel; m++) {
      acc += melLogAvg[m] * Math.cos((Math.PI * c * (m + 0.5)) / nMel)
    }
    mfcc.push(Math.round(acc * 1000) / 1000)
  }

  // Band power shares & centroid & peakSubHz
  let totPsd = 1e-12
  let subP = 0
  let kickP = 0
  let midP = 0
  let airP = 0
  let centNum = 0
  let centDen = 1e-12
  let peakSubVal = -1
  let peakSubHz = 50
  for (let k = 1; k < bins; k++) {
    const hz = (k * dsr) / nfft
    const p = avgPsd[k]
    totPsd += p
    if (hz >= 25 && hz < 55) subP += p
    else if (hz >= 55 && hz < 95) kickP += p
    else if (hz >= 400 && hz < 3000) midP += p
    else if (hz >= 3000) airP += p
    const mag = Math.sqrt(p)
    centNum += hz * mag
    centDen += mag
    if (hz >= 28 && hz <= 110 && p > peakSubVal) {
      peakSubVal = p
      peakSubHz = hz
    }
  }
  const subShare = subP / totPsd
  const kickShare = kickP / totPsd
  const midShare = midP / totPsd
  const airShare = airP / totPsd
  const centroidHz = Math.round(centNum / centDen)

  // --- 2. Low-end (<130Hz) & High-end (>400Hz) envelopes for SubSustain, 16-step Groove, 4OTF & Swing ---
  const aSub = 1 - Math.exp((-2 * Math.PI * 115) / dsr)
  const aHi = 1 - Math.exp((-2 * Math.PI * 400) / dsr)
  const loSig = new Float32Array(dn)
  const hiSig = new Float32Array(dn)
  let lp1 = 0
  let lp2 = 0
  let lpHi = 0
  for (let i = 0; i < dn; i++) {
    const x = mono[i]
    lp1 += aSub * (x - lp1)
    lp2 += aSub * (lp1 - lp2) // 2nd-order steeper lowpass for clean sub isolation
    lpHi += aHi * (x - lpHi)
    loSig[i] = lp2
    hiSig[i] = x - lpHi
  }

  // SubSustain (p50 / p95 of 25ms RMS blocks in active region)
  const blk25 = Math.max(8, Math.floor(0.025 * dsr))
  const subBlocks: number[] = []
  for (let i = activeStart; i + blk25 <= activeEnd; i += blk25) {
    let acc = 0
    for (let k = 0; k < blk25; k++) acc += loSig[i + k] * loSig[i + k]
    subBlocks.push(Math.sqrt(acc / blk25))
  }
  const subP50 = percentile(subBlocks, 50)
  const subP95 = percentile(subBlocks, 95)
  const subSustain = Math.min(1, Math.max(0, subP50 / (subP95 + 1e-7)))

  // 16-step bar-folded low-end groove pattern + 4OTF + Onset density
  const barDur = (60 / bpm) * bpb
  const nBars = Math.floor((dur - offset) / barDur)
  const groove = new Float64Array(16)
  let grooveBars = 0
  const bStart = Math.max(2, Math.floor(nBars * 0.2))
  const bEnd = Math.min(nBars - 2, Math.floor(nBars * 0.85))
  for (let b = bStart; b < bEnd; b++) {
    const s0 = Math.floor((offset + b * barDur) * dsr)
    const s1 = Math.floor((offset + (b + 1) * barDur) * dsr)
    if (s0 < 0 || s1 > dn || s1 - s0 < 32) continue
    const stepLen = (s1 - s0) / 16
    for (let st = 0; st < 16; st++) {
      const a = s0 + Math.floor(st * stepLen)
      const c = Math.max(a + 1, s0 + Math.floor((st + 1) * stepLen))
      let acc = 0
      for (let i = a; i < c; i++) acc += loSig[i] * loSig[i]
      groove[st] += Math.sqrt(acc / (c - a))
    }
    grooveBars++
  }
  let gMax = 1e-7
  for (let st = 0; st < 16; st++) {
    if (grooveBars > 0) groove[st] /= grooveBars
    if (groove[st] > gMax) gMax = groove[st]
  }
  const groove16 = Array.from(groove, (v) => Math.round((v / gMax) * 100) / 100)

  // 4-on-the-floor score: beats 0,4,8,12 should all be strong AND uniform compared to offbeats
  const onBeats = [groove16[0], groove16[4], groove16[8], groove16[12]]
  const minOn = Math.min(...onBeats)
  const meanOn = (onBeats[0] + onBeats[1] + onBeats[2] + onBeats[3]) / 4
  const offMean = (groove16[1] + groove16[2] + groove16[5] + groove16[6] + groove16[9] + groove16[10] + groove16[13] + groove16[14]) / 8
  const uniformity = minOn / (meanOn + 1e-5)
  const contrast = Math.max(0, (meanOn - offMean) / (meanOn + 1e-5))
  const fourOnFloor = Math.round(Math.min(1, Math.max(0, uniformity * (0.45 + 0.85 * contrast))) * 100) / 100

  // Symmetric 16th-note swing ratio:
  // First align to the actual hi-band on-beat peak phase (cancels MP3 priming delay!),
  // then take weighted median of offbeat peaks in the symmetric [0.30, 0.70] window.
  const hopOn = Math.max(16, Math.floor(0.005 * dsr)) // 5ms resolution
  const nOn = Math.floor((activeEnd - activeStart) / hopOn)
  const hiEnv = new Float32Array(nOn)
  for (let i = 0; i < nOn; i++) {
    const st = activeStart + i * hopOn
    let acc = 0
    for (let k = 0; k < hopOn; k++) acc += hiSig[st + k] * hiSig[st + k]
    hiEnv[i] = Math.sqrt(acc / hopOn)
  }
  const halfBeat = (60 / bpm) * 0.5
  let envMean = 0
  for (let i = 0; i < nOn; i++) envMean += hiEnv[i]
  envMean /= Math.max(1, nOn)

  const rawPeaks: { ph: number; w: number }[] = []
  let onsetCount = 0
  // Circular histogram (20 bins across [0,1)) to find the true on-beat anchor
  const hist = new Float64Array(20)
  for (let i = 2; i < nOn - 2; i++) {
    const d = hiEnv[i] - hiEnv[i - 1]
    if (d > envMean * 0.25 && hiEnv[i] >= hiEnv[i - 1] && hiEnv[i] >= hiEnv[i + 1]) {
      onsetCount++
      const tSec = (activeStart + i * hopOn) / dsr
      const ph = ((((tSec - offset) / halfBeat) % 1) + 1) % 1
      rawPeaks.push({ ph, w: d })
      hist[Math.min(19, Math.floor(ph * 20))] += d
    }
  }
  let bestBin = 0
  for (let b = 1; b < 20; b++) if (hist[b] > hist[bestBin]) bestBin = b
  const anchorPh = (bestBin + 0.5) / 20

  const swingPhases: { ph: number; w: number }[] = []
  for (const p of rawPeaks) {
    const rel = (((p.ph - anchorPh) % 1) + 1) % 1
    if (rel >= 0.3 && rel <= 0.7) swingPhases.push({ ph: rel, w: p.w })
  }
  let swing16 = 0.5
  if (swingPhases.length >= 12) {
    swingPhases.sort((a, b) => a.ph - b.ph)
    const totalW = swingPhases.reduce((s, p) => s + p.w, 0)
    let cum = 0
    for (const p of swingPhases) {
      cum += p.w
      if (cum >= totalW * 0.5) {
        swing16 = Math.round(p.ph * 1000) / 1000
        break
      }
    }
  }

  // --- 3. Loudness-normalized dancefloor energy (spread cleanly across [0..1]) ---
  const activeSec = activeLen / dsr
  const onsetsPerSec = onsetCount / Math.max(1, activeSec)
  const normOnset = Math.min(1, Math.max(0, (onsetsPerSec - 3.5) / 11))
  const normFlux = Math.min(1, Math.max(0, (fluxAcc * invF - 0.14) / 0.24))
  const normTempo = Math.min(1, Math.max(0, (bpm - 95) / 42))
  const normAir = Math.min(1, Math.sqrt(airShare) * 2.5)
  const normSubDrive = Math.min(1, Math.sqrt(subShare + kickShare) * 1.1)
  const danceEnergy =
    Math.round(
      Math.min(1, Math.max(0, 0.28 * normOnset + 0.24 * normFlux + 0.24 * normTempo + 0.14 * normAir + 0.1 * normSubDrive)) * 100
    ) / 100

  // --- 4. Energy-gated Intro & Outro natural Null-Node (∅) drum-tool score (first 8B & last 8B) ---
  const windowSec = Math.min(dur * 0.25, barDur * 8)
  const activeLoRms = Math.sqrt(
    subBlocks.reduce((s, v) => s + v * v, 0) / Math.max(1, subBlocks.length)
  )

  const measureEdge = (t0: number, t1: number): { nullScore: number; relEnergy: number; relSub: number } => {
    const i0 = Math.max(0, Math.floor(t0 * dsr))
    const i1 = Math.min(dn, Math.floor(t1 * dsr))
    if (i1 - i0 < nfft) return { nullScore: 0, relEnergy: 0, relSub: 0 }
    let rSq = 0
    let lSq = 0
    for (let i = i0; i < i1; i++) {
      rSq += mono[i] * mono[i]
      lSq += loSig[i] * loSig[i]
    }
    const edgeRms = Math.sqrt(rSq / (i1 - i0))
    const edgeSub = Math.sqrt(lSq / (i1 - i0))
    const relEnergy = edgeRms / (activeRms + 1e-7)
    const relSub = edgeSub / (activeLoRms + 1e-7)

    // Measure spectral flatness (atonal/percussive vs pitched chords) & transient impulsiveness
    let flatSum = 0
    let cnt = 0
    const step = Math.max(nfft >> 1, Math.floor((i1 - i0 - nfft) / 24))
    for (let st = i0; st + nfft <= i1; st += step) {
      for (let k = 0; k < nfft; k++) {
        re[k] = mono[st + k] * win[k]
        im[k] = 0
      }
      fftRadix2(re, im)
      let lSum = 0
      let pSum = 0
      // Check harmonic band (150 Hz .. 3500 Hz) flatness — drum tools have flat/noise-like spectrum here!
      const kMin = Math.max(1, Math.floor((150 * nfft) / dsr))
      const kMax = Math.min(bins - 1, Math.ceil((3500 * nfft) / dsr))
      for (let k = kMin; k <= kMax; k++) {
        const p = re[k] * re[k] + im[k] * im[k]
        lSum += Math.log(p + 1e-12)
        pSum += p
      }
      const span = Math.max(1, kMax - kMin + 1)
      flatSum += Math.exp(lSum / span) / (pSum / span + 1e-12)
      cnt++
    }
    const flatness = cnt > 0 ? flatSum / cnt : 0
    // Gate by energy so silent fadeouts (relEnergy < 0.25) NEVER score as active drum tools!
    const energyGate = relEnergy < 0.22 ? 0 : Math.min(1, (relEnergy - 0.22) / 0.35)
    const rawPerc = Math.min(1, flatness * 7.5)
    return {
      nullScore: Math.round(rawPerc * energyGate * 100) / 100,
      relEnergy: Math.round(relEnergy * 100) / 100,
      relSub: Math.round(relSub * 100) / 100
    }
  }

  const introEdge = measureEdge(offset, offset + windowSec)
  const outroEdge = measureEdge(Math.max(0, dur - windowSec), dur)

  return {
    danceEnergy,
    peakSubHz: Math.round(peakSubHz),
    subSustain: Math.round(subSustain * 100) / 100,
    subShare: Math.round(subShare * 1000) / 1000,
    kickShare: Math.round(kickShare * 1000) / 1000,
    midShare: Math.round(midShare * 1000) / 1000,
    airShare: Math.round(airShare * 1000) / 1000,
    centroidHz,
    crestDb: Math.round(crestDb * 10) / 10,
    stereoWidth: Math.round(stereoWidth * 1000) / 1000,
    fourOnFloor,
    swing16,
    groove16,
    mfcc,
    introNull: introEdge.nullScore,
    outroNull: outroEdge.nullScore,
    introEnergy: introEdge.relEnergy,
    outroEnergy: outroEdge.relEnergy,
    introSub: introEdge.relSub,
    outroSub: outroEdge.relSub
  }
}

/** Human-readable DJ micro-tags distilled from the raw acoustic fingerprint. */
export function describeFingerprint(fp?: TrackFingerprint): string[] {
  if (!fp) return []
  const tags: string[] = []
  if (fp.subShare >= 0.55 && fp.peakSubHz <= 46) tags.push(`${fp.peakSubHz}Hz 808`)
  else if (fp.subSustain >= 0.36) tags.push(`${fp.peakSubHz}Hz ROLLING`)
  else if (fp.subSustain <= 0.14) tags.push(`${fp.peakSubHz}Hz TIGHT`)
  else tags.push(`${fp.peakSubHz}Hz SUB`)

  if (fp.fourOnFloor >= 0.55) tags.push('4OTF')
  else if (fp.groove16[4] < 0.25 && fp.groove16[12] < 0.25) tags.push('TRAP/HALF')
  else tags.push('SYNCOPATED')

  if (fp.swing16 >= 0.59) tags.push('SWUNG')
  else if (fp.swing16 <= 0.525) tags.push('STRAIGHT')

  if (fp.stereoWidth <= 0.11) tags.push('MONO')
  if (fp.introNull >= 0.55) tags.push('∅ INTRO')
  return tags
}
