/**
 * Custom Teenage Engineering × Boeing 737 Hardware Tooltip Overlay
 *
 * Automatically intercepts every native `[title]` (and `[data-tip]`) element
 * across the app — suppressing default OS hover bubbles and rendering crisp,
 * theme-aware Geist Mono placards with Deck A/B accent bars and two-tier
 * primary/hint formatting.
 */

export function initCustomTooltips(): void {
  const tip = document.createElement('div')
  tip.className = 'te-tooltip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true

  const mainLine = document.createElement('div')
  mainLine.className = 'te-tip-main'
  const subLine = document.createElement('div')
  subLine.className = 'te-tip-sub'
  tip.append(mainLine, subLine)
  document.body.append(tip)

  let activeEl: HTMLElement | null = null
  let showTimer: number | null = null
  let lastX = 0
  let lastY = 0

  const cancelTimer = () => {
    if (showTimer != null) {
      window.clearTimeout(showTimer)
      showTimer = null
    }
  }

  const hide = () => {
    cancelTimer()
    activeEl = null
    tip.hidden = true
  }

  const readTip = (el: HTMLElement): string => {
    const rawTitle = el.getAttribute('title')
    if (rawTitle) {
      el.dataset.tip = rawTitle
      el.removeAttribute('title')
      return rawTitle
    }
    return el.dataset.tip ?? ''
  }

  const findTarget = (node: EventTarget | null): HTMLElement | null => {
    let cur = node instanceof Element ? node : null
    while (cur && cur instanceof HTMLElement) {
      if (cur.hasAttribute('title') || cur.dataset.tip) {
        const txt = readTip(cur)
        if (txt.trim()) return cur
      }
      cur = cur.parentElement
    }
    return null
  }

  const position = (el: HTMLElement, cx: number, cy: number) => {
    const pad = 8
    const tw = tip.offsetWidth
    const th = tip.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const rect = el.getBoundingClientRect()

    // Anchor neatly above or below small controls; follow cursor on wide canvases/lists
    const useAnchor = rect.width < 260 && rect.height < 90
    let x = useAnchor ? rect.left + rect.width / 2 - tw / 2 : cx + 12
    let y = useAnchor ? rect.top - th - 8 : cy - th - 12

    if (y < pad) y = useAnchor ? rect.bottom + 8 : cy + 16
    if (y + th > vh - pad) y = Math.max(pad, vh - th - pad)
    x = Math.max(pad, Math.min(vw - tw - pad, x))

    tip.style.left = `${Math.round(x)}px`
    tip.style.top = `${Math.round(y)}px`
  }

  const showFor = (el: HTMLElement) => {
    const text = readTip(el).trim()
    if (!text) {
      hide()
      return
    }
    const parts = text.split(/\s+·\s+/)
    mainLine.textContent = parts[0]
    if (parts.length > 1) {
      subLine.textContent = parts.slice(1).join('  ·  ')
      subLine.hidden = false
    } else {
      subLine.textContent = ''
      subLine.hidden = true
    }

    const deckEl = el.closest<HTMLElement>('.deck')
    tip.dataset.deck = deckEl?.dataset.deck ?? ''
    tip.hidden = false
    position(el, lastX, lastY)
  }

  document.addEventListener('pointerover', (e) => {
    const target = findTarget(e.target)
    if (!target) {
      hide()
      return
    }
    lastX = e.clientX
    lastY = e.clientY
    if (target === activeEl) return
    activeEl = target
    cancelTimer()
    // Fast snappier handoff if tooltip was already open on a neighboring button
    const delay = tip.hidden ? 240 : 60
    showTimer = window.setTimeout(() => {
      if (activeEl === target) showFor(target)
    }, delay)
  })

  document.addEventListener('pointermove', (e) => {
    lastX = e.clientX
    lastY = e.clientY
    if (!tip.hidden && activeEl) {
      const rect = activeEl.getBoundingClientRect()
      if (rect.width >= 260 || rect.height >= 90) {
        position(activeEl, lastX, lastY)
      }
    }
  })

  document.addEventListener('pointerout', (e) => {
    if (!activeEl) return
    const next = findTarget(e.relatedTarget)
    if (next !== activeEl) hide()
  })

  document.addEventListener('pointerdown', hide, { capture: true })
  document.addEventListener('wheel', hide, { passive: true, capture: true })
  window.addEventListener('blur', hide)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide()
  })
}
