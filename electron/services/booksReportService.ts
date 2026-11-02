import { readFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import { BASELINE_LINES } from '../../shared/baseline'
import type { Candle, ExecutorConfig, Interval } from '../../shared/ipc'
import { BOOK_IDS, healPaperBooks } from '../../shared/paperBooks'
import { bookRunReportOf, type BookRunReport, type BooksReport } from '../../shared/paperBooksReport'
import { PAPER_TESTING_VERSION } from '../../shared/paperTesting'
import type { LeaderEvent } from '../../shared/traders/follow'
import { booksSeam, executorsWithArchive, listEquityMarks, listMisses } from './booksService'
import { leaderEventsOf } from './followService'
import { listMonthFiles } from './jsonlStore'
import { fetchHistoricalRange } from './marketService'
import { getSettings } from './settingsService'

// THE BOOKS' RUN, READ AS V8-S9-BOOKS READS IT (shared/paperBooksReport.ts; V8 Stage 10). For the run that runs or ran
// last: each book's trades, those moved to the archive among them, its equity marks and its trades no venue could take;
// the followed leaders' own events, for the copy book's comparison; Binance's prices of the baseline's eight symbols at
// the Start, at each UTC day's end and at the run's end, for its hold; and Bitcoin's over the run, for context. Public
// prices only; it reads files and places nothing. A report is kept a few minutes, since it reads prices.

const DAY_SEC = 86_400
const KEEP_MS = 5 * 60_000

let kept: { key: string; atMs: number; report: BooksReport } | null = null

/** When the run that began at `startedAt` was stopped, from paperBooks/runs-YYYY-MM.jsonl; null where it was not. */
async function stoppedAtOf(startedAt: number): Promise<number | null> {
  const dir = booksSeam.dir()
  let stoppedAt: number | null = null
  for (const { name } of await listMonthFiles(dir, /^runs-(\d{4}-\d{2})\.jsonl$/).catch(() => [])) {
    const text = await readFile(join(dir, name), 'utf-8').catch(() => '')
    for (const line of text.split('\n')) {
      try {
        const run = JSON.parse(line) as { v?: unknown; startedAt?: unknown; stoppedAt?: unknown }
        if (run.v === PAPER_TESTING_VERSION && run.startedAt === startedAt && typeof run.stoppedAt === 'number') stoppedAt = Math.max(stoppedAt ?? 0, run.stoppedAt)
      } catch {
        // A line that is not a run is not one.
      }
    }
  }
  return stoppedAt
}

/** A symbol's Binance spot bars of an interval over a span; empty where they cannot be read. */
async function barsOf(symbol: string, interval: Interval, fromSec: number, toSec: number): Promise<Candle[]> {
  try {
    const read = await fetchHistoricalRange('binance', symbol, interval, fromSec, toSec, randomUUID(), () => undefined)
    return read.candles
  } catch {
    return []
  }
}

/** A symbol's price at a moment: the open of the minute it falls in, or the close of the last minute before it. */
async function priceAt(symbol: string, atSec: number): Promise<number | null> {
  const minute = Math.floor(atSec / 60) * 60
  const bars = await barsOf(symbol, '1m', minute - 120, minute + 60)
  const at = bars.find((bar) => bar.time === minute)
  if (at !== undefined && at.open > 0) return at.open
  const before = bars.filter((bar) => bar.time < minute).at(-1)
  return before !== undefined && before.close > 0 ? before.close : null
}

/** The hold's value -- the baseline's symbols bought for an equal part at the Start -- at the Start, each UTC day's end
 * between, and the run's end; a moment where any symbol's price is missing is left out. */
async function holdPoints(startedAt: number, endedAt: number): Promise<{ atSec: number; value: number }[]> {
  const symbols = BASELINE_LINES.symbols
  const dayEnds: number[] = []
  for (let end = Math.floor(startedAt / DAY_SEC) * DAY_SEC + DAY_SEC; end < endedAt; end += DAY_SEC) dayEnds.push(end)
  const prices = new Map<string, Map<number, number>>()
  for (const symbol of symbols) {
    const at = new Map<number, number>()
    const start = await priceAt(symbol, startedAt)
    if (start !== null) at.set(startedAt, start)
    if (dayEnds.length > 0) {
      for (const bar of await barsOf(symbol, '1d', dayEnds[0] - DAY_SEC, dayEnds[dayEnds.length - 1])) {
        if (bar.close > 0 && dayEnds.includes(bar.time + DAY_SEC)) at.set(bar.time + DAY_SEC, bar.close)
      }
    }
    const end = await priceAt(symbol, endedAt)
    if (end !== null) at.set(endedAt, end)
    prices.set(symbol, at)
  }
  const out: { atSec: number; value: number }[] = []
  for (const atSec of [startedAt, ...dayEnds, endedAt]) {
    let total = 0
    let whole = true
    for (const symbol of symbols) {
      const first = prices.get(symbol)?.get(startedAt)
      const now = prices.get(symbol)?.get(atSec)
      if (first === undefined || now === undefined) {
        whole = false
        break
      }
      total += now / first
    }
    if (whole) out.push({ atSec, value: total / symbols.length })
  }
  return out
}

/** The run that runs or ran last, each book read whole. */
export async function booksReport(nowSec: number = booksSeam.now()): Promise<BooksReport> {
  const books = healPaperBooks((await getSettings()).paperBooks)
  if (books.startedAt === null) return { startedAt: null, running: false, reports: [] }
  const startedAt = books.startedAt
  const endedAt = books.running ? nowSec : ((await stoppedAtOf(startedAt)) ?? nowSec)
  const key = `${startedAt}:${books.running ? 'running' : endedAt}`
  if (kept !== null && kept.key === key && Date.now() - kept.atMs < KEEP_MS) return kept.report
  const executors: ExecutorConfig[] = await executorsWithArchive()
  const misses = (await listMisses(startedAt)).filter((miss) => miss.at <= endedAt)
  const leaderEvents = new Map<string, LeaderEvent>()
  for (const traderKey of new Set(executors.filter((executor) => executor.follow !== undefined && executor.book?.startedAt === startedAt).map((executor) => executor.follow!.traderKey))) {
    for (const [eventKey, event] of await leaderEventsOf(traderKey, startedAt * 1000 - DAY_SEC * 1000)) leaderEvents.set(eventKey, event)
  }
  const [btcStart, btcEnd, hold] = await Promise.all([priceAt('BTCUSDT', startedAt), priceAt('BTCUSDT', endedAt), holdPoints(startedAt, endedAt)])
  const btcPct = btcStart !== null && btcEnd !== null ? (btcEnd / btcStart - 1) * 100 : null
  const reports: BookRunReport[] = []
  for (const book of BOOK_IDS) {
    reports.push(
      bookRunReportOf({
        book,
        startedAt,
        endedAt,
        running: books.running,
        startQuote: books.books[book].startQuote,
        executors,
        marks: await listEquityMarks(book, startedAt),
        leaderEvents,
        hold: book === 'baseline' ? hold : [],
        btcPct,
        noVenue: misses.filter((miss) => miss.book === book && miss.reason.startsWith('No venue could take this')).length
      })
    )
  }
  const report = { startedAt, running: books.running, reports }
  kept = { key, atMs: Date.now(), report }
  return report
}

/** Test seam. */
export function resetBooksReport(): void {
  kept = null
}
