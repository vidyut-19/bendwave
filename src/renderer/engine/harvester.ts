import { STEM_ORDER, type Deck } from './deck'

/**
 * Stem-to-Pad DNA Harvester (Pillar 6)
 *
 * Slices beat-quantized one-shots & loops directly from a deck's isolated
 * Demucs stem buffers (DRM / BAS / OTH / VOX) or full mix, tags each clip
 * with its acoustic DNA (sourceBpm, Camelot key, stem role, beats), and
 * provides 16-bit WAV encoding for pad persistence & physical K.O. II export.
 */

export type PadStemKind = 'drums' | 'bass' | 'other' | 'vocals' | 'mix' | 'file'

export interface HarvestedClip {
  name: string
  shortLabel: string
  stem: PadStemKind
  buffer: AudioBuffer
  sourceBpm?: number
  camelot?: string
  beats?: number
  mode: 'oneshot' | 'loop'
  keyLock: boolean
  fxSend: boolean
}

const CAMELOT_RE = /^(\d{1,2})([AB])$/

/**
 * Shortest semitone shift [-5..+6] from `fromCam` to `toCam` on the Camelot
 * circle of fifths. Each +1 clockwise step = +7 semitones (mod 12).
 * Relative major/minor (e.g. 8A ↔ 8B) share the exact same scale → 0 st.
 */
export function camelotSemitoneDelta(fromCam?: string, toCam?: string): number {
  if (!fromCam || !toCam) return 0
  const a = CAMELOT_RE.exec(fromCam.trim().toUpperCase())
  const b = CAMELOT_RE.exec(toCam.trim().toUpperCase())
  if (!a || !b) return 0
  const n1 = Number(a[1])
  const n2 = Number(b[1])
  let st = (((n2 - n1) * 7) % 12 + 12) % 12
  if (st > 6) st -= 12
  return st
}

/** Half/double-time aware tempo ratio (keeps extreme 73→132 jumps musical). */
export function foldedTempoRatio(sourceBpm?: number, targetBpm?: number): number {
  if (!sourceBpm || !targetBpm || sourceBpm <= 0 || targetBpm <= 0) return 1
  let r = targetBpm / sourceBpm
  while (r > 1.414) r /= 2
  while (r < 0.707) r *= 2
  return Math.max(0.65, Math.min(1.5, r))
}

/**
 * Copy a time window out of `src` with raised-cosine micro-fades (default 4ms)
 * so every harvested kick, wobble loop, and vocal chop is 100% click-free.
 */
export function sliceAudioBuffer(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  startSec: number,
  durSec: number,
  fadeMs = 4
): AudioBuffer {
  const sr = src.sampleRate
  const start = Math.max(0, Math.min(src.length - 1, Math.floor(startSec * sr)))
  const len = Math.max(256, Math.min(src.length - start, Math.floor(durSec * sr)))
  const ch = src.numberOfChannels
  const out = ctx.createBuffer(ch, len, sr)
  const fade = Math.min(Math.floor(len * 0.2), Math.max(16, Math.floor((fadeMs / 1000) * sr)))

  for (let c = 0; c < ch; c++) {
    const inp = src.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0; i < len; i++) {
      let g = 1
      if (i < fade) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade)
      else if (i >= len - fade) g = 0.5 - 0.5 * Math.cos((Math.PI * (len - 1 - i)) / fade)
      dst[i] = inp[start + i] * g
    }
  }
  return out
}

function windowRmsPeak(buf: AudioBuffer, startSec: number, durSec: number): { rms: number; peak: number; variance: number } {
  const sr = buf.sampleRate
  const i0 = Math.max(0, Math.floor(startSec * sr))
  const i1 = Math.min(buf.length, Math.floor((startSec + durSec) * sr))
  if (i1 - i0 < 64) return { rms: 0, peak: 0, variance: 0 }
  const d = buf.getChannelData(0)
  const step = Math.max(1, Math.floor(sr / 11025))
  let sq = 0
  let peak = 0
  let n = 0
  // Divide into 8 sub-blocks to capture rhythmic/wobble modulation variance
  const sub = new Float64Array(8)
  const subN = new Int32Array(8)
  const span = Math.max(1, i1 - i0)
  for (let i = i0; i < i1; i += step) {
    const v = d[i]
    const av = Math.abs(v)
    if (av > peak) peak = av
    sq += v * v
    n++
    const b = Math.min(7, Math.floor(((i - i0) * 8) / span))
    sub[b] += v * v
    subN[b]++
  }
  const rms = Math.sqrt(sq / Math.max(1, n))
  let meanSub = 0
  const env = new Array<number>(8)
  for (let b = 0; b < 8; b++) {
    env[b] = Math.sqrt(sub[b] / Math.max(1, subN[b]))
    meanSub += env[b]
  }
  meanSub /= 8
  let varAcc = 0
  for (let b = 0; b < 8; b++) varAcc += (env[b] - meanSub) * (env[b] - meanSub)
  const variance = Math.sqrt(varAcc / 8) / (meanSub + 1e-6)
  return { rms, peak, variance }
}

/**
 * Grab a beat-quantized slice from a specific stem (or full mix) at a given time.
 * Used both for ⇧-click on a DRM/BAS/OTH/VOX pill AND ⇧-drag on the waveform.
 */
export function grabStemSlice(
  ctx: BaseAudioContext,
  deck: Deck,
  stemIdx: number | 'mix',
  opts: { startSec?: number; beats?: number } = {}
): HarvestedClip | null {
  if (!deck.hasAudio || !deck.track) return null
  const track = deck.track
  const grid = track.grid
  const bpm = grid && grid.bpm > 0 ? grid.bpm : 120
  const beatDur = 60 / bpm
  const offset = grid?.offset ?? 0

  let src: AudioBuffer | null = null
  let stem: PadStemKind = 'mix'
  if (stemIdx !== 'mix' && deck.stemCount === 4) {
    src = deck.getStemBuffer(stemIdx)
    stem = STEM_ORDER[stemIdx] ?? 'mix'
  } else {
    src = deck.audioBuffer ?? deck.getStemBuffer(0)
    stem = 'mix'
  }
  if (!src) return null

  const defaultBeats = stem === 'drums' ? 1 : stem === 'bass' ? 4 : 2
  const beats = Math.max(0.5, Math.min(16, opts.beats ?? defaultBeats))
  const rawStart = opts.startSec ?? deck.audiblePosition
  // Snap start to nearest beat boundary so loops lock tightly
  const k = Math.round((rawStart - offset) / beatDur)
  const snappedStart = Math.max(0, Math.min(src.duration - beatDur * 0.5, offset + k * beatDur))
  const dur = beats * beatDur

  const leadPad = stem === 'drums' ? 0.002 : 0
  const buffer = sliceAudioBuffer(ctx, src, Math.max(0, snappedStart - leadPad), dur, stem === 'drums' ? 2 : 5)

  const stemTag =
    stem === 'drums'
      ? beats <= 1
        ? 'KICK'
        : `DRM ${beats}B`
      : stem === 'bass'
        ? `BAS ${beats >= 4 ? `${beats / 4}BAR` : `${beats}B`}`
        : stem === 'vocals'
          ? `VOX ${beats}B`
          : stem === 'other'
            ? `OTH ${beats}B`
            : `MIX ${beats}B`

  return {
    name: `${track.name} · ${stemTag}`,
    shortLabel: stemTag,
    stem,
    buffer,
    sourceBpm: bpm,
    camelot: track.camelot,
    beats,
    mode: stem === 'bass' || beats >= 4 ? 'loop' : 'oneshot',
    keyLock: stem !== 'drums',
    fxSend: stem === 'vocals' || stem === 'other'
  }
}

/**
 * Auto-Harvest the 4 signature sonic gems of a loaded track:
 *   1) Wet Kick (DRM 1 beat, oneshot, dry, unpitched)
 *   2) Bass Wobble / 808 Groove (BAS 1 bar, sync loop, Camelot key-locked)
 *   3) Vocal Chop 1 (VOX 2 beats, oneshot, key-locked + Space FX)
 *   4) Vocal Chop 2 (or OTH synth stab if track is instrumental)
 */
export function autoHarvestDeck(ctx: BaseAudioContext, deck: Deck): HarvestedClip[] {
  if (!deck.hasAudio || !deck.track) return []
  const track = deck.track
  const grid = track.grid
  const bpm = grid && grid.bpm > 0 ? grid.bpm : 120
  const beatDur = 60 / bpm
  const bpb = grid?.beatsPerBar ?? 4
  const barDur = beatDur * bpb
  const offset = grid?.offset ?? 0
  const dur = deck.duration
  const nBars = Math.max(1, Math.floor((dur - offset) / barDur))
  const clips: HarvestedClip[] = []

  // Prefer active DROP sections when available, else middle 15%..85% of the track
  const drops = (track.sections ?? []).filter((s) => s.label === 'DROP' || s.label === 'GROOVE')
  const inDrop = (t: number) => drops.length === 0 || drops.some((s) => t >= s.tStart - 0.1 && t < s.tEnd - barDur)

  const bStart = Math.max(1, Math.floor(nBars * 0.12))
  const bEnd = Math.max(bStart + 1, Math.min(nBars - 1, Math.floor(nBars * 0.88)))

  if (deck.stemCount === 4) {
    const drm = deck.getStemBuffer(0)
    const bas = deck.getStemBuffer(1)
    const oth = deck.getStemBuffer(2)
    const vox = deck.getStemBuffer(3)

    // 1. Wet Kick from DRM (1 beat on a strong downbeat)
    if (drm) {
      let bestT = offset + bStart * barDur
      let bestScore = -1
      for (let b = bStart; b < bEnd; b++) {
        const t = offset + b * barDur
        if (!inDrop(t)) continue
        const attack = windowRmsPeak(drm, t, Math.min(0.08, beatDur * 0.25))
        const body = windowRmsPeak(drm, t, beatDur * 0.7)
        const sc = attack.peak * 0.6 + body.rms * 0.4
        if (sc > bestScore) {
          bestScore = sc
          bestT = t
        }
      }
      clips.push({
        name: `${track.name} · KICK`,
        shortLabel: 'KICK',
        stem: 'drums',
        buffer: sliceAudioBuffer(ctx, drm, Math.max(0, bestT - 0.002), beatDur, 2),
        sourceBpm: bpm,
        camelot: track.camelot,
        beats: 1,
        mode: 'oneshot',
        keyLock: false,
        fxSend: false
      })
    }

    // 2. Bass / UKG Wobble Loop from BAS (1 bar = 4 beats)
    if (bas) {
      let bestT = offset + bStart * barDur
      let bestScore = -1
      for (let b = bStart; b < bEnd - 1; b++) {
        const t = offset + b * barDur
        if (!inDrop(t)) continue
        const st = windowRmsPeak(bas, t, barDur)
        // Reward both strong low-end energy and rhythmic wobble/modulation
        const sc = st.rms * (0.65 + 0.45 * Math.min(1.5, st.variance))
        if (sc > bestScore) {
          bestScore = sc
          bestT = t
        }
      }
      if (bestScore > 0.02) {
        clips.push({
          name: `${track.name} · BAS 1BAR`,
          shortLabel: 'BAS 1B',
          stem: 'bass',
          buffer: sliceAudioBuffer(ctx, bas, bestT, barDur, 5),
          sourceBpm: bpm,
          camelot: track.camelot,
          beats: bpb,
          mode: 'loop',
          keyLock: true,
          fxSend: false
        })
      }
    }

    // 3 & 4. Top 2 distinct Vocal Chops (2 beats each, >= 4 bars apart)
    const voxCands: { t: number; score: number }[] = []
    if (vox) {
      const halfBar = beatDur * 2
      for (let b = bStart; b < bEnd; b++) {
        for (let sub = 0; sub < 2; sub++) {
          const t = offset + b * barDur + sub * halfBar
          if (t + halfBar > vox.duration) continue
          const st = windowRmsPeak(vox, t, halfBar)
          if (st.rms >= 0.032 && st.peak >= 0.1) {
            voxCands.push({ t, score: st.rms * 0.7 + st.peak * 0.3 })
          }
        }
      }
      voxCands.sort((a, b) => b.score - a.score)
      const picked: number[] = []
      for (const c of voxCands) {
        if (picked.every((pt) => Math.abs(pt - c.t) >= barDur * 4)) {
          picked.push(c.t)
          clips.push({
            name: `${track.name} · VOX ${picked.length}`,
            shortLabel: `VOX ${picked.length}`,
            stem: 'vocals',
            buffer: sliceAudioBuffer(ctx, vox, c.t, beatDur * 2, 6),
            sourceBpm: bpm,
            camelot: track.camelot,
            beats: 2,
            mode: 'oneshot',
            keyLock: true,
            fxSend: true
          })
          if (picked.length >= 2) break
        }
      }
    }

    // If track had < 2 vocal chops (e.g. instrumental), grab a rich OTH synth/chord stab
    if (clips.length < 4 && oth) {
      let bestT = offset + bStart * barDur
      let bestScore = -1
      for (let b = bStart; b < bEnd; b++) {
        const t = offset + b * barDur
        const st = windowRmsPeak(oth, t, beatDur * 2)
        if (st.rms > bestScore) {
          bestScore = st.rms
          bestT = t
        }
      }
      if (bestScore > 0.025) {
        clips.push({
          name: `${track.name} · OTH 2B`,
          shortLabel: 'OTH 2B',
          stem: 'other',
          buffer: sliceAudioBuffer(ctx, oth, bestT, beatDur * 2, 6),
          sourceBpm: bpm,
          camelot: track.camelot,
          beats: 2,
          mode: 'oneshot',
          keyLock: true,
          fxSend: true
        })
      }
    }
  } else if (deck.audioBuffer) {
    // Full-mix fallback when stems aren't separated yet
    const mix = deck.audioBuffer
    let bestT = offset + bStart * barDur
    let bestScore = -1
    for (let b = bStart; b < bEnd - 1; b++) {
      const t = offset + b * barDur
      if (!inDrop(t)) continue
      const st = windowRmsPeak(mix, t, barDur)
      if (st.rms > bestScore) {
        bestScore = st.rms
        bestT = t
      }
    }
    clips.push(
      {
        name: `${track.name} · HIT 1B`,
        shortLabel: 'HIT 1B',
        stem: 'mix',
        buffer: sliceAudioBuffer(ctx, mix, bestT, beatDur, 3),
        sourceBpm: bpm,
        camelot: track.camelot,
        beats: 1,
        mode: 'oneshot',
        keyLock: false,
        fxSend: false
      },
      {
        name: `${track.name} · LOOP 1BAR`,
        shortLabel: 'MIX 1B',
        stem: 'mix',
        buffer: sliceAudioBuffer(ctx, mix, bestT, barDur, 5),
        sourceBpm: bpm,
        camelot: track.camelot,
        beats: bpb,
        mode: 'loop',
        keyLock: true,
        fxSend: false
      }
    )
  }

  return clips
}

/** Encode any AudioBuffer into a clean 16-bit PCM WAV file (for pad persistence & K.O. II export). */
export function encodeWav16(buf: AudioBuffer): Uint8Array {
  const numCh = Math.min(2, buf.numberOfChannels)
  const sr = buf.sampleRate
  const frames = buf.length
  const dataBytes = frames * numCh * 2
  const out = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(out)

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, numCh, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * numCh * 2, true)
  v.setUint16(32, numCh * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, dataBytes, true)

  const chs = Array.from({ length: numCh }, (_, c) => buf.getChannelData(c))
  let pos = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chs[c][i]))
      v.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      pos += 2
    }
  }
  return new Uint8Array(out)
}
