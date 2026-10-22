import { FEE_RATE, SLIPPAGE_RATE } from '../fees'
import { QUANTILE_LEVELS, cdfAt } from './ml/quantile'

// WHAT A FORECAST IS WORTH TO TRADE (the V6 document, §29 and §62; V6 Stage 9, 13 October 2026): the
// move it expects, less what a round trip costs -- the fee and the slippage both ways (0.24%,
// shared/fees.ts) and the live spread crossed, where the stream holds the book -- and the chance the
// move clears that cost on the way it would be traded. The expected move is read from the five
// levels by Swanson's rule (three tenths each of P10 and P90, four of the median), which weighs the
// tails a forecast this skewed has.

export const EDGE_VERSION = 'edge-v1'

export interface Edge {
  side: 'BUY' | 'SELL'
  /** A round trip's cost, the expected move and the edge after cost, in percent. */
  costPct: number
  expectedPct: number
  edgePct: number
  /** The chance the move clears the cost the way it is traded. */
  pProfit: number
}

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P50 = QUANTILE_LEVELS.indexOf(0.5)
const P90 = QUANTILE_LEVELS.indexOf(0.9)

/** A round trip's fee and slippage, both ways, in percent: 0.24. */
export const ROUND_TRIP_PCT = (FEE_RATE + SLIPPAGE_RATE) * 2 * 100

/** What a round trip costs, in percent: the fee and slippage both ways, and the spread crossed. */
export function roundTripCostPct(spreadPct: number | null): number {
  return ROUND_TRIP_PCT + (spreadPct !== null && Number.isFinite(spreadPct) && spreadPct > 0 ? spreadPct : 0)
}

/** The edge of trading a horizon's forecast (its five levels of the move, in percent) on a side; at a round trip
 * read from a venue's book where one is given (shared/venueCosts.ts, V7.2-R Stage 4), the flat one otherwise. */
export function edgeOf(quantilesPct: readonly number[], side: 'BUY' | 'SELL', spreadPct: number | null, roundTripPct?: number | null): Edge {
  const costPct = typeof roundTripPct === 'number' && Number.isFinite(roundTripPct) && roundTripPct >= 0 ? roundTripPct : roundTripCostPct(spreadPct)
  const expectedPct = 0.3 * quantilesPct[P10] + 0.4 * quantilesPct[P50] + 0.3 * quantilesPct[P90]
  const edgePct = (side === 'BUY' ? expectedPct : -expectedPct) - costPct
  const pProfit = side === 'BUY' ? 1 - cdfAt(quantilesPct, QUANTILE_LEVELS, costPct) : cdfAt(quantilesPct, QUANTILE_LEVELS, -costPct)
  return { side, costPct, expectedPct, edgePct, pProfit }
}
