import type { DJEngine } from './engine'

/**
 * Drift-lock sync: after SYNC matches tempo + phase, this controller keeps the
 * slave deck locked to the master while both play — a soft PLL. Every update
 * it (1) re-derives the slave's base tempo from the master's effective BPM and
 * (2) applies a small rate correction proportional to beat-phase error,
 * clamped to ±3%. Disengages if either deck stops or loses its grid.
 */
export class SyncController {
  slave: 'A' | 'B' | null = null
  onChange?: () => void

  constructor(private engine: DJEngine) {}

  private deck(id: 'A' | 'B') {
    return id === 'A' ? this.engine.deckA : this.engine.deckB
  }

  engage(id: 'A' | 'B'): void {
    if (this.slave && this.slave !== id) this.disengage()
    this.slave = id
    this.onChange?.()
  }

  disengage(): void {
    if (!this.slave) return
    this.deck(this.slave).bend(0)
    this.slave = null
    this.onChange?.()
  }

  update(): void {
    if (!this.slave) return
    const slave = this.deck(this.slave)
    const master = this.deck(this.slave === 'A' ? 'B' : 'A')
    const sg = slave.track?.grid
    const mg = master.track?.grid

    if (!slave.playing || !master.playing || !sg || !mg || !slave.hasAudio || !master.hasAudio) {
      this.disengage()
      return
    }

    // 1. tempo lock follows the master's effective BPM (incl. its pitch fader)
    const masterEff = mg.bpm * master.effRate
    slave.setTempoRate(masterEff / sg.bpm)

    // 2. phase lock: small proportional correction toward the master's phase
    const sBeat = 60 / sg.bpm
    const mBeat = 60 / masterEff
    const sPhase = ((((slave.position + sg.offset) / sBeat) % 1) + 1) % 1
    const mPhase = ((((master.position + mg.offset) / mBeat) % 1) + 1) % 1
    let err = sPhase - mPhase
    if (err > 0.5) err -= 1
    if (err < -0.5) err += 1

    if (Math.abs(err) < 0.015) {
      slave.bend(0)
    } else {
      const corr = Math.max(-0.03, Math.min(0.03, -err * 0.35))
      slave.bend(corr)
    }
  }
}
