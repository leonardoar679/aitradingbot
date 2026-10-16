import type { MarketRegime } from '../marketResearch'
import { MARKET_REGIMES, type PairSeries } from './features'
import { EXCURSION_LEVELS } from './models'
import { quantileOfSorted } from './ml/quantile'
import type { Panel } from './panel'
import { usualMove } from './targets'

// WHEN A PRICE IS REACHED, AND HOW FAR THE PATH GOES (V7.1 Stage 3, 16 October 2026). A forecast says where
// the price may close a horizon on; a person asks when it gets there, and how far it swings on the way.
//
// THE FIRST-TOUCH TABLE answers the first from the bars on file, with no model: for every moment of the
// training grid, whether the price first touched a level above the close -- k usual hourly moves
// (shared/forecast/targets.ts, usualMove over twelve bars) -- within five minutes, fifteen, an hour and
// four hours, and when it did, after how many bars; and the same below. Read at a target's distance, the
// table gives the chance it is reached within each window and the typical time when it is; under a fixed
// chance within the horizon the target is said UNLIKELY, and no time is invented. A regime has a curve of
// its own where it holds rows enough, the pooled one otherwise.
//
// THE EXCURSION CALIBRATION settles the second: the excursion models (shared/forecast/models.ts) read the
// highs the path stays under and the lows it stays above at each level, and on the walk forward's record
// each level's reading is scaled by the factor that would have had the tested paths stay inside it that
// often -- and scored, honestly, on weeks whose factors came from the weeks before alone.
//
// IT IS ARITHMETIC. No key, no model asked, no order.

export const FIRST_TOUCH_VERSION = 'first-touch-v1'
export const EXCURSION_CALIBRATION_VERSION = 'excursion-v1'

export const TOUCH_WINDOWS = ['minutes5', 'minutes15', 'hour1', 'hours4'] as const
export type TouchWindow = (typeof TOUCH_WINDOWS)[number]

export const FIRST_TOUCH = {
  /** The levels the table is read at: a target's distance in usual hourly moves. */
  levels: [0.25, 0.5, 0.75, 1, 1.5, 2, 3] as readonly number[],
  /** The windows a touch is counted within, in five-minute bars. */
  windows: { minutes5: 1, minutes15: 3, hour1: 12, hours4: 48 } as Readonly<Record<TouchWindow, number>>,
  /** Under this chance within the horizon, a target is UNLIKELY and no time is said. */
  unlikely: 0.25,
  /** Rows a regime's own curve needs; the pooled one serves below it. */
  minRows: 2000
} as const

const LONGEST = FIRST_TOUCH.windows.hours4

export interface TouchCurve {
  /** Per level, per window (TOUCH_WINDOWS' order): the share of moments whose path touched the level
   * inside that span of time. */
  within: number[][]
  /** Per level: the median bars to the first touch among the moments that touched within the longest
   * window; null where none did. */
  medianBars: (number | null)[]
}

export interface FirstTouchTable {
  version: string
  /** Moments read: those with the longest window's bars after them. */
  n: number
  up: TouchCurve
  down: TouchCurve
  byRegime: Partial<Record<MarketRegime, { n: number; up: TouchCurve; down: TouchCurve }>>
}

/** Per level, the bars to the first touch counted: index 0 for a touch on the first bar. */
class Tally {
  n = 0
  readonly touched: Uint32Array[]
  constructor() {
    this.touched = FIRST_TOUCH.levels.map(() => new Uint32Array(LONGEST))
  }
  add(bars: readonly number[]): void {
    this.n++
    bars.forEach((at, level) => {
      if (at > 0 && at <= LONGEST) this.touched[level][at - 1]++
    })
  }
  curve(): TouchCurve {
    const within = FIRST_TOUCH.levels.map((_, level) => TOUCH_WINDOWS.map((window) => (this.n === 0 ? Number.NaN : this.touched[level].slice(0, FIRST_TOUCH.windows[window]).reduce((sum, count) => sum + count, 0) / this.n)))
    const medianBars = FIRST_TOUCH.levels.map((_, level) => {
      const total = this.touched[level].reduce((sum, count) => sum + count, 0)
      if (total === 0) return null
      let seen = 0
      for (let at = 0; at < LONGEST; at++) {
        seen += this.touched[level][at]
        if (seen * 2 >= total) return at + 1
      }
      return LONGEST
    })
    return { within, medianBars }
  }
}

/** The index of the bar opened at `time` among bars oldest first; -1 without one. */
function barAt(bars: readonly { time: number }[], time: number): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (bars[middle].time < time) low = middle + 1
    else high = middle
  }
  return low < bars.length && bars[low].time === time ? low : -1
}

/** For one moment, the bars (1 for the first) to the first touch of each level above the close and below
 * it, from the bars after it (LONGEST at least); 0 where a level was not touched within them. A touch at
 * the level itself counts. */
export function touchBarsOf(close: number, usual: number, after: readonly { high: number; low: number }[]): { up: number[]; down: number[] } {
  const up = new Array<number>(FIRST_TOUCH.levels.length).fill(0)
  const down = new Array<number>(FIRST_TOUCH.levels.length).fill(0)
  let pendingUp = FIRST_TOUCH.levels.length
  let pendingDown = FIRST_TOUCH.levels.length
  for (let step = 1; step <= LONGEST && step <= after.length && (pendingUp > 0 || pendingDown > 0); step++) {
    const bar = after[step - 1]
    const rose = Math.log(bar.high / close) / usual
    const fell = -Math.log(bar.low / close) / usual
    for (let level = 0; level < FIRST_TOUCH.levels.length; level++) {
      if (up[level] === 0 && rose >= FIRST_TOUCH.levels[level]) {
        up[level] = step
        pendingUp--
      }
      if (down[level] === 0 && fell >= FIRST_TOUCH.levels[level]) {
        down[level] = step
        pendingDown--
      }
    }
  }
  return { up, down }
}

/** The table from the market's bars and the training grid's rows: each row's close, the levels about it
 * in its usual hourly move, and the bars after it. Rows without the longest window's bars are left out. */
export function firstTouchTable(market: ReadonlyMap<string, PairSeries>, panel: Panel): FirstTouchTable {
  const pooled = { up: new Tally(), down: new Tally() }
  const regimes = new Map<MarketRegime, { up: Tally; down: Tally }>()
  for (let row = 0; row < panel.rows; row++) {
    const series = market.get(panel.symbols[panel.pair[row]])
    if (series === undefined) continue
    const at = barAt(series.m5, panel.time[row] - 300)
    if (at < 0 || at + LONGEST >= series.m5.length || series.m5[at + LONGEST].time !== series.m5[at].time + LONGEST * 300) continue
    const usual = usualMove(panel.rv24h[row], 12)
    const close = series.m5[at].close
    if (!(usual > 0) || !(close > 0)) continue
    const { up: upBars, down: downBars } = touchBarsOf(close, usual, series.m5.slice(at + 1, at + 1 + LONGEST))
    pooled.up.add(upBars)
    pooled.down.add(downBars)
    const regime = MARKET_REGIMES[panel.regime[row]]
    let own = regimes.get(regime)
    if (own === undefined) {
      own = { up: new Tally(), down: new Tally() }
      regimes.set(regime, own)
    }
    own.up.add(upBars)
    own.down.add(downBars)
  }
  const byRegime: FirstTouchTable['byRegime'] = {}
  for (const [regime, own] of regimes) if (own.up.n >= FIRST_TOUCH.minRows) byRegime[regime] = { n: own.up.n, up: own.up.curve(), down: own.down.curve() }
  return { version: FIRST_TOUCH_VERSION, n: pooled.up.n, up: pooled.up.curve(), down: pooled.down.curve(), byRegime }
}

export interface Arrival {
  /** The chance the target is first touched inside each span of time (TOUCH_WINDOWS). */
  pWithin: Record<TouchWindow, number>
  /** The typical bars to the touch, among the moments it came within four hours; null where it never did. */
  medianBars: number | null
}

const lerp = (a: number, b: number, share: number): number => a + (b - a) * share

/** What the table says of a target `k` usual hourly moves above (`up`) or below the price, in the
 * regime's curve where it has one: read between the two levels about k, at the ends beyond them. */
export function arrivalOf(table: FirstTouchTable, k: number, side: 'up' | 'down', regime: MarketRegime | null = null): Arrival {
  const own = regime === null ? undefined : table.byRegime[regime]
  const curve = own === undefined ? table[side] : own[side]
  const levels = FIRST_TOUCH.levels
  const distance = Math.max(levels[0], Math.min(levels[levels.length - 1], Math.abs(k)))
  let index = 0
  while (index < levels.length - 2 && distance > levels[index + 1]) index++
  const share = (distance - levels[index]) / (levels[index + 1] - levels[index])
  const pWithin = {} as Record<TouchWindow, number>
  TOUCH_WINDOWS.forEach((window, at) => {
    pWithin[window] = lerp(curve.within[index][at], curve.within[index + 1][at], share)
  })
  const a = curve.medianBars[index]
  const b = curve.medianBars[index + 1]
  const medianBars = a === null && b === null ? null : a === null ? b : b === null ? a : lerp(a, b, share)
  return { pWithin, medianBars }
}

export interface ExcursionCalibration {
  version: string
  /** Per level: the factor the high's reading is scaled by so that the walk forward's highs stayed under
   * it that often; the low's the same. Each at least a tenth and at most ten. */
  high: number[]
  low: number[]
  /** Scored on weeks whose factors came from the weeks before alone: the share of highs under the scaled
   * level, of lows above it, per level; and the same as read, unscaled; over this many rows. */
  honest: { high: number[]; low: number[]; rawHigh: number[]; rawLow: number[]; n: number }
}

/** One tested row as the excursion calibration reads it: the path's highest high and lowest low in usual
 * moves, the models' levels, and its week. */
export interface ExcursionRow {
  best: number
  worst: number
  high: readonly number[]
  low: readonly number[]
  week: number
}

const FACTOR_FLOOR = 0.1
const FACTOR_CEILING = 10

/** The factor at a level: the quantile, at that level, of the ratio of what came to what was read. */
function factorsOf(rows: readonly ExcursionRow[]): { high: number[]; low: number[] } {
  const high = EXCURSION_LEVELS.map((level, at) => {
    const ratios = Float64Array.from(rows.filter((row) => row.high[at] > 0).map((row) => row.best / row.high[at])).sort()
    return ratios.length === 0 ? 1 : Math.min(FACTOR_CEILING, Math.max(FACTOR_FLOOR, quantileOfSorted(ratios, level)))
  })
  const low = EXCURSION_LEVELS.map((level, at) => {
    const ratios = Float64Array.from(rows.filter((row) => row.low[at] < 0).map((row) => row.worst / row.low[at])).sort()
    return ratios.length === 0 ? 1 : Math.min(FACTOR_CEILING, Math.max(FACTOR_FLOOR, quantileOfSorted(ratios, level)))
  })
  return { high, low }
}

/** The share of rows whose high stayed under each scaled level, and whose low stayed above. */
function coverageOf(rows: readonly ExcursionRow[], factors: { high: readonly number[]; low: readonly number[] }): { high: number[]; low: number[] } {
  const share = (hits: number): number => (rows.length === 0 ? Number.NaN : hits / rows.length)
  return {
    high: EXCURSION_LEVELS.map((_, at) => share(rows.filter((row) => row.best <= factors.high[at] * row.high[at]).length)),
    low: EXCURSION_LEVELS.map((_, at) => share(rows.filter((row) => row.worst >= factors.low[at] * row.low[at]).length))
  }
}

export const EXCURSION_MIN_ROWS = 500

/** The calibration from a horizon's tested rows; null under EXCURSION_MIN_ROWS of them. */
export function excursionCalibrationOf(rows: readonly ExcursionRow[]): ExcursionCalibration | null {
  const usable = rows.filter((row) => Number.isFinite(row.best) && Number.isFinite(row.worst) && row.high.every(Number.isFinite) && row.low.every(Number.isFinite))
  if (usable.length < EXCURSION_MIN_ROWS) return null
  const factors = factorsOf(usable)
  const weeks = [...new Set(usable.map((row) => row.week))].sort((a, b) => a - b)
  const scored: ExcursionRow[] = []
  const hits = { high: EXCURSION_LEVELS.map(() => 0), low: EXCURSION_LEVELS.map(() => 0), rawHigh: EXCURSION_LEVELS.map(() => 0), rawLow: EXCURSION_LEVELS.map(() => 0) }
  const ones = { high: EXCURSION_LEVELS.map(() => 1), low: EXCURSION_LEVELS.map(() => 1) }
  for (const week of weeks.slice(1)) {
    const before = usable.filter((row) => row.week < week)
    if (before.length < EXCURSION_MIN_ROWS) continue
    const earlier = factorsOf(before)
    const mine = usable.filter((row) => row.week === week)
    const scaled = coverageOf(mine, earlier)
    const raw = coverageOf(mine, ones)
    EXCURSION_LEVELS.forEach((_, at) => {
      hits.high[at] += scaled.high[at] * mine.length
      hits.low[at] += scaled.low[at] * mine.length
      hits.rawHigh[at] += raw.high[at] * mine.length
      hits.rawLow[at] += raw.low[at] * mine.length
    })
    scored.push(...mine)
  }
  const n = scored.length
  const per = (values: number[]): number[] => values.map((value) => (n === 0 ? Number.NaN : value / n))
  return { version: EXCURSION_CALIBRATION_VERSION, high: factors.high, low: factors.low, honest: { high: per(hits.high), low: per(hits.low), rawHigh: per(hits.rawHigh), rawLow: per(hits.rawLow), n } }
}
