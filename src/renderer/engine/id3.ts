/**
 * Zero-dependency browser-side ID3v2.3 / ID3v2.4 tag reader for DJ metadata:
 * extracts embedded Serato BeatGrid (exact downbeat offset + BPM), TBPM, and
 * TKEY (normalized to musical key + verified Camelot wheel code) straight from
 * the raw audio bytes we already read for decoding — takes <1 ms.
 */

export interface AudioTags {
  bpm?: number
  offset?: number
  key?: string
  camelot?: string
}

const CAMELOT: Record<string, string> = {
  'B major': '1B', 'F# major': '2B', 'C# major': '3B', 'G# major': '4B',
  'D# major': '5B', 'A# major': '6B', 'F major': '7B', 'C major': '8B',
  'G major': '9B', 'D major': '10B', 'A major': '11B', 'E major': '12B',
  'G# minor': '1A', 'D# minor': '2A', 'A# minor': '3A', 'F minor': '4A',
  'C minor': '5A', 'G minor': '6A', 'D minor': '7A', 'A minor': '8A',
  'E minor': '9A', 'B minor': '10A', 'F# minor': '11A', 'C# minor': '12A'
}

const CAMELOT_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(CAMELOT).map(([k, v]) => [v, k])
)

const ENHARMONIC: Record<string, string> = {
  Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#',
  Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C'
}

export function normalizeKey(raw: string): { key: string; camelot: string } | null {
  const s = raw.trim()
  if (!s) return null
  const cam = /^(\d{1,2})([ABab])$/.exec(s)
  if (cam) {
    const code = `${Number(cam[1])}${cam[2].toUpperCase()}`
    const k = CAMELOT_TO_KEY[code]
    return k ? { key: k, camelot: code } : null
  }
  const m = /^([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major)?$/i.exec(s)
  if (!m) return null
  let root = m[1].toUpperCase() + (m[2] ?? '')
  root = ENHARMONIC[root] ?? root
  const q = (m[3] ?? '').toLowerCase()
  const mode = q === 'm' || q === 'min' || q === 'minor' ? 'minor' : 'major'
  const key = `${root} ${mode}`
  const camelot = CAMELOT[key]
  return camelot ? { key, camelot } : null
}

function decodeLatin1(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end; i++) {
    const b = bytes[i]
    if (b === 0) break
    out += String.fromCharCode(b)
  }
  return out
}

function decodeTextFrame(bytes: Uint8Array, start: number, len: number): string {
  if (len <= 1) return ''
  const enc = bytes[start]
  const slice = bytes.subarray(start + 1, start + len)
  if (enc === 0 || enc === 3) {
    return new TextDecoder(enc === 3 ? 'utf-8' : 'latin1').decode(slice).replace(/\0+$/g, '').trim()
  }
  if (enc === 1 || enc === 2) {
    try {
      const label = enc === 2 ? 'utf-16be' : 'utf-16'
      return new TextDecoder(label).decode(slice).replace(/\0+$/g, '').trim()
    } catch {
      return decodeLatin1(slice, 0, slice.length).trim()
    }
  }
  return decodeLatin1(slice, 0, slice.length).trim()
}

function indexOfAscii(haystack: Uint8Array, start: number, end: number, needle: string): number {
  const nlen = needle.length
  outer: for (let i = start; i <= end - nlen; i++) {
    for (let j = 0; j < nlen; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer
    }
    return i
  }
  return -1
}

export function parseAudioTags(buf: ArrayBuffer): AudioTags {
  const out: AudioTags = {}
  const u8 = new Uint8Array(buf)
  if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return out // "ID3"

  const ver = u8[3]
  const tagSize = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f)
  const end = Math.min(u8.length, 10 + tagSize)
  const dv = new DataView(buf, 0, end)

  let pos = 10
  while (pos + 10 <= end) {
    if (u8[pos] === 0 && u8[pos + 1] === 0 && u8[pos + 2] === 0 && u8[pos + 3] === 0) break
    const fid = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3])
    const fsz =
      ver === 4
        ? ((u8[pos + 4] & 0x7f) << 21) | ((u8[pos + 5] & 0x7f) << 14) | ((u8[pos + 6] & 0x7f) << 7) | (u8[pos + 7] & 0x7f)
        : dv.getUint32(pos + 4, false)
    if (fsz <= 0 || pos + 10 + fsz > end) break

    const bodyStart = pos + 10
    const bodyEnd = bodyStart + fsz

    if (fid === 'TBPM' && out.bpm == null) {
      const v = parseFloat(decodeTextFrame(u8, bodyStart, fsz))
      if (Number.isFinite(v) && v >= 30 && v <= 260) out.bpm = Math.round(v * 100) / 100
    } else if (fid === 'TKEY') {
      const nk = normalizeKey(decodeTextFrame(u8, bodyStart, fsz))
      if (nk) {
        out.key = nk.key
        out.camelot = nk.camelot
      }
    } else if (fid === 'GEOB') {
      const hit = indexOfAscii(u8, bodyStart, bodyEnd, 'Serato BeatGrid\0')
      if (hit !== -1) {
        const bgStart = hit + 16
        if (bgStart + 14 <= bodyEnd) {
          const nmk = dv.getUint32(bgStart + 2, false)
          if (nmk >= 1 && bgStart + 6 + nmk * 8 <= bodyEnd) {
            const firstPos = dv.getFloat32(bgStart + 6, false)
            const lastOff = bgStart + 6 + (nmk - 1) * 8
            const bpm = dv.getFloat32(lastOff + 4, false)
            if (Number.isFinite(bpm) && bpm >= 30 && bpm <= 260 && Number.isFinite(firstPos)) {
              out.bpm = Math.round(bpm * 100) / 100
              out.offset = Math.round(Math.max(0, firstPos) * 10000) / 10000
            }
          }
        }
      }
    }

    pos = bodyEnd
  }

  return out
}
