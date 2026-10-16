import type { Exchange, ExchangeQuote } from './ipc'

// THE COMPARISON OF EXCHANGES (V7.1 Stage 6, 16 October 2026): one pair's price, spread, depth and
// freshness on two exchanges, read at the same moment and set side by side. Arithmetic on a book and a
// ticker; the reads are the main process's (electron/services/marketCompareService.ts). Read-only: it
// places nothing and chooses nothing.

/** How far from the mid the depth is counted, as a share. */
export const DEPTH_BAND = 0.005

export interface BookLevels {
  /** Best first; [price, size] in the base coin. */
  bids: readonly (readonly [number, number])[]
  asks: readonly (readonly [number, number])[]
}

/** A level's distance from the mid may be the band itself: the compare allows for the floating point of
 * a product like 100 * 1.005. */
const BAND_TOLERANCE = 1e-12

/** The quote currency resting within the band of the mid on one side of a book, best first. A level
 * past the band ends the count: a book is sorted from the best, and a level out of order is not a
 * reason to count what lies behind it. */
export function depthWithin(levels: readonly (readonly [number, number])[], mid: number, side: 'bid' | 'ask', band = DEPTH_BAND): number {
  let quote = 0
  for (const [price, size] of levels) {
    if (!(price > 0) || !(size >= 0)) continue
    const away = (side === 'bid' ? mid - price : price - mid) / mid
    if (away > band + BAND_TOLERANCE) break
    quote += price * size
  }
  return quote
}

export interface QuoteReads {
  book: BookLevels | null
  /** The book's own time, ms, where the exchange stamps it. */
  bookTs: number | null
  lastPrice: number | null
  quoteVolume24h: number | null
  roundTripMs: number | null
  problem: string | null
}

/** One exchange's quote from what was read: the best bid and ask, the spread over the mid, the depth
 * within the band each side, the book's age against `nowMs`. A read that failed is a quote of nulls
 * with the problem; a book with no bid or no ask gives no spread and no depth. */
export function quoteOf(exchange: Exchange, symbol: string, reads: QuoteReads, nowMs: number): ExchangeQuote {
  const empty: ExchangeQuote = {
    exchange,
    symbol,
    price: reads.lastPrice,
    bid: null,
    ask: null,
    spreadPct: null,
    bidDepthQuote: null,
    askDepthQuote: null,
    quoteVolume24h: reads.quoteVolume24h,
    bookAgeMs: null,
    roundTripMs: reads.roundTripMs,
    problem: reads.problem
  }
  if (reads.book === null) return empty
  const bid = reads.book.bids[0]?.[0] ?? null
  const ask = reads.book.asks[0]?.[0] ?? null
  if (bid === null || ask === null || !(bid > 0) || !(ask > 0)) return { ...empty, bid, ask, problem: reads.problem ?? 'The book is one-sided or empty.' }
  const mid = (bid + ask) / 2
  return {
    ...empty,
    bid,
    ask,
    spreadPct: ((ask - bid) / mid) * 100,
    bidDepthQuote: depthWithin(reads.book.bids, mid, 'bid'),
    askDepthQuote: depthWithin(reads.book.asks, mid, 'ask'),
    bookAgeMs: reads.bookTs === null ? null : Math.max(0, nowMs - reads.bookTs)
  }
}

/** The pair's spelling both exchanges use: the base and the quote run together, in capitals. */
export function commonSymbol(baseAsset: string, quoteAsset: string): string {
  return `${baseAsset}${quoteAsset}`.toUpperCase()
}
