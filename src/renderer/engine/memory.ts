/**
 * Audio memory budget manager: the registry of every decoded AudioBuffer set
 * we've handed out. Decks hold their own references (can't be freed while
 * loaded), so those ids are "protected" during eviction; everything else
 * (stream caches today, paging pools later) registers a release hook and gets
 * evicted LRU until usage fits the budget.
 *
 * See docs/memory.md for the full architecture.
 */

export interface MemoryEntry {
  id: string
  label: string
  bytes: number
  lastUsed: number
  release?: () => void
}

export interface MemoryUsage {
  used: number
  budget: number
  count: number
}

export class AudioMemory {
  readonly budgetBytes: number
  private entries = new Map<string, MemoryEntry>()

  constructor(budgetBytes = 1.25 * 1024 * 1024 * 1024) {
    this.budgetBytes = budgetBytes
  }

  /** decoded PCM bytes for a set of buffers (Float32: sr × ch × 4 × length) */
  static bytesOf(...bufs: (AudioBuffer | null | undefined)[]): number {
    let n = 0
    for (const b of bufs) {
      if (b) n += b.length * b.numberOfChannels * 4
    }
    return n
  }

  static fmt(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}G`
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}M`
    return `${(bytes / 1024).toFixed(0)}K`
  }

  /** register (or refresh) an allocation; release() runs when evicted or dropped */
  track(id: string, label: string, bytes: number, release?: () => void): void {
    this.entries.set(id, { id, label, bytes, lastUsed: performance.now(), release })
  }

  touch(id: string): void {
    const e = this.entries.get(id)
    if (e) e.lastUsed = performance.now()
  }

  release(id: string): void {
    this.entries.delete(id)
  }

  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id)
  }

  totalBytes(): number {
    let n = 0
    for (const e of this.entries.values()) n += e.bytes
    return n
  }

  usage(): MemoryUsage {
    return { used: this.totalBytes(), budget: this.budgetBytes, count: this.entries.size }
  }

  /**
   * Evict LRU among non-protected entries until under budget. Protected ids
   * (tracks currently on decks) are skipped — their buffers are referenced by
   * the decks themselves, so dropping the registry entry would free nothing.
   */
  enforce(protectedIds: Iterable<string>): { evicted: string[]; used: number } {
    const protect = new Set(protectedIds)
    let used = this.totalBytes()
    const evicted: string[] = []
    if (used <= this.budgetBytes) return { evicted, used }
    const candidates = [...this.entries.values()]
      .filter((e) => !protect.has(e.id))
      .sort((a, b) => a.lastUsed - b.lastUsed)
    for (const e of candidates) {
      if (used <= this.budgetBytes) break
      this.entries.delete(e.id)
      used -= e.bytes
      e.release?.()
      evicted.push(e.label)
    }
    return { evicted, used }
  }
}
