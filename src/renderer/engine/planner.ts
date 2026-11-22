import type { Track } from './deck'
import { harmonicScore } from './copilot'

/**
 * Graph-Theoretic Set Path Planner (pure TypeScript, <15ms on 25–100 tracks).
 *
 * Models the crate as a directed weighted graph over actual tracks:
 *   - Log-tempo distance Δτ = log2(bpm_j / bpm_i) with half/double-time wrap
 *   - Directed Camelot wheel cost, reduced by natural ∅ percussive intro/outro
 *     or capped by a Drums-Stem ∅ Reset edge when stems exist
 *   - Crate-z-scored 13-dim MFCC cosine distance ("same room" timbre)
 *   - 16-step low-end groove dot-product + 16th-note swing mismatch penalty
 *   - Loudness-normalized danceEnergy matched to selectable set arcs
 *
 * Solves strictly NO-REPEAT sets via Beam Search (width=96) + 2-opt polish,
 * plus unsupervised crate clustering & bridge-track discovery.
 */

export type SetArc = 'arc' | 'climb' | 'festival'

export type AutoStrategy =
  | 'BASS_SWAP'
  | 'HPF_ECHO'
  | 'LPF_IN'
  | 'STEM_NULL_RESET'
  | 'STEM_VOCAL_BLEND'
  | 'CROSS_FILTER'

export interface EdgeEval {
  cost: number
  bpmDeltaPct: number
  halfDouble?: '½×' | '2×'
  harmonicTag: string
  harmonicCompatible: boolean
  mfccSim: number | null
  swingDiff: number | null
  grooveSim: number | null
  usedNaturalNull: boolean
  usedStemNull: boolean
  strategy: AutoStrategy
  bars: 4 | 8
  rationale: string
}

export interface PlannedStep {
  track: Track
  energy: number
  targetEnergy: number
  /** transition INTO this track from previous step (null for opener) */
  incomingEdge: EdgeEval | null
}

export interface CrateCluster {
  id: number
  label: string
  tracks: Track[]
  avgBpm: number
  avgEnergy: number
}

export interface PlannedSet {
  arc: SetArc
  steps: PlannedStep[]
  totalCost: number
  energyRmse: number
  clusters: CrateCluster[]
  bridgeTrackIds: string[]
}

function zScoreMfccs(tracks: readonly Track[]): Map<string, number[]> {
  const valid = tracks.filter((t) => t.fingerprint?.mfcc?.length === 13)
  const out = new Map<string, number[]>()
  if (valid.length < 2) return out
  const mu = new Float64Array(13)
  const sd = new Float64Array(13)
  for (const t of valid) {
    const m = t.fingerprint!.mfcc
    for (let c = 0; c < 13; c++) mu[c] += m[c]
  }
  for (let c = 0; c < 13; c++) mu[c] /= valid.length
  for (const t of valid) {
    const m = t.fingerprint!.mfcc
    for (let c = 0; c < 13; c++) {
      const d = m[c] - mu[c]
      sd[c] += d * d
    }
  }
  for (let c = 0; c < 13; c++) sd[c] = Math.sqrt(sd[c] / valid.length) + 1e-6
  for (const t of valid) {
    const m = t.fingerprint!.mfcc
    const z = new Array<number>(13)
    let norm = 0
    for (let c = 0; c < 13; c++) {
      z[c] = (m[c] - mu[c]) / sd[c]
      norm += z[c] * z[c]
    }
    norm = Math.sqrt(norm) + 1e-6
    for (let c = 0; c < 13; c++) z[c] /= norm
    out.set(t.id, z)
  }
  return out
}

function cosineDot(a: number[], b: number[]): number {
  let acc = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) acc += a[i] * b[i]
  return acc
}

function grooveSimilarity(a?: number[], b?: number[]): number | null {
  if (!a || !b || a.length !== 16 || b.length !== 16) return null
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < 16; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na * nb) + 1e-6)
}

export function trackEnergy(t: Track): number {
  if (t.fingerprint) return t.fingerprint.danceEnergy
  if (t.vibe) return t.vibe.energy
  return 0.5
}

/** Evaluate directed transition edge i -> j with full acoustic reasoning. */
export function evaluateEdge(
  from: Track,
  to: Track,
  zMfcc: Map<string, number[]>,
  opts: { allowGenreBreak?: boolean } = {}
): EdgeEval {
  const b1 = from.grid?.bpm && from.grid.bpm > 0 ? from.grid.bpm : 120
  const b2 = to.grid?.bpm && to.grid.bpm > 0 ? to.grid.bpm : 120

  // 1. Log-tempo distance (with half/double wrap)
  const candidates: { dLog: number; pct: number; tag?: '½×' | '2×'; pen: number }[] = [
    { dLog: Math.abs(Math.log2(b2 / b1)), pct: ((b1 - b2) / b2) * 100, pen: 0 },
    { dLog: Math.abs(Math.log2((b2 * 2) / b1)), pct: ((b1 - b2 * 2) / (b2 * 2)) * 100, tag: '2×', pen: 0.35 },
    { dLog: Math.abs(Math.log2((b2 * 0.5) / b1)), pct: ((b1 - b2 * 0.5) / (b2 * 0.5)) * 100, tag: '½×', pen: 0.35 }
  ]
  candidates.sort((a, b) => a.dLog + a.pen * 0.05 - (b.dLog + b.pen * 0.05))
  const bestT = candidates[0]
  const excess = Math.max(0, bestT.dLog - 0.055)
  let cBpm = 10 * bestT.dLog + 55 * excess * excess + bestT.pen
  if (opts.allowGenreBreak && cBpm > 1.85) cBpm = 1.85 // intentional echo-out genre reset ceiling

  // 2. Directed Camelot cost + natural ∅ + Drums-Stem ∅ Reset
  const harm = harmonicScore(from.camelot, to.camelot)
  let hBase = 0
  if (harm.tag === 'MATCH') hBase = 0
  else if (harm.tag === '+1 LIFT') hBase = 0.1
  else if (harm.tag === '-1 COOL') hBase = 0.16
  else if (harm.tag === 'REL') hBase = 0.2
  else if (harm.tag === '+2 BOOST') hBase = 0.38
  else if (harm.tag === 'DIAG') hBase = 0.52
  else if (harm.tag === '—') hBase = 0.35
  else hBase = 1.25

  const fpA = from.fingerprint
  const fpB = to.fingerprint
  const natNull = Math.max(fpA?.outroNull ?? 0, fpB?.introNull ?? 0)
  const hNatural = hBase * (1 - 0.72 * natNull)
  const stemCap = 0.62 // Drums-only stem ∅ loop resets key cleanly
  const canStemReset = !!(from.stems || to.stems) || true // user can separate stems anytime
  const usedStemNull = !harm.compatible && hNatural > stemCap && canStemReset
  const usedNaturalNull = !harm.compatible && !usedStemNull && natNull >= 0.45
  const cHarm = usedStemNull ? stemCap : hNatural

  // 3. Timbre (z-scored MFCC cosine distance)
  const za = zMfcc.get(from.id)
  const zb = zMfcc.get(to.id)
  const mfccSim = za && zb ? Math.round(cosineDot(za, zb) * 100) / 100 : null
  const cTimbre = mfccSim != null ? 0.55 * (0.5 * (1 - mfccSim)) : 0.22

  // 4. Groove & Swing compatibility
  const swingDiff = fpA && fpB ? Math.round(Math.abs(fpA.swing16 - fpB.swing16) * 1000) / 1000 : null
  const grooveSim = grooveSimilarity(fpA?.groove16, fpB?.groove16)
  const cGroove =
    (swingDiff != null ? 2.4 * swingDiff : 0.08) +
    (grooveSim != null ? 0.45 * (1 - grooveSim) : 0.1)

  // 5. Dynamic / Crest mismatch
  const cCrest = fpA && fpB ? Math.min(0.3, Math.abs(fpA.crestDb - fpB.crestDb) * 0.04) : 0

  const cost = Math.round((cBpm + cHarm + cTimbre + cGroove + cCrest) * 1000) / 1000

  // --- Intelligent Strategy Selection driven directly by the physics ---
  const outSubHot = (fpA?.outroSub ?? 0.6) >= 0.55
  const inSubHot = (fpB?.introSub ?? 0.5) >= 0.55
  const swingClash = (swingDiff ?? 0) >= 0.085
  const grooveClash = (grooveSim ?? 0.85) < 0.72
  const bigTempoJump = Math.abs(bestT.pct) > 4.8
  const dualSustainSub = (fpA?.subSustain ?? 0.2) >= 0.34 && (fpB?.subSustain ?? 0.2) >= 0.34
  const bothStems = !!(from.stems && to.stems)

  let strategy: AutoStrategy = 'BASS_SWAP'
  let bars: 4 | 8 = 8
  const reasons: string[] = []

  if (usedStemNull) {
    strategy = 'STEM_NULL_RESET'
    bars = 4
    reasons.push(`key ${from.camelot ?? '?'}→${to.camelot ?? '?'} bridged via 4B Drums-only ∅ loop`)
  } else if (bigTempoJump || swingClash || grooveClash) {
    strategy = 'HPF_ECHO'
    bars = 4
    if (swingClash) reasons.push(`swing clash Δ${swingDiff!.toFixed(2)}`)
    if (grooveClash) reasons.push('kick patterns clash')
    if (bigTempoJump) reasons.push(`ΔBPM ${bestT.pct.toFixed(1)}%`)
    reasons.push('4B HPF sweep + Echo exit')
  } else if (bothStems && harm.compatible && !usedNaturalNull) {
    strategy = 'STEM_VOCAL_BLEND'
    bars = 8
    reasons.push(`${harm.tag} + dual stems → VOX/OTH blend into BAS+DRM swap`)
  } else if (outSubHot && !inSubHot) {
    strategy = 'HPF_ECHO'
    bars = fpB && fpB.introNull >= 0.5 ? 8 : 4
    reasons.push('bassless incoming intro → HPF out old track on drop')
  } else if (!outSubHot && inSubHot) {
    strategy = 'LPF_IN'
    bars = 8
    reasons.push('quiet/melodic outro → LPF open new track in')
  } else if (dualSustainSub) {
    strategy = 'BASS_SWAP'
    bars = 4
    reasons.push('dual sustained sub → tight 4B hard bass swap')
  } else if (usedNaturalNull) {
    strategy = 'BASS_SWAP'
    bars = 8
    reasons.push(`natural ∅ drum intro/outro bridges ${from.camelot ?? '?'}→${to.camelot ?? '?'}`)
  } else {
    strategy = 'BASS_SWAP'
    bars = 8
    reasons.push(`${harm.tag} · smooth 8B phrase blend + center bass swap`)
  }

  return {
    cost,
    bpmDeltaPct: Math.round(bestT.pct * 10) / 10,
    halfDouble: bestT.tag,
    harmonicTag: harm.tag,
    harmonicCompatible: harm.compatible,
    mfccSim,
    swingDiff,
    grooveSim: grooveSim != null ? Math.round(grooveSim * 100) / 100 : null,
    usedNaturalNull,
    usedStemNull,
    strategy,
    bars,
    rationale: reasons.join(' · ')
  }
}

function targetCurve(arc: SetArc, idx: number, len: number): number {
  const x = len <= 1 ? 0.5 : idx / (len - 1)
  if (arc === 'climb') return 0.25 + 0.7 * x
  if (arc === 'festival') {
    // Two peaks around x=0.38 and x=0.82 with a mid breather
    const p1 = Math.exp(-Math.pow((x - 0.36) / 0.2, 2))
    const p2 = Math.exp(-Math.pow((x - 0.84) / 0.18, 2))
    return Math.min(0.98, 0.28 + 0.66 * Math.max(p1 * 0.9, p2))
  }
  // Default bell curve: warmup -> peak around 70% -> cooldown
  return 0.24 + 0.72 * Math.exp(-Math.pow((x - 0.68) / 0.34, 2))
}

/** Simple average-linkage agglomerative clustering on symmetric crate distances. */
function clusterCrate(tracks: readonly Track[], symCost: number[][]): { clusters: CrateCluster[]; bridges: string[] } {
  const n = tracks.length
  if (n === 0) return { clusters: [], bridges: [] }
  const targetK = Math.min(n, Math.max(1, Math.min(4, Math.round(Math.sqrt(n / 2)))))
  let groups: number[][] = Array.from({ length: n }, (_, i) => [i])

  while (groups.length > targetK) {
    let bestI = 0
    let bestJ = 1
    let bestD = Infinity
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        let sum = 0
        for (const a of groups[i]) for (const b of groups[j]) sum += symCost[a][b]
        const avg = sum / (groups[i].length * groups[j].length)
        if (avg < bestD) {
          bestD = avg
          bestI = i
          bestJ = j
        }
      }
    }
    if (bestD > 4.2) break
    groups[bestI] = [...groups[bestI], ...groups[bestJ]]
    groups.splice(bestJ, 1)
  }

  groups.sort((a, b) => {
    const ba = a.reduce((s, i) => s + (tracks[i].grid?.bpm ?? 120), 0) / a.length
    const bb = b.reduce((s, i) => s + (tracks[i].grid?.bpm ?? 120), 0) / b.length
    return ba - bb
  })

  const clusters: CrateCluster[] = groups.map((idxs, id) => {
    const ts = idxs.map((i) => tracks[i])
    const avgBpm = Math.round((ts.reduce((s, t) => s + (t.grid?.bpm ?? 120), 0) / ts.length) * 10) / 10
    const avgEnergy = Math.round((ts.reduce((s, t) => s + trackEnergy(t), 0) / ts.length) * 100) / 100
    const vibeWord = avgBpm < 105 ? 'Slow/Hip-Hop' : avgEnergy > 0.68 ? 'Peak' : avgBpm < 123 ? 'Warmup' : 'Main-Room'
    return { id, label: `${vibeWord} (~${Math.round(avgBpm)} BPM)`, tracks: ts, avgBpm, avgEnergy }
  })

  // Bridge score: lowest mean distance to tracks OUTSIDE its own cluster
  const clusterOf = new Int32Array(n)
  groups.forEach((g, ci) => g.forEach((ti) => (clusterOf[ti] = ci)))
  const bridgeScores: { id: string; score: number }[] = []
  if (groups.length >= 2) {
    for (let i = 0; i < n; i++) {
      let sum = 0
      let cnt = 0
      for (let j = 0; j < n; j++) {
        if (clusterOf[j] !== clusterOf[i]) {
          sum += symCost[i][j]
          cnt++
        }
      }
      if (cnt > 0) bridgeScores.push({ id: tracks[i].id, score: sum / cnt })
    }
    bridgeScores.sort((a, b) => a.score - b.score)
  }

  return { clusters, bridges: bridgeScores.slice(0, 3).map((b) => b.id) }
}

/**
 * Solve an optimal strictly-no-repeat DJ set path through the crate via
 * Beam Search (width=96) + 2-opt segment refinement.
 */
export function planSetPath(
  crateTracks: readonly Track[],
  opts: {
    arc?: SetArc
    length?: number
    openerId?: string
    allowGenreBreak?: boolean
    jitterSeed?: number
  } = {}
): PlannedSet {
  const arc = opts.arc ?? 'arc'
  const tracks = crateTracks.filter((t) => (t.grid?.bpm ?? 0) > 0)
  const n = tracks.length
  const k = Math.min(n, Math.max(2, opts.length ?? Math.min(12, n)))
  if (n === 0) {
    return { arc, steps: [], totalCost: 0, energyRmse: 0, clusters: [], bridgeTrackIds: [] }
  }

  const zMfcc = zScoreMfccs(tracks)
  const edges: EdgeEval[][] = Array.from({ length: n }, () => new Array<EdgeEval>(n))
  const sym: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))

  // Deterministic micro-jitter when user hits "ALT PATH" so they can explore alternate sets
  let rng = (opts.jitterSeed ?? 0) * 1664525 + 1013904223
  const nextRand = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0
    return (rng / 0xffffffff) * (opts.jitterSeed ? 0.28 : 0)
  }

  const jitter: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => nextRand()))

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      edges[i][j] = evaluateEdge(tracks[i], tracks[j], zMfcc, { allowGenreBreak: opts.allowGenreBreak })
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = 0.5 * (edges[i][j].cost + edges[j][i].cost)
      sym[i][j] = s
      sym[j][i] = s
    }
  }

  const { clusters, bridges } = clusterCrate(tracks, sym)
  // Crate-relative min-max energy normalization so set arcs span the crate's true dynamic range
  const rawEnergies = tracks.map((t) => trackEnergy(t))
  const minE = Math.min(...rawEnergies)
  const maxE = Math.max(...rawEnergies)
  const spanE = Math.max(0.15, maxE - minE)
  const energies = rawEnergies.map((e) => Math.round(((e - minE) / spanE) * 100) / 100)
  const targets = Array.from({ length: k }, (_, i) => targetCurve(arc, i, k))
  const lamU = 5.2
  // For CLIMB arc, also gently pull tempo upward from the crate's 20th to 95th percentile BPM
  const bpms = tracks.map((t) => t.grid?.bpm ?? 120)
  const sortedBpms = [...bpms].sort((a, b) => a - b)
  const bpmLo = sortedBpms[Math.floor(sortedBpms.length * 0.2)] ?? 118
  const bpmHi = sortedBpms[Math.min(sortedBpms.length - 1, Math.floor(sortedBpms.length * 0.95))] ?? 132
  const bpmStepPenalty = (idx: number, step: number): number => {
    if (arc !== 'climb') return 0
    const tgtBpm = bpmLo + (bpmHi - bpmLo) * (k <= 1 ? 0.5 : step / (k - 1))
    const d = Math.log2(bpms[idx] / Math.max(60, tgtBpm))
    return 180 * d * d
  }

  const openerIdx = opts.openerId ? tracks.findIndex((t) => t.id === opts.openerId) : -1
  const beamWidth = 96

  interface BeamNode {
    path: number[]
    visited: Set<number>
    obj: number
  }

  let beam: BeamNode[] = []
  if (openerIdx >= 0) {
    beam.push({
      path: [openerIdx],
      visited: new Set([openerIdx]),
      obj: lamU * Math.pow(energies[openerIdx] - targets[0], 2) + bpmStepPenalty(openerIdx, 0)
    })
  } else {
    for (let i = 0; i < n; i++) {
      beam.push({
        path: [i],
        visited: new Set([i]),
        obj:
          lamU * Math.pow(energies[i] - targets[0], 2) +
          bpmStepPenalty(i, 0) +
          (opts.jitterSeed ? nextRand() * 0.25 : 0)
      })
    }
    beam.sort((a, b) => a.obj - b.obj)
    beam = beam.slice(0, beamWidth)
  }

  for (let step = 1; step < k; step++) {
    const nextBeam: BeamNode[] = []
    const tE = targets[step]
    for (const node of beam) {
      const prev = node.path[node.path.length - 1]
      for (let j = 0; j < n; j++) {
        if (node.visited.has(j)) continue
        const stepCost =
          edges[prev][j].cost +
          jitter[prev][j] +
          lamU * Math.pow(energies[j] - tE, 2) +
          bpmStepPenalty(j, step)
        const v2 = new Set(node.visited)
        v2.add(j)
        nextBeam.push({ path: [...node.path, j], visited: v2, obj: node.obj + stepCost })
      }
    }
    nextBeam.sort((a, b) => a.obj - b.obj)
    const seen = new Set<string>()
    beam = []
    for (const cand of nextBeam) {
      const key = `${cand.path[cand.path.length - 1]}:${[...cand.visited].sort((a, b) => a - b).join(',')}`
      if (seen.has(key)) continue
      seen.add(key)
      beam.push(cand)
      if (beam.length >= beamWidth) break
    }
  }

  let bestPath = beam[0]?.path ?? [0]

  // 2-opt local polish (swaps, preserving opener if locked)
  const pathObj = (p: number[]): number => {
    let total = 0
    for (let i = 0; i < p.length; i++) {
      total += lamU * Math.pow(energies[p[i]] - targets[i], 2) + bpmStepPenalty(p[i], i)
      if (i > 0) total += edges[p[i - 1]][p[i]].cost
    }
    return total
  }
  const startLock = openerIdx >= 0 ? 1 : 0
  let bestObj = pathObj(bestPath)
  let improved = true
  let passes = 0
  while (improved && passes < 6) {
    improved = false
    passes++
    for (let i = startLock; i < bestPath.length - 1; i++) {
      for (let j = i + 1; j < bestPath.length; j++) {
        const cand = [...bestPath]
        const t = cand[i]; cand[i] = cand[j]; cand[j] = t
        const sc = pathObj(cand)
        if (sc + 1e-6 < bestObj) {
          bestPath = cand
          bestObj = sc
          improved = true
        }
      }
    }
  }

  let totalCost = 0
  let sqErr = 0
  const steps: PlannedStep[] = bestPath.map((idx, pos) => {
    const incomingEdge = pos > 0 ? edges[bestPath[pos - 1]][idx] : null
    if (incomingEdge) totalCost += incomingEdge.cost
    const e = energies[idx]
    sqErr += Math.pow(e - targets[pos], 2)
    return {
      track: tracks[idx],
      energy: e,
      targetEnergy: Math.round(targets[pos] * 100) / 100,
      incomingEdge
    }
  })

  return {
    arc,
    steps,
    totalCost: Math.round(totalCost * 100) / 100,
    energyRmse: Math.round(Math.sqrt(sqErr / Math.max(1, steps.length)) * 1000) / 1000,
    clusters,
    bridgeTrackIds: bridges
  }
}
