import type { Direction } from './direction'
import { edgeOf, ROUND_TRIP_PCT } from './edge'
import type { MemberWeight } from './ensemble'
import { HORIZON_BARS, type Horizon, type PairClass } from './features'
import type { HorizonLine, OutcomeLine, PredictionLine } from './forecastRecord'
import { MARKET_SHOCK_STATES, type MarketShockState } from './marketShock'
import { QUANTILE_LEVELS, meanPinball } from './ml/quantile'
import type { ForecastModelId } from './models'
import { errorsOf, insideOf, type ErrorKind } from './outcome'
import { classKeyOf, setupOf } from './opportunityClass'
import type { CheckLine } from './promotion'
import type { MarketRegime } from '../marketResearch'
import type { Promotion } from './training'
import { DECISION_LINES } from './tradeDecision'
import { SHARE, blockHoursOf, bootstrapOverHours, effectiveSampleSize, hourOf, intervalOf, shareVariance, type HourSample, type Interval, type Statistic } from './uncertainty'
import type { ModelScore } from './walkForward'

// THE FORECAST LAB'S ARITHMETIC (the V6 document, §27-28, §42-43, §49-50, §90-98 and §100-105; V6 Stage 11,
// 13 October 2026). Two records are read, each said as which on the page:
// - THE WALK FORWARD's: every pair's hourly forecast of the weeks tested, each forecast with models and
//   a calibration made only from the weeks before it (shared/forecast/runCalibration.ts), so nothing in
//   it knew its outcome. Price and technical figures only: it holds no news.
// - THE LIVE RECORD's: the forecasts the app made and recorded (forecasts/), with their outcomes, where
//   the news and the analyst's readings moved them (V3, V4).
//
// For each, by horizon, variant and class: the share of moves whose way the median called, the calls
// and how many were right, the 50% and 80% ranges' coverage, the error of the median (MAE, RMSE, its
// bias), the pinball loss and, on the walk forward, its skill over persistence, the 80% range's width,
// the share at or below each level against its nominal (the calibration curve) and the tails; the
// kinds of error of §43 with EARLY, which needs the path past the horizon; and drift (§42): how a
// forecast behaved after a shock -- over-reacting when it followed an hour's shock that then turned,
// under-reacting when it leaned against one that went on past its likely range.
//
// THE FORECAST TRADER (§97) turns forecasts into trades as the rules stand -- a called way, an edge
// after a round trip's cost, a profit likelier than 55 in a hundred, a range not too wide -- entered at
// the close, stopped at the P10 level (P90 for a sell), taken at P75 (P25), else out at the horizon's
// close; one open trade a pair at a time; when the path touched both the stop and the target the stop
// is taken, the path's order within the horizon being unknown. Beside it, for research only, the same
// trader on the median alone where it clears the round trip, with no direction gate. Everything is
// net of the round trip's 0.24% (fees and slippage); a sell is a paper short.

export const LAB_VERSION = 'forecast-lab-v2'

export const LAB_LINES = {
  /** An hour's move of this many usual moves before a forecast is a shock: a pump, or a dump. */
  shock: 2,
  /** A story published this long before a forecast counts for it. */
  storySeconds: 14_400,
  /** Trades kept a horizon and rule, for the hybrid. */
  tradesKept: 5000,
  /** The days of the live record the Lab reads. */
  liveDays: 7
} as const

export const LAB_EVENTS = ['all', 'pump', 'dump', 'breakout', 'news', 'listing', 'hack', 'etf', 'macro'] as const
export type LabEvent = (typeof LAB_EVENTS)[number]

/** The story kinds behind each news event. */
const KIND_EVENTS: Readonly<Record<string, LabEvent>> = { LISTING: 'listing', HACK: 'hack', EXPLOIT: 'hack', ETF: 'etf', MACRO: 'macro' }

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P25 = QUANTILE_LEVELS.indexOf(0.25)
const P50 = QUANTILE_LEVELS.indexOf(0.5)
const P75 = QUANTILE_LEVELS.indexOf(0.75)
const P90 = QUANTILE_LEVELS.indexOf(0.9)

/** One forecast at one horizon and what came, in percent. */
export interface LabCase {
  pair: string
  /** Unix seconds: the close it was read at. */
  t: number
  horizon: Horizon
  cls: PairClass
  /** Its five levels as moves; the call it made; its P(up), null before one was mapped. */
  q: readonly number[]
  dir: Direction
  pUp: number | null
  uncertain: boolean
  width: number
  usualWidth: number
  /** The move to the horizon's close, the path's best and worst on the way. */
  move: number
  best: number
  worst: number
  /** The move to twice the horizon, where the bars hold it: what EARLY reads. */
  after?: number | null
  /** The hour before it, in usual moves; whether its close broke the day's range. */
  prior?: number | null
  breakout?: boolean
  /** What a story moved its median by, and the kinds of the coin's stories before it. */
  newsShift?: number
  kinds?: readonly string[]
  /** The market's regime at it (V6 Stage 12): a trade's setup reads it. */
  regime?: MarketRegime | null
  /** Whether Bitcoin's sharp move widened the forecast shown (V6.1). */
  shock?: boolean
  /** The market's shock state at the forecast (V7.1 Stage 11), where its line carried one. */
  state?: MarketShockState
  /** Its pinball loss in usual moves, and persistence's on the same outcome (the walk forward). */
  pinballZ?: number
  floorPinballZ?: number
}

export type LabErrorKind = ErrorKind | 'EARLY'

export interface LabMetrics {
  n: number
  /** Of the moves that moved where the median was not zero, the share whose way the median called. */
  direction: number | null
  /** The forecasts that called a way, and the share of them that were right. */
  calls: number
  callsRight: number | null
  coverage50: number | null
  coverage80: number | null
  /** The median's error, in percent: mean absolute, root mean square, and the mean of move less median. */
  mae: number | null
  rmse: number | null
  bias: number | null
  /** Mean pinball loss over the five levels, in percent; and, where every case has persistence's in
   * usual moves, 1 less the forecast's over persistence's. */
  pinball: number | null
  skill: number | null
  width80: number | null
  /** The share of outcomes at or below each level, against 10, 25, 50, 75 and 90%. */
  levels: (number | null)[]
  tailLow: number | null
  tailHigh: number | null
  errors: Partial<Record<LabErrorKind, number>>
  /** The 95% intervals of the coverage, the skill and the calls right (V7.2 Stage 1), resampled by the hour
   * the cases were read at in blocks as long as their horizon; the independent outcomes the 80% coverage
   * rests on; the blocks a resample drew. Absent on cases of one block, or none. */
  ci?: LabInterval
  nEff?: number | null
  blocks?: number
}

export interface LabInterval {
  coverage80: Interval | null
  coverage50: Interval | null
  skill: Interval | null
  callsRight: Interval | null
}

/** EARLY: a call whose move had not come by the horizon's close and came by twice the horizon. */
export function isEarly(entry: Pick<LabCase, 'dir' | 'q' | 'move' | 'after'>): boolean {
  if (entry.after === undefined || entry.after === null) return false
  const median = entry.q[P50]
  if (entry.dir === 'BULLISH') return entry.move < median && entry.after >= median
  if (entry.dir === 'BEARISH') return entry.move > median && entry.after <= median
  return false
}

/** The kinds of error a case made: §43's, with EARLY. */
export function errorsOfCase(entry: LabCase): LabErrorKind[] {
  const kinds: LabErrorKind[] = errorsOf(
    { horizon: entry.horizon, quantilesPct: entry.q, pUp: entry.pUp ?? 0.5, direction: entry.dir, width80Pct: entry.width, usualWidth80Pct: entry.usualWidth, newsShiftPct: entry.newsShift },
    entry.move,
    entry.best,
    entry.worst
  )
  if (isEarly(entry)) kinds.push('EARLY')
  return kinds
}

const share = (count: number, over: number): number | null => (over > 0 ? count / over : null)

export function labMetrics(cases: readonly LabCase[]): LabMetrics {
  const n = cases.length
  let moved = 0
  let called = 0
  let calls = 0
  let right = 0
  let in50 = 0
  let in80 = 0
  let absolute = 0
  let squared = 0
  let bias = 0
  let pinball = 0
  let pinballZ = 0
  let floorZ = 0
  let withFloor = 0
  let width = 0
  let low = 0
  let high = 0
  const below = QUANTILE_LEVELS.map(() => 0)
  const errors: Partial<Record<LabErrorKind, number>> = {}
  const samples: HourSample[] = []
  let block = 1
  for (const entry of cases) {
    const median = entry.q[P50]
    if (entry.move !== 0 && median !== 0) {
      moved++
      if (Math.sign(entry.move) === Math.sign(median)) called++
    }
    let call = 0
    let callRight = 0
    if (entry.dir !== 'NEUTRAL' && entry.move !== 0) {
      call = 1
      if ((entry.dir === 'BULLISH') === entry.move > 0) callRight = 1
    }
    calls += call
    right += callRight
    const inside = insideOf(entry.q, entry.move)
    if (inside.inside50) in50++
    if (inside.inside80) in80++
    samples.push({ hour: hourOf(entry.t), sample: [inside.inside80 ? 1 : 0, inside.inside50 ? 1 : 0, entry.pinballZ ?? 0, entry.floorPinballZ ?? 0, call, callRight] })
    block = Math.max(block, blockHoursOf(entry.horizon))
    absolute += Math.abs(entry.move - median)
    squared += (entry.move - median) ** 2
    bias += entry.move - median
    pinball += meanPinball(entry.move, entry.q)
    if (entry.pinballZ !== undefined && entry.floorPinballZ !== undefined) {
      pinballZ += entry.pinballZ
      floorZ += entry.floorPinballZ
      withFloor++
    }
    width += entry.q[P90] - entry.q[P10]
    if (entry.move < entry.q[P10]) low++
    if (entry.move > entry.q[P90]) high++
    for (let level = 0; level < QUANTILE_LEVELS.length; level++) if (entry.move <= entry.q[level]) below[level]++
    for (const kind of errorsOfCase(entry)) errors[kind] = (errors[kind] ?? 0) + 1
  }
  const metrics: LabMetrics = {
    n,
    direction: share(called, moved),
    calls,
    callsRight: share(right, calls),
    coverage50: share(in50, n),
    coverage80: share(in80, n),
    mae: share(absolute, n),
    rmse: n > 0 ? Math.sqrt(squared / n) : null,
    bias: share(bias, n),
    pinball: share(pinball, n),
    skill: withFloor === n && n > 0 && floorZ > 0 ? 1 - pinballZ / floorZ : null,
    width80: share(width, n),
    levels: below.map((count) => share(count, n)),
    tailLow: share(low, n),
    tailHigh: share(high, n),
    errors
  }
  // What the figures are worth (V7.2 Stage 1): the cases resampled by hour, in blocks as long as the
  // longest horizon among them.
  const made = bootstrapOverHours(samples, LAB_STATISTICS, block)
  if (made !== null) {
    const [coverage80, coverage50, skill, callsRight] = made.figures
    metrics.ci = { coverage80: intervalOf(coverage80, SHARE), coverage50: intervalOf(coverage50, SHARE), skill: metrics.skill === null ? null : intervalOf(skill), callsRight: intervalOf(callsRight, SHARE) }
    const nEff = effectiveSampleSize(shareVariance(coverage80.value), coverage80.sd)
    metrics.nEff = Number.isFinite(nEff) ? nEff : null
    metrics.blocks = made.blocks
  }
  return metrics
}

/** The figures as statistics of the cases' sums -- inside the 80% range, inside the 50%, the pinball loss
 * in usual moves, persistence's, the calls and those right: the shares inside, the skill over persistence,
 * and the share of calls right. */
const LAB_STATISTICS: readonly Statistic[] = [
  (sums, n): number => sums[0] / n,
  (sums, n): number => sums[1] / n,
  (sums): number => (sums[3] > 0 ? 1 - sums[2] / sums[3] : Number.NaN),
  (sums): number => (sums[4] > 0 ? sums[5] / sums[4] : Number.NaN)
]

/** The events a case falls under (§92-93): a shock the hour before, a break of the day's range, a
 * story about its coin, and the story's kind. Every case is under 'all'. */
export function eventsOf(entry: Pick<LabCase, 'prior' | 'breakout' | 'kinds' | 'newsShift'>): LabEvent[] {
  const out: LabEvent[] = ['all']
  if (entry.prior !== undefined && entry.prior !== null) {
    if (entry.prior >= LAB_LINES.shock) out.push('pump')
    if (entry.prior <= -LAB_LINES.shock) out.push('dump')
  }
  if (entry.breakout === true) out.push('breakout')
  const kinds = entry.kinds ?? []
  if (kinds.length > 0 || (entry.newsShift !== undefined && entry.newsShift !== 0)) out.push('news')
  for (const kind of kinds) {
    const event = KIND_EVENTS[kind]
    if (event !== undefined && !out.includes(event)) out.push(event)
  }
  return out
}

export interface LabDrift {
  /** Forecasts made after an hour's shock, and of them those that over- and under-reacted. */
  shocks: number
  overReacting: number
  underReacting: number
}

/** How forecasts behaved after a shock (§42): over-reacting where the median followed the shock and
 * the move turned against it; under-reacting where it did not follow and the move went on past the
 * likely range the shock's way. */
export function labDrift(cases: readonly LabCase[]): LabDrift {
  let shocks = 0
  let over = 0
  let under = 0
  for (const entry of cases) {
    if (entry.prior === undefined || entry.prior === null || Math.abs(entry.prior) < LAB_LINES.shock) continue
    shocks++
    const way = Math.sign(entry.prior)
    const followed = Math.sign(entry.q[P50]) === way
    if (followed && entry.move !== 0 && Math.sign(entry.move) === -way) over++
    if (!followed && (way > 0 ? entry.move > entry.q[P75] : entry.move < entry.q[P25])) under++
  }
  return { shocks, overReacting: over, underReacting: under }
}

export type TraderRule = 'rules' | 'medians'

export interface LabTrade {
  pair: string
  t: number
  horizon: Horizon
  side: 'BUY' | 'SELL'
  /** Its opportunity class (shared/forecast/opportunityClass.ts; V6 Stage 12). */
  classKey?: string
  exit: 'stop' | 'target' | 'close'
  grossPct: number
  netPct: number
}

/** The trade a forecast makes under a rule, and how it ends; null where it makes none. */
export function tradeOf(entry: LabCase, rule: TraderRule): LabTrade | null {
  const median = entry.q[P50]
  let side: 'BUY' | 'SELL'
  if (rule === 'rules') {
    if (entry.dir === 'NEUTRAL' || entry.uncertain) return null
    side = entry.dir === 'BULLISH' ? 'BUY' : 'SELL'
    const edge = edgeOf(entry.q, side, null)
    if (!(edge.edgePct > 0) || edge.pProfit < DECISION_LINES.minProfitChance) return null
  } else {
    if (!(Math.abs(median) > ROUND_TRIP_PCT)) return null
    side = median > 0 ? 'BUY' : 'SELL'
  }
  let exit: LabTrade['exit']
  let gross: number
  if (side === 'BUY') {
    const stop = Math.min(entry.q[P10], 0)
    const target = entry.q[P75] > 0 ? entry.q[P75] : null
    if (entry.worst <= stop) [exit, gross] = ['stop', stop]
    else if (target !== null && entry.best >= target) [exit, gross] = ['target', target]
    else [exit, gross] = ['close', entry.move]
  } else {
    const stop = Math.max(entry.q[P90], 0)
    const target = entry.q[P25] < 0 ? entry.q[P25] : null
    if (entry.best >= stop) [exit, gross] = ['stop', -stop]
    else if (target !== null && entry.worst <= target) [exit, gross] = ['target', -target]
    else [exit, gross] = ['close', -entry.move]
  }
  const setup = setupOf({ side, story: (entry.kinds ?? []).length > 0 || (entry.newsShift ?? 0) !== 0, breakout: entry.breakout === true, prior: entry.prior ?? null, regime: entry.regime ?? null })
  return { pair: entry.pair, t: entry.t, horizon: entry.horizon, side, classKey: classKeyOf(entry.cls, entry.horizon, setup), exit, grossPct: gross, netPct: gross - ROUND_TRIP_PCT }
}

/** The trades of a horizon's cases under a rule, one open a pair at a time, in time. */
export function replayTrades(cases: readonly LabCase[], rule: TraderRule): LabTrade[] {
  const ordered = [...cases].sort((a, b) => a.t - b.t || a.pair.localeCompare(b.pair))
  const openUntil = new Map<string, number>()
  const trades: LabTrade[] = []
  for (const entry of ordered) {
    if (entry.t < (openUntil.get(entry.pair) ?? Number.NEGATIVE_INFINITY)) continue
    const trade = tradeOf(entry, rule)
    if (trade === null) continue
    trades.push(trade)
    openUntil.set(entry.pair, entry.t + HORIZON_BARS[entry.horizon] * 300)
  }
  return trades
}

export interface TraderStats {
  trades: number
  wins: number
  winRate: number | null
  /** Gross won over gross lost, net of costs; null with nothing lost. */
  profitFactor: number | null
  /** The mean net a trade, the sum of them (a fixed stake a trade), and the deepest fall of that sum
   * from its high, in exit order; the round trips' cost in all. */
  expectancyPct: number | null
  netPct: number
  maxDrawdownPct: number
  costPct: number
}

export function traderStats(trades: readonly LabTrade[]): TraderStats {
  const byExit = [...trades].sort((a, b) => a.t + HORIZON_BARS[a.horizon] * 300 - (b.t + HORIZON_BARS[b.horizon] * 300) || a.pair.localeCompare(b.pair))
  let won = 0
  let lost = 0
  let wins = 0
  let sum = 0
  let peak = 0
  let drawdown = 0
  for (const trade of byExit) {
    if (trade.netPct > 0) {
      wins++
      won += trade.netPct
    } else lost -= trade.netPct
    sum += trade.netPct
    peak = Math.max(peak, sum)
    drawdown = Math.max(drawdown, peak - sum)
  }
  const count = trades.length
  return {
    trades: count,
    wins,
    winRate: share(wins, count),
    profitFactor: lost > 0 ? won / lost : null,
    expectancyPct: share(sum, count),
    netPct: sum,
    maxDrawdownPct: drawdown,
    costPct: count * ROUND_TRIP_PCT
  }
}

// THE LIVE RECORD (forecasts/): each outcome joined to the forecast it judged, by id, and read four
// ways on the same moments (§49): V1 on the price alone, V2 the ensemble, V3 with the news's rules and
// V4 with the analyst's readings -- the one shown. Where no story moved a forecast V3 and V4 are V2.

export const LIVE_VARIANTS = ['v1', 'v2', 'v3', 'v4'] as const
export type LiveVariant = (typeof LIVE_VARIANTS)[number]

/** A recorded horizon's levels for each variant. */
export function variantLevels(line: HorizonLine): Record<LiveVariant, readonly number[]> {
  const v2 = line.v2 ?? line.q
  return { v1: line.v1, v2, v3: line.news?.v3?.q ?? v2, v4: line.q }
}

/** How the path's figures came out (V7.1 Stage 3): when the median was said to be reached against when it
 * was, and whether the likely high and low held. */
export interface TimingMetrics {
  /** Forecasts with an arrival on record whose target touch was judged. */
  n: number
  /** The mean chance said of the median's touch within the window (the horizon's, four hours at most), and
   * the share of those forecasts whose median was reached within it. */
  predicted: number | null
  reached: number | null
  /** Of them, said UNLIKELY, and of those the share reached: whether the word was right. */
  unlikely: number
  unlikelyReached: number | null
  /** The median of the typical minutes said, and of the minutes seen, over the forecasts reached. */
  saidMinutes: number | null
  seenMinutes: number | null
  /** Forecasts with likely levels on record, and how often the path's high stayed under the 80% level and
   * its low above it. */
  excursion: { n: number; high80: number | null; low80: number | null }
}

export interface LiveLabHorizon {
  outcomes: number
  variants: Record<LiveVariant, LabMetrics>
  /** The shown forecast where a story moved it, and where none did. */
  news: { moved: LabMetrics; unmoved: LabMetrics }
  /** The forecasts Bitcoin's sharp move widened (V6.1): as shown, and by V2's own levels beside them --
   * what the widening changed. Absent where it widened none. */
  shock?: { widened: LabMetrics; unwidened: LabMetrics }
  /** The shown forecasts by the market's shock state at them (V7.1 Stage 11); absent where none carried one. */
  byState?: Partial<Record<MarketShockState, LabMetrics>>
  /** The path's figures (V7.1 Stage 3); absent where no forecast of the horizon carried them. */
  timing?: TimingMetrics
}

/** The window a horizon's arrival is judged over: its own, four hours at most (the table's longest). */
export const TIMING_WINDOW_SEC: Record<Horizon, number> = { minutes5: 300, minutes15: 900, hour1: 3600, hours4: 14_400, hours24: 14_400 }
const TIMING_WINDOW_INDEX: Record<Horizon, number> = { minutes5: 0, minutes15: 1, hour1: 2, hours4: 3, hours24: 3 }

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The path's figures of a horizon over the record: each outcome with its forecast's arrival and levels. */
export function timingOf(predictions: ReadonlyMap<string, PredictionLine>, outcomes: readonly OutcomeLine[], horizon: Horizon): TimingMetrics | null {
  const windowSec = TIMING_WINDOW_SEC[horizon]
  const at = TIMING_WINDOW_INDEX[horizon]
  let n = 0
  let predicted = 0
  let reached = 0
  let unlikely = 0
  let unlikelyReached = 0
  const said: number[] = []
  const seen: number[] = []
  let exN = 0
  let high80 = 0
  let low80 = 0
  for (const outcome of outcomes) {
    if (outcome.h !== horizon) continue
    const line = predictions.get(outcome.id)?.h[horizon]
    if (line === undefined) continue
    if (line.arr !== undefined && outcome.touch !== undefined) {
      n++
      predicted += line.arr.p[at] ?? 0
      const touched = outcome.touch[0] !== null && outcome.touch[0] <= windowSec
      if (touched) reached++
      if (line.arr.unlikely) {
        unlikely++
        if (touched) unlikelyReached++
      }
      if (touched) {
        seen.push(outcome.touch[0]! / 60)
        if (line.arr.med !== null) said.push(line.arr.med)
      }
    }
    if (line.ex !== undefined && line.ex.length === 6) {
      exN++
      if (outcome.best <= line.ex[1]) high80++
      if (outcome.worst >= line.ex[4]) low80++
    }
  }
  if (n === 0 && exN === 0) return null
  const share = (value: number, over: number): number | null => (over === 0 ? null : value / over)
  return {
    n,
    predicted: share(predicted, n),
    reached: share(reached, n),
    unlikely,
    unlikelyReached: share(unlikelyReached, unlikely),
    saidMinutes: medianOf(said),
    seenMinutes: medianOf(seen),
    excursion: { n: exN, high80: share(high80, exN), low80: share(low80, exN) }
  }
}

export interface LiveLab {
  /** Unix seconds: the first and last forecast judged. */
  from: number | null
  to: number | null
  horizons: Partial<Record<Horizon, LiveLabHorizon>>
  events: Partial<Record<LabEvent, LabMetrics>>
  drift: LabDrift & {
    /** Forecasts made again between closes, by reason, and the mean change of the hour's median at one. */
    refreshes: number
    byReason: Record<string, number>
    meanChangePct: number | null
  }
}

/** The live record's cases for one variant: every outcome whose forecast is on record. */
export function liveCases(predictions: ReadonlyMap<string, PredictionLine>, outcomes: readonly OutcomeLine[], variant: LiveVariant): LabCase[] {
  const out: LabCase[] = []
  for (const outcome of outcomes) {
    const line = predictions.get(outcome.id)
    const horizon = line?.h[outcome.h]
    if (line === undefined || horizon === undefined) continue
    const levels = variantLevels(horizon)[variant]
    const story = horizon.news?.v4 ?? horizon.news?.v3
    out.push({
      pair: line.pair,
      t: line.t,
      horizon: outcome.h,
      cls: line.cls,
      q: levels,
      // The call and P(up) recorded are the shown forecast's; V1's own are its P(up) and no call.
      dir: variant === 'v4' ? horizon.dir : 'NEUTRAL',
      pUp: variant === 'v1' ? horizon.v1pUp : horizon.pUp,
      uncertain: horizon.uncertain,
      width: levels[P90] - levels[P10],
      usualWidth: horizon.usualWidth,
      move: outcome.move,
      best: outcome.best,
      worst: outcome.worst,
      prior: line.z1h ?? null,
      newsShift: variant === 'v3' || variant === 'v4' ? (story?.shift ?? 0) : 0,
      kinds: story === undefined ? [] : [story.kind],
      shock: horizon.shock !== undefined,
      ...(line.state === undefined ? {} : { state: line.state })
    })
  }
  return out
}

/** The shown forecasts by the market's state at them (V7.1 Stage 11), for the states any carried. */
export function metricsByState(shown: readonly LabCase[]): Partial<Record<MarketShockState, LabMetrics>> {
  const out: Partial<Record<MarketShockState, LabMetrics>> = {}
  for (const state of MARKET_SHOCK_STATES) {
    const mine = shown.filter((entry) => entry.state === state)
    if (mine.length > 0) out[state] = labMetrics(mine)
  }
  return out
}

export function liveLab(predictionLines: readonly PredictionLine[], outcomes: readonly OutcomeLine[]): LiveLab {
  const predictions = new Map(predictionLines.map((line) => [line.id, line]))
  const byVariant = Object.fromEntries(LIVE_VARIANTS.map((variant) => [variant, liveCases(predictions, outcomes, variant)])) as Record<LiveVariant, LabCase[]>
  const horizons: LiveLab['horizons'] = {}
  for (const horizon of [...new Set(byVariant.v4.map((entry) => entry.horizon))]) {
    const pick = (variant: LiveVariant): LabCase[] => byVariant[variant].filter((entry) => entry.horizon === horizon)
    const shown = pick('v4')
    const widened = shown.filter((entry) => entry.shock === true)
    const timing = timingOf(predictions, outcomes, horizon)
    const byState = metricsByState(shown)
    horizons[horizon] = {
      outcomes: shown.length,
      variants: Object.fromEntries(LIVE_VARIANTS.map((variant) => [variant, labMetrics(pick(variant))])) as Record<LiveVariant, LabMetrics>,
      news: { moved: labMetrics(shown.filter((entry) => (entry.kinds ?? []).length > 0)), unmoved: labMetrics(shown.filter((entry) => (entry.kinds ?? []).length === 0)) },
      ...(widened.length === 0 ? {} : { shock: { widened: labMetrics(widened), unwidened: labMetrics(pick('v2').filter((entry) => entry.shock === true)) } }),
      ...(Object.keys(byState).length === 0 ? {} : { byState }),
      ...(timing === null ? {} : { timing })
    }
  }
  const events: LiveLab['events'] = {}
  for (const event of LAB_EVENTS) {
    const mine = byVariant.v4.filter((entry) => eventsOf(entry).includes(event))
    if (mine.length > 0) events[event] = labMetrics(mine)
  }
  // Each forecast made again, against the one it replaced: how far the hour's median moved.
  const byReason: Record<string, number> = {}
  let refreshes = 0
  let change = 0
  let changes = 0
  for (const line of predictionLines) {
    if (line.why !== 'refresh') continue
    refreshes++
    for (const reason of line.reasons ?? []) byReason[reason] = (byReason[reason] ?? 0) + 1
    const before = line.previous === undefined ? undefined : predictions.get(line.previous)?.h.hour1
    const now = line.h.hour1
    if (before !== undefined && now !== undefined) {
      change += Math.abs(now.q[P50] - before.q[P50])
      changes++
    }
  }
  const times = byVariant.v4.map((entry) => entry.t)
  return {
    from: times.length === 0 ? null : Math.min(...times),
    to: times.length === 0 ? null : Math.max(...times),
    horizons,
    events,
    drift: { ...labDrift(byVariant.v4), refreshes, byReason, meanChangePct: share(change, changes) }
  }
}

// THE LEADERBOARD (§103-105): every model at every horizon on the walk forward's outcomes -- its loss,
// its skill over persistence, its 80% range's coverage, the share of ways its median called -- its
// weight in the ensemble, whether it was promoted and why, and whether its last week found it degraded.

export interface LeaderRow {
  horizon: Horizon
  model: ForecastModelId
  n: number
  pinball: number
  skill: number | null
  coverage80: number
  direction: number
  weight: number
  promoted: boolean | null
  degraded: boolean
  lines: CheckLine[]
}

export function leaderboardOf(
  horizons: readonly { horizon: Horizon; scores: readonly { model: ForecastModelId; overall: ModelScore }[] }[],
  promotions: readonly Promotion[],
  weights: Partial<Record<Horizon, readonly MemberWeight[]>>,
  degraded: readonly string[]
): LeaderRow[] {
  const rows: LeaderRow[] = []
  for (const entry of horizons) {
    const floor = entry.scores.find((score) => score.model === 'persistence')?.overall
    for (const score of entry.scores) {
      const promotion = promotions.find((one) => one.horizon === entry.horizon && one.model === score.model)
      rows.push({
        horizon: entry.horizon,
        model: score.model,
        n: score.overall.n,
        pinball: score.overall.pinball,
        skill: floor === undefined || !(floor.pinball > 0) ? null : 1 - score.overall.pinball / floor.pinball,
        coverage80: score.overall.coverage80,
        direction: score.overall.direction,
        weight: weights[entry.horizon]?.find((member) => member.model === score.model)?.weight ?? 0,
        promoted: promotion?.promoted ?? null,
        degraded: degraded.includes(`${score.model}:${entry.horizon}`),
        lines: promotion?.lines ?? []
      })
    }
  }
  return rows.sort((a, b) => HORIZON_BARS[a.horizon] - HORIZON_BARS[b.horizon] || a.pinball - b.pinball)
}
