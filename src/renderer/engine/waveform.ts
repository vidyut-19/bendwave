import type { Deck } from './deck'
import { SECTION_COLORS, type TrackSection } from './structure'

export const HC_COLORS = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6'] as const
export const CUE_COLOR = '#fbbf24'

/** Order matches STEM_ORDER: ['drums', 'bass', 'other', 'vocals'] */
export const STEM_META = [
  { key: 'drums', short: 'DRM', label: 'DRUMS', color: '#f59e0b', rgb: [245, 158, 11] as const },
  { key: 'bass', short: 'BAS', label: 'BASS', color: '#f43f5e', rgb: [244, 63, 94] as const },
  { key: 'other', short: 'OTH', label: 'OTHER', color: '#06b6d4', rgb: [6, 182, 212] as const },
  { key: 'vocals', short: 'VOX', label: 'VOCALS', color: '#c084fc', rgb: [192, 132, 252] as const }
] as const

export const BAND_META = [
  { short: 'LOW', color: '#f43f5e', rgb: [244, 63, 94] as const },
  { short: 'MID', color: '#22c55e', rgb: [34, 197, 94] as const },
  { short: 'HI', color: '#38bdf8', rgb: [56, 189, 248] as const }
] as const

const CAMELOT_COLORS: Record<number, string> = {
  1: '#34d399',
  2: '#4ade80',
  3: '#a3e635',
  4: '#facc15',
  5: '#fbbf24',
  6: '#fb923c',
  7: '#f87171',
  8: '#f472b6',
  9: '#e879f9',
  10: '#a78bfa',
  11: '#60a5fa',
  12: '#22d3ee'
}

export function camelotColor(code?: string): string | null {
  const m = /^(\d{1,2})[AB]$/i.exec(code ?? '')
  if (!m) return null
  return CAMELOT_COLORS[Number(m[1])] ?? null
}

export type WaveformMode = 'rgb' | 'bands' | 'stems'

const PLAYHEAD_FRAC = 0.25
const PEAK_BUCKET = 512

interface PeakPyramid {
  peaks: Float32Array[]
  rms: Float32Array[]
  pps: number
  duration: number
}

interface FreqPyramid {
  peak: Float32Array[]
  rms: Float32Array[]
  lo: Float32Array[]
  mid: Float32Array[]
  hi: Float32Array[]
  pps: number
  duration: number
}

function buildMipLevels(base: Float32Array, mode: 'max' | 'avg' = 'max'): Float32Array[] {
  const levels: Float32Array[] = [base]
  while (levels[levels.length - 1].length > 256) {
    const prev = levels[levels.length - 1]
    const next = new Float32Array(Math.ceil(prev.length / 4))
    for (let i = 0; i < next.length; i++) {
      const st = i * 4
      const en = Math.min(prev.length, st + 4)
      if (mode === 'avg') {
        let acc = 0
        for (let j = st; j < en; j++) acc += prev[j]
        next[i] = acc / Math.max(1, en - st)
      } else {
        let m = 0
        for (let j = st; j < en; j++) if (prev[j] > m) m = prev[j]
        next[i] = m
      }
    }
    levels.push(next)
  }
  return levels
}

function buildPeakPyramid(buffer: AudioBuffer): PeakPyramid {
  const n = buffer.length
  const buckets = Math.ceil(n / PEAK_BUCKET)
  const peaks = new Float32Array(buckets)
  const rmsArr = new Float32Array(buckets)
  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null

  for (let b = 0; b < buckets; b++) {
    let m = 0
    let acc = 0
    const st = b * PEAK_BUCKET
    const en = Math.min(n, st + PEAK_BUCKET)
    const len = Math.max(1, en - st)
    for (let i = st; i < en; i++) {
      const v = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i]
      const av = v < 0 ? -v : v
      if (av > m) m = av
      acc += v * v
    }
    peaks[b] = Math.min(1, m)
    rmsArr[b] = Math.min(1, Math.sqrt(acc / len) * 1.45)
  }
  return {
    peaks: buildMipLevels(peaks, 'max'),
    rms: buildMipLevels(rmsArr, 'avg'),
    pps: buffer.sampleRate / PEAK_BUCKET,
    duration: buffer.duration
  }
}

/**
 * Single-pass 3-band spectral extractor (low <250Hz, mid 250-3.2kHz, high >3.2kHz)
 * with clamped peaks (prevents hot MP3 >1.0 intersample clipping) AND RMS body
 * levels so intros/breakdowns vs drops stand out cleanly visually.
 */
function buildFreqPyramid(buffer: AudioBuffer): FreqPyramid {
  const n = buffer.length
  const sr = buffer.sampleRate
  const buckets = Math.ceil(n / PEAK_BUCKET)
  const peak = new Float32Array(buckets)
  const rms = new Float32Array(buckets)
  const lo = new Float32Array(buckets)
  const mid = new Float32Array(buckets)
  const hi = new Float32Array(buckets)

  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null

  const stride = 2
  const effSr = sr / stride
  const aLo = 1 - Math.exp((-2 * Math.PI * 250) / effSr)
  const aHi = 1 - Math.exp((-2 * Math.PI * 3200) / effSr)
  let lpLo = 0
  let lpHi = 0

  for (let b = 0; b < buckets; b++) {
    const st = b * PEAK_BUCKET
    const en = Math.min(n, st + PEAK_BUCKET)
    let mAmp = 0
    let sAmp = 0
    let sLo = 0
    let sMid = 0
    let sHi = 0
    let cnt = 0
    for (let i = st; i < en; i += stride) {
      const x = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i]
      const ax = x < 0 ? -x : x
      if (ax > mAmp) mAmp = ax
      lpLo += aLo * (x - lpLo)
      lpHi += aHi * (x - lpHi)
      const vLo = lpLo
      const vMid = lpHi - lpLo
      const vHi = x - lpHi
      sAmp += x * x
      sLo += vLo * vLo
      sMid += vMid * vMid
      sHi += vHi * vHi
      cnt++
    }
    const inv = 1 / Math.max(1, cnt)
    peak[b] = Math.min(1, mAmp)
    rms[b] = Math.min(1, Math.sqrt(sAmp * inv) * 1.55)
    // RMS-weighted bands (no single-sample spike flattening!)
    lo[b] = Math.min(1, Math.sqrt(sLo * inv) * 2.1)
    mid[b] = Math.min(1, Math.sqrt(sMid * inv) * 2.5)
    hi[b] = Math.min(1, Math.sqrt(sHi * inv) * 4.2)
  }

  return {
    peak: buildMipLevels(peak, 'max'),
    rms: buildMipLevels(rms, 'avg'),
    lo: buildMipLevels(lo, 'avg'),
    mid: buildMipLevels(mid, 'avg'),
    hi: buildMipLevels(hi, 'avg'),
    pps: sr / PEAK_BUCKET,
    duration: buffer.duration
  }
}

function pickMip(levels: Float32Array[], basePps: number, secPerPx: number): { arr: Float32Array; pps: number; idx: number } {
  const bucketsPerPx = secPerPx * basePps
  let idx = 0
  while (idx < levels.length - 1 && bucketsPerPx / Math.pow(4, idx) > 4) idx++
  return { arr: levels[idx], pps: basePps / Math.pow(4, idx), idx }
}

function sampleRange(arr: Float32Array, pps: number, ta: number, tb: number, mode: 'max' | 'avg' = 'max'): number {
  const len = arr.length
  if (tb < 0 || ta > len / pps) return 0
  const i0 = Math.max(0, Math.floor(ta * pps))
  const i1 = Math.min(len, Math.ceil(tb * pps))
  if (i1 <= i0) return 0
  if (mode === 'avg') {
    let acc = 0
    for (let i = i0; i < i1; i++) acc += arr[i]
    return acc / (i1 - i0)
  }
  let m = 0
  for (let i = i0; i < i1; i++) if (arr[i] > m) m = arr[i]
  return m
}

function freqRgb(lo: number, mid: number, hi: number): [number, number, number] {
  const wLo = lo * 1.2
  const wMid = mid * 1.3
  const wHi = hi * 1.65
  const sum = wLo + wMid + wHi + 1e-6
  const r = (wLo * 248 + wMid * 68 + wHi * 56) / sum
  const g = (wLo * 66 + wMid * 212 + wHi * 195) / sum
  const b = (wLo * 92 + wMid * 138 + wHi * 250) / sum
  return [Math.min(255, Math.round(r)), Math.min(255, Math.round(g)), Math.min(255, Math.round(b))]
}

function fmtShortTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec - m * 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function barBeatAt(deck: Deck, sec: number): { bar: number; beat: number } | null {
  const g = deck.track?.grid
  if (!g || g.bpm <= 0) return null
  const bpb = g.beatsPerBar ?? 4
  const beatDur = 60 / g.bpm
  const idx = Math.floor((sec - g.offset) / beatDur + 1e-4)
  const bar = idx >= 0 ? Math.floor(idx / bpb) + 1 : Math.floor(idx / bpb)
  const beat = (((idx % bpb) + bpb) % bpb) + 1
  return { bar, beat }
}

function sectionAt(sections: TrackSection[] | undefined, sec: number): TrackSection | null {
  if (!sections?.length) return null
  for (const s of sections) {
    if (sec >= s.tStart - 0.05 && sec < s.tEnd) return s
  }
  return null
}

/**
 * Dual-view deck waveform controller:
 *  1. Zoom-out Overview Strip — color-coded Arrangement Ribbon (INTRO/BUILD/
 *     DROP/BREAK/OUTRO), full-track RMS+peak waveform, bar ruler, hover
 *     inspector, viewport bracket, cue flags, click/drag seek.
 *  2. Close-up Scrolling Waveform — 4-STEMS / 3-BAND / RGB views with RMS body
 *     + peak outline, live stem dimming, downbeat bar numbers, section badges,
 *     loop region, and colored cue flags.
 */
export class WaveformView {
  private overviewCanvas: HTMLCanvasElement
  private og: CanvasRenderingContext2D
  private detailCanvas: HTMLCanvasElement
  private dg: CanvasRenderingContext2D

  private freq: FreqPyramid | null = null
  private stemPyramids: PeakPyramid[] = []
  private duration = 0
  private lastT0 = 0
  private hoverOverviewFrac: number | null = null
  private lastOverviewSections: TrackSection[] = []

  mode: WaveformMode = 'rgb'
  zoomSec = 10
  dirty = true
  onSeek?: (timeSec: number) => void
  onModeChange?: (mode: WaveformMode) => void

  constructor(overviewCanvas: HTMLCanvasElement, detailCanvas: HTMLCanvasElement) {
    this.overviewCanvas = overviewCanvas
    this.og = overviewCanvas.getContext('2d')!
    this.detailCanvas = detailCanvas
    this.dg = detailCanvas.getContext('2d')!

    const observe = (canvas: HTMLCanvasElement) => {
      const resize = () => {
        const dpr = window.devicePixelRatio || 1
        const r = canvas.getBoundingClientRect()
        canvas.width = Math.max(1, Math.floor(r.width * dpr))
        canvas.height = Math.max(1, Math.floor(r.height * dpr))
        this.dirty = true
      }
      new ResizeObserver(resize).observe(canvas)
      resize()
    }
    observe(overviewCanvas)
    observe(detailCanvas)

    // Overview interactions: click ribbon = snap to section start; click/drag body = seek
    const seekOverview = (e: PointerEvent, allowSectionSnap: boolean) => {
      if (!this.onSeek || this.duration <= 0) return
      const rect = overviewCanvas.getBoundingClientRect()
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      const relY = e.clientY - rect.top
      const t = frac * this.duration
      if (allowSectionSnap && relY <= 17 && this.lastOverviewSections.length > 0) {
        const sec = sectionAt(this.lastOverviewSections, t)
        if (sec) {
          this.onSeek(sec.tStart)
          this.dirty = true
          return
        }
      }
      this.onSeek(t)
      this.dirty = true
    }
    overviewCanvas.addEventListener('pointerdown', (e) => {
      overviewCanvas.setPointerCapture(e.pointerId)
      seekOverview(e, true)
    })
    overviewCanvas.addEventListener('pointermove', (e) => {
      const rect = overviewCanvas.getBoundingClientRect()
      this.hoverOverviewFrac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      if (e.buttons & 1) seekOverview(e, false)
      this.dirty = true
    })
    overviewCanvas.addEventListener('pointerleave', () => {
      this.hoverOverviewFrac = null
      this.dirty = true
    })

    // Detail interactions: click/drag to scrub, wheel to zoom
    const seekDetail = (e: PointerEvent) => {
      if (!this.onSeek || !this.freq) return
      const rect = detailCanvas.getBoundingClientRect()
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      this.onSeek(this.lastT0 + frac * this.zoomSec)
      this.dirty = true
    }
    detailCanvas.addEventListener('pointerdown', (e) => {
      detailCanvas.setPointerCapture(e.pointerId)
      seekDetail(e)
    })
    detailCanvas.addEventListener('pointermove', (e) => {
      if (e.buttons & 1) seekDetail(e)
    })
    detailCanvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        this.setZoom(this.zoomSec * (e.deltaY > 0 ? 1.25 : 0.8))
      },
      { passive: false }
    )
  }

  get hasStems(): boolean {
    return this.stemPyramids.length === 4
  }

  markDirty(): void {
    this.dirty = true
  }

  setZoom(sec: number): void {
    this.zoomSec = Math.min(60, Math.max(2, sec))
    this.dirty = true
  }

  setMode(mode: WaveformMode): void {
    if (mode === 'stems' && !this.hasStems) return
    this.mode = mode
    this.dirty = true
    this.onModeChange?.(this.mode)
  }

  setBuffer(buffer: AudioBuffer | null): void {
    if (!buffer) {
      this.freq = null
      this.stemPyramids = []
      this.duration = 0
      this.mode = 'rgb'
      this.dirty = true
      return
    }
    this.freq = buildFreqPyramid(buffer)
    this.duration = buffer.duration
    this.stemPyramids = []
    if (this.mode === 'stems') this.mode = 'rgb'
    this.dirty = true
    this.onModeChange?.(this.mode)
  }

  setStems(buffers: AudioBuffer[]): void {
    if (buffers.length === 4) {
      this.stemPyramids = buffers.map((b) => buildPeakPyramid(b))
      this.mode = 'stems'
    } else {
      this.stemPyramids = []
      if (this.mode === 'stems') this.mode = 'rgb'
    }
    this.dirty = true
    this.onModeChange?.(this.mode)
  }

  draw(deck: Deck): void {
    this.dirty = false
    this.drawOverview(deck)
    this.drawDetail(deck)
  }

  // -------------------------------------------------------------------------
  // 1. Zoom-out Overview Strip (Arrangement Ribbon + Full-Track Waveform)
  // -------------------------------------------------------------------------

  private drawOverview(deck: Deck): void {
    const c = this.overviewCanvas
    const g = this.og
    const w = c.width
    const h = c.height
    const dpr = window.devicePixelRatio || 1
    const sections = deck.track?.sections ?? []
    this.lastOverviewSections = sections

    const ribbonH = sections.length > 0 ? Math.round(16 * dpr) : Math.round(13 * dpr)
    const bodyY = ribbonH
    const bodyH = Math.max(1, h - ribbonH)

    g.fillStyle = '#0c0f14'
    g.fillRect(0, 0, w, h)

    g.fillStyle = '#11161e'
    g.fillRect(0, 0, w, ribbonH)
    g.strokeStyle = 'rgba(255,255,255,0.08)'
    g.beginPath()
    g.moveTo(0, ribbonH + 0.5)
    g.lineTo(w, ribbonH + 0.5)
    g.stroke()

    if (!this.freq || this.duration <= 0) {
      g.fillStyle = '#3a424d'
      g.font = `${10 * dpr}px ui-monospace, monospace`
      g.textAlign = 'center'
      g.fillText('full-track overview & arrangement ribbon — drop audio to analyze', w / 2, bodyY + bodyH / 2 + 3 * dpr)
      return
    }

    const dur = this.duration
    const secPerPx = dur / w
    const grid = deck.track?.grid
    const bpb = grid?.beatsPerBar ?? 4
    const phraseBars = grid?.phraseBars ?? 8

    // Color-coded Arrangement Ribbon along top edge (click any block to jump!)
    if (sections.length > 0) {
      g.font = `700 ${8.5 * dpr}px ui-monospace, monospace`
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      for (const s of sections) {
        const x0 = Math.max(0, Math.round(s.tStart / secPerPx))
        const x1 = Math.min(w, Math.round(s.tEnd / secPerPx))
        const sw = x1 - x0
        if (sw < 2) continue
        const pal = SECTION_COLORS[s.label]
        g.fillStyle = pal.bg
        g.fillRect(x0, 0, sw, ribbonH)
        g.fillStyle = pal.border
        g.fillRect(x0, 0, sw, Math.max(1.5, 2 * dpr))
        // subtle vertical boundary line through waveform body
        g.strokeStyle = 'rgba(255,255,255,0.12)'
        g.beginPath()
        g.moveTo(x0 + 0.5, 0)
        g.lineTo(x0 + 0.5, h)
        g.stroke()

        const bars = Math.max(1, s.barEnd - s.barStart)
        const vox = s.hasVocals ? ' ♪' : ''
        const fullTxt = `${s.label} ${bars}B${vox}`
        const shortTxt = `${s.label.slice(0, 3)} ${bars}B`
        g.fillStyle = pal.fg
        if (sw >= g.measureText(fullTxt).width + 6 * dpr) {
          g.fillText(fullTxt, x0 + 3 * dpr, ribbonH / 2 + 1 * dpr)
        } else if (sw >= g.measureText(shortTxt).width + 4 * dpr) {
          g.fillText(shortTxt, x0 + 2 * dpr, ribbonH / 2 + 1 * dpr)
        } else if (sw >= 18 * dpr) {
          g.fillText(s.label.slice(0, 3), x0 + 2 * dpr, ribbonH / 2 + 1 * dpr)
        }
      }
      g.textBaseline = 'alphabetic'
    }

    // Phrase ticks & Bar 1 gold anchor
    if (grid && grid.bpm > 0) {
      const barDur = (60 / grid.bpm) * bpb
      const phraseDur = barDur * phraseBars
      const firstPhrase = Math.floor(-grid.offset / phraseDur) - 1
      const lastPhrase = Math.ceil((dur - grid.offset) / phraseDur) + 1

      for (let p = firstPhrase; p <= lastPhrase; p++) {
        const ts = grid.offset + p * phraseDur
        const te = ts + phraseDur
        const x0 = Math.max(0, Math.round(ts / secPerPx))
        const x1 = Math.min(w, Math.round(te / secPerPx))
        if (x1 <= x0) continue
        if (((p % 2) + 2) % 2 === 0) {
          g.fillStyle = 'rgba(255,255,255,0.028)'
          g.fillRect(x0, bodyY, x1 - x0, bodyH)
        }
      }

      const minLabelPx = 30 * dpr
      let stepPhrases = 1
      while ((phraseDur * stepPhrases) / secPerPx < minLabelPx) stepPhrases *= 2

      g.font = `600 ${8 * dpr}px ui-monospace, monospace`
      g.textAlign = 'left'
      for (let p = firstPhrase; p <= lastPhrase; p++) {
        const ts = grid.offset + p * phraseDur
        if (ts < -0.001 || ts > dur) continue
        const x = Math.round(ts / secPerPx)
        const isBar1 = p === 0
        g.strokeStyle = isBar1 ? 'rgba(251,191,36,0.85)' : 'rgba(255,255,255,0.12)'
        g.lineWidth = isBar1 ? Math.max(1.5, dpr) : 1
        g.beginPath()
        g.moveTo(x + 0.5, bodyY)
        g.lineTo(x + 0.5, h)
        g.stroke()
        g.lineWidth = 1

        if (sections.length === 0 && (isBar1 || ((p % stepPhrases) + stepPhrases) % stepPhrases === 0)) {
          const barNum = p >= 0 ? p * phraseBars + 1 : p * phraseBars
          g.fillStyle = isBar1 ? '#fbbf24' : '#8b95a5'
          g.fillText(isBar1 ? 'B1' : String(barNum), x + 3 * dpr, ribbonH - 3 * dpr)
        }
      }
    }

    // Waveform body (RMS body + peak outline)
    if (this.mode === 'stems' && this.hasStems) {
      this.drawStemLanes(g, deck, 0, bodyY, w, bodyH, 0, secPerPx, false)
    } else if (this.mode === 'bands') {
      this.drawBandLanes(g, 0, bodyY, w, bodyH, 0, secPerPx, false)
    } else {
      this.drawRgbWave(g, 0, bodyY, w, bodyH, 0, secPerPx)
    }

    // Dim veil over played portion
    const pos = deck.audiblePosition
    const playX = Math.max(0, Math.min(w, Math.round(pos / secPerPx)))
    g.fillStyle = 'rgba(6,8,12,0.34)'
    g.fillRect(0, bodyY, playX, bodyH)

    // Active loop region
    if (deck.activeLoop) {
      const lx0 = Math.max(0, deck.activeLoop.start / secPerPx)
      const lx1 = Math.min(w, (deck.activeLoop.start + deck.activeLoop.len) / secPerPx)
      g.fillStyle = 'rgba(168,85,247,0.28)'
      g.fillRect(lx0, bodyY, Math.max(2, lx1 - lx0), bodyH)
      g.strokeStyle = '#c084fc'
      g.strokeRect(lx0 + 0.5, bodyY + 0.5, Math.max(2, lx1 - lx0), bodyH - 1)
    }

    // Close-up viewport bracket
    const t0 = pos - this.zoomSec * PLAYHEAD_FRAC
    const t1 = t0 + this.zoomSec
    const vx0 = Math.max(0, Math.round(t0 / secPerPx))
    const vx1 = Math.min(w, Math.round(t1 / secPerPx))
    g.strokeStyle = deck.id === 'A' ? 'rgba(240,90,36,0.92)' : 'rgba(56,189,248,0.9)'
    g.lineWidth = Math.max(1, dpr)
    g.strokeRect(vx0 + 0.5, bodyY + 0.5, Math.max(4, vx1 - vx0), bodyH - 1)
    g.lineWidth = 1

    // Cue & Hot Cue ticks
    this.drawOverviewMarker(g, w, h, bodyY, secPerPx, dpr, deck.cuePoint, CUE_COLOR, 'C')
    for (let i = 0; i < deck.hotCues.length && i < HC_COLORS.length; i++) {
      const hc = deck.hotCues[i]
      if (hc != null) this.drawOverviewMarker(g, w, h, bodyY, secPerPx, dpr, hc, HC_COLORS[i], String(i + 1))
    }

    // Playhead
    g.strokeStyle = '#ffffff'
    g.lineWidth = Math.max(1.5, 1.5 * dpr)
    g.beginPath()
    g.moveTo(playX + 0.5, 0)
    g.lineTo(playX + 0.5, h)
    g.stroke()
    g.lineWidth = 1

    // Hover inspector (Section + Bar.Beat + Timestamp)
    if (this.hoverOverviewFrac != null) {
      const ht = this.hoverOverviewFrac * dur
      const hx = Math.round(this.hoverOverviewFrac * w)
      g.strokeStyle = 'rgba(255,255,255,0.6)'
      g.setLineDash([2 * dpr, 2 * dpr])
      g.beginPath()
      g.moveTo(hx + 0.5, ribbonH)
      g.lineTo(hx + 0.5, h)
      g.stroke()
      g.setLineDash([])

      const bb = barBeatAt(deck, ht)
      const sec = sectionAt(sections, ht)
      const secPrefix = sec ? `${sec.label} · ` : ''
      const label = bb ? `${secPrefix}BAR ${bb.bar}.${bb.beat} · ${fmtShortTime(ht)}` : fmtShortTime(ht)
      g.font = `700 ${9 * dpr}px ui-monospace, monospace`
      const tw = g.measureText(label).width + 10 * dpr
      const bx = Math.min(w - tw - 2 * dpr, Math.max(2 * dpr, hx - tw / 2))
      g.fillStyle = 'rgba(9,11,15,0.95)'
      g.fillRect(bx, 1 * dpr, tw, ribbonH - 2 * dpr)
      g.strokeStyle = sec ? SECTION_COLORS[sec.label].border : 'rgba(255,255,255,0.35)'
      g.strokeRect(bx + 0.5, 1 * dpr + 0.5, tw - 1, ribbonH - 2 * dpr - 1)
      g.fillStyle = '#f8fafc'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(label, bx + tw / 2, ribbonH / 2 + 0.5 * dpr)
      g.textBaseline = 'alphabetic'
    }
  }

  private drawOverviewMarker(
    g: CanvasRenderingContext2D,
    w: number,
    h: number,
    bodyY: number,
    secPerPx: number,
    dpr: number,
    t: number,
    color: string,
    label: string
  ): void {
    const x = Math.round(t / secPerPx)
    if (x < 0 || x > w) return
    g.strokeStyle = color
    g.lineWidth = Math.max(1.5, 1.5 * dpr)
    g.beginPath()
    g.moveTo(x + 0.5, bodyY)
    g.lineTo(x + 0.5, h)
    g.stroke()
    g.lineWidth = 1

    const pw = 10 * dpr
    const ph = 11 * dpr
    g.fillStyle = color
    g.fillRect(x - pw / 2, bodyY, pw, ph)
    g.fillStyle = '#090b0e'
    g.font = `700 ${8.5 * dpr}px ui-monospace, monospace`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(label, x, bodyY + ph / 2 + 0.5 * dpr)
    g.textBaseline = 'alphabetic'
  }

  // -------------------------------------------------------------------------
  // 2. Close-up Scrolling Waveform
  // -------------------------------------------------------------------------

  private drawDetail(deck: Deck): void {
    const c = this.detailCanvas
    const g = this.dg
    const w = c.width
    const h = c.height
    const dpr = window.devicePixelRatio || 1
    const rulerH = Math.round(16 * dpr)
    const bodyY = rulerH
    const bodyH = Math.max(1, h - rulerH)

    g.fillStyle = '#0c0f14'
    g.fillRect(0, 0, w, h)

    g.fillStyle = '#11161e'
    g.fillRect(0, 0, w, rulerH)
    g.strokeStyle = 'rgba(255,255,255,0.08)'
    g.beginPath()
    g.moveTo(0, rulerH + 0.5)
    g.lineTo(w, rulerH + 0.5)
    g.stroke()

    if (!this.freq) {
      g.fillStyle = '#3a424d'
      g.font = `${12 * dpr}px ui-monospace, monospace`
      g.textAlign = 'center'
      g.fillText('drop a track', w / 2, bodyY + bodyH / 2 + 4 * dpr)
      return
    }

    const pos = deck.audiblePosition
    const t0 = pos - this.zoomSec * PLAYHEAD_FRAC
    const t1 = t0 + this.zoomSec
    this.lastT0 = t0
    const secPerPx = this.zoomSec / w

    // Subtle section tint along ruler in close-up view
    const sections = deck.track?.sections ?? []
    for (const s of sections) {
      if (s.tEnd < t0 || s.tStart > t1) continue
      const sx0 = Math.max(0, Math.round((s.tStart - t0) / secPerPx))
      const sx1 = Math.min(w, Math.round((s.tEnd - t0) / secPerPx))
      const pal = SECTION_COLORS[s.label]
      g.fillStyle = pal.bg
      g.fillRect(sx0, 0, Math.max(1, sx1 - sx0), Math.round(3 * dpr))
    }

    // Waveform body
    if (this.mode === 'stems' && this.hasStems) {
      this.drawStemLanes(g, deck, 0, bodyY, w, bodyH, t0, secPerPx, true)
    } else if (this.mode === 'bands') {
      this.drawBandLanes(g, 0, bodyY, w, bodyH, t0, secPerPx, true)
    } else {
      g.strokeStyle = 'rgba(255,255,255,0.07)'
      g.beginPath()
      g.moveTo(0, bodyY + bodyH / 2)
      g.lineTo(w, bodyY + bodyH / 2)
      g.stroke()
      this.drawRgbWave(g, 0, bodyY, w, bodyH, t0, secPerPx)
    }

    // Beatgrid & downbeat bar numbers
    const grid = deck.track?.grid
    if (grid && grid.bpm > 0) {
      const beat = 60 / grid.bpm
      const bpb = grid.beatsPerBar ?? 4
      const phraseBars = grid.phraseBars ?? 8
      let k = Math.floor((t0 - grid.offset) / beat) - 1
      g.font = `600 ${9 * dpr}px ui-monospace, monospace`
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      for (;;) {
        const t = grid.offset + k * beat
        if (t > t1) break
        if (t >= t0) {
          const x = Math.round((t - t0) / secPerPx)
          const beatInBar = ((k % bpb) + bpb) % bpb
          const isDownbeat = beatInBar === 0
          const barZero = Math.floor(k / bpb)
          const isPhrase = isDownbeat && ((barZero % phraseBars) + phraseBars) % phraseBars === 0
          const isBar1 = k === 0

          if (isBar1) {
            g.strokeStyle = 'rgba(251,191,36,0.9)'
            g.lineWidth = Math.max(1.5, 1.5 * dpr)
          } else if (isPhrase) {
            g.strokeStyle = 'rgba(255,255,255,0.55)'
            g.lineWidth = Math.max(1, dpr)
          } else if (isDownbeat) {
            g.strokeStyle = 'rgba(255,255,255,0.3)'
            g.lineWidth = 1
          } else {
            g.strokeStyle = 'rgba(255,255,255,0.09)'
            g.lineWidth = 1
          }
          g.beginPath()
          g.moveTo(x + 0.5, isDownbeat ? 0 : bodyY + bodyH * 0.08)
          g.lineTo(x + 0.5, isDownbeat ? h : bodyY + bodyH * 0.92)
          g.stroke()
          g.lineWidth = 1

          if (isDownbeat) {
            const barNum = barZero >= 0 ? barZero + 1 : barZero
            g.fillStyle = isBar1 ? '#fbbf24' : isPhrase ? '#f1f5f9' : '#7d8590'
            g.fillText(isBar1 ? 'BAR 1' : String(barNum), x + 3 * dpr, rulerH / 2 + 1 * dpr)
          }
        }
        k++
      }
      g.textBaseline = 'alphabetic'
    }

    // Section transition badges right on the close-up ruler
    for (const s of sections) {
      if (s.tStart < t0 || s.tStart > t1) continue
      const x = Math.round((s.tStart - t0) / secPerPx)
      const pal = SECTION_COLORS[s.label]
      g.strokeStyle = pal.border
      g.lineWidth = Math.max(1.5, 1.5 * dpr)
      g.beginPath()
      g.moveTo(x + 0.5, rulerH)
      g.lineTo(x + 0.5, h)
      g.stroke()
      g.lineWidth = 1

      const label = s.hasVocals ? `${s.label} ♪` : s.label
      g.font = `700 ${8.5 * dpr}px ui-monospace, monospace`
      const tw = g.measureText(label).width + 8 * dpr
      g.fillStyle = '#090b0f'
      g.fillRect(x, 2 * dpr, tw, rulerH - 3 * dpr)
      g.fillStyle = pal.bg
      g.fillRect(x, 2 * dpr, tw, rulerH - 3 * dpr)
      g.strokeStyle = pal.border
      g.strokeRect(x + 0.5, 2 * dpr + 0.5, tw - 1, rulerH - 4 * dpr)
      g.fillStyle = pal.fg
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.fillText(label, x + 4 * dpr, rulerH / 2 + 1 * dpr)
      g.textBaseline = 'alphabetic'
    }

    // Active loop region
    if (deck.activeLoop) {
      const lx0 = (deck.activeLoop.start - t0) / secPerPx
      const lx1 = lx0 + deck.activeLoop.len / secPerPx
      g.fillStyle = 'rgba(168,85,247,0.18)'
      g.fillRect(lx0, bodyY, lx1 - lx0, bodyH)
      g.strokeStyle = 'rgba(192,132,252,0.9)'
      g.lineWidth = Math.max(1.5, 1.5 * dpr)
      for (const lx of [lx0, lx1]) {
        g.beginPath()
        g.moveTo(lx, bodyY)
        g.lineTo(lx, h)
        g.stroke()
      }
      g.lineWidth = 1
    }

    // Cue & Hot Cue flags
    this.drawDetailFlag(g, w, h, rulerH, t0, secPerPx, dpr, deck.cuePoint, CUE_COLOR, 'CUE')
    for (let i = 0; i < deck.hotCues.length && i < HC_COLORS.length; i++) {
      const hc = deck.hotCues[i]
      if (hc != null) this.drawDetailFlag(g, w, h, rulerH, t0, secPerPx, dpr, hc, HC_COLORS[i], String(i + 1))
    }

    // Playhead
    const px = Math.round(PLAYHEAD_FRAC * w)
    g.strokeStyle = '#ffffff'
    g.lineWidth = Math.max(1.5, 1.5 * dpr)
    g.beginPath()
    g.moveTo(px + 0.5, 0)
    g.lineTo(px + 0.5, h)
    g.stroke()
    g.lineWidth = 1

    const tri = 4.5 * dpr
    g.fillStyle = '#ffffff'
    g.beginPath()
    g.moveTo(px - tri, 0)
    g.lineTo(px + tri, 0)
    g.lineTo(px, tri * 1.4)
    g.closePath()
    g.fill()
  }

  private drawDetailFlag(
    g: CanvasRenderingContext2D,
    w: number,
    h: number,
    rulerH: number,
    t0: number,
    secPerPx: number,
    dpr: number,
    t: number,
    color: string,
    label: string
  ): void {
    const x = Math.round((t - t0) / secPerPx)
    if (x < -20 * dpr || x > w + 20 * dpr) return
    g.strokeStyle = color
    g.lineWidth = Math.max(1.5, 2 * dpr)
    g.beginPath()
    g.moveTo(x + 0.5, rulerH)
    g.lineTo(x + 0.5, h)
    g.stroke()
    g.lineWidth = 1

    g.font = `700 ${9 * dpr}px ui-monospace, monospace`
    const pad = 4 * dpr
    const tw = Math.max(13 * dpr, g.measureText(label).width + pad * 2)
    const fh = rulerH - 2 * dpr
    g.fillStyle = color
    g.fillRect(x, 1 * dpr, tw, fh)
    g.fillStyle = '#090b0e'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(label, x + tw / 2, 1 * dpr + fh / 2 + 0.5 * dpr)
    g.textBaseline = 'alphabetic'
  }

  // -------------------------------------------------------------------------
  // Waveform painters: RMS body (100%) + peak outline (42%) for crisp dynamics
  // -------------------------------------------------------------------------

  private drawRgbWave(
    g: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    w: number,
    h: number,
    t0: number,
    secPerPx: number
  ): void {
    const f = this.freq!
    const mip = pickMip(f.peak, f.pps, secPerPx)
    const pkArr = f.peak[mip.idx]
    const rmsArr = f.rms[mip.idx]
    const loArr = f.lo[mip.idx]
    const midArr = f.mid[mip.idx]
    const hiArr = f.hi[mip.idx]
    const pps = mip.pps
    const cy = y0 + h / 2
    const maxH = h * 0.46

    for (let x = 0; x < w; x++) {
      const ta = t0 + x * secPerPx
      const tb = ta + secPerPx
      const pk = sampleRange(pkArr, pps, ta, tb, 'max')
      if (pk <= 0.003) continue
      const rm = sampleRange(rmsArr, pps, ta, tb, 'avg')
      const vLo = sampleRange(loArr, pps, ta, tb, 'avg')
      const vMid = sampleRange(midArr, pps, ta, tb, 'avg')
      const vHi = sampleRange(hiArr, pps, ta, tb, 'avg')
      const [r, gr, b] = freqRgb(vLo, vMid, vHi)

      // Peak envelope (translucent halo — shows transients without flattening dynamics)
      const pkH = Math.max(1, pk * maxH)
      g.fillStyle = `rgba(${r},${gr},${b},0.42)`
      g.fillRect(x0 + x, cy - pkH, 1, pkH * 2)

      // Solid RMS core (clearly separates -15 dB breakdowns from -6.5 dB drops!)
      const rmH = Math.max(1, Math.min(pk, rm) * maxH)
      g.fillStyle = `rgb(${r},${gr},${b})`
      g.fillRect(x0 + x, cy - rmH, 1, rmH * 2)
    }
  }

  private drawBandLanes(
    g: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    w: number,
    h: number,
    t0: number,
    secPerPx: number,
    showLabels: boolean
  ): void {
    const f = this.freq!
    const mip = pickMip(f.peak, f.pps, secPerPx)
    const arrays = [f.lo[mip.idx], f.mid[mip.idx], f.hi[mip.idx]]
    const pps = mip.pps
    const laneH = h / 3
    const dpr = window.devicePixelRatio || 1

    for (let l = 0; l < 3; l++) {
      const ly = y0 + l * laneH
      const cy = ly + laneH / 2
      if (l > 0) {
        g.strokeStyle = 'rgba(255,255,255,0.06)'
        g.beginPath()
        g.moveTo(x0, Math.round(ly) + 0.5)
        g.lineTo(x0 + w, Math.round(ly) + 0.5)
        g.stroke()
      }
      const arr = arrays[l]
      const meta = BAND_META[l]
      g.fillStyle = meta.color
      const maxH = laneH * 0.45
      for (let x = 0; x < w; x++) {
        const ta = t0 + x * secPerPx
        const m = sampleRange(arr, pps, ta, ta + secPerPx, 'avg')
        if (m > 0.004) {
          const bh = Math.max(1, m * maxH)
          g.fillRect(x0 + x, cy - bh, 1, bh * 2)
        }
      }
      if (showLabels) {
        this.drawLaneTag(g, x0, ly, laneH, dpr, meta.short, meta.color, 1)
      }
    }
  }

  private drawStemLanes(
    g: CanvasRenderingContext2D,
    deck: Deck,
    x0: number,
    y0: number,
    w: number,
    h: number,
    t0: number,
    secPerPx: number,
    showLabels: boolean
  ): void {
    const laneH = h / 4
    const dpr = window.devicePixelRatio || 1

    for (let s = 0; s < 4; s++) {
      const pyr = this.stemPyramids[s]
      const meta = STEM_META[s]
      const ly = y0 + s * laneH
      const cy = ly + laneH / 2
      const gain = deck.getStemGain(s)

      if (s > 0) {
        g.strokeStyle = 'rgba(255,255,255,0.07)'
        g.beginPath()
        g.moveTo(x0, Math.round(ly) + 0.5)
        g.lineTo(x0 + w, Math.round(ly) + 0.5)
        g.stroke()
      }

      if (pyr) {
        const mip = pickMip(pyr.peaks, pyr.pps, secPerPx)
        const pkArr = pyr.peaks[mip.idx]
        const rmsArr = pyr.rms[mip.idx]
        const alpha = 0.16 + 0.84 * Math.min(1, Math.max(0, gain))
        const [r, gr, b] = meta.rgb
        const haloStyle = `rgba(${r},${gr},${b},${(alpha * 0.42).toFixed(2)})`
        const bodyStyle = `rgba(${r},${gr},${b},${alpha.toFixed(2)})`
        const maxH = laneH * 0.45

        for (let x = 0; x < w; x++) {
          const ta = t0 + x * secPerPx
          const tb = ta + secPerPx
          const pk = sampleRange(pkArr, mip.pps, ta, tb, 'max')
          if (pk <= 0.003) continue
          const rm = sampleRange(rmsArr, mip.pps, ta, tb, 'avg')
          const pkH = Math.max(1, pk * maxH)
          g.fillStyle = haloStyle
          g.fillRect(x0 + x, cy - pkH, 1, pkH * 2)
          const rmH = Math.max(1, Math.min(pk, rm) * maxH)
          g.fillStyle = bodyStyle
          g.fillRect(x0 + x, cy - rmH, 1, rmH * 2)
        }
      }

      if (showLabels) {
        this.drawLaneTag(g, x0, ly, laneH, dpr, meta.short, meta.color, gain)
      }
    }
  }

  private drawLaneTag(
    g: CanvasRenderingContext2D,
    x0: number,
    ly: number,
    laneH: number,
    dpr: number,
    text: string,
    color: string,
    gain: number
  ): void {
    const muted = gain < 0.02
    const tagW = 28 * dpr
    const tagH = Math.min(laneH - 4 * dpr, 14 * dpr)
    const ty = ly + (laneH - tagH) / 2
    g.fillStyle = 'rgba(11,14,20,0.82)'
    g.fillRect(x0 + 3 * dpr, ty, tagW, tagH)
    g.fillStyle = muted ? '#4b5563' : color
    g.fillRect(x0 + 3 * dpr, ty, 3 * dpr, tagH)
    g.font = `700 ${8.5 * dpr}px ui-monospace, monospace`
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillText(text, x0 + 8 * dpr, ty + tagH / 2 + 0.5 * dpr)
    g.textBaseline = 'alphabetic'
  }
}
