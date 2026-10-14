import type { Direction } from '../../shared/forecast/direction'
import type { Horizon, PairClass } from '../../shared/forecast/features'
import type { PricePrediction } from '../../shared/forecast/prediction'
import type { ForecastRanking, RankedForecast } from '../../shared/forecast/ranking'
import { decideOnBook, heldBackByPrice, type TradeDecision } from '../../shared/forecast/tradeDecision'
import type { LiveState } from '../../shared/liveMarket'

// THE PREDICTIONS TABLE'S ROWS (the V6 document, §32-34 and §69-70; V6 Stage 10, 13 October 2026): the
// ranking best first, cut by the page's filters. A row keeps its place in the whole ranking, so a
// filtered table still says where a pair stands among all of them.

export interface PredictionFilters {
  /** Part of a pair's name, as typed: "sol", "SOL/USDT". */
  query: string
  /** The horizon the table reads each pair at: the one it is ranked at, or one for every pair. */
  horizon: Horizon | 'ranked'
  call: Direction | 'all'
  pairClass: PairClass | 'all'
  /** Only pairs the decision would trade -- on a live price, where the pass had none for them (shared/
   * forecast/tradeDecision.ts) --; only pairs a story is moving. */
  tradeOnly: boolean
  newsOnly: boolean
}

export const NO_FILTERS: PredictionFilters = { query: '', horizon: 'ranked', call: 'all', pairClass: 'all', tradeOnly: false, newsOnly: false }

export interface PredictionRow {
  /** Its place in the whole ranking, from 1. */
  rank: number
  ranked: RankedForecast
  prediction: PricePrediction
  /** The horizon the row is read at. */
  horizon: Horizon
}

/** A row's decision on the book the stream holds for its pair now, where it holds one; the pass's
 * otherwise (shared/forecast/tradeDecision.ts). */
export function rowDecision(row: PredictionRow, live: LiveState | null, nowMs: number): TradeDecision {
  return decideOnBook(row.ranked.decision, row.prediction, live?.books[row.ranked.pair], nowMs)
}

export function predictionRows(ranking: ForecastRanking | null, predictions: ReadonlyMap<string, PricePrediction>, filters: PredictionFilters): PredictionRow[] {
  if (ranking === null) return []
  const query = filters.query.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const rows: PredictionRow[] = []
  ranking.ranked.forEach((ranked, index) => {
    const prediction = predictions.get(ranked.pair)
    if (prediction === undefined) return
    const horizon = filters.horizon === 'ranked' ? ranked.horizon : filters.horizon
    const range = prediction.horizons[horizon]
    if (range === undefined) return
    if (query !== '' && !ranked.pair.includes(query)) return
    if (filters.call !== 'all' && range.direction !== filters.call) return
    if (filters.pairClass !== 'all' && prediction.pairClass !== filters.pairClass) return
    if (filters.tradeOnly && ranked.decision.decision !== 'TRADE' && !heldBackByPrice(ranked.decision)) return
    if (filters.newsOnly && prediction.mainCatalyst === undefined) return
    rows.push({ rank: index + 1, ranked, prediction, horizon })
  })
  return rows
}
