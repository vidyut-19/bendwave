import './style.css'
import { DJEngine } from './engine/engine'
import { computeBeatGrid } from './engine/analysis'
import { WaveformView, camelotColor, type WaveformMode } from './engine/waveform'
import { SyncController } from './engine/sync'
import { STEM_ORDER, type Deck, type Track } from './engine/deck'
import { CrateStore } from './crate/store'
import { MidiRouter } from './midi/midi'
import { buildApp, ICO_PLAY, ICO_PAUSE, type AppRefs, type DeckRefs } from './ui'
import { SoundCloudProvider } from './sources/soundcloud'
import { registerProvider, type StreamTrackRef } from './sources/provider'
import { delayFracLabel } from './engine/fx'
import { AudioMemory } from './engine/memory'
import { computeLoudness, autoGainDb, TARGET_LUFS } from './engine/analysis'
import { parseAudioTags, type AudioTags } from './engine/id3'
import { analyzeStructure, annotateVocals, pickAutoCues, SECTION_COLORS } from './engine/structure'
import { computeFingerprint, describeFingerprint } from './engine/fingerprint'
import { planTransition, recommendNext, type VibeMode } from './engine/copilot'
import { planSetPath, type SetArc, type AutoStrategy } from './engine/planner'
import { TransitionRunner, drawTransitionCurves, STRATEGY_META } from './engine/transition'
import { Sampler } from './engine/sampler'
import { Recorder } from './engine/recorder'
import { DeckMeterView, MasterMeterView } from './engine/meter'
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

// master-bus recorder (streaming WAV to disk)
const recorder = new Recorder(engine.ctx)

// live automated transition runner (Spotify-Mix-style envelopes + stems + touch-to-override)
const txRunner = new TransitionRunner(engine)
let txStrategyOverride: AutoStrategy | 'AUTO' = 'AUTO'
let txBarsOverride: 4 | 8 | 'AUTO' = 'AUTO'
let txCurveCanvas: HTMLCanvasElement | null = null
let txCurrentStrategy: AutoStrategy = 'BASS_SWAP'
let txCurrentBars: 4 | 8 = 8

// set path planner state
let setArc: SetArc = 'arc'
let planSeed = 0
let planGenreBreak = false

function stopRecording(reason?: string): void {
  if (!recorder.recording) return
  void (async () => {
    const p = await recorder.stop()
    if (p) log(`recording saved → ${p}`)
    if (reason) log(reason)
  })()
}

const waveforms = new Map<string, WaveformView>()
const deckMeters = new Map<string, DeckMeterView>()
const masterMeter = new MasterMeterView(refs.masterVu)
/** remembered pre-mute gain per deck + stem index for click-to-mute/solo */
const stemSavedGain: Record<'A' | 'B', number[]> = { A: [1, 1, 1, 1], B: [1, 1, 1, 1] }

// Hardware chassis finish toggle: EP-133 Putty ('ko2-light') ↔ Dark Booth ('ko2-dark')
type ChassisTheme = 'ko2-light' | 'ko2-dark'
let chassisTheme: ChassisTheme =
  localStorage.getItem('vibedeck.theme') === 'ko2-dark' ? 'ko2-dark' : 'ko2-light'

function applyTheme(t: ChassisTheme): void {
  chassisTheme = t
  document.documentElement.dataset.theme = t
  refs.themeBtn.textContent = t === 'ko2-light' ? 'DARK' : 'PUTTY'
  localStorage.setItem('vibedeck.theme', t)
  for (const wf of waveforms.values()) wf.markDirty()
  if (txCurveCanvas) drawTransitionCurves(txCurveCanvas, txCurrentStrategy, txCurrentBars, txRunner.active?.progress ?? null)
}
applyTheme(chassisTheme)
refs.themeBtn.addEventListener('click', () => {
  applyTheme(chassisTheme === 'ko2-light' ? 'ko2-dark' : 'ko2-light')
})

/** Physically depress the matching on-screen keycap when triggered via K.O. II MIDI or keyboard */
function setActionPressed(actionId: string, down: boolean): void {
  const btn = document.querySelector<HTMLButtonElement>(`button[data-act="${actionId}"]`)
  if (!btn) return
  btn.classList.toggle('midi-pressed', down)
}

let focusedDeck: 'A' | 'B' = 'A'
let userDataDir = ''
let envHasDemucs = false
let vibeMode: VibeMode = 'flow'

// Serialized 1-at-a-time Demucs/sidecar queue so batch imports never spawn 25 parallel PyTorch processes
const sidecarQueue: Track[] = []
const sidecarQueuedIds = new Set<string>()
let sidecarBusyId: string | null = null

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

async function decodeFileWithTags(file: File): Promise<{ buffer: AudioBuffer; tags: AudioTags }> {
  const ab = await file.arrayBuffer()
  const tags = parseAudioTags(ab)
  const buffer = await engine.ctx.decodeAudioData(ab)
  return { buffer, tags }
}

async function decodeFile(file: File): Promise<AudioBuffer> {
  return (await decodeFileWithTags(file)).buffer
}

async function decodePathWithTags(path: string): Promise<{ buffer: AudioBuffer; tags: AudioTags }> {
  const api = window.vibedeck
  if (!api) throw new Error('not running under electron')
  const u8 = await api.readAudio(path)
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
  const tags = parseAudioTags(ab)
  const buffer = await engine.ctx.decodeAudioData(ab)
  return { buffer, tags }
}

async function decodePath(path: string): Promise<AudioBuffer> {
  return (await decodePathWithTags(path)).buffer
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

function applyTagsToTrack(track: Track, tags: AudioTags): void {
  if (tags.bpm && track.analysisSource !== 'manual') {
    track.grid = {
      ...(track.grid ?? {}),
      bpm: tags.bpm,
      offset: tags.offset ?? track.grid?.offset ?? 0
    }
    if (tags.offset != null) track.analysisSource = 'sidecar'
  }
  if (tags.key) {
    track.key = tags.key
    track.camelot = tags.camelot
  }
}

async function ingest(
  path: string,
  name: string,
  buffer: AudioBuffer,
  tags: AudioTags = {},
  opts: { loadIntoDeck?: boolean; runStems?: boolean; targetDeck?: Deck } = {}
): Promise<Track> {
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

  // 1. Embedded Serato / ID3 tags first (exact BPM, downbeat, key in <1ms)
  applyTagsToTrack(track, tags)

  // 2. Fallback browser beatgrid when tags had no BPM
  if (!track.grid || track.grid.bpm <= 0) {
    track.grid = computeBeatGrid(buffer)
    track.analysisSource = 'browser'
  }

  // 3. Instant loudness + bar-synchronous Arrangement, Vibe & Deep Fingerprint (<60ms)
  if (track.gainDb == null) {
    track.lufs = computeLoudness(buffer)
    track.gainDb = autoGainDb(track.lufs)
  }
  if (!track.sections?.length || !track.vibe) {
    const { sections, vibe } = analyzeStructure(buffer, track.grid)
    track.sections = sections
    track.vibe = vibe
  }
  if (!track.fingerprint) {
    track.fingerprint = computeFingerprint(buffer, track.grid)
  }

  track.analyzedAt = new Date().toISOString()
  crate.upsert(track)
  renderCrate()

  const tagNote = tags.bpm ? 'Serato/ID3' : 'browser'
  log(
    `added "${name}" — ${track.grid.bpm.toFixed(1)} BPM (${tagNote})` +
      (track.camelot ? ` · ${track.camelot}` : '') +
      ` · ${track.sections?.length ?? 0} sections`
  )

  if (opts.loadIntoDeck !== false) {
    await loadTrackIntoDeck(track, buffer, { targetDeck: opts.targetDeck })
  }

  // Queue sidecar if we still need stems (when requested) or if key is still missing
  const needStems = opts.runStems !== false && !track.stems && envHasDemucs
  const needKey = !track.key && !track.source
  if ((needStems || needKey) && !track.source && track.stemsAllowed !== false) {
    queueSidecar(track)
  }
  renderCopilot()
  return track
}

function queueSidecar(track: Track): void {
  if (track.source || track.stemsAllowed === false) return
  if (sidecarBusyId === track.id || sidecarQueuedIds.has(track.id)) return
  sidecarQueuedIds.add(track.id)
  sidecarQueue.push(track)
  updateStemsButtons()
  renderCrate()
  void drainSidecarQueue()
}

async function drainSidecarQueue(): Promise<void> {
  if (sidecarBusyId) return
  while (sidecarQueue.length > 0) {
    const track = sidecarQueue.shift()!
    sidecarQueuedIds.delete(track.id)
    sidecarBusyId = track.id
    updateStemsButtons()
    renderCrate()
    try {
      await enhanceWithSidecar(track)
    } finally {
      sidecarBusyId = null
      updateStemsButtons()
      renderCrate()
    }
  }
}

async function enhanceWithSidecar(track: Track): Promise<void> {
  const api = window.vibedeck
  if (!api) return
  if (track.source || track.stemsAllowed === false) return
  if (!userDataDir) {
    try {
      userDataDir = (await api.paths()).userData
    } catch {
      return
    }
  }
  const wantStems = !track.stems
  log(`analyzing "${track.name}" (${wantStems ? 'stems + metadata' : 'metadata'} via sidecar)…`)
  const started = performance.now()
  const r = await api.analyze(track.path, {
    stems: wantStems,
    stemsDir: `${userDataDir}/stems/${slug(track.id)}`
  })
  if (!r.ok || !r.result) {
    log('sidecar analysis unavailable — click "install analysis env" / "+ stems" in the header')
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
  let gridChanged = false
  if (typeof res.bpm === 'number' && res.bpm > 0 && track.analysisSource !== 'manual') {
    const prevBpm = track.grid?.bpm ?? 0
    const prevOff = track.grid?.offset ?? 0
    track.grid = {
      ...(track.grid ?? {}),
      bpm: res.bpm,
      offset: res.offset ?? track.grid?.offset ?? 0
    }
    track.analysisSource = 'sidecar'
    gridChanged = Math.abs(prevBpm - res.bpm) > 0.05 || Math.abs(prevOff - track.grid.offset) > 0.05
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
  for (const d of [engine.deckA, engine.deckB]) {
    if (d.track?.id === track.id) {
      if (gridChanged && d.audioBuffer) {
        const { sections, vibe } = analyzeStructure(d.audioBuffer, track.grid)
        track.sections = sections
        track.vibe = vibe
      }
      updateDeckMeta(d)
      wfFor(d).markDirty()
    }
  }
  crate.upsert(track)
  renderCrate()
  renderCopilot()
  log(`analyzed "${track.name}" in ${((performance.now() - started) / 1000).toFixed(1)}s${track.key ? ` — ${track.key}` : ''}`)
}

async function attachStems(deck: Deck, track: Track): Promise<void> {
  try {
    const bufs = await loadStemBuffers(track)
    if (deck.track?.id !== track.id) return
    if (bufs.length === 4 && track.sections?.length) {
      annotateVocals(track.sections, bufs[3]) // index 3 = vocals
      crate.upsert(track)
    }
    deck.setStemBuffers(bufs)
    wfFor(deck).setStems(bufs)
    deck.releaseMainMix() // stems replace the mix: free ~106 MB per 5-min track
    stemSavedGain[deck.id] = [1, 1, 1, 1]
    updateStemsUI(deck)
    syncWaveformModeButtons(deck)
    wfFor(deck).markDirty()
    wfFor(deck).draw(deck)
    audioMem.track(track.id, track.name, AudioMemory.bytesOf(...bufs))
    renderCopilot()
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

const deckLoading: Record<'A' | 'B', string | null> = { A: null, B: null }

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

function syncDeckStatus(deck: Deck): void {
  const r = deckRefs(deck)
  const loadMsg = deckLoading[deck.id]
  if (loadMsg) {
    r.statusBadge.textContent = loadMsg
    r.statusBadge.classList.remove('stems')
    r.statusBadge.hidden = false
    return
  }
  const t = deck.track
  if (t && sidecarBusyId === t.id) {
    r.statusBadge.textContent = 'STEMS…'
    r.statusBadge.classList.add('stems')
    r.statusBadge.hidden = false
    return
  }
  if (t && sidecarQueuedIds.has(t.id)) {
    r.statusBadge.textContent = 'STEMS QUEUED'
    r.statusBadge.classList.add('stems')
    r.statusBadge.hidden = false
    return
  }
  r.statusBadge.hidden = true
}

async function loadTrackIntoDeck(
  track: Track,
  buffer?: AudioBuffer,
  opts: { targetDeck?: Deck; cueAtSec?: number } = {}
): Promise<Deck | null> {
  if (recorder.recording && track.source === 'soundcloud') {
    stopRecording('recording stopped — a streamed track was loaded (SoundCloud terms)')
  }
  const deck =
    opts.targetDeck ??
    (!engine.deckA.hasAudio && !deckLoading.A
      ? engine.deckA
      : !engine.deckB.hasAudio && !deckLoading.B
        ? engine.deckB
        : focusedDeck === 'B'
          ? engine.deckB
          : engine.deckA)
  releaseSyncIfSlave(deck)
  deckLoading[deck.id] = track.source === 'soundcloud' ? 'STREAMING…' : 'LOADING…'
  syncDeckStatus(deck)
  if (!buffer) await nextFrame()
  try {
    let buf = buffer
    let tags: AudioTags = {}
    if (!buf) {
      if (track.source === 'soundcloud') {
        const r = await sc.resolve(refFromTrack(track))
        if (r.kind !== 'buffer') throw new Error('url streams not supported')
        buf = r.buffer
        registerSCMemory(track.path, track.name, buf)
      } else {
        const dec = await decodePathWithTags(track.path)
        buf = dec.buffer
        tags = dec.tags
      }
    }

    // Backfill Serato/ID3 tags, arrangement, vibe & deep fingerprint for older crate entries
    const hadTags = !!tags.bpm || !!tags.key
    if (hadTags) applyTagsToTrack(track, tags)
    if (!track.sections?.length || !track.vibe || hadTags) {
      const { sections, vibe } = analyzeStructure(buf, track.grid)
      track.sections = sections
      track.vibe = vibe
    }
    if (!track.fingerprint || hadTags) {
      track.fingerprint = computeFingerprint(buf, track.grid)
    }

    const stemBufs = track.stems ? await loadStemBuffers(track) : []
    if (stemBufs.length === 4 && track.sections?.length) {
      annotateVocals(track.sections, stemBufs[3])
    }
    await deck.load(track, buf, stemBufs)
    const wf = wfFor(deck)
    wf.setBuffer(buf)
    if (stemBufs.length === 4) {
      wf.setStems(stemBufs)
      deck.releaseMainMix() // peaks are captured; stems handle playback
      audioMem.track(track.id, track.name, AudioMemory.bytesOf(...stemBufs))
    } else {
      audioMem.track(track.id, track.name, AudioMemory.bytesOf(buf, ...stemBufs))
    }
    stemSavedGain[deck.id] = [1, 1, 1, 1]
    focusedDeck = deck.id
    if (track.gainDb == null) {
      track.lufs = computeLoudness(buf)
      track.gainDb = autoGainDb(track.lufs)
    }
    crate.upsert(track)
    renderCrate()
    const r = deckRefs(deck)
    if (autoGain && track.gainDb != null) {
      deck.setTrim(track.gainDb)
      if (!r.trim.dragging) r.trim.setValue(track.gainDb)
      log(
        `deck ${deck.id} auto-gain ${track.gainDb >= 0 ? '+' : ''}${track.gainDb.toFixed(1)} dB` +
          (isFinite(track.lufs ?? NaN) ? ` (track ${(track.lufs as number).toFixed(1)} LUFS → ${TARGET_LUFS})` : '')
      )
    } else if (!autoGain) {
      deck.setTrim(0)
      if (!r.trim.dragging) r.trim.setValue(0)
    }
    if (opts.cueAtSec != null && opts.cueAtSec >= 0) {
      deck.seek(opts.cueAtSec)
      deck.setCueHere()
      wf.markDirty()
    }
    updateDeckUI(deck)
    updateStemsUI(deck)
    syncWaveformModeButtons(deck)
    updateStemsButtons()
    wf.markDirty()
    wf.draw(deck)
    renderCopilot()

    // Auto-queue stems on loaded local tracks whenever demucs is available
    if (!track.stems && !track.source && track.stemsAllowed !== false && envHasDemucs) {
      queueSidecar(track)
    }

    log(`loaded "${track.name}" → deck ${deck.id}`)
    return deck
  } catch (e) {
    log(`could not load "${track.name}": ${String(e)}`)
    return null
  } finally {
    deckLoading[deck.id] = null
    syncDeckStatus(deck)
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

function recomputeArrangement(deck: Deck): void {
  const t = deck.track
  if (!t || !t.grid) return
  if (deck.audioBuffer) {
    const { sections, vibe } = analyzeStructure(deck.audioBuffer, t.grid)
    t.sections = sections
    t.vibe = vibe
  }
  persistTrack(deck)
  wfFor(deck).markDirty()
  renderCopilot()
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
        deck.hotCues[i] = deck.audiblePosition
        persistTrack(deck)
        wfFor(deck).markDirty()
        log(`deck ${deck.id} hot cue ${i + 1} set @ ${fmtTime(deck.audiblePosition)}`)
      } else {
        const p = deck.hotCues[i]
        if (p == null) {
          log(`deck ${deck.id} hot cue ${i + 1} not set — shift+number or shift-click to set`)
        } else {
          releaseSyncIfSlave(deck)
          deck.seek(p)
          wfFor(deck).markDirty()
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
      wfFor(deck).markDirty()
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
        wfFor(deck).markDirty()
        break
      case 'cue':
        releaseSyncIfSlave(deck)
        deck.cuePress()
        wfFor(deck).markDirty()
        break
      case 'setCue':
        deck.setCueHere()
        persistTrack(deck)
        wfFor(deck).markDirty()
        log(`deck ${deck.id} cue set @ ${fmtTime(deck.cuePoint)}`)
        break
      case 'sync': {
        const other = deck === engine.deckA ? engine.deckB : engine.deckA
        if (syncCtl.slave === deck.id) {
          syncCtl.disengage()
          log(`deck ${deck.id} sync lock released`)
        } else if (deck.syncTo(other)) {
          syncCtl.engage(deck.id)
          wfFor(deck).markDirty()
          log(`deck ${deck.id} synced + drift lock ON (${(deck.effectiveBpm ?? 0).toFixed(1)} BPM)`)
        } else {
          log('sync failed — need audio + beatgrids on both decks')
        }
        break
      }
      case 'keylock': {
        const ok = deck.setKeylock(!deck.keylock)
        if (ok) log(`deck ${deck.id} key lock ${deck.keylock ? 'ON' : 'OFF'}`)
        else log(`deck ${deck.id} key lock unavailable while stems are loaded`)
        break
      }
      case 'setBar1':
        if (deck.setDownbeatHere()) {
          recomputeArrangement(deck)
          log(`deck ${deck.id} Bar 1 anchored @ ${fmtTime(deck.audiblePosition)}`)
        }
        break
      case 'beatLeft':
        if (deck.shiftDownbeat(-1)) recomputeArrangement(deck)
        break
      case 'beatRight':
        if (deck.shiftDownbeat(1)) recomputeArrangement(deck)
        break
      case 'nudgeBack':
        if (deck.nudgeGrid(-0.01)) {
          persistTrack(deck)
          wfFor(deck).markDirty()
        }
        break
      case 'nudgeFwd':
        if (deck.nudgeGrid(0.01)) {
          persistTrack(deck)
          wfFor(deck).markDirty()
        }
        break
      case 'bpmHalf': {
        const next = deck.scaleBpm(0.5)
        if (next != null) {
          recomputeArrangement(deck)
          updateDeckMeta(deck)
          renderCrate()
          log(`deck ${deck.id} BPM halved → ${next.toFixed(1)}`)
        }
        break
      }
      case 'bpmDouble': {
        const next = deck.scaleBpm(2)
        if (next != null) {
          recomputeArrangement(deck)
          updateDeckMeta(deck)
          renderCrate()
          log(`deck ${deck.id} BPM doubled → ${next.toFixed(1)}`)
        }
        break
      }
      case 'beatsPerBar': {
        const bpb = deck.cycleBeatsPerBar()
        recomputeArrangement(deck)
        log(`deck ${deck.id} measure = ${bpb}/4`)
        break
      }
      case 'phraseBars': {
        const pb = deck.cyclePhraseBars()
        persistTrack(deck)
        wfFor(deck).markDirty()
        log(`deck ${deck.id} overview phrase grid = ${pb} bars`)
        break
      }
      case 'delay':
        deck.fx.setBpm(deck.effectiveBpm ?? deck.track?.grid?.bpm ?? 0)
        deck.fx.setDelay(!deck.fx.delayOn)
        break
      case 'delayFrac': {
        deck.fx.setBpm(deck.effectiveBpm ?? deck.track?.grid?.bpm ?? 0)
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
        wfFor(deck).markDirty()
        break
      case 'jumpBack':
        releaseSyncIfSlave(deck)
        deck.beatJump(-1)
        wfFor(deck).markDirty()
        break
      case 'jumpFwd':
        releaseSyncIfSlave(deck)
        deck.beatJump(1)
        wfFor(deck).markDirty()
        break
      case 'jumpSize': {
        const s = deck.cycleJumpSize()
        log(`deck ${deck.id} jump size = ${s} beat${s > 1 ? 's' : ''}`)
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
    case 'mix.splitCue': {
      const on = engine.setSplitCue(!engine.splitCue)
      if (on) {
        log('split cue ON — master → ch 1/2, headphone cue → ch 3/4. create a macOS Aggregate Device (speakers + headphones) and select it as the sound output')
      } else {
        log('split cue OFF — everything on the default stereo output')
      }
      break
    }
    case 'mix.record': {
      if (recorder.recording) {
        stopRecording()
      } else {
        const scLoaded = [engine.deckA, engine.deckB].some((d) => d.track?.source === 'soundcloud')
        if (scLoaded) {
          log('recording blocked — SoundCloud terms forbid recording streamed audio')
          break
        }
        void (async () => {
          const r = await recorder.start(engine.master)
          if (r.ok && r.path) log(`recording → ${r.path}`)
          else log(`recording failed: ${r.error ?? 'unknown'}`)
        })()
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
            if (!r.trim.dragging) r.trim.setValue(d.track.gainDb)
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
    if (verb === 'cue') {
      deck.cueRelease()
      wfFor(deck).markDirty()
    } else if (verb === 'bendDown' || verb === 'bendUp') {
      deck.bend(0)
    } else if (verb === 'echoOut') {
      deck.fx.echoOutRelease()
    } else if (/^loop[1248]$/.test(verb)) {
      deck.releaseLoop()
      wfFor(deck).markDirty()
    }
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
  KeyC: 'mix.autoGain',
  KeyV: 'mix.record'
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

function isTypingTarget(t: EventTarget | null): boolean {
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true
  if (t instanceof HTMLInputElement && t.type !== 'range') return true
  return false
}

document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target)) return
  // beat jump on the focused deck: [ back, ] forward, \ cycles size
  if (e.code === 'BracketLeft' || e.code === 'BracketRight' || e.code === 'Backslash') {
    e.preventDefault()
    const deck = focusedDeck === 'B' ? engine.deckB : engine.deckA
    if (e.code === 'Backslash') {
      if (e.repeat) return
      const s = deck.cycleJumpSize()
      log(`deck ${deck.id} jump size = ${s} beat${s > 1 ? 's' : ''}`)
    } else {
      releaseSyncIfSlave(deck)
      deck.beatJump(e.code === 'BracketLeft' ? -1 : 1)
      wfFor(deck).markDirty()
    }
    return
  }
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
  setActionPressed(a, true)
  actionPress(a)
})
document.addEventListener('keyup', (e) => {
  if (isTypingTarget(e.target)) return
  const a = KEY_ACTIONS[e.code]
  if (!a) return
  setActionPressed(a, false)
  actionRelease(a)
})

// ---------------------------------------------------------------------------
// file input: drag & drop (files + recursive folders) + browse + progress bar
// ---------------------------------------------------------------------------

let dropHideTimer: number | null = null
let importGen = 0
let importHideTimer: number | null = null

function hideDropOverlay(): void {
  if (dropHideTimer != null) {
    window.clearTimeout(dropHideTimer)
    dropHideTimer = null
  }
  refs.dropOverlay.hidden = true
}

function showDropOverlayTransient(): void {
  refs.dropOverlay.hidden = false
  if (dropHideTimer != null) window.clearTimeout(dropHideTimer)
  // Self-healing heartbeat: dragover fires every ~50ms while files are held over the window;
  // if the drag exits, cancels, or drops anywhere, the overlay is guaranteed to vanish cleanly.
  dropHideTimer = window.setTimeout(hideDropOverlay, 180)
}

function showImportBar(pctVal: number, text: string, pulsing = false): void {
  if (importHideTimer != null) {
    window.clearTimeout(importHideTimer)
    importHideTimer = null
  }
  refs.importBar.hidden = false
  refs.importFill.style.width = `${Math.max(0, Math.min(100, pctVal))}%`
  refs.importText.textContent = text
  refs.importBar.classList.toggle('is-loading', pulsing)
}

function finishImportBar(text?: string, delayMs = 900): void {
  const gen = ++importGen
  refs.importBar.classList.remove('is-loading')
  if (text) {
    refs.importFill.style.width = '100%'
    refs.importText.textContent = text
    importHideTimer = window.setTimeout(() => {
      if (gen === importGen) refs.importBar.hidden = true
    }, delayMs)
  } else {
    refs.importBar.hidden = true
  }
}

function dropTargetDeck(target: EventTarget | null): Deck | undefined {
  if (!(target instanceof Node)) return undefined
  if (refs.deckA.root.contains(target)) return engine.deckA
  if (refs.deckB.root.contains(target)) return engine.deckB
  return undefined
}

document.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (e.dataTransfer?.types?.includes('Files')) showDropOverlayTransient()
})
document.addEventListener('dragend', hideDropOverlay)
document.addEventListener('pointerdown', hideDropOverlay, { capture: true })
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideDropOverlay()
})
window.addEventListener('blur', () => {
  hideDropOverlay()
  // Release any momentary keyboard/pointer holds if the window loses focus mid-press
  for (const d of [engine.deckA, engine.deckB]) {
    d.cueRelease()
    d.bend(0)
    d.releaseLoop()
    if (!txRunner.isRunning && d.fx.echoActive) d.fx.echoOutRelease()
  }
})
document.addEventListener('drop', (e) => {
  e.preventDefault()
  hideDropOverlay()
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.length) return
  const targetDeck = dropTargetDeck(e.target)
  const api = window.vibedeck
  if (api?.expandPaths) {
    const rawPaths = files.map((f) => api.filePathFor(f)).filter(Boolean)
    if (rawPaths.length) {
      void (async () => {
        importGen++
        showImportBar(8, 'SCANNING DROPPED FILES / FOLDERS…', true)
        await nextFrame()
        const expanded = await api.expandPaths(rawPaths)
        if (!expanded.length) {
          finishImportBar()
          log('no supported audio files found in dropped item(s)')
          return
        }
        await addPaths(expanded, expanded.length === 1 ? targetDeck : undefined)
      })()
      return
    }
  }
  void addFiles(files, files.length === 1 ? targetDeck : undefined)
})

async function addFiles(files: File[], targetDeck?: Deck): Promise<void> {
  const valid = files.filter((f) => {
    if (!AUDIO_EXT.test(f.name)) {
      log(`skipped ${f.name} (unsupported type)`)
      return false
    }
    return true
  })
  if (!valid.length) return
  importGen++
  const batch = valid.length >= 3
  if (batch) log(`batch importing ${valid.length} tracks (ID3/Serato tags + arrangement + fingerprint)…`)
  let okCount = 0
  for (let i = 0; i < valid.length; i++) {
    const f = valid[i]
    const clean = f.name.replace(/\.[^.]+$/, '')
    const pctVal = Math.round(((i + 0.15) / valid.length) * 100)
    showImportBar(
      pctVal,
      valid.length > 1 ? `IMPORTING ${i + 1} / ${valid.length} · ${clean}` : `LOADING · ${clean}…`,
      valid.length === 1
    )
    await nextFrame()
    try {
      const { buffer, tags } = await decodeFileWithTags(f)
      const path = window.vibedeck?.filePathFor(f) ?? f.name
      const shouldLoad = !batch || !engine.deckA.hasAudio || !engine.deckB.hasAudio
      await ingest(path, clean, buffer, tags, {
        loadIntoDeck: shouldLoad,
        runStems: !batch,
        targetDeck: valid.length === 1 ? targetDeck : undefined
      })
      okCount++
    } catch (e) {
      log(`failed to load ${f.name}: ${String(e)}`)
    }
  }
  renderCopilot()
  if (valid.length > 1) {
    finishImportBar(`IMPORTED ${okCount} / ${valid.length} TRACKS ✓`, 1200)
    log(`batch import done — ${okCount} tracks ready in crate + Co-Pilot + Set Plan`)
  } else {
    finishImportBar()
  }
}

async function addPaths(paths: string[], targetDeck?: Deck): Promise<void> {
  if (!paths.length) return
  importGen++
  const batch = paths.length >= 3
  if (batch) log(`batch importing ${paths.length} tracks (ID3/Serato tags + arrangement + fingerprint)…`)
  let okCount = 0
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]
    const clean = basename(p).replace(/\.[^.]+$/, '')
    const pctVal = Math.round(((i + 0.15) / paths.length) * 100)
    showImportBar(
      pctVal,
      paths.length > 1 ? `IMPORTING ${i + 1} / ${paths.length} · ${clean}` : `LOADING · ${clean}…`,
      paths.length === 1
    )
    await nextFrame()
    try {
      const { buffer, tags } = await decodePathWithTags(p)
      const shouldLoad = !batch || !engine.deckA.hasAudio || !engine.deckB.hasAudio
      await ingest(p, clean, buffer, tags, {
        loadIntoDeck: shouldLoad,
        runStems: !batch,
        targetDeck: paths.length === 1 ? targetDeck : undefined
      })
      okCount++
    } catch (e) {
      log(`failed to load ${basename(p)}: ${String(e)}`)
    }
  }
  renderCopilot()
  if (paths.length > 1) {
    finishImportBar(`IMPORTED ${okCount} / ${paths.length} TRACKS ✓`, 1200)
    log(`batch import done — ${okCount} tracks ready in crate + Co-Pilot + Set Plan`)
  } else {
    finishImportBar()
  }
}

refs.addBtn.addEventListener('click', async () => {
  const api = window.vibedeck
  if (!api) return
  const picked = (await api.selectAudio()) ?? []
  if (!picked.length) return
  importGen++
  showImportBar(8, 'SCANNING SELECTED FILES / FOLDERS…', true)
  await nextFrame()
  const expanded = api.expandPaths ? await api.expandPaths(picked) : picked
  if (!expanded.length) {
    finishImportBar()
    log('no supported audio files found in selected folder(s)')
    return
  }
  void addPaths(expanded)
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

function fmtShortTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec - m * 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function barLabelAt(deck: Deck, sec: number): string {
  const g = deck.track?.grid
  if (g && g.bpm > 0) {
    const bpb = g.beatsPerBar ?? 4
    const idx = Math.floor((sec - g.offset) / (60 / g.bpm) + 1e-4)
    const bar = idx >= 0 ? Math.floor(idx / bpb) + 1 : Math.floor(idx / bpb)
    return `B${bar}`
  }
  return fmtShortTime(sec)
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

function syncWaveformModeButtons(deck: Deck): void {
  const r = deckRefs(deck)
  const wf = wfFor(deck)
  const hasStems = wf.hasStems
  r.wfStemsBtn.disabled = !hasStems
  r.wfStemsBtn.title = hasStems
    ? 'Separated Drums / Bass / Other / Vocals stem lanes'
    : 'Stems not yet separated for this track'
  r.wfRgbBtn.classList.toggle('active', wf.mode === 'rgb')
  r.wfBandsBtn.classList.toggle('active', wf.mode === 'bands')
  r.wfStemsBtn.classList.toggle('active', wf.mode === 'stems' && hasStems)
}

function applyStemGainUI(deck: Deck, i: number, v: number): void {
  const r = deckRefs(deck)
  deck.setStemGain(i, v)
  r.stemSliders[i].value = String(v)
  r.stemMuteBtns[i].classList.toggle('muted', v < 0.02)
  wfFor(deck).markDirty()
}

function updateFilterLabel(r: DeckRefs, v: number): void {
  r.filter.root.classList.toggle('lp', v < -0.04)
  r.filter.root.classList.toggle('hp', v > 0.04)
}

function updateStemsButtons(): void {
  for (const deck of [engine.deckA, engine.deckB]) {
    const r = deckRefs(deck)
    const t = deck.track
    const eligible = !!t && !t.stems && !t.source && t.stemsAllowed !== false
    r.getStemsBtn.hidden = !eligible
    if (eligible && t) {
      const running = sidecarBusyId === t.id
      const queued = sidecarQueuedIds.has(t.id)
      r.getStemsBtn.disabled = running || queued
      r.getStemsBtn.classList.toggle('is-loading', running || queued)
      r.getStemsBtn.textContent = running ? 'STEMS…' : queued ? 'QUEUED' : 'GET STEMS'
    } else {
      r.getStemsBtn.classList.remove('is-loading')
    }
    syncDeckStatus(deck)
  }
}

function updateDeckMeta(deck: Deck): void {
  const r = deckRefs(deck)
  const t = deck.track
  r.name.textContent = t?.name ?? '— empty deck —'
  const orig = t?.grid?.bpm
  r.origBpm.textContent = orig && orig > 0 ? `ORIG ♩ ${orig.toFixed(1)}` : 'ORIG ♩ –.–'

  const tags = describeFingerprint(t?.fingerprint)
  r.fpTags.hidden = tags.length === 0
  r.fpTags.textContent = tags.join(' · ')

  const cam = t?.camelot ?? ''
  const col = camelotColor(cam)
  r.keyCamelot.textContent = cam || '—'
  r.keyCamelot.classList.toggle('has-key', !!col)
  r.keyCamelot.style.backgroundColor = col ?? ''
  r.keyName.textContent = t?.key ?? (t ? 'unanalyzed' : '—')

  const hasStems = deck.stemCount > 0
  r.keylockBtn.disabled = hasStems
  r.keylockBtn.title = hasStems
    ? 'Key lock unavailable while stems are loaded'
    : 'Lock musical key while changing tempo (Signalsmith Stretch)'
}

function wireDeck(deck: Deck, r: DeckRefs): void {
  const wf = new WaveformView(r.overview, r.waveform)
  wf.onSeek = (t) => {
    releaseSyncIfSlave(deck)
    deck.seek(t)
    wf.markDirty()
  }
  wf.onModeChange = () => syncWaveformModeButtons(deck)
  waveforms.set(deck.id, wf)
  deckMeters.set(deck.id, new DeckMeterView(r.vuCanvas, deck.id))

  r.root.addEventListener('pointerdown', () => {
    if (focusedDeck !== deck.id) {
      focusedDeck = deck.id
      tbDeck = deck.id
      syncTouchBar(true)
      renderCopilot()
    }
  })

  const resetRate = () => {
    releaseSyncIfSlave(deck)
    deck.setTempoRate(1)
    r.rate.value = '0'
    r.rateVal.textContent = '+0.00%'
  }
  r.rate.oninput = () => {
    releaseSyncIfSlave(deck)
    deck.setTempoRate(1 + r.rate.valueAsNumber / 100)
    r.rateVal.textContent = pct(deck.tempoRate)
  }
  r.rate.ondblclick = resetRate
  r.rate.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      releaseSyncIfSlave(deck)
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : -e.deltaY
      const step = Math.max(-0.008, Math.min(0.008, raw * (e.shiftKey ? 0.0001 : 0.00035)))
      const next = Math.max(0.92, Math.min(1.08, deck.tempoRate + step))
      deck.setTempoRate(next)
      r.rate.value = String(((next - 1) * 100).toFixed(2))
      r.rateVal.textContent = pct(next)
    },
    { passive: false }
  )
  r.rateResetBtn.addEventListener('click', resetRate)
  r.pitchBadge.addEventListener('click', resetRate)

  const modePairs: [HTMLButtonElement, WaveformMode][] = [
    [r.wfRgbBtn, 'rgb'],
    [r.wfBandsBtn, 'bands'],
    [r.wfStemsBtn, 'stems']
  ]
  for (const [btn, mode] of modePairs) {
    btn.addEventListener('click', () => wf.setMode(mode))
  }
  r.zoomOutBtn.addEventListener('click', () => wf.setZoom(wf.zoomSec * 1.4))
  r.zoomInBtn.addEventListener('click', () => wf.setZoom(wf.zoomSec * 0.72))

  r.autoCuesBtn.addEventListener('click', () => {
    const secs = deck.track?.sections
    if (!secs?.length) {
      log(`deck ${deck.id}: no arrangement detected yet`)
      return
    }
    const picked = pickAutoCues(secs)
    for (let i = 0; i < 4; i++) deck.hotCues[i] = picked[i]
    if (deck.track) deck.track.hotCues = [...picked]
    persistTrack(deck)
    wf.markDirty()
    log(`deck ${deck.id}: auto-set hot cues on Intro / Drop / Break`)
  })

  r.getStemsBtn.addEventListener('click', () => {
    const t = deck.track
    if (!t) return
    if (!envHasDemucs) {
      log('stems require demucs — click "+ stems" in the top bar first')
      return
    }
    queueSidecar(t)
    log(`queued stem separation for "${t.name}"`)
  })

  const eqs = [r.eqLow, r.eqMid, r.eqHigh]
  const applyEq = () => {
    if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outEq' : 'inEq')
    deck.setEQ(eqs[0].value, eqs[1].value, eqs[2].value)
  }
  eqs.forEach((k) => {
    k.oninput = applyEq
  })

  r.stemSliders.forEach((s, i) => {
    s.oninput = () => {
      if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outStems' : 'inStems')
      const v = s.valueAsNumber
      if (v >= 0.02) stemSavedGain[deck.id][i] = v
      applyStemGainUI(deck, i, v)
    }
  })
  r.stemMuteBtns.forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outStems' : 'inStems')
      const saved = stemSavedGain[deck.id]
      if (e.shiftKey) {
        // solo toggle: if already soloed, restore all; else mute others
        const othersMuted = [0, 1, 2, 3].every((k) => k === i || deck.getStemGain(k) < 0.02)
        for (let k = 0; k < 4; k++) {
          if (othersMuted) {
            applyStemGainUI(deck, k, saved[k] > 0.05 ? saved[k] : 1)
          } else {
            const cur = deck.getStemGain(k)
            if (cur >= 0.02) saved[k] = cur
            applyStemGainUI(deck, k, k === i ? (saved[i] > 0.05 ? saved[i] : 1) : 0)
          }
        }
      } else {
        const cur = deck.getStemGain(i)
        if (cur >= 0.02) {
          saved[i] = cur
          applyStemGainUI(deck, i, 0)
        } else {
          applyStemGainUI(deck, i, saved[i] > 0.05 ? saved[i] : 1)
        }
      }
    })
  })

  r.filter.oninput = (v) => {
    if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outFilter' : 'inFilter')
    deck.setFilter(v)
    updateFilterLabel(r, v)
  }
  r.wet.oninput = (v) => deck.fx.setWet(v)
  r.fb.oninput = (v) => deck.fx.setFb(v)
  r.vol.oninput = (v) => deck.setVolume(v)
  r.trim.oninput = (v) => deck.setTrim(v)

  r.hotcueBtns.forEach((btn, i) => {
    btn.addEventListener('pointerdown', (e) => {
      if (e.shiftKey) actionPress(`deck${deck.id}.setHotcue${i + 1}`)
      else if (e.altKey) {
        deck.hotCues[i] = null
        persistTrack(deck)
        wf.markDirty()
        log(`deck ${deck.id} hot cue ${i + 1} cleared`)
      } else actionPress(`deck${deck.id}.hotcue${i + 1}`)
    })
  })

  for (const btn of r.root.querySelectorAll<HTMLButtonElement>('button[data-act]')) {
    if (btn.classList.contains('hc')) continue // handled with shift/alt modifiers above
    const act = btn.dataset.act!
    let held = false
    const release = () => {
      if (!held) return
      held = false
      actionRelease(act)
    }
    btn.addEventListener('pointerdown', () => {
      held = true
      actionPress(act)
    })
    btn.addEventListener('pointerup', release)
    btn.addEventListener('pointerleave', release)
    btn.addEventListener('pointercancel', release)
  }
}

function updateDeckUI(deck: Deck): void {
  const r = deckRefs(deck)
  updateDeckMeta(deck)
  if (document.activeElement !== r.rate) {
    r.rate.value = String(((deck.tempoRate - 1) * 100).toFixed(2))
    r.rateVal.textContent = pct(deck.tempoRate)
  }
}

function updateStemsUI(deck: Deck): void {
  const r = deckRefs(deck)
  r.stemsBox.hidden = deck.stemCount === 0
  r.stemSliders.forEach((s) => (s.value = '1'))
  r.stemMuteBtns.forEach((b) => b.classList.remove('muted'))
  updateDeckMeta(deck)
}

function camelotOrder(c?: string): number {
  const m = /^(\d+)([AB])$/.exec(c ?? '')
  return m ? Number(m[1]) * 2 + (m[2] === 'B' ? 1 : 0) : 9999
}

function renderCrate(): void {
  refs.crateList.innerHTML = ''
  const q = refs.crateQuery.value.trim().toLowerCase()
  const sort = refs.crateSort.value
  let tracks = [...crate.tracks]
  if (q) {
    tracks = tracks.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.key ?? '').toLowerCase().includes(q) ||
        (t.camelot ?? '').toLowerCase().includes(q) ||
        String(t.grid?.bpm ?? '').includes(q)
    )
  }
  tracks.sort((a, b) => {
    switch (sort) {
      case 'bpm':
        return (a.grid?.bpm ?? 9999) - (b.grid?.bpm ?? 9999)
      case 'key':
        return camelotOrder(a.camelot) - camelotOrder(b.camelot)
      case 'recent':
        return (b.analyzedAt ?? '').localeCompare(a.analyzedAt ?? '')
      default:
        return a.name.localeCompare(b.name)
    }
  })
  refs.crateCount.textContent = tracks.length ? `(${tracks.length})` : ''
  for (const t of tracks) {
    const li = document.createElement('li')
    const parts: string[] = []
    if (t.source === 'soundcloud') parts.push('<span class="crate-tag sc">SC</span>')
    if (t.grid?.bpm) parts.push(`<span>${t.grid.bpm.toFixed(1)}</span>`)
    if (t.camelot) {
      const col = camelotColor(t.camelot) ?? '#94a3b8'
      parts.push(`<span class="crate-key" style="background:${col}">${escapeHtml(t.camelot)}</span>`)
    }
    if (t.stems) parts.push('<span class="crate-tag">stems</span>')
    else if (sidecarBusyId === t.id) parts.push('<span class="crate-tag stems-busy is-loading">stems…</span>')
    else if (sidecarQueuedIds.has(t.id)) parts.push('<span class="crate-tag">queued</span>')
    if (t.hotCues?.some((h) => h != null)) parts.push('<span class="crate-tag cues">cues</span>')
    li.innerHTML = `<span class="crate-name">${escapeHtml(t.name)}</span><span class="crate-meta">${parts.join('')}</span>`
    const mb = t.pcmBytes ? `${(t.pcmBytes / (1024 * 1024)).toFixed(0)}MB` : ''
    li.title = `${fmtTime(t.durationSec)}${t.key ? ` · ${t.key}` : ''}${mb ? ` · ${mb} PCM` : ''}${t.sourceUrl ? ` · ${t.sourceUrl}` : ''}`
    li.addEventListener('click', () => void loadTrackIntoDeck(t))
    refs.crateList.append(li)
  }
}

refs.crateQuery.addEventListener('input', renderCrate)
refs.crateSort.addEventListener('change', () => {
  localStorage.setItem('vibedeck.crate-sort', refs.crateSort.value)
  renderCrate()
})

refs.xfader.addEventListener('input', () => {
  txRunner.override('xfade')
  engine.mixer.setCrossfade(refs.xfader.valueAsNumber)
})
refs.xfader.addEventListener('dblclick', () => {
  txRunner.override('xfade')
  engine.mixer.setCrossfade(0.5)
})
refs.xfader.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    txRunner.override('xfade')
    const raw = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : -e.deltaY
    const delta = Math.max(-0.06, Math.min(0.06, raw * (e.shiftKey ? 0.0008 : 0.0025)))
    const next = Math.max(0, Math.min(1, engine.mixer.position + delta))
    engine.mixer.setCrossfade(Math.abs(next - 0.5) < 0.015 ? 0.5 : next)
  },
  { passive: false }
)
refs.master.oninput = (v) => {
  engine.master.gain.value = v
}

// ---------------------------------------------------------------------------
// Native macOS Touch Bar Live DJ Strip (2020 M1 MacBook Pro OLED strip)
// ---------------------------------------------------------------------------

type TbParam = 'lo' | 'flt' | 'vol' | 'mid' | 'hi' | 'xf'
let tbDeck: 'A' | 'B' = 'A'
let tbParam: TbParam = 'flt'
let lastTbKey = ''
let tbLocalUntil = 0

function tbVal100For(deckId: 'A' | 'B', param: TbParam): number {
  const deck = deckId === 'B' ? engine.deckB : engine.deckA
  if (param === 'xf') return Math.round(engine.mixer.position * 100)
  if (param === 'vol') return Math.round(deck.volume * 100)
  if (param === 'flt') return Math.round((deck.filterVal * 0.5 + 0.5) * 100)
  const db = param === 'lo' ? deck.eqDb.low : param === 'mid' ? deck.eqDb.mid : deck.eqDb.high
  return Math.round((db >= 0 ? 0.5 + (db / 6) * 0.5 : 0.5 - (-db / 26) * 0.5) * 100)
}

function syncTouchBar(force = false): void {
  const api = window.vibedeck
  if (!api?.touchBarSync) return
  if (!force && performance.now() < tbLocalUntil) return
  const deck = tbDeck === 'B' ? engine.deckB : engine.deckA
  const value100 = tbVal100For(tbDeck, tbParam)
  const killActive = deck.eqDb.low <= -25
  const key = `${tbDeck}:${tbParam}:${value100}:${killActive ? 1 : 0}`
  if (!force && key === lastTbKey) return
  lastTbKey = key
  api.touchBarSync({ deck: tbDeck, param: tbParam, value100, killActive })
}

window.vibedeck?.onTouchBarAction((ev) => {
  engine.resume()
  if (ev.kind === 'deck' && (ev.deck === 'A' || ev.deck === 'B')) {
    tbDeck = ev.deck
    focusedDeck = ev.deck
    syncTouchBar(true)
    return
  }
  if (ev.kind === 'param' && ev.param) {
    tbParam = ev.param as TbParam
    syncTouchBar(true)
    return
  }
  const deckId = ev.deck ?? tbDeck
  const deck = deckId === 'B' ? engine.deckB : engine.deckA
  const r = deckRefs(deck)
  const param = (ev.param as TbParam) ?? tbParam

  if (ev.kind === 'kill') {
    if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outEq' : 'inEq')
    const killed = deck.eqDb.low <= -25
    deck.setEqBand('low', killed ? 0 : -26)
    syncTouchBar(true)
    return
  }
  if (ev.kind === 'reset') {
    if (param === 'xf') {
      txRunner.override('xfade')
      engine.mixer.setCrossfade(0.5)
    } else if (param === 'vol') {
      deck.setVolume(1)
    } else if (param === 'flt') {
      if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outFilter' : 'inFilter')
      deck.setFilter(0)
      updateFilterLabel(r, 0)
    } else {
      if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outEq' : 'inEq')
      deck.setEqBand(param === 'lo' ? 'low' : param === 'mid' ? 'mid' : 'high', 0)
    }
    syncTouchBar(true)
    return
  }
  if (ev.kind === 'value' && typeof ev.value100 === 'number') {
    tbLocalUntil = performance.now() + 260
    const raw = Math.max(0, Math.min(100, ev.value100))
    const norm = raw / 100
    const centered = Math.abs(raw - 50) <= 2 ? 0.5 : norm
    if (param === 'xf') {
      txRunner.override('xfade')
      engine.mixer.setCrossfade(centered)
    } else if (param === 'vol') {
      deck.setVolume(norm)
    } else if (param === 'flt') {
      if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outFilter' : 'inFilter')
      const fv = centered * 2 - 1
      deck.setFilter(fv)
      updateFilterLabel(r, fv)
    } else {
      if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outEq' : 'inEq')
      const db = centered >= 0.5 ? ((centered - 0.5) / 0.5) * 6 : -((0.5 - centered) / 0.5) * 26
      deck.setEqBand(param === 'lo' ? 'low' : param === 'mid' ? 'mid' : 'high', db)
    }
  }
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

refs.samplerVol.oninput = (v) => sampler.setMaster(v)

refs.samplerPads.forEach((pad, i) => {
  pad.addEventListener('pointerdown', (e) => {
    if (e.altKey) {
      sampler.clear(i)
      audioMem.release(`smp:${i + 1}`)
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
    hideDropOverlay()
    const f = e.dataTransfer?.files?.[0]
    if (!f || !AUDIO_EXT.test(f.name)) {
      log(`sampler: unsupported file (want wav/mp3/flac/aiff)`)
      return
    }
    void (async () => {
      pad.classList.add('is-loading')
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
      } finally {
        pad.classList.remove('is-loading')
      }
    })()
  })
})

let lastSyncUpdate = 0
let lastFxBpmUpdate = 0
let lastMemUpdate = -2000
let lastMemEnforce = 0
let lastCopilotUpdate = 0

function tick(): void {
  requestAnimationFrame(tick)
  try {
    tickBody()
  } catch (err) {
    console.error('[vibedeck tick]', err)
  }
}

function tickBody(): void {
  const now = performance.now()
  if (txRunner.isRunning) {
    txRunner.update()
    if (txCurveCanvas && txRunner.active) {
      drawTransitionCurves(txCurveCanvas, txRunner.active.strategy, txRunner.active.bars, txRunner.active.progress)
    }
  }
  if (now - lastSyncUpdate > 200) {
    lastSyncUpdate = now
    syncCtl.update()
  }
  if (now - lastCopilotUpdate > 1500) {
    lastCopilotUpdate = now
    if (!txRunner.isRunning && (engine.deckA.playing || engine.deckB.playing)) renderCopilot()
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
    const wf = wfFor(deck)
    const meter = deckMeters.get(deck.id)
    const wasPlaying = r.playBtn.classList.contains('active')
    if (wasPlaying !== deck.playing) {
      r.playBtn.classList.toggle('active', deck.playing)
      r.playBtn.innerHTML = deck.playing ? `${ICO_PAUSE}<span>PAUSE</span>` : `${ICO_PLAY}<span>PLAY</span>`
    }
    r.spinIcon.classList.toggle('spinning', deck.playing)
    if (meter) meter.draw(deck.sampleMeter(meter.binBuffer))
    r.syncBtn.classList.toggle('active', syncCtl.slave === deck.id)
    r.keylockBtn.classList.toggle('active', deck.keylock)
    r.delayBtn.classList.toggle('active', deck.fx.delayOn)
    r.reverbBtn.classList.toggle('active', deck.fx.reverbOn)
    r.echoBtn.classList.toggle('active', deck.fx.echoActive)
    r.cueMixBtn.classList.toggle('active', engine.isCueMix(deck.id))
    r.fracBtn.textContent = delayFracLabel(deck.fx.delayFrac)
    r.loopLatchBtn.classList.toggle('active', deck.loopLatch)
    r.jumpSizeBtn.textContent = String(deck.jumpBeats)
    const bpb = deck.track?.grid?.beatsPerBar ?? 4
    const pb = deck.track?.grid?.phraseBars ?? 8
    r.bpbBtn.textContent = `${bpb}/4`
    r.phraseBtn.textContent = `${pb}B`
    r.zoomVal.textContent = `${Math.round(wf.zoomSec)}s`

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
    const rateTxt = pct(deck.tempoRate)
    r.pitchBadge.textContent = rateTxt
    r.pitchBadge.classList.toggle('shifted', Math.abs(deck.tempoRate - 1) > 0.0005)

    const bb = deck.barBeat
    r.barBeat.textContent = bb ? `BAR ${bb.bar}.${bb.beat}` : '—'
    const cd = deck.sectionCountdown
    if (cd) {
      r.phraseCd.hidden = false
      const pal = SECTION_COLORS[cd.current.label]
      r.phraseCd.style.background = pal.bg
      r.phraseCd.style.color = pal.fg
      r.phraseCd.style.borderColor = pal.border
      r.phraseCd.textContent = cd.next
        ? `${cd.current.label} → ${cd.next.label} in ${cd.barsLeft}.${cd.beatsLeft}`
        : `${cd.current.label} · ${cd.barsLeft}.${cd.beatsLeft} left`
    } else {
      r.phraseCd.hidden = true
    }
    const pos = deck.audiblePosition
    r.pos.textContent = fmtTime(pos)
    r.rem.textContent = `-${fmtTime(Math.max(0, deck.duration - pos))}`
    r.root.classList.toggle('focused', deck.id === focusedDeck)

    if (document.activeElement !== r.rate) {
      r.rate.value = String(((deck.tempoRate - 1) * 100).toFixed(2))
      r.rateVal.textContent = rateTxt
    }
    for (let i = 0; i < r.hotcueBtns.length; i++) {
      const btn = r.hotcueBtns[i]
      const hc = deck.hotCues[i]
      btn.classList.toggle('set', hc != null)
      const timeEl = btn.querySelector('.hc-time')
      if (timeEl) timeEl.textContent = hc != null ? barLabelAt(deck, hc) : '—'
      btn.title = hc != null ? `Hot Cue ${i + 1} @ ${fmtTime(hc)} (${barLabelAt(deck, hc)}) · ⇧set · ⌥clear` : `Hot Cue ${i + 1} empty · ⇧click to set`
    }
    const eq = deck.eqDb
    if (!r.eqLow.dragging) r.eqLow.setValue(eq.low)
    if (!r.eqMid.dragging) r.eqMid.setValue(eq.mid)
    if (!r.eqHigh.dragging) r.eqHigh.setValue(eq.high)
    if (!r.filter.dragging) r.filter.setValue(deck.filterVal)
    if (!r.vol.dragging) r.vol.setValue(deck.volume)
    if (!r.trim.dragging) r.trim.setValue(deck.trimDb)
    if (!r.wet.dragging) r.wet.setValue(deck.fx.wetLevel)
    if (!r.fb.dragging) r.fb.setValue(deck.fx.fbLevel)
    if (deck.playing || wf.dirty) wf.draw(deck)
  }
  if (document.activeElement !== refs.xfader) {
    refs.xfader.value = String(engine.mixer.position)
  }
  masterMeter.draw(engine.sampleMasterMeter())
  refs.splitCueBtn.classList.toggle('active', engine.splitCue)
  refs.autoGainBtn.classList.toggle('active', autoGain)
  refs.recBtn.classList.toggle('active', recorder.recording)
  const recLabel = recorder.recording
    ? `${Math.floor(recorder.elapsed / 60)}:${String(Math.floor(recorder.elapsed % 60)).padStart(2, '0')}`
    : 'REC'
  if (refs.recBtn.dataset.lbl !== recLabel) {
    refs.recBtn.dataset.lbl = recLabel
    refs.recBtn.innerHTML = `<svg class="ico" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2" fill="${recorder.recording ? '#ffffff' : '#e11d48'}"/></svg> ${recLabel}`
  }
  syncTouchBar()
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
  'deckA.tempo', 'deckA.eqLow', 'deckA.eqMid', 'deckA.eqHigh',
  'deckA.loop1', 'deckA.loop2', 'deckA.loop4', 'deckA.loop8', 'deckA.loopLatch', 'deckA.loopExit',
  'deckA.jumpBack', 'deckA.jumpFwd', 'deckA.jumpSize',
  'deckA.setBar1', 'deckA.beatLeft', 'deckA.beatRight', 'deckA.bpmHalf', 'deckA.bpmDouble',
  'deckB.play', 'deckB.cue', 'deckB.setCue', 'deckB.sync', 'deckB.keylock',
  'deckB.bendDown', 'deckB.bendUp', 'deckB.cueMix',
  'deckB.hotcue1', 'deckB.hotcue2', 'deckB.hotcue3', 'deckB.hotcue4',
  'deckB.setHotcue1', 'deckB.setHotcue2', 'deckB.setHotcue3', 'deckB.setHotcue4',
  'deckB.delay', 'deckB.delayFrac', 'deckB.reverb', 'deckB.echoOut',
  'deckB.filter', 'deckB.volume', 'deckB.delayWet', 'deckB.delayFb', 'deckB.trim',
  'deckB.tempo', 'deckB.eqLow', 'deckB.eqMid', 'deckB.eqHigh',
  'deckB.loop1', 'deckB.loop2', 'deckB.loop4', 'deckB.loop8', 'deckB.loopLatch', 'deckB.loopExit',
  'deckB.jumpBack', 'deckB.jumpFwd', 'deckB.jumpSize',
  'deckB.setBar1', 'deckB.beatLeft', 'deckB.beatRight', 'deckB.bpmHalf', 'deckB.bpmDouble',
  'sampler.pad1', 'sampler.pad2', 'sampler.pad3', 'sampler.pad4',
  'sampler.pad5', 'sampler.pad6', 'sampler.pad7', 'sampler.pad8', 'sampler.volume',
  'mix.master', 'mix.crossfade', 'mix.crossLeft', 'mix.crossRight', 'mix.crossCenter', 'mix.splitCue', 'mix.autoGain',
  'mix.record',
  'active.volume', 'active.tempo', 'active.filter', 'active.eqLow'
]

const FADER_TARGET_KEY = 'vibedeck.midi.fader-target'
const savedFaderTarget = localStorage.getItem(FADER_TARGET_KEY)
if (savedFaderTarget && Array.from(refs.midiFaderTarget.options).some((o) => o.value === savedFaderTarget)) {
  refs.midiFaderTarget.value = savedFaderTarget
}
refs.midiFaderTarget.addEventListener('change', () => {
  localStorage.setItem(FADER_TARGET_KEY, refs.midiFaderTarget.value)
  log(`fader target → ${refs.midiFaderTarget.selectedOptions[0]?.textContent ?? refs.midiFaderTarget.value}`)
})

refs.midiFaderLearn.addEventListener('click', (e) => {
  if (e.altKey) {
    midi.clearBinding('fader.control')
    log('fader binding cleared')
    return
  }
  const next = midi.learning === 'fader.control' ? null : 'fader.control'
  midi.startLearn(next)
  if (next) log('move your K.O. II bottom-left fader up/down now to bind it (⌥-click FADER to clear)')
})

function fmtBinding(b?: MidiBinding): string {
  if (!b) return '—'
  if (b.type === 'pb') return `PB ch${b.channel + 1}`
  return `${b.type.toUpperCase()} ch${b.channel + 1} #${b.control}`
}

function renderMidiPanel(): void {
  const fb = midi.bindingFor('fader.control')
  const fLearning = midi.learning === 'fader.control'
  refs.midiFaderLearn.classList.toggle('learning', fLearning)
  refs.midiFaderLearn.classList.toggle('bound', !!fb && !fLearning)
  refs.midiFaderLearn.textContent = fLearning ? 'MOVE…' : fb ? `FADER ${fb.type === 'pb' ? 'PB' : `#${fb.control}`}` : 'SET FADER'
  refs.midiFaderLearn.title = fb
    ? `Bound to ${fmtBinding(fb)} · click to re-learn · ⌥-click to clear`
    : 'Click, then slide your K.O. II bottom-left fader up/down to bind'

  refs.midiActions.innerHTML = ''
  for (const id of ACTION_IDS) {
    const row = document.createElement('div')
    row.className = 'midi-row' + (midi.learning === id ? ' learning' : '')
    const b = midi.bindingFor(id)
    const label = fmtBinding(b)
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

// watch mode: discover what a controller actually transmits
let midiWatching = false
let watchLastKey = ''
let watchLastTs = 0

midi.onRaw = (msg) => {
  if (!midiWatching) return
  const now = performance.now()
  const key = `${msg.type}:${msg.channel}:${msg.control}`
  if (key === watchLastKey && now - watchLastTs < 250) {
    watchLastTs = now
    return
  }
  watchLastKey = key
  watchLastTs = now
  const desc = msg.type === 'pb' ? `PB ch${msg.channel + 1} = ${msg.value}` : `${msg.type.toUpperCase()} ch${msg.channel + 1} ctrl ${msg.control} = ${msg.value}`
  log(`midi in: ${desc}`)
}

refs.midiWatch.addEventListener('click', () => {
  midiWatching = !midiWatching
  refs.midiWatch.textContent = midiWatching ? 'WATCHING…' : 'WATCH'
  refs.midiWatch.classList.toggle('active', midiWatching)
  if (midiWatching) {
    watchLastKey = ''
    log('midi watch ON — move any pad, knob, or fader; the log shows what your device transmits (note: analog output knobs send no MIDI)')
  }
})
midi.onAction = (rawActionId, msg) => {
  const actionId = rawActionId === 'fader.control' ? refs.midiFaderTarget.value : rawActionId
  // sampler pads are velocity-sensitive
  const sp = /^sampler\.pad([1-8])$/.exec(actionId)
  if (sp) {
    if (msg.type === 'note') {
      setActionPressed(actionId, msg.value > 0)
      if (msg.value > 0) sampler.trigger(Number(sp[1]) - 1, msg.value / 127)
    } else if (msg.value > 63) {
      setActionPressed(actionId, true)
      sampler.trigger(Number(sp[1]) - 1)
      window.setTimeout(() => setActionPressed(actionId, false), 120)
    }
    return
  }
  // continuous (CC or Pitch Bend) actions
  if (msg.type === 'cc' || msg.type === 'pb') {
    if (actionId === 'mix.master') {
      const v = msg.value / 127
      engine.master.gain.value = v
      if (!refs.master.dragging) refs.master.setValue(v)
      return
    }
    if (actionId === 'mix.crossfade') {
      txRunner.override('xfade')
      engine.mixer.setCrossfade(msg.value / 127)
      return
    }
    if (actionId === 'sampler.volume') {
      const v = msg.value / 127
      sampler.setMaster(v)
      if (!refs.samplerVol.dragging) refs.samplerVol.setValue(v)
      return
    }
    const deck = actionId.startsWith('active.')
      ? focusedDeck === 'B'
        ? engine.deckB
        : engine.deckA
      : deckOf(actionId)
    if (deck) {
      const r = deckRefs(deck)
      const ccEqDb = (cc: number) => (cc <= 64 ? -26 + (cc / 64) * 26 : ((cc - 64) / 63) * 6)
      if (actionId.endsWith('.filter')) {
        if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outFilter' : 'inFilter')
        const v = (msg.value - 64) / 63
        deck.setFilter(v)
        if (!r.filter.dragging) r.filter.setValue(v)
        updateFilterLabel(r, v)
        return
      }
      if (actionId.endsWith('.volume')) {
        const v = msg.value / 127
        deck.setVolume(v)
        if (!r.vol.dragging) r.vol.setValue(v)
        return
      }
      if (actionId.endsWith('.delayWet')) {
        const v = msg.value / 127
        deck.fx.setWet(v)
        if (!r.wet.dragging) r.wet.setValue(v)
        return
      }
      if (actionId.endsWith('.delayFb')) {
        const v = (msg.value / 127) * 0.9
        deck.fx.setFb(v)
        if (!r.fb.dragging) r.fb.setValue(v)
        return
      }
      if (actionId.endsWith('.trim')) {
        const v = (msg.value / 127) * 24 - 12
        deck.setTrim(v)
        if (!r.trim.dragging) r.trim.setValue(v)
        return
      }
      if (actionId.endsWith('.tempo')) {
        releaseSyncIfSlave(deck)
        deck.setTempoRate(0.92 + (msg.value / 127) * 0.16) // full ±8% pitch range
        return
      }
      if (actionId.endsWith('.eqLow')) {
        if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outEq' : 'inEq')
        deck.setEqBand('low', ccEqDb(msg.value))
        return
      }
      if (actionId.endsWith('.eqMid')) {
        if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outEq' : 'inEq')
        deck.setEqBand('mid', ccEqDb(msg.value))
        return
      }
      if (actionId.endsWith('.eqHigh')) {
        if (txRunner.active) txRunner.override(deck === txRunner.active.outDeck ? 'outEq' : 'inEq')
        deck.setEqBand('high', ccEqDb(msg.value))
        return
      }
    }
  }
  // press/release actions (with physical on-screen keycap depression!)
  if (msg.type === 'note') {
    if (msg.value > 0) {
      setActionPressed(actionId, true)
      actionPress(actionId)
    } else {
      setActionPressed(actionId, false)
      actionRelease(actionId)
    }
  } else {
    if (msg.value > 63) {
      setActionPressed(actionId, true)
      actionPress(actionId)
    } else {
      setActionPressed(actionId, false)
      actionRelease(actionId)
    }
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
  midi.applyPreset(ko2Preset(), ['fader.control', 'mix.master'])
  log('loaded K.O. II pad preset (groups A/C = deck controls, B/D = hot cue setters; BPM left unmapped). use SET FADER above to route the bottom-left fader to Master Vol, Crossfader, Filter, or BPM anytime')
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
  'mix.master', 'mix.crossfade'
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
// Co-Pilot + Automated Transition Curves + Graph-Theoretic Set Path Planner
// ---------------------------------------------------------------------------

txRunner.onFinish = (msg) => {
  log(msg)
  renderCopilot()
}
txRunner.onStemGain = (deck, i, v) => applyStemGainUI(deck, i, v)
txRunner.onFilterChanged = (deck, v) => {
  const r = deckRefs(deck)
  if (!r.filter.dragging) r.filter.setValue(v)
  updateFilterLabel(r, v)
}

function setCopilotTab(tab: 'copilot' | 'planner' | 'stream'): void {
  refs.tabCopilot.classList.toggle('active', tab === 'copilot')
  refs.tabPlanner.classList.toggle('active', tab === 'planner')
  refs.tabStream.classList.toggle('active', tab === 'stream')
  refs.copilotPane.hidden = tab !== 'copilot'
  refs.plannerPane.hidden = tab !== 'planner'
  refs.streamPane.hidden = tab !== 'stream'
  const vibeBox = refs.vibeBtns[0]?.parentElement
  if (vibeBox) vibeBox.hidden = tab !== 'copilot'
  if (tab === 'planner') renderPlanner()
}

refs.tabCopilot.addEventListener('click', () => setCopilotTab('copilot'))
refs.tabPlanner.addEventListener('click', () => setCopilotTab('planner'))
refs.tabStream.addEventListener('click', () => setCopilotTab('stream'))

refs.vibeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    vibeMode = (btn.dataset.vibe as VibeMode) ?? 'flow'
    refs.vibeBtns.forEach((b) => b.classList.toggle('active', b === btn))
    renderCopilot()
  })
})

refs.arcBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    setArc = (btn.dataset.arc as SetArc) ?? 'arc'
    refs.arcBtns.forEach((b) => b.classList.toggle('active', b === btn))
    renderPlanner()
  })
})

refs.planAltBtn.addEventListener('click', () => {
  planSeed++
  renderPlanner()
})

refs.planBreakBtn.addEventListener('click', () => {
  planGenreBreak = !planGenreBreak
  refs.planBreakBtn.classList.toggle('active', planGenreBreak)
  renderPlanner()
})

/** Determine which deck is currently leading (outgoing) and which is incoming. */
function activeDeckPair(): { out: Deck; inc: Deck } {
  if (txRunner.active) return { out: txRunner.active.outDeck, inc: txRunner.active.inDeck }
  const a = engine.deckA
  const b = engine.deckB
  if (a.playing && !b.playing) return { out: a, inc: b }
  if (b.playing && !a.playing) return { out: b, inc: a }
  if (a.playing && b.playing) return engine.mixer.position <= 0.5 ? { out: a, inc: b } : { out: b, inc: a }
  if (focusedDeck === 'B' && b.track) return { out: b, inc: a }
  if (a.track) return { out: a, inc: b }
  return { out: b, inc: a }
}

const ALL_STRATEGIES: AutoStrategy[] = [
  'BASS_SWAP', 'HPF_ECHO', 'LPF_IN', 'CROSS_FILTER', 'STEM_NULL_RESET', 'STEM_VOCAL_BLEND'
]

function renderCopilot(): void {
  const { out, inc } = activeDeckPair()
  txCurveCanvas = null

  // 1. Live Automated Transition Card (when both decks have tracks)
  if (out.track && inc.track) {
    const plan = planTransition(
      out.track,
      out.audiblePosition,
      out.effectiveBpm ?? out.track.grid?.bpm ?? 120,
      inc.track,
      out.stemCount > 0,
      inc.stemCount > 0
    )
    const activeStrat: AutoStrategy = txStrategyOverride === 'AUTO' ? plan.strategy : txStrategyOverride
    const activeBars: 4 | 8 = txBarsOverride === 'AUTO' ? plan.bars : txBarsOverride
    txCurrentStrategy = activeStrat
    txCurrentBars = activeBars

    const harmCls = plan.harmonic.compatible ? '' : ' clash'
    const pitchStr = `${plan.pitchPct >= 0 ? '+' : ''}${plan.pitchPct.toFixed(1)}%`
    const running = txRunner.isRunning
    const stratOpts = [
      `<option value="AUTO"${txStrategyOverride === 'AUTO' ? ' selected' : ''}>AUTO · ${STRATEGY_META[plan.strategy].short}</option>`,
      ...ALL_STRATEGIES.map(
        (s) => `<option value="${s}"${txStrategyOverride === s ? ' selected' : ''}>${STRATEGY_META[s].short}</option>`
      )
    ].join('')

    refs.planBox.innerHTML = `
      <div class="plan-head">
        <span>${out.id} → ${inc.id}</span>
        <span class="next-harm${harmCls}">${escapeHtml(plan.harmonic.tag)}</span>
        <span class="next-pitch">${escapeHtml(pitchStr)}</span>
        <select class="tx-select tx-strat" title="Transition curve preset">${stratOpts}</select>
        <button class="mini-btn tx-bars" title="Transition length (4B / 8B)">${activeBars}B</button>
        <button class="plan-prep" title="Jump deck ${inc.id} to mix-in cue & set CUE">PREP ${inc.id}</button>
        <button class="plan-run${running ? ' running' : ''}" title="Execute automated transition curves live (touch any control to override)">${running ? '■ STOP' : '▶ RUN'}</button>
      </div>
      ${plan.vocalWarning ? `<div class="plan-vox">[!] ${escapeHtml(plan.vocalWarning)}</div>` : ''}
      <div class="tx-row">
        <canvas class="tx-curve" title="Orange: Out Vol · Blue: In Vol · Red: Bass · Violet: Filter"></canvas>
        <div class="tx-meta">
          <span><b>WHY</b> ${escapeHtml(plan.rationale)}</span>
          <span><b>IN</b> ${escapeHtml(plan.inCueLabel)} · <b>OUT</b> ${escapeHtml(plan.outCueLabel)}</span>
          <span><b>KICK</b> ${escapeHtml(plan.kickOwner)}</span>
        </div>
      </div>`

    txCurveCanvas = refs.planBox.querySelector<HTMLCanvasElement>('.tx-curve')
    if (txCurveCanvas) {
      drawTransitionCurves(txCurveCanvas, activeStrat, activeBars, txRunner.active?.progress ?? null)
    }

    refs.planBox.querySelector<HTMLSelectElement>('.tx-strat')?.addEventListener('change', (e) => {
      txStrategyOverride = (e.target as HTMLSelectElement).value as AutoStrategy | 'AUTO'
      renderCopilot()
    })
    refs.planBox.querySelector('.tx-bars')?.addEventListener('click', () => {
      txBarsOverride = activeBars === 8 ? 4 : 8
      renderCopilot()
    })
    refs.planBox.querySelector('.plan-prep')?.addEventListener('click', () => {
      releaseSyncIfSlave(inc)
      inc.seek(plan.inCueSec)
      inc.setCueHere()
      persistTrack(inc)
      wfFor(inc).markDirty()
      log(`co-pilot: prepped deck ${inc.id} cue @ ${plan.inCueLabel}`)
    })
    refs.planBox.querySelector('.plan-run')?.addEventListener('click', () => {
      if (txRunner.isRunning) {
        txRunner.cancel(true)
        log('auto-transition cancelled')
        renderCopilot()
        return
      }
      engine.resume()
      const res = txRunner.start(out, inc, activeStrat, activeBars, plan.inCueSec)
      if (res.ok) {
        log(`running ${activeBars}B ${STRATEGY_META[activeStrat].label} (${out.id} → ${inc.id}) — touch any fader/knob to override`)
      } else {
        log(`transition failed: ${res.error}`)
      }
      renderCopilot()
    })
  } else if (out.track) {
    refs.planBox.innerHTML = `<div class="plan-empty">Deck ${out.id} active (♩ ${out.track.grid?.bpm.toFixed(1) ?? '?'} · ${out.track.camelot ?? 'no key'}) — click any Next Up track below to load & cue on Deck ${inc.id}</div>`
  } else {
    refs.planBox.innerHTML =
      '<div class="plan-empty">Drop tracks (or drag a whole crate folder) to unlock Top-5 Next Up curation, Set Path Planner & Automated Transitions.</div>'
  }

  // 2. Top-5 Next-Up recommendations from crate
  refs.nextList.innerHTML = ''
  if (!out.track) return
  const exclude = new Set<string>([out.track.id])
  if (inc.track) exclude.add(inc.track.id)
  const picks = recommendNext(
    out.track,
    out.effectiveBpm ?? out.track.grid?.bpm ?? 0,
    crate.tracks,
    exclude,
    vibeMode,
    5
  )
  if (picks.length === 0) {
    const li = document.createElement('li')
    li.innerHTML = '<span class="plan-empty">Add more tracks to your crate for Top-5 picks.</span>'
    refs.nextList.append(li)
    return
  }

  for (const p of picks) {
    const li = document.createElement('li')
    const camCol = camelotColor(p.track.camelot) ?? '#94a3b8'
    const pitchStr = `${p.pitchPct >= 0 ? '+' : ''}${p.pitchPct.toFixed(1)}%${p.halfDouble ? ` ${p.halfDouble}` : ''}`
    const harmCls = p.harmonic.compatible ? '' : ' clash'
    li.innerHTML = `
      <span class="next-score">${p.score}%</span>
      <span class="next-name">${escapeHtml(p.track.name)}</span>
      ${p.track.camelot ? `<span class="crate-key" style="background:${camCol}">${escapeHtml(p.track.camelot)}</span>` : ''}
      <span class="next-harm${harmCls}">${escapeHtml(p.harmonic.tag)}</span>
      <span class="next-pitch">${escapeHtml(pitchStr)}</span>
      <span class="next-hint">${escapeHtml(p.quickMove)}</span>`
    li.title = `${p.track.name} · ♩ ${p.track.grid?.bpm.toFixed(1) ?? '?'} · ${p.vibeNote} · Click to load & cue on Deck ${inc.id}`
    li.addEventListener('click', () => {
      const plan = planTransition(
        out.track!,
        out.audiblePosition,
        out.effectiveBpm ?? out.track!.grid?.bpm ?? 120,
        p.track,
        out.stemCount > 0,
        !!p.track.stems
      )
      txStrategyOverride = 'AUTO'
      txBarsOverride = 'AUTO'
      void loadTrackIntoDeck(p.track, undefined, { targetDeck: inc, cueAtSec: plan.inCueSec })
    })
    refs.nextList.append(li)
  }

  if (!refs.plannerPane.hidden) renderPlanner()
}

function renderPlanner(): void {
  refs.planList.innerHTML = ''
  if (crate.tracks.length < 2) {
    refs.planSummary.textContent = 'Add at least 2 tracks (or drag a full folder) to solve a harmonic set path.'
    return
  }
  const { out, inc } = activeDeckPair()
  const planned = planSetPath(crate.tracks, {
    arc: setArc,
    length: Math.min(12, crate.tracks.length),
    openerId: out.track?.id,
    allowGenreBreak: planGenreBreak,
    jitterSeed: planSeed
  })

  const clSummary = planned.clusters.map((c) => `${c.label} (${c.tracks.length})`).join(' · ')
  refs.planSummary.textContent =
    `${planned.steps.length} tracks · cost ${planned.totalCost.toFixed(1)} · clusters: ${clSummary}`

  const bridgeSet = new Set(planned.bridgeTrackIds)
  for (let i = 0; i < planned.steps.length; i++) {
    const st = planned.steps[i]
    const t = st.track
    const edge = st.incomingEdge
    const camCol = camelotColor(t.camelot) ?? '#94a3b8'
    const stratTxt = edge ? `${edge.bars}B ${STRATEGY_META[edge.strategy].short}` : 'OPENER'
    const isNull = !!edge && (edge.usedStemNull || edge.usedNaturalNull)
    const bridgeTag = bridgeSet.has(t.id) ? '<span class="crate-tag cues" title="Crate bridge track">BRG</span>' : ''
    const li = document.createElement('li')
    li.innerHTML = `
      <span class="plan-idx">${String(i + 1).padStart(2, '0')}</span>
      <span class="plan-ebar" title="Dancefloor energy ${(st.energy * 100).toFixed(0)}%"><span class="plan-efill" style="width:${Math.round(st.energy * 100)}%"></span></span>
      <span class="next-name">${escapeHtml(t.name)}</span>
      ${bridgeTag}
      <span class="next-pitch">${t.grid?.bpm ? t.grid.bpm.toFixed(0) : '?'}</span>
      ${t.camelot ? `<span class="crate-key" style="background:${camCol}">${escapeHtml(t.camelot)}</span>` : ''}
      <span class="plan-strat${isNull ? ' null' : ''}" title="${escapeHtml(edge?.rationale ?? 'Opening track')}">${escapeHtml(stratTxt)}</span>`
    li.title = edge ? `${t.name} — ${edge.rationale} · Click to load on Deck ${inc.id}` : `${t.name} (opener)`
    li.addEventListener('click', () => {
      if (edge) {
        txStrategyOverride = edge.strategy
        txBarsOverride = edge.bars
      }
      const target = out.track?.id === t.id ? out : inc
      void loadTrackIntoDeck(t, undefined, { targetDeck: target })
      setCopilotTab('copilot')
    })
    refs.planList.append(li)
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
  refs.scConnect.disabled = true
  refs.scConnect.classList.add('is-loading')
  try {
    if (sc.loggedIn) {
      refs.scConnect.textContent = 'DISCONNECTING…'
      await sc.logout()
      log('soundcloud disconnected')
    } else {
      refs.scConnect.textContent = 'CONNECTING…'
      log('soundcloud: opening browser for OAuth sign-in…')
      const r = await sc.login()
      if (r.ok) log(`soundcloud connected${r.username ? ` as @${r.username}` : ''}`)
      else log(`soundcloud login failed: ${r.error ?? 'unknown error'}`)
    }
  } finally {
    refs.scConnect.classList.remove('is-loading')
    updateStreamPanel()
  }
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
    refs.streamResults.innerHTML = `<li class="stream-loading is-loading">SEARCHING "${escapeHtml(q)}"…</li>`
    try {
      const results = await sc.search(q)
      renderStreamResults(results)
      log(`soundcloud: ${results.length} results for "${q}"`)
    } catch (err) {
      refs.streamResults.innerHTML = ''
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
  const target = !engine.deckA.hasAudio
    ? engine.deckA
    : !engine.deckB.hasAudio
      ? engine.deckB
      : focusedDeck === 'B'
        ? engine.deckB
        : engine.deckA
  deckLoading[target.id] = 'STREAMING…'
  syncDeckStatus(target)
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
    const { sections, vibe } = analyzeStructure(buffer, track.grid)
    track.sections = sections
    track.vibe = vibe
    track.fingerprint = computeFingerprint(buffer, track.grid)
    track.pcmBytes = AudioMemory.bytesOf(buffer)
    registerSCMemory(ref.id, track.name, buffer)
    crate.upsert(track)
    renderCrate()
    await loadTrackIntoDeck(track, buffer, { targetDeck: target })
    log(`added "${track.name}" (SoundCloud · beatgrid ${track.grid.bpm || '?'} BPM · stems off per ToS)`)
  } catch (e) {
    deckLoading[target.id] = null
    syncDeckStatus(target)
    log(`soundcloud: ${String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// analysis env bootstrap (librosa/demucs live in a private venv, not the DMG)
// ---------------------------------------------------------------------------

async function refreshEnvStatus(): Promise<void> {
  const s = await window.vibedeck?.envStatus()
  if (!s) return
  envHasDemucs = s.demucs
  const showSetup = !s.librosa || (!s.demucs && !s.installing)
  refs.envSetup.hidden = !showSetup
  refs.envInstallBtn.hidden = s.librosa
  refs.envInstallStemsBtn.hidden = s.demucs
  refs.envInstallBtn.disabled = s.installing
  refs.envInstallStemsBtn.disabled = s.installing
  refs.envInstallBtn.classList.toggle('is-loading', s.installing)
  refs.envInstallStemsBtn.classList.toggle('is-loading', s.installing)
  if (!s.installing) {
    refs.envInstallBtn.textContent = 'INSTALL ENV'
    refs.envInstallStemsBtn.textContent = '+ STEMS'
  }
  updateStemsButtons()
  if (s.librosa && s.demucs) log('analysis env ready (librosa + demucs)')
}

refs.envInstallBtn.addEventListener('click', () => {
  void (async () => {
    refs.envInstallBtn.disabled = true
    refs.envInstallBtn.classList.add('is-loading')
    refs.envInstallBtn.textContent = 'INSTALLING…'
    const r = await window.vibedeck?.envInstall()
    log(r?.ok ? 'analysis env installed ✓ (BPM/key via librosa)' : `env install failed: ${r?.error}`)
    await refreshEnvStatus()
  })()
})

refs.envInstallStemsBtn.addEventListener('click', () => {
  void (async () => {
    refs.envInstallStemsBtn.disabled = true
    refs.envInstallStemsBtn.classList.add('is-loading')
    refs.envInstallStemsBtn.textContent = 'INSTALLING…'
    const r = await window.vibedeck?.envInstall({ stems: true })
    log(r?.ok ? 'stems support installed ✓ (demucs)' : `stems install failed: ${r?.error}`)
    await refreshEnvStatus()
  })()
})

window.vibedeck?.onEnvLog((line) => log(`py: ${line}`))

// ---------------------------------------------------------------------------
// boot — wire decks & start render loop IMMEDIATELY so slow IPC/MIDI never blocks UI
// ---------------------------------------------------------------------------

wireDeck(engine.deckA, refs.deckA)
wireDeck(engine.deckB, refs.deckB)
for (const deck of [engine.deckA, engine.deckB]) {
  deck.onEnded = () => log(`deck ${deck.id} track ended`)
  deck.onKeylockError = (m) =>
    log(`deck ${deck.id} key lock unavailable (${m}) — playing without it`)
}
renderMidiPanel()
window.addEventListener('pointerdown', () => engine.resume())
// Start animation loop immediately — waveforms, VU meters, BPM, timers live from frame 0!
requestAnimationFrame(tick)

void (async () => {
  await crate.load()
  const savedSort = localStorage.getItem('vibedeck.crate-sort')
  if (savedSort) refs.crateSort.value = savedSort
  renderCrate()
  renderCopilot()

  log('drop tracks or folders anywhere (or "+ ADD / FOLDER") — tags, arrangement & fingerprint run instantly')
  log('SYNC engages a drift lock — press SYNC again to release it')

  // Run slow background subsystems concurrently so none can ever stall the app
  void restoreSampler()
  void refreshEnvStatus()
  void (async () => {
    await sc.refreshStatus()
    updateStreamPanel()
    if (sc.configured && !sc.loggedIn) {
      log('soundcloud configured — click "connect SoundCloud" in the STREAM panel')
    } else if (!sc.configured) {
      log('soundcloud: set up soundcloud.config.json to enable streaming (docs/streaming.md)')
    }
  })()
  void (async () => {
    const midiOk = await Promise.race([
      midi.init(),
      new Promise<boolean>((r) => window.setTimeout(() => r(false), 5000))
    ])
    renderMidiPanel()
    log(
      midiOk
        ? 'midi ready — click "learn" next to an action, then touch a control'
        : 'web midi unavailable or timed out (replug controller or click watch)'
    )
  })()
})()
