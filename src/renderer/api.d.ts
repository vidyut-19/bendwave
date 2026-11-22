export {}

declare global {
  export interface VibedeckApi {
    paths(): Promise<{ userData: string }>
    selectAudio(): Promise<string[]>
    expandPaths(paths: string[]): Promise<string[]>
    readAudio(p: string): Promise<Uint8Array>
    filePathFor(f: File): string
    crateLoad(): Promise<{ version?: number; tracks?: unknown[] }>
    crateSave(data: unknown): Promise<boolean>
    analyze(
      p: string,
      opts?: { stems?: boolean; stemsDir?: string; python?: string }
    ): Promise<{ ok: boolean; result?: unknown; error?: string }>
    recStart(): Promise<{ ok: boolean; path?: string; error?: string }>
    recWrite(chunk: Uint8Array): Promise<{ ok: boolean }>
    recFinish(frames: number, sampleRate: number): Promise<{ ok: boolean; path: string | null }>
    envStatus(): Promise<{
      venv: boolean
      python: string
      installing: boolean
      librosa: boolean
      demucs: boolean
    }>
    envInstall(opts?: { stems?: boolean }): Promise<{ ok: boolean; error?: string }>
    onEnvLog(cb: (line: string) => void): () => void
    scStatus(): Promise<{ configured: boolean; loggedIn: boolean; username?: string }>
    scLogin(): Promise<{ ok: boolean; error?: string; username?: string }>
    scLogout(): Promise<{ ok: boolean }>
    scGet(p: string, params?: Record<string, string>): Promise<{ ok: boolean; data?: unknown; error?: string }>
    scFetchBinary(url: string): Promise<{ ok: boolean; data?: Uint8Array; error?: string }>
    touchBarSync(state: { deck?: 'A' | 'B'; param?: string; value100?: number; killActive?: boolean }): void
    onTouchBarAction(cb: (payload: { kind: string; deck?: 'A' | 'B'; param?: string; value100?: number }) => void): () => void
  }

  interface Window {
    vibedeck?: VibedeckApi
  }
}
