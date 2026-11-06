import { SOURCE_RECORD_VERSION, hourUnitOf, sourcePredictionId, type SourcePrediction } from '../evaluation/predictionRecord'
import type { ForecastBar } from './bars'
import type { Horizon } from './features'
import { ratesAt, type MoveRates } from './moveRates'
import type { PricePrediction } from './prediction'

// THE BIG MOVERS (V8 Stage 10, 27 October 2026; V8-R1-SIZE, registered 26 October). Which coins are most likely to move
// a size worth trading -- 1% within an hour, 2% within four, 5% within a day, either way -- said as size alone: no
// side. V8-R1-SIZE's registration sets how the list is ranked: by the first of its rankers that passes at a horizon,
// and by the coin's own ninety-day rates (shared/forecast/moveRates.ts) where none does, saying so. None passed on March
// to September 2026. V9-SIZE-RANK (6 November 2026) asked the forecast's shown P10-P90 width again on the year before,
// October 2024 to September 2025, which no ranking had been measured on: at an hour it ranked the coins that moved 1%
// better than their rates (Brier skill +8.6%, its top tenth moving 1.33 times as often as the rates' top tenth); at four
// hours and a day it did not. So the hour's list is ranked by the width, and the others by the rates; the chance each
// entry shows is its ninety-day rate either way. Each hour the list's entries are recorded as size
// calls of the source 'big-movers' (shared/evaluation/predictionRecord.ts) and scored like every other source. Beside
// it, for the Forecast Lab, the share of days that closed 5% and 10% away over the same ninety days: the moves studied
// apart. Arithmetic: no key, no model, no order.

export type BigMoverHorizon = 'hour1' | 'hours4' | 'hours24'

/** How a horizon's list is ranked: by the coin's ninety-day rate of the move, or by the forecast's shown P10-P90 width. */
export type BigMoverRanker = 'move-rates-90d' | 'width-p10-p90'

export const BIG_MOVERS_LINES = {
  version: 'big-movers-v2',
  /** The ranker each horizon is read by: the width where V9-SIZE-RANK passed, the ninety-day rate elsewhere. */
  rankers: { hour1: 'width-p10-p90', hours4: 'move-rates-90d', hours24: 'move-rates-90d' } as Readonly<Record<BigMoverHorizon, BigMoverRanker>>,
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
  /** The forecast's shown P10-P90 width at the horizon, in percent; null where it has none. */
  widthPct: number | null
  /** The forecast's price at its close. */
  price: number
}

/** The list at each horizon: the pairs ranked by the horizon's ranker -- the widest shown range first, or the move most
 * often over their ninety days first -- the pair's name breaking ties. A pair the ranker cannot read is left out. */
export function bigMoversOf(predictions: readonly Pick<PricePrediction, 'pair' | 'moveRates' | 'currentPrice' | 'horizons'>[], lines = BIG_MOVERS_LINES): Record<BigMoverHorizon, BigMover[]> {
  const out = { hour1: [], hours4: [], hours24: [] } as Record<BigMoverHorizon, BigMover[]>
  for (const horizon of BIG_MOVER_HORIZONS) {
    const sizePct = lines.horizons[horizon].sizePct
    const byWidth = lines.rankers[horizon] === 'width-p10-p90'
    const rows: BigMover[] = []
    for (const prediction of predictions) {
      const rate = rateAt(prediction.moveRates, horizon, sizePct)
      const width = prediction.horizons?.[horizon]?.width80Pct
      const widthPct = typeof width === 'number' && Number.isFinite(width) ? width : null
      if (rate === null || !(prediction.currentPrice > 0) || (byWidth && widthPct === null)) continue
      rows.push({ pair: prediction.pair, horizon, sizePct, rate, widthPct, price: prediction.currentPrice })
    }
    const key = (row: BigMover): number => (byWidth ? (row.widthPct as number) : row.rate)
    out[horizon] = rows.sort((a, b) => key(b) - key(a) || a.pair.localeCompare(b.pair)).slice(0, lines.listed)
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
        sourceVersion: `${lines.version}@${lines.rankers[horizon]}`,
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
        reason:
          lines.rankers[horizon] === 'width-p10-p90' && entry.widthPct !== null
            ? `ranked by the forecast's P10-P90 width, ${entry.widthPct.toFixed(2)}%; its ninety-day rate of a close ${entry.sizePct}% away either way: ${(entry.rate * 100).toFixed(1)}%`
            : `ranked by its ninety-day rate of a close ${entry.sizePct}% away either way: ${(entry.rate * 100).toFixed(1)}%`,
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
