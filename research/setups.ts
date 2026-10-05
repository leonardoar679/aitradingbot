import { readFileSync } from 'fs'
import { join } from 'path'
import { FEE_RATE } from '../shared/fees'
import type { Candle } from '../shared/ipc'
import { EVENT_LOOKBACK_BARS, detectEvents, isAtLeast, readEventAt, type EventReading } from '../shared/marketEvent'

// Does anything come BEFORE an event? See research/SETUPS.md for the question, the rule and the
// result.
//
//   npx esbuild research/setups.ts --bundle --platform=node --format=esm --outfile=research/.setups.mjs
//   CANDLE_DIR=.candles MODE=freq  SET=discovery node --max-old-space-size=4096 research/.setups.mjs
//   CANDLE_DIR=.candles MODE=study SET=discovery node --max-old-space-size=4096 research/.setups.mjs
//
// MODE=freq counts setups and prints nothing about what followed them: the thresholds below were
// set by how often each setup fires, before a single outcome was looked at. MODE=study scores them.

const DIR = process.env.CANDLE_DIR as string
const MODE = process.env.MODE ?? 'freq'
const SET = process.env.SET ?? 'discovery'

interface PairSet {
  dir: string
  symbols: string[]
  slippage: number
}

// The sets research/EVENTS.md used, with the same roles: the four discovery pairs are the only
// ones looked at before the rule in SETUPS.md was written down.
const SMALL = ['STRKUSDT', 'FETUSDT', 'SUPERUSDT', 'AXSUSDT', 'RAYUSDT', 'DOTUSDT', 'ICPUSDT', 'ARKUSDT']
const SETS: Record<string, PairSet> = {
  discovery: { dir: '', symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'], slippage: 0.0002 },
  confirm: { dir: '', symbols: ['BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT'], slippage: 0.0002 },
  small: { dir: 'flow', symbols: SMALL, slippage: 0.0005 }
}
const set = SETS[SET]
if (!set) throw new Error(`unknown SET ${SET}`)

function load(symbol: string): Candle[] {
  const raw = JSON.parse(readFileSync(join(DIR, set.dir, `${symbol}-1m.json`), 'utf-8')) as number[][]
  return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
}

// ---------------------------------------------------------------------------------------------
// The two setups. Fixed formulas on the same reading the detector takes, from bars up to the one
// the reading is at and nothing after it. Their scales were set in MODE=freq, by how often each
// fires, before any outcome was looked at.

/** A coil: the last hour's whole range, high to low, at most this many of the pair's usual
 * fifteen-minute moves. An hour of an ordinary market spans about three. */
const COIL_RANGE_SIGMAS = 1.5
const COIL_BARS = 60
/** Pressed against the four-hour high (or low): the close within this many usual moves of it,
 * and not beyond it -- beyond it is a break, which is an event's business. */
const NEAR_SIGMAS = 0.5
const FOUR_HOURS = 240
/** An early move: a fifteen-minute move of at least this many usual moves, the last five minutes
 * trading at least this many times the usual, and the last five minutes still going the same way
 * -- while the detector's score is still under candidate. First set at one usual move (the
 * detector's own line for a direction) and twice the volume, which fired twelve to fourteen times
 * a pair a day, ten times as often as an event; raised to these before any outcome was looked at. */
const EARLY_MOVE_SIGMAS = 1.5
const EARLY_VOLUME_RATIO = 3
/** One setup of a kind and a direction per pair per half hour, as one event is: a coil that lasts
 * forty minutes is one coil. And none within half an hour after an event: what comes after an
 * event is that event's aftermath, not a setup for the next. */
const SETUP_COOLDOWN_SECONDS = 30 * 60

type SetupKind = 'coil' | 'early'
type Side = 1 | -1

/** Which setup, if any, the reading at bar i is, on its own terms (no cooldown). */
function setupsAt(bars: Candle[], i: number, reading: EventReading): { kind: SetupKind; side: Side }[] {
  const found: { kind: SetupKind; side: Side }[] = []
  // Both are about a move that has not yet become an event.
  if (isAtLeast(reading.band, 'candidate')) return found
  const sigma = reading.sigma15Pct
  const close = reading.price

  let hourHigh = -Infinity
  let hourLow = Infinity
  for (let j = i - COIL_BARS + 1; j <= i; j++) {
    if (bars[j].high > hourHigh) hourHigh = bars[j].high
    if (bars[j].low < hourLow) hourLow = bars[j].low
  }
  if (((hourHigh - hourLow) / close) * 100 <= COIL_RANGE_SIGMAS * sigma) {
    let high = -Infinity
    let low = Infinity
    for (let j = i - FOUR_HOURS + 1; j <= i; j++) {
      if (bars[j].high > high) high = bars[j].high
      if (bars[j].low < low) low = bars[j].low
    }
    if (close <= high && ((high - close) / close) * 100 <= NEAR_SIGMAS * sigma) found.push({ kind: 'coil', side: 1 })
    if (close >= low && ((close - low) / close) * 100 <= NEAR_SIGMAS * sigma) found.push({ kind: 'coil', side: -1 })
  }

  if (reading.direction !== 'none' && Math.abs(reading.moveSigmas) >= EARLY_MOVE_SIGMAS && reading.volumeRatio !== null && reading.volumeRatio >= EARLY_VOLUME_RATIO) {
    const side: Side = reading.direction === 'up' ? 1 : -1
    if (Math.sign(reading.returnsPct.m5) === side) found.push({ kind: 'early', side })
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// How a setup is scored: the bracket research/EVENTS.md scored events by, unchanged.

const ENTRY_DELAY_BARS = 2
const STOP_SIGMAS = 1.5
const TARGET_SIGMAS = 3
const HOLD_BARS = 60
const ROUND_TRIP_FEE_PCT = FEE_RATE * 2 * 100
/** "An event follows": one at candidate or above, in the setup's direction, raised by the
 * detector's own rule within this long after the setup's reading. */
const WINDOWS_MIN = [30, 60]

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

function mean(xs: number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length
}

function tStat(xs: number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  const variance = xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1)
  return m / Math.sqrt(variance / xs.length)
}

/** As in research/events.ts: observations in the same hour are one observation, and every t is
 * computed on hourly means. */
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

const f = (value: number, digits = 3): string => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}` : 'n/a')

function summarise(label: string, rows: { time: number; value: number }[], unit = '%'): string {
  if (rows.length < 30) return `${label.padEnd(34)} n=${String(rows.length).padStart(6)}  (too few)`
  const clusters = clustered(rows)
  return (
    `${label.padEnd(34)} n=${String(rows.length).padStart(6)}  hours=${String(clusters.length).padStart(6)}` +
    `  mean=${f(mean(clusters))}${unit}  t=${f(tStat(clusters), 1).padStart(6)}  per setup=${f(mean(rows.map((row) => row.value)))}${unit}`
  )
}

// ---------------------------------------------------------------------------------------------

interface Scored {
  symbol: string
  time: number
  kind: SetupKind
  side: Side
  /** 1 when an event in the setup's direction followed within each window, 0 when none did; less
   * the same pair's rate after arbitrary minutes, for the excess. */
  followed: number[]
  followedExcess: number[]
  /** The bracket in the setup's direction, and that less the same bracket at arbitrary minutes. */
  net: number | null
  excess: number | null
}

const all: Scored[] = []
const baseRates: string[] = []

for (const symbol of set.symbols) {
  const started = Date.now()
  const bars = load(symbol)
  const events = detectEvents(bars, { floor: 'candidate' }).filter((event) => event.direction !== 'none')
  const days = (bars[bars.length - 1].time - bars[EVENT_LOOKBACK_BARS - 1].time) / 86_400

  // Every event's execution time, by direction, for "did one follow?".
  const eventTimes: Record<string, number[]> = { up: [], down: [] }
  for (const event of events) eventTimes[event.direction].push(event.time)
  const anyEventTimes = events.map((event) => event.time)
  const followedWithin = (times: number[], from: number, minutes: number): number => {
    // Execution times strictly after the setup's own, and no later than the window's end.
    let lo = 0
    let hi = times.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (times[mid] <= from) lo = mid + 1
      else hi = mid
    }
    return lo < times.length && times[lo] <= from + minutes * 60 ? 1 : 0
  }
  const eventWithin = (from: number, seconds: number): boolean => {
    // Any event executed in [from - seconds, from]: the setup would be its aftermath.
    let lo = 0
    let hi = anyEventTimes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (anyEventTimes[mid] < from - seconds) lo = mid + 1
      else hi = mid
    }
    return lo < anyEventTimes.length && anyEventTimes[lo] <= from
  }

  const lastSetup = new Map<string, number>()
  const found: Omit<Scored, 'followedExcess' | 'excess'>[] = []
  // Arbitrary minutes held to the same terms as a setup -- below candidate, not in an event's
  // aftermath -- for the rate at which an event follows one anyway. Every fifteenth minute.
  const arbitrary: Record<string, number[][]> = { '1': WINDOWS_MIN.map(() => []), '-1': WINDOWS_MIN.map(() => []) }
  // The same bracket at every fifteenth minute, each side: the usual, as in research/EVENTS.md.
  const usual: Record<string, number[]> = { '1': [], '-1': [] }

  for (let i = Math.max(EVENT_LOOKBACK_BARS - 1, FOUR_HOURS); i + ENTRY_DELAY_BARS + HOLD_BARS < bars.length; i++) {
    const reading = readEventAt(bars, i)
    if (reading === null) continue
    const time = reading.time
    if (i % 15 === 0) {
      for (const side of [1, -1] as Side[]) {
        const net = bracket(bars, i + ENTRY_DELAY_BARS, side, reading.sigma15Pct)
        if (net !== null) usual[String(side)].push(net)
      }
      if (!isAtLeast(reading.band, 'candidate') && !eventWithin(time, SETUP_COOLDOWN_SECONDS)) {
        for (const side of [1, -1] as Side[]) {
          WINDOWS_MIN.forEach((minutes, w) => arbitrary[String(side)][w].push(followedWithin(eventTimes[side > 0 ? 'up' : 'down'], time, minutes)))
        }
      }
    }
    if (eventWithin(time, SETUP_COOLDOWN_SECONDS)) continue
    for (const setup of setupsAt(bars, i, reading)) {
      const key = `${setup.kind}:${setup.side}`
      const previous = lastSetup.get(key)
      if (previous !== undefined && time - previous < SETUP_COOLDOWN_SECONDS) continue
      lastSetup.set(key, time)
      if (MODE !== 'study') {
        found.push({ symbol, time, kind: setup.kind, side: setup.side, followed: [], net: null })
        continue
      }
      found.push({
        symbol,
        time,
        kind: setup.kind,
        side: setup.side,
        followed: WINDOWS_MIN.map((minutes) => followedWithin(eventTimes[setup.side > 0 ? 'up' : 'down'], time, minutes)),
        net: bracket(bars, i + ENTRY_DELAY_BARS, setup.side, reading.sigma15Pct)
      })
    }
  }

  const count = (kind: SetupKind, side: Side): number => found.filter((row) => row.kind === kind && row.side === side).length
  console.error(
    `${symbol}: ${days.toFixed(0)} days, ${events.length} events; a day: coil up ${(count('coil', 1) / days).toFixed(2)}, coil down ${(count('coil', -1) / days).toFixed(2)}, ` +
      `early up ${(count('early', 1) / days).toFixed(2)}, early down ${(count('early', -1) / days).toFixed(2)}, events ${(events.length / days).toFixed(2)} (${((Date.now() - started) / 1000).toFixed(0)}s)`
  )
  if (MODE !== 'study') continue

  const rate = (side: Side, w: number): number => mean(arbitrary[String(side)][w])
  const usualMean = (side: Side): number => mean(usual[String(side)])
  baseRates.push(
    `${symbol}: after an arbitrary minute, an event up within 30/60 min ${(rate(1, 0) * 100).toFixed(2)}% / ${(rate(1, 1) * 100).toFixed(2)}%, down ${(rate(-1, 0) * 100).toFixed(2)}% / ${(rate(-1, 1) * 100).toFixed(2)}%; ` +
      `the bracket at arbitrary minutes ${f(usualMean(1))}% long, ${f(usualMean(-1))}% short`
  )
  for (const row of found) {
    all.push({
      ...row,
      followedExcess: row.followed.map((value, w) => value - rate(row.side, w)),
      excess: row.net === null ? null : row.net - usualMean(row.side)
    })
  }
}

if (MODE === 'study') {
  console.log(`SET=${SET}: ${set.symbols.join(', ')}`)
  for (const line of baseRates) console.log(line)
  console.log('')
  for (const kind of ['coil', 'early'] as SetupKind[]) {
    for (const side of [1, -1] as Side[]) {
      const rows = all.filter((row) => row.kind === kind && row.side === side)
      const name = `${kind} ${side > 0 ? 'up' : 'down'}`
      WINDOWS_MIN.forEach((minutes, w) => {
        const share = rows.length > 0 ? mean(rows.map((row) => row.followed[w])) * 100 : NaN
        const base = rows.length > 0 ? share - mean(rows.map((row) => row.followedExcess[w])) * 100 : NaN
        console.log(
          `${`${name}, event within ${minutes} min`.padEnd(34)} n=${String(rows.length).padStart(6)}  followed=${f(share, 2)}%  arbitrary=${f(base, 2)}%  ratio=${(share / base).toFixed(2)}`
        )
        console.log(summarise(`${name}, ${minutes} min, excess`, rows.map((row) => ({ time: row.time, value: row.followedExcess[w] * 100 })), ' pts'))
      })
      const traded = rows.filter((row) => row.net !== null)
      console.log(summarise(`${name}, bracket net`, traded.map((row) => ({ time: row.time, value: row.net as number }))))
      console.log(summarise(`${name}, bracket vs the usual`, traded.map((row) => ({ time: row.time, value: row.excess as number }))))
      console.log('')
    }
  }
}
