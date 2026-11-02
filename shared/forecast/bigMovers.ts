import { SOURCE_RECORD_VERSION, hourUnitOf, sourcePredictionId, type SourcePrediction } from '../evaluation/predictionRecord'
import type { ForecastBar } from './bars'
import type { Horizon } from './features'
import { ratesAt, type MoveRates } from './moveRates'
import type { PricePrediction } from './prediction'

// THE BIG MOVERS (V8 Stage 10, 27 October 2026; V8-R1-SIZE, registered 26 October). Which coins are most likely to move
// a size worth trading -- 1% within an hour, 2% within four, 5% within a day, either way -- said as size alone: no
// side. V8-R1-SIZE's registration sets how the list is ranked: by the first of its rankers that passes at a horizon,
// and by the coin's own ninety-day rates (shared/forecast/moveRates.ts) where none does, saying so. None has been
// measured yet, so every horizon is ranked by the ninety-day rates. Each hour the list's entries are recorded as size
// calls of the source 'big-movers' (shared/evaluation/predictionRecord.ts) and scored like every other source. Beside
// it, for the Forecast Lab, the share of days that closed 5% and 10% away over the same ninety days: the moves studied
// apart. Arithmetic: no key, no model, no order.

export type BigMoverHorizon = 'hour1' | 'hours4' | 'hours24'

export const BIG_MOVERS_LINES = {
  version: 'big-movers-v1',
  /** The ranker each horizon is read by until one of V8-R1-SIZE's passes there. */
  ranker: 'move-rates-90d',
  /** Coins listed a horizon. */
  listed: 5,
  /** V8-R1-SIZE's targets: the size a horizon's list is about, in percent either way, and the horizon in seconds. */
  horizons: { hour1: { sizePct: 1, sec: 3600 }, hours4: { sizePct: 2, sec: 4 * 3600 }, hours24: { sizePct: 5, sec: 86_400 } },
  /** The Forecast Lab's list: a day's close at least this far away, either way, over the rates' ninety days. */
  dayMovesPct: [5, 10],
  dayMoveDays: 90
} as const

export const BIG_MOVER_HORIZONS: readonly BigMoverHorizon[] = ['hour1', 'hours4', 'hours24']

export interface BigMover {
  pair: string
  horizon: BigMoverHorizon
  sizePct: number
  /** The share of the coin's moments over ninety days whose close at the horizon was at least the size away. */
  rate: number
  /** The forecast's price at its close. */
  price: number
}

/** The list at each horizon: the pairs whose close moved the horizon's size most often over their ninety days, the
 * most often first, the pair's name breaking ties. */
export function bigMoversOf(predictions: readonly Pick<PricePrediction, 'pair' | 'moveRates' | 'currentPrice'>[], lines = BIG_MOVERS_LINES): Record<BigMoverHorizon, BigMover[]> {
  const out = { hour1: [], hours4: [], hours24: [] } as Record<BigMoverHorizon, BigMover[]>
  for (const horizon of BIG_MOVER_HORIZONS) {
    const sizePct = lines.horizons[horizon].sizePct
    const rows: BigMover[] = []
    for (const prediction of predictions) {
      const rate = rateAt(prediction.moveRates, horizon, sizePct)
      if (rate === null || !(prediction.currentPrice > 0)) continue
      rows.push({ pair: prediction.pair, horizon, sizePct, rate, price: prediction.currentPrice })
    }
    out[horizon] = rows.sort((a, b) => b.rate - a.rate || a.pair.localeCompare(b.pair)).slice(0, lines.listed)
  }
  return out
}

/** A coin's ninety-day rate of a close at least `sizePct` away at a horizon, either way; null where not read. */
function rateAt(rates: MoveRates | null | undefined, horizon: Horizon, sizePct: number): number | null {
  const close = ratesAt(rates, horizon)?.close.find((rate) => rate.pct === sizePct)
  return close === undefined || !Number.isFinite(close.either) ? null : close.either
}

/** The list's entries made at `madeAt` as size calls: each the horizon's size either way, its rate as its chance. */
export function bigMoverPredictionsOf(lists: Record<BigMoverHorizon, BigMover[]>, madeAt: number, versions: { engine: string; config: string }, lines = BIG_MOVERS_LINES): SourcePrediction[] {
  const out: SourcePrediction[] = []
  for (const [seq, horizon] of BIG_MOVER_HORIZONS.entries()) {
    for (const entry of lists[horizon]) {
      out.push({
        v: SOURCE_RECORD_VERSION,
        id: sourcePredictionId('big-movers', entry.pair, madeAt, seq + 1),
        source: 'big-movers',
        sourceVersion: `${lines.version}@${lines.ranker}`,
        kind: 'size',
        pair: entry.pair,
        venue: 'binance',
        madeAt,
        bar: madeAt,
        horizonSec: lines.horizons[horizon].sec,
        refPrice: entry.price,
        side: null,
        movePct: entry.sizePct,
        targetPrice: null,
        window: { fromSec: 0, toSec: lines.horizons[horizon].sec },
        dist: { pRight: null, q: null, pMove: null },
        scenarios: null,
        cost: null,
        expectedNet: null,
        reason: `ranked by its ninety-day rate of a close ${entry.sizePct}% away either way: ${(entry.rate * 100).toFixed(1)}%`,
        evidence: [`move-rates:${entry.pair}`],
        unit: hourUnitOf(madeAt),
        versions
      })
    }
  }
  return out
}

/** A coin's day moves: the hours read, and at each size the share whose close a day later was that far away. */
export interface DayMoveRates {
  moments: number
  rates: Record<number, number>
}

/** A coin's share of hours, over the days given, whose close a day later was at least each size away, either way;
 * null where under thirty days of hours are on file. Read at each hour's close, as the ninety-day rates are. */
export function dayMoveRatesOf(bars: readonly ForecastBar[], atSec: number, lines = BIG_MOVERS_LINES): DayMoveRates | null {
  const BAR_SEC = 300
  const DAY_BARS = 288
  const fromSec = atSec - lines.dayMoveDays * 86_400
  const hits = lines.dayMovesPct.map(() => 0)
  let moments = 0
  for (let at = 0; at + DAY_BARS < bars.length; at++) {
    const bar = bars[at]
    const closeSec = bar.time + BAR_SEC
    if (closeSec % 3600 !== 0 || closeSec < fromSec) continue
    const later = bars[at + DAY_BARS]
    // The bar a day on must be the one closing a day later: a gap in the bars is not a day.
    if (later.time + BAR_SEC !== closeSec + 86_400 || later.time + BAR_SEC > atSec) continue
    if (!(bar.close > 0) || !(later.close > 0)) continue
    moments++
    const move = Math.abs(later.close / bar.close - 1) * 100
    lines.dayMovesPct.forEach((pct, k) => {
      if (move >= pct) hits[k]++
    })
  }
  if (moments < 30 * 24) return null
  return { moments, rates: Object.fromEntries(lines.dayMovesPct.map((pct, k) => [pct, hits[k] / moments])) }
}
