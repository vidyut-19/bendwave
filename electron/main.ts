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
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: '#090b0f',
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
    title: 'Add tracks or folders to crate',
    filters: [
      { name: 'Audio', extensions: ['wav', 'aiff', 'aif', 'flac', 'mp3', 'm4a', 'aac', 'ogg'] }
    ],
    properties: ['openFile', 'openDirectory', 'multiSelections']
  })
  return r.canceled ? [] : r.filePaths
})

const AUDIO_FILE_RE = /\.(wav|aiff?|flac|mp3|m4a|aac|ogg)$/i

async function collectAudio(p: string, out: string[], depth = 0): Promise<void> {
  if (depth > 4) return
  try {
    const st = await fs.stat(p)
    if (st.isDirectory()) {
      const entries = (await fs.readdir(p)).sort((a, b) => a.localeCompare(b))
      for (const name of entries) {
        if (name.startsWith('.')) continue
        await collectAudio(path.join(p, name), out, depth + 1)
      }
    } else if (st.isFile() && AUDIO_FILE_RE.test(p)) {
      out.push(p)
    }
  } catch {
    /* unreadable entry */
  }
}

/** Expands any mix of dropped files & folders recursively into audio file paths. */
ipcMain.handle('fs:expandPaths', async (_e, paths: string[]) => {
  const out: string[] = []
  for (const p of paths) {
    if (p) await collectAudio(p, out, 0)
  }
  return out
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

// --- analysis python environment (auto-bootstrap) ---------------------------
// Heavy deps (librosa ~200MB, demucs+torch ~2GB) stay OUT of the DMG; instead
// the app builds a private venv in userData on demand and always prefers it.

function envDir(): string {
  return path.join(app.getPath('userData'), 'pyenv')
}

function envPythonPath(): string {
  return path.join(envDir(), 'bin', 'python3')
}

/** Ensure Homebrew/local binaries (python3.12, ffmpeg, uv) are on PATH even when launched from Finder. */
function enrichedEnv(): NodeJS.ProcessEnv {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin']
  const cur = process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'
  const parts = cur.split(':')
  for (const p of extra) if (!parts.includes(p)) parts.unshift(p)
  return { ...process.env, PATH: parts.join(':') }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function pythonVersion(bin: string): Promise<[number, number] | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: enrichedEnv()
    })
    let out = ''
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.on('error', () => resolve(null))
    child.on('close', (c) => {
      if (c !== 0) return resolve(null)
      const [maj, min] = out.trim().split(/\s+/).map(Number)
      resolve(Number.isFinite(maj) && Number.isFinite(min) ? [maj, min] : null)
    })
  })
}

/** Prefer Python 3.11–3.13 (best torch/demucs wheel support); avoid Apple's ancient 3.9.6. */
async function findBestSystemPython(): Promise<string> {
  const candidates = [
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.13',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/opt/homebrew/bin/python3',
    'python3'
  ]
  let fallback = 'python3'
  for (const c of candidates) {
    const v = await pythonVersion(c)
    if (!v) continue
    if (v[0] === 3 && v[1] >= 11 && v[1] <= 13) return c
    if (v[0] === 3 && v[1] >= 10) fallback = c
  }
  return fallback
}

async function resolvePythonBin(): Promise<string> {
  return (await fileExists(envPythonPath())) ? envPythonPath() : await findBestSystemPython()
}

function envLog(line: string): void {
  if (!line) return
  try {
    win?.webContents.send('env:log', line)
  } catch {
    /* window may be gone */
  }
}

function runStream(bin: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, env: enrichedEnv() })
    const onLine = (d: Buffer) => envLog(d.toString().trimEnd())
    child.stdout?.on('data', onLine)
    child.stderr?.on('data', onLine)
    child.on('error', (e) => {
      envLog(`spawn failed: ${e.message}`)
      resolve(1)
    })
    child.on('close', (c) => resolve(c ?? 1))
  })
}

async function probeImports(bin: string): Promise<{ librosa: boolean; demucs: boolean }> {
  const probe = (code: string) =>
    new Promise<boolean>((resolve) => {
      const child = spawn(bin, ['-c', code], { stdio: ['ignore', 'ignore', 'ignore'], env: enrichedEnv() })
      child.on('error', () => resolve(false))
      child.on('close', (c) => resolve(c === 0))
    })
  const librosa = await probe('import librosa, soundfile')
  const demucs = await probe('import demucs, torch')
  return { librosa, demucs }
}

let envInstalling = false

ipcMain.handle('env:status', async () => {
  const venv = await fileExists(envPythonPath())
  const bin = venv ? envPythonPath() : await findBestSystemPython()
  const probe = await probeImports(bin)
  return { venv, python: bin, installing: envInstalling, ...probe }
})

ipcMain.handle('env:install', async (_e, opts: { stems?: boolean } = {}) => {
  if (envInstalling) return { ok: false, error: 'installation already running' }
  envInstalling = true
  try {
    const existing = await fileExists(envPythonPath())
    const existingVer = existing ? await pythonVersion(envPythonPath()) : null
    // Recreate venv if missing or built on Python < 3.10 (Apple's 3.9.6 can't install modern demucs/torch)
    const tooOld = !!existingVer && (existingVer[0] < 3 || existingVer[1] < 10)
    if (!existing || tooOld) {
      const sysPy = await findBestSystemPython()
      if (tooOld) {
        envLog(`upgrading pyenv from Python ${existingVer![0]}.${existingVer![1]} to ${sysPy}…`)
        await fs.rm(envDir(), { recursive: true, force: true })
      } else {
        envLog(`creating private python environment with ${sysPy}…`)
      }
      const code = await runStream(sysPy, ['-m', 'venv', envDir()])
      if (code !== 0) {
        return {
          ok: false,
          error: 'python3 -m venv failed — install Python 3.12 (brew install python@3.12)'
        }
      }
      await runStream(envPythonPath(), ['-m', 'pip', 'install', '--upgrade', 'pip'])
    }
    const pkgs = ['librosa', 'soundfile']
    if (opts.stems) pkgs.push('demucs', 'torch', 'torchaudio')
    envLog(`pip install ${pkgs.join(' ')} — this can take a while (stems/torch ≈ 2 GB, one time)…`)
    const code = await runStream(envPythonPath(), ['-m', 'pip', 'install', '--prefer-binary', '--upgrade', ...pkgs])
    return code === 0 ? { ok: true } : { ok: false, error: 'pip install failed — see log panel' }
  } finally {
    envInstalling = false
  }
})

/**
 * Runs tools/analyze.py (Serato/ID3 tags + librosa bpm/key + optional demucs stems)
 * and returns its JSON result. Fails soft: { ok: false, error }.
 */
ipcMain.handle('ingest:analyze', async (_e, filePath: string, opts: AnalyzeOptions = {}) => {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'analyze.py')
    : path.join(app.getAppPath(), 'tools', 'analyze.py')
  const pythonBin = opts.python ?? (await resolvePythonBin())
  const args = [script, filePath]
  if (opts.stems) {
    args.push('--stems', '--stems-dir', opts.stemsDir ?? path.join(app.getPath('userData'), 'stems'))
  }
  return await new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
    const child = spawn(pythonBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: enrichedEnv() })
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
