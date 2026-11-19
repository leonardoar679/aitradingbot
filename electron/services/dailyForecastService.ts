import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { DAILY_RECORD_VERSION, dailyFactorsOf, dailyOutcomeOf, dailyPredictionOf, parseDailyOutcome, parseDailyPrediction, type DailyForecastView, type DailyOutcomeLine, type DailyPredictionLine } from '../../shared/forecast/daily/dailyRecord'
import { DAILY_HORIZONS, DAILY_HORIZON_DAYS, DAILY_SIZE_LINES, type DayBar } from '../../shared/forecast/daily/dailySize'
import { takeBoardDailyOutcomes } from './accuracyBoardService'
import { writeJsonAtomic } from './atomicWrite'
import { fetchMarketData, servesBinanceComMarket } from './exchanges/binance'
import { latestForecasts } from './forecastService'
import { appendJsonLines } from './jsonlStore'

// THE DAILY FORECAST (V10 Stage 4, 19 November 2026; V10-DAILY-SIZE held: its 80% ranges covered 79.4% to 79.6% over
// one, three and seven days on January 2024 to October 2026, the real moves 1.00 to 1.06 times the size expected). A little
// after each UTC day opens, the daily bars of the forecast's coins are brought up to date -- Binance's, binance.com's market
// only, as the five-minute forecast's are -- and each coin's five levels over one, three and seven days are made from its
// day's open (shared/forecast/daily/dailyRecord.ts), the ranges' widths read from every coin's moves over the thousand days
// before. When a horizon's days are up, its outcome is written and counted on the accuracy board. It reads public market
// data and keeps what it made; it calls no way and places nothing.

const DAY = 86_400
const BARS_FILE = 'daily-bars.json'
/** The days of bars kept: the widths' thousand and the spread's thirty, and room. */
const KEEP_DAYS = DAILY_SIZE_LINES.fitDays + 100
/** A day's forecast is made this long after it opens: its bar has opened, every closed bar is there. */
const AFTER_OPEN_SEC = 600
const TICK_MS = 10 * 60_000
const FIRST_TICK_MS = 2 * 60_000

export const dailySeam = {
  dir: (): string => join(app.getPath('userData'), 'forecasts'),
  nowSec: (): number => Math.floor(Date.now() / 1000),
  /** The forecast's coins. */
  pairs: (): string[] => latestForecasts().map((prediction) => prediction.pair),
  /** A coin's daily bars from `startSec` on, a thousand at most, the day in progress included; null where the data host
   * is another market than binance.com's (its bars are not kept). */
  klines: async (symbol: string, startSec: number): Promise<DayBar[] | null> => {
    const { response, endpoint } = await fetchMarketData(`/klines?symbol=${symbol}&interval=1d&startTime=${startSec * 1000}&limit=1000`, 30_000, 'background')
    if (!response.ok) throw new Error(`${endpoint.name} daily klines for ${symbol} answered ${response.status}`)
    if (!servesBinanceComMarket(endpoint)) return null
    const rows = (await response.json()) as unknown[][]
    return rows
      .map((row) => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }))
      .filter((bar) => [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0))
  },
  write: (path: string, data: unknown): Promise<void> => writeJsonAtomic(path, data),
  append: (path: string, rows: readonly unknown[]): Promise<void> => appendJsonLines(path, rows)
}

let bars = new Map<string, Map<number, DayBar>>()
let today: DailyPredictionLine[] = []
let owed: DailyPredictionLine[] = []
/** Each forecast's horizons already settled, `${id}/${horizon}`: never written twice. */
let settledKeys = new Set<string>()
let madeDay: number | null = null
let problem: string | null = null
let loaded = false
let busy = false
let timer: ReturnType<typeof setInterval> | null = null

const yearOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 4)

async function readLines<T>(name: string, parse: (value: unknown) => T | null): Promise<T[]> {
  const text = await readFile(join(dailySeam.dir(), name), 'utf-8').catch(() => '')
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const read = parse(JSON.parse(line))
      if (read !== null) out.push(read)
    } catch {
      // A torn line: left out.
    }
  }
  return out
}

/** What was kept: the bars, the forecasts still owed an outcome and today's. */
async function load(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(await readFile(join(dailySeam.dir(), BARS_FILE), 'utf-8')) as Record<string, number[][]>
    for (const [pair, rows] of Object.entries(raw)) bars.set(pair, new Map(rows.map((row) => [row[0], { time: row[0], open: row[1], high: row[2], low: row[3], close: row[4] }])))
  } catch {
    // None kept yet.
  }
  const nowSec = dailySeam.nowSec()
  const years = [...new Set([yearOf(nowSec - 10 * DAY), yearOf(nowSec)])]
  const predictions: DailyPredictionLine[] = []
  const settled = new Set<string>()
  for (const year of years) {
    predictions.push(...(await readLines(`daily-predictions-${year}.jsonl`, parseDailyPrediction)))
    for (const outcome of await readLines(`daily-outcomes-${year}.jsonl`, parseDailyOutcome)) settled.add(`${outcome.id}/${outcome.h}`)
  }
  const day = Math.floor(nowSec / DAY) * DAY
  today = predictions.filter((line) => line.day === day)
  madeDay = today.length > 0 ? day : null
  settledKeys = settled
  owed = predictions.filter(stillOwed)
}

/** Whether any of a forecast's horizons is still to be settled. */
const stillOwed = (line: DailyPredictionLine): boolean => DAILY_HORIZONS.some((horizon) => line.h[horizon] !== undefined && !settledKeys.has(`${line.id}/${horizon}`))

/** Each coin's bars brought up to the day in progress; the day's own bar is kept for its open, the closed ones for the rule. */
async function refreshBars(day: number, pairs: readonly string[]): Promise<Map<string, number>> {
  const opens = new Map<string, number>()
  for (const pair of pairs) {
    const mine = bars.get(pair) ?? new Map<number, DayBar>()
    const last = [...mine.keys()].reduce((most, time) => Math.max(most, time), -Infinity)
    let from = Number.isFinite(last) ? last + DAY : day - KEEP_DAYS * DAY
    try {
      for (let pages = 0; pages < 3 && from <= day; pages++) {
        const read = await dailySeam.klines(pair, from)
        if (read === null) throw new Error('the data host is another market than binance.com: its bars are not kept')
        if (read.length === 0) break
        for (const bar of read) {
          if (bar.time === day) opens.set(pair, bar.open)
          else if (bar.time < day) mine.set(bar.time, bar)
        }
        from = read[read.length - 1].time + DAY
        if (read.length < 1000) break
      }
    } catch (error) {
      console.warn(`The daily forecast could not read ${pair}'s daily bars:`, error instanceof Error ? error.message : error)
    }
    for (const time of [...mine.keys()]) if (time < day - KEEP_DAYS * DAY) mine.delete(time)
    if (mine.size > 0) bars.set(pair, mine)
  }
  await dailySeam.write(join(dailySeam.dir(), BARS_FILE), Object.fromEntries([...bars].map(([pair, mine]) => [pair, [...mine.values()].sort((a, b) => a.time - b.time).map((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close])])))
  return opens
}

/** The outcomes whose days are up, written and counted. */
async function settle(day: number): Promise<void> {
  const nowSec = dailySeam.nowSec()
  const outcomes: DailyOutcomeLine[] = []
  for (const line of owed) {
    const byDay = bars.get(line.pair)
    for (const horizon of DAILY_HORIZONS) {
      const key = `${line.id}/${horizon}`
      if (line.h[horizon] === undefined || settledKeys.has(key) || line.day + DAILY_HORIZON_DAYS[horizon] * DAY > day) continue
      const outcome = byDay === undefined ? null : dailyOutcomeOf(line, horizon, byDay, nowSec)
      if (outcome !== null) outcomes.push(outcome)
    }
  }
  if (outcomes.length === 0) return
  await dailySeam.append(join(dailySeam.dir(), `daily-outcomes-${yearOf(day)}.jsonl`), outcomes)
  for (const outcome of outcomes) settledKeys.add(`${outcome.id}/${outcome.h}`)
  takeBoardDailyOutcomes(outcomes)
  owed = owed.filter(stillOwed)
}

/** One turn: after the day has opened, the bars brought up to date, the owed outcomes settled, the day's forecasts made
 * once. */
export async function dailyForecastTurn(): Promise<void> {
  if (busy) return
  busy = true
  try {
    await load()
    const nowSec = dailySeam.nowSec()
    const day = Math.floor(nowSec / DAY) * DAY
    if (nowSec < day + AFTER_OPEN_SEC || madeDay === day) return
    const pairs = dailySeam.pairs()
    if (pairs.length === 0) {
      problem = 'no forecast yet: the daily forecast waits for the forecast to name its coins'
      return
    }
    const opens = await refreshBars(day, pairs)
    await settle(day)
    const factors = dailyFactorsOf(bars, day)
    const made: DailyPredictionLine[] = []
    for (const pair of pairs) {
      const byDay = bars.get(pair)
      const open = opens.get(pair)
      if (byDay === undefined || open === undefined) continue
      const line = dailyPredictionOf(pair, byDay, day, open, factors, nowSec)
      if (line !== null) made.push(line)
    }
    if (made.length === 0) {
      problem = 'no coin had the thirty days of bars and the day\'s open a forecast needs'
      return
    }
    await dailySeam.append(join(dailySeam.dir(), `daily-predictions-${yearOf(day)}.jsonl`), made)
    today = made
    owed.push(...made)
    madeDay = day
    problem = null
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error)
    console.warn('The daily forecast failed a turn:', problem)
  } finally {
    busy = false
  }
}

/** Today's forecasts, as the window shows them. */
export function dailyForecastView(): DailyForecastView {
  return { day: madeDay, at: today[0]?.at ?? null, rows: today.map((line) => ({ pair: line.pair, price: line.price, h: line.h })), problem: today.length > 0 ? null : problem }
}

/** Starts the turns: the first a little after the app starts, then every ten minutes. Called once, from main.ts. */
export function startDailyForecast(): void {
  if (timer !== null) return
  setTimeout(() => void dailyForecastTurn(), FIRST_TICK_MS)
  timer = setInterval(() => void dailyForecastTurn(), TICK_MS)
}

export function stopDailyForecast(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

/** Test seam: as a new session finds it. */
export function resetDailyForecast(): void {
  bars = new Map()
  today = []
  owed = []
  madeDay = null
  settledKeys = new Set()
  problem = null
  loaded = false
  busy = false
  stopDailyForecast()
}

export const DAILY_FORECAST_VERSION = DAILY_RECORD_VERSION
