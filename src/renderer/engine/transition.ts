import type { DJEngine } from './engine'
import type { Deck } from './deck'
import type { AutoStrategy } from './planner'

/**
 * Automated Transition Curves Engine (Spotify Mix–style envelopes + Stems + Live Override).
 *
 * Evaluates declarative curves over normalized progress u ∈ [0, 1] across a
 * chosen bar duration (4B / 8B) and drives real deck parameters live:
 *   - Crossfader (equal-power blend)
 *   - Outgoing & Incoming EQ Low (Center Bass Swap)
 *   - Outgoing & Incoming Filter (HPF Out / LPF In / Cross-Filter)
 *   - Outgoing Echo Out tail on exit
 *   - 4-Stem automation (Drums-only ∅ Reset & Stem Vocal Blend!)
 *
 * Touch-to-Override: if the DJ grabs any fader, filter, EQ, or stem slider
 * mid-transition, that parameter yields immediately to manual control.
 */

export interface TransitionPoint {
  /** crossfader 0 (full out) -> 1 (full in) */
  xfade: number
  /** EQ low in dB (-26..0) */
  outLowDb: number
  inLowDb: number
  /** DJ filter (-1 LP .. 0 flat .. +1 HP) */
  outFilter: number
  inFilter: number
  /** momentary echo-out on outgoing deck */
  outEcho: boolean
  /** optional 4-stem gains [drums, bass, other, vocals] (0..1) */
  outStems?: [number, number, number, number]
  inStems?: [number, number, number, number]
}

export const STRATEGY_META: Record<AutoStrategy, { label: string; short: string }> = {
  BASS_SWAP:        { label: 'Center Bass Swap',     short: 'BASS SWAP' },
  HPF_ECHO:         { label: 'HPF Out + Echo Tail',  short: 'HPF + ECHO' },
  LPF_IN:           { label: 'LPF Open In',          short: 'LPF IN' },
  CROSS_FILTER:     { label: 'HPF In / LPF Out',     short: 'X-FILTER' },
  STEM_NULL_RESET:  { label: 'Drums-Only ∅ Reset',   short: 'STEM ∅' },
  STEM_VOCAL_BLEND: { label: 'Stem Vocal/Bass Swap', short: 'STEM BLEND' }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / Math.max(1e-6, b - a))
  return t * t * (3 - 2 * t)
}

/** Pure envelope evaluator at normalized progress u ∈ [0, 1]. */
export function evalTransitionCurve(strategy: AutoStrategy, u: number): TransitionPoint {
  const t = clamp01(u)
  switch (strategy) {
    case 'BASS_SWAP': {
      // Smooth equal-power crossfade; incoming bass held at -26dB until midpoint, then crisp swap!
      const swap = smoothstep(0.46, 0.54, t)
      return {
        xfade: smoothstep(0.05, 0.95, t),
        outLowDb: -26 * swap,
        inLowDb: -26 * (1 - swap),
        outFilter: 0,
        inFilter: 0,
        outEcho: false
      }
    }
    case 'HPF_ECHO': {
      // Sweep outgoing HPF up cleanly, trigger Echo Out on last 25% while incoming takes over
      const hp = smoothstep(0.15, 0.9, t) * 0.68
      return {
        xfade: smoothstep(0.08, 0.88, t),
        outLowDb: 0,
        inLowDb: -18 * (1 - smoothstep(0.35, 0.52, t)),
        outFilter: hp,
        inFilter: 0,
        outEcho: t >= 0.72 && t < 0.96
      }
    }
    case 'LPF_IN': {
      // Open incoming track from muffled LP (-0.72) to full brightness (0), swap bass at 50%
      const open = smoothstep(0.05, 0.65, t)
      const swap = smoothstep(0.45, 0.55, t)
      return {
        xfade: smoothstep(0.05, 0.95, t),
        outLowDb: -24 * swap,
        inLowDb: -20 * (1 - swap),
        outFilter: smoothstep(0.55, 0.98, t) * 0.35,
        inFilter: -0.72 * (1 - open),
        outEcho: false
      }
    }
    case 'CROSS_FILTER': {
      // Classic Spotify Mix "High pass filter in, low pass filter out"
      return {
        xfade: smoothstep(0.05, 0.95, t),
        outLowDb: 0,
        inLowDb: 0,
        outFilter: -0.78 * smoothstep(0.1, 0.95, t),
        inFilter: 0.72 * (1 - smoothstep(0.05, 0.85, t)),
        outEcho: false
      }
    }
    case 'STEM_NULL_RESET': {
      // Step onto null node ∅: strip outgoing BAS+OTH+VOX early (drums-only groove), bring incoming in cleanly!
      const strip = smoothstep(0.0, 0.18, t)
      const dropDrm = smoothstep(0.68, 0.92, t)
      const inFull = smoothstep(0.2, 0.75, t)
      return {
        xfade: smoothstep(0.12, 0.92, t),
        outLowDb: -22 * smoothstep(0.5, 0.7, t),
        inLowDb: -16 * (1 - smoothstep(0.45, 0.6, t)),
        outFilter: 0,
        inFilter: 0,
        outEcho: false,
        outStems: [1 - dropDrm, 1 - strip, 1 - strip, 1 - strip],
        inStems: [inFull, smoothstep(0.45, 0.65, t), inFull, inFull]
      }
    }
    case 'STEM_VOCAL_BLEND': {
      // Strip outgoing VOX immediately, tease incoming VOX+OTH over outgoing DRM+BAS, swap DRM+BAS at midpoint!
      const voxOut = smoothstep(0.0, 0.16, t)
      const swap = smoothstep(0.46, 0.56, t)
      const inTop = smoothstep(0.06, 0.42, t)
      return {
        xfade: smoothstep(0.04, 0.96, t),
        outLowDb: 0,
        inLowDb: 0,
        outFilter: 0,
        inFilter: 0,
        outEcho: false,
        outStems: [1 - swap, 1 - swap, 1 - smoothstep(0.5, 0.92, t), 1 - voxOut],
        inStems: [swap, swap, inTop, inTop]
      }
    }
  }
}

export interface ActiveTransition {
  strategy: AutoStrategy
  bars: number
  outDeck: Deck
  inDeck: Deck
  startTime: number
  durationSec: number
  /** normalized 0..1 progress */
  progress: number
  /** params touched manually by the user are surrendered immediately */
  overridden: Set<'xfade' | 'outFilter' | 'inFilter' | 'outEq' | 'inEq' | 'outStems' | 'inStems'>
  echoEngaged: boolean
  loopedOut: boolean
}

export class TransitionRunner {
  active: ActiveTransition | null = null
  onFinish?: (msg: string) => void
  onStemGain?: (deck: Deck, i: number, v: number) => void
  onFilterChanged?: (deck: Deck, v: number) => void

  constructor(private engine: DJEngine) {}

  get isRunning(): boolean {
    return this.active !== null
  }

  /** Yield a specific control to the DJ the moment they touch it. */
  override(param: 'xfade' | 'outFilter' | 'inFilter' | 'outEq' | 'inEq' | 'outStems' | 'inStems'): void {
    this.active?.overridden.add(param)
  }

  start(
    outDeck: Deck,
    inDeck: Deck,
    strategy: AutoStrategy,
    bars: number,
    inCueSec?: number
  ): { ok: boolean; error?: string } {
    if (!outDeck.hasAudio || !inDeck.hasAudio) {
      return { ok: false, error: 'need tracks loaded on both decks' }
    }
    this.cancel(false)

    // Align incoming deck to cue & beat-sync onto outgoing deck
    if (inCueSec != null && !inDeck.playing) inDeck.seek(inCueSec)
    inDeck.syncTo(outDeck)
    if (!outDeck.playing) outDeck.play()
    if (!inDeck.playing) inDeck.play()

    // For Drums-only ∅ Reset, latch a 4-beat loop on outgoing deck if not already looping
    let loopedOut = false
    if (strategy === 'STEM_NULL_RESET' && !outDeck.activeLoop) {
      outDeck.loopLatch = true
      outDeck.loopBeats(4)
      loopedOut = true
    }

    const bpm = outDeck.effectiveBpm ?? outDeck.track?.grid?.bpm ?? 120
    const bpb = outDeck.track?.grid?.beatsPerBar ?? 4
    const durationSec = Math.max(2, (bars * bpb * 60) / Math.max(60, bpm))

    this.active = {
      strategy,
      bars,
      outDeck,
      inDeck,
      startTime: performance.now(),
      durationSec,
      progress: 0,
      overridden: new Set(),
      echoEngaged: false,
      loopedOut
    }
    return { ok: true }
  }

  cancel(restore = true): void {
    const a = this.active
    if (!a) return
    this.active = null
    if (a.echoEngaged) a.outDeck.fx.echoOutRelease()
    if (a.loopedOut) a.outDeck.exitLoop()
    if (restore) {
      a.outDeck.setFilter(0)
      a.inDeck.setFilter(0)
      a.outDeck.setEqBand('low', 0)
      a.inDeck.setEqBand('low', 0)
      this.onFilterChanged?.(a.outDeck, 0)
      this.onFilterChanged?.(a.inDeck, 0)
    }
  }

  /** Step live automation from rAF tick(). */
  update(): void {
    const a = this.active
    if (!a) return
    const elapsed = (performance.now() - a.startTime) / 1000
    const u = clamp01(elapsed / a.durationSec)
    a.progress = u
    const pt = evalTransitionCurve(a.strategy, u)

    const outIsA = a.outDeck.id === 'A'
    if (!a.overridden.has('xfade')) {
      this.engine.mixer.setCrossfade(outIsA ? pt.xfade : 1 - pt.xfade)
    }
    if (!a.overridden.has('outEq')) a.outDeck.setEqBand('low', pt.outLowDb)
    if (!a.overridden.has('inEq')) a.inDeck.setEqBand('low', pt.inLowDb)
    if (!a.overridden.has('outFilter')) {
      a.outDeck.setFilter(pt.outFilter)
      this.onFilterChanged?.(a.outDeck, pt.outFilter)
    }
    if (!a.overridden.has('inFilter')) {
      a.inDeck.setFilter(pt.inFilter)
      this.onFilterChanged?.(a.inDeck, pt.inFilter)
    }

    if (pt.outEcho && !a.echoEngaged) {
      a.echoEngaged = true
      a.outDeck.fx.echoOutEngage()
    } else if (!pt.outEcho && a.echoEngaged) {
      a.echoEngaged = false
      a.outDeck.fx.echoOutRelease()
    }

    if (pt.outStems && a.outDeck.stemCount === 4 && !a.overridden.has('outStems')) {
      for (let i = 0; i < 4; i++) this.onStemGain?.(a.outDeck, i, pt.outStems[i])
    }
    if (pt.inStems && a.inDeck.stemCount === 4 && !a.overridden.has('inStems')) {
      for (let i = 0; i < 4; i++) this.onStemGain?.(a.inDeck, i, pt.inStems[i])
    }

    if (u >= 1) {
      // Transition complete: clean up outgoing deck & restore neutral filters/EQ on incoming
      if (a.echoEngaged) a.outDeck.fx.echoOutRelease()
      if (a.loopedOut) a.outDeck.exitLoop()
      a.outDeck.pause()
      a.outDeck.setFilter(0)
      a.outDeck.setEqBand('low', 0)
      a.inDeck.setFilter(0)
      a.inDeck.setEqBand('low', 0)
      this.onFilterChanged?.(a.outDeck, 0)
      this.onFilterChanged?.(a.inDeck, 0)
      if (a.outDeck.stemCount === 4) {
        for (let i = 0; i < 4; i++) this.onStemGain?.(a.outDeck, i, 1)
      }
      if (a.inDeck.stemCount === 4) {
        for (let i = 0; i < 4; i++) this.onStemGain?.(a.inDeck, i, 1)
      }
      const msg = `transition complete (${STRATEGY_META[a.strategy].short} · ${a.bars}B) → Deck ${a.inDeck.id} live`
      this.active = null
      this.onFinish?.(msg)
    }
  }
}

/**
 * Draw Spotify-Mix–inspired transition envelope curves onto a compact canvas:
 *   Orange = Outgoing Volume, Blue = Incoming Volume, Crimson = Bass Swap,
 *   Violet = Filter Sweep, plus live progress playhead while running.
 */
export function drawTransitionCurves(
  canvas: HTMLCanvasElement,
  strategy: AutoStrategy,
  bars: number,
  progress: number | null
): void {
  const dpr = window.devicePixelRatio || 1
  const r = canvas.getBoundingClientRect()
  const w = Math.max(1, Math.floor(r.width * dpr))
  const h = Math.max(1, Math.floor(r.height * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const g = canvas.getContext('2d')!
  const light = document.documentElement.dataset.theme !== 'ko2-dark'

  g.fillStyle = light ? '#ffffff' : '#090a0d'
  g.fillRect(0, 0, w, h)

  const padX = Math.round(4 * dpr)
  const padY = Math.round(4 * dpr)
  const iw = w - padX * 2
  const ih = h - padY * 2

  // Bar grid lines
  g.strokeStyle = light ? 'rgba(15,14,18,0.1)' : 'rgba(255,255,255,0.08)'
  for (let b = 0; b <= bars; b++) {
    const x = Math.round(padX + (b / bars) * iw) + 0.5
    g.beginPath()
    g.moveTo(x, padY)
    g.lineTo(x, h - padY)
    g.stroke()
  }

  const plot = (color: string, width: number, dashed: boolean, fn: (u: number) => number) => {
    g.strokeStyle = color
    g.lineWidth = width * dpr
    g.setLineDash(dashed ? [3 * dpr, 2 * dpr] : [])
    g.beginPath()
    const steps = 64
    for (let i = 0; i <= steps; i++) {
      const u = i / steps
      const y = padY + (1 - clamp01(fn(u))) * ih
      const x = padX + u * iw
      if (i === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.stroke()
    g.setLineDash([])
    g.lineWidth = 1
  }

  // Outgoing vol (orange) & Incoming vol (blue)
  plot('#f05a24', 1.6, false, (u) => Math.cos((evalTransitionCurve(strategy, u).xfade * Math.PI) / 2))
  plot('#0071bb', 1.6, false, (u) => Math.sin((evalTransitionCurve(strategy, u).xfade * Math.PI) / 2))
  // Outgoing Bass (dashed crimson) & Filter sweep (violet)
  plot('#e11d48', 1.2, true, (u) => {
    const pt = evalTransitionCurve(strategy, u)
    return pt.outStems ? pt.outStems[1] : 1 + pt.outLowDb / 26
  })
  plot('#7c3aed', 1.2, false, (u) => {
    const pt = evalTransitionCurve(strategy, u)
    return 0.5 + 0.5 * (pt.outFilter !== 0 ? pt.outFilter : pt.inFilter)
  })

  // Live progress playhead
  if (progress != null) {
    const px = Math.round(padX + clamp01(progress) * iw) + 0.5
    g.strokeStyle = light ? '#0f0e12' : '#ffffff'
    g.lineWidth = 1.6 * dpr
    g.beginPath()
    g.moveTo(px, 0)
    g.lineTo(px, h)
    g.stroke()
    g.lineWidth = 1
  }
}
