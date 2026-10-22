import type { ForecastBar } from './bars'
import { ROUND_TRIP_PCT } from './edge'
import type { Horizon } from './features'
import type { CheckLine } from './promotion'
import { pairHalfOf } from './runCalibration'
import { BLOCK_HOURS, bootstrapOverHours, type Figure } from './uncertainty'

// THE USER'S DIRECTION HYPOTHESES, AS RULES (V7.2-R Stage 6, 22 October 2026). The forecast's ranges held and no model
// of the way beat the base rate, so the user's own ideas of where the way comes from are put to the same bar, each as a
// rule fixed here before it was measured, on a year of five-minute bars (research/fetch-forecast-archive.mjs, each
// month's pairs read from the archive itself) and judged at an hour, four hours and a day apart:
// - GAINERS: a coin among the five that rose most over the last day, at least 3%, keeps rising;
// - LEADERS: where Bitcoin and ether both moved 1% or more the same way over the last four hours, every other coin goes
//   that way;
// - CATALYST: a coin Binance's own announcement names goes the way its kind went before: down after a spot delisting or
//   a Monitoring Tag, up after a spot listing or a USDT perpetual's launch -- from the first hour's close a minute after
//   the announcement, the first an app reading the list could act at;
// - BREAKOUT: a close through the last day's high, on an hour's volume at least twice the day's usual hour and with its
//   last fifteen minutes still moving its way by at least a quarter of the hour's move, goes on that way (and the same
//   through the low);
// - RECOVERY: a coin that fell two of its usual hourly moves in the last hour comes back up.
// A rule's calls are judged by the direction bar's lines as a model's are (shared/forecast/promotion.ts), read for calls:
// at least 200 calls; the share right, its 95% interval's lower bound above an even chance; a skill -- the share right
// less the share of the month's coin-hours that went the called way, the drift a call must beat -- of a point at least,
// and above zero in both halves of the year and both halves of the pairs; and TRADEABLE where the calls' mean move in
// the way called, less the flat round trip, is above zero with its lower bound. A horizon gets a direction from a rule
// only by every line; otherwise NEUTRAL stays, with the figures.
//
// Intervals are resampled by calendar hour in blocks as long as the horizon, an hour without a call counting nothing
// (the replay's replay-v2). Arithmetic on bars and titles: no key, no model, no order.

export const HYPOTHESES_VERSION = 'hypotheses-v1'

export const HYPOTHESES = ['gainers', 'leaders', 'catalyst', 'breakout', 'recovery'] as const
export type HypothesisId = (typeof HYPOTHESES)[number]

export const HYPOTHESIS_HORIZONS = ['hour1', 'hours4', 'hours24'] as const satisfies readonly Horizon[]
export type HypothesisHorizon = (typeof HYPOTHESIS_HORIZONS)[number]
export const HYPOTHESIS_HOURS: Record<HypothesisHorizon, number> = { hour1: 1, hours4: 4, hours24: 24 }

export const HYPOTHESIS_LINES = {
  gainers: { top: 5, minPct: 3, windowHours: 24 },
  leaders: { minPct: 1, windowHours: 4, leaders: ['BTCUSDT', 'ETHUSDT'] as readonly string[] },
  /** The way each kind of announcement is called, and how long after its release the list is first read. */
  catalyst: { ways: { DELISTING: -1, MONITORING_TAG: -1, SPOT_LISTING: 1, FUTURES_LAUNCH: 1 } as Readonly<Record<string, 1 | -1>>, readAfterSec: 60 },
  breakout: { lookbackHours: 24, volumeRatio: 2, acceleration: 0.25 },
  recovery: { fallUsual: 2 },
  /** The bar a rule is judged by, at each horizon apart: the direction bar's lines for calls. */
  bar: { minCalls: 200, precisionLowerBound: 0.5, minSkill: 0.01, halvesAbove: 0, edgeAbovePct: 0, roundTripPct: ROUND_TRIP_PCT }
} as const

/** A pair's hours, oldest first, without a gap: an hour the bars do not cover is NaN throughout. */
export interface HourlySeries {
  pair: string
  /** The first hour's end, Unix seconds, on the hour. */
  start: number
  /** Each hour's close (the last five-minute bar's), high, low and quote volume; the close fifteen minutes before its
   * end; and the standard deviation of the five-minute log returns over the day to its end (NaN short of a day). */
  close: Float64Array
  high: Float64Array
  low: Float64Array
  quoteVolume: Float64Array
  close15: Float64Array
  rv5m: Float64Array
}

/** A pair's hours from its five-minute bars (oldest first): an hour is whole only with all twelve of its bars. */
export function hourlyOf(pair: string, bars: readonly ForecastBar[]): HourlySeries | null {
  if (bars.length === 0) return null
  const start = Math.ceil((bars[0].time + 300) / 3600) * 3600
  const end = Math.floor((bars[bars.length - 1].time + 300) / 3600) * 3600
  const hours = Math.max(0, Math.floor((end - start) / 3600) + 1)
  if (hours === 0) return null
  const nan = (): Float64Array => new Float64Array(hours).fill(Number.NaN)
  const series: HourlySeries = { pair, start, close: nan(), high: nan(), low: nan(), quoteVolume: nan(), close15: nan(), rv5m: nan() }
  // The bars by their slot from the start, so that a missing bar is a gap.
  const first = start - 3600
  const slots = hours * 12
  const byIndex: (ForecastBar | undefined)[] = new Array(slots)
  for (const bar of bars) {
    const at = (bar.time - first) / 300
    if (Number.isInteger(at) && at >= 0 && at < slots) byIndex[at] = bar
  }
  const logs = new Float64Array(slots).fill(Number.NaN)
  for (let at = 1; at < slots; at++) {
    const bar = byIndex[at]
    const before = byIndex[at - 1]
    if (bar !== undefined && before !== undefined && bar.close > 0 && before.close > 0) logs[at] = Math.log(bar.close / before.close)
  }
  for (let hour = 0; hour < hours; hour++) {
    let high = Number.NEGATIVE_INFINITY
    let low = Number.POSITIVE_INFINITY
    let volume = 0
    let whole = true
    for (let k = 0; k < 12; k++) {
      const bar = byIndex[hour * 12 + k]
      if (bar === undefined) {
        whole = false
        break
      }
      high = Math.max(high, bar.high)
      low = Math.min(low, bar.low)
      volume += bar.quoteVolume
    }
    if (!whole) continue
    series.close[hour] = byIndex[hour * 12 + 11]!.close
    series.high[hour] = high
    series.low[hour] = low
    series.quoteVolume[hour] = volume
    series.close15[hour] = byIndex[hour * 12 + 8]!.close
    // The day's five-minute moves to the hour's end, all of them there.
    const from = hour * 12 + 12 - 288
    if (from < 1) continue
    let sum = 0
    let squares = 0
    let n = 0
    for (let at = from; at < hour * 12 + 12; at++) {
      const value = logs[at]
      if (!Number.isFinite(value)) {
        n = -1
        break
      }
      sum += value
      squares += value * value
      n++
    }
    if (n > 1) series.rv5m[hour] = Math.sqrt(Math.max(0, (squares - (sum * sum) / n) / (n - 1)))
  }
  return series
}

/** The index of an hour's end in a series; -1 outside it. */
export function hourIndex(series: HourlySeries, t: number): number {
  const at = (t - series.start) / 3600
  return Number.isInteger(at) && at >= 0 && at < series.close.length ? at : -1
}

/** The move from an hour's close to the close `hours` on, in percent; null where either is missing. */
export function moveAfterPct(series: HourlySeries, at: number, hours: number): number | null {
  const now = series.close[at]
  const then = series.close[at + hours]
  return at >= 0 && Number.isFinite(now) && Number.isFinite(then) && now > 0 ? (then / now - 1) * 100 : null
}

const returnPct = (series: HourlySeries, at: number, back: number): number | null => {
  if (at - back < 0) return null
  const now = series.close[at]
  const then = series.close[at - back]
  return Number.isFinite(now) && Number.isFinite(then) && then > 0 ? (now / then - 1) * 100 : null
}

/** A rule's call: a pair, the hour's close it is made at, and the way. */
export interface HypothesisCall {
  pair: string
  t: number
  way: 1 | -1
}

/** GAINERS at one hour's close: the five pairs of the universe that rose most over the last day, each at least 3%. */
export function gainersAt(universe: readonly HourlySeries[], t: number): HypothesisCall[] {
  const L = HYPOTHESIS_LINES.gainers
  const rises: { pair: string; pct: number }[] = []
  for (const series of universe) {
    const pct = returnPct(series, hourIndex(series, t), L.windowHours)
    if (pct !== null) rises.push({ pair: series.pair, pct })
  }
  rises.sort((a, b) => b.pct - a.pct || a.pair.localeCompare(b.pair))
  return rises
    .slice(0, L.top)
    .filter((entry) => entry.pct >= L.minPct)
    .map((entry) => ({ pair: entry.pair, t, way: 1 }))
}

/** LEADERS at one hour's close: Bitcoin and ether both 1% or more the same way over the last four hours, every other
 * pair of the universe called that way. */
export function leadersAt(universe: readonly HourlySeries[], t: number): HypothesisCall[] {
  const L = HYPOTHESIS_LINES.leaders
  const moves = L.leaders.map((pair) => {
    const series = universe.find((entry) => entry.pair === pair)
    return series === undefined ? null : returnPct(series, hourIndex(series, t), L.windowHours)
  })
  if (moves.some((move) => move === null)) return []
  const way = moves.every((move) => move! >= L.minPct) ? 1 : moves.every((move) => move! <= -L.minPct) ? -1 : 0
  if (way === 0) return []
  return universe.filter((series) => !L.leaders.includes(series.pair) && Number.isFinite(series.close[hourIndex(series, t)])).map((series) => ({ pair: series.pair, t, way: way as 1 | -1 }))
}

/** BREAKOUT at one hour's close of a pair: through the last day's high (low) on twice the day's usual hour's volume, its
 * last fifteen minutes still going its way by a quarter of the hour's move; null where it is none. */
export function breakoutAt(series: HourlySeries, t: number): HypothesisCall | null {
  const L = HYPOTHESIS_LINES.breakout
  const at = hourIndex(series, t)
  if (at < L.lookbackHours) return null
  const close = series.close[at]
  const before = series.close[at - 1]
  const close15 = series.close15[at]
  if (!Number.isFinite(close) || !Number.isFinite(before) || !Number.isFinite(close15) || !(before > 0) || !(close15 > 0)) return null
  let high = Number.NEGATIVE_INFINITY
  let low = Number.POSITIVE_INFINITY
  let volume = 0
  for (let hour = at - L.lookbackHours; hour < at; hour++) {
    if (!Number.isFinite(series.high[hour])) return null
    high = Math.max(high, series.high[hour])
    low = Math.min(low, series.low[hour])
    volume += series.quoteVolume[hour]
  }
  const usual = volume / L.lookbackHours
  if (!(usual > 0) || !(series.quoteVolume[at] >= L.volumeRatio * usual)) return null
  const hourMove = close / before - 1
  const lastMove = close / close15 - 1
  if (close > high && hourMove > 0 && lastMove >= L.acceleration * hourMove) return { pair: series.pair, t, way: 1 }
  if (close < low && hourMove < 0 && lastMove <= L.acceleration * hourMove) return { pair: series.pair, t, way: -1 }
  return null
}

/** RECOVERY at one hour's close of a pair: a fall over the last hour of two usual hourly moves (the day's five-minute
 * volatility, scaled to an hour) or more, called up; null where it is none. */
export function recoveryAt(series: HourlySeries, t: number): HypothesisCall | null {
  const at = hourIndex(series, t)
  if (at < 1) return null
  const close = series.close[at]
  const before = series.close[at - 1]
  const rv = series.rv5m[at]
  if (!Number.isFinite(close) || !Number.isFinite(before) || !(before > 0) || !(close > 0) || !Number.isFinite(rv) || !(rv > 0)) return null
  return Math.log(close / before) <= -HYPOTHESIS_LINES.recovery.fallUsual * rv * Math.sqrt(12) ? { pair: series.pair, t, way: 1 } : null
}

/** CATALYST: an announcement's call for a coin it names, at the first hour's close a minute after its release. */
export function catalystCall(pair: string, category: string, releaseSec: number): HypothesisCall | null {
  const way = HYPOTHESIS_LINES.catalyst.ways[category]
  if (way === undefined) return null
  return { pair, t: Math.ceil((releaseSec + HYPOTHESIS_LINES.catalyst.readAfterSec) / 3600) * 3600, way }
}

/** A call judged at a horizon: its move in the way called, whether it went that way, and the month's base rate of it. */
export interface JudgedCall extends HypothesisCall {
  movePct: number
  /** The share of the month's coin-hours whose move at the horizon went the way called. */
  base: number
}

/** The month's base rates at a horizon: the share of every coin-hour that went up and down. */
export interface MonthBase {
  up: number
  down: number
  n: number
}

export const monthOf = (t: number): string => new Date(t * 1000).toISOString().slice(0, 7)

export interface HypothesisFigures {
  hypothesis: HypothesisId
  horizon: HypothesisHorizon
  calls: number
  /** The share of calls the move went the way of, the skill over the month's base rate, and the mean move in the way
   * called less the round trip, in percent; each with its interval. */
  precision: Figure | null
  skill: Figure | null
  edgePct: Figure | null
  /** The skill in the year's two halves and the pairs' two (pairHalfOf); null where a half holds no call. */
  halves: { year: [number | null, number | null]; pairs: [number | null, number | null] }
  lines: CheckLine[]
  promoted: boolean
  tradeable: boolean
  /** The calls of each month, and their mean move in the way called. */
  byMonth: Record<string, { calls: number; meanMovePct: number }>
}

/** A rule's calls at one horizon against the bar. `split` is the moment the year is halved at. */
export function hypothesisFiguresOf(hypothesis: HypothesisId, horizon: HypothesisHorizon, calls: readonly JudgedCall[], split: number): HypothesisFigures {
  const L = HYPOTHESIS_LINES.bar
  const correct = (call: JudgedCall): number => (call.way * call.movePct > 0 ? 1 : 0)
  const skillOf = (mine: readonly JudgedCall[]): number | null => (mine.length === 0 ? null : mine.reduce((sum, call) => sum + correct(call) - call.base, 0) / mine.length)
  let precision: Figure | null = null
  let skill: Figure | null = null
  let edgePct: Figure | null = null
  if (calls.length > 0) {
    let first = Number.POSITIVE_INFINITY
    let last = Number.NEGATIVE_INFINITY
    const samples: { hour: number; sample: number[] }[] = []
    for (const call of calls) {
      const hour = Math.floor(call.t / 3600)
      first = Math.min(first, hour)
      last = Math.max(last, hour)
      samples.push({ hour, sample: [correct(call), call.base, call.way * call.movePct - L.roundTripPct, 1] })
    }
    for (let hour = first; hour <= last; hour++) samples.push({ hour, sample: [0, 0, 0, 0] })
    const of = (k: number, minus?: number) => (sums: Float64Array): number => (sums[3] > 0 ? (sums[k] - (minus === undefined ? 0 : sums[minus])) / sums[3] : Number.NaN)
    const made = bootstrapOverHours(samples, [of(0), of(0, 1), of(2)], BLOCK_HOURS[horizon])
    if (made !== null) [precision, skill, edgePct] = made.figures
  }
  const halves = {
    year: [skillOf(calls.filter((call) => call.t < split)), skillOf(calls.filter((call) => call.t >= split))] as [number | null, number | null],
    pairs: [skillOf(calls.filter((call) => pairHalfOf(call.pair) === 0)), skillOf(calls.filter((call) => pairHalfOf(call.pair) === 1))] as [number | null, number | null]
  }
  const halvesRead = [...halves.year, ...halves.pairs].every((value) => value !== null)
  const pct = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(digits)}%`)
  const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`
  const lines: CheckLine[] = [
    { id: 'calls', ok: calls.length >= L.minCalls, text: `${calls.length} calls (${L.minCalls} needed)` },
    precision === null
      ? { id: 'precision', ok: null, text: "the calls' precision has no interval: not read" }
      : { id: 'precision', ok: precision.low > L.precisionLowerBound, text: `${pct(precision.value, 1)} of the calls right, at least ${pct(precision.low, 1)} (above ${pct(L.precisionLowerBound, 0)} needed)` },
    skill === null ? { id: 'skill', ok: null, text: 'no skill read' } : { id: 'skill', ok: skill.value >= L.minSkill, text: `a skill of ${pct(skill.value)} over the month's base rate (${pct(L.minSkill)} needed)` },
    halvesRead
      ? {
          id: 'halves',
          ok: [...halves.year, ...halves.pairs].every((value) => value! > L.halvesAbove),
          text: `skill ${pct(halves.year[0])} and ${pct(halves.year[1])} in the year's two halves, ${pct(halves.pairs[0])} and ${pct(halves.pairs[1])} in the pairs' (each above zero needed)`
        }
      : { id: 'halves', ok: null, text: 'a half of the year or of the pairs holds no call: not read' },
    edgePct === null
      ? { id: 'edge', ok: null, text: "the calls' moves less the round trip have no interval: not read" }
      : { id: 'edge', ok: edgePct.value > L.edgeAbovePct && edgePct.low > L.edgeAbovePct, text: `the calls' mean move in the way called, less the round trip, ${signed(edgePct.value)} [${signed(edgePct.low)}, ${signed(edgePct.high)}] (above zero with its lower bound needed)` }
  ]
  const promoted = lines.filter((line) => line.id !== 'edge').every((line) => line.ok === true)
  const tradeable = promoted && lines.find((line) => line.id === 'edge')!.ok === true
  const byMonth: HypothesisFigures['byMonth'] = {}
  for (const call of calls) {
    const mine = byMonth[monthOf(call.t)] ?? (byMonth[monthOf(call.t)] = { calls: 0, meanMovePct: 0 })
    mine.calls++
    mine.meanMovePct += call.way * call.movePct
  }
  for (const mine of Object.values(byMonth)) mine.meanMovePct /= mine.calls
  return { hypothesis, horizon, calls: calls.length, precision, skill, edgePct, halves, lines, promoted, tradeable, byMonth }
}
