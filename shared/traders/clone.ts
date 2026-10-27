import { UNCERTAINTY_LINES, bootstrapOverHours, type HourSample, type Interval } from '../forecast/uncertainty'
import { rngOf } from '../forecast/ml/bins'
import { ASSUMED_FUNDING_RATE, FUNDING_INTERVAL_SEC } from '../perp'
import type { RoundTrip } from './roundTrips'
import { closeAt, type CloseSeries } from './skill'

// CAN A RULE DO WHAT THE TRADER DOES (V8-S7-CLONE; V8 Stage 7, 27 October 2026)? A trader's entries are set against
// moments they did not enter, for a rule of the market's state that tells the two apart: at most two conditions, each
// one of twelve fixed features at or below, or at or above, one of its deciles, and the rule's side. The rule is fitted
// on the first two thirds of the entries by time, against null A's moments -- each entry's own moment moved by an
// offset drawn within its third's span, keeping its coin and side -- and judged on the last third alone: how well it
// tells the trader's entries there from the moved ones (its AUC), and what it makes traded on its own there, entering
// wherever it holds on the trader's coins, on its side, for the trader's usual hold, after a follower's costs. In sample
// the rule is chosen freely from at most 21,600 a side; only the last third judges it. The lines are the engine's
// (ENGINE_CONSTANTS.traders.clone), registered before any trader was measured.

export const CLONE_VERSION = 'trader-clone-v1'

/** The twelve features at a moment, from the coin's 15-minute closes before it and Bitcoin's hourly ones: its log
 * return over an hour, four hours and a day; the standard deviation of its 15-minute log returns over the day, and that
 * of the last four hours over it; where it closes in the day's range of closes (0 at the low, 1 at the high), and how
 * far from the day's mean close; Bitcoin's log return over an hour and a day, and the coin's day less Bitcoin's; the
 * hour of the day and the day of the week (Monday 0), in UTC. */
export const CLONE_FEATURES = ['ret1h', 'ret4h', 'ret24h', 'vol24h', 'volRatio', 'rangePos24h', 'fromMean24h', 'btcRet1h', 'btcRet24h', 'relRet24h', 'hourUtc', 'weekdayUtc'] as const

export type CloneFeature = (typeof CLONE_FEATURES)[number]

export const CLONE_LINES = {
  version: CLONE_VERSION,
  features: CLONE_FEATURES,
  /** The first two thirds of the entries by time fit the rule; the rest test it. */
  trainShare: 2 / 3,
  /** Each entry's null-A moments: its own moment moved by an offset drawn uniformly within its third's span. */
  negativesPerEntry: 4,
  /** A condition's thresholds: the deciles of its feature over the side's training moments. */
  quantiles: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  maxConditions: 2,
  /** A rule must hold at no fewer than this share of its side's training entries. */
  minSupport: 0.2,
  /** A side is fitted only with at least this many training entries. */
  minSideEntries: 10,
  /** Under this many entries of the rule's side in the last third, the record is TOO FEW. */
  minTestEntries: 30,
  /** The last third's AUC must have its interval's lower end above this; the clone's mean net its lower end above 0,
   * on at least `minTrades` trades. */
  minAucLow: 0.6,
  minTrades: 30,
  level: 0.95,
  /** The bars the features, the moved moments and the clone's trades are read on. */
  barMinutes: 15,
  /** The clone pays the venue's taker fee and the larger of this and the book's impact each way, and the funding rate
   * against it at each funding time its hold crosses. */
  minImpactBps: 2,
  fundingRate: ASSUMED_FUNDING_RATE,
  seed: 20_261_027
} as const

export type CloneVerdict = 'REPLICABLE' | 'PARTLY' | 'NOT REPLICABLE' | 'TOO FEW'

export interface CloneCondition {
  feature: CloneFeature
  op: '<=' | '>='
  threshold: number
}

export interface CloneRule {
  side: 'long' | 'short'
  conditions: CloneCondition[]
  /** The hold, in bars: the median of the side's training trips, rounded up, at least one. */
  holdBars: number
}

export interface CloneCosts {
  takerFeePct: number
  /** The book's impact at the stake each way, in percent; null where no book was read. */
  impactPct: number | null
}

export interface CloneInput {
  trips: readonly RoundTrip[]
  /** Each coin's 15-minute closes, and Bitcoin's hourly closes under "BTC": the skill test's. */
  bars: ReadonlyMap<string, CloseSeries>
  hourly: ReadonlyMap<string, CloseSeries>
  /** Each coin's costs; a coin without them is not traded by the clone. */
  costs: ReadonlyMap<string, CloneCosts>
  /** The trader's key: the moved moments are drawn from the lines' seed and the key's. */
  key: string
}

export interface CloneResult {
  version: typeof CLONE_VERSION
  verdict: CloneVerdict
  /** Each line the record or the rule did not meet. */
  reasons: string[]
  /** Entries with every feature at their moment, and those without. */
  entries: number
  withoutFeatures: number
  trainEntries: number
  testEntries: number
  rule: CloneRule | null
  /** How the rule told its side's training entries from their moved moments. */
  training: { tpr: number; fpr: number; positives: number; negatives: number } | null
  /** How it told them apart in the last third: the share of entries it held at, of moved moments, and the AUC. */
  outOfTime: { tpr: number; fpr: number; auc: number; interval: Interval | null; positives: number; negatives: number } | null
  /** The clone's own trades in the last third, after costs, in percent; null before a rule is tested. */
  trades: { n: number; meanNetPct: number | null; interval: Interval | null; coins: string[] } | null
}

const DAY_SEC = 86_400
const WINDOW_BARS = 96

/** The twelve features at a moment, in CLONE_FEATURES' order; null where a close they read is missing. */
export function featuresAt(series: CloseSeries, btcHourly: CloseSeries | undefined, sec: number, barSec: number = CLONE_LINES.barMinutes * 60): Float64Array | null {
  if (series.stepSec !== barSec || btcHourly === undefined) return null
  const end = Math.floor((sec - series.startSec) / barSec) - 1
  const start = end - WINDOW_BARS
  if (start < 0 || end >= series.closes.length) return null
  let low = Infinity
  let high = -Infinity
  let sum = 0
  for (let k = start; k <= end; k++) {
    const close = series.closes[k]
    if (!(close > 0)) return null
    low = Math.min(low, close)
    high = Math.max(high, close)
    sum += close
  }
  const closes = series.closes
  const now = closes[end]
  const ret = (bars: number): number => Math.log(now / closes[end - bars])
  const sd = (from: number): number => {
    const n = end - from
    let mean = 0
    for (let k = from + 1; k <= end; k++) mean += Math.log(closes[k] / closes[k - 1])
    mean /= n
    let total = 0
    for (let k = from + 1; k <= end; k++) total += (Math.log(closes[k] / closes[k - 1]) - mean) ** 2
    return Math.sqrt(total / n)
  }
  const b0 = closeAt(btcHourly, sec)
  const b1 = closeAt(btcHourly, sec - 3600)
  const b24 = closeAt(btcHourly, sec - DAY_SEC)
  if (b0 === null || b1 === null || b24 === null) return null
  const vol24h = sd(start)
  const ret24h = ret(96)
  const btcRet24h = Math.log(b0 / b24)
  const day = Math.floor(sec / DAY_SEC)
  return Float64Array.of(
    ret(4),
    ret(16),
    ret24h,
    vol24h,
    // A day without a move has no ratio: rounding's noise over rounding's noise.
    vol24h > 1e-12 ? sd(end - 16) / vol24h : 1,
    high > low ? (now - low) / (high - low) : 0.5,
    now / (sum / (WINDOW_BARS + 1)) - 1,
    Math.log(b0 / b1),
    btcRet24h,
    ret24h - btcRet24h,
    Math.floor((sec - day * DAY_SEC) / 3600),
    (((day + 3) % 7) + 7) % 7
  )
}

/** A string's 32-bit hash, for the draws' seed. */
function hashOf(text: string): number {
  let hash = 2166136261
  for (let k = 0; k < text.length; k++) {
    hash ^= text.charCodeAt(k)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function quantile(sorted: readonly number[], share: number): number {
  const at = (sorted.length - 1) * share
  const low = Math.floor(at)
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low)
}

const bitsIn = (word: number): number => {
  let v = word - ((word >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff
}

/** The rows set in both: one rule's rows, or two rules' at once. */
function countBoth(a: Uint32Array, b: Uint32Array = a): number {
  let total = 0
  for (let k = 0; k < a.length; k++) total += bitsIn(a[k] & b[k])
  return total
}

function bitsOf(rows: readonly Float64Array[], test: (row: Float64Array) => boolean): Uint32Array {
  const bits = new Uint32Array(Math.ceil(rows.length / 32))
  for (let k = 0; k < rows.length; k++) if (test(rows[k])) bits[k >>> 5] |= 1 << (k & 31)
  return bits
}

const holds = (condition: CloneCondition, row: Float64Array): boolean => {
  const value = row[CLONE_FEATURES.indexOf(condition.feature)]
  return condition.op === '<=' ? value <= condition.threshold : value >= condition.threshold
}

/** Whether a rule's conditions all hold at a moment's features. */
export function ruleHolds(conditions: readonly CloneCondition[], row: Float64Array): boolean {
  return conditions.every((condition) => holds(condition, row))
}

/** The rule that best tells entries from moved moments -- the share of entries it holds at less the share of moved
 * moments, holding at no fewer than `minSupport` of the entries -- of one condition or two on different features; the
 * first found where two tie, one condition before two. */
export function fitRule(positives: readonly Float64Array[], negatives: readonly Float64Array[], lines: typeof CLONE_LINES = CLONE_LINES): { conditions: CloneCondition[]; tpr: number; fpr: number } | null {
  if (positives.length === 0 || negatives.length === 0) return null
  const candidates: { feature: number; condition: CloneCondition; pos: Uint32Array; neg: Uint32Array }[] = []
  for (let f = 0; f < CLONE_FEATURES.length; f++) {
    const values = [...positives, ...negatives].map((row) => row[f]).sort((a, b) => a - b)
    const thresholds = [...new Set(lines.quantiles.map((share) => quantile(values, share)))]
    for (const op of ['<=', '>='] as const) {
      for (const threshold of thresholds) {
        const condition: CloneCondition = { feature: CLONE_FEATURES[f], op, threshold }
        candidates.push({ feature: f, condition, pos: bitsOf(positives, (row) => holds(condition, row)), neg: bitsOf(negatives, (row) => holds(condition, row)) })
      }
    }
  }
  let best: { conditions: CloneCondition[]; tpr: number; fpr: number; j: number } | null = null
  const consider = (posCount: number, negCount: number, conditions: () => CloneCondition[]): void => {
    const tpr = posCount / positives.length
    if (tpr < lines.minSupport) return
    const fpr = negCount / negatives.length
    if (best === null || tpr - fpr > best.j) best = { conditions: conditions(), tpr, fpr, j: tpr - fpr }
  }
  for (const one of candidates) consider(countBoth(one.pos), countBoth(one.neg), () => [one.condition])
  if (lines.maxConditions >= 2) {
    for (let a = 0; a < candidates.length; a++) {
      for (let b = a + 1; b < candidates.length; b++) {
        const first = candidates[a]
        const second = candidates[b]
        if (first.feature === second.feature) continue
        consider(countBoth(first.pos, second.pos), countBoth(first.neg, second.neg), () => [first.condition, second.condition])
      }
    }
  }
  if (best === null) return null
  const found: { conditions: CloneCondition[]; tpr: number; fpr: number } = best
  return { conditions: found.conditions, tpr: found.tpr, fpr: found.fpr }
}

interface Entry {
  trip: RoundTrip
  sec: number
  row: Float64Array
}

interface Moved {
  sec: number
  row: Float64Array
}

const median = (values: readonly number[]): number => quantile([...values].sort((a, b) => a - b), 0.5)

/** V8-S7-CLONE: a trader's record, cloned. */
export function cloneOf(input: CloneInput, lines: typeof CLONE_LINES = CLONE_LINES): CloneResult {
  const barSec = lines.barMinutes * 60
  const btc = input.hourly.get('BTC')
  const entries: Entry[] = []
  let withoutFeatures = 0
  for (const trip of [...input.trips].sort((a, b) => a.openedAtMs - b.openedAtMs)) {
    const series = input.bars.get(trip.coin)
    const sec = trip.openedAtMs / 1000
    const row = series === undefined ? null : featuresAt(series, btc, sec, barSec)
    if (row === null) withoutFeatures++
    else entries.push({ trip, sec, row })
  }
  const nTrain = Math.floor(entries.length * lines.trainShare)
  const train = entries.slice(0, nTrain)
  const test = entries.slice(nTrain)
  const base = { version: CLONE_VERSION as typeof CLONE_VERSION, entries: entries.length, withoutFeatures, trainEntries: train.length, testEntries: test.length }

  // Each entry's moved moments, drawn in time order, the training third's first.
  const rng = rngOf((lines.seed ^ hashOf(input.key)) >>> 0)
  const movedOf = (third: readonly Entry[]): Moved[][] => {
    const from = third.length === 0 ? 0 : third[0].sec
    const span = third.length === 0 ? 0 : third[third.length - 1].sec - from
    return third.map((entry) => {
      const series = input.bars.get(entry.trip.coin) as CloseSeries
      const out: Moved[] = []
      for (let k = 0; k < lines.negativesPerEntry; k++) {
        const offset = rng() * span
        const sec = span > 0 ? from + ((((entry.sec - from + offset) % span) + span) % span) : entry.sec
        const row = featuresAt(series, btc, sec, barSec)
        if (row !== null) out.push({ sec, row })
      }
      return out
    })
  }
  const trainMoved = movedOf(train)
  const testMoved = movedOf(test)

  // The rule: each side fitted on its own training entries, the better kept, long first where they tie.
  let fitted: { side: 'long' | 'short'; conditions: CloneCondition[]; tpr: number; fpr: number; positives: number; negatives: number; holdSec: number } | null = null
  for (const side of ['long', 'short'] as const) {
    const mine = train.map((entry, k) => ({ entry, moved: trainMoved[k] })).filter(({ entry }) => entry.trip.side === side)
    if (mine.length < lines.minSideEntries) continue
    const positives = mine.map(({ entry }) => entry.row)
    const negatives = mine.flatMap(({ moved }) => moved.map((moment) => moment.row))
    const rule = fitRule(positives, negatives, lines)
    if (rule === null) continue
    if (fitted === null || rule.tpr - rule.fpr > fitted.tpr - fitted.fpr) {
      fitted = { side, ...rule, positives: positives.length, negatives: negatives.length, holdSec: median(mine.map(({ entry }) => (entry.trip.closedAtMs - entry.trip.openedAtMs) / 1000)) }
    }
  }
  if (fitted === null) {
    return { ...base, verdict: 'TOO FEW', reasons: [`no side has ${lines.minSideEntries} entries in the first two thirds to fit a rule on`], rule: null, training: null, outOfTime: null, trades: null }
  }
  const rule: CloneRule = { side: fitted.side, conditions: fitted.conditions, holdBars: Math.max(1, Math.ceil(fitted.holdSec / barSec)) }
  const training = { tpr: fitted.tpr, fpr: fitted.fpr, positives: fitted.positives, negatives: fitted.negatives }

  const mineTest = test.map((entry, k) => ({ entry, moved: testMoved[k] })).filter(({ entry }) => entry.trip.side === rule.side)
  if (mineTest.length < lines.minTestEntries) {
    return { ...base, verdict: 'TOO FEW', reasons: [`${mineTest.length} ${rule.side} entries in the last third, under ${lines.minTestEntries}`], rule, training, outOfTime: null, trades: null }
  }

  // The last third: entries against their moved moments, by the day each falls on.
  const samples: HourSample[] = []
  let posHit = 0
  let negHit = 0
  let negatives = 0
  for (const { entry, moved } of mineTest) {
    const hit = ruleHolds(rule.conditions, entry.row) ? 1 : 0
    posHit += hit
    samples.push({ hour: Math.floor(entry.sec / DAY_SEC), sample: [hit, 1, 0, 0] })
    for (const moment of moved) {
      const movedHit = ruleHolds(rule.conditions, moment.row) ? 1 : 0
      negHit += movedHit
      negatives++
      samples.push({ hour: Math.floor(moment.sec / DAY_SEC), sample: [0, 0, movedHit, 1] })
    }
  }
  const aucOf = (sums: Float64Array): number => (sums[1] > 0 && sums[3] > 0 ? 0.5 * (sums[0] / sums[1] + 1 - sums[2] / sums[3]) : 0.5)
  const bootstrapLines = { ...UNCERTAINTY_LINES, seed: lines.seed, level: lines.level }
  const aucResampled = negatives === 0 ? null : bootstrapOverHours(samples, [(sums): number => aucOf(sums)], 1, bootstrapLines)
  const tpr = posHit / mineTest.length
  const fpr = negatives === 0 ? 0 : negHit / negatives
  const outOfTime = {
    tpr,
    fpr,
    auc: 0.5 * (tpr + 1 - fpr),
    interval: aucResampled === null ? null : { low: aucResampled.figures[0].low, high: aucResampled.figures[0].high },
    positives: mineTest.length,
    negatives
  }

  // The clone traded on its own over the last third's span, on the coins of the side's entries.
  const coins = [...new Set(entries.filter((entry) => entry.trip.side === rule.side).map((entry) => entry.trip.coin))].sort()
  const traded = cloneTradesOf(rule, coins, input, test[0].sec, test[test.length - 1].sec, lines)
  const netResampled = traded.length === 0 ? null : bootstrapOverHours(traded.map((trade) => ({ hour: Math.floor(trade.closeSec / DAY_SEC), sample: [trade.netPct] })), [(sums, n): number => sums[0] / n], 1, bootstrapLines)
  const trades = {
    n: traded.length,
    meanNetPct: traded.length === 0 ? null : traded.reduce((total, trade) => total + trade.netPct, 0) / traded.length,
    interval: netResampled === null ? null : { low: netResampled.figures[0].low, high: netResampled.figures[0].high },
    coins
  }
  return { ...base, ...cloneVerdictOf(outOfTime, trades, lines), rule, training, outOfTime, trades }
}

/** The clone traded on its own from one moment to another: at each bar's close where the rule holds on a coin, in at
 * that close and out at the close its hold later, one trade a coin at a time; each trade's net in percent after the
 * venue's taker fee and the larger of the lines' least impact and the book's each way, and the funding rate against
 * it at each funding time its hold crosses. A coin without bars or costs is not traded. */
export function cloneTradesOf(rule: CloneRule, coins: readonly string[], input: Pick<CloneInput, 'bars' | 'hourly' | 'costs'>, fromSec: number, toSec: number, lines: typeof CLONE_LINES = CLONE_LINES): { coin: string; openSec: number; closeSec: number; netPct: number }[] {
  const barSec = lines.barMinutes * 60
  const btc = input.hourly.get('BTC')
  const sign = rule.side === 'long' ? 1 : -1
  const out: { coin: string; openSec: number; closeSec: number; netPct: number }[] = []
  for (const coin of coins) {
    const series = input.bars.get(coin)
    const costs = input.costs.get(coin)
    if (series === undefined || costs === undefined) continue
    const perSide = costs.takerFeePct + Math.max(lines.minImpactBps / 100, costs.impactPct ?? 0)
    let freeAt = -Infinity
    for (let sec = series.startSec + Math.max(1, Math.ceil((fromSec - series.startSec) / barSec)) * barSec; sec <= toSec; sec += barSec) {
      if (sec < freeAt) continue
      const row = featuresAt(series, btc, sec, barSec)
      if (row === null || !ruleHolds(rule.conditions, row)) continue
      const closeSec = sec + rule.holdBars * barSec
      const entry = closeAt(series, sec)
      const exit = closeAt(series, closeSec)
      if (entry === null || exit === null) break
      const crossed = Math.floor(closeSec / FUNDING_INTERVAL_SEC) - Math.floor(sec / FUNDING_INTERVAL_SEC)
      out.push({ coin, openSec: sec, closeSec, netPct: sign * (exit / entry - 1) * 100 - 2 * perSide - crossed * lines.fundingRate * 100 })
      freeAt = closeSec
    }
  }
  return out
}

/** The verdict from the last third: its AUC's interval, and the clone's trades there. */
export function cloneVerdictOf(outOfTime: { interval: Interval | null }, trades: { n: number; interval: Interval | null }, lines: typeof CLONE_LINES = CLONE_LINES): { verdict: Exclude<CloneVerdict, 'TOO FEW'>; reasons: string[] } {
  const reasons: string[] = []
  const aucMet = outOfTime.interval !== null && outOfTime.interval.low > lines.minAucLow
  if (!aucMet) reasons.push(outOfTime.interval === null ? "the last third's AUC has no interval" : `the last third's AUC reaches ${lines.minAucLow} or below`)
  const netMet = trades.n >= lines.minTrades && trades.interval !== null && trades.interval.low > 0
  if (!netMet) {
    reasons.push(trades.n < lines.minTrades ? `the clone made ${trades.n} trades in the last third, under ${lines.minTrades}` : trades.interval === null ? "the clone's mean net has no interval" : "the clone's mean net reaches 0 or below")
  }
  return { verdict: aucMet && netMet ? 'REPLICABLE' : aucMet || netMet ? 'PARTLY' : 'NOT REPLICABLE', reasons }
}
