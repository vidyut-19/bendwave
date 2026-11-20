// Workaround: on some Node versions (26.x), extract-zip silently "succeeds"
// while extracting only part of the Electron zip, leaving dist/ without
// Frameworks and no path.txt. This script detects that and re-extracts using
// the system unzip instead.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronDir = path.resolve('node_modules/electron')
const dist = path.join(electronDir, 'dist')
const platformPath = 'Electron.app/Contents/MacOS/Electron'

const complete =
  existsSync(path.join(dist, 'Electron.app/Contents/Frameworks')) &&
  existsSync(path.join(dist, 'version')) &&
  existsSync(path.join(electronDir, 'path.txt'))

if (complete) process.exit(0)

console.log('[ensure-electron] dist incomplete — re-extracting with system unzip')
const { downloadArtifact } = require(path.join(electronDir, 'node_modules/@electron/get'))
const { version } = JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8'))

mkdirSync(dist, { recursive: true })
const zip = await downloadArtifact({
  version,
  artifactName: 'electron',
  platform: 'darwin',
  arch: process.arch
})
execFileSync('unzip', ['-q', '-o', zip, '-d', dist], { stdio: 'inherit' })
writeFileSync(path.join(electronDir, 'path.txt'), platformPath)
console.log(`[ensure-electron] electron ${version} ready`)
