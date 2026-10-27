import type { Candle } from './ipc'
import { ASSUMED_FUNDING_RATE, FUNDING_INTERVAL_SEC } from './perp'
import type { FundingRate } from './traders/delay'
import { followFundingOf } from './traders/follow'
import { PERP_FEES } from './venueCosts'

// THE NEWS BOOK'S LINES AND ITS ARITHMETIC (V8 Stage 9, 27 October 2026). While paper testing runs, the news rule's
// paper shorts -- a delisting's four-hour hold, a Monitoring Tag's bracket where it is switched on -- are the news
// book's, as the plan costs a short: on the coin's USDT perpetual, Binance's first and Bitget's where Binance lists
// none, at its taker fee each way and the funding it published over the hold, an assumed rate charged against the
// position where none was published. A coin no venue lists a perpetual of cannot be shorted by anyone: its short is a
// missed opportunity with that reason, scored apart and called nothing (src/news/newsBookShort.ts). A 1x short closes
// where its loss reaches its stake. The lines are fixed here, and named by V8-S9-BOOKS, before the first Start.

export const NEWS_BOOK_LINES = {
  version: 'news-book-v1',
  /** The perpetual's venue, in the order it is looked for. */
  venues: ['binance', 'bitget'],
  /** Taker fees in percent, each way, by venue. */
  takerPct: { binance: PERP_FEES.binance.takerPct, bitget: PERP_FEES.bitget.takerPct },
  /** A 1x short closes where its loss reaches this share of its stake. */
  lossCapPct: 100,
  /** Charged against the position at each funding time crossed where no rate was published. */
  assumedFundingRate: ASSUMED_FUNDING_RATE
} as const

export type NewsBookCloseReason = 'time' | 'stop' | 'target' | 'loss cap' | 'stopped'

/** What a news book's short keeps of itself, on its executor (`newsBook`). */
export interface NewsBookStamp {
  articleId: number
  ticker: string
  category: 'DELISTING' | 'MONITORING_TAG'
  releaseSec: number
  title: string
  /** The perpetual it is short on. */
  venue: 'binance' | 'bitget'
  symbol: string
  entryPx: number
  qty: number
  stakeQuote: number
  /** The entry's taker fee, in the quote. */
  feesQuote: number
  openedAtMs: number
  /** A tag's bracket; null for a delisting's. */
  stopPx: number | null
  targetPx: number | null
  /** It leaves at the open of this minute, in seconds: the rule's hold. */
  exitAtSec: number
  closeReason: NewsBookCloseReason | null
  exitPx: number | null
}

/** Where a short leaves, read from its perpetual's closed 1-minute bars after the minute it was entered in: its stop,
 * the loss of its stake, its target -- a bar reaching its stop and its target counted as reaching its stop -- or its
 * hold, at the open of its exit minute. A bar that opens past a level fills at its open. Null while it holds. */
export function newsBookExitOf(stamp: Pick<NewsBookStamp, 'openedAtMs' | 'entryPx' | 'stopPx' | 'targetPx' | 'exitAtSec'>, bars: readonly Candle[], lines: typeof NEWS_BOOK_LINES = NEWS_BOOK_LINES): { reason: NewsBookCloseReason; px: number; atSec: number } | null {
  const enteredMinute = Math.floor(stamp.openedAtMs / 60_000) * 60
  const cap = stamp.entryPx * (1 + lines.lossCapPct / 100)
  for (const bar of [...bars].sort((a, b) => a.time - b.time)) {
    if (bar.time <= enteredMinute) continue
    if (bar.time >= stamp.exitAtSec) return { reason: 'time', px: bar.open, atSec: bar.time }
    if (stamp.stopPx !== null && bar.high >= stamp.stopPx) return { reason: 'stop', px: Math.max(stamp.stopPx, bar.open), atSec: bar.time + 60 }
    if (bar.high >= cap) return { reason: 'loss cap', px: Math.max(cap, bar.open), atSec: bar.time + 60 }
    if (stamp.targetPx !== null && bar.low <= stamp.targetPx) return { reason: 'target', px: Math.min(stamp.targetPx, bar.open), atSec: bar.time + 60 }
  }
  return null
}

/** Funding assumed against a position: at each funding time it was open through, the assumed rate on its stake. */
export function assumedFundingAgainst(stakeQuote: number, fromMs: number, toMs: number, rate: number = NEWS_BOOK_LINES.assumedFundingRate): number {
  const period = FUNDING_INTERVAL_SEC * 1000
  const crossed = Math.floor(toMs / period) - Math.floor(fromMs / period)
  return crossed > 0 ? -crossed * rate * stakeQuote : 0
}

/** A short's funding at the rates its perpetual published, from its entry to `untilMs`: a short is paid a positive rate. */
export function newsBookFundingOf(stamp: Pick<NewsBookStamp, 'qty' | 'entryPx' | 'openedAtMs'>, rates: readonly FundingRate[], untilMs: number): number {
  return followFundingOf({ side: 'short', legs: [{ qty: -stamp.qty, px: stamp.entryPx, atMs: stamp.openedAtMs, feeQuote: 0, eventKey: '' }] }, rates, untilMs)
}

/** A closed short's result, for its book: its move on its size, both taker fees, its funding; in the quote and in
 * percent of its stake. */
export function newsBookResultOf(stamp: Pick<NewsBookStamp, 'venue' | 'entryPx' | 'qty' | 'stakeQuote' | 'feesQuote'>, exit: { px: number; atSec: number }, fundingQuote: number, lines: typeof NEWS_BOOK_LINES = NEWS_BOOK_LINES): { netQuote: number; netPct: number; feesQuote: number; fundingQuote: number; closedAt: number } {
  const feesQuote = stamp.feesQuote + (lines.takerPct[stamp.venue] / 100) * stamp.qty * exit.px
  const netQuote = (stamp.entryPx - exit.px) * stamp.qty - feesQuote + fundingQuote
  return { netQuote, netPct: stamp.stakeQuote > 0 ? (netQuote / stamp.stakeQuote) * 100 : 0, feesQuote, fundingQuote, closedAt: exit.atSec }
}

/** What an open short stands at, were it closed now at `px`: its move, both taker fees, and funding assumed against it. */
export function newsBookOpenNetOf(stamp: Pick<NewsBookStamp, 'venue' | 'entryPx' | 'qty' | 'stakeQuote' | 'feesQuote' | 'openedAtMs'>, px: number, nowMs: number, lines: typeof NEWS_BOOK_LINES = NEWS_BOOK_LINES): number {
  return newsBookResultOf(stamp, { px, atSec: Math.floor(nowMs / 1000) }, assumedFundingAgainst(stamp.stakeQuote, stamp.openedAtMs, nowMs, lines.assumedFundingRate), lines).netQuote
}
