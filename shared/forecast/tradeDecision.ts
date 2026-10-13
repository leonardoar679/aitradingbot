import { MAX_SPREAD_PCT, STALE_PRICE_MS } from '../liveMarket'
import { edgeOf, type Edge } from './edge'
import type { Horizon } from './features'
import { classTradable, type ClassVerdict } from './opportunityClass'
import type { PricePrediction } from './prediction'

// THE FORECAST AND THE TRADE ARE TWO THINGS (the V6 document, §29-30, §62-63; V6 Stage 9, 13 October
// 2026). A forecast says what may happen; a TradeDecision says whether it is worth trading, and where
// it is not, why -- every reason that holds, by fixed lines:
// - NO_CALL: the forecast calls no way (shared/forecast/direction.ts);
// - UNCERTAIN: its range is too wide to know enough (§30);
// - EDGE_UNDER_COSTS: the move it expects does not clear a round trip's cost (shared/forecast/edge.ts),
//   UNLIKELY_PROFIT: or clears it less than 55 times in a hundred;
// - SPREAD: the live spread is over the 0.1% a trade is entered at; STALE_PRICE: there is no live price
//   newer than ten seconds; STALE_BARS: the close it was read at is more than two bars old;
// - REGIME_AGAINST: a BUY in a falling or panicking market, a SELL in a rising or recovering one;
// - RELIABILITY_LOW, QUALITY_LOW: under 60 (shared/forecast/quality.ts);
// - CLASS_NOT_APPROVED: its opportunity class (shared/forecast/opportunityClass.ts, V6 Stage 12) is
//   not APPROVED or on PROBATION: not traded enough on the replayed weeks to be judged, or it lost.
//   Where no class is read, it is not judged.
// TRADE where none holds. A SELL is a paper trade only, as every short in the app is.

export const DECISION_VERSION = 'decision-v2'

export const DECISION_LINES = {
  minProfitChance: 0.55,
  maxSpreadPct: MAX_SPREAD_PCT,
  staleBarsSec: 600,
  minQuality: 60
} as const

export type NoTradeReason =
  | 'NO_CALL'
  | 'UNCERTAIN'
  | 'EDGE_UNDER_COSTS'
  | 'UNLIKELY_PROFIT'
  | 'SPREAD'
  | 'STALE_PRICE'
  | 'STALE_BARS'
  | 'REGIME_AGAINST'
  | 'RELIABILITY_LOW'
  | 'QUALITY_LOW'
  | 'CLASS_NOT_APPROVED'

export interface TradeDecision {
  version: string
  pair: string
  horizon: Horizon
  side: 'BUY' | 'SELL' | null
  decision: 'TRADE' | 'NO_TRADE'
  reasons: { code: NoTradeReason; text: string }[]
  edge: Edge | null
  quality: number
  /** Its opportunity class and the class's verdict (V6 Stage 12); null where none was read. */
  classKey: string | null
  classVerdict: ClassVerdict | null
  /** Unix milliseconds. */
  at: number
}

export interface DecisionInput {
  prediction: PricePrediction
  horizon: Horizon
  nowMs: number
  /** The live book's mid and when it came, and its spread, where the stream holds it. */
  live: { price: number; updatedAt: number; spreadPct: number | null } | null
  /** The opportunity class a trade on its side falls in, and how the class stands; null where none is
   * read, and then it is not judged. */
  classOf: ((side: 'BUY' | 'SELL') => { key: string; verdict: ClassVerdict }) | null
}

const VERDICT_WORDS: Record<ClassVerdict, string> = {
  APPROVED: 'has earned trading',
  PROBATION: 'is on probation',
  NOT_ENOUGH: 'has not been traded enough on the replayed weeks to be judged',
  DISABLED: 'lost on the replayed weeks or on live paper'
}

const HORIZON_WORDS: Record<Horizon, string> = { minutes5: '5-minute', minutes15: '15-minute', hour1: '1-hour', hours4: '4-hour', hours24: '24-hour' }
const pct = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`

export function decideTrade(input: DecisionInput): TradeDecision {
  const { prediction, horizon } = input
  const range = prediction.horizons[horizon]
  const reasons: TradeDecision['reasons'] = []
  const add = (code: NoTradeReason, text: string): void => void reasons.push({ code, text })
  const words = HORIZON_WORDS[horizon]
  const side = range === undefined ? null : range.direction === 'BULLISH' ? 'BUY' : range.direction === 'BEARISH' ? 'SELL' : null
  let edge: Edge | null = null
  if (range === undefined) add('NO_CALL', `There is no ${words} forecast.`)
  else {
    if (range.uncertain) add('UNCERTAIN', `The ${words} range is over three times as wide as this kind of coin's usual: the forecast does not know enough.`)
    if (side === null) add('NO_CALL', `The ${words} forecast calls no way.`)
    else {
      edge = edgeOf(range.quantilesPct, side, input.live?.spreadPct ?? null)
      if (edge.edgePct <= 0) add('EDGE_UNDER_COSTS', `The move it expects (${pct(edge.expectedPct)}) does not clear a round trip's ${edge.costPct.toFixed(2)}%.`)
      else if (edge.pProfit < DECISION_LINES.minProfitChance) add('UNLIKELY_PROFIT', `It clears its costs only ${Math.round(edge.pProfit * 100)} times in a hundred.`)
      const regime = prediction.regime
      if ((side === 'BUY' && (regime === 'bear' || regime === 'panic')) || (side === 'SELL' && (regime === 'bull' || regime === 'recovery'))) add('REGIME_AGAINST', `A ${side} against a ${regime} market.`)
    }
    if (range.reliability === 'LOW') add('RELIABILITY_LOW', `Its reliability is LOW: ${range.reliabilityReasons.join('; ')}.`)
    if (range.quality.score < DECISION_LINES.minQuality) add('QUALITY_LOW', `Its quality is ${range.quality.score}, under ${DECISION_LINES.minQuality}.`)
  }
  const live = input.live
  if (live === null || input.nowMs - live.updatedAt > STALE_PRICE_MS) add('STALE_PRICE', 'There is no live price newer than ten seconds.')
  else if (live.spreadPct !== null && live.spreadPct > DECISION_LINES.maxSpreadPct) add('SPREAD', `The spread is ${live.spreadPct.toFixed(3)}%, over the ${DECISION_LINES.maxSpreadPct}% a trade is entered at.`)
  if (input.nowMs / 1000 - prediction.barTime > DECISION_LINES.staleBarsSec) add('STALE_BARS', 'The bars it was read from are more than two closes old.')
  const opportunity = side === null || input.classOf === null ? null : input.classOf(side)
  if (opportunity !== null && !classTradable(opportunity.verdict)) add('CLASS_NOT_APPROVED', `Its kind of opportunity (${opportunity.key}) ${VERDICT_WORDS[opportunity.verdict]}.`)
  return {
    version: DECISION_VERSION,
    pair: prediction.pair,
    horizon,
    side,
    decision: reasons.length === 0 ? 'TRADE' : 'NO_TRADE',
    reasons,
    edge,
    quality: range?.quality.score ?? 0,
    classKey: opportunity?.key ?? null,
    classVerdict: opportunity?.verdict ?? null,
    at: input.nowMs
  }
}
