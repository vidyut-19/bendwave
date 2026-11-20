import './style.css'
import { DJEngine } from './engine/engine'
import { computeBeatGrid } from './engine/analysis'
import { STEM_ORDER, type Deck, type Track } from './engine/deck'
import { CrateStore } from './crate/store'
import { MidiRouter } from './midi/midi'
import { buildApp, type AppRefs, type DeckRefs } from './ui'

const AUDIO_EXT = /\.(wav|aiff?|flac|mp3|m4a|aac|ogg)$/i

const engine = new DJEngine()
const crate = new CrateStore()
const midi = new MidiRouter()
const refs = buildApp(document.getElementById('app')!)

let focusedDeck: 'A' | 'B' = 'A'
let userDataDir = ''

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const line = document.createElement('div')
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`
  refs.log.prepend(line)
  while (refs.log.childElementCount > 40) refs.log.lastChild?.remove()
}

// ---------------------------------------------------------------------------
// audio helpers
// ---------------------------------------------------------------------------

async function decodeFile(file: File): Promise<AudioBuffer> {
  const ab = await file.arrayBuffer()
  return await engine.ctx.decodeAudioData(ab)
}

async function decodePath(path: string): Promise<AudioBuffer> {
  const api = window.vibedeck
  if (!api) throw new Error('not running under electron')
  const u8 = await api.readAudio(path)
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
  return await engine.ctx.decodeAudioData(ab)
}

function emptyBuffer(): AudioBuffer {
  return engine.ctx.createBuffer(2, 1, engine.ctx.sampleRate)
}

async function loadStemBuffers(t: Track): Promise<AudioBuffer[]> {
  if (!t.stems || !window.vibedeck) return []
  const out: AudioBuffer[] = []
  for (const name of STEM_ORDER) {
    const p = t.stems[name]
    if (!p) {
      out.push(emptyBuffer())
      continue
    }
    try {
      out.push(await decodePath(p))
    } catch {
      out.push(emptyBuffer())
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// ingestion: add file -> browser beatgrid now -> sidecar (librosa + demucs) async
// ---------------------------------------------------------------------------

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function slug(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

async function ingest(path: string, name: string, buffer: AudioBuffer): Promise<void> {
  const existing = crate.tracks.find((t) => t.path === path)
  const track: Track = existing
    ? { ...existing }
    : {
        id: `${path}#${buffer.duration.toFixed(2)}`,
        name,
        path,
        durationSec: buffer.duration,
        sampleRate: buffer.sampleRate
      }
  track.name = name
  track.durationSec = buffer.duration
  track.sampleRate = buffer.sampleRate
  if (!track.grid || track.analysisSource === 'browser') {
    track.grid = computeBeatGrid(buffer)
    track.analysisSource = 'browser'
  }
  track.analyzedAt = new Date().toISOString()
  crate.upsert(track)
  renderCrate()
  log(`added "${name}" — browser BPM ${track.grid.bpm || '?'}`)

  await loadTrackIntoDeck(track, buffer)

  if (!track.stems && track.analysisSource !== 'sidecar') {
    void enhanceWithSidecar(track)
  }
}

async function enhanceWithSidecar(track: Track): Promise<void> {
  const api = window.vibedeck
  if (!api) return
  if (!userDataDir) {
    try {
      userDataDir = (await api.paths()).userData
    } catch {
      return
    }
  }
  log(`analyzing "${track.name}" (sidecar: librosa bpm/key + demucs stems)…`)
  const started = performance.now()
  const r = await api.analyze(track.path, {
    stems: true,
    stemsDir: `${userDataDir}/stems/${slug(track.id)}`
  })
  if (!r.ok || !r.result) {
    log(`sidecar unavailable — using browser estimate. install with: pip install librosa soundfile demucs`)
    return
  }
  const res = r.result as {
    bpm?: number
    offset?: number
    key?: string
    camelot?: string
    stems?: Record<string, string>
    stems_error?: string
  }
  if (typeof res.bpm === 'number' && res.bpm > 0) {
    track.grid = { bpm: res.bpm, offset: res.offset ?? track.grid?.offset ?? 0 }
    track.analysisSource = 'sidecar'
  }
  if (res.key) {
    track.key = res.key
    track.camelot = res.camelot
  }
  if (res.stems && !res.stems_error) {
    track.stems = {
      drums: res.stems.drums,
      bass: res.stems.bass,
      vocals: res.stems.vocals,
      other: res.stems.other
    }
    for (const d of [engine.deckA, engine.deckB]) {
      if (d.track?.id === track.id) void attachStems(d, track)
    }
    log(`stems ready for "${track.name}"`)
  } else if (res.stems_error) {
    log(`stems skipped: ${res.stems_error}`)
  }
  crate.upsert(track)
  renderCrate()
  log(`analyzed "${track.name}" in ${((performance.now() - started) / 1000).toFixed(1)}s${track.key ? ` — ${track.key}` : ''}`)
}

async function attachStems(deck: Deck, track: Track): Promise<void> {
  try {
    const bufs = await loadStemBuffers(track)
    if (deck.track?.id !== track.id) return
    deck.setStemBuffers(bufs)
    updateStemsUI(deck)
  } catch (e) {
    log(`stem load failed: ${String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// deck loading
// ---------------------------------------------------------------------------

async function loadTrackIntoDeck(track: Track, buffer?: AudioBuffer): Promise<void> {
  const deck = !engine.deckA.hasAudio
    ? engine.deckA
    : !engine.deckB.hasAudio
      ? engine.deckB
      : focusedDeck === 'B'
        ? engine.deckB
        : engine.deckA
  try {
    const buf = buffer ?? (await decodePath(track.path))
    const stemBufs = track.stems ? await loadStemBuffers(track) : []
    await deck.load(track, buf, stemBufs)
    focusedDeck = deck.id
    updateDeckUI(deck)
    updateStemsUI(deck)
    log(`loaded "${track.name}" → deck ${deck.id}`)
  } catch (e) {
    log(`could not load "${track.name}": ${String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// actions (shared by keyboard, buttons, MIDI)
// ---------------------------------------------------------------------------

function deckOf(action: string): Deck | null {
  if (action.startsWith('deckA.')) return engine.deckA
  if (action.startsWith('deckB.')) return engine.deckB
  return null
}

function actionPress(action: string): void {
  engine.resume()
  const deck = deckOf(action)
  if (deck) {
    const verb = action.slice(6)
    switch (verb) {
      case 'play':
        if (deck.playing) deck.pause()
        else deck.play()
        break
      case 'cue':
        deck.cuePress()
        break
      case 'setCue':
        deck.setCueHere()
        log(`deck ${deck.id} cue set @ ${fmtTime(deck.cuePoint)}`)
        break
      case 'sync': {
        const other = deck === engine.deckA ? engine.deckB : engine.deckA
        if (deck.syncTo(other)) {
          log(`deck ${deck.id} synced to deck ${other.id} (${(deck.effectiveBpm ?? 0).toFixed(1)} BPM)`)
        } else {
          log('sync failed — need audio + beatgrids on both decks')
        }
        break
      }
      case 'bendDown':
        deck.bend(-0.06)
        break
      case 'bendUp':
        deck.bend(0.06)
        break
    }
    return
  }
  switch (action) {
    case 'mix.crossLeft':
      engine.mixer.nudge(-1)
      break
    case 'mix.crossRight':
      engine.mixer.nudge(1)
      break
    case 'mix.crossCenter':
      engine.mixer.setCrossfade(0.5)
      break
  }
}

function actionRelease(action: string): void {
  const deck = deckOf(action)
  if (!deck) return
  const verb = action.slice(6)
  if (verb === 'cue') deck.cueRelease()
  else if (verb === 'bendDown' || verb === 'bendUp') deck.bend(0)
}

const KEY_ACTIONS: Record<string, string> = {
  KeyQ: 'deckA.play',
  KeyW: 'deckA.cue',
  KeyE: 'deckA.setCue',
  KeyR: 'deckA.sync',
  Digit1: 'deckA.bendDown',
  Digit2: 'deckA.bendUp',
  KeyP: 'deckB.play',
  KeyO: 'deckB.cue',
  KeyI: 'deckB.setCue',
  KeyU: 'deckB.sync',
  Digit9: 'deckB.bendDown',
  Digit0: 'deckB.bendUp',
  Comma: 'mix.crossLeft',
  Period: 'mix.crossRight',
  Space: 'mix.crossCenter'
}

document.addEventListener('keydown', (e) => {
  const a = KEY_ACTIONS[e.code]
  if (!a) return
  e.preventDefault()
  if (e.repeat) return
  actionPress(a)
})
document.addEventListener('keyup', (e) => {
  const a = KEY_ACTIONS[e.code]
  if (!a) return
  actionRelease(a)
})

// ---------------------------------------------------------------------------
// file input: drag & drop + browse
// ---------------------------------------------------------------------------

document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  const files = Array.from(e.dataTransfer?.files ?? [])
  void addFiles(files)
})

async function addFiles(files: File[]): Promise<void> {
  for (const f of files) {
    if (!AUDIO_EXT.test(f.name)) {
      log(`skipped ${f.name} (unsupported type)`)
      continue
    }
    try {
      const buffer = await decodeFile(f)
      const path = window.vibedeck?.filePathFor(f) ?? f.name
      await ingest(path, f.name.replace(/\.[^.]+$/, ''), buffer)
    } catch (e) {
      log(`failed to load ${f.name}: ${String(e)}`)
    }
  }
}

async function addPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      const buffer = await decodePath(p)
      await ingest(p, basename(p).replace(/\.[^.]+$/, ''), buffer)
    } catch (e) {
      log(`failed to load ${basename(p)}: ${String(e)}`)
    }
  }
}

refs.addBtn.addEventListener('click', async () => {
  const paths = (await window.vibedeck?.selectAudio()) ?? []
  if (paths.length) void addPaths(paths)
})

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function pct(rate: number): string {
  return `${rate >= 1 ? '+' : ''}${((rate - 1) * 100).toFixed(2)}%`
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

function deckRefs(deck: Deck): DeckRefs {
  return deck.id === 'A' ? refs.deckA : refs.deckB
}

function wireDeck(deck: Deck, r: DeckRefs): void {
  r.root.addEventListener('pointerdown', () => {
    focusedDeck = deck.id
  })
  r.rate.oninput = () => {
    deck.setTempoRate(1 + r.rate.valueAsNumber / 100)
    r.rateVal.textContent = pct(deck.tempoRate)
  }
  const eqs = [r.eqLow, r.eqMid, r.eqHigh]
  const applyEq = () => deck.setEQ(eqs[0].valueAsNumber, eqs[1].valueAsNumber, eqs[2].valueAsNumber)
  eqs.forEach((e) => (e.oninput = applyEq))
  r.stemSliders.forEach((s, i) => (s.oninput = () => deck.setStemGain(i, s.valueAsNumber)))
  for (const btn of r.root.querySelectorAll<HTMLButtonElement>('button[data-act]')) {
    const act = btn.dataset.act!
    btn.addEventListener('pointerdown', () => actionPress(act))
    btn.addEventListener('pointerup', () => actionRelease(act))
    btn.addEventListener('pointerleave', () => actionRelease(act))
  }
}

function updateDeckUI(deck: Deck): void {
  const r = deckRefs(deck)
  r.name.textContent = deck.track?.name ?? '— empty —'
  if (document.activeElement !== r.rate) {
    r.rate.value = String(((deck.tempoRate - 1) * 100).toFixed(2))
    r.rateVal.textContent = pct(deck.tempoRate)
  }
}

function updateStemsUI(deck: Deck): void {
  const r = deckRefs(deck)
  r.stemsBox.hidden = deck.stemCount === 0
  r.stemSliders.forEach((s) => (s.value = '1'))
}

function renderCrate(): void {
  refs.crateList.innerHTML = ''
  const tracks = [...crate.tracks].sort((a, b) => a.name.localeCompare(b.name))
  refs.crateCount.textContent = tracks.length ? `(${tracks.length})` : ''
  for (const t of tracks) {
    const li = document.createElement('li')
    const meta = [
      t.grid?.bpm ? t.grid.bpm.toFixed(1) : '?',
      t.camelot ?? '',
      t.stems ? 'stems' : ''
    ]
      .filter(Boolean)
      .join(' · ')
    li.innerHTML = `<span class="crate-name">${escapeHtml(t.name)}</span><span class="crate-meta">${escapeHtml(meta)}</span>`
    li.addEventListener('click', () => void loadTrackIntoDeck(t))
    refs.crateList.append(li)
  }
}

refs.xfader.addEventListener('input', () => engine.mixer.setCrossfade(refs.xfader.valueAsNumber))
refs.master.addEventListener('input', () => {
  engine.master.gain.value = refs.master.valueAsNumber
})

function tick(): void {
  for (const deck of [engine.deckA, engine.deckB]) {
    const r = deckRefs(deck)
    r.playBtn.classList.toggle('active', deck.playing)
    const bpm = deck.effectiveBpm
    r.bpm.textContent = bpm ? bpm.toFixed(1) : '–.–'
    r.key.textContent = deck.track?.camelot ?? deck.track?.key ?? ''
    r.pos.textContent = fmtTime(deck.position)
    r.root.classList.toggle('focused', deck.id === focusedDeck)
    if (document.activeElement !== r.rate) {
      r.rate.value = String(((deck.tempoRate - 1) * 100).toFixed(2))
      r.rateVal.textContent = pct(deck.tempoRate)
    }
  }
  if (document.activeElement !== refs.xfader) {
    refs.xfader.value = String(engine.mixer.position)
  }
  requestAnimationFrame(tick)
}

// ---------------------------------------------------------------------------
// MIDI learn panel
// ---------------------------------------------------------------------------

const ACTION_IDS = [
  'deckA.play', 'deckA.cue', 'deckA.setCue', 'deckA.sync', 'deckA.bendDown', 'deckA.bendUp',
  'deckB.play', 'deckB.cue', 'deckB.setCue', 'deckB.sync', 'deckB.bendDown', 'deckB.bendUp',
  'mix.crossLeft', 'mix.crossRight', 'mix.crossCenter', 'mix.crossfade'
]

function renderMidiPanel(): void {
  refs.midiActions.innerHTML = ''
  for (const id of ACTION_IDS) {
    const row = document.createElement('div')
    row.className = 'midi-row' + (midi.learning === id ? ' learning' : '')
    const b = midi.bindingFor(id)
    const label = b ? `${b.type.toUpperCase()} ch${b.channel + 1} #${b.control}` : '—'
    row.innerHTML = `<span class="midi-action">${id}</span><span class="midi-binding">${label}</span>`
    const learn = document.createElement('button')
    learn.textContent = midi.learning === id ? 'waiting…' : 'learn'
    learn.addEventListener('click', () => {
      midi.startLearn(midi.learning === id ? null : id)
    })
    const clear = document.createElement('button')
    clear.textContent = 'clear'
    clear.disabled = !b
    clear.addEventListener('click', () => midi.clearBinding(id))
    row.append(learn, clear)
    refs.midiActions.append(row)
  }
}

midi.onBindingsChanged = renderMidiPanel
midi.onDevices = (names) => {
  refs.midiDevices.textContent = names.length ? names.join(', ') : 'no devices'
}
midi.onAction = (actionId, msg) => {
  if (actionId === 'mix.crossfade') {
    if (msg.type === 'cc') engine.mixer.setCrossfade(msg.value / 127)
    return
  }
  if (msg.type === 'note') {
    if (msg.value > 0) actionPress(actionId)
    else actionRelease(actionId)
  } else {
    if (msg.value > 63) actionPress(actionId)
    else actionRelease(actionId)
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

void (async () => {
  await crate.load()
  renderCrate()
  wireDeck(engine.deckA, refs.deckA)
  wireDeck(engine.deckB, refs.deckB)
  renderMidiPanel()
  const midiOk = await midi.init()
  renderMidiPanel()
  log(midiOk ? 'midi ready — click "learn" next to an action, then touch a control' : 'web midi unavailable in this build')
  log('drop tracks anywhere (or "add tracks…") — bpm runs instantly, stems follow via sidecar')
  window.addEventListener('pointerdown', () => engine.resume())
  requestAnimationFrame(tick)
})()
