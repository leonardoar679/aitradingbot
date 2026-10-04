import { readFileSync } from 'fs'
import { join } from 'path'
import { FEE_RATE } from '../shared/fees'
import type { Candle } from '../shared/ipc'
import { EVENT_LOOKBACK_BARS, detectEvents, readEventAt, type EventBand, type EventReading, type MarketEventType } from '../shared/marketEvent'

// What follows an event? See research/EVENTS.md for the question, the rule and the result.
//
//   npx esbuild research/events.ts --bundle --platform=node --format=esm --outfile=research/.events.mjs
//   CANDLE_DIR=.candles MODE=freq  SET=discovery node --max-old-space-size=4096 research/.events.mjs
//   CANDLE_DIR=.candles MODE=study SET=discovery node --max-old-space-size=4096 research/.events.mjs
//
// MODE=freq counts events and prints nothing about what followed them. It exists so that the
// thresholds could be looked at -- how often does each band fire? -- without looking at a single
// outcome. MODE=study scores them.

const DIR = process.env.CANDLE_DIR as string
const MODE = process.env.MODE ?? 'freq'
const SET = process.env.SET ?? 'discovery'

interface PairSet {
  /** Sub-directory of CANDLE_DIR. */
  dir: string
  symbols: string[]
  /** Charged on every market fill, on top of the fee. Larger for the smaller pairs: a stated
   * assumption, not a measurement, since a historical spread is not in a candle. */
  slippage: number
}

const SMALL = ['STRKUSDT', 'FETUSDT', 'SUPERUSDT', 'AXSUSDT', 'RAYUSDT', 'DOTUSDT', 'ICPUSDT', 'ARKUSDT']
const SETS: Record<string, PairSet> = {
  discovery: { dir: '', symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'], slippage: 0.0002 },
  confirm: { dir: '', symbols: ['BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT'], slippage: 0.0002 },
  small: { dir: 'flow', symbols: SMALL, slippage: 0.0005 },
  // The taker-flow question is asked on the smaller pairs only, the ones downloaded with that
  // column: found on the first four, confirmed on the last four.
  'flow-a': { dir: 'flow', symbols: SMALL.slice(0, 4), slippage: 0.0005 },
  'flow-b': { dir: 'flow', symbols: SMALL.slice(4), slippage: 0.0005 }
}

const set = SETS[SET]
if (!set) throw new Error(`unknown SET ${SET}`)

interface Series {
  bars: Candle[]
  /** Taker-buy volume per bar in base units, when the file carries it. */
  takerBuy: Float64Array | null
}

function load(symbol: string): Series {
  const raw = JSON.parse(readFileSync(join(DIR, set.dir, `${symbol}-1m.json`), 'utf-8')) as number[][]
  const hasFlow = raw.length > 0 && raw[0].length >= 7
  const takerBuy = hasFlow ? new Float64Array(raw.length) : null
  const bars = raw.map((r, i) => {
    if (takerBuy) takerBuy[i] = r[6]
    return { time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }
  })
  return { bars, takerBuy }
}

// ---------------------------------------------------------------------------------------------
// The trade every event is scored by. Fixed here, in advance, and the same for every pair.

/** Bars between the reading and the entry: the bar the call executes on is skipped, so a fill is
 * a whole minute after the last price the detector saw. A model's answer takes seconds; a person
 * takes longer. Nothing here is filled at a price it had already seen. */
const ENTRY_DELAY_BARS = 2
const STOP_SIGMAS = 1.5
const TARGET_SIGMAS = 3
const HOLD_BARS = 60
const HORIZONS = [5, 15, 30, 60, 240, 1440]
const ROUND_TRIP_FEE_PCT = FEE_RATE * 2 * 100

/** Net percent return of one bracketed trade, or null when the candles run out before it ends.
 * `side` is +1 for a long and -1 for a short. A bar touching both levels counts as the stop. */
function bracket(bars: Candle[], entryIndex: number, side: 1 | -1, sigma15Pct: number): number | null {
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
      // A bar that opens beyond the stop fills at its open, not at a stop it never traded at.
      const level = side > 0 ? Math.min(stop, bar.open) : Math.max(stop, bar.open)
      return net(level * (1 - side * set.slippage))
    }
    const reached = side > 0 ? bar.high >= target : bar.low <= target
    if (reached) return net(target)
  }
  return net(bars[entryIndex + HOLD_BARS - 1].close * (1 - side * set.slippage))
}

/** The plain move from the entry to the close `horizon` bars later, signed by `side`, before any
 * cost. Null when the candles run out. */
function forward(bars: Candle[], entryIndex: number, side: 1 | -1, horizon: number): number | null {
  const later = bars[entryIndex + horizon - 1]
  return later === undefined ? null : side * (later.close / bars[entryIndex].open - 1) * 100
}

// ---------------------------------------------------------------------------------------------

interface Scored {
  symbol: string
  time: number
  type: MarketEventType
  band: EventBand
  /** Net bracket return taking the event's side, and taking the other one. Null for an event with
   * no direction, which has no side to take. */
  follow: number | null
  fade: number | null
  /** The same two, less what that pair's bracket earned at arbitrary times on that side. */
  followExcess: number | null
  fadeExcess: number | null
  /** Signed plain move at each horizon, in the event's direction. */
  forward: (number | null)[]
  /** The same, less what holding that side of that pair for that long earned at arbitrary times. */
  forwardExcess: (number | null)[]
  /** Candle-only pressure in the event's direction, -1..1. */
  pressure: number
  /** Taker-buy share of the last five bars in the event's direction, 0..1. Null without the column. */
  flow: number | null
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

/** Events in the same hour are one observation, not several: when the whole market moves, four
 * pairs raise an event in the same minute and their outcomes are nearly one outcome. Every t
 * below is computed on these hourly means, never on the raw events. */
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

/** `mean` is the mean of the hourly means, which is what `t` tests; `per event` is the plain
 * average over events, which is what an account taking every one of them would have earned. The
 * two differ when the hours with many events did differently from the hours with one. */
function summarise(label: string, rows: { time: number; value: number }[]): string {
  if (rows.length < 30) return `${label.padEnd(30)} n=${String(rows.length).padStart(6)}  (too few)`
  const clusters = clustered(rows)
  const wins = rows.filter((row) => row.value > 0).length
  return (
    `${label.padEnd(30)} n=${String(rows.length).padStart(6)}  hours=${String(clusters.length).padStart(6)}` +
    `  mean=${f(mean(clusters))}%  t=${f(tStat(clusters), 1).padStart(6)}` +
    `  per event=${f(mean(rows.map((row) => row.value)))}%  win=${((wins / rows.length) * 100).toFixed(0).padStart(3)}%`
  )
}

const BANDS: EventBand[] = ['watch', 'candidate', 'urgent']
const TYPES: MarketEventType[] = ['pump', 'breakout', 'dump', 'breakdown', 'volume_spike']

const all: Scored[] = []
const days: Record<string, number> = {}
const counts: Record<string, Record<string, number>> = {}

for (const symbol of set.symbols) {
  const started = Date.now()
  const { bars, takerBuy } = load(symbol)
  const events = detectEvents(bars, { floor: 'watch' })
  days[symbol] = (bars[bars.length - 1].time - bars[EVENT_LOOKBACK_BARS - 1].time) / 86_400
  counts[symbol] = {}
  for (const event of events) counts[symbol][`${event.band}:${event.type}`] = (counts[symbol][`${event.band}:${event.type}`] ?? 0) + 1
  console.error(`${symbol}: ${bars.length} bars, ${days[symbol].toFixed(0)} days, ${events.length} events, ${((Date.now() - started) / 1000).toFixed(0)}s`)
  if (MODE !== 'study') continue

  const indexByTime = new Map<number, number>()
  bars.forEach((bar, i) => indexByTime.set(bar.time, i))

  // What the same bracket earned at arbitrary times on this pair, each side: every fifteenth
  // minute of the whole series. An event's result means nothing until this is taken off it.
  const baseline = { long: [] as number[], short: [] as number[] }
  const drifts: number[][] = HORIZONS.map(() => [])
  for (let i = EVENT_LOOKBACK_BARS - 1; i + ENTRY_DELAY_BARS + HOLD_BARS < bars.length; i += 15) {
    const reading = readEventAt(bars, i)
    if (reading === null) continue
    const long = bracket(bars, i + ENTRY_DELAY_BARS, 1, reading.sigma15Pct)
    const short = bracket(bars, i + ENTRY_DELAY_BARS, -1, reading.sigma15Pct)
    if (long !== null) baseline.long.push(long)
    if (short !== null) baseline.short.push(short)
    HORIZONS.forEach((horizon, h) => {
      const move = forward(bars, i + ENTRY_DELAY_BARS, 1, horizon)
      if (move !== null) drifts[h].push(move)
    })
  }
  const usual = { long: mean(baseline.long), short: mean(baseline.short) }
  /** What simply holding the pair for each horizon earned, on average. */
  const drift = drifts.map(mean)
  console.error(`  ${symbol} baseline bracket: long ${f(usual.long)}%  short ${f(usual.short)}%  (${baseline.long.length} samples)`)
  console.error(`  ${symbol} drift: ${HORIZONS.map((horizon, h) => `+${horizon}m ${f(drift[h])}%`).join('  ')}`)

  for (const event of events as (EventReading & { type: MarketEventType })[]) {
    const index = indexByTime.get(event.barTime)
    if (index === undefined) continue
    const entryIndex = index + ENTRY_DELAY_BARS
    const side: 1 | -1 | 0 = event.direction === 'up' ? 1 : event.direction === 'down' ? -1 : 0
    const follow = side === 0 ? null : bracket(bars, entryIndex, side, event.sigma15Pct)
    const fade = side === 0 ? null : bracket(bars, entryIndex, side === 1 ? -1 : 1, event.sigma15Pct)
    let flow: number | null = null
    if (takerBuy && side !== 0) {
      let buy = 0
      let total = 0
      for (let i = index - 4; i <= index; i++) {
        buy += takerBuy[i]
        total += bars[i].volume
      }
      if (total > 0) flow = side === 1 ? buy / total : 1 - buy / total
    }
    all.push({
      symbol,
      time: event.time,
      type: event.type,
      band: event.band,
      follow,
      fade,
      followExcess: follow === null ? null : follow - (side === 1 ? usual.long : usual.short),
      fadeExcess: fade === null ? null : fade - (side === 1 ? usual.short : usual.long),
      forward: HORIZONS.map((horizon) => forward(bars, entryIndex, side === 0 ? 1 : side, horizon)),
      forwardExcess: HORIZONS.map((horizon, h) => {
        const move = forward(bars, entryIndex, side === 0 ? 1 : side, horizon)
        return move === null ? null : move - (side === 0 ? 1 : side) * drift[h]
      }),
      pressure: side === 0 ? 0 : side * event.pressure,
      flow
    })
  }
}

console.log(`\n===== SET ${SET}: ${set.symbols.join(' ')} =====`)
console.log('\n--- how often each band fires, per pair per day ---')
for (const symbol of set.symbols) {
  const perDay = (band: EventBand): string =>
    (TYPES.reduce((sum, type) => sum + (counts[symbol][`${band}:${type}`] ?? 0), 0) / days[symbol]).toFixed(2).padStart(6)
  console.log(`${symbol.padEnd(10)} watch ${perDay('watch')}  candidate ${perDay('candidate')}  urgent ${perDay('urgent')}`)
}
console.log('\n--- events by type and band, whole set ---')
for (const type of TYPES) {
  const row = BANDS.map((band) => String(set.symbols.reduce((sum, symbol) => sum + (counts[symbol][`${band}:${type}`] ?? 0), 0)).padStart(7)).join(' ')
  console.log(`${type.padEnd(13)} watch/candidate/urgent ${row}`)
}

if (MODE === 'study') {
  const pick = (rows: Scored[], key: 'follow' | 'fade' | 'followExcess' | 'fadeExcess'): { time: number; value: number }[] =>
    rows.filter((row) => row[key] !== null).map((row) => ({ time: row.time, value: row[key] as number }))

  console.log(`\n--- the bracket: stop ${STOP_SIGMAS} and target ${TARGET_SIGMAS} usual fifteen-minute moves away, ${HOLD_BARS} minutes at most,`)
  console.log(`    entered ${ENTRY_DELAY_BARS} bars after the reading, ${ROUND_TRIP_FEE_PCT.toFixed(2)}% fees and ${(set.slippage * 100).toFixed(2)}% slippage a market fill ---`)
  for (const type of TYPES.filter((entry) => entry !== 'volume_spike')) {
    for (const band of BANDS) {
      const rows = all.filter((row) => row.type === type && row.band === band)
      console.log(`\n${type} / ${band}`)
      console.log('  ' + summarise('follow, net', pick(rows, 'follow')))
      console.log('  ' + summarise('follow, less the usual', pick(rows, 'followExcess')))
      console.log('  ' + summarise('fade, net', pick(rows, 'fade')))
      console.log('  ' + summarise('fade, less the usual', pick(rows, 'fadeExcess')))
    }
  }

  // The rows research/EVENTS.md fixes its rule on, each over candidate and urgent together.
  console.log('\n--- the rule: at candidate or above ---')
  for (const type of ['breakout', 'breakdown', 'volume_spike'] as const) {
    const rows = all.filter((row) => row.type === type && row.band !== 'watch')
    console.log(`\n${type}`)
    console.log('  ' + summarise('follow, net', pick(rows, 'follow')))
    console.log('  ' + summarise('follow, less the usual', pick(rows, 'followExcess')))
    console.log('  ' + summarise('fade, net', pick(rows, 'fade')))
    console.log('  ' + summarise('fade, less the usual', pick(rows, 'fadeExcess')))
    HORIZONS.forEach((horizon, h) => {
      const moves = rows.filter((row) => row.forwardExcess[h] !== null).map((row) => ({ time: row.time, value: row.forwardExcess[h] as number }))
      console.log('  ' + summarise(`plain move +${horizon}m`, moves))
    })
  }

  console.log("\n--- the plain move after the entry, in the event's direction, before costs, less the pair's own drift ---")
  for (const type of TYPES) {
    for (const band of BANDS) {
      const rows = all.filter((row) => row.type === type && row.band === band)
      if (rows.length < 30) continue
      console.log(`\n${type} / ${band}`)
      HORIZONS.forEach((horizon, h) => {
        const moves = rows.filter((row) => row.forwardExcess[h] !== null).map((row) => ({ time: row.time, value: row.forwardExcess[h] as number }))
        console.log('  ' + summarise(`+${horizon}m`, moves))
      })
    }
  }

  if (all.some((row) => row.flow !== null)) {
    console.log('\n--- does taker flow say anything the candle-only pressure does not? ---')
    console.log('    events at candidate or above with a direction; follow bracket, net; split at the median of each reading')
    const rows = all.filter((row) => row.follow !== null && row.flow !== null && row.band !== 'watch')
    const split = (label: string, key: 'flow' | 'pressure'): void => {
      const sorted = [...rows].sort((a, b) => (a[key] as number) - (b[key] as number))
      const half = Math.floor(sorted.length / 2)
      const low = sorted.slice(0, half).map((row) => ({ time: row.time, value: row.follow as number }))
      const high = sorted.slice(half).map((row) => ({ time: row.time, value: row.follow as number }))
      const a = clustered(high)
      const b = clustered(low)
      const variance = (xs: number[]): number => {
        const m = mean(xs)
        return xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1)
      }
      const difference = mean(a) - mean(b)
      const t = difference / Math.sqrt(variance(a) / a.length + variance(b) / b.length)
      console.log(`  ${label.padEnd(22)} high half ${f(mean(high.map((row) => row.value)))}%  low half ${f(mean(low.map((row) => row.value)))}%  difference t=${f(t, 1)}  (n=${rows.length})`)
    }
    split('taker flow', 'flow')
    split('candle-only pressure', 'pressure')
  }
}
