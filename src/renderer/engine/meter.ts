/**
 * Super-segment LCD + Winamp-style live spectrum / VU visualizer.
 * Renders crisp discrete phosphor segments with falling peak-hold caps
 * inside recessed obsidian glass displays — zero allocations per frame.
 */

export class DeckMeterView {
  private g: CanvasRenderingContext2D
  private peaks = new Float32Array(16)
  private bins = new Float32Array(16)
  private clipHold = 0

  constructor(private canvas: HTMLCanvasElement, private accent: 'A' | 'B') {
    this.g = canvas.getContext('2d')!
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const r = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(r.width * dpr))
      canvas.height = Math.max(1, Math.floor(r.height * dpr))
    }
    new ResizeObserver(resize).observe(canvas)
    resize()
  }

  get binBuffer(): Float32Array {
    return this.bins
  }

  draw(level: { rms: number; peak: number; clip: boolean }): void {
    const c = this.canvas
    const g = this.g
    const w = c.width
    const h = c.height
    const dpr = window.devicePixelRatio || 1

    g.fillStyle = '#090a0d'
    g.fillRect(0, 0, w, h)

    if (level.clip) this.clipHold = 18
    else if (this.clipHold > 0) this.clipHold--

    const nBars = 16
    const nSegs = 8
    const padX = Math.round(3 * dpr)
    const padY = Math.round(3 * dpr)
    const clipW = Math.round(6 * dpr)
    const specW = Math.max(16, w - padX * 2 - clipW - Math.round(4 * dpr))
    const specH = Math.max(8, h - padY * 2)
    const gapX = Math.max(1, Math.round(1.5 * dpr))
    const gapY = Math.max(1, Math.round(1.5 * dpr))
    const barW = Math.max(1, (specW - gapX * (nBars - 1)) / nBars)
    const segH = Math.max(1, (specH - gapY * (nSegs - 1)) / nSegs)

    const loCol = this.accent === 'A' ? '#f05a24' : '#38bdf8'
    const midCol = this.accent === 'A' ? '#fab413' : '#4ade80'
    const hiCol = '#ef4444'

    for (let i = 0; i < nBars; i++) {
      const v = Math.min(1, this.bins[i] * 1.15)
      if (v > this.peaks[i]) this.peaks[i] = v
      else this.peaks[i] = Math.max(0, this.peaks[i] - 0.022)

      const lit = Math.round(v * nSegs)
      const pkSeg = Math.min(nSegs - 1, Math.floor(this.peaks[i] * nSegs))
      const x = padX + i * (barW + gapX)

      for (let s = 0; s < nSegs; s++) {
        const y = padY + (nSegs - 1 - s) * (segH + gapY)
        const isLit = s < lit
        const isPeak = this.peaks[i] > 0.05 && s === pkSeg
        if (isLit || isPeak) {
          g.fillStyle = s >= nSegs - 1 ? hiCol : s >= nSegs - 3 ? midCol : loCol
          g.globalAlpha = isLit ? 1 : 0.78
        } else {
          g.fillStyle = '#181b22'
          g.globalAlpha = 1
        }
        g.fillRect(x, y, barW, segH)
      }
    }
    g.globalAlpha = 1

    // Right-edge vertical RMS VU + top red CLIP LED
    const vx = w - padX - clipW
    const vuLit = Math.min(nSegs - 1, Math.round(Math.min(1, level.rms * 2.2) * (nSegs - 1)))
    for (let s = 0; s < nSegs; s++) {
      const y = padY + (nSegs - 1 - s) * (segH + gapY)
      if (s === nSegs - 1) {
        g.fillStyle = this.clipHold > 0 ? '#ef4444' : '#261417'
      } else if (s < vuLit) {
        g.fillStyle = s >= nSegs - 3 ? '#fab413' : '#4ade80'
      } else {
        g.fillStyle = '#181b22'
      }
      g.fillRect(vx, y, clipW, segH)
    }
  }
}

export class MasterMeterView {
  private g: CanvasRenderingContext2D
  private peakHold = 0
  private clipHold = 0

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const r = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(r.width * dpr))
      canvas.height = Math.max(1, Math.floor(r.height * dpr))
    }
    new ResizeObserver(resize).observe(canvas)
    resize()
  }

  draw(level: { rms: number; peak: number; clip: boolean }): void {
    const c = this.canvas
    const g = this.g
    const w = c.width
    const h = c.height
    const dpr = window.devicePixelRatio || 1

    g.fillStyle = '#090a0d'
    g.fillRect(0, 0, w, h)

    const v = Math.min(1, level.rms * 2.3)
    if (v > this.peakHold) this.peakHold = v
    else this.peakHold = Math.max(0, this.peakHold - 0.018)
    if (level.clip) this.clipHold = 22
    else if (this.clipHold > 0) this.clipHold--

    const segs = 20
    const pad = Math.round(3 * dpr)
    const gap = Math.max(1, Math.round(1.5 * dpr))
    const sw = Math.max(2, (w - pad * 2 - gap * (segs - 1)) / segs)
    const sh = Math.max(4, h - pad * 2)
    const lit = Math.round(v * (segs - 1))
    const pkIdx = Math.min(segs - 2, Math.floor(this.peakHold * (segs - 1)))

    for (let i = 0; i < segs; i++) {
      const x = pad + i * (sw + gap)
      if (i === segs - 1) {
        g.fillStyle = this.clipHold > 0 ? '#ef4444' : '#2a1518'
      } else if (i < lit || (this.peakHold > 0.04 && i === pkIdx)) {
        g.fillStyle = i >= segs - 4 ? '#f05a24' : i >= segs - 8 ? '#fab413' : '#4ade80'
      } else {
        g.fillStyle = '#181b22'
      }
      g.fillRect(x, pad, sw, sh)
    }
  }
}
