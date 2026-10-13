import type { ForecastBar } from './bars'
import { classify, type Direction } from './direction'
import { ENSEMBLE_LINES } from './ensemble'
import { HORIZON_BARS, MARKET_REGIMES, PAIR_CLASSES, type Horizon, type PairClass } from './features'
import { LAB_EVENTS, LAB_LINES, eventsOf, labDrift, labMetrics, replayTrades, traderStats, type LabCase, type LabDrift, type LabEvent, type LabMetrics, type LabTrade, type TraderRule, type TraderStats } from './lab'
import { QUANTILE_LEVELS, meanPinball } from './ml/quantile'
import type { ForecastModelId } from './models'
import type { OosRecord } from './oosRecord'
import { VARIANTS, honestScore, rowsOf, scoreOutOfSample, type CurveBin, type ScoredRow, type VariantId } from './runCalibration'
import { usualMove } from './targets'
import type { Promotion } from './training'

// THE LAB ON THE WALK FORWARD (V6 Stage 11, 13 October 2026; the arithmetic of each figure is lab.ts).
// Each tested hour of each pair, forecast as runCalibration.ts forecasts it out of sample -- weights and
// calibration from the weeks before its own, P(up) mapped by the weeks before that -- is said in percent
// and called as the live forecast would call it, with the direction's skill and the class's usual width
// read from the weeks before it too: nothing a forecast is judged by was fitted on its week. Around each,
// from the bars on file: the hour before (a shock), the day's range (a break of it), the move to twice
// the horizon (EARLY); and the stories published in the four hours before that named its coin.

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P50 = QUANTILE_LEVELS.indexOf(0.5)
const P90 = QUANTILE_LEVELS.indexOf(0.9)

/** A story as the news history marks it: when, the coins it named, its kind. */
export interface StoryMarkInput {
  publishedAt: number
  tickers: readonly string[]
  eventType: string
}

export interface LabVariant {
  pooled: LabMetrics
  byClass: Partial<Record<PairClass, LabMetrics>>
  /** P(up)'s reliability: the mean forecast against the share that went up, by tenth. */
  pUpCurve: CurveBin[]
}

export interface LabHorizon {
  rows: number
  weeks: number[]
  variants: Record<VariantId, LabVariant>
  /** V2, the forecast shown, under each event (§92-93), and after shocks (§42). */
  events: Partial<Record<LabEvent, LabMetrics>>
  drift: LabDrift
  trader: Record<TraderRule, TraderStats>
  trades: Record<TraderRule, LabTrade[]>
}

/** One tested hour of a pair as the replay shows it: V2's five levels in percent, its P(up) and call,
 * and what came. */
export interface ReplayRow {
  t: number
  pair: string
  q: number[]
  pUp: number | null
  dir: Direction
  move: number
  best: number
  worst: number
}

const pctOf = (logMove: number): number => (Math.exp(logMove) - 1) * 100

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The first bar at or after `time`, by its open time; -1 where none. */
function barAt(bars: readonly ForecastBar[], time: number): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (bars[middle].time < time) low = middle + 1
    else high = middle
  }
  return low < bars.length && bars[low].time === time ? low : -1
}

/** What the bars say around a forecast read at the close `t`: the hour before in usual moves, whether
 * the close broke the day before's range, and the move to `aheadBars` on, in percent. */
export function aroundOf(bars: readonly ForecastBar[] | undefined, t: number, rv24h: number, aheadBars: number): { prior: number | null; breakout: boolean; after: number | null } {
  if (bars === undefined) return { prior: null, breakout: false, after: null }
  // The bar that closed at t opened five minutes before it.
  const at = barAt(bars, t - 300)
  if (at < 0) return { prior: null, breakout: false, after: null }
  const close = bars[at].close
  const hourAgo = barAt(bars, t - 300 - 3600)
  const usual = usualMove(rv24h, 12)
  const prior = hourAgo >= 0 && usual > 0 ? Math.log(close / bars[hourAgo].close) / usual : null
  let high = -Infinity
  let low = Infinity
  for (let index = at - 1; index >= 0 && bars[index].time >= t - 300 - 86_400; index--) {
    high = Math.max(high, bars[index].high)
    low = Math.min(low, bars[index].low)
  }
  const breakout = Number.isFinite(high) && (close > high || close < low)
  const ahead = barAt(bars, t - 300 + aheadBars * 300)
  return { prior, breakout, after: ahead >= 0 ? (bars[ahead].close / close - 1) * 100 : null }
}

/** The stories by the coins they named. */
function storiesByTicker(stories: readonly StoryMarkInput[]): Map<string, StoryMarkInput[]> {
  const out = new Map<string, StoryMarkInput[]>()
  for (const story of stories) {
    for (const ticker of story.tickers) {
      const mine = out.get(ticker)
      if (mine === undefined) out.set(ticker, [story])
      else mine.push(story)
    }
  }
  return out
}

/** The kinds of a coin's stories published in the four hours before `t`. */
export function kindsAt(stories: readonly StoryMarkInput[] | undefined, t: number): string[] {
  const kinds: string[] = []
  for (const story of stories ?? []) {
    if (story.publishedAt > t || story.publishedAt <= t - LAB_LINES.storySeconds) continue
    if (!kinds.includes(story.eventType)) kinds.push(story.eventType)
  }
  return kinds
}

/** Per week, from the weeks before it alone: P(up)'s skill, pooled and by class (where the class has
 * a cell's worth), and the class's usual 80% width in percent. */
function priorReadings(scored: readonly ScoredRow[], widthOf: (entry: ScoredRow) => number): Map<number, { skill: Map<PairClass | 'pooled', number | null>; usual: Map<PairClass | 'pooled', number | null> }> {
  const weeks = [...new Set(scored.map((entry) => entry.week))].sort((a, b) => a - b)
  const out = new Map<number, { skill: Map<PairClass | 'pooled', number | null>; usual: Map<PairClass | 'pooled', number | null> }>()
  for (const week of weeks) {
    const before = scored.filter((entry) => entry.week < week)
    const mapped = before.filter((entry) => entry.pUp !== null && entry.base !== null)
    const skill = new Map<PairClass | 'pooled', number | null>([['pooled', honestScore(mapped)?.directionSkill ?? null]])
    const usual = new Map<PairClass | 'pooled', number | null>([['pooled', median(before.map(widthOf))]])
    for (const cls of PAIR_CLASSES) {
      const mine = mapped.filter((entry) => entry.cls === cls)
      if (mine.length >= ENSEMBLE_LINES.minCellRows) skill.set(cls, honestScore(mine)?.directionSkill ?? null)
      const widths = before.filter((entry) => entry.cls === cls).map(widthOf)
      if (widths.length >= 200) usual.set(cls, median(widths))
    }
    out.set(week, { skill, usual })
  }
  return out
}

/** A horizon's Lab from its walk forward's record: its cases for each variant, and V2's replay rows. */
export function walkForwardLab(
  record: OosRecord,
  promotions: readonly Promotion[],
  market: ReadonlyMap<string, readonly ForecastBar[]>,
  stories: readonly StoryMarkInput[]
): { lab: LabHorizon; replay: ReplayRow[]; cases: Record<VariantId, LabCase[]> } {
  const horizon: Horizon = record.horizon
  const bars = HORIZON_BARS[horizon]
  const rows = rowsOf(record)
  const promoted = new Set<ForecastModelId>(promotions.filter((promotion) => promotion.horizon === horizon && promotion.promoted).map((promotion) => promotion.model))
  const cases = {} as Record<VariantId, LabCase[]>
  const variants = {} as Record<VariantId, LabVariant>
  let weeks: number[] = []
  const around = new Map<number, ReturnType<typeof aroundOf> & { kinds: string[] }>()
  const byTicker = storiesByTicker(stories)
  for (const variant of VARIANTS) {
    const scored = scoreOutOfSample(rows, variant, promoted).filter((entry) => entry.at !== undefined)
    if (variant === 'v2') weeks = [...new Set(scored.map((entry) => entry.week))].sort((a, b) => a - b)
    const usualOf = (entry: ScoredRow): number => usualMove(record.rv24h[entry.at!], bars)
    const widthOf = (entry: ScoredRow): number => pctOf(entry.quantiles[P90] * usualOf(entry)) - pctOf(entry.quantiles[P10] * usualOf(entry))
    const prior = priorReadings(scored, widthOf)
    const mine: LabCase[] = []
    for (const entry of scored) {
      const at = entry.at!
      const usual = usualOf(entry)
      const q = entry.quantiles.map((level) => pctOf(level * usual))
      const t = record.time[at]
      const pair = record.symbols[record.pair[at]]
      let context = around.get(at)
      if (context === undefined) {
        context = { ...aroundOf(market.get(pair), t, record.rv24h[at], 2 * bars), kinds: kindsAt(byTicker.get(pair.replace(/USDT$/, '')), t) }
        around.set(at, context)
      }
      const readings = prior.get(entry.week)
      const width = q[P90] - q[P10]
      const usualWidth = readings?.usual.get(entry.cls) ?? readings?.usual.get('pooled') ?? null
      const skill = readings?.skill.get(entry.cls) ?? readings?.skill.get('pooled') ?? null
      const call = classify({ pUp: entry.pUp ?? 0.5, medianPct: q[P50], p10Pct: q[P10], p90Pct: q[P90], width80Pct: width, usualWidth80Pct: usualWidth ?? 0, quality: null, directionSkill: entry.pUp === null ? null : skill })
      mine.push({
        pair,
        t,
        horizon,
        cls: entry.cls,
        q,
        dir: call.direction,
        pUp: entry.pUp,
        uncertain: call.uncertain,
        width,
        usualWidth: usualWidth ?? 0,
        move: pctOf(record.y[at]),
        best: pctOf(record.best[at]),
        worst: pctOf(record.worst[at]),
        after: context.after,
        prior: context.prior,
        breakout: context.breakout,
        kinds: context.kinds,
        regime: MARKET_REGIMES[record.regime[at]] ?? null,
        pinballZ: meanPinball(entry.z, entry.quantiles),
        floorPinballZ: meanPinball(entry.z, entry.floor)
      })
    }
    cases[variant] = mine
    const byClass: Partial<Record<PairClass, LabMetrics>> = {}
    for (const cls of PAIR_CLASSES) {
      const ofClass = mine.filter((entry) => entry.cls === cls)
      if (ofClass.length > 0) byClass[cls] = labMetrics(ofClass)
    }
    variants[variant] = { pooled: labMetrics(mine), byClass, pUpCurve: honestScore(scored)?.curve ?? [] }
  }
  const shown = cases.v2
  const events: Partial<Record<LabEvent, LabMetrics>> = {}
  for (const event of LAB_EVENTS) {
    const mine = shown.filter((entry) => eventsOf(entry).includes(event))
    if (mine.length > 0) events[event] = labMetrics(mine)
  }
  const trades = { rules: replayTrades(shown, 'rules'), medians: replayTrades(shown, 'medians') }
  return {
    lab: {
      rows: shown.length,
      weeks,
      variants,
      events,
      drift: labDrift(shown),
      trader: { rules: traderStats(trades.rules), medians: traderStats(trades.medians) },
      trades: { rules: trades.rules.slice(0, LAB_LINES.tradesKept), medians: trades.medians.slice(0, LAB_LINES.tradesKept) }
    },
    replay: shown.map((entry) => ({ t: entry.t, pair: entry.pair, q: [...entry.q], pUp: entry.pUp, dir: entry.dir, move: entry.move, best: entry.best, worst: entry.worst })),
    cases
  }
}
