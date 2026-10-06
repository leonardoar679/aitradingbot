import { AI_WATCH_PAPER_DEFAULT_BTC_MOVE, AI_WATCH_PAPER_DEFAULT_STAKE } from '../../shared/aiWatchPaper'
import { executionQuality, revalidate, type ExecutionQuality, type LiveState, type LiveVerdict } from '../../shared/liveMarket'
import type { RightNowRow } from './opportunities'

export interface LiveReading {
  verdict: LiveVerdict
  quality: ExecutionQuality
}

/** What the live price says of a recommendation still on offer: whether it can be entered now, must
 * wait for its range, or no longer stands (shared/liveMarket.ts revalidate), and how good the
 * conditions are to execute in. Bitcoin's move is held to the watch's safeguard, and the depth to
 * the watch's stake, where those are known; their defaults otherwise. Null before the stream has
 * been read. */
export function liveReadingOf(
  row: Pick<RightNowRow, 'item' | 'side' | 'entryMin' | 'entryMax' | 'expiresAt'>,
  live: LiveState | null,
  options: { btcLimitPct?: number; stakeQuote?: number; nowMs: number }
): LiveReading | null {
  if (live === null) return null
  const { symbol, time } = row.item.event
  const side = row.side === 'long' ? 'buy' : 'sell'
  const book = live.books[symbol] ?? null
  const btcPrice = live.btcMinutes.length > 0 ? live.btcMinutes[live.btcMinutes.length - 1].close : null
  return {
    verdict: revalidate({
      side,
      entryMin: row.entryMin,
      entryMax: row.entryMax,
      expiresAt: row.expiresAt,
      eventTime: time,
      book,
      btcMinutes: live.btcMinutes,
      btcPrice,
      btcLimitPct: options.btcLimitPct ?? AI_WATCH_PAPER_DEFAULT_BTC_MOVE,
      nowMs: options.nowMs
    }),
    quality: executionQuality({ book, depth: live.depth[symbol] ?? null, side, stakeQuote: options.stakeQuote ?? AI_WATCH_PAPER_DEFAULT_STAKE, nowMs: options.nowMs })
  }
}

/** The verdict in a word, as shown. */
export function describeLiveState(verdict: LiveVerdict): { word: string; tone: 'up' | 'gold' | 'down' } {
  if (verdict.state === 'enterable') return { word: 'ENTERABLE', tone: 'up' }
  if (verdict.state === 'waiting') return { word: 'WAITING', tone: 'gold' }
  return { word: 'INVALIDATED', tone: 'down' }
}
