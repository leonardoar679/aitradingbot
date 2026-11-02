import type { BaselineStamp } from './baseline'
import { UNCERTAINTY_LINES, bootstrapOverHours, type Figure, type HourSample } from './forecast/uncertainty'
import type { ExecutorConfig } from './ipc'
import type { NewsBookStamp } from './newsBook'
import { BOOKS_REPORT_LINES, bookOf, type BookEquityMark, type BookId } from './paperBooks'
import type { CloneTradeStamp } from './traders/copyTrading'
import type { FollowStamp, LeaderEvent } from './traders/follow'

// HOW A BOOK'S RUN IS READ (V8 Stage 10; V8-S9-BOOKS, registered before the first Start, and its lines in
// BOOKS_REPORT_LINES). For each book and run: its closed trades' net after fees and funding, in percent of their stake and
// in R -- a trade's net over its risk at entry, its stop's distance times its size where it has a stop and else its whole
// stake -- each mean with its 95% interval resampled by the UTC day the trade closed; its equity's return over the run;
// its closed trades and its independent events -- the occasions its trades came from: an announcement, a leader's
// position or a clone's fifteen-minute close, a symbol's entry signal, the trades of one occasion counting once; its
// benchmark over the same span and the interval of the difference, by day -- cash for the news book (the difference is
// its own mean), each follow's net percent against its leader's own on the same position for the copy book (the clones
// have no leader's position and are not compared), holding the eight symbols from the Start for the baseline; and
// Bitcoin's return as context, never a benchmark. A book is called profitable only with 30 closed trades and 10 events
// and the lower end of its mean R's interval above 0, and better than its benchmark only on the same counts with the
// difference's lower end above 0; short of the counts it is too few to call. Trades no venue could take are counted
// apart. Pure: electron/services/booksReportService.ts reads what it needs.

const DAY_SEC = 86_400

export type BookVerdict = 'yes' | 'no' | 'too few'

export interface BookRunReport {
  book: BookId
  startedAt: number
  /** The run's end: its Stop, or now while it runs. */
  endedAt: number
  running: boolean
  trades: number
  events: number
  open: number
  meanPct: Figure | null
  meanR: Figure | null
  /** The last mark's equity against the book's start, in percent; null without marks. */
  equityReturnPct: number | null
  benchmark: {
    kind: (typeof BOOKS_REPORT_LINES.benchmarks)[BookId]
    /** The benchmark's own figure over the span: cash 0, the leaders' mean percent, the hold's return. */
    pct: number | null
    /** The book less the benchmark, with its interval by day. */
    difference: Figure | null
    /** What was compared: closed trades for cash, follows with their leader's position closed, days for the hold. */
    compared: number
    /** Follows not compared: their leader's position still open, or its prices not read. */
    notCompared: number
  }
  btcPct: number | null
  /** Trades no venue could take: missed opportunities of the run, counted apart. */
  noVenue: number
  profitable: BookVerdict
  better: BookVerdict
}

/** The run that runs or ran last, each book read whole; no run before the first Start. */
export interface BooksReport {
  startedAt: number | null
  running: boolean
  reports: BookRunReport[]
}

/** One closed trade of a book as the report reads it. */
export interface BookTradeRow {
  closedAt: number
  netQuote: number
  netPct: number
  riskQuote: number
  eventKey: string
}

/** A trade's risk at entry: its stop's distance times its size where it has a stop, else its whole stake. */
export function riskOf(executor: ExecutorConfig): number | null {
  const news = executor.newsBook as NewsBookStamp | undefined
  if (news !== undefined) return news.stopPx !== null ? Math.abs(news.stopPx - news.entryPx) * news.qty : news.stakeQuote
  const baseline = executor.baseline as BaselineStamp | undefined
  if (baseline !== undefined) return Math.abs(baseline.entryPx - baseline.stopPx) * baseline.qty
  const follow = executor.follow as FollowStamp | undefined
  if (follow !== undefined) return follow.maxStakeQuote
  const clone = executor.clone as CloneTradeStamp | undefined
  if (clone !== undefined) return clone.stakeQuote
  return null
}

/** The occasion a trade came from: its announcement, its leader's position, its clone's close, its symbol's signal. */
export function eventKeyOf(executor: ExecutorConfig): string | null {
  if (executor.newsBook !== undefined) return `news:${executor.newsBook.articleId}`
  if (executor.follow !== undefined) return `follow:${executor.follow.traderKey}:${executor.follow.openedOnKey}`
  if (executor.clone !== undefined) return `clone:${executor.clone.signalKey.replace(/:clone:[^:]+:/, ':clone:')}`
  if (executor.baseline !== undefined) return `baseline:${executor.baseline.symbol}:${executor.baseline.signalBarSec}`
  return null
}

/** A book's closed trades of a run, each once, in the order they closed. */
export function bookTradeRows(executors: readonly ExecutorConfig[], book: BookId, startedAt: number): BookTradeRow[] {
  const seen = new Set<string>()
  const rows: BookTradeRow[] = []
  for (const executor of executors) {
    if (seen.has(executor.id) || bookOf(executor) !== book || executor.book?.startedAt !== startedAt) continue
    const result = executor.book.result
    const risk = riskOf(executor)
    const eventKey = eventKeyOf(executor)
    if (result === undefined || risk === null || !(risk > 0) || eventKey === null) continue
    seen.add(executor.id)
    rows.push({ closedAt: result.closedAt, netQuote: result.netQuote, netPct: result.netPct, riskQuote: risk, eventKey })
  }
  return rows.sort((a, b) => a.closedAt - b.closedAt)
}

const lines = { ...UNCERTAINTY_LINES, draws: BOOKS_REPORT_LINES.draws, seed: BOOKS_REPORT_LINES.seed, level: BOOKS_REPORT_LINES.level }

/** The mean of values, with its interval resampled by the UTC day each falls on; the point alone with one day. */
export function meanByDay(values: readonly { atSec: number; value: number }[]): Figure | null {
  const rows: HourSample[] = values.filter((entry) => Number.isFinite(entry.value)).map((entry) => ({ hour: Math.floor(entry.atSec / DAY_SEC), sample: [entry.value] }))
  if (rows.length === 0) return null
  const resampled = bootstrapOverHours(rows, [(sums, n): number => sums[0] / n], 1, lines)
  if (resampled === null) {
    const mean = rows.reduce((sum, row) => sum + row.sample[0], 0) / rows.length
    return { value: mean, low: Number.NaN, high: Number.NaN, sd: Number.NaN }
  }
  return resampled.figures[0]
}

/** The leader's own percent on the position a follow followed, from the leader's own fills its legs were made on: its
 * average entry and exit, each weighted by the leader's size change. Null where the leader's position did not close by
 * the follow's end, or its events were not read. */
export function leaderPctOf(stamp: Pick<FollowStamp, 'legs' | 'side' | 'closeReason'>, events: ReadonlyMap<string, Pick<LeaderEvent, 'before' | 'after' | 'px'>>): number | null {
  if (stamp.closeReason !== 'leader closed' && stamp.closeReason !== 'leader flipped') return null
  let inQty = 0
  let inQuote = 0
  let outQty = 0
  let outQuote = 0
  for (const leg of stamp.legs) {
    const event = events.get(leg.eventKey)
    if (event === undefined) return null
    const opened = Math.abs(event.after) - Math.abs(event.before)
    if (Math.sign(event.after) !== Math.sign(event.before) && event.before !== 0 && event.after !== 0) {
      // A flip: the old position closed in full at this fill.
      outQty += Math.abs(event.before)
      outQuote += Math.abs(event.before) * event.px
    } else if (opened > 0) {
      inQty += opened
      inQuote += opened * event.px
    } else if (opened < 0) {
      outQty += -opened
      outQuote += -opened * event.px
    }
  }
  if (!(inQty > 0) || !(outQty > 0)) return null
  const sign = stamp.side === 'long' ? 1 : -1
  return sign * (outQuote / outQty / (inQuote / inQty) - 1) * 100
}

/** The book's equity at a moment: its last mark at or before it, its settled equity where the mark priced nothing open. */
export function bookValueAt(marks: readonly Pick<BookEquityMark, 'at' | 'equity' | 'settledEquity'>[], atSec: number): number | null {
  let value: number | null = null
  let latest = -Infinity
  for (const mark of marks) {
    if (mark.at <= atSec && mark.at >= latest) {
      latest = mark.at
      value = mark.equity ?? mark.settledEquity
    }
  }
  return value
}

/** The book's and the hold's changes between consecutive moments of the hold's points -- the Start, each UTC day's end
 * between, the run's end -- in percent, paired where both are known. The hold's value is its symbols bought for an
 * equal part at the Start, 1 there. */
export function pairedChangesOf(hold: readonly { atSec: number; value: number }[], marks: readonly Pick<BookEquityMark, 'at' | 'equity' | 'settledEquity'>[]): { atSec: number; bookPct: number; holdPct: number }[] {
  const points = [...hold].sort((a, b) => a.atSec - b.atSec).map((point) => ({ ...point, book: bookValueAt(marks, point.atSec) }))
  const out: { atSec: number; bookPct: number; holdPct: number }[] = []
  for (let k = 1; k < points.length; k++) {
    const before = points[k - 1]
    const now = points[k]
    if (before.book === null || now.book === null || !(before.book > 0) || !(before.value > 0)) continue
    out.push({ atSec: now.atSec, bookPct: (now.book / before.book - 1) * 100, holdPct: (now.value / before.value - 1) * 100 })
  }
  return out
}

/** The verdicts as V8-S9-BOOKS reads them: on the counts, by the lower ends. */
export function verdictsOf(trades: number, events: number, meanR: Figure | null, difference: Figure | null, report = BOOKS_REPORT_LINES): { profitable: BookVerdict; better: BookVerdict } {
  if (trades < report.minTrades || events < report.minEvents) return { profitable: 'too few', better: 'too few' }
  return { profitable: meanR !== null && meanR.low > 0 ? 'yes' : 'no', better: difference !== null && difference.low > 0 ? 'yes' : 'no' }
}

/** One book's run read whole. */
export function bookRunReportOf(input: {
  book: BookId
  startedAt: number
  endedAt: number
  running: boolean
  startQuote: number
  executors: readonly ExecutorConfig[]
  marks: readonly BookEquityMark[]
  /** The leaders' events by key, for the copy book. */
  leaderEvents: ReadonlyMap<string, Pick<LeaderEvent, 'before' | 'after' | 'px'>>
  /** The hold's value -- the baseline's symbols bought for an equal part at the Start, 1 there -- at the Start, each UTC
   * day's end between and the run's end. */
  hold: readonly { atSec: number; value: number }[]
  btcPct: number | null
  noVenue: number
}): BookRunReport {
  const { book, startedAt } = input
  const rows = bookTradeRows(input.executors, book, startedAt)
  const events = new Set(rows.map((row) => row.eventKey)).size
  const open = input.executors.filter((executor) => executor.status === 'active' && bookOf(executor) === book && executor.book?.startedAt === startedAt).length
  const meanPct = meanByDay(rows.map((row) => ({ atSec: row.closedAt, value: row.netPct })))
  const meanR = meanByDay(rows.map((row) => ({ atSec: row.closedAt, value: row.netQuote / row.riskQuote })))
  const last = [...input.marks].sort((a, b) => a.at - b.at).at(-1)
  const equityReturnPct = last === undefined || !(input.startQuote > 0) ? null : (((last.equity ?? last.settledEquity) / input.startQuote - 1) * 100)
  const kind = BOOKS_REPORT_LINES.benchmarks[book]
  let benchmark: BookRunReport['benchmark']
  if (kind === 'cash') {
    benchmark = { kind, pct: 0, difference: meanPct, compared: rows.length, notCompared: 0 }
  } else if (kind === 'leader') {
    const pairs: { atSec: number; mine: number; leader: number }[] = []
    let notCompared = 0
    for (const executor of input.executors) {
      if (executor.follow === undefined || bookOf(executor) !== book || executor.book?.startedAt !== startedAt || executor.book.result === undefined) continue
      const leader = leaderPctOf(executor.follow, input.leaderEvents)
      if (leader === null) notCompared++
      else pairs.push({ atSec: executor.book.result.closedAt, mine: executor.book.result.netPct, leader })
    }
    benchmark = {
      kind,
      pct: pairs.length === 0 ? null : pairs.reduce((sum, pair) => sum + pair.leader, 0) / pairs.length,
      difference: meanByDay(pairs.map((pair) => ({ atSec: pair.atSec, value: pair.mine - pair.leader }))),
      compared: pairs.length,
      notCompared
    }
  } else {
    const changes = pairedChangesOf(input.hold, input.marks)
    const ordered = [...input.hold].sort((a, b) => a.atSec - b.atSec)
    const first = ordered[0]
    const final = ordered.at(-1)
    benchmark = {
      kind,
      pct: first === undefined || final === undefined || ordered.length < 2 || !(first.value > 0) ? null : (final.value / first.value - 1) * 100,
      difference: meanByDay(changes.map((change) => ({ atSec: change.atSec, value: change.bookPct - change.holdPct }))),
      compared: changes.length,
      notCompared: 0
    }
  }
  return {
    book,
    startedAt,
    endedAt: input.endedAt,
    running: input.running,
    trades: rows.length,
    events,
    open,
    meanPct,
    meanR,
    equityReturnPct,
    benchmark,
    btcPct: input.btcPct,
    noVenue: input.noVenue,
    ...verdictsOf(rows.length, events, meanR, benchmark.difference)
  }
}
