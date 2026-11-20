import type { AudioSourceProvider, StreamTrackRef } from './provider'

/**
 * SoundCloud provider.
 *
 * Search + stream via the main-process API proxy (OAuth session lives there).
 * Streams resolve to progressive MP3 URLs which decode straight into an
 * AudioBuffer — kept in a session-only in-memory cache (their terms forbid
 * offline copies). HLS-only tracks are declined with a clear message rather
 * than played glitchy.
 *
 * SoundCloud's API terms explicitly forbid feeding their content to stem
 * separation, so tracks from this provider carry stemsAllowed: false.
 */

interface SCTrackJson {
  id?: number | string
  urn?: string
  title?: string
  duration?: number // milliseconds
  duration_ms?: number
  permalink_url?: string
  artwork_url?: string
  access?: string
  user?: { username?: string }
  metadata_artist?: string
}

interface UrlCandidate {
  url: string
  score: number // 3 = progressive, 1 = hls, 0.5 = preview snippet
}

function collectUrls(node: unknown, out: UrlCandidate[], depth = 0): void {
  if (depth > 6) return
  if (Array.isArray(node)) {
    for (const item of node) collectUrls(item, out, depth + 1)
    return
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    const format = obj.format as { protocol?: string } | undefined
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && /^https?:\/\//.test(v)) {
        let score = 0
        if (format?.protocol === 'progressive') score = 3
        if (/http_mp3/.test(k)) score = Math.max(score, 3)
        if (/hls/.test(k) || format?.protocol === 'hls') score = Math.max(score, 1)
        if (/preview/.test(k)) score = 0.5
        if (score > 0) out.push({ url: v, score })
      } else {
        collectUrls(v, out, depth + 1)
      }
    }
  }
}

function bestStreamUrl(streams: unknown): { progressive?: string; hls?: boolean } {
  const found: UrlCandidate[] = []
  collectUrls(streams, found)
  found.sort((a, b) => b.score - a.score)
  const top = found[0]
  return {
    progressive: top && top.score >= 3 ? top.url : undefined,
    hls: found.some((f) => f.score === 1)
  }
}

export class SoundCloudProvider implements AudioSourceProvider {
  readonly id = 'soundcloud'
  readonly label = 'SoundCloud'
  configured = false
  loggedIn = false
  username: string | undefined

  /** urn/id -> decoded AudioBuffer, session only (no files, per API terms) */
  private cache = new Map<string, AudioBuffer>()

  constructor(private ctx: AudioContext) {}

  isAvailable(): boolean {
    return this.loggedIn
  }

  async refreshStatus(): Promise<void> {
    const api = window.vibedeck
    if (!api) return
    try {
      const s = await api.scStatus()
      this.configured = s.configured
      this.loggedIn = s.loggedIn
      this.username = s.username
    } catch {
      /* status stays as-is */
    }
  }

  async login(): Promise<{ ok: boolean; error?: string; username?: string }> {
    const api = window.vibedeck
    if (!api) return { ok: false, error: 'not running under electron' }
    const r = await api.scLogin()
    if (r.ok) {
      this.loggedIn = true
      this.username = r.username
    }
    return r
  }

  async logout(): Promise<void> {
    await window.vibedeck?.scLogout()
    this.loggedIn = false
    this.username = undefined
    this.cache.clear()
  }

  getCached(id: string): AudioBuffer | undefined {
    return this.cache.get(id)
  }

  async search(q: string): Promise<StreamTrackRef[]> {
    const r = await this.get('/tracks', { q, access: 'playable', limit: '20' })
    const list = (Array.isArray(r) ? r : []) as SCTrackJson[]
    return list
      .map((t) => ({
        provider: this.id,
        id: String(t.urn ?? t.id ?? ''),
        title: t.title ?? 'untitled',
        artist: t.user?.username ?? t.metadata_artist,
        durationSec: (t.duration ?? t.duration_ms ?? 0) / 1000,
        artworkUrl: t.artwork_url,
        sourceUrl: t.permalink_url,
        stemsAllowed: false
      }))
      .filter((ref) => ref.id !== '')
  }

  async resolve(ref: StreamTrackRef): Promise<{ kind: 'buffer'; buffer: AudioBuffer }> {
    const cached = this.cache.get(ref.id)
    if (cached) return { kind: 'buffer', buffer: cached }

    const enc = encodeURIComponent(ref.id)
    let streams: unknown
    try {
      streams = await this.get(`/tracks/${enc}/streams`)
    } catch {
      streams = await this.get(`/tracks/${enc}/stream`)
    }

    const { progressive, hls } = bestStreamUrl(streams)
    if (!progressive) {
      if (hls) throw new Error('HLS-only stream — no progressive URL for this track')
      throw new Error('no stream URL — track may be restricted')
    }

    const api = window.vibedeck!
    const fr = await api.scFetchBinary(progressive)
    if (!fr.ok || !fr.data) throw new Error(fr.error ?? 'media fetch failed')
    const u8 = fr.data
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
    const buffer = await this.ctx.decodeAudioData(ab)
    this.cache.set(ref.id, buffer)
    return { kind: 'buffer', buffer }
  }

  private async get(p: string, params?: Record<string, string>): Promise<unknown> {
    const r = await window.vibedeck!.scGet(p, params)
    if (!r.ok) throw new Error(r.error ?? 'soundcloud request failed')
    return r.data
  }
}
