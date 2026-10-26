import { roundTripOf, type CostedVenue, type RoundTrip } from './venueCosts'

// AN OPPORTUNITY THAT LOOKS LARGE ONLY BECAUSE ITS BOOK IS THIN (V8 Stage 2, 26 October 2026; the V8 plan's §5).
//
// A pair's predicted move is worth nothing if crossing its book costs most of it, and a thin pair is exactly the
// one that moves most on paper. Until V8 a book too thin to hold the stake was costed at the flat two basis
// points a leg (shared/venueCosts.ts roundTripOf), so the thinnest pairs read as cheap. The gate reads the routed
// venue's book at the sized stake and refuses, with the reason:
// - no book read: the cost is not measured, so nothing is recommended;
// - a book older than half a minute;
// - a book whose levels do not hold the stake on the way in or out;
// - a book with under five stakes within half a percent of the mid on the side the trade takes;
// - a round trip whose spread and impact take more than half the predicted move.
// It refuses for V8's writers and recommendations; over the writers that were there before V8 it only watches,
// each refusal written as a miss (shadow), until a registered line says otherwise (V8-S2-LIQ).

export const LIQUIDITY_LINES = {
  version: 'liquidity-v1',
  maxBookAgeMs: 30_000,
  /** Within this far of the mid, in percent, the side the trade takes must hold `minDepthStakes` stakes. */
  depthBandPct: 0.5,
  minDepthStakes: 5,
  /** The spread and the impact together may take at most this share of the predicted move. */
  maxCostShareOfMove: 0.5
} as const

export type LiquidityCode = 'no-book' | 'stale-book' | 'cannot-hold' | 'thin' | 'cost-share'

export type LiquidityVerdict =
  | { ok: true; trip: RoundTrip; depthQuote: number }
  | { ok: false; code: LiquidityCode; reason: string; trip: RoundTrip | null; depthQuote: number | null }

type Levels = { bids: readonly (readonly [number, number])[]; asks: readonly (readonly [number, number])[] }

/** What the side a trade takes holds, in the quote, within `bandPct` of the mid. */
export function depthWithin(levels: Levels, side: 'BUY' | 'SELL', bandPct: number): number | null {
  const bid = levels.bids[0]?.[0]
  const ask = levels.asks[0]?.[0]
  if (!(bid! > 0) || !(ask! > 0) || ask! < bid!) return null
  const mid = (bid! + ask!) / 2
  const book = side === 'BUY' ? levels.asks : levels.bids
  let quote = 0
  for (const [price, size] of book) {
    if (!(price > 0) || !(size > 0)) continue
    if (Math.abs(price / mid - 1) * 100 > bandPct) break
    quote += price * size
  }
  return quote
}

/** The gate on one trade: the routed venue's book at the sized stake, against the move it is for. */
export function liquidityVerdictOf(input: {
  venue: CostedVenue
  feePct: number
  side: 'BUY' | 'SELL'
  stakeQuote: number
  levels: Levels | null
  bookAgeMs: number | null
  /** The predicted move in the trade's favour, in percent; null where none is (a size call alone). */
  predictedMovePct: number | null
}): LiquidityVerdict {
  const lines = LIQUIDITY_LINES
  if (input.levels === null || input.levels.bids.length === 0 || input.levels.asks.length === 0) {
    return { ok: false, code: 'no-book', reason: "No book of the venue is read: the trade's cost is not measured, so nothing is recommended.", trip: null, depthQuote: null }
  }
  if (input.bookAgeMs === null || !(input.bookAgeMs <= lines.maxBookAgeMs)) {
    return { ok: false, code: 'stale-book', reason: `The venue's book is ${input.bookAgeMs === null ? 'of unknown age' : `${Math.round(input.bookAgeMs / 1000)} s old`}, older than the ${lines.maxBookAgeMs / 1000} s a cost is read from.`, trip: null, depthQuote: null }
  }
  const best = { bid: input.levels.bids[0][0], ask: input.levels.asks[0][0] }
  const trip = roundTripOf({ venue: input.venue, feePct: input.feePct, side: input.side, stakeQuote: input.stakeQuote, book: best, levels: input.levels })
  if (trip.basis !== 'book') {
    return { ok: false, code: 'cannot-hold', reason: `The book read does not hold a stake of ${input.stakeQuote.toFixed(2)} on the way in and out: what it would cost is not known.`, trip, depthQuote: null }
  }
  const depth = depthWithin(input.levels, input.side, lines.depthBandPct)
  if (depth === null || depth < lines.minDepthStakes * input.stakeQuote) {
    return { ok: false, code: 'thin', reason: `Within ${lines.depthBandPct}% of the mid the book holds ${depth === null ? 'nothing readable' : depth.toFixed(0)}, under the ${lines.minDepthStakes} stakes (${(lines.minDepthStakes * input.stakeQuote).toFixed(0)}) a trade is opened against.`, trip, depthQuote: depth }
  }
  const liquidityPct = (trip.spreadPct ?? 0) + trip.impactPct
  if (input.predictedMovePct !== null && liquidityPct > lines.maxCostShareOfMove * Math.abs(input.predictedMovePct)) {
    return {
      ok: false,
      code: 'cost-share',
      reason: `Crossing the book costs ${liquidityPct.toFixed(2)}% (spread and impact), more than ${Math.round(lines.maxCostShareOfMove * 100)}% of the ${Math.abs(input.predictedMovePct).toFixed(2)}% predicted: the move is large mostly because the pair is thin.`,
      trip,
      depthQuote: depth
    }
  }
  return { ok: true, trip, depthQuote: depth }
}
