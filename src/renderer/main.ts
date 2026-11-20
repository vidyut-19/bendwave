import './style.css'
import { DJEngine } from './engine/engine'
import { computeBeatGrid } from './engine/analysis'
import { WaveformView } from './engine/waveform'
import { SyncController } from './engine/sync'
import { STEM_ORDER, type Deck, type Track } from './engine/deck'
import { CrateStore } from './crate/store'
import { MidiRouter } from './midi/midi'
import { buildApp, type AppRefs, type DeckRefs } from './ui'
import { SoundCloudProvider } from './sources/soundcloud'
import { registerProvider, type StreamTrackRef } from './sources/provider'

const AUDIO_EXT = /\.(wav|aiff?|flac|mp3|m4a|aac|ogg)$/i

const engine = new DJEngine()
const crate = new CrateStore()
const midi = new MidiRouter()
const syncCtl = new SyncController(engine)
const refs = buildApp(document.getElementById('app')!)

const sc = new SoundCloudProvider(engine.ctx)
registerProvider(sc)

const waveforms = new Map<string, WaveformView>()

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

function persistTrack(deck: Deck): void {
  if (deck.track) crate.upsert(deck.track)
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
  // streaming tracks have no local file, and their terms may forbid stem separation
  if (track.source || track.stemsAllowed === false) return
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
    log('sidecar unavailable — using browser estimate. install with: pip install librosa soundfile demucs')
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

function refFromTrack(t: Track): StreamTrackRef {
  return {
    provider: 'soundcloud',
    id: t.path,
    title: t.name,
    durationSec: t.durationSec,
    sourceUrl: t.sourceUrl,
    stemsAllowed: false
  }
}

async function loadTrackIntoDeck(track: Track, buffer?: AudioBuffer): Promise<void> {
  const deck = !engine.deckA.hasAudio
    ? engine.deckA
    : !engine.deckB.hasAudio
      ? engine.deckB
      : focusedDeck === 'B'
        ? engine.deckB
        : engine.deckA
  releaseSyncIfSlave(deck)
  try {
    let buf = buffer
    if (!buf) {
      if (track.source === 'soundcloud') {
        const r = await sc.resolve(refFromTrack(track))
        if (r.kind !== 'buffer') throw new Error('url streams not supported')
        buf = r.buffer
      } else {
        buf = await decodePath(track.path)
      }
    }
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

function releaseSyncIfSlave(deck: Deck): void {
  if (syncCtl.slave === deck.id) {
    syncCtl.disengage()
    log(`deck ${deck.id} sync lock released (manual control)`)
  }
}

function actionPress(action: string): void {
  engine.resume()
  const deck = deckOf(action)
  if (deck) {
    const verb = action.slice(6)

    const hc = /^(?:set)?[Hh]otcue([1-4])$/.exec(verb)
    if (hc) {
      const i = Number(hc[1]) - 1
      if (verb.startsWith('set')) {
        deck.hotCues[i] = deck.position
        persistTrack(deck)
        log(`deck ${deck.id} hot cue ${i + 1} set @ ${fmtTime(deck.position)}`)
      } else {
        const p = deck.hotCues[i]
        if (p == null) {
          log(`deck ${deck.id} hot cue ${i + 1} not set — shift+number or shift-click to set`)
        } else {
          releaseSyncIfSlave(deck)
          deck.seek(p)
          if (!deck.playing) deck.play()
        }
      }
      return
    }

    switch (verb) {
      case 'play':
        if (deck.playing) deck.pause()
        else deck.play()
        break
      case 'cue':
        releaseSyncIfSlave(deck)
        deck.cuePress()
        break
      case 'setCue':
        deck.setCueHere()
        persistTrack(deck)
        log(`deck ${deck.id} cue set @ ${fmtTime(deck.cuePoint)}`)
        break
      case 'sync': {
        const other = deck === engine.deckA ? engine.deckB : engine.deckA
        if (syncCtl.slave === deck.id) {
          syncCtl.disengage()
          log(`deck ${deck.id} sync lock released`)
        } else if (deck.syncTo(other)) {
          syncCtl.engage(deck.id)
          log(`deck ${deck.id} synced + drift lock ON (${(deck.effectiveBpm ?? 0).toFixed(1)} BPM)`)
        } else {
          log('sync failed — need audio + beatgrids on both decks')
        }
        break
      }
      case 'keylock': {
        const ok = deck.setKeylock(!deck.keylock)
        if (ok) log(`deck ${deck.id} key lock ${deck.keylock ? 'ON' : 'OFF'} (experimental)`)
        else log(`deck ${deck.id} key lock unavailable while stems are loaded`)
        break
      }
      case 'bendDown':
        releaseSyncIfSlave(deck)
        deck.bend(-0.06)
        break
      case 'bendUp':
        releaseSyncIfSlave(deck)
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
  Digit3: 'deckA.keylock',
  KeyP: 'deckB.play',
  KeyO: 'deckB.cue',
  KeyI: 'deckB.setCue',
  KeyU: 'deckB.sync',
  Digit9: 'deckB.bendDown',
  Digit0: 'deckB.bendUp',
  Digit8: 'deckB.keylock',
  Comma: 'mix.crossLeft',
  Period: 'mix.crossRight',
  Space: 'mix.crossCenter'
}

const HOTCUE_KEYS: Record<string, ['A' | 'B', number]> = {
  KeyA: ['A', 1],
  KeyS: ['A', 2],
  KeyD: ['A', 3],
  KeyF: ['A', 4],
  KeyJ: ['B', 1],
  KeyK: ['B', 2],
  KeyL: ['B', 3],
  Semicolon: ['B', 4]
}

document.addEventListener('keydown', (e) => {
  const hc = HOTCUE_KEYS[e.code]
  if (hc) {
    e.preventDefault()
    if (e.repeat) return
    const [d, n] = hc
    actionPress(`deck${d}.${e.shiftKey ? 'set' : ''}hotcue${n}`)
    return
  }
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

function wfFor(deck: Deck): WaveformView {
  return waveforms.get(deck.id)!
}

function wireDeck(deck: Deck, r: DeckRefs): void {
  const wf = new WaveformView(r.waveform)
  wf.onSeek = (t) => {
    releaseSyncIfSlave(deck)
    deck.seek(t)
  }
  waveforms.set(deck.id, wf)

  r.root.addEventListener('pointerdown', () => {
    focusedDeck = deck.id
  })
  r.rate.oninput = () => {
    releaseSyncIfSlave(deck)
    deck.setTempoRate(1 + r.rate.valueAsNumber / 100)
    r.rateVal.textContent = pct(deck.tempoRate)
  }
  const eqs = [r.eqLow, r.eqMid, r.eqHigh]
  const applyEq = () => deck.setEQ(eqs[0].valueAsNumber, eqs[1].valueAsNumber, eqs[2].valueAsNumber)
  eqs.forEach((e) => (e.oninput = applyEq))
  r.stemSliders.forEach((s, i) => (s.oninput = () => deck.setStemGain(i, s.valueAsNumber)))

  r.hotcueBtns.forEach((btn, i) => {
    btn.addEventListener('pointerdown', (e) => {
      if (e.shiftKey) actionPress(`deck${deck.id}.setHotcue${i + 1}`)
      else if (e.altKey) {
        deck.hotCues[i] = null
        persistTrack(deck)
        log(`deck ${deck.id} hot cue ${i + 1} cleared`)
      } else actionPress(`deck${deck.id}.hotcue${i + 1}`)
    })
  })

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
  wfFor(deck).setBuffer(deck.audioBuffer)
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
      t.source === 'soundcloud' ? 'SC' : '',
      t.grid?.bpm ? t.grid.bpm.toFixed(1) : '?',
      t.camelot ?? '',
      t.stems ? 'stems' : '',
      t.hotCues?.some((h) => h != null) ? 'cues' : ''
    ]
      .filter(Boolean)
      .join(' · ')
    li.innerHTML = `<span class="crate-name">${escapeHtml(t.name)}</span><span class="crate-meta">${escapeHtml(meta)}</span>`
    if (t.sourceUrl) li.title = t.sourceUrl
    li.addEventListener('click', () => void loadTrackIntoDeck(t))
    refs.crateList.append(li)
  }
}

refs.xfader.addEventListener('input', () => engine.mixer.setCrossfade(refs.xfader.valueAsNumber))
refs.master.addEventListener('input', () => {
  engine.master.gain.value = refs.master.valueAsNumber
})

let lastSyncUpdate = 0

function tick(): void {
  const now = performance.now()
  if (now - lastSyncUpdate > 200) {
    lastSyncUpdate = now
    syncCtl.update()
  }
  for (const deck of [engine.deckA, engine.deckB]) {
    const r = deckRefs(deck)
    r.playBtn.classList.toggle('active', deck.playing)
    r.syncBtn.classList.toggle('active', syncCtl.slave === deck.id)
    r.keylockBtn.classList.toggle('active', deck.keylock)
    const bpm = deck.effectiveBpm
    r.bpm.textContent = bpm ? bpm.toFixed(1) : '–.–'
    r.key.textContent = deck.track?.camelot ?? deck.track?.key ?? ''
    r.pos.textContent = fmtTime(deck.position)
    r.root.classList.toggle('focused', deck.id === focusedDeck)
    if (document.activeElement !== r.rate) {
      r.rate.value = String(((deck.tempoRate - 1) * 100).toFixed(2))
      r.rateVal.textContent = pct(deck.tempoRate)
    }
    for (let i = 0; i < r.hotcueBtns.length; i++) {
      r.hotcueBtns[i].classList.toggle('set', deck.hotCues[i] != null)
    }
    wfFor(deck).draw(deck)
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
  'deckA.play', 'deckA.cue', 'deckA.setCue', 'deckA.sync', 'deckA.keylock',
  'deckA.bendDown', 'deckA.bendUp',
  'deckA.hotcue1', 'deckA.hotcue2', 'deckA.hotcue3', 'deckA.hotcue4',
  'deckA.setHotcue1', 'deckA.setHotcue2', 'deckA.setHotcue3', 'deckA.setHotcue4',
  'deckB.play', 'deckB.cue', 'deckB.setCue', 'deckB.sync', 'deckB.keylock',
  'deckB.bendDown', 'deckB.bendUp',
  'deckB.hotcue1', 'deckB.hotcue2', 'deckB.hotcue3', 'deckB.hotcue4',
  'deckB.setHotcue1', 'deckB.setHotcue2', 'deckB.setHotcue3', 'deckB.setHotcue4',
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
// SoundCloud stream panel
// ---------------------------------------------------------------------------

function updateStreamPanel(): void {
  if (!sc.configured) {
    refs.streamStatus.textContent = 'not configured'
    refs.scConnect.textContent = 'setup…'
    refs.scConnect.disabled = true
    return
  }
  refs.scConnect.disabled = false
  if (sc.loggedIn) {
    refs.streamStatus.textContent = sc.username ? `@${sc.username}` : 'connected'
    refs.scConnect.textContent = 'disconnect'
  } else {
    refs.streamStatus.textContent = 'not connected'
    refs.scConnect.textContent = 'connect SoundCloud'
  }
}

refs.scConnect.addEventListener('click', async () => {
  if (!sc.configured) {
    log('soundcloud: copy soundcloud.config.example.json → soundcloud.config.json with your app credentials (docs/streaming.md)')
    return
  }
  if (sc.loggedIn) {
    await sc.logout()
    log('soundcloud disconnected')
  } else {
    log('soundcloud: opening browser for OAuth sign-in…')
    const r = await sc.login()
    if (r.ok) log(`soundcloud connected${r.username ? ` as @${r.username}` : ''}`)
    else log(`soundcloud login failed: ${r.error ?? 'unknown error'}`)
  }
  updateStreamPanel()
})

refs.scQuery.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  const q = refs.scQuery.value.trim()
  if (!q) return
  if (!sc.loggedIn) {
    log('soundcloud: connect first (STREAM panel → connect SoundCloud)')
    return
  }
  void (async () => {
    try {
      const results = await sc.search(q)
      renderStreamResults(results)
      log(`soundcloud: ${results.length} results for "${q}"`)
    } catch (err) {
      log(`soundcloud search failed: ${String(err)}`)
    }
  })()
})

function renderStreamResults(refsList: StreamTrackRef[]): void {
  refs.streamResults.innerHTML = ''
  for (const ref of refsList) {
    const li = document.createElement('li')
    const dur = ref.durationSec ? fmtTime(ref.durationSec) : '–:––'
    const label = ref.artist ? `${ref.title} — ${ref.artist}` : ref.title
    li.innerHTML = `<span class="crate-name">${escapeHtml(label)}</span><span class="crate-meta">${escapeHtml(dur)}</span>`
    if (ref.sourceUrl) li.title = ref.sourceUrl
    li.addEventListener('click', () => void addStreamTrack(ref))
    refs.streamResults.append(li)
  }
}

async function addStreamTrack(ref: StreamTrackRef): Promise<void> {
  try {
    log(`soundcloud: streaming "${ref.title}"…`)
    const r = await sc.resolve(ref)
    if (r.kind !== 'buffer') throw new Error('url streams not supported')
    const buffer = r.buffer
    const track: Track = {
      id: `soundcloud:${ref.id}`,
      name: ref.artist ? `${ref.title} — ${ref.artist}` : ref.title,
      path: ref.id,
      durationSec: buffer.duration,
      sampleRate: buffer.sampleRate,
      source: 'soundcloud',
      sourceUrl: ref.sourceUrl,
      stemsAllowed: false,
      analyzedAt: new Date().toISOString(),
      analysisSource: 'browser'
    }
    track.grid = computeBeatGrid(buffer)
    crate.upsert(track)
    renderCrate()
    await loadTrackIntoDeck(track, buffer)
    log(`added "${track.name}" (SoundCloud · beatgrid ${track.grid.bpm || '?'} BPM · stems off per ToS)`)
  } catch (e) {
    log(`soundcloud: ${String(e)}`)
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
  for (const deck of [engine.deckA, engine.deckB]) {
    deck.onEnded = () => log(`deck ${deck.id} track ended`)
    deck.onKeylockError = (m) =>
      log(`deck ${deck.id} key lock unavailable (${m}) — playing without it`)
  }
  renderMidiPanel()
  await sc.refreshStatus()
  updateStreamPanel()
  if (sc.configured && !sc.loggedIn) {
    log('soundcloud configured — click "connect SoundCloud" in the STREAM panel')
  } else if (!sc.configured) {
    log('soundcloud: set up soundcloud.config.json to enable streaming (docs/streaming.md)')
  }
  const midiOk = await midi.init()
  renderMidiPanel()
  log(
    midiOk
      ? 'midi ready — click "learn" next to an action, then touch a control'
      : 'web midi unavailable in this build'
  )
  log('drop tracks anywhere (or "add tracks…") — bpm runs instantly, stems follow via sidecar')
  log('SYNC engages a drift lock — press SYNC again to release it')
  window.addEventListener('pointerdown', () => engine.resume())
  requestAnimationFrame(tick)
})()
