export interface DeckRefs {
  root: HTMLElement
  name: HTMLElement
  barBeat: HTMLElement
  pos: HTMLElement
  rem: HTMLElement
  bpm: HTMLElement
  origBpm: HTMLElement
  pitchBadge: HTMLButtonElement
  keyCamelot: HTMLElement
  keyName: HTMLElement
  keylockBtn: HTMLButtonElement
  syncBtn: HTMLButtonElement
  overview: HTMLCanvasElement
  waveform: HTMLCanvasElement
  bpbBtn: HTMLButtonElement
  phraseBtn: HTMLButtonElement
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
  eqLow: HTMLInputElement
  eqMid: HTMLInputElement
  eqHigh: HTMLInputElement
  filter: HTMLInputElement
  wet: HTMLInputElement
  fb: HTMLInputElement
  vol: HTMLInputElement
  trim: HTMLInputElement
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
  master: HTMLInputElement
  splitCueBtn: HTMLButtonElement
  autoGainBtn: HTMLButtonElement
  recBtn: HTMLButtonElement
  samplerPads: HTMLButtonElement[]
  samplerVol: HTMLInputElement
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
  midiWizardStatus: HTMLElement
  streamStatus: HTMLElement
  scConnect: HTMLButtonElement
  scQuery: HTMLInputElement
  streamResults: HTMLUListElement
  log: HTMLElement
  addBtn: HTMLButtonElement
}

const DECK_TEMPLATE = (id: 'A' | 'B') => `
  <div class="deck-head">
    <span class="deck-badge">${id}</span>
    <span class="track-name">— empty deck —</span>
    <span class="bar-beat" title="Current Bar.Beat from Measure 1">—</span>
    <span class="time-group">
      <span class="pos">0:00.0</span>
      <span class="rem">-0:00.0</span>
    </span>
  </div>

  <div class="deck-hud">
    <div class="hud-card bpm-card">
      <div class="hud-main">
        <span class="bpm" title="Live playback BPM">–.–</span>
        <span class="hud-unit">BPM</span>
      </div>
      <div class="hud-sub">
        <span class="orig-bpm" title="Original track tempo">ORIG –.–</span>
        <button class="pitch-badge" title="Click to reset pitch to 0.00%">+0.00%</button>
      </div>
    </div>

    <div class="hud-card key-card">
      <div class="hud-key-row">
        <span class="key-camelot" title="Camelot harmonic key">—</span>
        <div class="key-meta">
          <span class="hud-cap">KEY</span>
          <span class="key-name">unanalyzed</span>
        </div>
      </div>
      <button class="hud-btn keylock" data-act="deck${id}.keylock" title="Lock musical key while changing tempo (Signalsmith Stretch)">🔒 KEY LOCK</button>
    </div>

    <div class="hud-actions">
      <button class="hud-btn sync" data-act="deck${id}.sync" title="Match BPM & phase + drift lock">SYNC</button>
      <button class="hud-btn cuemix" data-act="deck${id}.cueMix" title="Headphone pre-listen (split-cue mode)">🎧 CUE</button>
    </div>
  </div>

  <div class="visuals">
    <div class="overview-box" title="Full-track overview — hover to measure intro bars, click/drag to jump">
      <canvas class="overview"></canvas>
    </div>

    <div class="grid-bar">
      <div class="grid-group">
        <span class="bar-label">MEASURE</span>
        <button class="mini-btn accent-gold" data-act="deck${id}.setBar1" title="Anchor Bar 1, Beat 1 at current playhead">SET 1</button>
        <button class="mini-btn" data-act="deck${id}.beatLeft" title="Shift measure downbeat 1 beat earlier">◀1</button>
        <button class="mini-btn" data-act="deck${id}.beatRight" title="Shift measure downbeat 1 beat later">1▶</button>
        <button class="mini-btn" data-act="deck${id}.nudgeBack" title="Nudge beatgrid -10ms">-ms</button>
        <button class="mini-btn" data-act="deck${id}.nudgeFwd" title="Nudge beatgrid +10ms">+ms</button>
        <button class="mini-btn" data-act="deck${id}.bpmHalf" title="Halve BPM">½×</button>
        <button class="mini-btn" data-act="deck${id}.bpmDouble" title="Double BPM">2×</button>
        <button class="mini-btn bpb-btn" data-act="deck${id}.beatsPerBar" title="Beats per measure (click to cycle)">4/4</button>
        <button class="mini-btn phrase-btn" data-act="deck${id}.phraseBars" title="Phrase block size on overview (click to cycle)">8B</button>
      </div>
      <div class="grid-group wf-controls">
        <div class="seg-group" role="group" aria-label="Waveform mode">
          <button class="seg-btn wf-rgb active" title="Unified 3-band RGB frequency waveform">RGB</button>
          <button class="seg-btn wf-bands" title="Separated Low / Mid / High frequency lanes">3-BAND</button>
          <button class="seg-btn wf-stems" disabled title="Separated Drums / Bass / Other / Vocals stem lanes">4-STEMS</button>
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
      <button class="t-btn play" data-act="deck${id}.play">▶ PLAY</button>
      <button class="t-btn cue" data-act="deck${id}.cue">CUE</button>
      <button class="t-btn set-cue" data-act="deck${id}.setCue">SET CUE</button>
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
      <span class="sec-lab">LOOP</span>
      <button class="t-btn loop loop1" data-act="deck${id}.loop1" title="1-beat loop roll (hold)">1</button>
      <button class="t-btn loop loop2" data-act="deck${id}.loop2" title="2-beat loop roll (hold)">2</button>
      <button class="t-btn loop loop4" data-act="deck${id}.loop4" title="4-beat loop roll (hold)">4</button>
      <button class="t-btn loop loop8" data-act="deck${id}.loop8" title="8-beat loop roll (hold)">8</button>
      <button class="t-btn loop-latch" data-act="deck${id}.loopLatch" title="Latching loops instead of momentary rolls">LATCH</button>
      <button class="t-btn loop-exit" data-act="deck${id}.loopExit">EXIT</button>
      <span class="row-sep"></span>
      <span class="sec-lab">JUMP</span>
      <button class="t-btn jump jb" data-act="deck${id}.jumpBack" title="Beat jump back">◀◀</button>
      <button class="t-btn jump-size" data-act="deck${id}.jumpSize" title="Jump size in beats">4</button>
      <button class="t-btn jump jf" data-act="deck${id}.jumpFwd" title="Beat jump forward">▶▶</button>
    </div>
  </div>

  <div class="mix-section">
    <div class="row eq-row">
      <label class="ctrl-lab">TRM <input class="trim" type="range" min="-12" max="12" step="0.5" value="0" title="Input trim (dB)" /></label>
      <label class="ctrl-lab">LO <input class="eq eq-low" type="range" min="-26" max="6" step="0.5" value="0" /></label>
      <label class="ctrl-lab">MID <input class="eq eq-mid" type="range" min="-26" max="6" step="0.5" value="0" /></label>
      <label class="ctrl-lab">HI <input class="eq eq-high" type="range" min="-26" max="6" step="0.5" value="0" /></label>
      <label class="ctrl-lab flt-lab">FLT <input class="filter" type="range" min="-1" max="1" step="0.01" value="0" title="Low-pass ← 0 → High-pass (double-click resets)" /></label>
      <label class="ctrl-lab vol-lab">VOL <input class="vol" type="range" min="0" max="1" step="0.01" value="1" /></label>
    </div>
    <div class="row fx-row">
      <span class="sec-lab">FX</span>
      <button class="t-btn fx delay" data-act="deck${id}.delay">DLY</button>
      <button class="t-btn fx frac" data-act="deck${id}.delayFrac">1/2</button>
      <label class="ctrl-lab">WET <input class="wet" type="range" min="0" max="1" step="0.01" value="0.55" /></label>
      <label class="ctrl-lab">FB <input class="fb" type="range" min="0" max="0.9" step="0.01" value="0.5" /></label>
      <button class="t-btn fx reverb" data-act="deck${id}.reverb">VRB</button>
      <button class="t-btn fx echo" data-act="deck${id}.echoOut">ECHO OUT</button>
    </div>
  </div>
`

function buildDeck(id: 'A' | 'B'): DeckRefs {
  const root = document.createElement('section')
  root.className = 'deck'
  root.dataset.deck = id
  root.innerHTML = DECK_TEMPLATE(id)
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T
  return {
    root,
    name: q('.track-name'),
    barBeat: q('.bar-beat'),
    pos: q('.pos'),
    rem: q('.rem'),
    bpm: q('.bpm'),
    origBpm: q('.orig-bpm'),
    pitchBadge: q('.pitch-badge'),
    keyCamelot: q('.key-camelot'),
    keyName: q('.key-name'),
    keylockBtn: q('.keylock'),
    syncBtn: q('.sync'),
    overview: q('.overview'),
    waveform: q('.waveform'),
    bpbBtn: q('.bpb-btn'),
    phraseBtn: q('.phrase-btn'),
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
    eqLow: q('.eq-low'),
    eqMid: q('.eq-mid'),
    eqHigh: q('.eq-high'),
    filter: q('.filter'),
    wet: q('.wet'),
    fb: q('.fb'),
    vol: q('.vol'),
    trim: q('.trim'),
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
  addBtn.textContent = '+ add tracks…'
  header.innerHTML =
    '<h1>VIBEDECK</h1><span class="hint">drop audio anywhere · hover overview to count intro bars · full key map in README.md</span><span class="mem-meter"></span><span class="env-setup" hidden><button class="env-install">install analysis env</button><button class="env-install-stems" title="adds demucs + torch (~2 GB, one time)">+ stems</button></span>'
  header.append(addBtn)

  const main = document.createElement('main')
  const deckA = buildDeck('A')
  const deckB = buildDeck('B')

  const mixer = document.createElement('section')
  mixer.className = 'mixer'
  mixer.innerHTML = `
    <div class="panel-title mixer-title">MIXER</div>
    <div class="xf-row"><span class="xf-a">A</span><input class="xfader" type="range" min="0" max="1" step="0.01" value="0.5" /><span class="xf-b">B</span></div>
    <button class="t-btn xf-center" data-act="mix.crossCenter">CENTER</button>
    <div class="mixer-toggles">
      <button class="t-btn split-cue" data-act="mix.splitCue" title="master on ch 1/2, headphone cue on ch 3/4 (use an aggregate audio device)">SPLIT CUE</button>
      <button class="t-btn auto-gain" data-act="mix.autoGain" title="normalize tracks to ${-14} LUFS via trim on load">AUTO GAIN</button>
      <button class="t-btn rec-btn" data-act="mix.record" title="record the master bus to ~/Music/vibedeck/ (blocked while SoundCloud tracks are loaded)">● REC</button>
    </div>
    <div class="row master-row"><span class="sec-lab">MASTER</span><input class="master" type="range" min="0" max="1" step="0.01" value="0.85" style="flex:1" /></div>
    <div class="sampler-box">
      <div class="panel-title">SAMPLER <span class="sampler-hint">drop · ⌥clr</span></div>
      <div class="sampler-pads">
        ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<button class="smp" data-act="sampler.pad${n}">${n}</button>`).join('\n        ')}
      </div>
      <div class="row"><span class="sec-lab">SMP</span><input class="sampler-vol" type="range" min="0" max="1" step="0.01" value="0.9" style="flex:1" /></div>
    </div>`

  main.append(deckA.root, mixer, deckB.root)

  const footer = document.createElement('footer')
  footer.innerHTML = `
    <section class="crate">
      <div class="panel-title">CRATE <span class="crate-count"></span></div>
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
    <section class="stream-panel">
      <div class="panel-title">STREAM <span class="stream-status"></span></div>
      <div class="stream-controls"><button class="sc-connect">connect SoundCloud</button></div>
      <div class="stream-search"><input class="sc-q" type="text" placeholder="search SoundCloud… ⏎" /></div>
      <ul class="stream-results"></ul>
    </section>
    <section class="midi-panel">
      <div class="panel-title">MIDI <span class="midi-devices"></span></div>
      <div class="midi-tools">
        <button class="midi-wizard">auto-map</button>
        <button class="midi-ko2">K.O. II preset</button>
        <button class="midi-watch">watch</button>
      </div>
      <div class="midi-wizard-status"></div>
      <div class="midi-actions"></div>
    </section>
    <section class="log">
      <div class="panel-title">LOG</div>
      <div class="log-lines"></div>
    </section>`

  root.append(header, main, footer)

  return {
    deckA,
    deckB,
    xfader: mixer.querySelector('.xfader') as HTMLInputElement,
    master: mixer.querySelector('.master') as HTMLInputElement,
    splitCueBtn: mixer.querySelector('.split-cue') as HTMLButtonElement,
    autoGainBtn: mixer.querySelector('.auto-gain') as HTMLButtonElement,
    recBtn: mixer.querySelector('.rec-btn') as HTMLButtonElement,
    samplerPads: Array.from(mixer.querySelectorAll<HTMLButtonElement>('.smp')),
    samplerVol: mixer.querySelector('.sampler-vol') as HTMLInputElement,
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
    midiWizardStatus: footer.querySelector('.midi-wizard-status') as HTMLElement,
    streamStatus: footer.querySelector('.stream-status') as HTMLElement,
    scConnect: footer.querySelector('.sc-connect') as HTMLButtonElement,
    scQuery: footer.querySelector('.sc-q') as HTMLInputElement,
    streamResults: footer.querySelector('.stream-results') as HTMLUListElement,
    log: footer.querySelector('.log-lines') as HTMLElement,
    addBtn
  }
}
