/**
 * Source provider interface — the seam where streaming services plug in.
 *
 * The local-files path (drag & drop / file dialog) is built into the app and
 * needs no provider. A streaming provider (SoundCloud is the realistic first
 * candidate — see docs/streaming.md) implements this interface and registers
 * itself; the crate/UI then treats its tracks like any other.
 *
 * Constraints for streaming providers, per each service's terms:
 * - decoded audio lives in memory for the session only (no files written)
 * - stem separation must be disabled for tracks whose terms forbid it
 *   (SoundCloud's explicitly do) — flag the track with `stemsAllowed: false`.
 */

export interface StreamTrackRef {
  /** provider id, e.g. "soundcloud" */
  provider: string
  /** provider-native track id/URN */
  id: string
  title: string
  artist?: string
  durationSec: number
  artworkUrl?: string
  /** attribution link back to the service (required by most terms) */
  sourceUrl?: string
  /** false when the provider's terms forbid stem separation of its content */
  stemsAllowed?: boolean
}

export interface AudioSourceProvider {
  readonly id: string
  readonly label: string

  /** Search the provider's catalog. */
  search(query: string): Promise<StreamTrackRef[]>

  /**
   * Resolve a track to audio the engine can decode. Return either a URL the
   * app can fetch (HLS playlists need internal handling) or the decoded
   * AudioBuffer directly for session-only playback.
   */
  resolve(ref: StreamTrackRef): Promise<{ kind: 'url'; url: string } | { kind: 'buffer'; buffer: AudioBuffer }>

  /** True when the provider is signed in / has valid credentials. */
  isAvailable(): boolean
}

const providers = new Map<string, AudioSourceProvider>()

export function registerProvider(p: AudioSourceProvider): void {
  providers.set(p.id, p)
}

export function listProviders(): AudioSourceProvider[] {
  return [...providers.values()]
}

export function getProvider(id: string): AudioSourceProvider | undefined {
  return providers.get(id)
}
