import { SLIPPAGE_RATE } from './fees'
import { LAB_RISK } from './forecast/labTrader'
import type { Exchange } from './ipc'

// WHAT A ROUND TRIP COSTS, VENUE BY VENUE (V7.2-R Stage 3's sequel, Stage 4; 22 October 2026). The forecast's
// decisions charged every trade the same 0.24% -- a 0.1% fee and 2 bps of slippage each way -- plus the spread where
// the stream held a book. A trade pays its venue's fee, the spread it crosses and the depth its stake takes, and a
// pair can be cheaper to trade on Bitget than on Binance or dearer: Bitget's own list asks 0.2% a side of 53 older
// pairs, Bitcoin and ether among them, and 0.1% of the rest. So a round trip is read from a venue's book at the
// moment and the stake: a taker fee each way, the spread crossed (bought at the ask, sold at the bid), and each leg's
// impact -- what a market order of the stake takes from the levels beyond the best, against the best. Where only the
// best levels are read the impact is the flat slippage, and where no book is read the round trip is the flat one at
// the venue's fee. Arithmetic on a book: no key, no order.

export const VENUE_COSTS_VERSION = 'venue-costs-v1'

/** A venue's spot fees for its base tier, in percent of a fill's notional, and where they were read. */
export interface VenueFees {
  takerPct: number
  makerPct: number
  readOn: string
  source: string
}

/** The venues the forecast's trades are costed on. A venue's per-pair rate, where the venue lists one, replaces its
 * line here (venueFeeOf). */
export const VENUE_FEES: Readonly<Record<'binance' | 'bitget', VenueFees>> = {
  binance: {
    takerPct: 0.1,
    makerPct: 0.1,
    readOn: '2026-10-22',
    source: "Binance's published spot schedule for a regular user (VIP 0), without the BNB discount; Binance has no public per-pair fee list"
  },
  bitget: {
    takerPct: 0.1,
    makerPct: 0.1,
    readOn: '2026-10-22',
    source: "Bitget's public spot symbol list (api/v2/spot/public/symbols): 0.1% taker and maker on 3,472 online USDT pairs, 0.2% on 53 older ones (BTC, ETH, SOL, XRP, DOGE and BNB among them), read per pair where the list is held"
  }
}

export type CostedVenue = keyof typeof VENUE_FEES

/** The stake a round trip is costed at: the most the paper laboratory puts in one trade of its account. */
export const VENUE_STAKE_QUOTE = (LAB_RISK.fundQuote * LAB_RISK.maxPositionPct) / 100
export const COSTED_VENUES: readonly CostedVenue[] = ['binance', 'bitget']

export const isCostedVenue = (exchange: Exchange | string): exchange is CostedVenue => (COSTED_VENUES as readonly string[]).includes(exchange)

/** A venue's taker fee for a pair, in percent: its own per-pair rate where one was read (a fraction, as Bitget lists
 * it: 0.002 is 0.2%), its base tier's otherwise. */
export function venueFeeOf(venue: CostedVenue, pairRate?: number | null): number {
  return typeof pairRate === 'number' && Number.isFinite(pairRate) && pairRate >= 0 && pairRate < 0.05 ? pairRate * 100 : VENUE_FEES[venue].takerPct
}

/** What a market order of `stakeQuote` pays beyond the best price on the side it takes, in percent of the best: the
 * average price of the levels it fills from against the first; null where the levels read do not hold the stake. */
export function impactPct(levels: readonly (readonly [number, number])[], stakeQuote: number): number | null {
  if (!(stakeQuote > 0)) return 0
  const best = levels[0]?.[0]
  if (best === undefined || !(best > 0)) return null
  let quote = 0
  let qty = 0
  for (const [price, size] of levels) {
    if (!(price > 0) || !(size > 0)) continue
    const take = Math.min(size, (stakeQuote - quote) / price)
    quote += take * price
    qty += take
    if (quote >= stakeQuote - 1e-9) return Math.abs(quote / qty / best - 1) * 100
  }
  return null
}

/** A round trip on a venue, in percent of the mid: its parts, and what they were read from -- the book's levels, its
 * best bid and ask alone, or nothing. */
export interface RoundTrip {
  venue: CostedVenue
  feePct: number
  spreadPct: number | null
  impactPct: number
  totalPct: number
  basis: 'book' | 'best' | 'flat'
}

/** A round trip of `stakeQuote` on a venue: a taker fee each way; the spread, where a two-sided book is read; each
 * leg's impact from the levels where they are read (the entry's side, then the other's on the way out), the flat
 * slippage each way where only the best levels are, or where the levels do not hold the stake. */
export function roundTripOf(input: {
  venue: CostedVenue
  feePct: number
  side: 'BUY' | 'SELL'
  stakeQuote: number
  book: { bid: number; ask: number } | null
  levels?: { bids: readonly (readonly [number, number])[]; asks: readonly (readonly [number, number])[] } | null
}): RoundTrip {
  const fees = 2 * input.feePct
  const flatLeg = SLIPPAGE_RATE * 100
  const book = input.book
  if (book === null || !(book.bid > 0) || !(book.ask > 0) || book.ask < book.bid) {
    return { venue: input.venue, feePct: input.feePct, spreadPct: null, impactPct: 2 * flatLeg, totalPct: fees + 2 * flatLeg, basis: 'flat' }
  }
  const mid = (book.bid + book.ask) / 2
  const spreadPct = ((book.ask - book.bid) / mid) * 100
  const levels = input.levels ?? null
  if (levels === null) return { venue: input.venue, feePct: input.feePct, spreadPct, impactPct: 2 * flatLeg, totalPct: fees + spreadPct + 2 * flatLeg, basis: 'best' }
  const entry = impactPct(input.side === 'BUY' ? levels.asks : levels.bids, input.stakeQuote)
  const exit = impactPct(input.side === 'BUY' ? levels.bids : levels.asks, input.stakeQuote)
  const impact = (entry ?? flatLeg) + (exit ?? flatLeg)
  return { venue: input.venue, feePct: input.feePct, spreadPct, impactPct: impact, totalPct: fees + spreadPct + impact, basis: entry === null || exit === null ? 'best' : 'book' }
}

/** How a paper trade costed at a round trip fills (V7.2-R Stage 4): on that venue, at its fee, each market fill a half
 * spread and a leg's impact worse than its price (never under the flat slippage); on Binance at the flat lines where
 * no round trip was read. */
export function paperFillOf(cost: RoundTrip | null | undefined): { exchange: CostedVenue; feeRate: number; slippageRate: number } {
  if (cost === null || cost === undefined) return { exchange: 'binance', feeRate: VENUE_FEES.binance.takerPct / 100, slippageRate: SLIPPAGE_RATE }
  const leg = ((cost.spreadPct ?? 0) / 2 + cost.impactPct / 2) / 100
  return { exchange: cost.venue, feeRate: cost.feePct / 100, slippageRate: Math.max(SLIPPAGE_RATE, leg) }
}

/** Of the round trips read for a pair, the cheapest; null where none was. A tie goes to the first given. */
export function cheapestOf(trips: readonly RoundTrip[]): RoundTrip | null {
  let best: RoundTrip | null = null
  for (const trip of trips) if (best === null || trip.totalPct < best.totalPct - 1e-12) best = trip
  return best
}
