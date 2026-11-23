# Streaming sources: what's actually possible (researched Nov 2026)

Short version: **SoundCloud is the only service where a hobbyist can legitimately get
full-track, DRM-free audio into the DJ engine. Spotify and YouTube Music are hard nos for
audio. TIDAL is a great metadata source but streams only 30s previews for third parties.**
Beatport/Beatsource LINK exist precisely for DJ apps but require a commercial partnership.

**The SoundCloud provider is implemented** — see "Setup" below.

## "But Serato gives me stems from SoundCloud streams?"

Probably yes — and the difference is the contract, not the tech:

- **Serato** integrates SoundCloud through an official **DJ-program licensing partnership**
  (requires listeners to hold SoundCloud Go+; streams arrive as 256k AAC; Serato analyzes
  BPM/key on load and runs its realtime stems). Partner agreements explicitly license
  DJ-grade processing of the audio, stems included.
- **bendwave** uses the **public API** (Artist Pro keys). The public API Terms of Use
  explicitly forbid feeding API content to stem separation. Same catalog, different front
  door, stricter rules. That's why streamed tracks in bendwave get beatgrids, sync, waveforms
  and cue points (all fine) but the stem pipeline stays off — enforced in code via
  `stemsAllowed: false`.

If bendwave ever grows into something distributed, the path to "Serato-style stems on
SoundCloud" is a partnership conversation with SoundCloud, not a technical one.

## The matrix

| Service | OAuth app? | Full-track audio for us? | Why |
|---|---|---|---|
| **SoundCloud** | Yes (Artist Pro required) | **Yes — HLS AAC, no DRM** | `/tracks/{id}/streams` returns playable stream URLs; decodable to PCM |
| **Spotify** | Yes | No | Web Playback SDK audio is EME-encrypted (Widevine/FairPlay); policy forbids capturing/altering/syncing |
| **YouTube Music** | No official API | No | Stream extraction violates YouTube ToS; keys get revoked |
| **TIDAL** | Yes (free) | Previews only | SDK Player module is "the only allowed way" for third parties, and covers *previews*; full streams = partner tier |
| **Beatport / Beatsource LINK** | Partnership | n/a | Purpose-built DJ streaming; requires a commercial deal |

## SoundCloud — the recommended path

State of the world (as of mid/late 2026):

- Self-service API keys reopened **18 May 2026**, but only for **Artist Pro subscribers**
  (~$10/mo — you likely want it for uploading anyway). Register at
  `soundcloud.com/you/apps` or via their CLI (`sc-api-auth.mjs` from `soundcloud/api`).
- **OAuth 2.1 with PKCE** (`secure.soundcloud.com/authorize`). Tokens ~1h; refresh tokens are
  single-use. Client-credentials flow covers public resources (search, streams, resolve);
  authorization-code flow adds user stuff (likes, playlists).
- Auth header is `Authorization: OAuth <token>` (not Bearer). IDs are URNs
  (`soundcloud:tracks:308946187`).
- **`GET /tracks/{id}/streams`** returns stream URLs for playback — HLS AAC segments.
  No DRM. Fetchable, and each segment decodes with `decodeAudioData`/WebCodecs, so beatgrids
  and sync work normally on SoundCloud content.
- Rate limit: **15,000 play-stream requests / 24h / app** — plenty for personal use.

### The catches that matter to *this* app

From the API Terms of Use:

1. **No stem separation on SoundCloud content.** The terms explicitly prohibit API content
   as "input to AI tools such as stem separation." So: SC tracks get beatgrid + sync, but the
   stem faders must be disabled/hidden for streaming tracks. This is a hard line, not a
   technicality — they revoke access over it.
2. **No downloads / offline / permanent copies.** Caching is session-only. Streaming tracks
   must never be written to the stems cache or crate audio files — keep the decoded PCM in
   memory, re-fetch next session.
3. **Attribution**: show uploader + link back to the soundcloud.com page in the UI.
4. They can revoke any app they judge "unacceptable." A personal-use DJ tool is low-risk, but
   don't ship it publicly without talking to them.

### Integration — implemented

1. Register an app at `soundcloud.com/you/apps` (needs Artist Pro). Set the redirect URI to
   `http://localhost:8931/callback` exactly.
2. Copy `soundcloud.config.example.json` → `soundcloud.config.json` in the repo root
   (gitignored) and fill in your `clientId` / `clientSecret`.
3. In bendwave: STREAM panel → **connect SoundCloud** → browser opens → authorize → back in
   the app. Tokens are stored encrypted (Keychain via Electron safeStorage) and auto-refresh.
4. Search, click a result. The track streams (progressive MP3), decodes to an in-memory
   AudioBuffer, gets a browser beatgrid, and loads onto a deck. Crate entries carry an `SC`
   badge and a hover link back to the track (attribution).

Implementation notes: OAuth 2.1 + PKCE with the secret living only in the main process;
all API/media fetches proxied through IPC (no CORS, no secrets in the renderer); decoded
audio is cached in memory for the session only (no files — terms); HLS-only tracks are
declined with a clear message (segment-decode would click); tracks stream as ~128k MP3 via
the public API (partner apps get 256k AAC — another partnership perk).

## TIDAL — the metadata power-up

- Free developer platform (`developer.tidal.com`), OAuth 2.1, up to 10 apps, no approval for dev mode.
- The **catalog API returns BPM and musical key per track** — better than our browser
  estimator for many tracks. Non-commercial license; dev-mode quota; production tier
  reportedly not accepting requests.
- Playback: third-party apps may only use the official, unmodified SDK Player module, and
  that grants *previews* (30s). Full streaming is partner-tier (what Serato/djay have).
- **Use it for**: crate enrichment — search TIDAL, pull BPM/key, match against local files
  or just pre-tag the crate. Don't build playback on it.

## Spotify — metadata only, ever

- Web API (OAuth) is fine for playlists/search/art — could power a "browse Spotify, match
  against my local crate" flow.
- Audio: Web Playback SDK streams through EME DRM; the PCM never touches user code, and
  Spotify's developer policy explicitly prohibits preserving anything but the original form
  and prohibits synchronization — i.e., literally what a DJ app does. djay's historical
  Spotify integration was a special licensing deal, later withdrawn. There is no hobbyist path.

## YouTube Music — no

No public API; the unofficial protocols (innertube etc.) violate YouTube ToS and get client
keys banned. Any "YouTube DJ" hack is one C&D away from breaking. Skip.

## Recommended build order

1. **Provider interface** (done — `src/renderer/sources/provider.ts`) so streaming is an
   add-in, not a rewrite.
2. **SoundCloud provider** with the OAuth loop + HLS→PCM decode + session-only cache +
   "no stems" gate on streamed tracks. Budget: a focused weekend.
3. **TIDAL metadata enrichment** for the crate (BPM/key/backfill).
4. Optional later: Beatport/Beatsource conversation if this ever stops being a personal toy.

Legal reminder: streaming DSP catalogs come with licenses for *personal playback*. A private
DJ session at home is fine; playing streams out at a gig/publishing mixes is a licensing
question between you and the service. The stem-separation prohibition on SoundCloud content
is the one rule this codebase must actively enforce.
