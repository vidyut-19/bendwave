import type { Track } from './deck'
import type { TrackSection } from './structure'
import { evaluateEdge, trackEnergy, type AutoStrategy } from './planner'

/**
 * Harmonic & Transition Co-Pilot ("Co-pilot, not autopilot"):
 *  - Camelot wheel harmonic scoring (match, ±1 lift/cool, relative maj/min, +2 boost)
 *  - Tempo compatibility (incl. half/double-time)
 *  - Vibe continuity (FLOW / LIFT / CHILL modes)
 *  - Top-5 Next-Up curation from the crate
 *  - Concrete 5-point Transition Recipe for any Outgoing → Incoming pair:
 *      1. Mix-out & Mix-in cues (bar + timestamp)
 *      2. Loop length (4B vs 8B vs straight phrase blend)
 *      3. Filter move (HPF out vs LPF in)
 *      4. Kick / Drums ownership (never clash two kicks!)
 *      5. Stems strategy + vocal-clash warning
 */

export type VibeMode = 'flow' | 'lift' | 'chill'

export interface HarmonicMatch {
  score: number // 0..100
  tag: string   // 'MATCH' | '+1 LIFT' | '-1 COOL' | 'REL' | '+2 BOOST' | 'DIAG' | 'CLASH' | '—'
  compatible: boolean
}

export interface NextPick {
  track: Track
  score: number // 0..100
  harmonic: HarmonicMatch
  /** percentage pitch shift needed on incoming track to match outgoing BPM */
  pitchPct: number
  halfDouble?: '½×' | '2×'
  vibeNote: string
  quickMove: string
}

export interface TransitionPlan {
  outName: string
  inName: string
  /** recommended cue point in seconds on incoming track */
  inCueSec: number
  inCueLabel: string
  outCueSec: number
  outCueLabel: string
  /** suggested loop length in beats (16 = 4 bars, 32 = 8 bars) or null for straight blend */
  loopBeats: number | null
  loopNote: string
  filterNote: string
  kickOwner: string
  stemNote: string
  vocalWarning: string | null
  harmonic: HarmonicMatch
  pitchPct: number
  /** intelligent auto-selected curve strategy & duration driven by the acoustic fingerprint */
  strategy: AutoStrategy
  bars: 4 | 8
  rationale: string
}

function parseCamelot(code?: string): { num: number; letter: 'A' | 'B' } | null {
  const m = /^(\d{1,2})([AB])$/i.exec(code ?? '')
  if (!m) return null
  const num = Number(m[1])
  if (num < 1 || num > 12) return null
  return { num, letter: m[2].toUpperCase() as 'A' | 'B' }
}

/** Circular signed distance on the 12-step Camelot wheel (-5..+6) */
function wheelDelta(from: number, to: number): number {
  let d = ((to - from) % 12 + 12) % 12
  if (d > 6) d -= 12
  return d
}

export function harmonicScore(fromCode?: string, toCode?: string): HarmonicMatch {
  const a = parseCamelot(fromCode)
  const b = parseCamelot(toCode)
  if (!a || !b) return { score: 55, tag: '—', compatible: true }

  const d = wheelDelta(a.num, b.num)
  const sameMode = a.letter === b.letter

  if (d === 0 && sameMode) return { score: 100, tag: 'MATCH', compatible: true }
  if (d === 1 && sameMode) return { score: 94, tag: '+1 LIFT', compatible: true }
  if (d === -1 && sameMode) return { score: 90, tag: '-1 COOL', compatible: true }
  if (d === 0 && !sameMode) return { score: 88, tag: 'REL', compatible: true }
  if (d === 2 && sameMode) return { score: 74, tag: '+2 BOOST', compatible: true }
  if (Math.abs(d) === 1 && !sameMode) return { score: 66, tag: 'DIAG', compatible: true }
  if (d === -2 && sameMode) return { score: 60, tag: '-2 DROP', compatible: false }
  return { score: 18, tag: 'CLASH', compatible: false }
}

export function tempoMatch(srcBpm: number, dstBpm: number): {
  score: number
  pitchPct: number
  halfDouble?: '½×' | '2×'
} {
  if (srcBpm <= 0 || dstBpm <= 0) return { score: 50, pitchPct: 0 }
  const options: { eff: number; tag?: '½×' | '2×'; penalty: number }[] = [
    { eff: dstBpm, penalty: 0 },
    { eff: dstBpm * 2, tag: '2×', penalty: 8 },
    { eff: dstBpm * 0.5, tag: '½×', penalty: 8 }
  ]
  let best = { score: 0, pitchPct: 0, halfDouble: undefined as '½×' | '2×' | undefined }
  for (const o of options) {
    const pct = ((srcBpm - o.eff) / o.eff) * 100
    const abs = Math.abs(pct)
    let sc = 0
    if (abs <= 3) sc = 100 - abs * 2
    else if (abs <= 6) sc = 94 - (abs - 3) * 6
    else if (abs <= 9) sc = 76 - (abs - 6) * 10
    else if (abs <= 14) sc = 46 - (abs - 9) * 7
    else sc = Math.max(0, 10 - (abs - 14))
    sc = Math.max(0, sc - o.penalty)
    if (sc > best.score) best = { score: sc, pitchPct: Math.round(pct * 10) / 10, halfDouble: o.tag }
  }
  return best
}

function fmtMinSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function findSectionAt(sections: TrackSection[] | undefined, sec: number): TrackSection | null {
  if (!sections?.length) return null
  for (const s of sections) {
    if (sec >= s.tStart - 0.1 && sec < s.tEnd) return s
  }
  return sections[sections.length - 1]
}

/**
 * Compute a concrete 5-point DJ transition recipe from outgoing track/position
 * into incoming track.
 */
export function planTransition(
  outTrack: Track,
  outPosSec: number,
  outEffBpm: number,
  inTrack: Track,
  outHasStems: boolean,
  inHasStems: boolean
): TransitionPlan {
  const outBpm = outEffBpm > 0 ? outEffBpm : outTrack.grid?.bpm ?? 120
  const inBpm = inTrack.grid?.bpm ?? 120
  const harm = harmonicScore(outTrack.camelot, inTrack.camelot)
  const tm = tempoMatch(outBpm, inBpm)

  const outSecs = outTrack.sections ?? []
  const inSecs = inTrack.sections ?? []
  const outCur = findSectionAt(outSecs, outPosSec)

  // 1. Pick Outgoing mix-out anchor: next BREAK/OUTRO/GROOVE after playhead, or 8 bars before end of current DROP
  const outBarDur = (60 / (outTrack.grid?.bpm || 120)) * (outTrack.grid?.beatsPerBar ?? 4)
  let outAnchorSec = outPosSec
  let outAnchorLabel = 'NOW'
  const upcomingOut = outSecs.find((s) => s.tStart > outPosSec + 2 && (s.label === 'BREAK' || s.label === 'OUTRO' || s.label === 'GROOVE'))
  if (upcomingOut) {
    outAnchorSec = upcomingOut.tStart
    outAnchorLabel = `${upcomingOut.label} B${upcomingOut.barStart + 1} (${fmtMinSec(upcomingOut.tStart)})`
  } else if (outCur && outCur.tEnd - outPosSec > outBarDur * 8) {
    outAnchorSec = Math.max(outPosSec, outCur.tEnd - outBarDur * 8)
    outAnchorLabel = `last 8B of ${outCur.label} (${fmtMinSec(outAnchorSec)})`
  }

  // 2. Pick Incoming mix-in cue: INTRO start if available, else 8 bars before first DROP, else Bar 1
  const inBarDur = (60 / inBpm) * (inTrack.grid?.beatsPerBar ?? 4)
  const inFirstDrop = inSecs.find((s) => s.label === 'DROP')
  const inIntro = inSecs[0] && inSecs[0].label === 'INTRO' ? inSecs[0] : null
  const inIntroBars = inIntro ? inIntro.barEnd - inIntro.barStart : 0

  let inCueSec = inTrack.grid?.offset ?? 0
  let inCueLabel = `B1 (${fmtMinSec(inCueSec)})`
  let inSection: TrackSection | null = inSecs[0] ?? null

  if (inIntro && inIntroBars >= 4) {
    inCueSec = inIntro.tStart
    inCueLabel = `INTRO B${inIntro.barStart + 1} (${inIntroBars}B)`
    inSection = inIntro
  } else if (inFirstDrop && inFirstDrop.barStart >= 8) {
    const startBar = Math.max(0, inFirstDrop.barStart - 8)
    inCueSec = Math.max(0, (inTrack.grid?.offset ?? 0) + startBar * inBarDur)
    inCueLabel = `8B pre-DROP (B${startBar + 1} · ${fmtMinSec(inCueSec)})`
    inSection = findSectionAt(inSecs, inCueSec)
  } else if (inFirstDrop) {
    inCueSec = inFirstDrop.tStart
    inCueLabel = `DROP B${inFirstDrop.barStart + 1} (${fmtMinSec(inCueSec)})`
    inSection = inFirstDrop
  }

  // 3. Loop recommendation: 4-bar vs 8-bar vs straight phrase blend
  let loopBeats: number | null = null
  let loopNote = '8-bar phrase blend (no loop needed)'
  if (!inIntro || inIntroBars < 6) {
    loopBeats = 16 // 4-bar loop (4 beats × 4 bars; our pad max is 8 beats = 2 bars, or 4-bar blend)
    loopNote = inIntroBars >= 4
      ? '4B loop on incoming intro (extends runway)'
      : 'Loop outgoing groove (4–8 beat roll) — incoming hits fast'
  } else if (inIntroBars >= 8 && inIntroBars <= 16) {
    loopBeats = null
    loopNote = `${inIntroBars}B intro — line up drop-for-drop (no loop)`
  } else {
    loopBeats = 32
    loopNote = `Long ${inIntroBars}B intro — start 8B before drop or loop 8B`
  }

  // 4. Kick / Drums owner + 5. Filter move
  const outBassHot = (outCur?.bass ?? 0.7) >= 0.55
  const inBassHot = (inSection?.bass ?? 0.4) >= 0.55
  let kickOwner = ''
  let filterNote = ''

  if (outBassHot && inBassHot) {
    kickOwner = 'CLASH RISK: keep outgoing kick, cut incoming LOW → swap on Drop'
    filterNote = 'HPF out old track as new bass drops in'
  } else if (outBassHot && !inBassHot) {
    kickOwner = 'OLD track owns kick through new intro/build → cut old on Drop'
    filterNote = 'Sweep HPF up on old track (last 4B) + Echo Out'
  } else if (!outBassHot && inBassHot) {
    kickOwner = 'NEW track owns kick immediately (old is in break/outro)'
    filterNote = 'LPF open new track in smoothly, fade old VOL down'
  } else {
    kickOwner = 'Both low-bass — clean atmospheric blend into next drop'
    filterNote = 'Gentle LPF/HPF crossover, ride crossfader'
  }

  // 5. Stems strategy + vocal clash warning
  let stemNote = 'EQ blend (cut incoming LOW, swap mids on phrase)'
  if (outHasStems && inHasStems) {
    stemNote = 'STEM BLEND: keep old DRM+BAS, bring in new OTH+VOX → swap DRM+BAS on drop'
  } else if (outHasStems) {
    stemNote = 'STEMS (out): mute old VOX first, ride old DRM under new intro'
  } else if (inHasStems) {
    stemNote = 'STEMS (in): tease new VOX/OTH solo first, drop BAS+DRM on Bar 1'
  }

  const vocalWarning =
    outCur?.hasVocals && inSection?.hasVocals
      ? 'VOX CLASH: both sections have vocals — mute one VOX stem or wait for instrumental'
      : null

  // Compute intelligent auto-transition curve strategy from full acoustic fingerprints
  const edge = evaluateEdge(outTrack, inTrack, new Map())
  let strategy: AutoStrategy = edge.strategy
  let bars: 4 | 8 = edge.bars
  let rationale = edge.rationale
  if (vocalWarning && outHasStems && inHasStems) {
    strategy = 'STEM_VOCAL_BLEND'
    bars = 8
    rationale = 'vocal clash detected — strips outgoing VOX immediately, swaps BAS+DRM on bar 5'
  } else if (!outHasStems && strategy === 'STEM_NULL_RESET') {
    strategy = 'HPF_ECHO'
    rationale = 'key clash without stems — 4B HPF sweep + Echo tail (separate stems to unlock ∅ loop)'
  }

  return {
    outName: outTrack.name,
    inName: inTrack.name,
    inCueSec,
    inCueLabel,
    outCueSec: outAnchorSec,
    outCueLabel: outAnchorLabel,
    loopBeats,
    loopNote,
    filterNote,
    kickOwner,
    stemNote,
    vocalWarning,
    harmonic: harm,
    pitchPct: tm.pitchPct,
    strategy,
    bars,
    rationale
  }
}

/**
 * Rank the top N next tracks from the crate for the currently active deck.
 */
export function recommendNext(
  srcTrack: Track,
  srcEffBpm: number,
  crateTracks: readonly Track[],
  excludeIds: Set<string>,
  vibeMode: VibeMode = 'flow',
  limit = 5
): NextPick[] {
  const srcBpm = srcEffBpm > 0 ? srcEffBpm : srcTrack.grid?.bpm ?? 0
  const srcVibe = srcTrack.vibe

  const scored: NextPick[] = []
  for (const t of crateTracks) {
    if (excludeIds.has(t.id) || t.id === srcTrack.id) continue
    const harm = harmonicScore(srcTrack.camelot, t.camelot)
    const tm = tempoMatch(srcBpm, t.grid?.bpm ?? 0)

    // Vibe score (0..100) using loudness-normalized danceEnergy + swing compatibility
    let vibeScore = 70
    let vibeNote = 'steady'
    const eSrc = trackEnergy(srcTrack)
    const eDst = trackEnergy(t)
    const dE = eDst - eSrc
    const dSw =
      srcTrack.fingerprint && t.fingerprint
        ? Math.abs(srcTrack.fingerprint.swing16 - t.fingerprint.swing16)
        : 0
    if (srcVibe && t.vibe) {
      const dB = Math.abs(t.vibe.bass - srcVibe.bass)
      const dBr = Math.abs(t.vibe.brightness - srcVibe.brightness)
      if (vibeMode === 'flow') {
        vibeScore = Math.max(0, 100 - (Math.abs(dE) * 85 + dB * 30 + dBr * 25 + dSw * 140))
        vibeNote = Math.abs(dE) < 0.12 ? 'vibe match' : dE > 0 ? 'slight lift' : 'slight dip'
      } else if (vibeMode === 'lift') {
        const target = 0.16
        vibeScore = Math.max(0, 100 - Math.abs(dE - target) * 150 - dSw * 120)
        vibeNote = dE > 0.05 ? 'energy lift' : 'holds energy'
      } else {
        const target = -0.16
        vibeScore = Math.max(0, 100 - Math.abs(dE - target) * 150 - dSw * 120)
        vibeNote = dE < -0.05 ? 'cool down' : 'steady groove'
      }
    }

    // Weighted total: Tempo (45%) + Harmonic (38%) + Vibe (17%)
    const total = Math.round(tm.score * 0.45 + harm.score * 0.38 + vibeScore * 0.17)

    // Compact 1-line mix hint
    const intro = t.sections?.[0]?.label === 'INTRO' ? t.sections[0] : null
    const introBars = intro ? intro.barEnd - intro.barStart : 0
    const quickMove = introBars >= 8
      ? `${introBars}B intro · HPF out`
      : introBars >= 4
        ? `${introBars}B intro · 4B loop`
        : 'hits fast · swap bass'

    scored.push({
      track: t,
      score: total,
      harmonic: harm,
      pitchPct: tm.pitchPct,
      halfDouble: tm.halfDouble,
      vibeNote,
      quickMove
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
