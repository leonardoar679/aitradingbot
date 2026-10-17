import type { Horizon } from './features'
import type { MarketShockState } from './marketShock'
import { QUANTILE_LEVELS, meanPinball } from './ml/quantile'
import { pairHalfOf, type ScoredRow } from './runCalibration'

// THE CLOCK AS A DIAGNOSTIC (V7.2 Stage 4, 17 October 2026). The rows carry the hour of the day and the day
// of the week as figures (hour_sin, hour_cos, dow_sin, dow_cos), and the usual move a forecast is scaled by
// knows nothing of the clock: whether the forecast's range holds 80% at every hour of the day, or runs
// too wide in the quiet hours and too narrow at the open of New York, is a question the record answers.
// This reads the forecast shown (V2, scored out of sample as the app scores it) by the UTC hour it was made
// at, in 24 bands, and by the day of the week: how the 80% and 50% ranges held, the pinball loss, the
// outcomes, the dispersion the coverage implies -- the ratio of the true spread to the forecast's, 1.2816
// over the normal quantile at (1 + coverage) / 2, 1 where 80% held exactly -- and, of the outcomes outside
// the 80% range, the share that fell in a shock state. Each band is read in four halves -- the two halves
// of the pairs (by the fixed hash of their names) against the first weeks and the last -- because three
// tested weeks hold about three of each weekday, and a band is called FAILING only where its 80% coverage
// is under 70% or over 90% in all four halves with at least 500 outcomes each: the four-halves rule is the
// guard against twenty-four bands tried at once. Rows forecast before a scheduled release (PRE_EVENT) are
// left out. The weekday is reported and never acted on. Arithmetic on the record: no key, no order.

export const BY_HOUR_VERSION = 'by-hour-v1'

export const BY_HOUR_LINES = {
  /** The outcomes a half of a band needs before it may fail the band. */
  minCell: 500,
  /** A band fails where its 80% coverage is under this, or over `high`, in all four halves. */
  low: 0.7,
  high: 0.9
} as const

export interface HourCell {
  n: number
  coverage80: number
  coverage50: number
  pinball: number
  /** The ratio of the true spread to the forecast's that the 80% coverage implies: 1 where 80% held. */
  dispersion: number
  /** Of the outcomes outside the 80% range, the share forecast in a shock state; null where none missed or
   * the record holds no states. */
  missesInShock: number | null
}

export interface HourBand {
  /** The UTC hour of the day, 0-23. */
  hour: number
  pooled: HourCell
  /** Pairs' first half x first weeks, first half x last weeks, second half x first weeks, second half x last weeks. */
  halves: [HourCell | null, HourCell | null, HourCell | null, HourCell | null]
  failing: boolean
}

export interface ByHourReport {
  version: string
  horizon: Horizon
  /** Rows read; rows left out as forecast before a release. */
  rows: number
  preEventOut: number
  /** The weeks the first half of the weeks holds. */
  firstWeeks: number[]
  hours: HourBand[]
  /** The UTC day of the week, 0 Sunday to 6 Saturday. */
  weekdays: { day: number; pooled: HourCell }[]
  /** The bands that fail the line, by hour. */
  failing: number[]
}

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P25 = QUANTILE_LEVELS.indexOf(0.25)
const P75 = QUANTILE_LEVELS.indexOf(0.75)
const P90 = QUANTILE_LEVELS.indexOf(0.9)
/** The standard normal's 90th percentile: where the 80% range's edges sit on a forecast that is right. */
const Z80 = 1.2815515655446004

/** The standard normal's quantile function (Acklam's algorithm, a relative error under 1.2e-9 everywhere). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? Number.NEGATIVE_INFINITY : p >= 1 ? Number.POSITIVE_INFINITY : Number.NaN
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** The ratio of the true spread to the forecast's that a coverage of the 80% range implies. */
export function dispersionOf(coverage80: number): number {
  if (!(coverage80 > 0 && coverage80 < 1)) return coverage80 >= 1 ? 0 : Number.NaN
  return Z80 / normalQuantile(0.5 + coverage80 / 2)
}

interface Sums {
  n: number
  in80: number
  in50: number
  pinball: number
  missed: number
  missedInShock: number
  states: number
}

const empty = (): Sums => ({ n: 0, in80: 0, in50: 0, pinball: 0, missed: 0, missedInShock: 0, states: 0 })

function cellOf(sums: Sums): HourCell | null {
  if (sums.n === 0) return null
  const coverage80 = sums.in80 / sums.n
  return {
    n: sums.n,
    coverage80,
    coverage50: sums.in50 / sums.n,
    pinball: sums.pinball / sums.n,
    dispersion: dispersionOf(coverage80),
    missesInShock: sums.missed > 0 && sums.states > 0 ? sums.missedInShock / sums.missed : null
  }
}

/** The UTC hour of the day a moment falls in. */
export const hourOfDay = (seconds: number): number => Math.floor(seconds / 3600) % 24
/** The UTC day of the week, 0 Sunday to 6 Saturday. */
export const dayOfWeek = (seconds: number): number => (Math.floor(seconds / 86_400) + 4) % 7

/** The forecast shown by the hour it was made at and the day of the week, with the four halves and the
 * failing bands. `stateOf` gives each row's market state where the record holds one (undefined where not). */
export function byHourOf(shown: readonly ScoredRow[], horizon: Horizon, stateOf: (entry: ScoredRow) => MarketShockState | undefined, lines: typeof BY_HOUR_LINES = BY_HOUR_LINES): ByHourReport {
  const weeks = [...new Set(shown.map((entry) => entry.week))].sort((a, b) => a - b)
  const firstWeeks = weeks.slice(0, Math.ceil(weeks.length / 2))
  const first = new Set(firstWeeks)
  const hours = Array.from({ length: 24 }, () => ({ pooled: empty(), halves: [empty(), empty(), empty(), empty()] }))
  const days = Array.from({ length: 7 }, () => empty())
  let rows = 0
  let preEventOut = 0
  for (const entry of shown) {
    if (entry.t === undefined) continue
    const state = stateOf(entry)
    if (state === 'PRE_EVENT') {
      preEventOut++
      continue
    }
    rows++
    const q = entry.quantiles
    const in80 = entry.z >= q[P10] && entry.z <= q[P90] ? 1 : 0
    const in50 = entry.z >= q[P25] && entry.z <= q[P75] ? 1 : 0
    const loss = meanPinball(entry.z, q)
    const add = (sums: Sums): void => {
      sums.n++
      sums.in80 += in80
      sums.in50 += in50
      sums.pinball += loss
      if (state !== undefined) sums.states++
      if (in80 === 0) {
        sums.missed++
        if (state !== undefined && state !== 'NORMAL') sums.missedInShock++
      }
    }
    const band = hours[hourOfDay(entry.t)]
    add(band.pooled)
    if (entry.pair !== undefined) add(band.halves[pairHalfOf(entry.pair) * 2 + (first.has(entry.week) ? 0 : 1)])
    add(days[dayOfWeek(entry.t)])
  }
  const bands: HourBand[] = hours.map((band, hour) => {
    const halves = band.halves.map(cellOf) as HourBand['halves']
    const read = halves.every((cell) => cell !== null && cell.n >= lines.minCell)
    const failing = read && (halves.every((cell) => cell!.coverage80 < lines.low) || halves.every((cell) => cell!.coverage80 > lines.high))
    return { hour, pooled: cellOf(band.pooled) ?? { n: 0, coverage80: Number.NaN, coverage50: Number.NaN, pinball: Number.NaN, dispersion: Number.NaN, missesInShock: null }, halves, failing }
  })
  return {
    version: BY_HOUR_VERSION,
    horizon,
    rows,
    preEventOut,
    firstWeeks,
    hours: bands,
    weekdays: days.map((sums, day) => ({ day, pooled: cellOf(sums) })).filter((entry): entry is { day: number; pooled: HourCell } => entry.pooled !== null),
    failing: bands.filter((band) => band.failing).map((band) => band.hour)
  }
}
