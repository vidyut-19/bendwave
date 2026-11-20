export type MidiBinding = { type: 'note' | 'cc'; channel: number; control: number }
export type MidiMessage = { type: 'note' | 'cc'; channel: number; control: number; value: number }

interface SequenceHooks {
  onStep?: (action: string, index: number, total: number) => void
  onDone?: () => void
  onCancel?: () => void
}

const STORAGE_KEY = 'vibedeck.midi.bindings.v1'

/**
 * MIDI-learn router: bind any action id to an incoming note or CC, persist the
 * map to localStorage, and dispatch incoming messages as action events.
 * Works with any class-compliant controller (K.O. II, pads, knobs, faders).
 * Also supports presets (e.g. the documented K.O. II pad map) and a guided
 * auto-map wizard that walks a list of actions in order.
 */
export class MidiRouter {
  private access: MIDIAccess | null = null
  bindings = new Map<string, MidiBinding>()
  learning: string | null = null
  private seq: { actions: string[]; total: number; hooks: SequenceHooks } | null = null

  onAction?: (actionId: string, msg: MidiMessage) => void
  onDevices?: (names: string[]) => void
  onBindingsChanged?: () => void

  async init(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) return false
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
    } catch {
      return false
    }
    this.loadBindings()
    this.wire()
    this.access.addEventListener('statechange', () => {
      this.wire()
      this.onDevices?.(this.deviceNames())
    })
    this.onDevices?.(this.deviceNames())
    return true
  }

  deviceNames(): string[] {
    const names: string[] = []
    this.access?.inputs.forEach((i) => names.push(i.name ?? i.id))
    return names
  }

  startLearn(actionId: string | null): void {
    this.cancelSequence(false)
    this.learning = actionId
    this.onBindingsChanged?.()
  }

  clearBinding(actionId: string): void {
    this.bindings.delete(actionId)
    this.persist()
    this.onBindingsChanged?.()
  }

  /** Replace the whole binding set (presets). */
  applyPreset(preset: Record<string, MidiBinding>): void {
    this.bindings.clear()
    for (const [k, v] of Object.entries(preset)) {
      if (v && (v.type === 'note' || v.type === 'cc')) this.bindings.set(k, v)
    }
    this.learning = null
    this.cancelSequence(false)
    this.persist()
    this.onBindingsChanged?.()
  }

  /**
   * Guided auto-map: walk `actions` in order, binding each to whatever control
   * is touched next. Pass null to cancel.
   */
  startSequence(actions: string[] | null, hooks: SequenceHooks = {}): void {
    if (this.seq) this.cancelSequence(true)
    this.learning = null
    if (!actions || actions.length === 0) return
    this.seq = { actions: [...actions], total: actions.length, hooks }
    this.emitStep()
    this.onBindingsChanged?.()
  }

  private cancelSequence(notify: boolean): void {
    if (!this.seq) return
    const hooks = this.seq.hooks
    this.seq = null
    if (notify) {
      hooks.onCancel?.()
      this.onBindingsChanged?.()
    }
  }

  private emitStep(): void {
    if (!this.seq) return
    const done = this.seq.total - this.seq.actions.length
    this.seq.hooks.onStep?.(this.seq.actions[0], done + 1, this.seq.total)
  }

  bindingFor(actionId: string): MidiBinding | undefined {
    return this.bindings.get(actionId)
  }

  get isSequencing(): boolean {
    return this.seq !== null
  }

  private wire(): void {
    this.access?.inputs.forEach((input) => {
      input.onmidimessage = (ev: MIDIMessageEvent) => this.handle(ev)
    })
  }

  private parse(data: Uint8Array): MidiMessage | null {
    if (data.length < 3) return null
    const status = data[0]
    const channel = status & 0x0f
    const control = data[1]
    const value = data[2]
    if (status >= 0x80 && status < 0x90) return { type: 'note', channel, control, value: 0 }
    if (status >= 0x90 && status < 0xa0) return { type: 'note', channel, control, value }
    if (status >= 0xb0 && status < 0xc0) return { type: 'cc', channel, control, value }
    return null
  }

  private handle(ev: MIDIMessageEvent): void {
    const data = ev.data
    if (!data) return
    const msg = this.parse(data)
    if (!msg) return

    if (this.seq) {
      const actionId = this.seq.actions.shift() as string
      this.bindings.set(actionId, {
        type: msg.type,
        channel: msg.channel,
        control: msg.control
      })
      this.persist()
      if (this.seq.actions.length === 0) {
        const hooks = this.seq.hooks
        this.seq = null
        hooks.onDone?.()
      } else {
        this.emitStep()
      }
      this.onBindingsChanged?.()
      return
    }

    if (this.learning) {
      this.bindings.set(this.learning, {
        type: msg.type,
        channel: msg.channel,
        control: msg.control
      })
      this.learning = null
      this.persist()
      this.onBindingsChanged?.()
      return
    }

    for (const [actionId, b] of this.bindings) {
      if (b.type === msg.type && b.channel === msg.channel && b.control === msg.control) {
        this.onAction?.(actionId, msg)
        return
      }
    }
  }

  private loadBindings(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const obj = JSON.parse(raw) as Record<string, MidiBinding>
      for (const [k, v] of Object.entries(obj)) {
        if (v && (v.type === 'note' || v.type === 'cc')) this.bindings.set(k, v)
      }
    } catch {
      /* ignore corrupt bindings */
    }
  }

  private persist(): void {
    const obj: Record<string, MidiBinding> = {}
    for (const [k, v] of this.bindings) obj[k] = v
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  }
}
