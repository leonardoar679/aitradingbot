import { UNCERTAINTY_LINES, bootstrapOverHours, type Interval } from '../forecast/uncertainty'
import { rngOf } from '../forecast/ml/bins'
import type { RoundTrip } from './roundTrips'

// IS IT SKILL (V8-S6-SKILL; V8 Stage 6, 26 October 2026)? A trader's completed round trips, each at 1x -- its move in
// its favour from its own average entry to its own average exit -- less what the market's drift would have given the
// same side over the same hold: Bitcoin's mean hourly return over the 720 hours before the trip's day, times the coin's
// beta to Bitcoin over those hours, times the hours held. The mean of what is left is the trader's edge per trip.
//
// It is called skill only where chance explains it under neither of two nulls and the record holds it up:
// - null A, the schedule shifted: every trip moved by one random offset within the record's span, keeping its coin, its
//   side and its hold, and measured on the venue's bars -- what the same trades at other times would have made, with
//   the observed figure measured on the same bars at no offset;
// - null B, the sides flipped: each trip's edge given a random sign -- what the same trips with sides chosen by a coin
//   toss would have made;
// each 10,000 draws, p the share at or above what was seen (counting the seen one), needing 0.01 or less under both;
// the edge's 95% interval, resampled by trading day, wholly above 0; and the first half of the trips and the second
// each positive. Under 30 trips, 15 trading days or 30 calendar days the record is TOO FEW; any other failure is MARKET
// OR LUCK. The lines are the engine's (ENGINE_CONSTANTS.traders.skill), registered before any trader was measured.

export const SKILL_VERSION = 'trader-skill-v1'

export const SKILL_LINES = {
  version: SKILL_VERSION,
  minTrips: 30,
  minTradingDays: 15,
  minSpanDays: 30,
  draws: 10_000,
  alpha: 0.01,
  /** The edge's interval, resampled by the trading day a trip closed on. */
  level: 0.95,
  /** Beta and Bitcoin's drift from the hours before a trip's day; fewer paired hours than the least, a beta of 1. */
  betaHours: 720,
  minBetaHours: 360,
  /** The bars null A's shifted trips are measured on. */
  nullBarMinutes: 15,
  seed: 20_261_026
} as const

export type SkillVerdict = 'SKILL' | 'MARKET OR LUCK' | 'TOO FEW'

/** A coin's closes at a fixed step: bar k covers [startSec + k*step, startSec + (k+1)*step) and closes at its end. */
export interface CloseSeries {
  startSec: number
  stepSec: number
  closes: Float64Array
}

export interface SkillInput {
  /** Completed round trips on coins the venue's bars cover, keyed by the coin's bars below. */
  trips: readonly RoundTrip[]
  /** Each coin's closes at null A's bar size, and hourly closes for the betas -- Bitcoin's under "BTC". */
  bars: ReadonlyMap<string, CloseSeries>
  hourly: ReadonlyMap<string, CloseSeries>
  /** The trader's key: the draws' seed is the lines' seed and the key's, so the same record draws the same. */
  key: string
}

export interface SkillResult {
  version: typeof SKILL_VERSION
  verdict: SkillVerdict
  /** Why it is not SKILL: each line it did not meet. */
  reasons: string[]
  trips: number
  /** Trips left out: no bars of their coin at their times. */
  withoutBars: number
  tradingDays: number
  spanDays: number
  /** The mean edge per trip in percent, its interval, and each half's mean. */
  edgePct: number | null
  interval: Interval | null
  halvesPct: [number, number] | null
  /** p under each null; null where the test was not run. */
  pShift: number | null
  pFlip: number | null
  /** Trips whose coin had too few hours for a beta, given 1. */
  betaOfOne: number
  draws: number
}

const DAY_SEC = 86_400

/** The close of the last bar that closed at or before a moment; null outside the series. */
export function closeAt(series: CloseSeries, sec: number): number | null {
  const k = Math.floor((sec - series.startSec) / series.stepSec) - 1
  if (k < 0 || k >= series.closes.length) return null
  const close = series.closes[k]
  return close > 0 ? close : null
}

/** A coin's beta to Bitcoin and Bitcoin's mean hourly log return over the hours before a day: null where too few hours
 * pair. */
export function betaBefore(coin: CloseSeries | undefined, btc: CloseSeries | undefined, daySec: number, lines: typeof SKILL_LINES = SKILL_LINES): { beta: number; drift: number } | null {
  if (btc === undefined) return null
  const coinReturns: number[] = []
  const btcReturns: number[] = []
  for (let hour = lines.betaHours; hour >= 1; hour--) {
    const end = daySec - (hour - 1) * 3600
    const b0 = closeAt(btc, end - 3600)
    const b1 = closeAt(btc, end)
    if (b0 === null || b1 === null) continue
    if (coin === undefined || coin === btc) {
      btcReturns.push(Math.log(b1 / b0))
      coinReturns.push(Math.log(b1 / b0))
      continue
    }
    const c0 = closeAt(coin, end - 3600)
    const c1 = closeAt(coin, end)
    if (c0 === null || c1 === null) continue
    btcReturns.push(Math.log(b1 / b0))
    coinReturns.push(Math.log(c1 / c0))
  }
  if (btcReturns.length < lines.minBetaHours) return null
  const n = btcReturns.length
  const meanB = btcReturns.reduce((a, b) => a + b, 0) / n
  const meanC = coinReturns.reduce((a, b) => a + b, 0) / n
  let cov = 0
  let varB = 0
  for (let k = 0; k < n; k++) {
    cov += (coinReturns[k] - meanC) * (btcReturns[k] - meanB)
    varB += (btcReturns[k] - meanB) ** 2
  }
  return { beta: varB > 0 ? cov / varB : 1, drift: meanB }
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

const signOf = (trip: RoundTrip): 1 | -1 => (trip.side === 'long' ? 1 : -1)
const mean = (values: ArrayLike<number>): number => {
  let total = 0
  for (let k = 0; k < values.length; k++) total += values[k]
  return values.length === 0 ? Number.NaN : total / values.length
}

/** V8-S6-SKILL: a trader's record, judged. */
export function skillOf(input: SkillInput, lines: typeof SKILL_LINES = SKILL_LINES): SkillResult {
  const btcHourly = input.hourly.get('BTC')
  // Each day's beta and drift, per coin, computed once: a shifted trip reads its new day's. Too few hours of the coin, a
  // beta of 1 on Bitcoin's own drift; too few of Bitcoin, no drift.
  const cache = new Map<string, Map<number, { beta: number; drift: number; ofOne: boolean }>>()
  const betaOf = (coin: string, sec: number): { beta: number; drift: number; ofOne: boolean } => {
    const day = Math.floor(sec / DAY_SEC) * DAY_SEC
    let mine = cache.get(coin)
    if (mine === undefined) {
      mine = new Map()
      cache.set(coin, mine)
    }
    let found = mine.get(day)
    if (found === undefined) {
      const read = betaBefore(coin === 'BTC' ? btcHourly : input.hourly.get(coin), btcHourly, day, lines)
      found = read !== null ? { ...read, ofOne: false } : { beta: 1, drift: betaBefore(btcHourly, btcHourly, day, lines)?.drift ?? 0, ofOne: true }
      mine.set(day, found)
    }
    return found
  }
  let betaOfOne = 0

  // The trips null A can measure: every one with its coin's bars at its own times.
  const usable: RoundTrip[] = []
  let withoutBars = 0
  for (const trip of input.trips) {
    const series = input.bars.get(trip.coin)
    if (series === undefined || closeAt(series, trip.openedAtMs / 1000) === null || closeAt(series, trip.closedAtMs / 1000) === null) withoutBars++
    else usable.push(trip)
  }
  usable.sort((a, b) => a.closedAtMs - b.closedAtMs)
  const n = usable.length
  const days = new Set(usable.map((trip) => Math.floor(trip.closedAtMs / 1000 / DAY_SEC))).size
  const fromSec = n === 0 ? 0 : Math.min(...usable.map((trip) => trip.openedAtMs)) / 1000
  const toSec = n === 0 ? 0 : Math.max(...usable.map((trip) => trip.closedAtMs)) / 1000
  const spanDays = (toSec - fromSec) / DAY_SEC
  const base = { version: SKILL_VERSION as typeof SKILL_VERSION, trips: n, withoutBars, tradingDays: days, spanDays, draws: lines.draws }

  // The edge per trip from the trader's own fills.
  const edges = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const trip = usable[k]
    const hours = (trip.closedAtMs - trip.openedAtMs) / 3_600_000
    const { beta, drift, ofOne } = betaOf(trip.coin, trip.openedAtMs / 1000)
    if (ofOne) betaOfOne++
    const move = trip.side === 'long' ? trip.exitPx / trip.entryPx - 1 : 1 - trip.exitPx / trip.entryPx
    edges[k] = move - signOf(trip) * beta * drift * hours
  }
  const edgePct = n === 0 ? null : mean(edges) * 100
  const half = Math.floor(n / 2)
  const halvesPct: [number, number] | null = n < 2 ? null : [mean(edges.subarray(0, half)) * 100, mean(edges.subarray(half)) * 100]
  const resampled =
    n === 0
      ? null
      : bootstrapOverHours(
          usable.map((trip, k) => ({ hour: Math.floor(trip.closedAtMs / 1000 / DAY_SEC), sample: [edges[k] * 100] })),
          [(sums, count): number => sums[0] / count],
          1,
          { ...UNCERTAINTY_LINES, seed: lines.seed, level: lines.level }
        )
  const interval = resampled === null ? null : { low: resampled.figures[0].low, high: resampled.figures[0].high }

  const tooFew: string[] = []
  if (n < lines.minTrips) tooFew.push(`${n} completed round trips, under ${lines.minTrips}`)
  if (days < lines.minTradingDays) tooFew.push(`${days} trading days, under ${lines.minTradingDays}`)
  if (spanDays < lines.minSpanDays) tooFew.push(`${spanDays.toFixed(1)} calendar days, under ${lines.minSpanDays}`)
  if (tooFew.length > 0) return { ...base, verdict: 'TOO FEW', reasons: tooFew, edgePct, interval, halvesPct, pShift: null, pFlip: null, betaOfOne }

  const rng = rngOf((lines.seed ^ hashOf(input.key)) >>> 0)
  const seen = mean(edges)

  // Null B: the sides by a coin toss.
  let atLeastFlip = 0
  for (let draw = 0; draw < lines.draws; draw++) {
    let total = 0
    for (let k = 0; k < n; k++) total += rng() < 0.5 ? -edges[k] : edges[k]
    if (total / n >= seen) atLeastFlip++
  }
  const pFlip = (1 + atLeastFlip) / (1 + lines.draws)

  // Null A: the schedule shifted, on the bars. The seen figure on the same bars at no offset.
  const span = toSec - fromSec
  const holdSec = usable.map((trip) => (trip.closedAtMs - trip.openedAtMs) / 1000)
  const onBars = (offset: number): number | null => {
    let total = 0
    let counted = 0
    for (let k = 0; k < n; k++) {
      const trip = usable[k]
      const series = input.bars.get(trip.coin) as CloseSeries
      const entry = span > 0 ? fromSec + ((((trip.openedAtMs / 1000 - fromSec + offset) % span) + span) % span) : trip.openedAtMs / 1000
      const exit = entry + holdSec[k]
      const p0 = closeAt(series, entry)
      const p1 = closeAt(series, exit)
      if (p0 === null || p1 === null) continue
      const { beta, drift } = betaOf(trip.coin, entry)
      total += signOf(trip) * (p1 / p0 - 1) - signOf(trip) * beta * drift * (holdSec[k] / 3600)
      counted++
    }
    return counted === 0 ? null : total / counted
  }
  const seenOnBars = onBars(0)
  let atLeastShift = 0
  let shifted = 0
  if (seenOnBars !== null) {
    for (let draw = 0; draw < lines.draws; draw++) {
      const value = onBars(rng() * span)
      if (value === null) continue
      shifted++
      if (value >= seenOnBars) atLeastShift++
    }
  }
  const pShift = seenOnBars === null || shifted === 0 ? null : (1 + atLeastShift) / (1 + shifted)

  const failed: string[] = []
  if (pShift === null || pShift > lines.alpha) failed.push(pShift === null ? 'the shifted schedule could not be measured on the bars' : `the shifted schedule does as well ${((pShift as number) * 100).toFixed(2)}% of the time, over ${lines.alpha * 100}%`)
  if (pFlip > lines.alpha) failed.push(`sides by a coin toss do as well ${(pFlip * 100).toFixed(2)}% of the time, over ${lines.alpha * 100}%`)
  if (interval === null || !(interval.low > 0)) failed.push(interval === null ? 'the edge has no interval' : 'the edge\'s 95% interval reaches 0 or below')
  if (halvesPct === null || !(halvesPct[0] > 0 && halvesPct[1] > 0)) failed.push('the first half and the second half are not both positive')
  return { ...base, verdict: failed.length === 0 ? 'SKILL' : 'MARKET OR LUCK', reasons: failed, edgePct, interval, halvesPct, pShift, pFlip, betaOfOne }
}
