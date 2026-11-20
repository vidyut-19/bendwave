import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('vibedeck', {
  paths: () => ipcRenderer.invoke('app:paths') as Promise<{ userData: string }>,
  selectAudio: () => ipcRenderer.invoke('dialog:selectAudio') as Promise<string[]>,
  readAudio: (p: string) => ipcRenderer.invoke('fs:readAudio', p) as Promise<Uint8Array>,
  filePathFor: (f: File) => webUtils.getPathForFile(f),
  crateLoad: () => ipcRenderer.invoke('crate:load'),
  crateSave: (data: unknown) => ipcRenderer.invoke('crate:save', data) as Promise<boolean>,
  analyze: (p: string, opts?: { stems?: boolean; stemsDir?: string; python?: string }) =>
    ipcRenderer.invoke('ingest:analyze', p, opts) as Promise<{
      ok: boolean
      result?: unknown
      error?: string
    }>,
  recStart: () => ipcRenderer.invoke('rec:start') as Promise<{ ok: boolean; path?: string; error?: string }>,
  recWrite: (chunk: Uint8Array) => ipcRenderer.invoke('rec:write', chunk) as Promise<{ ok: boolean }>,
  recFinish: (frames: number, sampleRate: number) =>
    ipcRenderer.invoke('rec:finish', frames, sampleRate) as Promise<{ ok: boolean; path: string | null }>,
  envStatus: () =>
    ipcRenderer.invoke('env:status') as Promise<{
      venv: boolean
      python: string
      installing: boolean
      librosa: boolean
      demucs: boolean
    }>,
  envInstall: (opts?: { stems?: boolean }) =>
    ipcRenderer.invoke('env:install', opts) as Promise<{ ok: boolean; error?: string }>,
  onEnvLog: (cb: (line: string) => void): (() => void) => {
    const listener = (_e: unknown, line: string): void => cb(line)
    ipcRenderer.on('env:log', listener)
    return () => ipcRenderer.removeListener('env:log', listener)
  },
  scStatus: () =>
    ipcRenderer.invoke('sc:status') as Promise<{ configured: boolean; loggedIn: boolean; username?: string }>,
  scLogin: () => ipcRenderer.invoke('sc:login') as Promise<{ ok: boolean; error?: string; username?: string }>,
  scLogout: () => ipcRenderer.invoke('sc:logout') as Promise<{ ok: boolean }>,
  scGet: (p: string, params?: Record<string, string>) =>
    ipcRenderer.invoke('sc:get', p, params) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  scFetchBinary: (url: string) =>
    ipcRenderer.invoke('sc:fetchBinary', url) as Promise<{ ok: boolean; data?: Uint8Array; error?: string }>
})
