import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Candle } from '../shared/ipc'
import { readEventAt } from '../shared/marketEvent'
import { BRACKET_HOLD_BARS, ENTRY_DELAY_BARS, HOLD_EXIT_BARS, bracketNet, fillMinutes, holdNet } from '../shared/newsRules'

// What an announcement did to the price of each coin it names, on 1-minute candles: the plain moves
// after it, what an app reading once a minute could not have had, and the two trades, each set
// against the same coin's usual minutes.
//
// ONE METHOD FOR EVERY ANNOUNCEMENT STUDY. Written for research/news.ts (Binance's announcements,
// NEWS.md) and moved here unchanged -- its output is the same to the byte -- so that research/upbit.ts
// (Upbit's notices, UPBIT.md) is scored by this code and not by a copy of it. Each study brings its
// own kinds of news, the side each is traded on, and the coins each announcement names.

/** The split, by time. Discovery is everything before 2025; held out is 2025 to the end of
 * September 2026. */
const HELD_OUT_FROM = Date.parse('2025-01-01T00:00:00Z') / 1000
const HELD_OUT_TO = Date.parse('2026-10-01T00:00:00Z') / 1000

export type Side = 1 | -1
export type Market = 'spot' | 'um'

/** A kind of news: the side it is traded on, where its price is read, and what one side of a trade
 * in it is charged in slippage. */
export interface Kind {
  side: Side
  market: Market
  slippage: number
  label: string
}

/** One coin named by one announcement. */
export interface StudyPair<C extends string = string> {
  key: string
  articleId: number
  category: C
  releaseSec: number
  title: string
  ticker: string
  market: Market
  /** The symbols its price may be under, in the order to try them: a perpetual of a cheap coin is
   * often a thousand of it (1000PEPEUSDT), its spot pair not. */
  candidates: string[]
  /** The days whose candles are read: three before the announcement's, its own, and the next. */
  days: string[]
}

function dayOf(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

export function daysAround(sec: number): string[] {
  return [-3, -2, -1, 0, 1].map((offset) => dayOf(sec + offset * 86_400))
}

export function splitOf(sec: number): 'discovery' | 'heldout' | null {
  if (sec < HELD_OUT_FROM) return 'discovery'
  return sec < HELD_OUT_TO ? 'heldout' : null
}

// ---------------------------------------------------------------------------------------------
// Candles, as research/fetch-news-candles.mjs left them.

interface Manifest {
  [key: string]: { status: 'ok'; symbol: string } | { status: 'none'; tried: string[] }
}

/** The days' candles as one series with no holes (shared/newsRules.ts fillMinutes): a minute with
 * no row is carried at the last close, and a hole longer than half an hour cuts the series. */
function loadBars(dir: string, market: Market, symbol: string, days: string[], aroundSec: number): { bars: Candle[]; filled: number } | null {
  const raw: number[][] = []
  for (const day of days) {
    const file = join(dir, 'klines', market, symbol, `${day}.json`)
    if (existsSync(file)) raw.push(...(JSON.parse(readFileSync(file, 'utf-8')) as number[][]))
  }
  if (raw.length === 0) return null
  return fillMinutes(
    raw.map((row) => ({ time: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] })),
    aroundSec
  )
}

// ---------------------------------------------------------------------------------------------
// The trades: the bracket every study here has used (research/EVENTS.md), unchanged, and the
// four-hour hold -- written down after the discovery half of NEWS.md had been seen and before the
// held-out half was (NEWS.md says why, and holds it to a stricter bar). Both are
// shared/newsRules.ts, which the app's record of the rules since the study scores with too.

/** The plain move after the announcement, in minutes. */
const HORIZONS = [1, 5, 15, 60, 240, 1440]
/** "The usual": the same measure at every fifteenth minute of the same pair before the news. */
const USUAL_EVERY_BARS = 15
const LEAST_USUAL_SAMPLES = 96

/** The move from bar `from`'s open to bar `to`'s open, in percent, in the news's direction. */
function move(bars: Candle[], from: number, to: number, side: Side): number | null {
  if (from < 0 || to >= bars.length || !(bars[from].open > 0)) return null
  return side * (bars[to].open / bars[from].open - 1) * 100
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

/** Coins named by one announcement move together, and so do announcements in the same hour: one
 * hour is one observation, and every t is computed on hourly means (as research/events.ts). */
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
  if (rows.length < 5) return `${label.padEnd(40)} n=${String(rows.length).padStart(4)}  (too few)`
  const clusters = clustered(rows)
  return (
    `${label.padEnd(40)} n=${String(rows.length).padStart(4)}  hours=${String(clusters.length).padStart(4)}` +
    `  mean=${f(mean(clusters))}${unit}  t=${f(tStat(clusters), 1).padStart(6)}  per coin=${f(mean(rows.map((row) => row.value)))}${unit}`
  )
}

// ---------------------------------------------------------------------------------------------

interface Scored {
  pair: StudyPair
  symbol: string
  time: number
  /** By horizon: the plain move, and that less the same pair's usual move over as long. */
  moves: (number | null)[]
  movesExcess: (number | null)[]
  /** From the announcement minute's open to the entry: what an app that checks once a minute
   * could not have had. */
  missed: number
  /** The hour before the announcement, in the news's direction: was it known early? */
  before: number | null
  net: number | null
  excess: number | null
  /** The four-hour hold, and that less the same hold at the usual minutes. */
  holdNet: number | null
  holdExcess: number | null
}

function score(pair: StudyPair, symbol: string, bars: Candle[], kind: Kind): Scored | { skipped: string } {
  const minute = Math.floor(pair.releaseSec / 60) * 60
  const i = bars.findIndex((bar) => bar.time === minute)
  if (i < 0) return { skipped: 'no candle at the announcement minute' }
  // The yardstick is read from bars before the announcement's minute and nothing after it.
  const reading = readEventAt(bars, i - 1)
  if (reading === null) return { skipped: 'under twelve hours of candles before it' }
  const { side, slippage } = kind
  const entryIndex = i + ENTRY_DELAY_BARS
  const net = bracketNet(bars, entryIndex, side, reading.sigma15Pct, slippage)
  if (net === null) return { skipped: 'under an hour of candles after it' }

  // The usual: the same bracket and the same moves at every fifteenth minute before the news, each
  // ended before the announcement's minute began.
  const usualNet: number[] = []
  const usualHold: number[] = []
  const usualMoves: number[][] = HORIZONS.map(() => [])
  for (let k = i - 1; k >= 720; k -= USUAL_EVERY_BARS) {
    const usualReading = readEventAt(bars, k - 1)
    if (usualReading === null) continue
    if (k + ENTRY_DELAY_BARS + BRACKET_HOLD_BARS <= i) {
      const value = bracketNet(bars, k + ENTRY_DELAY_BARS, side, usualReading.sigma15Pct, slippage)
      if (value !== null) usualNet.push(value)
    }
    if (k + HOLD_EXIT_BARS <= i) {
      const value = holdNet(bars, k + ENTRY_DELAY_BARS, k + HOLD_EXIT_BARS, side, slippage)
      if (value !== null) usualHold.push(value)
    }
    HORIZONS.forEach((minutes, h) => {
      if (k + minutes <= i) {
        const value = move(bars, k, k + minutes, side)
        if (value !== null) usualMoves[h].push(value)
      }
    })
  }
  if (usualNet.length < LEAST_USUAL_SAMPLES) return { skipped: 'under a day of candles before it to say what is usual' }

  const moves = HORIZONS.map((minutes) => move(bars, i, i + minutes, side))
  const heldNet = holdNet(bars, entryIndex, i + HOLD_EXIT_BARS, side, slippage)
  return {
    holdNet: heldNet,
    holdExcess: heldNet === null || usualHold.length < LEAST_USUAL_SAMPLES / 2 ? null : heldNet - mean(usualHold),
    pair,
    symbol,
    time: pair.releaseSec,
    moves,
    movesExcess: moves.map((value, h) => (value === null || usualMoves[h].length < 20 ? null : value - mean(usualMoves[h]))),
    missed: move(bars, i, entryIndex, side) as number,
    before: move(bars, i - 60, i, side),
    net,
    excess: net - mean(usualNet)
  }
}

// ---------------------------------------------------------------------------------------------

/** MODE=check: where the largest one-minute move near each announcement fell, which says whether
 * its minute is right. MODE=study: each kind's moves and trades. Both read only the half named by
 * `set`, and print to the console. */
export function checkOrStudy<C extends string>(options: {
  dir: string
  mode: 'check' | 'study'
  set: string
  pairs: StudyPair<C>[]
  kinds: Record<C, Kind>
  /** The kinds, in the order the study prints them. */
  categories: C[]
}): void {
  const { dir, mode: MODE, set: SET, pairs, kinds: KINDS, categories: CATEGORIES } = options
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as Manifest
  const scored: Scored[] = []
  const skipped = new Map<string, number>()
  const skip = (category: C, reason: string) => skipped.set(`${category}: ${reason}`, (skipped.get(`${category}: ${reason}`) ?? 0) + 1)
  /** For MODE=check: where the largest one-minute move near each announcement fell. */
  const peakOffsets = new Map<C, number[]>()
  let filledMinutes = 0
  let minutesRead = 0

  for (const pair of pairs) {
    const split = splitOf(pair.releaseSec)
    // The check reads prices too, so it is held to the same split: nothing of the held-out half is
    // looked at before the rule is committed.
    if (split === null || split !== SET) continue
    const entry = manifest[pair.key]
    if (entry === undefined) {
      skip(pair.category, 'not fetched')
      continue
    }
    if (entry.status !== 'ok') {
      skip(pair.category, pair.market === 'spot' ? 'no USDT spot pair trading the day before' : 'no USDT perpetual trading the day before')
      continue
    }
    const loaded = loadBars(dir, pair.market, entry.symbol, pair.days, pair.releaseSec)
    if (loaded === null) {
      skip(pair.category, 'no candles')
      continue
    }
    filledMinutes += loaded.filled
    minutesRead += loaded.bars.length

    if (MODE === 'check') {
      const minute = Math.floor(pair.releaseSec / 60) * 60
      const i = loaded.bars.findIndex((bar) => bar.time === minute)
      if (i < 11 || i + 11 >= loaded.bars.length) continue
      let best = 0
      let at = 0
      for (let offset = -10; offset <= 10; offset++) {
        const bar = loaded.bars[i + offset]
        const size = Math.abs(bar.close / loaded.bars[i + offset - 1].close - 1)
        if (size > best) {
          best = size
          at = offset
        }
      }
      const list = peakOffsets.get(pair.category) ?? []
      list.push(at)
      peakOffsets.set(pair.category, list)
      continue
    }

    const result = score(pair, entry.symbol, loaded.bars, KINDS[pair.category])
    if ('skipped' in result) skip(pair.category, result.skipped)
    else scored.push(result)
  }

  console.log(`MODE=${MODE} SET=${SET}: ${minutesRead.toLocaleString()} minutes read, ${filledMinutes.toLocaleString()} of them with no trade (carried at the last close)`)
  for (const [reason, count] of [...skipped.entries()].sort()) console.log(`  left out, ${reason}: ${count}`)

  if (MODE === 'check') {
    console.log('\nWhere the largest one-minute move within ten minutes of the announcement fell, by minutes from its own:')
    for (const [category, offsets] of peakOffsets) {
      const counts = new Map<number, number>()
      for (const offset of offsets) counts.set(offset, (counts.get(offset) ?? 0) + 1)
      const line = [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([offset, count]) => `${offset >= 0 ? '+' : ''}${offset}:${count}`)
        .join(' ')
      const near = offsets.filter((offset) => offset >= 0 && offset <= 2).length
      console.log(`${category.padEnd(15)} n=${offsets.length}  at 0 to +2: ${((near / offsets.length) * 100).toFixed(0)}% (by chance ${((3 / 21) * 100).toFixed(0)}%)   ${line}`)
    }
  }

  if (MODE === 'study') {
    for (const category of CATEGORIES) {
      const rows = scored.filter((row) => row.pair.category === category)
      const announcements = new Set(rows.map((row) => row.pair.articleId)).size
      console.log(`\n${KINDS[category].label}: ${rows.length} coins measured, from ${announcements} announcements`)
      if (rows.length === 0) continue
      HORIZONS.forEach((minutes, h) => {
        const name = minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${minutes / 60} h` : '1 day'
        const plain = rows.filter((row) => row.moves[h] !== null).map((row) => ({ time: row.time, value: row.moves[h] as number }))
        const excess = rows.filter((row) => row.movesExcess[h] !== null).map((row) => ({ time: row.time, value: row.movesExcess[h] as number }))
        console.log(summarise(`  move over ${name}`, plain))
        console.log(summarise(`  move over ${name}, vs the usual`, excess))
      })
      console.log(summarise('  missed before the second bar', rows.map((row) => ({ time: row.time, value: row.missed }))))
      console.log(summarise('  the hour before the announcement', rows.filter((row) => row.before !== null).map((row) => ({ time: row.time, value: row.before as number }))))
      const traded = rows.filter((row) => row.net !== null)
      console.log(summarise('  the bracket, net', traded.map((row) => ({ time: row.time, value: row.net as number }))))
      console.log(summarise('  the bracket, vs the usual', traded.map((row) => ({ time: row.time, value: row.excess as number }))))
      const wins = traded.filter((row) => (row.net as number) > 0).length
      console.log(`  ${'the bracket, ahead'.padEnd(38)} ${wins} of ${traded.length} (${((wins / traded.length) * 100).toFixed(0)}%)`)
      const held = rows.filter((row) => row.holdNet !== null)
      console.log(summarise('  held four hours, net', held.map((row) => ({ time: row.time, value: row.holdNet as number }))))
      console.log(
        summarise(
          '  held four hours, vs the usual',
          held.filter((row) => row.holdExcess !== null).map((row) => ({ time: row.time, value: row.holdExcess as number }))
        )
      )
      const heldWins = held.filter((row) => (row.holdNet as number) > 0).length
      const worst = held.length > 0 ? Math.min(...held.map((row) => row.holdNet as number)) : NaN
      console.log(`  ${'held four hours, ahead'.padEnd(38)} ${heldWins} of ${held.length} (${((heldWins / held.length) * 100).toFixed(0)}%), worst ${f(worst, 2)}%`)
      // BY_HOUR=<kind>: which announcements carry the result -- each hour's coins and its means.
      if (process.env.BY_HOUR === category) {
        const hours = new Map<number, Scored[]>()
        for (const row of rows) {
          const hour = Math.floor(row.time / 3600)
          hours.set(hour, [...(hours.get(hour) ?? []), row])
        }
        for (const [hour, list] of [...hours.entries()].sort((a, b) => a[0] - b[0])) {
          const bracketMean = mean(list.filter((row) => row.net !== null).map((row) => row.net as number))
          const heldMean = mean(list.filter((row) => row.holdNet !== null).map((row) => row.holdNet as number))
          const coins = list.map((row) => `${row.pair.ticker} ${f(row.holdNet ?? NaN, 1)}`).join(', ')
          console.log(`  ${new Date(hour * 3_600_000).toISOString().slice(0, 13)}h ${String(list.length).padStart(3)} coins  bracket ${f(bracketMean, 2)}  held ${f(heldMean, 2)}  ${coins}`)
        }
      }
    }
  }
}
