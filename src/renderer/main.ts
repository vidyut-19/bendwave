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
import { delayFracLabel } from './engine/fx'
import { AudioMemory } from './engine/memory'
import { computeLoudness, autoGainDb, TARGET_LUFS } from './engine/analysis'
import { Sampler } from './engine/sampler'
import type { MidiBinding } from './midi/midi'

const AUDIO_EXT = /\.(wav|aiff?|flac|mp3|m4a|aac|ogg)$/i

const engine = new DJEngine()
const crate = new CrateStore()
const midi = new MidiRouter()
const syncCtl = new SyncController(engine)
const refs = buildApp(document.getElementById('app')!)

const sc = new SoundCloudProvider(engine.ctx)
registerProvider(sc)

// decoded-audio budget manager (see docs/memory.md)
const audioMem = new AudioMemory()

// auto-gain: normalize tracks to TARGET_LUFS via trim on deck load
let autoGain = localStorage.getItem('vibedeck.autogain') !== 'off'

// one-shot sampler (kicks/claps/tones) — straight to master, crossfader-bypassed
const sampler = new Sampler(engine.ctx, engine.master)
const SAMPLER_KEY = 'vibedeck.sampler.v1'

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
  track.pcmBytes = AudioMemory.bytesOf(buffer)
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
    audioMem.track(track.id, track.name, (track.pcmBytes ?? 0) + AudioMemory.bytesOf(...bufs))
  } catch (e) {
    log(`stem load failed: ${String(e)}`)
  }
}

/** register a streamed buffer with the budget; LRU eviction drops the provider cache entry */
function registerSCMemory(id: string, label: string, buffer: AudioBuffer): void {
  audioMem.track(`sc:${id}`, `sc:${label}`, AudioMemory.bytesOf(buffer), () => {
    sc.cacheDelete(id)
    log(`memory: evicted cached stream "${label}"`)
  })
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
        registerSCMemory(track.path, track.name, buf)
      } else {
        buf = await decodePath(track.path)
      }
    }
    const stemBufs = track.stems ? await loadStemBuffers(track) : []
    await deck.load(track, buf, stemBufs)
    audioMem.track(track.id, track.name, AudioMemory.bytesOf(buf, ...stemBufs))
    focusedDeck = deck.id
    if (track.gainDb == null) {
      track.lufs = computeLoudness(buf)
      track.gainDb = autoGainDb(track.lufs)
      crate.upsert(track)
    }
    if (autoGain && track.gainDb != null) {
      deck.setTrim(track.gainDb)
      const r = deckRefs(deck)
      if (document.activeElement !== r.trim) r.trim.value = String(track.gainDb.toFixed(1))
      log(
        `deck ${deck.id} auto-gain ${track.gainDb >= 0 ? '+' : ''}${track.gainDb.toFixed(1)} dB` +
          (isFinite(track.lufs ?? NaN) ? ` (track ${(track.lufs as number).toFixed(1)} LUFS → ${TARGET_LUFS})` : '')
      )
    }
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

  const sp = /^sampler\.pad([1-8])$/.exec(action)
  if (sp) {
    sampler.trigger(Number(sp[1]) - 1)
    return
  }

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

    const lp = /^loop([1248])$/.exec(verb)
    if (lp) {
      const beats = Number(lp[1])
      if (deck.loopLatch) deck.toggleLoop(beats)
      else deck.loopBeats(beats)
      if (deck.activeLoop && syncCtl.slave === deck.id) {
        syncCtl.disengage()
        log(`deck ${deck.id} sync lock released (loop)`)
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
      case 'delay':
        deck.fx.setDelay(!deck.fx.delayOn)
        break
      case 'delayFrac': {
        const f = deck.fx.cycleDelayFrac()
        log(`deck ${deck.id} delay = ${delayFracLabel(f)} beat`)
        break
      }
      case 'reverb':
        deck.fx.setReverb(!deck.fx.reverbOn)
        break
      case 'echoOut':
        deck.fx.echoOutEngage()
        break
      case 'cueMix':
        engine.setCueMix(deck.id, !engine.isCueMix(deck.id))
        break
      case 'loopLatch':
        deck.loopLatch = !deck.loopLatch
        log(`deck ${deck.id} loops: ${deck.loopLatch ? 'latching' : 'momentary rolls'}`)
        break
      case 'loopExit':
        deck.exitLoop()
        break
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
    case 'mix.splitCue': {
      const on = engine.setSplitCue(!engine.splitCue)
      if (on) {
        log('split cue ON — master → ch 1/2, headphone cue → ch 3/4. create a macOS Aggregate Device (speakers + headphones) and select it as the sound output')
      } else {
        log('split cue OFF — everything on the default stereo output')
      }
      break
    }
    case 'mix.autoGain': {
      autoGain = !autoGain
      localStorage.setItem('vibedeck.autogain', autoGain ? 'on' : 'off')
      log(`auto-gain ${autoGain ? `ON — normalizing to ${TARGET_LUFS} LUFS on load` : 'OFF'}`)
      if (autoGain) {
        for (const d of [engine.deckA, engine.deckB]) {
          if (d.track?.gainDb != null) {
            d.setTrim(d.track.gainDb)
            const r = deckRefs(d)
            if (document.activeElement !== r.trim) r.trim.value = String(d.track.gainDb.toFixed(1))
          }
        }
      }
      break
    }
  }
}

function actionRelease(action: string): void {
  const deck = deckOf(action)
  if (deck) {
    const verb = action.slice(6)
    if (verb === 'cue') deck.cueRelease()
    else if (verb === 'bendDown' || verb === 'bendUp') deck.bend(0)
    else if (verb === 'echoOut') deck.fx.echoOutRelease()
    else if (/^loop[1248]$/.test(verb)) deck.releaseLoop()
    return
  }
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
  Space: 'mix.crossCenter',
  KeyG: 'deckA.echoOut',
  KeyH: 'deckB.echoOut',
  KeyZ: 'deckA.cueMix',
  Slash: 'deckB.cueMix',
  KeyX: 'mix.splitCue',
  Digit4: 'deckA.loop1',
  Digit5: 'deckA.loop2',
  Digit6: 'deckA.loop4',
  Digit7: 'deckA.loop8',
  KeyB: 'deckB.loop1',
  KeyN: 'deckB.loop2',
  KeyM: 'deckB.loop4',
  Quote: 'deckB.loop8',
  KeyT: 'deckA.loopLatch',
  KeyY: 'deckB.loopLatch',
  KeyC: 'mix.autoGain'
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
  if (e.shiftKey && /^Digit[1-8]$/.test(e.code)) {
    e.preventDefault()
    if (e.repeat) return
    sampler.trigger(Number(e.code.slice(5)) - 1)
    return
  }
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
  r.filter.oninput = () => deck.setFilter(r.filter.valueAsNumber)
  r.filter.ondblclick = () => {
    r.filter.value = '0'
    deck.setFilter(0)
  }
  r.wet.oninput = () => deck.fx.setWet(r.wet.valueAsNumber)
  r.fb.oninput = () => deck.fx.setFb(r.fb.valueAsNumber)
  r.vol.oninput = () => deck.setVolume(r.vol.valueAsNumber)
  r.trim.oninput = () => deck.setTrim(r.trim.valueAsNumber)

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
    const mb = t.pcmBytes ? `${(t.pcmBytes / (1024 * 1024)).toFixed(0)}MB` : ''
    li.title = `${fmtTime(t.durationSec)}${mb ? ` · ${mb} PCM` : ''}${t.sourceUrl ? ` · ${t.sourceUrl}` : ''}`
    li.addEventListener('click', () => void loadTrackIntoDeck(t))
    refs.crateList.append(li)
  }
}

refs.xfader.addEventListener('input', () => engine.mixer.setCrossfade(refs.xfader.valueAsNumber))
refs.master.addEventListener('input', () => {
  engine.master.gain.value = refs.master.valueAsNumber
})

// ---------------------------------------------------------------------------
// sampler: pads, drag & drop, persistence
// ---------------------------------------------------------------------------

function updateSamplerUI(): void {
  refs.samplerPads.forEach((pad, i) => {
    const info = sampler.info(i)
    pad.classList.toggle('loaded', !!info)
    pad.title = info ? info.name : 'empty — drop an audio file here'
  })
}

function persistSampler(): void {
  const recs = Array.from({ length: sampler.count }, (_, i) => {
    const info = sampler.info(i)
    return info ? { name: info.name, path: info.path } : null
  })
  localStorage.setItem(SAMPLER_KEY, JSON.stringify(recs))
}

async function restoreSampler(): Promise<void> {
  try {
    const recs = JSON.parse(localStorage.getItem(SAMPLER_KEY) ?? '[]') as ({ name: string; path: string } | null)[]
    let n = 0
    for (let i = 0; i < sampler.count && i < recs.length; i++) {
      const r = recs[i]
      if (!r?.path) continue
      try {
        const b = await decodePath(r.path)
        sampler.load(i, r.name, r.path, b)
        n++
      } catch {
        /* file moved or deleted */
      }
    }
    if (n > 0) log(`sampler: restored ${n} slot(s)`)
  } catch {
    /* corrupt config */
  }
  updateSamplerUI()
}

refs.samplerVol.addEventListener('input', () => sampler.setMaster(refs.samplerVol.valueAsNumber))

refs.samplerPads.forEach((pad, i) => {
  pad.addEventListener('pointerdown', (e) => {
    if (e.altKey) {
      sampler.clear(i)
      persistSampler()
      updateSamplerUI()
      log(`sampler slot ${i + 1} cleared`)
      return
    }
    actionPress(`sampler.pad${i + 1}`)
  })
  pad.addEventListener('dragover', (e) => e.preventDefault())
  pad.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const f = e.dataTransfer?.files?.[0]
    if (!f || !AUDIO_EXT.test(f.name)) {
      log(`sampler: unsupported file (want wav/mp3/flac/aiff)`)
      return
    }
    void (async () => {
      try {
        const buffer = await decodeFile(f)
        const path = window.vibedeck?.filePathFor(f) ?? f.name
        const name = f.name.replace(/\.[^.]+$/, '')
        sampler.load(i, name, path, buffer)
        persistSampler()
        updateSamplerUI()
        audioMem.track(`smp:${i + 1}`, `sample:${name}`, AudioMemory.bytesOf(buffer))
        log(`sampler slot ${i + 1} ← "${name}"`)
      } catch (err) {
        log(`sampler: failed to load ${f.name}: ${String(err)}`)
      }
    })()
  })
})

let lastSyncUpdate = 0
let lastFxBpmUpdate = 0
let lastMemUpdate = 0
let lastMemEnforce = 0

function tick(): void {
  const now = performance.now()
  if (now - lastSyncUpdate > 200) {
    lastSyncUpdate = now
    syncCtl.update()
  }
  if (now - lastMemUpdate > 1000) {
    lastMemUpdate = now
    const u = audioMem.usage()
    refs.memMeter.textContent = `AUDIO ${AudioMemory.fmt(u.used)} / ${AudioMemory.fmt(u.budget)}`
    refs.memMeter.classList.toggle('warn', u.used > u.budget * 0.85)
  }
  if (now - lastMemEnforce > 3000) {
    lastMemEnforce = now
    for (const d of [engine.deckA, engine.deckB]) {
      if (d.track) audioMem.touch(d.track.id)
    }
    const { evicted } = audioMem.enforce([
      engine.deckA.track?.id ?? '',
      engine.deckB.track?.id ?? ''
    ])
    for (const label of evicted) log(`memory: over budget — evicted ${label}`)
  }
  const updateFxBpm = now - lastFxBpmUpdate > 250
  if (updateFxBpm) lastFxBpmUpdate = now
  for (const deck of [engine.deckA, engine.deckB]) {
    const r = deckRefs(deck)
    r.playBtn.classList.toggle('active', deck.playing)
    r.syncBtn.classList.toggle('active', syncCtl.slave === deck.id)
    r.keylockBtn.classList.toggle('active', deck.keylock)
    r.delayBtn.classList.toggle('active', deck.fx.delayOn)
    r.reverbBtn.classList.toggle('active', deck.fx.reverbOn)
    r.echoBtn.classList.toggle('active', deck.fx.echoActive)
    r.cueMixBtn.classList.toggle('active', engine.isCueMix(deck.id))
    r.fracBtn.textContent = delayFracLabel(deck.fx.delayFrac)
    r.loopLatchBtn.classList.toggle('active', deck.loopLatch)
    const LOOP_SIZES = [1, 2, 4, 8]
    for (let i = 0; i < r.loopBtns.length; i++) {
      r.loopBtns[i].classList.toggle('active', !!deck.activeLoop && deck.activeLoop.beats === LOOP_SIZES[i])
    }
    deck.updateLoop()
    if (updateFxBpm && (deck.fx.delayOn || deck.fx.echoActive)) {
      deck.fx.setBpm(deck.effectiveBpm ?? deck.track?.grid?.bpm ?? 0)
    }
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
  refs.splitCueBtn.classList.toggle('active', engine.splitCue)
  refs.autoGainBtn.classList.toggle('active', autoGain)
  requestAnimationFrame(tick)
}

// ---------------------------------------------------------------------------
// MIDI learn panel
// ---------------------------------------------------------------------------

const ACTION_IDS = [
  'deckA.play', 'deckA.cue', 'deckA.setCue', 'deckA.sync', 'deckA.keylock',
  'deckA.bendDown', 'deckA.bendUp', 'deckA.cueMix',
  'deckA.hotcue1', 'deckA.hotcue2', 'deckA.hotcue3', 'deckA.hotcue4',
  'deckA.setHotcue1', 'deckA.setHotcue2', 'deckA.setHotcue3', 'deckA.setHotcue4',
  'deckA.delay', 'deckA.delayFrac', 'deckA.reverb', 'deckA.echoOut',
  'deckA.filter', 'deckA.volume', 'deckA.delayWet', 'deckA.delayFb', 'deckA.trim',
  'deckA.loop1', 'deckA.loop2', 'deckA.loop4', 'deckA.loop8', 'deckA.loopLatch', 'deckA.loopExit',
  'deckB.play', 'deckB.cue', 'deckB.setCue', 'deckB.sync', 'deckB.keylock',
  'deckB.bendDown', 'deckB.bendUp', 'deckB.cueMix',
  'deckB.hotcue1', 'deckB.hotcue2', 'deckB.hotcue3', 'deckB.hotcue4',
  'deckB.setHotcue1', 'deckB.setHotcue2', 'deckB.setHotcue3', 'deckB.setHotcue4',
  'deckB.delay', 'deckB.delayFrac', 'deckB.reverb', 'deckB.echoOut',
  'deckB.filter', 'deckB.volume', 'deckB.delayWet', 'deckB.delayFb', 'deckB.trim',
  'deckB.loop1', 'deckB.loop2', 'deckB.loop4', 'deckB.loop8', 'deckB.loopLatch', 'deckB.loopExit',
  'sampler.pad1', 'sampler.pad2', 'sampler.pad3', 'sampler.pad4',
  'sampler.pad5', 'sampler.pad6', 'sampler.pad7', 'sampler.pad8', 'sampler.volume',
  'mix.crossLeft', 'mix.crossRight', 'mix.crossCenter', 'mix.crossfade', 'mix.splitCue', 'mix.autoGain'
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
  // sampler pads are velocity-sensitive
  const sp = /^sampler\.pad([1-8])$/.exec(actionId)
  if (sp) {
    if (msg.type === 'note' && msg.value > 0) sampler.trigger(Number(sp[1]) - 1, msg.value / 127)
    else if (msg.type === 'cc' && msg.value > 63) sampler.trigger(Number(sp[1]) - 1)
    return
  }
  // continuous (CC value) actions
  if (msg.type === 'cc') {
    if (actionId === 'mix.crossfade') {
      engine.mixer.setCrossfade(msg.value / 127)
      return
    }
    if (actionId === 'sampler.volume') {
      sampler.setMaster(msg.value / 127)
      return
    }
    const deck = deckOf(actionId)
    if (deck) {
      if (actionId.endsWith('.filter')) {
        deck.setFilter((msg.value - 64) / 63)
        return
      }
      if (actionId.endsWith('.volume')) {
        deck.setVolume(msg.value / 127)
        return
      }
      if (actionId.endsWith('.delayWet')) {
        deck.fx.setWet(msg.value / 127)
        return
      }
      if (actionId.endsWith('.delayFb')) {
        deck.fx.setFb((msg.value / 127) * 0.9)
        return
      }
      if (actionId.endsWith('.trim')) {
        deck.setTrim((msg.value / 127) * 24 - 12)
        return
      }
    }
  }
  // press/release actions
  if (msg.type === 'note') {
    if (msg.value > 0) actionPress(actionId)
    else actionRelease(actionId)
  } else {
    if (msg.value > 63) actionPress(actionId)
    else actionRelease(actionId)
  }
}

// ---------------------------------------------------------------------------
// K.O. II pad preset + auto-map wizard
// ---------------------------------------------------------------------------

// K.O. II pads send MIDI notes per group (documented in TE's guide):
// group A = 36–47, B = 48–59, C = 60–71, D = 72–83 (channel 1 by default).
const KO2_PAD_ACTIONS: [number, string][] = [
  // group A — deck A
  [36, 'deckA.play'], [37, 'deckA.cue'], [38, 'deckA.setCue'], [39, 'deckA.sync'],
  [40, 'deckA.hotcue1'], [41, 'deckA.hotcue2'], [42, 'deckA.hotcue3'], [43, 'deckA.hotcue4'],
  [44, 'deckA.echoOut'], [45, 'deckA.delay'], [46, 'deckA.delayFrac'], [47, 'deckA.reverb'],
  // group B — deck A setters + loops
  [48, 'deckA.setHotcue1'], [49, 'deckA.setHotcue2'], [50, 'deckA.setHotcue3'], [51, 'deckA.setHotcue4'],
  [52, 'deckA.cueMix'], [53, 'deckA.keylock'],
  [54, 'deckA.loop1'], [55, 'deckA.loop2'], [56, 'deckA.loop4'], [57, 'deckA.loop8'],
  [58, 'deckA.loopExit'], [59, 'deckA.loopLatch'],
  // group C — deck B
  [60, 'deckB.play'], [61, 'deckB.cue'], [62, 'deckB.setCue'], [63, 'deckB.sync'],
  [64, 'deckB.hotcue1'], [65, 'deckB.hotcue2'], [66, 'deckB.hotcue3'], [67, 'deckB.hotcue4'],
  [68, 'deckB.echoOut'], [69, 'deckB.delay'], [70, 'deckB.delayFrac'], [71, 'deckB.reverb'],
  // group D — deck B setters + loops
  [72, 'deckB.setHotcue1'], [73, 'deckB.setHotcue2'], [74, 'deckB.setHotcue3'], [75, 'deckB.setHotcue4'],
  [76, 'deckB.cueMix'], [77, 'deckB.keylock'],
  [78, 'deckB.loop1'], [79, 'deckB.loop2'], [80, 'deckB.loop4'], [81, 'deckB.loop8'],
  [82, 'deckB.loopExit'], [83, 'deckB.loopLatch']
]

function ko2Preset(): Record<string, MidiBinding> {
  const out: Record<string, MidiBinding> = {}
  for (const [note, action] of KO2_PAD_ACTIONS) out[action] = { type: 'note', channel: 0, control: note }
  return out
}

refs.midiKo2.addEventListener('click', () => {
  midi.applyPreset(ko2Preset())
  log('loaded K.O. II pad preset (groups A/C = deck controls, B/D = hot cue setters). faders/knobs: use learn or the wizard. tip: set pads to sound 000 on the K.O. II so they stay silent')
})

const WIZARD_ACTIONS = [
  'deckA.play', 'deckA.cue', 'deckA.sync',
  'deckA.hotcue1', 'deckA.hotcue2', 'deckA.hotcue3', 'deckA.hotcue4',
  'deckA.echoOut', 'deckA.delay', 'deckA.delayFrac', 'deckA.reverb',
  'deckA.loop1', 'deckA.loop2', 'deckA.loop4', 'deckA.loop8',
  'deckA.cueMix', 'deckA.filter', 'deckA.volume',
  'deckB.play', 'deckB.cue', 'deckB.sync',
  'deckB.hotcue1', 'deckB.hotcue2', 'deckB.hotcue3', 'deckB.hotcue4',
  'deckB.echoOut', 'deckB.delay', 'deckB.delayFrac', 'deckB.reverb',
  'deckB.loop1', 'deckB.loop2', 'deckB.loop4', 'deckB.loop8',
  'deckB.cueMix', 'deckB.filter', 'deckB.volume',
  'mix.crossfade'
]

refs.midiWizard.addEventListener('click', () => {
  if (midi.isSequencing) {
    midi.startSequence(null)
    return
  }
  log('auto-map wizard: touch controls on your device in the order shown — click the button again to cancel')
  midi.startSequence(WIZARD_ACTIONS, {
    onStep: (action, i, n) => {
      refs.midiWizardStatus.textContent = `${i}/${n} — ${action} — touch a control…`
    },
    onDone: () => {
      refs.midiWizardStatus.textContent = 'auto-map complete ✓'
      log('auto-map wizard complete — bindings saved')
    },
    onCancel: () => {
      refs.midiWizardStatus.textContent = ''
    }
  })
})

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
    track.pcmBytes = AudioMemory.bytesOf(buffer)
    registerSCMemory(ref.id, track.name, buffer)
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
  await restoreSampler()
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
