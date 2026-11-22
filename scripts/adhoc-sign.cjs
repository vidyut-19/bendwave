const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * Electron-builder with `identity: null` mutates Electron's Info.plist and
 * app.asar without re-signing, leaving a broken signature on Apple Silicon.
 * Apply a clean ad-hoc signature before building the DMG so macOS validates
 * the bundle cleanly on other Macs (after clearing AirDrop quarantine).
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  console.log(`  • ad-hoc signing  path=${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
