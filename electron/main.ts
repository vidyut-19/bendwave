import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { FileHandle } from 'node:fs/promises'
import { registerSoundCloud } from './soundcloud'

const dev = process.argv.includes('--dev')

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    backgroundColor: '#0b0d10',
    title: 'vibedeck',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (dev) {
    void win.loadURL('http://localhost:5173')
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

registerSoundCloud()

// ---------------------------------------------------------------------------
// IPC surface (see electron/preload.ts for the renderer-facing shape)
// ---------------------------------------------------------------------------

const cratePath = (): string => path.join(app.getPath('userData'), 'crate.json')

ipcMain.handle('app:paths', () => ({ userData: app.getPath('userData') }))

ipcMain.handle('dialog:selectAudio', async () => {
  if (!win) return []
  const r = await dialog.showOpenDialog(win, {
    title: 'Add tracks to crate',
    filters: [
      { name: 'Audio', extensions: ['wav', 'aiff', 'aif', 'flac', 'mp3', 'm4a', 'aac', 'ogg'] }
    ],
    properties: ['openFile', 'multiSelections']
  })
  return r.canceled ? [] : r.filePaths
})

ipcMain.handle('fs:readAudio', async (_e, p: string) => {
  const buf = await fs.readFile(p)
  return new Uint8Array(buf)
})

ipcMain.handle('crate:load', async () => {
  try {
    return JSON.parse(await fs.readFile(cratePath(), 'utf8'))
  } catch {
    return { version: 1, tracks: [] }
  }
})

ipcMain.handle('crate:save', async (_e, data: unknown) => {
  await fs.mkdir(path.dirname(cratePath()), { recursive: true })
  await fs.writeFile(cratePath(), JSON.stringify(data, null, 2), 'utf8')
  return true
})

interface AnalyzeOptions {
  stems?: boolean
  stemsDir?: string
  python?: string
}

/** streaming 16-bit stereo WAV header */
function wavHeader(dataLen: number, sampleRate: number, channels = 2, bits = 16): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataLen, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE((sampleRate * channels * bits) / 8, 28)
  h.writeUInt16LE((channels * bits) / 8, 32)
  h.writeUInt16LE(bits, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataLen, 40)
  return h
}

let recFd: FileHandle | null = null
let recPath = ''
let recPos = 0

ipcMain.handle('rec:start', async () => {
  try {
    if (recFd) return { ok: false, error: 'already recording' }
    const dir = path.join(app.getPath('music'), 'vibedeck')
    await fs.mkdir(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    recPath = path.join(dir, `vibedeck-set-${ts}.wav`)
    recFd = await fs.open(recPath, 'w')
    await recFd.write(wavHeader(0, 48000), 0) // placeholder, patched on finish
    recPos = 44
    return { ok: true, path: recPath }
  } catch (e) {
    recFd = null
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('rec:write', async (_e, chunk: Uint8Array) => {
  if (!recFd) return { ok: false }
  try {
    await recFd.write(Buffer.from(chunk), recPos)
    recPos += chunk.byteLength
    return { ok: true }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('rec:finish', async (_e, frames: number, sampleRate: number) => {
  const fd = recFd
  recFd = null
  if (!fd) return { ok: false, path: null }
  try {
    await fd.write(wavHeader(Math.max(0, frames) * 4, sampleRate || 48000), 0)
  } catch {
    /* keep the data even if the header patch fails */
  }
  await fd.close()
  return { ok: true, path: recPath }
})

/**
 * Runs tools/analyze.py (librosa bpm/key + optional demucs stems) and returns
 * its JSON result. Fails soft: { ok: false, error } so the renderer can fall
 * back to the in-browser beatgrid estimator.
 */
ipcMain.handle('ingest:analyze', async (_e, filePath: string, opts: AnalyzeOptions = {}) => {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'analyze.py')
    : path.join(app.getAppPath(), 'tools', 'analyze.py')
  const args = [script, filePath]
  if (opts.stems) {
    args.push('--stems', '--stems-dir', opts.stemsDir ?? path.join(app.getPath('userData'), 'stems'))
  }
  return await new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
    const child = spawn(opts.python ?? 'python3', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => resolve({ ok: false, error: `spawn failed: ${e.message}` }))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: (err || out || `exited with code ${code}`).slice(-400) })
        return
      }
      try {
        resolve({ ok: true, result: JSON.parse(out) })
      } catch {
        resolve({ ok: false, error: `sidecar printed bad json: ${out.slice(0, 200)}` })
      }
    })
  })
})
