import type { Track } from '../engine/deck'

export interface Crate {
  version: 1
  tracks: Track[]
}

/** JSON-file-backed crate persisted through the electron main process. */
export class CrateStore {
  private data: Crate = { version: 1, tracks: [] }
  private saveTimer: number | undefined

  async load(): Promise<void> {
    const api = window.vibedeck
    if (!api) return
    try {
      const d = await api.crateLoad()
      if (d && Array.isArray(d.tracks)) {
        this.data = { version: 1, tracks: d.tracks as Track[] }
      }
    } catch {
      /* fresh crate */
    }
  }

  get tracks(): readonly Track[] {
    return this.data.tracks
  }

  upsert(track: Track): void {
    const i = this.data.tracks.findIndex((t) => t.id === track.id)
    if (i >= 0) this.data.tracks[i] = track
    else this.data.tracks.push(track)
    this.scheduleSave()
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      void window.vibedeck?.crateSave(this.data)
    }, 400)
  }
}
