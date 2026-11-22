/**
 * Boeing 737 Cockpit-Inspired Tactile SVG Rotary Knobs
 *
 * Three authentic B737 cockpit knob silhouettes:
 *   - 'pointer'   : B737 EFIS HSI / RANGE 4-lobe bar-pointer knob (TRM, LO, MID, HI)
 *   - 'wedge'     : B737 Overhead APU GEN / AUX BAT faceted wedge pointer (FLT, MST)
 *   - 'scalloped' : B737 EFIS BRT 8-scallop fluted brightness knob (VOL, WET, FB, SMP)
 *
 * Interactions:
 *   - Vertical pointer drag (Shift = 4× fine precision)
 *   - Mouse wheel / trackpad scroll
 *   - Double-click to snap back to detent/default value
 *   - Soft magnetic center detent on bipolar controls
 *   - Keyboard arrows / Home / End when focused
 *   - Programmatic setValue() rotates smoothly without firing user oninput
 */

export type KnobVariant = 'pointer' | 'wedge' | 'scalloped'

export interface KnobOptions {
  label: string
  min: number
  max: number
  step?: number
  value: number
  defaultValue?: number
  /** Bipolar controls sweep from 12 o'clock with a subtle center detent at detentValue (default 0) */
  bipolar?: boolean
  detentValue?: number
  variant: KnobVariant
  /** Diameter of the SVG dial in CSS pixels (default 38) */
  size?: number
  /** Optional accent color CSS value (e.g. 'var(--te-orange)', 'var(--te-violet)') */
  accent?: string
  /** Optional bipolar dual-color mode (left = lowAccent, right = highAccent, e.g. Filter LP/HP) */
  lowAccent?: string
  highAccent?: string
  /** Tooltip text */
  title?: string
  /** Formatter for the compact live readout under the knob */
  format?: (v: number) => string
  /** Extra class on the wrapper element */
  className?: string
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const MIN_DEG = -135
const MAX_DEG = 135
let knobUid = 0

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
  return n
}

function polar(cx: number, cy: number, r: number, degFromTop: number): [number, number] {
  const rad = ((degFromTop - 90) * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

function arcPath(cx: number, cy: number, r: number, degA: number, degB: number): string {
  const span = degB - degA
  if (Math.abs(span) < 0.4) return ''
  const [x1, y1] = polar(cx, cy, r, degA)
  const [x2, y2] = polar(cx, cy, r, degB)
  const large = Math.abs(span) > 180 ? 1 : 0
  const sweep = span > 0 ? 1 : 0
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

/** Build the 4-lobe sculpted skirt path (B737 EFIS HSI/RANGE knob). */
function buildFourLobePath(cx: number, cy: number): string {
  // 4 rounded outer lobes centered at 0, 90, 180, 270 deg with smooth concave waist cutouts at 45, 135, 225, 315 deg
  const pts: string[] = []
  const steps = 64
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    // cos(4a) peaks at 0, 90, 180, 270 and dips gently at 45, 135, 225, 315
    const r = 17.6 + 2.0 * Math.cos(4 * a)
    const x = cx + r * Math.cos(a)
    const y = cy + r * Math.sin(a)
    pts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  return pts.join(' ') + ' Z'
}

/** Build the 8-scallop fluted perimeter path (B737 EFIS BRT knob). */
function buildScallopedPath(cx: number, cy: number): string {
  const pts: string[] = []
  const steps = 96
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    // 8 crisp concave finger flutes around the perimeter
    const wave = Math.cos(8 * a)
    // Sharper crests, deeper rounded valleys like machined Boeing BRT flutes
    const r = 18.0 + (wave > 0 ? 1.5 * Math.pow(wave, 0.7) : 2.1 * wave)
    const x = cx + r * Math.cos(a)
    const y = cy + r * Math.sin(a)
    pts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  return pts.join(' ') + ' Z'
}

export class BoeingKnob {
  readonly root: HTMLDivElement
  readonly dial: HTMLDivElement
  readonly labelEl: HTMLSpanElement
  readonly readoutEl: HTMLSpanElement

  private rotor: SVGGElement
  private arcEl: SVGPathElement
  private indicatorEl: SVGElement | null = null
  private _value: number
  private _dragging = false

  readonly min: number
  readonly max: number
  readonly step: number
  readonly defaultValue: number
  readonly bipolar: boolean
  readonly detentValue: number
  private accent: string
  private lowAccent?: string
  private highAccent?: string
  private formatFn: (v: number) => string

  /** Fired only on user interaction (drag / wheel / double-click / keyboard). */
  oninput?: (value: number) => void

  constructor(opts: KnobOptions) {
    this.min = opts.min
    this.max = opts.max
    this.step = opts.step ?? (opts.max - opts.min) / 100
    this.defaultValue = opts.defaultValue ?? opts.value
    this.bipolar = !!opts.bipolar
    this.detentValue = opts.detentValue ?? 0
    this._value = this.clamp(opts.value)
    this.accent = opts.accent ?? 'var(--te-orange)'
    this.lowAccent = opts.lowAccent
    this.highAccent = opts.highAccent
    this.formatFn = opts.format ?? ((v) => v.toFixed(1))

    const size = opts.size ?? 38
    const id = `b737k-${++knobUid}`

    this.root = document.createElement('div')
    this.root.className = `b737-knob-wrap b737-${opts.variant}${opts.className ? ` ${opts.className}` : ''}`
    if (opts.title) this.root.title = `${opts.title} · drag ↕ · scroll · dbl-click reset`

    this.labelEl = document.createElement('span')
    this.labelEl.className = 'b737-label'
    this.labelEl.textContent = opts.label

    this.dial = document.createElement('div')
    this.dial.className = 'b737-dial'
    this.dial.tabIndex = 0
    this.dial.setAttribute('role', 'slider')
    this.dial.setAttribute('aria-label', opts.label)
    this.dial.setAttribute('aria-valuemin', String(this.min))
    this.dial.setAttribute('aria-valuemax', String(this.max))
    this.dial.style.width = `${size}px`
    this.dial.style.height = `${size}px`

    const svg = el('svg', { viewBox: '0 0 64 64', class: 'b737-svg' })
    const defs = el('defs')

    // 3D top-left cockpit lighting gradients (driven by CSS variables for Putty/Dark)
    const bodyGrad = el('linearGradient', { id: `${id}-body`, x1: '18%', y1: '10%', x2: '84%', y2: '90%' })
    bodyGrad.append(
      el('stop', { offset: '0%', class: 'k-stop-hi' }),
      el('stop', { offset: '55%', class: 'k-stop-mid' }),
      el('stop', { offset: '100%', class: 'k-stop-lo' })
    )
    const capGrad = el('linearGradient', { id: `${id}-cap`, x1: '20%', y1: '12%', x2: '82%', y2: '88%' })
    capGrad.append(
      el('stop', { offset: '0%', class: 'k-cap-hi' }),
      el('stop', { offset: '100%', class: 'k-cap-lo' })
    )
    const barGrad = el('linearGradient', { id: `${id}-bar`, x1: '0%', y1: '0%', x2: '100%', y2: '0%' })
    barGrad.append(
      el('stop', { offset: '0%', class: 'k-cap-hi' }),
      el('stop', { offset: '50%', class: 'k-stop-mid' }),
      el('stop', { offset: '100%', class: 'k-stop-lo' })
    )
    const drop = el('filter', { id: `${id}-sh`, x: '-25%', y: '-25%', width: '160%', height: '160%' })
    drop.append(
      el('feDropShadow', { dx: '1.8', dy: '2.6', stdDeviation: '2.0', 'flood-color': '#000000', 'flood-opacity': '0.44' })
    )
    defs.append(bodyGrad, capGrad, barGrad, drop)
    svg.append(defs)

    // 1. Precision Boeing cockpit radial tick scale (-135° to +135°)
    const ticks = el('g', { class: 'b737-ticks' })
    const nTicks = 11
    for (let i = 0; i < nTicks; i++) {
      const deg = MIN_DEG + (i / (nTicks - 1)) * (MAX_DEG - MIN_DEG)
      const isMajor = i === 0 || i === nTicks - 1 || i === Math.floor(nTicks / 2)
      const [x1, y1] = polar(32, 32, isMajor ? 24.5 : 25.6, deg)
      const [x2, y2] = polar(32, 32, isMajor ? 30.2 : 29.2, deg)
      ticks.append(
        el('line', {
          x1: x1.toFixed(2),
          y1: y1.toFixed(2),
          x2: x2.toFixed(2),
          y2: y2.toFixed(2),
          class: isMajor ? 'k-tick major' : 'k-tick'
        })
      )
    }
    svg.append(ticks)

    // 2. Track & dynamic active arc (r=23.5)
    const trackBg = el('path', {
      d: arcPath(32, 32, 23.2, MIN_DEG, MAX_DEG),
      fill: 'none',
      class: 'k-track'
    })
    this.arcEl = el('path', {
      d: '',
      fill: 'none',
      class: 'k-arc',
      'stroke-linecap': 'butt'
    })
    svg.append(trackBg, this.arcEl)

    // 3. Recessed mounting collar
    svg.append(el('circle', { cx: 32, cy: 32, r: 21.0, class: 'k-well' }))

    // 4. Shadow wrapper (fixed world-space drop shadow!) + rotating rotor
    const shadowWrap = el('g', { filter: `url(#${id}-sh)` })
    this.rotor = el('g', { class: 'b737-rotor' })

    if (opts.variant === 'pointer') {
      // B737 EFIS HSI / RANGE 4-lobe bar-pointer knob
      this.rotor.append(
        el('path', {
          d: buildFourLobePath(32, 32),
          fill: `url(#${id}-body)`,
          class: 'k-skirt-stroke'
        }),
        el('circle', { cx: 32, cy: 32, r: 14.4, fill: `url(#${id}-cap)`, class: 'k-inner-ring' }),
        // Raised rectangular Boeing pointer bar
        el('rect', {
          x: 27.6,
          y: 12.6,
          width: 8.8,
          height: 36.2,
          rx: 2.0,
          fill: `url(#${id}-bar)`,
          class: 'k-bar-stroke'
        }),
        // High-contrast inlaid black-framed Boeing index channel
        el('rect', {
          x: 29.7,
          y: 13.6,
          width: 4.6,
          height: 19.2,
          rx: 0.7,
          class: 'k-slot-bg'
        })
      )
      const stripe = el('rect', {
        x: 31.0,
        y: 14.5,
        width: 2.0,
        height: 17.2,
        rx: 0.4,
        class: 'k-indicator'
      })
      this.indicatorEl = stripe
      this.rotor.append(stripe)
    } else if (opts.variant === 'wedge') {
      // B737 Overhead APU GEN / AUX BAT faceted wedge pointer knob
      this.rotor.append(
        el('circle', { cx: 32, cy: 32, r: 19.6, fill: `url(#${id}-body)`, class: 'k-skirt-stroke' }),
        el('circle', { cx: 32, cy: 32, r: 16.8, fill: 'none', class: 'k-inner-ring' }),
        // Faceted teardrop/wedge handle base
        el('path', {
          d: 'M 32 12.2 L 39.2 21.8 L 39.2 44.8 Q 32 48.2 24.8 44.8 L 24.8 21.8 Z',
          fill: `url(#${id}-cap)`,
          class: 'k-bar-stroke'
        }),
        // Left illuminated facet + right shaded facet (classic 737 overhead 3D bevel)
        el('path', {
          d: 'M 32 12.5 L 25.2 22.0 L 25.2 44.4 L 32 46.8 Z',
          class: 'k-facet-l'
        }),
        el('path', {
          d: 'M 32 12.5 L 38.8 22.0 L 38.8 44.4 L 32 46.8 Z',
          class: 'k-facet-r'
        }),
        // Recessed Boeing black center spine
        el('rect', {
          x: 29.9,
          y: 13.2,
          width: 4.2,
          height: 20.4,
          rx: 0.6,
          class: 'k-slot-bg'
        })
      )
      const stripe = el('rect', {
        x: 31.05,
        y: 14.0,
        width: 1.9,
        height: 18.6,
        rx: 0.4,
        class: 'k-indicator'
      })
      this.indicatorEl = stripe
      this.rotor.append(stripe)
    } else {
      // B737 EFIS BRT 8-scallop fluted brightness knob
      this.rotor.append(
        el('path', {
          d: buildScallopedPath(32, 32),
          fill: `url(#${id}-body)`,
          class: 'k-skirt-stroke'
        })
      )
      // Subtle concave scallop highlight dots at the 8 flute valleys
      for (let i = 0; i < 8; i++) {
        const deg = i * 45 + 22.5
        const [fx, fy] = polar(32, 32, 17.6, deg)
        this.rotor.append(el('circle', { cx: fx.toFixed(1), cy: fy.toFixed(1), r: 2.1, class: 'k-flute-shadow' }))
      }
      this.rotor.append(
        el('circle', { cx: 32, cy: 32, r: 12.9, fill: `url(#${id}-cap)`, class: 'k-bar-stroke' }),
        el('rect', { x: 30.1, y: 19.6, width: 3.8, height: 8.6, rx: 0.6, class: 'k-slot-bg' })
      )
      const stripe = el('rect', {
        x: 31.1,
        y: 20.3,
        width: 1.8,
        height: 7.2,
        rx: 0.4,
        class: 'k-indicator'
      })
      this.indicatorEl = stripe
      this.rotor.append(stripe)
    }

    shadowWrap.append(this.rotor)
    svg.append(shadowWrap)
    this.dial.append(svg)

    this.readoutEl = document.createElement('span')
    this.readoutEl.className = 'b737-val'

    this.root.append(this.labelEl, this.dial, this.readoutEl)
    this.wireEvents()
    this.render()
  }

  get value(): number {
    return this._value
  }

  get dragging(): boolean {
    return this._dragging
  }

  /** Programmatic update (MIDI CC, auto-gain, auto-transition) — does NOT fire user oninput. */
  setValue(v: number): void {
    const clamped = this.clamp(v)
    if (Math.abs(clamped - this._value) < 1e-6) return
    this._value = clamped
    this.render()
  }

  private clamp(v: number): number {
    if (!isFinite(v)) return this.defaultValue
    return Math.min(this.max, Math.max(this.min, v))
  }

  private quantize(v: number): number {
    const c = this.clamp(v)
    if (this.step <= 0) return c
    const q = Math.round((c - this.min) / this.step) * this.step + this.min
    return Math.round(this.clamp(q) * 10000) / 10000
  }

  private normOf(v: number): number {
    if (this.bipolar) {
      // Piece-wise linear so detentValue (e.g. 0 dB on asymmetric -26..+6 EQ!) lands EXACTLY at 12 o'clock (0.5)!
      if (v >= this.detentValue) {
        const span = Math.max(1e-6, this.max - this.detentValue)
        return 0.5 + 0.5 * ((v - this.detentValue) / span)
      } else {
        const span = Math.max(1e-6, this.detentValue - this.min)
        return 0.5 - 0.5 * ((this.detentValue - v) / span)
      }
    }
    return (v - this.min) / Math.max(1e-6, this.max - this.min)
  }

  private valueFromNorm(n: number): number {
    const cn = Math.min(1, Math.max(0, n))
    if (this.bipolar) {
      if (Math.abs(cn - 0.5) < 0.025) return this.detentValue // tactile center detent snap
      if (cn >= 0.5) return this.detentValue + ((cn - 0.5) / 0.5) * (this.max - this.detentValue)
      return this.detentValue - ((0.5 - cn) / 0.5) * (this.detentValue - this.min)
    }
    return this.min + cn * (this.max - this.min)
  }

  private emitUserValue(v: number): void {
    const q = this.quantize(v)
    if (Math.abs(q - this._value) < 1e-6) return
    this._value = q
    this.render()
    this.oninput?.(this._value)
  }

  private render(): void {
    const norm = this.normOf(this._value)
    const deg = MIN_DEG + norm * (MAX_DEG - MIN_DEG)
    this.rotor.setAttribute('transform', `rotate(${deg.toFixed(1)} 32 32)`)

    // Active color (supports dual LP/HP coloring on Filter!)
    let activeCol = this.accent
    if (this.bipolar && this.lowAccent && this.highAccent) {
      if (this._value < this.detentValue - 0.02) activeCol = this.lowAccent
      else if (this._value > this.detentValue + 0.02) activeCol = this.highAccent
    }
    const atDetent = this.bipolar && Math.abs(this._value - this.detentValue) < (this.max - this.min) * 0.012
    this.arcEl.style.stroke = activeCol
    if (this.indicatorEl) {
      this.indicatorEl.style.fill = atDetent ? 'var(--knob-ind-flat)' : activeCol
    }

    const d = this.bipolar ? arcPath(32, 32, 23.2, 0, deg) : arcPath(32, 32, 23.2, MIN_DEG, deg)
    this.arcEl.setAttribute('d', d)

    this.readoutEl.textContent = this.formatFn(this._value)
    this.root.classList.toggle('engaged', this.bipolar ? !atDetent : norm > 0.01)
    this.dial.setAttribute('aria-valuenow', String(this._value))
  }

  private wireEvents(): void {
    let startY = 0
    let startNorm = 0

    this.dial.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      this._dragging = true
      this.root.classList.add('dragging')
      startY = e.clientY
      startNorm = this.normOf(this._value)
      this.dial.setPointerCapture(e.pointerId)
    })

    this.dial.addEventListener('pointermove', (e) => {
      if (!this._dragging) return
      const sens = e.shiftKey ? 440 : 125
      const deltaNorm = (startY - e.clientY) / sens
      const next = this.valueFromNorm(startNorm + deltaNorm)
      this.emitUserValue(next)
    })

    const endDrag = (e: PointerEvent) => {
      if (!this._dragging) return
      this._dragging = false
      this.root.classList.remove('dragging')
      try {
        this.dial.releasePointerCapture(e.pointerId)
      } catch {
        /* noop */
      }
    }
    this.dial.addEventListener('pointerup', endDrag)
    this.dial.addEventListener('pointercancel', endDrag)

    this.dial.addEventListener('dblclick', (e) => {
      e.preventDefault()
      this.emitUserValue(this.defaultValue)
    })

    // Right-click / two-finger trackpad tap: instant Isolator Kill (EQ) or Flat Reset!
    this.dial.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.bipolar && this.min <= -20) {
        // DJ EQ isolator kill toggle: full kill (-26 dB) ↔ flat (0.0 dB)
        this.emitUserValue(this._value <= this.min + 1 ? this.defaultValue : this.min)
      } else {
        this.emitUserValue(this.defaultValue)
      }
    })

    this.dial.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        // Smooth proportional trackpad glide (MacBook Force Touch) while keeping mouse wheel steps crisp
        const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? -e.deltaY : e.deltaX
        const scale = e.shiftKey ? 0.0008 : 0.0028
        const deltaNorm = Math.max(-0.08, Math.min(0.08, raw * scale))
        const next = this.valueFromNorm(this.normOf(this._value) + deltaNorm)
        this.emitUserValue(next)
      },
      { passive: false }
    )

    this.dial.addEventListener('keydown', (e) => {
      let handled = true
      const frac = e.shiftKey ? 0.015 : 0.05
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        this.emitUserValue(this.valueFromNorm(this.normOf(this._value) + frac))
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        this.emitUserValue(this.valueFromNorm(this.normOf(this._value) - frac))
      } else if (e.key === 'Home') {
        this.emitUserValue(this.defaultValue)
      } else {
        handled = false
      }
      if (handled) e.preventDefault()
    })
  }
}

export function createBoeingKnob(opts: KnobOptions): BoeingKnob {
  return new BoeingKnob(opts)
}
