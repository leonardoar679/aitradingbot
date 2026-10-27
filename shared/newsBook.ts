import { ASSUMED_FUNDING_RATE } from './perp'
import { PERP_FEES } from './venueCosts'

// THE NEWS BOOK'S LINES (V8 Stage 9, 27 October 2026). While paper testing runs, the news rule's paper shorts -- a
// delisting's four-hour hold, a Monitoring Tag's bracket where it is switched on -- are the news book's, as the plan
// costs a short: on the coin's USDT perpetual, Binance's first and Bitget's where Binance lists none, at its taker fee
// each way and the funding it published over the hold, an assumed rate charged against the position where none was
// published. A short of a coin no venue lists a perpetual of is still kept, at the spot price and the same costs, and
// marked as one no venue could take: it is shown apart and called nothing. A 1x short closes where its loss reaches its
// stake. Fixed here, and named by V8-S9-BOOKS, before the first Start.

export const NEWS_BOOK_LINES = {
  version: 'news-book-v1',
  /** The perpetual's venue, in the order it is looked for. */
  venues: ['binance', 'bitget'],
  /** Taker fees in percent, each way, by venue; a short no venue could take is costed at Binance's. */
  takerPct: { binance: PERP_FEES.binance.takerPct, bitget: PERP_FEES.bitget.takerPct },
  /** A 1x short closes where its loss reaches this share of its stake. */
  lossCapPct: 100,
  /** Charged against the position at each funding time crossed where no rate was published. */
  assumedFundingRate: ASSUMED_FUNDING_RATE
} as const
