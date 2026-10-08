import { describeFrameAge, type LiveMarketState } from '../../shared/liveMarketState'
import type { ModeLabel } from './statusModes'

export { describeFrameAge, liveMarketStateOf, type LiveMarketState } from '../../shared/liveMarketState'

// THE BAR'S LIVE MARKET CHIP (the V4 document, §12): what the live-price socket is doing, read from
// the log the main process keeps of it (shared/liveMarket.ts LiveConnection). Its own module, beside
// statusModes.ts, which reads the live gates and the AI's settings and is pinned to read nothing else.
// The state in a word is shared/liveMarketState.ts since 8 October 2026, so the tray reads it too.

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
