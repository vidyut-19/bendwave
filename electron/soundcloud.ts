import { app, ipcMain, safeStorage, shell } from 'electron'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

/**
 * SoundCloud integration, main-process side.
 *
 * - Config: soundcloud.config.json (repo root, gitignored) or
 *   <userData>/soundcloud.json — { clientId, clientSecret, redirectUri }
 * - OAuth 2.1 + PKCE: opens the user's browser, catches the redirect on a
 *   loopback HTTP server, exchanges the code with the client secret (never
 *   exposed to the renderer).
 * - Tokens: persisted encrypted via safeStorage (plaintext fallback), auto
 *   refreshed (refresh tokens are single-use).
 * - All API + media fetching happens here (no CORS, no secrets in renderer).
 */

const AUTH_URL = 'https://secure.soundcloud.com/authorize'
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token'
const API_BASE = 'https://api.soundcloud.com'
const DEFAULT_REDIRECT = 'http://localhost:8931/callback'

interface SCConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
  message?: string
}

interface SCTokens {
  access_token: string
  refresh_token?: string
  expires_at: number
}

let config: SCConfig | null | undefined
let tokens: SCTokens | null = null
let meUsername: string | undefined

function tokenFile(): string {
  return path.join(app.getPath('userData'), 'soundcloud-tokens.bin')
}

async function loadConfig(): Promise<SCConfig | null> {
  if (config !== undefined) return config
  const candidates = [
    path.join(app.getAppPath(), 'soundcloud.config.json'),
    path.join(app.getPath('userData'), 'soundcloud.json')
  ]
  for (const p of candidates) {
    try {
      const j = JSON.parse(await fs.readFile(p, 'utf8')) as Partial<SCConfig>
      if (j.clientId && j.clientSecret) {
        config = {
          clientId: j.clientId,
          clientSecret: j.clientSecret,
          redirectUri: j.redirectUri ?? DEFAULT_REDIRECT
        }
        return config
      }
    } catch {
      /* try next candidate */
    }
  }
  config = null
  return null
}

async function saveTokens(): Promise<void> {
  if (!tokens) {
    await fs.rm(tokenFile(), { force: true })
    return
  }
  const json = JSON.stringify(tokens)
  try {
    if (safeStorage.isEncryptionAvailable()) {
      await fs.writeFile(tokenFile(), safeStorage.encryptString(json))
      return
    }
  } catch {
    /* fall through to plaintext */
  }
  await fs.writeFile(tokenFile(), json, 'utf8')
}

async function loadTokens(): Promise<void> {
  try {
    const buf = await fs.readFile(tokenFile())
    let json: string
    try {
      json = safeStorage.decryptString(buf)
    } catch {
      json = buf.toString('utf8')
    }
    const j = JSON.parse(json) as SCTokens
    if (j && typeof j.access_token === 'string') tokens = j
  } catch {
    /* no stored session */
  }
}

async function tokenExchange(body: Record<string, string>): Promise<TokenResponse> {
  const cfg = await loadConfig()
  if (!cfg) throw new Error('soundcloud not configured')
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json; charset=utf-8',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }).toString()
  })
  const j = (await r.json().catch(() => ({}))) as TokenResponse
  if (!r.ok || !j.access_token) {
    throw new Error(j.error_description ?? j.error ?? j.message ?? `token endpoint returned ${r.status}`)
  }
  return j
}

async function refreshTokens(): Promise<boolean> {
  if (!tokens?.refresh_token) {
    tokens = null
    await saveTokens()
    return false
  }
  try {
    const j = await tokenExchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    tokens = {
      access_token: j.access_token,
      refresh_token: j.refresh_token ?? tokens.refresh_token,
      expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000
    }
    await saveTokens()
    return true
  } catch {
    tokens = null
    await saveTokens()
    return false
  }
}

async function ensureToken(): Promise<string> {
  if (!tokens) throw new Error('not connected to SoundCloud')
  if (Date.now() >= tokens.expires_at) {
    const ok = await refreshTokens()
    if (!ok) throw new Error('session expired — reconnect SoundCloud')
  }
  return tokens.access_token
}

async function apiGet(p: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(API_BASE + p)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const doFetch = (tok: string) =>
    fetch(url, { headers: { accept: 'application/json; charset=utf-8', Authorization: `OAuth ${tok}` } })
  let r = await doFetch(await ensureToken())
  if (r.status === 401 && tokens?.refresh_token) {
    const ok = await refreshTokens()
    if (ok && tokens) r = await doFetch(tokens.access_token)
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = (await r.json()) as { message?: string }
      msg = j.message ?? msg
    } catch {
      /* keep status text */
    }
    if (r.status === 429) msg += ' — rate limited, wait a moment'
    throw new Error(msg)
  }
  return r.json()
}

async function scLogin(): Promise<{ ok: boolean; error?: string; username?: string }> {
  const cfg = await loadConfig()
  if (!cfg) return { ok: false, error: 'no soundcloud.config.json — see docs/streaming.md' }
  const ru = new URL(cfg.redirectUri)
  if (ru.protocol !== 'http:' && ru.protocol !== 'https:') {
    return { ok: false, error: `custom-scheme redirect URIs are unsupported in this build (got ${cfg.redirectUri})` }
  }
  const port = Number(ru.port) || 80
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', cfg.redirectUri)
      if (u.pathname !== ru.pathname) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<html><body style="background:#111;color:#eee;font-family:ui-monospace,monospace;padding:40px"><h2>vibedeck ✓ connected to SoundCloud</h2><p>You can close this tab.</p></body></html>'
      )
      server.close()
      if (u.searchParams.get('state') !== state) reject(new Error('OAuth state mismatch — aborting'))
      else if (u.searchParams.get('error')) reject(new Error(`SoundCloud returned: ${u.searchParams.get('error')}`))
      else if (u.searchParams.get('code')) resolve(u.searchParams.get('code') as string)
      else reject(new Error('callback contained no code'))
    })
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('login timed out after 5 minutes'))
    }, 5 * 60_000)
    server.on('close', () => clearTimeout(timeout))
    server.listen(port, '127.0.0.1', () => {
      const authUrl = new URL(AUTH_URL)
      authUrl.searchParams.set('client_id', cfg.clientId)
      authUrl.searchParams.set('redirect_uri', cfg.redirectUri)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('state', state)
      void shell.openExternal(authUrl.toString()).catch((e) => {
        server.close()
        reject(e)
      })
    })
  })

  const j = await tokenExchange({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: cfg.redirectUri
  })
  tokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000
  }
  await saveTokens()
  const me = (await apiGet('/me').catch(() => null)) as { username?: string } | null
  meUsername = me?.username
  return { ok: true, username: meUsername }
}

export function registerSoundCloud(): void {
  ipcMain.handle('sc:status', async () => {
    const cfg = await loadConfig()
    if (!tokens) await loadTokens()
    return { configured: !!cfg, loggedIn: !!tokens, username: meUsername }
  })

  ipcMain.handle('sc:login', async () => {
    try {
      return await scLogin()
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('sc:logout', async () => {
    try {
      if (tokens) {
        await fetch(`${API_BASE}/disconnect`, {
          method: 'POST',
          headers: { Authorization: `OAuth ${tokens.access_token}` }
        })
      }
    } catch {
      /* best effort */
    }
    tokens = null
    meUsername = undefined
    await saveTokens()
    return { ok: true }
  })

  ipcMain.handle('sc:get', async (_e, p: string, params?: Record<string, string>) => {
    try {
      return { ok: true, data: await apiGet(p, params) }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('sc:fetchBinary', async (_e, url: string) => {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`media fetch failed: HTTP ${r.status}`)
      return { ok: true, data: new Uint8Array(await r.arrayBuffer()) }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
}
