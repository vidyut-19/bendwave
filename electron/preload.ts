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
    }>
})
