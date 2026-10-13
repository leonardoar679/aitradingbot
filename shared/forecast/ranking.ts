import type { MarketRegime } from '../marketResearch'
import { ROUND_TRIP_PCT, type Edge } from './edge'
import type { Horizon } from './features'
import type { ForecastRange, PricePrediction } from './prediction'
import type { TradeDecision } from './tradeDecision'

// WHICH FORECASTS COME FIRST (the V6 document, §32-33, §69-70; V6 Stage 9, 13 October 2026). Every pair
// the research reads -- its fifty most traded -- is ranked by fixed lines (§69):
//
//   edge x reliability x news relevance x liquidity x execution quality,
//   less uncertainty, market risk and cost,
//
// where the edge is the forecast's expected move after a round trip's cost on the way it calls (none
// for a forecast that calls no way), full at 1%; reliability counts HIGH whole, MEDIUM seven tenths,
// LOW four; a story moving it its way counts a quarter more and against it a quarter less; liquidity
// rises with the day's traded volume from $1M to $1B; execution is the live book's quality where the
// stream holds it, eight tenths where it does not. Uncertainty takes up to 20 points as the range runs
// wider than its class's usual, a panicking market 20 and a high-volatility one 10, and each round
// trip's worth of cost 5. Ties -- every forecast without an edge -- go by quality, then by volume. The
// first ten are the top ten and the first three the top three (§32, §70), so that a coin up 25% today
// with a flat forecast ranks under one up 7% whose forecast clears its costs (§33).

export const RANK_VERSION = 'rank-v1'

export const RANK_LINES = {
  edgeFullPct: 1,
  reliability: { HIGH: 1, MEDIUM: 0.7, LOW: 0.4 },
  news: { aligned: 1.25, against: 0.75 },
  liquidity: { fromQuote: 1e6, fullQuote: 1e9, floor: 0.2 },
  executionUnknown: 0.8,
  uncertaintyMax: 20,
  panic: 20,
  highVol: 10,
  costPerRoundTrip: 5,
  top: 10,
  shortlist: 3
} as const

export interface RankInput {
  prediction: PricePrediction
  horizon: Horizon
  /** The edge on the way the forecast calls; null where it calls none. */
  edge: Edge | null
  /** The day's traded volume in the quote, and the live book's execution quality (0-100), where known. */
  quoteVolume24h: number | null
  execution: number | null
}

export interface Ranked {
  pair: string
  horizon: Horizon
  score: number
  quality: number
  quoteVolume24h: number | null
  parts: { edge: number; reliability: number; news: number; liquidity: number; execution: number; uncertainty: number; marketRisk: number; cost: number }
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)

function newsFactor(range: ForecastRange, side: Edge['side'] | null): number {
  const story = range.news.v4
  if (story === null || story.shiftPct === 0 || side === null) return 1
  return Math.sign(story.shiftPct) === (side === 'BUY' ? 1 : -1) ? RANK_LINES.news.aligned : RANK_LINES.news.against
}

function riskOf(regime: MarketRegime): number {
  return regime === 'panic' ? RANK_LINES.panic : regime === 'high-vol' ? RANK_LINES.highVol : 0
}

export function rankOf(input: RankInput): Ranked {
  const range = input.prediction.horizons[input.horizon]
  const lines = RANK_LINES
  const quality = range?.quality.score ?? 0
  if (range === undefined) {
    return { pair: input.prediction.pair, horizon: input.horizon, score: 0, quality, quoteVolume24h: input.quoteVolume24h, parts: { edge: 0, reliability: 0, news: 1, liquidity: 0, execution: 0, uncertainty: 0, marketRisk: 0, cost: 0 } }
  }
  const edge = input.edge === null ? 0 : clamp01(input.edge.edgePct / lines.edgeFullPct)
  const reliability = lines.reliability[range.reliability]
  const news = newsFactor(range, input.edge?.side ?? null)
  const volume = input.quoteVolume24h
  const liquidity = volume === null || !(volume > 0) ? lines.liquidity.floor : Math.max(lines.liquidity.floor, clamp01(Math.log10(volume / lines.liquidity.fromQuote) / Math.log10(lines.liquidity.fullQuote / lines.liquidity.fromQuote)))
  const execution = input.execution === null ? lines.executionUnknown : clamp01(input.execution / 100)
  const ratio = range.usualWidth80Pct > 0 ? range.width80Pct / range.usualWidth80Pct : 1
  const uncertainty = lines.uncertaintyMax * clamp01((ratio - 1) / 2)
  const marketRisk = riskOf(input.prediction.regime)
  const cost = lines.costPerRoundTrip * ((input.edge?.costPct ?? ROUND_TRIP_PCT) / ROUND_TRIP_PCT)
  const score = Math.max(0, 100 * edge * reliability * news * liquidity * execution - uncertainty - marketRisk - cost)
  return { pair: input.prediction.pair, horizon: input.horizon, score, quality, quoteVolume24h: volume, parts: { edge, reliability, news, liquidity, execution, uncertainty, marketRisk, cost } }
}

/** The ranked forecasts, best first, and the top ten and three of them (§32). */
export function funnel(ranked: readonly Ranked[]): { ranked: Ranked[]; top10: Ranked[]; top3: Ranked[] } {
  const sorted = [...ranked].sort((a, b) => b.score - a.score || b.quality - a.quality || (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0) || a.pair.localeCompare(b.pair))
  return { ranked: sorted, top10: sorted.slice(0, RANK_LINES.top), top3: sorted.slice(0, RANK_LINES.shortlist) }
}

/** A pair's place in the ranking, with its decision. */
export interface RankedForecast extends Ranked {
  decision: TradeDecision
}

/** The ranking the window is shown: every pair best first, and the top ten and three by pair. */
export interface ForecastRanking {
  /** Unix seconds: the close the forecasts were read at. */
  at: number | null
  ranked: RankedForecast[]
  top10: string[]
  top3: string[]
}
