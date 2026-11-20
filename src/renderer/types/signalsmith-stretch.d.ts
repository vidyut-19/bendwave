declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    output?: number
    active?: boolean
    input?: number
    rate?: number
    semitones?: number
    tonalityHz?: number
    formantSemitones?: number
    formantCompensation?: boolean
    loopStart?: number
    loopEnd?: number
  }

  export interface StretchNode extends AudioNode {
    inputTime: number
    schedule(opts: StretchSchedule): void
    start(when?: number): void
    stop(when?: number): void
    addBuffers(channels: Float32Array[]): Promise<number>
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>
    setUpdateInterval(seconds: number, callback?: () => void): void
  }

  export function SignalsmithStretch(
    ctx: BaseAudioContext,
    channelOptions?: AudioWorkletNodeOptions
  ): Promise<StretchNode>
}
