export interface DeckRefs {
  root: HTMLElement
  name: HTMLElement
  bpm: HTMLElement
  key: HTMLElement
  pos: HTMLElement
  rate: HTMLInputElement
  rateVal: HTMLElement
  playBtn: HTMLButtonElement
  cueBtn: HTMLButtonElement
  syncBtn: HTMLButtonElement
  keylockBtn: HTMLButtonElement
  waveform: HTMLCanvasElement
  hotcueBtns: HTMLButtonElement[]
  stemsBox: HTMLElement
  stemSliders: HTMLInputElement[]
  eqLow: HTMLInputElement
  eqMid: HTMLInputElement
  eqHigh: HTMLInputElement
  filter: HTMLInputElement
  wet: HTMLInputElement
  fb: HTMLInputElement
  vol: HTMLInputElement
  delayBtn: HTMLButtonElement
  fracBtn: HTMLButtonElement
  reverbBtn: HTMLButtonElement
  echoBtn: HTMLButtonElement
  cueMixBtn: HTMLButtonElement
  trim: HTMLInputElement
  loopBtns: HTMLButtonElement[]
  loopLatchBtn: HTMLButtonElement
  loopExitBtn: HTMLButtonElement
}

export interface AppRefs {
  deckA: DeckRefs
  deckB: DeckRefs
  xfader: HTMLInputElement
  master: HTMLInputElement
  splitCueBtn: HTMLButtonElement
  autoGainBtn: HTMLButtonElement
  samplerPads: HTMLButtonElement[]
  samplerVol: HTMLInputElement
  memMeter: HTMLElement
  crateList: HTMLUListElement
  crateCount: HTMLElement
  midiDevices: HTMLElement
  midiActions: HTMLElement
  midiWizard: HTMLButtonElement
  midiKo2: HTMLButtonElement
  midiWizardStatus: HTMLElement
  streamStatus: HTMLElement
  scConnect: HTMLButtonElement
  scQuery: HTMLInputElement
  streamResults: HTMLUListElement
  log: HTMLElement
  addBtn: HTMLButtonElement
}

const DECK_TEMPLATE = (id: 'A' | 'B') => `
  <div class="deck-head"><span class="deck-label">${id}</span><span class="track-name">— empty —</span></div>
  <div class="deck-stats">
    <span class="stat bpm" title="effective BPM">–.–</span>
    <span class="stat key"></span>
    <span class="stat pos">0:00.0</span>
  </div>
  <div class="waveform-box"><canvas class="waveform"></canvas></div>
  <div class="row rate-row">
    <input class="rate" type="range" min="-8" max="8" step="0.05" value="0" />
    <span class="rate-val">+0.00%</span>
  </div>
  <div class="row eq-row">
    <label>EQ
      low <input class="eq eq-low" type="range" min="-26" max="6" step="0.5" value="0" />
      mid <input class="eq eq-mid" type="range" min="-26" max="6" step="0.5" value="0" />
      high <input class="eq eq-high" type="range" min="-26" max="6" step="0.5" value="0" />
    </label>
  </div>
  <div class="row fx-row">
    <label class="fx-lab">FLT <input class="filter" type="range" min="-1" max="1" step="0.01" value="0" title="double-click to reset" /></label>
    <button class="t-btn fx delay" data-act="deck${id}.delay">DLY</button>
    <button class="t-btn fx frac" data-act="deck${id}.delayFrac">1/2</button>
    <button class="t-btn fx reverb" data-act="deck${id}.reverb">VRB</button>
    <button class="t-btn fx echo" data-act="deck${id}.echoOut">ECHO</button>
  </div>
  <div class="row fx-params">
    <label class="fx-lab">TRM <input class="trim" type="range" min="-12" max="12" step="0.5" value="0" title="input trim (dB)" /></label>
    <label class="fx-lab">WET <input class="wet" type="range" min="0" max="1" step="0.01" value="0.55" /></label>
    <label class="fx-lab">FB <input class="fb" type="range" min="0" max="0.9" step="0.01" value="0.5" /></label>
    <label class="fx-lab">VOL <input class="vol" type="range" min="0" max="1" step="0.01" value="1" /></label>
    <button class="t-btn fx cuemix" data-act="deck${id}.cueMix" title="headphone cue (split-cue mode)">CUE</button>
  </div>
  <div class="stems-row" hidden>
    <div class="stem"><span>DRUMS</span><input type="range" min="0" max="1" step="0.01" value="1" /></div>
    <div class="stem"><span>BASS</span><input type="range" min="0" max="1" step="0.01" value="1" /></div>
    <div class="stem"><span>OTHER</span><input type="range" min="0" max="1" step="0.01" value="1" /></div>
    <div class="stem"><span>VOCALS</span><input type="range" min="0" max="1" step="0.01" value="1" /></div>
  </div>
  <div class="transport">
    <button class="t-btn play" data-act="deck${id}.play">PLAY</button>
    <button class="t-btn cue" data-act="deck${id}.cue">CUE</button>
    <button class="t-btn" data-act="deck${id}.setCue">SET&nbsp;CUE</button>
    <button class="t-btn sync" data-act="deck${id}.sync">SYNC</button>
    <button class="t-btn keylock" data-act="deck${id}.keylock">KEY</button>
  </div>
  <div class="row hotcue-row">
    <button class="hc hc1" data-act="deck${id}.hotcue1">1</button>
    <button class="hc hc2" data-act="deck${id}.hotcue2">2</button>
    <button class="hc hc3" data-act="deck${id}.hotcue3">3</button>
    <button class="hc hc4" data-act="deck${id}.hotcue4">4</button>
    <span class="hc-hint">shift+click sets · alt+click clears</span>
  </div>
  <div class="row loop-row">
    <span class="loop-lab">LOOP</span>
    <button class="t-btn loop loop1" data-act="deck${id}.loop1" title="1-beat loop roll (hold)">1</button>
    <button class="t-btn loop loop2" data-act="deck${id}.loop2" title="2-beat loop roll (hold)">2</button>
    <button class="t-btn loop loop4" data-act="deck${id}.loop4" title="4-beat loop roll (hold)">4</button>
    <button class="t-btn loop loop8" data-act="deck${id}.loop8" title="8-beat loop roll (hold)">8</button>
    <button class="t-btn loop-latch" data-act="deck${id}.loopLatch" title="latching loops instead of momentary rolls">LATCH</button>
    <button class="t-btn loop-exit" data-act="deck${id}.loopExit">EXIT</button>
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
    bpm: q('.bpm'),
    key: q('.key'),
    pos: q('.pos'),
    rate: q('.rate'),
    rateVal: q('.rate-val'),
    playBtn: q('.play'),
    cueBtn: q('.cue'),
    syncBtn: q('.sync'),
    keylockBtn: q('.keylock'),
    waveform: q('.waveform'),
    hotcueBtns: [1, 2, 3, 4].map((n) => q(`.hc${n}`)),
    stemsBox: q('.stems-row'),
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
    loopExitBtn: q('.loop-exit')
  }
}

export function buildApp(root: HTMLElement): AppRefs {
  root.innerHTML = ''

  const header = document.createElement('header')
  const addBtn = document.createElement('button')
  addBtn.textContent = 'add tracks…'
  header.innerHTML =
    '<h1>VIBEDECK</h1><span class="hint">drop audio anywhere · Q/W deck A · P/O deck B · A S D F / J K L ; hot cues · SYNC twice to unlock</span><span class="mem-meter"></span>'
  header.append(addBtn)

  const main = document.createElement('main')
  const deckA = buildDeck('A')
  const deckB = buildDeck('B')

  const mixer = document.createElement('section')
  mixer.className = 'mixer'
  mixer.innerHTML = `
    <div class="xf-row"><span>A</span><input class="xfader" type="range" min="0" max="1" step="0.01" value="0.5" /><span>B</span></div>
    <button class="t-btn xf-center" data-act="mix.crossCenter">CENTER</button>
    <button class="t-btn split-cue" data-act="mix.splitCue" title="master on ch 1/2, headphone cue on ch 3/4 (use an aggregate audio device)">SPLIT CUE</button>
    <button class="t-btn auto-gain" data-act="mix.autoGain" title="normalize tracks to ${-14} LUFS via trim on load">AUTO GAIN</button>
    <div class="row"><span>MASTER</span><input class="master" type="range" min="0" max="1" step="0.01" value="0.85" style="flex:1" /></div>
    <div class="sampler-box">
      <div class="panel-title">SAMPLER <span class="sampler-hint">drop on pads · alt+click clears</span></div>
      <div class="sampler-pads">
        ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<button class="smp" data-act="sampler.pad${n}">${n}</button>`).join('\n        ')}
      </div>
      <div class="row"><span>SMP</span><input class="sampler-vol" type="range" min="0" max="1" step="0.01" value="0.9" style="flex:1" /></div>
    </div>`

  main.append(deckA.root, mixer, deckB.root)

  const footer = document.createElement('footer')
  footer.innerHTML = `
    <section class="crate">
      <div class="panel-title">CRATE <span class="crate-count"></span></div>
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
        <button class="midi-wizard">auto-map wizard</button>
        <button class="midi-ko2">load K.O. II preset</button>
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
    samplerPads: Array.from(mixer.querySelectorAll<HTMLButtonElement>('.smp')),
    samplerVol: mixer.querySelector('.sampler-vol') as HTMLInputElement,
    memMeter: header.querySelector('.mem-meter') as HTMLElement,
    crateList: footer.querySelector('.crate-list') as HTMLUListElement,
    crateCount: footer.querySelector('.crate-count') as HTMLElement,
    midiDevices: footer.querySelector('.midi-devices') as HTMLElement,
    midiActions: footer.querySelector('.midi-actions') as HTMLElement,
    midiWizard: footer.querySelector('.midi-wizard') as HTMLButtonElement,
    midiKo2: footer.querySelector('.midi-ko2') as HTMLButtonElement,
    midiWizardStatus: footer.querySelector('.midi-wizard-status') as HTMLElement,
    streamStatus: footer.querySelector('.stream-status') as HTMLElement,
    scConnect: footer.querySelector('.sc-connect') as HTMLButtonElement,
    scQuery: footer.querySelector('.sc-q') as HTMLInputElement,
    streamResults: footer.querySelector('.stream-results') as HTMLUListElement,
    log: footer.querySelector('.log-lines') as HTMLElement,
    addBtn
  }
}
