import { LIVE_GAP_SECONDS, STALE_PRICE_MS, type LiveConnection } from '../../shared/liveMarket'
import type { ModeLabel } from './statusModes'

// THE BAR'S LIVE MARKET CHIP (the V4 document, §12): what the live-price socket is doing, read from
// the log the main process keeps of it (shared/liveMarket.ts LiveConnection). Its own module, beside
// statusModes.ts, which reads the live gates and the AI's settings and is pinned to read nothing else.

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

export function describeLiveMarket(state: LiveMarketState, ageMs: number | null): ModeLabel {
  const age = ageMs === null ? 'no frame yet' : describeFrameAge(ageMs)
  switch (state) {
    case 'off':
      return { label: 'LIVE MARKET: OFF', detail: 'No live-price socket has been opened yet.', tone: 'muted' }
    case 'live':
      return { label: `LIVE MARKET · ${age}`, detail: `Live prices are streaming from Binance's market-data host; the last frame arrived ${age} ago.`, tone: 'safe' }
    case 'quiet':
      return {
        label: `LIVE MARKET · QUIET ${age}`,
        detail: `The socket is open but nothing has arrived for ${age}. A price older than ten seconds is not used for a trade of the app's own.`,
        tone: 'warn'
      }
    case 'stale':
      return {
        label: `MARKET DATA STALE · ${age}`,
        detail: `Nothing has arrived for ${age}: a gap, written down for the session report. No trade of the app's own is opened on a stale price.`,
        tone: 'blocked'
      }
    case 'reconnecting':
      return { label: 'LIVE MARKET: RECONNECTING', detail: 'The live-price socket is closed and is being reopened; prices on screen may be a few seconds behind.', tone: 'warn' }
  }
}
