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
  stemsBox: HTMLElement
  stemSliders: HTMLInputElement[]
  eqLow: HTMLInputElement
  eqMid: HTMLInputElement
  eqHigh: HTMLInputElement
}

export interface AppRefs {
  deckA: DeckRefs
  deckB: DeckRefs
  xfader: HTMLInputElement
  master: HTMLInputElement
  crateList: HTMLUListElement
  crateCount: HTMLElement
  midiDevices: HTMLElement
  midiActions: HTMLElement
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
    stemsBox: q('.stems-row'),
    stemSliders: Array.from(root.querySelectorAll<HTMLInputElement>('.stem input')),
    eqLow: q('.eq-low'),
    eqMid: q('.eq-mid'),
    eqHigh: q('.eq-high')
  }
}

export function buildApp(root: HTMLElement): AppRefs {
  root.innerHTML = ''

  const header = document.createElement('header')
  const addBtn = document.createElement('button')
  addBtn.textContent = 'add tracks…'
  header.innerHTML = '<h1>VIBEDECK</h1><span class="hint">drop audio anywhere · Q/W = deck A play/cue · P/O = deck B · , . crossfade · space = center</span>'
  header.append(addBtn)

  const main = document.createElement('main')
  const deckA = buildDeck('A')
  const deckB = buildDeck('B')

  const mixer = document.createElement('section')
  mixer.className = 'mixer'
  mixer.innerHTML = `
    <div class="xf-row"><span>A</span><input class="xfader" type="range" min="0" max="1" step="0.01" value="0.5" /><span>B</span></div>
    <button class="t-btn xf-center" data-act="mix.crossCenter">CENTER</button>
    <div class="row"><span>MASTER</span><input class="master" type="range" min="0" max="1" step="0.01" value="0.85" style="flex:1" /></div>`

  main.append(deckA.root, mixer, deckB.root)

  const footer = document.createElement('footer')
  footer.innerHTML = `
    <section class="crate">
      <div class="panel-title">CRATE <span class="crate-count"></span></div>
      <ul class="crate-list"></ul>
    </section>
    <section class="midi-panel">
      <div class="panel-title">MIDI <span class="midi-devices"></span></div>
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
    crateList: footer.querySelector('.crate-list') as HTMLUListElement,
    crateCount: footer.querySelector('.crate-count') as HTMLElement,
    midiDevices: footer.querySelector('.midi-devices') as HTMLElement,
    midiActions: footer.querySelector('.midi-actions') as HTMLElement,
    log: footer.querySelector('.log-lines') as HTMLElement,
    addBtn
  }
}
