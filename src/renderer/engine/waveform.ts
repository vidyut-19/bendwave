import type { Deck } from './deck'

export const HC_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6']

const PLAYHEAD_FRAC = 0.25 // playhead sits 25% from the left
const PEAK_BUCKET = 512 // samples per peak bucket

/**
 * Scrolling waveform with beatgrid, cue + hot-cue markers.
 * Click/drag to seek, wheel to zoom.
 */
export class WaveformView {
  private canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D
  private peaks: Float32Array | null = null
  /** mip-pyramid: level n aggregates 4^n base buckets — O(pixels) redraw at any zoom */
  private levels: Float32Array[] = []
  private pps = 0 // base buckets (512-sample) per second
  zoomSec = 10
  onSeek?: (timeSec: number) => void

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.g = canvas.getContext('2d')!
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const r = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(r.width * dpr))
      canvas.height = Math.max(1, Math.floor(r.height * dpr))
    }
    new ResizeObserver(resize).observe(canvas)
    resize()

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId)
      this.emitSeek(e)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons & 1) this.emitSeek(e)
    })
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        this.zoomSec = Math.min(120, Math.max(1, this.zoomSec * (e.deltaY > 0 ? 1.25 : 0.8)))
      },
      { passive: false }
    )
  }

  private emitSeek(e: PointerEvent): void {
    if (!this.onSeek || !this.peaks) return
    const rect = this.canvas.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const t = this.lastT0 + frac * this.zoomSec
    this.onSeek(t)
  }

  private lastT0 = 0

  setBuffer(buffer: AudioBuffer | null): void {
    if (!buffer) {
      this.peaks = null
      this.levels = []
      return
    }
    const n = buffer.length
    const buckets = Math.ceil(n / PEAK_BUCKET)
    const peaks = new Float32Array(buckets)
    const chs: Float32Array[] = []
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chs.push(buffer.getChannelData(c))
    for (let b = 0; b < buckets; b++) {
      let m = 0
      const st = b * PEAK_BUCKET
      const en = Math.min(n, st + PEAK_BUCKET)
      for (let i = st; i < en; i++) {
        for (const d of chs) {
          const v = Math.abs(d[i])
          if (v > m) m = v
        }
      }
      peaks[b] = m
    }
    this.peaks = peaks
    this.pps = buffer.sampleRate / PEAK_BUCKET

    // build mip levels (4x max-aggregation each) until coarse enough
    const levels: Float32Array[] = [peaks]
    while (levels[levels.length - 1].length > 256) {
      const prev = levels[levels.length - 1]
      const next = new Float32Array(Math.ceil(prev.length / 4))
      for (let i = 0; i < next.length; i++) {
        let m = 0
        const en = Math.min(prev.length, (i + 1) * 4)
        for (let j = i * 4; j < en; j++) {
          if (prev[j] > m) m = prev[j]
        }
        next[i] = m
      }
      levels.push(next)
    }
    this.levels = levels
  }

  draw(deck: Deck): void {
    const c = this.canvas
    const g = this.g
    const w = c.width
    const h = c.height
    g.fillStyle = '#0e1116'
    g.fillRect(0, 0, w, h)

    if (!this.peaks) {
      g.fillStyle = '#3a424d'
      g.font = `${12 * (window.devicePixelRatio || 1)}px ui-monospace, monospace`
      g.textAlign = 'center'
      g.fillText('drop a track', w / 2, h / 2)
      return
    }

    const pos = deck.audiblePosition
    const t0 = pos - this.zoomSec * PLAYHEAD_FRAC
    const t1 = t0 + this.zoomSec
    this.lastT0 = t0
    const secPerPx = this.zoomSec / w

    // center line
    g.strokeStyle = 'rgba(255,255,255,0.08)'
    g.beginPath()
    g.moveTo(0, h / 2)
    g.lineTo(w, h / 2)
    g.stroke()

    // waveform — pick the mip level so each pixel column scans ~1-4 buckets
    const bucketsPerPx = secPerPx * this.pps
    let levelIdx = 0
    while (levelIdx < this.levels.length - 1 && bucketsPerPx / Math.pow(4, levelIdx) > 4) levelIdx++
    const lvl = this.levels[levelIdx]
    const lvlPps = this.pps / Math.pow(4, levelIdx)
    g.fillStyle = deck.id === 'A' ? '#ff5c39' : '#38bdf8'
    for (let x = 0; x < w; x++) {
      const ta = t0 + x * secPerPx
      const tb = ta + secPerPx
      if (tb < 0 || ta > lvl.length / lvlPps) continue
      let m = 0
      const i0 = Math.max(0, Math.floor(ta * lvlPps))
      const i1 = Math.min(lvl.length, Math.ceil(tb * lvlPps))
      for (let i = i0; i < i1; i++) {
        if (lvl[i] > m) m = lvl[i]
      }
      if (m > 0) {
        const bh = Math.max(1, m * h * 0.46)
        g.fillRect(x, h / 2 - bh, 1, bh * 2)
      }
    }

    // beatgrid (grid offset + bpm are in track time, which is what we display)
    const grid = deck.track?.grid
    if (grid && grid.bpm > 0) {
      const beat = 60 / grid.bpm
      let k = Math.floor((t0 - grid.offset) / beat) - 1
      for (;;) {
        const t = grid.offset + k * beat
        if (t > t1) break
        if (t >= t0) {
          const x = Math.round((t - t0) / secPerPx)
          const major = ((k % 4) + 4) % 4 === 0
          g.strokeStyle = major ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.15)'
          g.beginPath()
          g.moveTo(x + 0.5, major ? 0 : h * 0.14)
          g.lineTo(x + 0.5, major ? h : h * 0.86)
          g.stroke()
        }
        k++
      }
    }

    // active loop region
    if (deck.activeLoop) {
      const lx0 = (deck.activeLoop.start - t0) / secPerPx
      const lx1 = lx0 + deck.activeLoop.len / secPerPx
      g.fillStyle = 'rgba(167,139,250,0.16)'
      g.fillRect(lx0, 0, lx1 - lx0, h)
      g.strokeStyle = 'rgba(167,139,250,0.85)'
      for (const lx of [lx0, lx1]) {
        g.beginPath()
        g.moveTo(lx, 0)
        g.lineTo(lx, h)
        g.stroke()
      }
    }

    // cue marker
    this.drawMarker(g, w, h, t0, secPerPx, deck.cuePoint, '#f59e0b', 'C')
    // hot cue markers
    if (deck.hotCues) {
      for (let i = 0; i < deck.hotCues.length && i < HC_COLORS.length; i++) {
        const hc = deck.hotCues[i]
        if (hc != null) this.drawMarker(g, w, h, t0, secPerPx, hc, HC_COLORS[i], String(i + 1))
      }
    }

    // playhead
    const px = Math.round(PLAYHEAD_FRAC * w)
    g.strokeStyle = '#ffffff'
    g.beginPath()
    g.moveTo(px + 0.5, 0)
    g.lineTo(px + 0.5, h)
    g.stroke()
  }

  private drawMarker(
    g: CanvasRenderingContext2D,
    w: number,
    h: number,
    t0: number,
    secPerPx: number,
    t: number,
    color: string,
    label: string
  ): void {
    const x = Math.round((t - t0) / secPerPx)
    if (x < 0 || x > w) return
    g.strokeStyle = color
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(x + 0.5, 0)
    g.lineTo(x + 0.5, h)
    g.stroke()
    g.lineWidth = 1
    g.fillStyle = color
    g.font = 'bold 10px ui-monospace, monospace'
    g.textAlign = 'left'
    g.fillText(label, x + 3, 10)
  }
}
