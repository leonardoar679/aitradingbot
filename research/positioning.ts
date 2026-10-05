import { readFileSync } from 'fs'
import { join } from 'path'
import { FEE_RATE } from '../shared/fees'
import type { Candle } from '../shared/ipc'
import { EVENT_LOOKBACK_BARS, detectEvents, isAtLeast, readEventAt, type EventReading } from '../shared/marketEvent'

// How is the futures market positioned when an event fires, and does it say which events to take?
// Does a crowded market come before a move on its own? See research/POSITIONING.md for the
// question, the rule and the result.
//
//   SET=large node research/fetch-positioning.mjs && SET=small node research/fetch-positioning.mjs
//   npx esbuild research/positioning.ts --bundle --platform=node --format=esm --outfile=research/.positioning.mjs
//   CANDLE_DIR=.candles MODE=freq  SET=discovery node --max-old-space-size=4096 research/.positioning.mjs
//   CANDLE_DIR=.candles MODE=study SET=discovery node --max-old-space-size=4096 research/.positioning.mjs
//
// MODE=freq prints how the readings are spread across events and how often a crowded market is
// seen, and nothing about what followed either: the split points and the crowding thresholds
// below were fixed from it before a single outcome was looked at. MODE=study scores them.

const DIR = process.env.CANDLE_DIR as string
const MODE = process.env.MODE ?? 'freq'
const SET = process.env.SET ?? 'discovery'
/** SHOW=n prints the first n events of each pair with their readings, for checking by hand. */
const SHOW = Number(process.env.SHOW ?? 0)

interface PairSet {
  /** Sub-directory of CANDLE_DIR holding the 1-minute candles. */
  dir: string
  symbols: string[]
  slippage: number
}

// The sets research/EVENTS.md and research/SETUPS.md used, with the same roles.
const SETS: Record<string, PairSet> = {
  discovery: { dir: '', symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'], slippage: 0.0002 },
  confirm: { dir: '', symbols: ['BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT'], slippage: 0.0002 },
  // RAYUSDT, the eighth smaller pair there, has no perpetual for a market to be positioned in.
  small: { dir: 'flow', symbols: ['STRKUSDT', 'FETUSDT', 'SUPERUSDT', 'AXSUSDT', 'DOTUSDT', 'ICPUSDT', 'ARKUSDT'], slippage: 0.0005 }
}
const set = SETS[SET]
if (!set) throw new Error(`unknown SET ${SET}`)

function loadCandles(symbol: string): Candle[] {
  const raw = JSON.parse(readFileSync(join(DIR, set.dir, `${symbol}-1m.json`), 'utf-8')) as number[][]
  return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
}

// ---------------------------------------------------------------------------------------------
// The positioning series, as research/fetch-positioning.mjs wrote them.

/** An archive row is stamped with the START of the five minutes it describes: open interest and
 * the two long/short ratios as they stood at the end of them, taker volume traded during them.
 * research/positioning-live.mjs found the live endpoints stamp the first three five minutes later
 * and taker volume the same, and publish each one to four minutes after its five minutes end. So
 * a row is used only once ten minutes have passed since its archive stamp -- here, and in anything
 * that reads the same numbers live. */
const ROW_USABLE_AFTER = 600
/** A premium bar, stamped with its open: complete five minutes later, and used five after that. */
const PREMIUM_USABLE_AFTER = 600
const STEP = 300
/** A day of rows, for the 24-hour means; a mean over less than nine tenths of a day is no mean. */
const DAY_ROWS = 288
const MIN_DAY_ROWS = Math.ceil(DAY_ROWS * 0.9)

interface Positioning {
  times: Float64Array
  /** Per row, each reading's value where the row and the rows it needs are all there, else NaN. */
  positionsAdded: Float64Array
  accountsLean: Float64Array
  topLean: Float64Array
  takerLift: Float64Array
  premiumTimes: Float64Array
  /** Per premium bar: the mean premium of the hour of bars ending with it, in percent. */
  premiumHour: Float64Array
}

/** Longs over shorts (or buys over sells), as Binance publishes it, as the long (buying) share. */
const share = (ratio: number | null): number => (ratio === null || !(ratio >= 0) ? NaN : ratio / (1 + ratio))

/** The largest index whose time is at or before `t`, or -1. */
function lastAtOrBefore(times: Float64Array, t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** The index whose time is exactly `t`, or -1: a reading spanning a hole in the series is no reading. */
function exactly(times: Float64Array, t: number, near: number): number {
  if (near >= 0 && near < times.length && times[near] === t) return near
  const index = lastAtOrBefore(times, t)
  return index >= 0 && times[index] === t ? index : -1
}

/** Each row's share less the mean of the same share over the day of rows before it, in points. */
function leanAgainstTheDay(times: Float64Array, shares: Float64Array): Float64Array {
  const n = times.length
  const sums = new Float64Array(n + 1)
  const counts = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const ok = Number.isFinite(shares[i])
    sums[i + 1] = sums[i] + (ok ? shares[i] : 0)
    counts[i + 1] = counts[i] + (ok ? 1 : 0)
  }
  const out = new Float64Array(n).fill(NaN)
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(shares[k])) continue
    // The rows stamped in the 24 hours before this one: [t - 1 day, t - 5 min].
    const from = lastAtOrBefore(times, times[k] - DAY_ROWS * STEP - 1) + 1
    const count = counts[k] - counts[from]
    if (count < MIN_DAY_ROWS) continue
    out[k] = (shares[k] - (sums[k] - sums[from]) / count) * 100
  }
  return out
}

function loadPositioning(symbol: string): Positioning {
  const metrics = JSON.parse(readFileSync(join(DIR, 'positioning', `${symbol}-metrics.json`), 'utf-8')) as (number | null)[][]
  const bars = JSON.parse(readFileSync(join(DIR, 'positioning', `${symbol}-premium-5m.json`), 'utf-8')) as (number | null)[][]
  const n = metrics.length
  const times = new Float64Array(n)
  const openInterest = new Float64Array(n)
  const accounts = new Float64Array(n)
  const top = new Float64Array(n)
  const taker = new Float64Array(n)
  metrics.forEach((row, i) => {
    times[i] = row[0] as number
    openInterest[i] = row[1] === null ? NaN : (row[1] as number)
    top[i] = share(row[4])
    accounts[i] = share(row[5])
    taker[i] = share(row[6])
  })

  const positionsAdded = new Float64Array(n).fill(NaN)
  const takerLift = new Float64Array(n).fill(NaN)
  for (let k = 0; k < n; k++) {
    const hourAgo = exactly(times, times[k] - 3600, k - 12)
    if (hourAgo >= 0 && openInterest[hourAgo] > 0 && Number.isFinite(openInterest[k])) {
      positionsAdded[k] = (openInterest[k] / openInterest[hourAgo] - 1) * 100
    }
    // The last fifteen minutes published: this row's five and the two before it.
    if (k >= 2 && times[k - 2] === times[k] - 2 * STEP && Number.isFinite(taker[k] + taker[k - 1] + taker[k - 2])) {
      takerLift[k] = ((taker[k] + taker[k - 1] + taker[k - 2]) / 3 - 0.5) * 100
    }
  }

  const m = bars.length
  const premiumTimes = new Float64Array(m)
  const premiumClose = new Float64Array(m)
  bars.forEach((bar, i) => {
    premiumTimes[i] = bar[0] as number
    premiumClose[i] = bar[4] === null ? NaN : (bar[4] as number)
  })
  const premiumHour = new Float64Array(m).fill(NaN)
  for (let q = 11; q < m; q++) {
    if (premiumTimes[q - 11] !== premiumTimes[q] - 11 * STEP) continue
    let sum = 0
    for (let j = q - 11; j <= q; j++) sum += premiumClose[j]
    if (Number.isFinite(sum)) premiumHour[q] = (sum / 12) * 100
  }

  return {
    times,
    positionsAdded,
    accountsLean: leanAgainstTheDay(times, accounts),
    topLean: leanAgainstTheDay(times, top),
    takerLift,
    premiumTimes,
    premiumHour
  }
}

const READINGS = ['positionsAdded', 'accountsLean', 'topLean', 'takerLift', 'premium'] as const
type ReadingKey = (typeof READINGS)[number]
const READING_NAMES: Record<ReadingKey, string> = {
  positionsAdded: 'positions added, % in the hour',
  accountsLean: 'accounts leaning, pts vs the day',
  topLean: 'top traders leaning, pts vs the day',
  takerLift: 'perp taker buying, pts over half',
  premium: 'premium, % over the hour'
}
type Reading = Record<ReadingKey, number>

/** The five readings as they could have been read at `now` (a bar's close, in seconds), unsigned:
 * NaN where the row due is missing, never an older one in its place. */
function readPositioningAt(p: Positioning, now: number): Reading {
  const reading: Reading = { positionsAdded: NaN, accountsLean: NaN, topLean: NaN, takerLift: NaN, premium: NaN }
  const k = lastAtOrBefore(p.times, now - ROW_USABLE_AFTER)
  if (k >= 0 && p.times[k] > now - ROW_USABLE_AFTER) throw new Error('a row was read before it was published')
  if (k >= 0 && p.times[k] > now - ROW_USABLE_AFTER - STEP) {
    reading.positionsAdded = p.positionsAdded[k]
    reading.accountsLean = p.accountsLean[k]
    reading.topLean = p.topLean[k]
    reading.takerLift = p.takerLift[k]
  }
  const q = lastAtOrBefore(p.premiumTimes, now - PREMIUM_USABLE_AFTER)
  if (q >= 0 && p.premiumTimes[q] > now - PREMIUM_USABLE_AFTER) throw new Error('a premium bar was read before it was complete')
  if (q >= 0 && p.premiumTimes[q] > now - PREMIUM_USABLE_AFTER - STEP) reading.premium = p.premiumHour[q]
  return reading
}

/** At an event, every reading but positions added is turned to face the move: positive where the
 * accounts, the top traders, the perpetual's takers or its premium lean the way the price went. */
function facingTheMove(reading: Reading, side: Side): Reading {
  return {
    positionsAdded: reading.positionsAdded,
    accountsLean: side * reading.accountsLean,
    topLean: side * reading.topLean,
    takerLift: side * reading.takerLift,
    premium: side * reading.premium
  }
}

// ---------------------------------------------------------------------------------------------
// Fixed from MODE=freq on the discovery pairs, before any outcome was looked at. Null until then,
// and MODE=study refuses to run on a null.

const EVENT_TYPES = ['breakout', 'breakdown'] as const
type EventType = (typeof EVENT_TYPES)[number]

type Splits = Record<ReadingKey, Record<EventType, number>>
interface Crowding {
  long: { accountsLean: number; premium: number }
  short: { accountsLean: number; premium: number }
}

/** Where each reading splits the events of each type in two: its median over the discovery
 * pairs' events, from MODE=freq SET=discovery on 5 October 2026. */
const SPLITS = {
  positionsAdded: { breakout: 0.0817, breakdown: 0.0058 },
  accountsLean: { breakout: -0.5626, breakdown: -0.4434 },
  topLean: { breakout: -0.0344, breakdown: -0.0126 },
  takerLift: { breakout: 2.8824, breakdown: 3.8131 },
  premium: { breakout: -0.0423, breakdown: 0.0437 }
} as Splits | null

/** A crowded market: the accounts leaning further than this from their day, AND the premium
 * beyond this, both the same way. Set by how often it fires, as research/SETUPS.md did: each is
 * the 90th (or 10th) percentile of its reading at every fifth minute on the discovery pairs, the
 * least extreme of 90, 95, 97.5, 99 and 99.5 at which no discovery pair sees a crowd more than
 * once a day a side -- 0.19 to 0.83 a day. From MODE=freq SET=discovery on 5 October 2026. */
const CROWDED = {
  long: { accountsLean: 2.712, premium: 0.05109 },
  short: { accountsLean: -2.767, premium: -0.05747 }
} as Crowding | null
const CROWD_COOLDOWN_SECONDS = 30 * 60

// ---------------------------------------------------------------------------------------------
// The trade, as research/EVENTS.md scored events by, unchanged.

type Side = 1 | -1
const ENTRY_DELAY_BARS = 2
const STOP_SIGMAS = 1.5
const TARGET_SIGMAS = 3
const HOLD_BARS = 60
const HORIZONS = [60, 240, 1440]
const ROUND_TRIP_FEE_PCT = FEE_RATE * 2 * 100

function bracket(bars: Candle[], entryIndex: number, side: Side, sigma15Pct: number): number | null {
  if (entryIndex + HOLD_BARS > bars.length) return null
  const open = bars[entryIndex].open
  const entry = open * (1 + side * set.slippage)
  const stop = open * (1 - (side * STOP_SIGMAS * sigma15Pct) / 100)
  const target = open * (1 + (side * TARGET_SIGMAS * sigma15Pct) / 100)
  const net = (exit: number): number => side * (exit / entry - 1) * 100 - ROUND_TRIP_FEE_PCT
  for (let i = entryIndex; i < entryIndex + HOLD_BARS; i++) {
    const bar = bars[i]
    const stopped = side > 0 ? bar.low <= stop : bar.high >= stop
    if (stopped) {
      const level = side > 0 ? Math.min(stop, bar.open) : Math.max(stop, bar.open)
      return net(level * (1 - side * set.slippage))
    }
    const reached = side > 0 ? bar.high >= target : bar.low <= target
    if (reached) return net(target)
  }
  return net(bars[entryIndex + HOLD_BARS - 1].close * (1 - side * set.slippage))
}

function forward(bars: Candle[], entryIndex: number, side: Side, horizon: number): number | null {
  const later = bars[entryIndex + horizon - 1]
  return later === undefined ? null : side * (later.close / bars[entryIndex].open - 1) * 100
}

function mean(xs: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < xs.length; i++) sum += xs[i]
  return sum / xs.length
}

function variance(xs: number[]): number {
  const m = mean(xs)
  return xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1)
}

function tStat(xs: number[]): number {
  return xs.length < 2 ? NaN : mean(xs) / Math.sqrt(variance(xs) / xs.length)
}

/** As in research/events.ts: observations in the same hour are one, and every t is on hourly means. */
function clustered(rows: { time: number; value: number }[]): number[] {
  const byHour = new Map<number, number[]>()
  for (const row of rows) {
    const hour = Math.floor(row.time / 3600)
    const list = byHour.get(hour)
    if (list) list.push(row.value)
    else byHour.set(hour, [row.value])
  }
  return [...byHour.values()].map(mean)
}

/** Two halves' difference, high less low, with its t on hourly means, as research/events.ts did
 * for taker flow. */
function difference(high: { time: number; value: number }[], low: { time: number; value: number }[]): { d: number; t: number } {
  const a = clustered(high)
  const b = clustered(low)
  const d = mean(a) - mean(b)
  return { d, t: d / Math.sqrt(variance(a) / a.length + variance(b) / b.length) }
}

const f = (value: number, digits = 3): string => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}` : 'n/a')

function summarise(label: string, rows: { time: number; value: number }[]): string {
  if (rows.length < 30) return `${label.padEnd(40)} n=${String(rows.length).padStart(6)}  (too few)`
  const clusters = clustered(rows)
  return (
    `${label.padEnd(40)} n=${String(rows.length).padStart(6)}  hours=${String(clusters.length).padStart(6)}` +
    `  mean=${f(mean(clusters))}%  t=${f(tStat(clusters), 1).padStart(6)}  per trade=${f(mean(rows.map((row) => row.value)))}%`
  )
}

function quantile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return NaN
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[at]
}

const sortedFinite = (values: number[]): Float64Array => Float64Array.from(values.filter(Number.isFinite)).sort()

// ---------------------------------------------------------------------------------------------

interface ScoredEvent {
  symbol: string
  time: number
  type: EventType
  /** The readings, each facing the move (positions added as it is). */
  reading: Reading
  /** Net bracket, taking the move's side and the other one, and each less the usual. */
  follow: number | null
  fade: number | null
  followExcess: number | null
  fadeExcess: number | null
}

interface ScoredCrowd {
  symbol: string
  time: number
  /** +1 for a market crowded long, -1 for one crowded short. */
  crowd: Side
  /** The bracket against the crowd and with it, net and less the usual. */
  against: number | null
  with: number | null
  againstExcess: number | null
  withExcess: number | null
  /** The plain move against the crowd at each horizon, less the pair's drift. */
  moves: (number | null)[]
}

const events: ScoredEvent[] = []
const crowds: ScoredCrowd[] = []
const notes: string[] = []
/** MODE=freq: every reading at an event, by type, facing the move; and the unsigned accounts lean
 * and premium at every fifth minute, for the crowding thresholds. */
const atEvents: Record<EventType, Record<ReadingKey, number[]>> = {
  breakout: { positionsAdded: [], accountsLean: [], topLean: [], takerLift: [], premium: [] },
  breakdown: { positionsAdded: [], accountsLean: [], topLean: [], takerLift: [], premium: [] }
}
const everywhere = { accountsLean: [] as number[], premium: [] as number[] }
/** MODE=freq: per pair, the unsigned accounts lean and premium at every minute not in an event's
 * aftermath, for counting how often each candidate crowding threshold fires. */
const minutesByPair: { symbol: string; days: number; times: Float64Array; lean: Float64Array; premium: Float64Array; bars: Candle[] }[] = []

if (MODE === 'study' && (SPLITS === null || CROWDED === null)) throw new Error('MODE=study needs SPLITS and CROWDED fixed from MODE=freq first')

for (const symbol of set.symbols) {
  const started = Date.now()
  const bars = loadCandles(symbol)
  const positioning = loadPositioning(symbol)
  const raised = detectEvents(bars, { floor: 'candidate' })
  const directional = raised.filter((event) => event.direction !== 'none')
  const typed = directional.filter((event): event is EventReading & { type: EventType } => event.type === 'breakout' || event.type === 'breakdown')
  const days = (bars[bars.length - 1].time - bars[EVENT_LOOKBACK_BARS - 1].time) / 86_400
  const eventTimes = raised.map((event) => event.time)
  /** Any event executed in [from - seconds, from]: a crowd seen then is that event's aftermath. */
  const eventWithin = (from: number, seconds: number): boolean => {
    let lo = 0
    let hi = eventTimes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (eventTimes[mid] < from - seconds) lo = mid + 1
      else hi = mid
    }
    return lo < eventTimes.length && eventTimes[lo] <= from
  }

  const indexByTime = new Map<number, number>()
  bars.forEach((bar, i) => indexByTime.set(bar.time, i))

  // The usual: the same bracket at every fifteenth minute, each side; and the pair's drift.
  const usual = { '1': [] as number[], '-1': [] as number[] }
  const drifts: number[][] = HORIZONS.map(() => [])
  if (MODE === 'study') {
    for (let i = EVENT_LOOKBACK_BARS - 1; i + ENTRY_DELAY_BARS + HOLD_BARS < bars.length; i += 15) {
      const reading = readEventAt(bars, i)
      if (reading === null) continue
      for (const side of [1, -1] as Side[]) {
        const net = bracket(bars, i + ENTRY_DELAY_BARS, side, reading.sigma15Pct)
        if (net !== null) usual[side === 1 ? '1' : '-1'].push(net)
      }
      HORIZONS.forEach((horizon, h) => {
        const move = forward(bars, i + ENTRY_DELAY_BARS, 1, horizon)
        if (move !== null) drifts[h].push(move)
      })
    }
  }
  const usualOf = (side: Side): number => mean(usual[side === 1 ? '1' : '-1'])
  const drift = drifts.map((values) => mean(values))

  let covered = 0
  for (const event of typed) {
    const index = indexByTime.get(event.barTime)
    if (index === undefined) continue
    const side: Side = event.direction === 'up' ? 1 : -1
    const reading = facingTheMove(readPositioningAt(positioning, event.time), side)
    if (READINGS.every((key) => Number.isFinite(reading[key]))) covered++
    if (covered <= SHOW && READINGS.every((key) => Number.isFinite(reading[key]))) {
      console.log(`SHOW ${symbol} ${event.time} ${event.type} side ${side} ${READINGS.map((key) => `${key}=${reading[key].toFixed(6)}`).join(' ')}`)
    }
    if (MODE !== 'study') {
      for (const key of READINGS) if (Number.isFinite(reading[key])) atEvents[event.type][key].push(reading[key])
      continue
    }
    const entryIndex = index + ENTRY_DELAY_BARS
    const follow = bracket(bars, entryIndex, side, event.sigma15Pct)
    const fade = bracket(bars, entryIndex, side === 1 ? -1 : 1, event.sigma15Pct)
    events.push({
      symbol,
      time: event.time,
      type: event.type,
      reading,
      follow,
      fade,
      followExcess: follow === null ? null : follow - usualOf(side),
      fadeExcess: fade === null ? null : fade - usualOf(side === 1 ? -1 : 1)
    })
  }

  // Every minute's unsigned accounts lean and premium, outside an event's aftermath.
  const first = EVENT_LOOKBACK_BARS - 1
  const count = bars.length - first
  const minuteTimes = new Float64Array(count)
  const minuteLean = new Float64Array(count).fill(NaN)
  const minutePremium = new Float64Array(count).fill(NaN)
  for (let i = first; i < bars.length; i++) {
    const now = bars[i].time + 60
    minuteTimes[i - first] = now
    if (eventWithin(now, CROWD_COOLDOWN_SECONDS)) continue
    const reading = readPositioningAt(positioning, now)
    minuteLean[i - first] = reading.accountsLean
    minutePremium[i - first] = reading.premium
    if (MODE !== 'study' && (i - first) % 5 === 0) {
      if (Number.isFinite(reading.accountsLean)) everywhere.accountsLean.push(reading.accountsLean)
      if (Number.isFinite(reading.premium)) everywhere.premium.push(reading.premium)
    }
  }

  const other = raised.length - typed.length
  notes.push(
    `${symbol}: ${days.toFixed(0)} days; ${typed.length} breakouts and breakdowns at candidate or above (${(typed.length / days).toFixed(2)} a day)` +
      `${other ? `, and ${other} other events` : ''}; all five readings on ${covered} of them; ${((Date.now() - started) / 1000).toFixed(0)}s`
  )

  if (MODE !== 'study') {
    minutesByPair.push({ symbol, days, times: minuteTimes, lean: minuteLean, premium: minutePremium, bars })
    continue
  }

  // A crowded market, below candidate and not in an event's aftermath, once per side per half hour.
  const crowded = CROWDED as Crowding
  const last = { '1': -Infinity, '-1': -Infinity }
  for (let j = 0; j < count; j++) {
    const lean = minuteLean[j]
    const premium = minutePremium[j]
    if (!Number.isFinite(lean) || !Number.isFinite(premium)) continue
    const crowd: Side | 0 =
      lean >= crowded.long.accountsLean && premium >= crowded.long.premium ? 1 : lean <= crowded.short.accountsLean && premium <= crowded.short.premium ? -1 : 0
    if (crowd === 0) continue
    const now = minuteTimes[j]
    const key = crowd === 1 ? '1' : '-1'
    if (now - last[key] < CROWD_COOLDOWN_SECONDS) continue
    const i = j + first
    const eventReading = readEventAt(bars, i)
    if (eventReading === null || isAtLeast(eventReading.band, 'candidate')) continue
    if (i + ENTRY_DELAY_BARS + HOLD_BARS >= bars.length) continue
    last[key] = now
    const against: Side = crowd === 1 ? -1 : 1
    const withIt: Side = crowd
    const a = bracket(bars, i + ENTRY_DELAY_BARS, against, eventReading.sigma15Pct)
    const w = bracket(bars, i + ENTRY_DELAY_BARS, withIt, eventReading.sigma15Pct)
    crowds.push({
      symbol,
      time: now,
      crowd,
      against: a,
      with: w,
      againstExcess: a === null ? null : a - usualOf(against),
      withExcess: w === null ? null : w - usualOf(withIt),
      moves: HORIZONS.map((horizon, h) => {
        const move = forward(bars, i + ENTRY_DELAY_BARS, against, horizon)
        return move === null ? null : move - against * drift[h]
      })
    })
  }
  notes.push(`  ${symbol} the usual bracket: long ${f(usualOf(1))}%, short ${f(usualOf(-1))}%; crowded long ${crowds.filter((c) => c.symbol === symbol && c.crowd === 1).length}, crowded short ${crowds.filter((c) => c.symbol === symbol && c.crowd === -1).length}`)
}

console.log(`SET=${SET}: ${set.symbols.join(', ')}`)
for (const line of notes) console.log(line)

if (MODE !== 'study') {
  const PERCENTS = [10, 25, 50, 75, 90]
  console.log('\n--- each reading at an event, facing the move (positions added as it is): percentiles 10/25/50/75/90 ---')
  for (const type of EVENT_TYPES) {
    for (const key of READINGS) {
      const sorted = sortedFinite(atEvents[type][key])
      console.log(`${type.padEnd(10)} ${READING_NAMES[key].padEnd(38)} n=${String(sorted.length).padStart(5)}  ${PERCENTS.map((p) => f(quantile(sorted, p), 4).padStart(9)).join(' ')}`)
    }
  }

  console.log('\n--- the market at every fifth minute, outside events: unsigned accounts lean and premium ---')
  const leanSorted = sortedFinite(everywhere.accountsLean)
  const premiumSorted = sortedFinite(everywhere.premium)
  const TAILS = [0.5, 1, 2.5, 5, 10, 50, 90, 95, 97.5, 99, 99.5]
  console.log(`accounts lean, pts   n=${leanSorted.length}  ${TAILS.map((p) => `${p}%:${f(quantile(leanSorted, p), 2)}`).join('  ')}`)
  console.log(`premium, %           n=${premiumSorted.length}  ${TAILS.map((p) => `${p}%:${f(quantile(premiumSorted, p), 4)}`).join('  ')}`)

  console.log('\n--- how often a crowded market is seen, a pair a day, at each candidate threshold (both readings past their percentile, the same way) ---')
  for (const p of [90, 95, 97.5, 99, 99.5]) {
    const long = { accountsLean: quantile(leanSorted, p), premium: quantile(premiumSorted, p) }
    const short = { accountsLean: quantile(leanSorted, 100 - p), premium: quantile(premiumSorted, 100 - p) }
    const rates = minutesByPair.map(({ symbol, days, times, lean, premium, bars }) => {
      const last = { '1': -Infinity, '-1': -Infinity }
      const fired = { '1': 0, '-1': 0 }
      for (let j = 0; j < times.length; j++) {
        if (!Number.isFinite(lean[j]) || !Number.isFinite(premium[j])) continue
        const crowd = lean[j] >= long.accountsLean && premium[j] >= long.premium ? '1' : lean[j] <= short.accountsLean && premium[j] <= short.premium ? '-1' : null
        if (crowd === null || times[j] - last[crowd] < CROWD_COOLDOWN_SECONDS) continue
        const reading = readEventAt(bars, j + EVENT_LOOKBACK_BARS - 1)
        if (reading === null || isAtLeast(reading.band, 'candidate')) continue
        last[crowd] = times[j]
        fired[crowd]++
      }
      return `${symbol} long ${(fired['1'] / days).toFixed(2)} short ${(fired['-1'] / days).toFixed(2)}`
    })
    console.log(
      `${String(p).padStart(4)}th: long at lean >= ${f(long.accountsLean, 3)} and premium >= ${f(long.premium, 5)}; short at lean <= ${f(short.accountsLean, 3)} and premium <= ${f(short.premium, 5)}`
    )
    console.log(`        ${rates.join('  |  ')}`)
  }
} else {
  const splits = SPLITS as Splits
  type Row = { time: number; value: number }
  const pick = (rows: ScoredEvent[], key: 'follow' | 'fade' | 'followExcess' | 'fadeExcess'): Row[] =>
    rows.filter((row) => row[key] !== null).map((row) => ({ time: row.time, value: row[key] as number }))

  console.log(`\n--- the bracket: stop ${STOP_SIGMAS} and target ${TARGET_SIGMAS} usual fifteen-minute moves away, ${HOLD_BARS} minutes at most, entered ${ENTRY_DELAY_BARS} bars after the reading,`)
  console.log(`    ${ROUND_TRIP_FEE_PCT.toFixed(2)}% fees and ${(set.slippage * 100).toFixed(2)}% slippage a market fill; "vs usual" is less the same bracket at every fifteenth minute ---`)
  for (const type of EVENT_TYPES) {
    const rows = events.filter((row) => row.type === type)
    console.log(`\n${type}, every event`)
    for (const side of ['follow', 'fade'] as const) {
      console.log('  ' + summarise(`${side}, net`, pick(rows, side)))
      console.log('  ' + summarise(`${side}, vs usual`, pick(rows, side === 'follow' ? 'followExcess' : 'fadeExcess')))
    }
  }

  console.log('\n--- split by each reading at its fixed point: below it (low) and at or above it (high) ---')
  for (const type of EVENT_TYPES) {
    for (const key of READINGS) {
      const at = splits[key][type]
      const withReading = events.filter((row) => row.type === type && Number.isFinite(row.reading[key]))
      const low = withReading.filter((row) => row.reading[key] < at)
      const high = withReading.filter((row) => row.reading[key] >= at)
      console.log(`\n${type} / ${READING_NAMES[key]}, split at ${f(at, 4)} (${events.filter((row) => row.type === type).length - withReading.length} events without it)`)
      for (const side of ['follow', 'fade'] as const) {
        const excess = side === 'follow' ? 'followExcess' : 'fadeExcess'
        console.log('  ' + summarise(`${side}, low half, net`, pick(low, side)))
        console.log('  ' + summarise(`${side}, low half, vs usual`, pick(low, excess)))
        console.log('  ' + summarise(`${side}, high half, net`, pick(high, side)))
        console.log('  ' + summarise(`${side}, high half, vs usual`, pick(high, excess)))
        const { d, t } = difference(pick(high, excess), pick(low, excess))
        console.log(`  ${`${side}, high less low, vs usual`.padEnd(40)} ${f(d)}%  t=${f(t, 1)}`)
      }
    }
  }

  console.log('\n--- a crowded market, below candidate and outside an event\'s aftermath ---')
  for (const crowd of [1, -1] as Side[]) {
    const rows = crowds.filter((row) => row.crowd === crowd)
    const name = crowd === 1 ? 'crowded long' : 'crowded short'
    const as = (key: 'against' | 'with' | 'againstExcess' | 'withExcess'): Row[] =>
      rows.filter((row) => row[key] !== null).map((row) => ({ time: row.time, value: row[key] as number }))
    console.log(`\n${name}: ${rows.length} seen`)
    console.log('  ' + summarise('against the crowd, net', as('against')))
    console.log('  ' + summarise('against the crowd, vs usual', as('againstExcess')))
    console.log('  ' + summarise('with the crowd, net', as('with')))
    console.log('  ' + summarise('with the crowd, vs usual', as('withExcess')))
    HORIZONS.forEach((horizon, h) => {
      const moves = rows.filter((row) => row.moves[h] !== null).map((row) => ({ time: row.time, value: row.moves[h] as number }))
      console.log('  ' + summarise(`plain move against it, +${horizon}m, less drift`, moves))
    })
  }
}
