import { createBoeingKnob, type BoeingKnob } from './knob'

export interface DeckRefs {
  root: HTMLElement
  name: HTMLElement
  statusBadge: HTMLElement
  fpTags: HTMLElement
  spinIcon: HTMLElement
  barBeat: HTMLElement
  phraseCd: HTMLElement
  pos: HTMLElement
  rem: HTMLElement
  bpm: HTMLElement
  origBpm: HTMLElement
  pitchBadge: HTMLButtonElement
  keyCamelot: HTMLElement
  keyName: HTMLElement
  keylockBtn: HTMLButtonElement
  syncBtn: HTMLButtonElement
  vuCanvas: HTMLCanvasElement
  overview: HTMLCanvasElement
  waveform: HTMLCanvasElement
  bpbBtn: HTMLButtonElement
  phraseBtn: HTMLButtonElement
  autoCuesBtn: HTMLButtonElement
  getStemsBtn: HTMLButtonElement
  wfRgbBtn: HTMLButtonElement
  wfBandsBtn: HTMLButtonElement
  wfStemsBtn: HTMLButtonElement
  zoomOutBtn: HTMLButtonElement
  zoomInBtn: HTMLButtonElement
  zoomVal: HTMLElement
  rate: HTMLInputElement
  rateVal: HTMLElement
  rateResetBtn: HTMLButtonElement
  playBtn: HTMLButtonElement
  cueBtn: HTMLButtonElement
  hotcueBtns: HTMLButtonElement[]
  stemsBox: HTMLElement
  stemMuteBtns: HTMLButtonElement[]
  stemSliders: HTMLInputElement[]
  eqLow: BoeingKnob
  eqMid: BoeingKnob
  eqHigh: BoeingKnob
  filter: BoeingKnob
  wet: BoeingKnob
  fb: BoeingKnob
  vol: BoeingKnob
  trim: BoeingKnob
  delayBtn: HTMLButtonElement
  fracBtn: HTMLButtonElement
  reverbBtn: HTMLButtonElement
  echoBtn: HTMLButtonElement
  cueMixBtn: HTMLButtonElement
  loopBtns: HTMLButtonElement[]
  loopLatchBtn: HTMLButtonElement
  loopExitBtn: HTMLButtonElement
  jumpSizeBtn: HTMLButtonElement
}

export interface AppRefs {
  deckA: DeckRefs
  deckB: DeckRefs
  xfader: HTMLInputElement
  master: BoeingKnob
  masterVu: HTMLCanvasElement
  splitCueBtn: HTMLButtonElement
  autoGainBtn: HTMLButtonElement
  recBtn: HTMLButtonElement
  samplerPads: HTMLButtonElement[]
  samplerVol: BoeingKnob
  themeBtn: HTMLButtonElement
  importBar: HTMLElement
  importFill: HTMLElement
  importText: HTMLElement
  dropOverlay: HTMLElement
  memMeter: HTMLElement
  envSetup: HTMLElement
  envInstallBtn: HTMLButtonElement
  envInstallStemsBtn: HTMLButtonElement
  crateQuery: HTMLInputElement
  crateSort: HTMLSelectElement
  crateList: HTMLUListElement
  crateCount: HTMLElement
  midiDevices: HTMLElement
  midiActions: HTMLElement
  midiWizard: HTMLButtonElement
  midiKo2: HTMLButtonElement
  midiWatch: HTMLButtonElement
  midiFaderLearn: HTMLButtonElement
  midiFaderTarget: HTMLSelectElement
  midiWizardStatus: HTMLElement
  tabCopilot: HTMLButtonElement
  tabPlanner: HTMLButtonElement
  tabStream: HTMLButtonElement
  copilotPane: HTMLElement
  plannerPane: HTMLElement
  streamPane: HTMLElement
  vibeBtns: HTMLButtonElement[]
  planBox: HTMLElement
  nextList: HTMLUListElement
  arcBtns: HTMLButtonElement[]
  planAltBtn: HTMLButtonElement
  planBreakBtn: HTMLButtonElement
  planSummary: HTMLElement
  planList: HTMLUListElement
  streamStatus: HTMLElement
  scConnect: HTMLButtonElement
  scQuery: HTMLInputElement
  streamResults: HTMLUListElement
  log: HTMLElement
  addBtn: HTMLButtonElement
}

// Crisp Teenage Engineering–style geometric inline SVG glyphs
export const ICO_PLAY = `<svg class="ico ico-lg" viewBox="0 0 12 12"><polygon points="2.5,1.5 11,6 2.5,10.5" fill="currentColor"/></svg>`
export const ICO_PAUSE = `<svg class="ico ico-lg" viewBox="0 0 12 12"><rect x="2.2" y="1.8" width="2.8" height="8.4" fill="currentColor"/><rect x="7" y="1.8" width="2.8" height="8.4" fill="currentColor"/></svg>`
const ICO_CUE = `<svg class="ico ico-lg" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/></svg>`
const ICO_FLAG = `<svg class="ico" viewBox="0 0 12 12"><path d="M2.5 10.5V1.8h6.5l-1.8 2.4 1.8 2.4H2.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`
const ICO_LOCK = `<svg class="ico" viewBox="0 0 12 12"><rect x="2.2" y="5.2" width="7.6" height="5.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`
const ICO_SYNC = `<svg class="ico" viewBox="0 0 12 12"><path d="M1.5 6h9M3.8 3.5 1.5 6l2.3 2.5M8.2 3.5 10.5 6 8.2 8.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`
const ICO_PFL = `<svg class="ico ico-md" viewBox="0 0 12 12"><path d="M2 7.5V6a4 4 0 0 1 8 0v1.5" fill="none" stroke="currentColor" stroke-width="1.35"/><rect x="1.4" y="6.6" width="2.3" height="3.8" fill="currentColor"/><rect x="8.3" y="6.6" width="2.3" height="3.8" fill="currentColor"/></svg>`
const ICO_REEL = `<svg class="ico reel-svg" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="1.6" fill="currentColor"/><line x1="7" y1="1.8" x2="7" y2="4.4" stroke="currentColor" stroke-width="1.3"/><line x1="2.4" y1="9.6" x2="4.7" y2="8.3" stroke="currentColor" stroke-width="1.3"/><line x1="11.6" y1="9.6" x2="9.3" y2="8.3" stroke="currentColor" stroke-width="1.3"/></svg>`
const ICO_X = `<svg class="ico" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3L3 9" stroke="currentColor" stroke-width="1.5"/></svg>`
const ICO_ECHO = `<svg class="ico" viewBox="0 0 12 12"><circle cx="3" cy="6" r="2.2" fill="currentColor"/><circle cx="7.2" cy="6" r="1.5" fill="currentColor" opacity="0.65"/><circle cx="10.4" cy="6" r="1" fill="currentColor" opacity="0.38"/></svg>`
const ICO_DLY = `<svg class="ico" viewBox="0 0 12 12"><rect x="1.5" y="2.5" width="2" height="7" fill="currentColor"/><rect x="5" y="4" width="2" height="5.5" fill="currentColor" opacity="0.7"/><rect x="8.5" y="5.8" width="2" height="3.7" fill="currentColor" opacity="0.45"/></svg>`
const ICO_VRB = `<svg class="ico" viewBox="0 0 12 12"><path d="M1.5 9.5L4 2.5l2.5 5 2-2.5 2 4.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`
const ICO_STEMS = `<svg class="ico" viewBox="0 0 12 12"><rect x="1" y="1.5" width="10" height="1.6" fill="#d97706"/><rect x="1" y="4.2" width="10" height="1.6" fill="#e11d48"/><rect x="1" y="6.9" width="10" height="1.6" fill="#0284c7"/><rect x="1" y="9.6" width="10" height="1.6" fill="#7c3aed"/></svg>`
const ICO_JUMP_L = `<svg class="ico" viewBox="0 0 12 12"><polygon points="6,2.2 1.5,6 6,9.8" fill="currentColor"/><polygon points="10.5,2.2 6,6 10.5,9.8" fill="currentColor"/></svg>`
const ICO_JUMP_R = `<svg class="ico" viewBox="0 0 12 12"><polygon points="1.5,2.2 6,6 1.5,9.8" fill="currentColor"/><polygon points="6,2.2 10.5,6 6,9.8" fill="currentColor"/></svg>`
const ICO_REC = `<svg class="ico" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2" fill="#e11d48"/></svg>`
const ICO_GAIN = `<svg class="ico" viewBox="0 0 12 12"><path d="M1.5 8.5h2V5h2v3.5h2V3h2v5.5h1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`

const DECK_TEMPLATE = (id: 'A' | 'B') => `
  <div class="deck-head">
    <span class="deck-badge">${id}</span>
    <span class="reel-indicator" title="Deck transport spin">${ICO_REEL}</span>
    <span class="track-name">— empty deck —</span>
    <span class="deck-status" hidden></span>
    <span class="fp-tags" hidden title="Acoustic fingerprint: sub anatomy · groove · swing"></span>
    <span class="phrase-cd" hidden title="Current section & bars.beats until next transition"></span>
    <span class="bar-beat" title="Current Bar.Beat from Measure 1">—</span>
    <span class="time-group">
      <span class="pos">0:00.0</span>
      <span class="rem">-0:00.0</span>
    </span>
  </div>

  <div class="deck-hud">
    <div class="hud-lcd bpm-card">
      <div class="hud-main">
        <span class="note-glyph" aria-hidden="true">♩</span>
        <span class="bpm" title="Live playback BPM">–.–</span>
        <span class="hud-unit">BPM</span>
      </div>
      <div class="hud-sub">
        <span class="orig-bpm" title="Original track tempo">ORIG ♩ –.–</span>
        <button class="pitch-badge" title="Click to reset pitch to 0.00%">+0.00%</button>
      </div>
    </div>

    <div class="hud-lcd key-card">
      <div class="hud-key-row">
        <span class="key-camelot" title="Camelot harmonic key">—</span>
        <div class="key-meta">
          <span class="hud-cap">𝄞 KEY</span>
          <span class="key-name">—</span>
        </div>
      </div>
      <button class="hud-btn keylock" data-act="deck${id}.keylock" title="Lock musical key while changing tempo">${ICO_LOCK} KEY</button>
    </div>

    <div class="hud-lcd vu-card" title="Live channel spectrum & RMS/clip meter">
      <canvas class="vu-canvas"></canvas>
    </div>

    <div class="hud-actions">
      <button class="hud-btn sync" data-act="deck${id}.sync" title="Match BPM & phase + drift lock">${ICO_SYNC} SYNC</button>
      <button class="hud-btn cuemix" data-act="deck${id}.cueMix" title="Headphone cue pre-listen (split-cue mode)">${ICO_PFL}</button>
    </div>
  </div>

  <div class="visuals">
    <div class="overview-box" title="Full-track overview — click any section ribbon block to jump, hover to measure bars">
      <canvas class="overview"></canvas>
    </div>

    <div class="grid-bar">
      <div class="grid-group">
        <span class="bar-label">((GRID))</span>
        <button class="mini-btn accent-gold" data-act="deck${id}.setBar1" title="Anchor Bar 1, Beat 1 at current playhead">${ICO_FLAG} 1</button>
        <button class="mini-btn" data-act="deck${id}.beatLeft" title="Shift measure downbeat 1 beat earlier">◀1</button>
        <button class="mini-btn" data-act="deck${id}.beatRight" title="Shift measure downbeat 1 beat later">1▶</button>
        <button class="mini-btn" data-act="deck${id}.nudgeBack" title="Nudge beatgrid -10ms">-ms</button>
        <button class="mini-btn" data-act="deck${id}.nudgeFwd" title="Nudge beatgrid +10ms">+ms</button>
        <button class="mini-btn" data-act="deck${id}.bpmHalf" title="Halve BPM">½×</button>
        <button class="mini-btn" data-act="deck${id}.bpmDouble" title="Double BPM">2×</button>
        <button class="mini-btn bpb-btn" data-act="deck${id}.beatsPerBar" title="Beats per measure">4/4</button>
        <button class="mini-btn phrase-btn" data-act="deck${id}.phraseBars" title="Phrase block size on overview">8B</button>
        <button class="mini-btn auto-cues-btn" title="Drop Hot Cues 1–4 onto Intro / Drop 1 / Break / Drop 2">AUTO CUES</button>
        <button class="mini-btn get-stems-btn" hidden title="Separate Drums / Bass / Other / Vocals via Demucs">${ICO_STEMS} STEMS</button>
      </div>
      <div class="grid-group wf-controls">
        <div class="seg-group" role="group" aria-label="Waveform mode">
          <button class="seg-btn wf-rgb active" title="Unified 3-band RGB frequency waveform">RGB</button>
          <button class="seg-btn wf-bands" title="Separated Low / Mid / High lanes">3-BAND</button>
          <button class="seg-btn wf-stems" disabled title="Separated Drums / Bass / Other / Vocals lanes">${ICO_STEMS} STEMS</button>
        </div>
        <button class="mini-btn zoom-out" title="Zoom out">−</button>
        <span class="zoom-val">10s</span>
        <button class="mini-btn zoom-in" title="Zoom in">+</button>
      </div>
    </div>

    <div class="waveform-box" title="Close-up scrolling waveform — drag to scrub, wheel to zoom">
      <canvas class="waveform"></canvas>
    </div>
  </div>

  <div class="row rate-row">
    <span class="sec-lab">PITCH</span>
    <input class="rate" type="range" min="-8" max="8" step="0.05" value="0" title="Double-click to reset" />
    <span class="rate-val">+0.00%</span>
    <button class="mini-btn rate-rst" title="Reset pitch to original tempo">0%</button>
  </div>

  <div class="stems-row" hidden>
    <div class="stem stem-drums">
      <button class="stem-pill" data-stem="0" title="Click mute · Shift+click solo">DRM</button>
      <input type="range" min="0" max="1" step="0.01" value="1" />
    </div>
    <div class="stem stem-bass">
      <button class="stem-pill" data-stem="1" title="Click mute · Shift+click solo">BAS</button>
      <input type="range" min="0" max="1" step="0.01" value="1" />
    </div>
    <div class="stem stem-other">
      <button class="stem-pill" data-stem="2" title="Click mute · Shift+click solo">OTH</button>
      <input type="range" min="0" max="1" step="0.01" value="1" />
    </div>
    <div class="stem stem-vocals">
      <button class="stem-pill" data-stem="3" title="Click mute · Shift+click solo">VOX</button>
      <input type="range" min="0" max="1" step="0.01" value="1" />
    </div>
  </div>

  <div class="perf-section">
    <div class="transport">
      <button class="t-btn play" data-act="deck${id}.play">${ICO_PLAY}<span>PLAY</span></button>
      <button class="t-btn cue" data-act="deck${id}.cue">${ICO_CUE}<span>CUE</span></button>
      <button class="t-btn set-cue" data-act="deck${id}.setCue" title="Set main CUE at playhead">${ICO_FLAG}<span>SET</span></button>
    </div>

    <div class="row hotcue-row">
      <span class="sec-lab">CUES</span>
      <button class="hc hc1" data-act="deck${id}.hotcue1"><span class="hc-num">1</span><span class="hc-time">—</span></button>
      <button class="hc hc2" data-act="deck${id}.hotcue2"><span class="hc-num">2</span><span class="hc-time">—</span></button>
      <button class="hc hc3" data-act="deck${id}.hotcue3"><span class="hc-num">3</span><span class="hc-time">—</span></button>
      <button class="hc hc4" data-act="deck${id}.hotcue4"><span class="hc-num">4</span><span class="hc-time">—</span></button>
      <span class="hc-hint">⇧set · ⌥clr</span>
    </div>

    <div class="row loop-jump-row">
      <span class="sec-lab music-sym" title="Beat Loop Rolls">𝄆 𝄇</span>
      <button class="t-btn loop loop1" data-act="deck${id}.loop1" title="1-beat loop roll (hold)">1</button>
      <button class="t-btn loop loop2" data-act="deck${id}.loop2" title="2-beat loop roll (hold)">2</button>
      <button class="t-btn loop loop4" data-act="deck${id}.loop4" title="4-beat loop roll (hold)">4</button>
      <button class="t-btn loop loop8" data-act="deck${id}.loop8" title="8-beat loop roll (hold)">8</button>
      <button class="t-btn loop-latch" data-act="deck${id}.loopLatch" title="Latching loops instead of momentary rolls">${ICO_LOCK} LATCH</button>
      <button class="t-btn loop-exit" data-act="deck${id}.loopExit" title="Exit active loop">${ICO_X}</button>
      <span class="row-sep"></span>
      <button class="t-btn jump jb" data-act="deck${id}.jumpBack" title="Beat jump back">${ICO_JUMP_L}</button>
      <button class="t-btn jump-size" data-act="deck${id}.jumpSize" title="Jump size in beats">4</button>
      <button class="t-btn jump jf" data-act="deck${id}.jumpFwd" title="Beat jump forward">${ICO_JUMP_R}</button>
    </div>
  </div>

  <div class="mix-section">
    <div class="row eq-row"></div>
    <div class="row fx-row">
      <span class="sec-lab">FX</span>
      <button class="t-btn fx delay" data-act="deck${id}.delay">${ICO_DLY} DLY</button>
      <button class="t-btn fx frac" data-act="deck${id}.delayFrac">♪ 1/2</button>
      <div class="fx-knobs"></div>
      <button class="t-btn fx reverb" data-act="deck${id}.reverb">${ICO_VRB} VRB</button>
      <button class="t-btn fx echo" data-act="deck${id}.echoOut">${ICO_ECHO} ECHO</button>
    </div>
  </div>
`

function fmtDb(v: number): string {
  if (Math.abs(v) < 0.05) return '0.0'
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function fmtEq(v: number): string {
  if (v <= -25.5) return 'KILL'
  return fmtDb(v)
}

function fmtFlt(v: number): string {
  if (Math.abs(v) < 0.03) return 'FLAT'
  return v < 0 ? `LP ${Math.round(-v * 100)}%` : `HP ${Math.round(v * 100)}%`
}

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`
}

function buildDeck(id: 'A' | 'B'): DeckRefs {
  const root = document.createElement('section')
  root.className = 'deck'
  root.dataset.deck = id
  root.innerHTML = DECK_TEMPLATE(id)
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T

  const deckAccent = id === 'A' ? 'var(--deck-a)' : 'var(--deck-b)'
  const trim = createBoeingKnob({
    label: 'TRM',
    min: -12,
    max: 12,
    step: 0.5,
    value: 0,
    bipolar: true,
    variant: 'pointer',
    size: 42,
    accent: deckAccent,
    title: 'Input trim (-12..+12 dB)',
    format: fmtDb
  })
  const eqLow = createBoeingKnob({
    label: 'LO',
    min: -26,
    max: 6,
    step: 0.5,
    value: 0,
    bipolar: true,
    variant: 'pointer',
    size: 42,
    accent: deckAccent,
    title: 'Low EQ (-26..+6 dB)',
    format: fmtEq
  })
  const eqMid = createBoeingKnob({
    label: 'MID',
    min: -26,
    max: 6,
    step: 0.5,
    value: 0,
    bipolar: true,
    variant: 'pointer',
    size: 42,
    accent: deckAccent,
    title: 'Mid EQ (-26..+6 dB)',
    format: fmtEq
  })
  const eqHigh = createBoeingKnob({
    label: 'HI',
    min: -26,
    max: 6,
    step: 0.5,
    value: 0,
    bipolar: true,
    variant: 'pointer',
    size: 42,
    accent: deckAccent,
    title: 'High EQ (-26..+6 dB)',
    format: fmtEq
  })
  const filter = createBoeingKnob({
    label: 'FLT',
    min: -1,
    max: 1,
    step: 0.01,
    value: 0,
    bipolar: true,
    variant: 'wedge',
    size: 44,
    lowAccent: 'var(--te-blue)',
    highAccent: 'var(--te-orange)',
    title: 'DJ Filter (LP ← 0 → HP)',
    format: fmtFlt,
    className: 'flt-lab'
  })
  const vol = createBoeingKnob({
    label: 'VOL',
    min: 0,
    max: 1,
    step: 0.01,
    value: 1,
    defaultValue: 1,
    variant: 'scalloped',
    size: 42,
    accent: deckAccent,
    title: 'Channel Volume',
    format: fmtPct
  })
  q('.eq-row').append(trim.root, eqLow.root, eqMid.root, eqHigh.root, filter.root, vol.root)

  const wet = createBoeingKnob({
    label: 'WET',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.55,
    defaultValue: 0.55,
    variant: 'scalloped',
    size: 34,
    accent: 'var(--te-violet)',
    title: 'Delay Wet Level',
    format: fmtPct,
    className: 'compact'
  })
  const fb = createBoeingKnob({
    label: 'FB',
    min: 0,
    max: 0.9,
    step: 0.01,
    value: 0.5,
    defaultValue: 0.5,
    variant: 'scalloped',
    size: 34,
    accent: 'var(--te-rose)',
    title: 'Delay Feedback',
    format: (v) => `${Math.round((v / 0.9) * 100)}%`,
    className: 'compact'
  })
  q('.fx-knobs').append(wet.root, fb.root)

  return {
    root,
    name: q('.track-name'),
    statusBadge: q('.deck-status'),
    fpTags: q('.fp-tags'),
    spinIcon: q('.reel-indicator'),
    barBeat: q('.bar-beat'),
    phraseCd: q('.phrase-cd'),
    pos: q('.pos'),
    rem: q('.rem'),
    bpm: q('.bpm'),
    origBpm: q('.orig-bpm'),
    pitchBadge: q('.pitch-badge'),
    keyCamelot: q('.key-camelot'),
    keyName: q('.key-name'),
    keylockBtn: q('.keylock'),
    syncBtn: q('.sync'),
    vuCanvas: q('.vu-canvas'),
    overview: q('.overview'),
    waveform: q('.waveform'),
    bpbBtn: q('.bpb-btn'),
    phraseBtn: q('.phrase-btn'),
    autoCuesBtn: q('.auto-cues-btn'),
    getStemsBtn: q('.get-stems-btn'),
    wfRgbBtn: q('.wf-rgb'),
    wfBandsBtn: q('.wf-bands'),
    wfStemsBtn: q('.wf-stems'),
    zoomOutBtn: q('.zoom-out'),
    zoomInBtn: q('.zoom-in'),
    zoomVal: q('.zoom-val'),
    rate: q('.rate'),
    rateVal: q('.rate-val'),
    rateResetBtn: q('.rate-rst'),
    playBtn: q('.play'),
    cueBtn: q('.cue'),
    hotcueBtns: [1, 2, 3, 4].map((n) => q(`.hc${n}`)),
    stemsBox: q('.stems-row'),
    stemMuteBtns: Array.from(root.querySelectorAll<HTMLButtonElement>('.stem-pill')),
    stemSliders: Array.from(root.querySelectorAll<HTMLInputElement>('.stem input')),
    eqLow,
    eqMid,
    eqHigh,
    filter,
    wet,
    fb,
    vol,
    trim,
    delayBtn: q('.delay'),
    fracBtn: q('.frac'),
    reverbBtn: q('.reverb'),
    echoBtn: q('.echo'),
    cueMixBtn: q('.cuemix'),
    loopBtns: [1, 2, 4, 8].map((n) => q(`.loop${n}`)),
    loopLatchBtn: q('.loop-latch'),
    loopExitBtn: q('.loop-exit'),
    jumpSizeBtn: q('.jump-size')
  }
}

export function buildApp(root: HTMLElement): AppRefs {
  root.innerHTML = ''

  const header = document.createElement('header')
  const addBtn = document.createElement('button')
  addBtn.className = 'add-btn'
  addBtn.textContent = '+ ADD / FOLDER'
  addBtn.title = 'Add audio files or an entire folder to your crate'
  header.innerHTML = `
    <div class="brand">
      <span class="brand-tag">EP–133</span>
      <h1>vibedeck</h1>
      <span class="brand-ver">v1.4</span>
    </div>
    <span class="hint">drop tracks or folders anywhere · click arrangement blocks to jump</span>
    <span class="mem-meter"></span>
    <span class="env-setup" hidden>
      <button class="env-install">INSTALL ENV</button>
      <button class="env-install-stems" title="adds demucs + torch (~2 GB, one time)">+ STEMS</button>
    </span>
    <button class="theme-btn" title="Switch chassis finish: EP–133 Putty / Dark Booth">DARK</button>`
  header.append(addBtn)

  const importBar = document.createElement('div')
  importBar.className = 'import-bar'
  importBar.hidden = true
  importBar.innerHTML = '<div class="import-fill"></div><span class="import-text"></span>'

  const dropOverlay = document.createElement('div')
  dropOverlay.className = 'drop-overlay'
  dropOverlay.hidden = true
  dropOverlay.innerHTML = '<div class="drop-card">DROP AUDIO FILES OR FOLDER TO IMPORT</div>'

  const main = document.createElement('main')
  const deckA = buildDeck('A')
  const deckB = buildDeck('B')

  const mixer = document.createElement('section')
  mixer.className = 'mixer'
  mixer.innerHTML = `
    <div class="panel-title mixer-title">((MIXER))</div>
    <div class="master-vu-box" title="Live master bus VU & clip indicator">
      <canvas class="master-vu"></canvas>
    </div>
    <div class="xf-row"><span class="xf-a">A</span><input class="xfader" type="range" min="0" max="1" step="0.01" value="0.5" /><span class="xf-b">B</span></div>
    <button class="t-btn xf-center" data-act="mix.crossCenter">CENTER</button>
    <div class="mixer-toggles">
      <button class="t-btn split-cue" data-act="mix.splitCue" title="master on ch 1/2, headphone cue on ch 3/4">${ICO_PFL} SPLIT CUE</button>
      <button class="t-btn auto-gain" data-act="mix.autoGain" title="normalize tracks to ${-14} LUFS via trim on load">${ICO_GAIN} AUTO GAIN</button>
      <button class="t-btn rec-btn" data-act="mix.record" title="record master bus to ~/Music/vibedeck/">${ICO_REC} REC</button>
    </div>
    <div class="mixer-knobs"></div>
    <div class="sampler-box">
      <div class="panel-title">((SAMPLER)) <span class="sampler-hint">drop · ⌥clr</span></div>
      <div class="sampler-pads">
        ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<button class="smp" data-act="sampler.pad${n}">${n}</button>`).join('\n        ')}
      </div>
    </div>`

  const masterKnob = createBoeingKnob({
    label: 'MASTER',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.85,
    defaultValue: 0.85,
    variant: 'wedge',
    size: 52,
    accent: 'var(--te-orange)',
    title: 'Master Output Gain',
    format: fmtPct
  })
  const samplerKnob = createBoeingKnob({
    label: 'SAMPLER',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.9,
    defaultValue: 0.9,
    variant: 'scalloped',
    size: 46,
    accent: 'var(--te-yellow)',
    title: 'Sampler Bus Level',
    format: fmtPct
  })
  ;(mixer.querySelector('.mixer-knobs') as HTMLElement).append(masterKnob.root, samplerKnob.root)

  main.append(deckA.root, mixer, deckB.root)

  const footer = document.createElement('footer')
  footer.innerHTML = `
    <section class="crate">
      <div class="panel-title">((CRATE)) <span class="crate-count"></span></div>
      <div class="crate-tools">
        <input class="crate-q" type="text" placeholder="search name, bpm, key…" />
        <select class="crate-sort">
          <option value="name">name</option>
          <option value="bpm">bpm</option>
          <option value="key">key</option>
          <option value="recent">recent</option>
        </select>
      </div>
      <ul class="crate-list"></ul>
    </section>
    <section class="stream-panel copilot-panel">
      <div class="panel-tabs">
        <button class="tab-btn tab-copilot active">((CO-PILOT))</button>
        <button class="tab-btn tab-planner">((SET PLAN))</button>
        <button class="tab-btn tab-stream">STREAM <span class="stream-status"></span></button>
        <div class="vibe-pills">
          <button class="vibe-btn active" data-vibe="flow" title="Match energy & groove">FLOW</button>
          <button class="vibe-btn" data-vibe="lift" title="Step up energy">LIFT</button>
          <button class="vibe-btn" data-vibe="chill" title="Bring energy down">CHILL</button>
        </div>
      </div>
      <div class="copilot-pane">
        <div class="plan-box"></div>
        <ul class="next-list"></ul>
      </div>
      <div class="planner-pane" hidden>
        <div class="planner-bar">
          <button class="arc-btn active" data-arc="arc" title="Warmup → Peak → Cooldown">ARC</button>
          <button class="arc-btn" data-arc="climb" title="Steady Climb">CLIMB</button>
          <button class="arc-btn" data-arc="festival" title="Two-Peak Festival">2-PEAK</button>
          <button class="mini-btn plan-break" title="Allow intentional echo-out genre/tempo resets (includes hip-hop pockets)">GENRE BRK</button>
          <button class="mini-btn plan-alt" title="Solve an alternate no-repeat path">ALT</button>
        </div>
        <div class="plan-summary"></div>
        <ul class="plan-list"></ul>
      </div>
      <div class="stream-pane" hidden>
        <div class="stream-controls"><button class="sc-connect">connect SoundCloud</button></div>
        <div class="stream-search"><input class="sc-q" type="text" placeholder="search SoundCloud… ⏎" /></div>
        <ul class="stream-results"></ul>
      </div>
    </section>
    <section class="midi-panel">
      <div class="panel-title">((MIDI)) <span class="midi-devices"></span></div>
      <div class="midi-tools">
        <button class="midi-wizard">AUTO-MAP</button>
        <button class="midi-ko2">K.O. II PRESET</button>
        <button class="midi-watch">WATCH</button>
      </div>
      <div class="midi-fader-row" title="Bind your K.O. II bottom-left fader once, then flip what it controls anytime">
        <button class="midi-fader-learn">FADER</button>
        <span class="midi-fader-arrow">→</span>
        <select class="midi-fader-target">
          <option value="mix.master">Master Volume</option>
          <option value="mix.crossfade">Crossfader (A ↔ B)</option>
          <option value="active.volume">Active Deck Volume</option>
          <option value="active.tempo">Active Deck BPM / Tempo</option>
          <option value="active.filter">Active Deck Filter</option>
          <option value="active.eqLow">Active Deck Low EQ</option>
          <option value="deckA.volume">Deck A Volume</option>
          <option value="deckB.volume">Deck B Volume</option>
          <option value="deckA.tempo">Deck A BPM / Tempo</option>
          <option value="deckB.tempo">Deck B BPM / Tempo</option>
          <option value="deckA.filter">Deck A Filter</option>
          <option value="deckB.filter">Deck B Filter</option>
          <option value="sampler.volume">Sampler Volume</option>
        </select>
      </div>
      <div class="midi-wizard-status"></div>
      <div class="midi-actions"></div>
    </section>
    <section class="log">
      <div class="panel-title">((LOG))</div>
      <div class="log-lines"></div>
    </section>`

  root.append(header, importBar, main, footer, dropOverlay)

  return {
    deckA,
    deckB,
    xfader: mixer.querySelector('.xfader') as HTMLInputElement,
    master: masterKnob,
    masterVu: mixer.querySelector('.master-vu') as HTMLCanvasElement,
    splitCueBtn: mixer.querySelector('.split-cue') as HTMLButtonElement,
    autoGainBtn: mixer.querySelector('.auto-gain') as HTMLButtonElement,
    recBtn: mixer.querySelector('.rec-btn') as HTMLButtonElement,
    samplerPads: Array.from(mixer.querySelectorAll<HTMLButtonElement>('.smp')),
    samplerVol: samplerKnob,
    themeBtn: header.querySelector('.theme-btn') as HTMLButtonElement,
    importBar,
    importFill: importBar.querySelector('.import-fill') as HTMLElement,
    importText: importBar.querySelector('.import-text') as HTMLElement,
    dropOverlay,
    memMeter: header.querySelector('.mem-meter') as HTMLElement,
    envSetup: header.querySelector('.env-setup') as HTMLElement,
    envInstallBtn: header.querySelector('.env-install') as HTMLButtonElement,
    envInstallStemsBtn: header.querySelector('.env-install-stems') as HTMLButtonElement,
    crateList: footer.querySelector('.crate-list') as HTMLUListElement,
    crateCount: footer.querySelector('.crate-count') as HTMLElement,
    crateQuery: footer.querySelector('.crate-q') as HTMLInputElement,
    crateSort: footer.querySelector('.crate-sort') as HTMLSelectElement,
    midiDevices: footer.querySelector('.midi-devices') as HTMLElement,
    midiActions: footer.querySelector('.midi-actions') as HTMLElement,
    midiWizard: footer.querySelector('.midi-wizard') as HTMLButtonElement,
    midiKo2: footer.querySelector('.midi-ko2') as HTMLButtonElement,
    midiWatch: footer.querySelector('.midi-watch') as HTMLButtonElement,
    midiFaderLearn: footer.querySelector('.midi-fader-learn') as HTMLButtonElement,
    midiFaderTarget: footer.querySelector('.midi-fader-target') as HTMLSelectElement,
    midiWizardStatus: footer.querySelector('.midi-wizard-status') as HTMLElement,
    tabCopilot: footer.querySelector('.tab-copilot') as HTMLButtonElement,
    tabPlanner: footer.querySelector('.tab-planner') as HTMLButtonElement,
    tabStream: footer.querySelector('.tab-stream') as HTMLButtonElement,
    copilotPane: footer.querySelector('.copilot-pane') as HTMLElement,
    plannerPane: footer.querySelector('.planner-pane') as HTMLElement,
    streamPane: footer.querySelector('.stream-pane') as HTMLElement,
    vibeBtns: Array.from(footer.querySelectorAll<HTMLButtonElement>('.vibe-btn')),
    planBox: footer.querySelector('.plan-box') as HTMLElement,
    nextList: footer.querySelector('.next-list') as HTMLUListElement,
    arcBtns: Array.from(footer.querySelectorAll<HTMLButtonElement>('.arc-btn')),
    planAltBtn: footer.querySelector('.plan-alt') as HTMLButtonElement,
    planBreakBtn: footer.querySelector('.plan-break') as HTMLButtonElement,
    planSummary: footer.querySelector('.plan-summary') as HTMLElement,
    planList: footer.querySelector('.plan-list') as HTMLUListElement,
    streamStatus: footer.querySelector('.stream-status') as HTMLElement,
    scConnect: footer.querySelector('.sc-connect') as HTMLButtonElement,
    scQuery: footer.querySelector('.sc-q') as HTMLInputElement,
    streamResults: footer.querySelector('.stream-results') as HTMLUListElement,
    log: footer.querySelector('.log-lines') as HTMLElement,
    addBtn
  }
}
