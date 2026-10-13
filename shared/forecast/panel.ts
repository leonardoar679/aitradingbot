import { FORECAST_BAR_SECONDS } from './bars'
import {
  FEATURE_COUNT,
  FEATURE_NAMES,
  HORIZONS,
  HORIZON_BARS,
  MARKET_REGIMES,
  PAIR_CLASSES,
  crossSectionAt,
  endsAt,
  featuresAt,
  quickAt,
  type Horizon,
  type PairQuick,
  type PairSeries
} from './features'
import { outcomeAt } from './targets'

// THE ROWS THE FORECAST LEARNS FROM (the V6 document, §51-53; V6 Stage 5, 13 October 2026): every
// pair's row at every moment of a grid over its history, read exactly as the live forecast reads one
// (shared/forecast/features.ts), with what happened after it at each horizon (targets.ts) -- or
// nothing, where the path is not yet there or had a gap. One flat set of typed arrays: a quarter of a
// million rows of sixty-three figures fit in memory as single-precision numbers.

export interface Panel {
  rows: number
  cols: number
  /** rows x cols figures, row-major. */
  x: Float32Array
  /** The moment each row was read at, Unix seconds. */
  time: Uint32Array
  /** Each row's pair, by index into `symbols`. */
  pair: Uint16Array
  /** Each row's class and the market's regime at it, by index into PAIR_CLASSES and MARKET_REGIMES. */
  cls: Uint8Array
  regime: Uint8Array
  /** The pair's realized volatility over the day before the row: what each move is measured against. */
  rv24h: Float32Array
  /** Per horizon: the log return to the close a horizon on (NaN where none), and the path's best and worst. */
  y: Record<Horizon, Float32Array>
  best: Record<Horizon, Float32Array>
  worst: Record<Horizon, Float32Array>
  symbols: string[]
}

const RV24H = FEATURE_NAMES.indexOf('rv_24h')

/** Every row on a grid of `stepSec` (aligned to it) between `fromSec` and `toSec` (both moments the
 * rows are read at, inclusive), from the pairs' whole series. */
export function buildPanel(market: ReadonlyMap<string, PairSeries>, options: { stepSec: number; fromSec: number; toSec: number }): Panel {
  const symbols = [...market.keys()].sort()
  const btc = market.get('BTCUSDT')
  const start = Math.ceil(options.fromSec / options.stepSec) * options.stepSec
  const steps = start > options.toSec ? 0 : Math.floor((options.toSec - start) / options.stepSec) + 1
  const capacity = steps * symbols.length
  const x = new Float32Array(capacity * FEATURE_COUNT)
  const time = new Uint32Array(capacity)
  const pair = new Uint16Array(capacity)
  const cls = new Uint8Array(capacity)
  const regime = new Uint8Array(capacity)
  const rv24h = new Float32Array(capacity)
  const y = Object.fromEntries(HORIZONS.map((h) => [h, new Float32Array(capacity).fill(Number.NaN)])) as Record<Horizon, Float32Array>
  const best = Object.fromEntries(HORIZONS.map((h) => [h, new Float32Array(capacity).fill(Number.NaN)])) as Record<Horizon, Float32Array>
  const worst = Object.fromEntries(HORIZONS.map((h) => [h, new Float32Array(capacity).fill(Number.NaN)])) as Record<Horizon, Float32Array>
  let rows = 0
  if (btc !== undefined) {
    for (let step = 0; step < steps; step++) {
      const t = start + step * options.stepSec
      const quick = new Map<string, PairQuick>()
      for (const symbol of symbols) {
        const read = quickAt(market.get(symbol)!, t)
        if (read !== null) quick.set(symbol, read)
      }
      const cross = crossSectionAt(quick)
      if (cross === null) continue
      for (let index = 0; index < symbols.length; index++) {
        const symbol = symbols[index]
        const series = market.get(symbol)!
        const row = featuresAt({ symbol, series, btcH1: btc.h1, cross, tSec: t })
        if (row === null) continue
        x.set(row, rows * FEATURE_COUNT)
        time[rows] = t
        pair[rows] = index
        cls[rows] = PAIR_CLASSES.indexOf(cross.classes.get(symbol)!)
        regime[rows] = MARKET_REGIMES.indexOf(cross.regime)
        rv24h[rows] = row[RV24H]
        const at = endsAt(series, t).m5 - 1
        for (const horizon of HORIZONS) {
          const outcome = outcomeAt(series.m5, at, HORIZON_BARS[horizon])
          if (outcome === null) continue
          y[horizon][rows] = outcome.r
          best[horizon][rows] = outcome.best
          worst[horizon][rows] = outcome.worst
        }
        rows++
      }
    }
  }
  const cut = <T extends Float32Array | Uint32Array | Uint16Array | Uint8Array>(array: T, width = 1): T => array.slice(0, rows * width) as T
  return {
    rows,
    cols: FEATURE_COUNT,
    x: cut(x, FEATURE_COUNT),
    time: cut(time),
    pair: cut(pair),
    cls: cut(cls),
    regime: cut(regime),
    rv24h: cut(rv24h),
    y: Object.fromEntries(HORIZONS.map((h) => [h, cut(y[h])])) as Record<Horizon, Float32Array>,
    best: Object.fromEntries(HORIZONS.map((h) => [h, cut(best[h])])) as Record<Horizon, Float32Array>,
    worst: Object.fromEntries(HORIZONS.map((h) => [h, cut(worst[h])])) as Record<Horizon, Float32Array>,
    symbols
  }
}

/** When a row's outcome at a horizon is known: its moment and the horizon's time. */
export function outcomeKnownAt(rowTime: number, horizon: Horizon): number {
  return rowTime + HORIZON_BARS[horizon] * FORECAST_BAR_SECONDS
}
