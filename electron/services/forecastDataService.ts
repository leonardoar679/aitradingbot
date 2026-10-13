import { app } from 'electron'
import { readFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import {
  FORECAST_BAR_SECONDS,
  FORECAST_DATA_VERSION,
  FORECAST_HISTORY_DAYS,
  KLINES_PAGE,
  KLINES_WEIGHT,
  nextPageStart,
  barFromKline,
  barFromLine,
  barMonthKey,
  barToLine,
  coarseBars,
  lastClosedBarTime,
  mergeBars,
  missingSpans,
  staleMonth,
  type CoarseBar,
  type ForecastBar,
  type ForecastDataStatus
} from '../../shared/forecast/bars'
import { fetchMarketData, servesBinanceComMarket } from './exchanges/binance'
import { appendJsonLines } from './jsonlStore'
import { getResearchState, onResearchUpdate } from './marketResearchService'

// THE FORECAST'S BARS, KEPT (the V6 document, §15 and §40; V6 Stage 2, 13 October 2026; the
// arithmetic is shared/forecast/bars.ts).
//
// Ninety days of five-minute klines for the pairs the research reads -- the most traded USDT pairs
// over $20M a day -- and Bitcoin and ether always, read from the public data host the app already
// fails over between (fetchMarketData), kept in forecastData/<PAIR>-<YYYY-MM>.jsonl, one bar a line,
// and extended as each bar closes. The forecast trains on the files and predicts from the bars held
// here: three days of five-minute bars and thirty-two days of hours built from them.
//
// IT READS PUBLIC DATA AND NOTHING ELSE. No key, no model, no order. A first start reads about
// 1,300 pages, paced under Binance's request budget beside the scanner's; after that, a page a pair
// every five minutes.
//
// APPENDED, NEVER REWRITTEN, AND SWEPT BY THE MONTH. A bar is written once, when it has closed; a
// gap the exchange left is asked for again once a session; a month file whose month ended before the
// history the forecast keeps is deleted at start.

/** Five-minute bars held for each pair: what the forecast's short readings need. */
const LIVE_M5_DAYS = 3
/** Hours held for each pair: a month for the long averages, and a margin. */
const LIVE_H1_DAYS = 32
/** Pairs read at once during a backfill. */
const BACKFILL_LANES = 3
/** The least time between two requests: at most about eight a second, under 1,000 of Binance's
 * 6,000 a minute in weight, beside the scanner's sixty. */
const MIN_REQUEST_GAP_MS = 125
/** After the five-minute close, how long to wait for the exchange to have the bar. */
const SETTLE_MS = 5_000
/** A rate limit without a Retry-After waits this long; a ban (418), this. */
const RATE_LIMIT_WAIT_MS = 60_000
const BAN_WAIT_MS = 30 * 60_000
/** Gaps the exchange left that are asked for again, at most, per pair and session. */
const MAX_REPAIRS_PER_PAIR = 12
/** Pages one pair is asked for in one pass, at most: ninety days are 26, and a gap or two more. */
const MAX_PAGES_PER_PASS = 40
const FILE_PATTERN = /^([A-Z0-9]+)-(\d{4}-\d{2})\.jsonl$/
/** Bitcoin and ether are read whatever the research picked: every pair's forecast reads them. */
const ALWAYS = ['BTCUSDT', 'ETHUSDT']

interface PairSeries {
  m5: ForecastBar[]
  h1: CoarseBar[]
  /** The newest bar on file, by its open. */
  lastStored: number | null
  /** The first backfill of this session has run. */
  ready: boolean
}

const series = new Map<string, PairSeries>()
let universe: string[] = []
let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let lastRequestAt = 0
let waitUntil = 0
/** The pacing in force: MIN_REQUEST_GAP_MS, but for a test. */
let requestGapMs = MIN_REQUEST_GAP_MS
const status: ForecastDataStatus = {
  version: FORECAST_DATA_VERSION,
  pairs: 0,
  ready: 0,
  requests: 0,
  weight: 0,
  failures: 0,
  barsWritten: 0,
  lastPassAt: null,
  lastError: null,
  rateLimitedUntil: null,
  refusedHost: null,
  monthsSwept: 0
}
const listeners = new Set<(closedAt: number) => void>()

function dataDir(): string {
  return join(app.getPath('userData'), 'forecastData')
}

function fileFor(symbol: string, month: string): string {
  return join(dataDir(), `${symbol}-${month}.jsonl`)
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class RateLimited extends Error {}
/** A page from a host that serves another market than binance.com's: never stored. */
class OtherMarket extends Error {}

/** Why requests wait, while a rate limit's wait lasts. */
let limitedBecause = ''

/** Waits out the gap since the last request. While a rate limit's wait lasts, a request is not made
 * at all: it fails at once, so a pass ends where it is and the pass after its wait carries on. */
async function paced(): Promise<void> {
  for (;;) {
    const now = Date.now()
    if (now < waitUntil) throw new RateLimited(`waiting until ${new Date(waitUntil).toISOString().slice(11, 19)} UTC: ${limitedBecause}`)
    const ready = lastRequestAt + requestGapMs
    if (now >= ready) break
    await sleep(ready - now)
  }
  lastRequestAt = Date.now()
}

/** One page of a pair's five-minute bars from `startSec`, the closed ones only. */
async function fetchPage(symbol: string, startSec: number): Promise<ForecastBar[]> {
  await paced()
  status.requests++
  status.weight += KLINES_WEIGHT
  const { response, endpoint } = await fetchMarketData(`/klines?symbol=${symbol}&interval=5m&startTime=${startSec * 1000}&limit=${KLINES_PAGE}`)
  if (response.status === 429 || response.status === 418) {
    const after = Number(response.headers.get('retry-after'))
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 : response.status === 418 ? BAN_WAIT_MS : RATE_LIMIT_WAIT_MS
    waitUntil = Date.now() + wait
    limitedBecause = `${endpoint.name} answered ${response.status}`
    status.rateLimitedUntil = Math.floor(waitUntil / 1000)
    throw new RateLimited(`${limitedBecause}; waiting ${Math.round(wait / 1000)} s`)
  }
  if (!response.ok) throw new Error(`${endpoint.name} klines for ${symbol} answered ${response.status}`)
  // binance.us is another exchange: its bars would be another market's prices in binance.com's
  // history. The page is refused, and so is every page until the data host is binance.com's again.
  if (!servesBinanceComMarket(endpoint)) {
    status.refusedHost = endpoint.name
    throw new OtherMarket(`the data host is ${endpoint.name}, another market than binance.com's: its bars are not kept`)
  }
  status.refusedHost = null
  const rows: unknown = await response.json()
  if (!Array.isArray(rows)) throw new Error(`${endpoint.name} klines for ${symbol} were not a list`)
  const closedBy = Math.floor(Date.now() / 1000)
  return rows.map(barFromKline).filter((bar): bar is ForecastBar => bar !== null && bar.time + FORECAST_BAR_SECONDS <= closedBy)
}

/** Writes bars to their month files. */
async function store(symbol: string, bars: readonly ForecastBar[]): Promise<void> {
  const byMonth = new Map<string, ForecastBar[]>()
  for (const bar of bars) {
    const month = barMonthKey(bar.time)
    const list = byMonth.get(month)
    if (list === undefined) byMonth.set(month, [bar])
    else list.push(bar)
  }
  for (const [month, list] of byMonth) await appendJsonLines(fileFor(symbol, month), list.map(barToLine))
  status.barsWritten += bars.length
}

/** Every bar on file for a pair, oldest first, each time once. */
async function readPair(symbol: string): Promise<ForecastBar[]> {
  let names: string[]
  try {
    names = await readdir(dataDir())
  } catch {
    return []
  }
  let bars: ForecastBar[] = []
  for (const name of names.filter((entry) => FILE_PATTERN.exec(entry)?.[1] === symbol).sort()) {
    const text = await readFile(join(dataDir(), name), 'utf-8').catch(() => '')
    const read: ForecastBar[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const bar = barFromLine(JSON.parse(line))
        if (bar !== null) read.push(bar)
      } catch {
        // A torn line: skipped.
      }
    }
    bars = mergeBars(bars, read)
  }
  return bars
}

/** Every bar of a pair on file, oldest first: the whole history kept, not the days held for the live
 * forecast. What the Forecast Lab replays and runs the strategies on (V6 Stage 11). */
export function readForecastBars(symbol: string): Promise<ForecastBar[]> {
  return readPair(symbol)
}

/** The windows built from every bar of a pair: the last days of five-minute bars, and the hours. */
function rebuild(entry: PairSeries, bars: readonly ForecastBar[], nowSec: number): void {
  entry.m5 = bars.filter((bar) => bar.time >= nowSec - LIVE_M5_DAYS * 86_400)
  entry.h1 = coarseBars(bars, '1h', nowSec).filter((bar) => bar.time >= nowSec - LIVE_H1_DAYS * 86_400)
}

/** The bars of the usual pass -- one or two that just closed -- added to the windows, and the hours
 * they complete built from the five-minute bars, which always hold the whole of a recent hour. */
function hold(entry: PairSeries, incoming: readonly ForecastBar[], nowSec: number): void {
  // The hours are built before the window is trimmed: a page can reach further back than it.
  const merged = mergeBars(entry.m5, incoming)
  const lastHour = entry.h1.length === 0 ? Number.NEGATIVE_INFINITY : entry.h1[entry.h1.length - 1].time
  const fresh = coarseBars(merged, '1h', nowSec).filter((bar) => bar.time > lastHour)
  entry.m5 = merged.filter((bar) => bar.time >= nowSec - LIVE_M5_DAYS * 86_400)
  entry.h1 = [...entry.h1, ...fresh].filter((bar) => bar.time >= nowSec - LIVE_H1_DAYS * 86_400)
}

/** A pair read from its files, once a session: the gaps left in its last ninety days asked for once
 * each, and its windows built from all of it. */
async function loadPair(symbol: string, nowSec: number): Promise<PairSeries> {
  let bars = await readPair(symbol)
  const entry: PairSeries = { m5: [], h1: [], lastStored: bars.length === 0 ? null : bars[bars.length - 1].time, ready: false }
  if (bars.length > 0) {
    // Gaps between the first bar on file and the newest: before the first is the backfill's.
    const gaps = missingSpans(bars, Math.max(bars[0].time, nowSec - FORECAST_HISTORY_DAYS * 86_400), bars[bars.length - 1].time)
    for (const gap of gaps.slice(0, MAX_REPAIRS_PER_PAIR)) {
      try {
        const page = (await fetchPage(symbol, gap.from)).filter((bar) => bar.time >= gap.from && bar.time <= gap.to)
        if (page.length > 0) {
          await store(symbol, page)
          bars = mergeBars(bars, page)
        }
      } catch (error) {
        if (error instanceof RateLimited || error instanceof OtherMarket) throw error
        status.failures++
        status.lastError = describe(error)
      }
    }
  }
  rebuild(entry, bars, nowSec)
  return entry
}

/** A pair brought up to the last closed bar: as many pages as it is behind, stored, and held -- the
 * usual bar or two added to the windows, a longer catch-up built into them again from the files. */
async function catchUp(symbol: string): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  const entry = series.get(symbol) ?? (await loadPair(symbol, nowSec))
  series.set(symbol, entry)
  const fetched: ForecastBar[] = []
  let pages = 0
  while (pages < MAX_PAGES_PER_PASS) {
    const start = nextPageStart(entry.lastStored, Math.floor(Date.now() / 1000))
    if (start === null) break
    const stored = entry.lastStored
    const page = (await fetchPage(symbol, start)).filter((bar) => stored === null || bar.time > stored)
    if (page.length === 0) break
    await store(symbol, page)
    entry.lastStored = page[page.length - 1].time
    pages++
    if (pages === 1) fetched.push(...page)
    // Fewer than a page: the exchange has nothing closed after it.
    if (page.length < KLINES_PAGE) break
  }
  const now = Math.floor(Date.now() / 1000)
  if (pages > 1) rebuild(entry, await readPair(symbol), now)
  else if (pages === 1) hold(entry, fetched, now)
  entry.ready = true
}

/** Every pair of the universe, three at a time, each brought up to date. A rate limit stops the
 * pass where it is: the next pass carries on. */
async function pass(): Promise<void> {
  const pairs = [...universe]
  let next = 0
  let limited = false
  const lane = async (): Promise<void> => {
    while (next < pairs.length && !limited) {
      const symbol = pairs[next++]
      try {
        await catchUp(symbol)
      } catch (error) {
        status.failures++
        status.lastError = `${symbol}: ${describe(error)}`
        if (error instanceof RateLimited || error instanceof OtherMarket) limited = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BACKFILL_LANES, pairs.length) }, lane))
  status.pairs = universe.length
  status.ready = universe.filter((symbol) => series.get(symbol)?.ready === true).length
  status.lastPassAt = Math.floor(Date.now() / 1000)
  if (waitUntil <= Date.now()) status.rateLimitedUntil = null
  const closedAt = lastClosedBarTime(Math.floor(Date.now() / 1000)) + FORECAST_BAR_SECONDS
  for (const listener of listeners) {
    try {
      listener(closedAt)
    } catch (error) {
      console.error('A forecast-data listener failed:', error)
    }
  }
}

let passing: Promise<void> | null = null
function runPass(): Promise<void> {
  if (passing === null) {
    passing = pass().finally(() => {
      passing = null
    })
  }
  return passing
}

/** The research's pairs, most traded first, and Bitcoin and ether. */
function universeOf(): string[] {
  const pairs = [...getResearchState().pairs].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h).map((pair) => pair.symbol)
  return [...new Set([...ALWAYS, ...pairs])]
}

/** Month files whose month ended before the history kept: deleted at start. */
async function sweepOldMonths(nowSec: number): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dataDir())
  } catch {
    return 0
  }
  let count = 0
  for (const name of names) {
    const month = FILE_PATTERN.exec(name)?.[2]
    if (month === undefined || !staleMonth(month, nowSec)) continue
    try {
      await unlink(join(dataDir(), name))
      count++
    } catch {
      // Held by something: left for the next start.
    }
  }
  return count
}

function scheduleNext(): void {
  const now = Date.now()
  const period = FORECAST_BAR_SECONDS * 1000
  timer = setTimeout(
    () => {
      void runPass().catch((error) => console.error('The forecast data pass failed:', error))
      scheduleNext()
    },
    period - (now % period) + SETTLE_MS
  )
}

/** Starts the forecast's data at launch, once the research has named its pairs: the sweep, the
 * backfill, and a pass after every five-minute close. Called once, from electron/main.ts. */
export function startForecastData(): void {
  if (started) return
  started = true
  const begin = (): void => {
    universe = universeOf()
    status.pairs = universe.length
    void sweepOldMonths(Math.floor(Date.now() / 1000))
      .then((count) => {
        status.monthsSwept = count
      })
      .then(() => runPass())
      .catch((error) => console.error('The forecast data backfill failed:', error))
    scheduleNext()
  }
  let begun = false
  const onResearch = (): void => {
    const next = universeOf()
    if (!begun) {
      if (getResearchState().pairs.length === 0) return
      begun = true
      begin()
      return
    }
    // A pair new to the research is read at the next pass; one that left it keeps its files.
    universe = next
    status.pairs = universe.length
  }
  onResearchUpdate(onResearch)
  onResearch()
}

/** What the forecast's data stands at. */
export function getForecastDataStatus(): ForecastDataStatus {
  return { ...status }
}

/** The pairs the forecast reads, most traded first, Bitcoin and ether leading. */
export function forecastUniverse(): string[] {
  return [...universe]
}

/** A pair's bars as held: three days of five-minute bars, a month of hours. Null before it is read. */
export function forecastSeries(symbol: string): { m5: readonly ForecastBar[]; h1: readonly CoarseBar[] } | null {
  const entry = series.get(symbol)
  return entry === undefined || !entry.ready ? null : { m5: entry.m5, h1: entry.h1 }
}

/** Every bar on file for a pair, oldest first: what the forecast trains on. */
export function readForecastHistory(symbol: string): Promise<ForecastBar[]> {
  return readPair(symbol)
}

/** Told after each pass, with the close of the bar it brought the pairs up to. */
export function onForecastBars(listener: (closedAt: number) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seams. */
export const forecastDataForTest = {
  reset(): void {
    series.clear()
    universe = []
    started = false
    if (timer !== null) clearTimeout(timer)
    timer = null
    lastRequestAt = 0
    waitUntil = 0
    limitedBecause = ''
    requestGapMs = MIN_REQUEST_GAP_MS
    Object.assign(status, { pairs: 0, ready: 0, requests: 0, weight: 0, failures: 0, barsWritten: 0, lastPassAt: null, lastError: null, rateLimitedUntil: null, refusedHost: null, monthsSwept: 0 })
  },
  setUniverse(symbols: string[]): void {
    universe = [...symbols]
  },
  setPacing(ms: number): void {
    requestGapMs = ms
  },
  pass: runPass,
  sweepOldMonths
}
