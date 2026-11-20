export {}

declare global {
  export interface VibedeckApi {
    paths(): Promise<{ userData: string }>
    selectAudio(): Promise<string[]>
    readAudio(p: string): Promise<Uint8Array>
    filePathFor(f: File): string
    crateLoad(): Promise<{ version?: number; tracks?: unknown[] }>
    crateSave(data: unknown): Promise<boolean>
    analyze(
      p: string,
      opts?: { stems?: boolean; stemsDir?: string; python?: string }
    ): Promise<{ ok: boolean; result?: unknown; error?: string }>
  }

  interface Window {
    vibedeck?: VibedeckApi
  }
}
