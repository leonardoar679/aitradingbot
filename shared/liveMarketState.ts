import { LIVE_GAP_SECONDS, STALE_PRICE_MS, type LiveConnection } from './liveMarket'

// THE LIVE-PRICE SOCKET AS IT STANDS, IN A WORD (the V4 document, §12): read from the log the main
// process keeps of it (shared/liveMarket.ts LiveConnection). Shared since 8 October 2026 (V5 Stage
// 2) so the main process reads it for the tray's tooltip as the bar's chip does
// (src/status/liveMarketChip.ts).

export type LiveMarketState = 'off' | 'live' | 'quiet' | 'stale' | 'reconnecting'

/** The socket as it stands: never opened; open and delivering; open but quiet (nothing for ten
 * seconds, the age past which a price is not used for a trade); stale (nothing for a minute: a gap,
 * written down for the session report); or closed and being reopened. */
export function liveMarketStateOf(connection: Pick<LiveConnection, 'open' | 'host' | 'lastMessageAt'> | null, nowMs: number): LiveMarketState {
  if (connection === null || connection.host === null) return 'off'
  if (!connection.open) return 'reconnecting'
  if (connection.lastMessageAt === null) return 'quiet'
  const ageMs = nowMs - connection.lastMessageAt
  if (ageMs >= LIVE_GAP_SECONDS * 1000) return 'stale'
  if (ageMs >= STALE_PRICE_MS) return 'quiet'
  return 'live'
}

/** The age of the last frame in a few characters: tenths under ten seconds, whole seconds after. */
export function describeFrameAge(ageMs: number): string {
  return ageMs < 10_000 ? `${(Math.max(0, ageMs) / 1000).toFixed(1)} s` : `${Math.round(ageMs / 1000)} s`
}
