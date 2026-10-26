import { ROUND_TRIP_PCT } from './edge'
import { HORIZON_BARS, type Horizon } from './features'
import { QUANTILE_LEVELS } from './ml/quantile'
import type { PricePrediction } from './prediction'
import { OPPORTUNITY_LINES, type TradeDecision } from './tradeDecision'
import type { RoundTrip } from '../venueCosts'

// FROM A FORECAST TO A TRADE PLAN (the V6 document, §29-30, §62 and §107; V6 Stage 12, 13 October 2026).
// Only a TRADE decision has a plan. From the live price:
// - THE ENTRY ZONE: half the five-minute ATR either side of it; the plan is VALID until the next
//   five-minute close, or until the price leaves the zone;
// - THE STOP: at the forecast's P10 level (P90 for a sell), and never nearer than one and a half
//   five-minute ATRs, nor than 0.2%;
// - THE TARGET: at the level the risk mode takes -- P75, P80 or P90 (P25, P20 or P10 for a sell),
//   P80 read between P75 and P90 -- where it clears a round trip from the entry; otherwise there is no
//   plan;
// - THE HOLDING TIME: the horizon. The size is the risk mode's (shared/paperRisk.ts), from the stop.
// Since V7.2-R Stage 3 the target, from the live price, must also reach the horizon's line of a move worth its
// costs (OPPORTUNITY_LINES: 1% up to four hours, 2% at a day): a price that has run toward it leaves no plan.
// The forecast's levels are prices fixed at its close (§41): the plan's percentages are from the live
// price. Since V8 Stage 3 (trade-plan-v2) the target must clear the round trip the decision was costed at on its
// venue's book -- its fee, spread and impact at the stake -- rather than the flat 0.24%, which stays only where no
// book was read.

export const PLAN_VERSION = 'trade-plan-v2'

export const PLAN_LINES = {
  /** The entry zone, either side of the live price, in five-minute ATRs. */
  zoneAtr: 0.5,
  /** The nearest a stop may be, in five-minute ATRs, and in percent. */
  atrStop: 1.5,
  minStopPct: 0.2,
  /** The zone where no ATR could be read, in percent either side. */
  zoneWithoutAtrPct: 0.1
} as const

export type TargetLevel = 'P75' | 'P80' | 'P90'

export interface TradePlan {
  version: string
  pair: string
  side: 'BUY' | 'SELL'
  horizon: Horizon
  /** The live price it was made from, and the zone the entry is good in. */
  entryPrice: number
  entryMin: number
  entryMax: number
  /** From the entry: how far the stop and the target are, in percent, and their prices. */
  stopPct: number
  stopPrice: number
  targetPct: number
  targetPrice: number
  targetLevel: TargetLevel
  /** The round trip its decision was costed at (V7.2-R Stage 4): the venue it is traded on; absent where none was read. */
  cost?: RoundTrip | null
  holdSec: number
  /** Unix seconds: the next five-minute close. */
  validUntil: number
}

const at = (tau: (typeof QUANTILE_LEVELS)[number]): number => QUANTILE_LEVELS.indexOf(tau)

/** The forecast's move at a level, in percent from its close; P80 read between P75 and P90, P20
 * between P10 and P25. */
export function levelPct(quantilesPct: readonly number[], level: TargetLevel, side: 'BUY' | 'SELL'): number {
  if (side === 'BUY') {
    if (level === 'P75') return quantilesPct[at(0.75)]
    if (level === 'P90') return quantilesPct[at(0.9)]
    return quantilesPct[at(0.75)] + ((0.8 - 0.75) / (0.9 - 0.75)) * (quantilesPct[at(0.9)] - quantilesPct[at(0.75)])
  }
  if (level === 'P75') return quantilesPct[at(0.25)]
  if (level === 'P90') return quantilesPct[at(0.1)]
  return quantilesPct[at(0.25)] - ((0.25 - 0.2) / (0.25 - 0.1)) * (quantilesPct[at(0.25)] - quantilesPct[at(0.1)])
}

export function tradePlanOf(input: { decision: TradeDecision; prediction: PricePrediction; livePrice: number; atr5mPct: number | null; targetLevel: TargetLevel }): TradePlan | null {
  const { decision, prediction, livePrice } = input
  if (decision.decision !== 'TRADE' || decision.side === null || !(livePrice > 0)) return null
  const range = prediction.horizons[decision.horizon]
  if (range === undefined) return null
  const side = decision.side
  const atr = input.atr5mPct !== null && Number.isFinite(input.atr5mPct) && input.atr5mPct > 0 ? input.atr5mPct : null
  const zone = (atr === null ? PLAN_LINES.zoneWithoutAtrPct : PLAN_LINES.zoneAtr * atr) / 100
  // A level's price, from the close the forecast was read at.
  const priceOf = (pct: number): number => prediction.currentPrice * (1 + pct / 100)
  const nearest = Math.max(atr === null ? 0 : PLAN_LINES.atrStop * atr, PLAN_LINES.minStopPct)
  const stopLevel = priceOf(side === 'BUY' ? range.quantilesPct[at(0.1)] : range.quantilesPct[at(0.9)])
  const stopPct = Math.max(side === 'BUY' ? (1 - stopLevel / livePrice) * 100 : (stopLevel / livePrice - 1) * 100, nearest)
  const targetPrice = priceOf(levelPct(range.quantilesPct, input.targetLevel, side))
  const targetPct = side === 'BUY' ? (targetPrice / livePrice - 1) * 100 : (1 - targetPrice / livePrice) * 100
  // A target that does not clear the route's round trip from here (the flat one where no book was read), or is under the
  // line of a move worth its costs, is no plan.
  const roundTripPct = decision.cost?.totalPct ?? ROUND_TRIP_PCT
  if (!(targetPct > roundTripPct) || !(targetPct >= OPPORTUNITY_LINES.minMovePct[decision.horizon])) return null
  return {
    version: PLAN_VERSION,
    pair: prediction.pair,
    side,
    horizon: decision.horizon,
    entryPrice: livePrice,
    entryMin: livePrice * (1 - zone),
    entryMax: livePrice * (1 + zone),
    stopPct,
    stopPrice: side === 'BUY' ? livePrice * (1 - stopPct / 100) : livePrice * (1 + stopPct / 100),
    targetPct,
    targetPrice,
    targetLevel: input.targetLevel,
    ...(decision.cost === undefined || decision.cost === null ? {} : { cost: decision.cost }),
    holdSec: HORIZON_BARS[decision.horizon] * 300,
    validUntil: prediction.barTime + 300
  }
}

/** Whether a plan still holds now: before the next close, with the price inside its zone. */
export function planValid(plan: Pick<TradePlan, 'entryMin' | 'entryMax' | 'validUntil'>, price: number, nowSec: number): boolean {
  return nowSec < plan.validUntil && price >= plan.entryMin && price <= plan.entryMax
}
