import type { ExecutorConfig } from './ipc'

// THREE PAPER BOOKS, EACH ITS OWN $10,000 (V8 Stage 2, 26 October 2026; the user's answer of that day).
//
// V8 tests three ideas on paper side by side: news-driven forecasting, following traders, and the best existing
// strategy as a baseline. Run on the one paper account they would block one another -- one book's open trades
// filling a cap another needs -- and their results would not be their own. So each is a book: its own start
// (10,000 USDT unless set), its own caps, pause and daily stop, nothing shared. A book counts only the
// executors its own writer stamped with its mark; every other paper trade -- the watch's, the forecast trader's,
// the laboratory's, a person's -- is book "other" and keeps the account and caps it has today.
//
// THE BOOKS ARE DERIVED, NOT KEPT. As the paper account is (src/account/paperAccount.ts), a book's money is read
// from the executors that exist: its start, plus what its stopped trades made (their marks' results), plus what
// its open ones stand at now. Nothing moves money in step with opening and closing, so nothing can invent or lose
// it. Its equity is marked once an hour to a file (paperBooks/equity-YYYY-MM.jsonl), so its drawdown survives a
// restart. A stake is sized on a book's settled equity (start plus results); its open results move its drawdown
// and its daily stop, never a stake (paper-equity-v2).
//
// IT IS PAPER. A book opens nothing by itself; its writers do, each pinned to paper (tests/aiNoLivePath.test.ts).

export const BOOK_IDS = ['news', 'copy', 'baseline'] as const
export type BookId = (typeof BOOK_IDS)[number]
/** Where a trade sits within its book, so its figures can be read apart. */
export type BookLedger = 'rule' | 'card' | 'user' | 'follow' | 'clone' | 'baseline'

export const BOOK_LEDGERS: Record<BookId, readonly BookLedger[]> = {
  news: ['rule', 'card', 'user'],
  copy: ['follow', 'clone'],
  baseline: ['baseline']
}

/** How a book's run is read and judged (V8-S9-BOOKS, registered before the first Start): its closed trades' net in
 * percent of their stake and in R, each with an interval resampled by UTC day, beside its benchmark; and the counts
 * short of which no book is called profitable, or better than its benchmark, whatever its figures. */
export const BOOKS_REPORT_LINES = {
  version: 'books-report-v1',
  /** Closed trades a book needs before it is called anything. */
  minTrades: 30,
  /** Independent events it needs too: the occasions its trades came from -- an announcement, a leader's position or a
   * clone's close, a symbol's entry signal -- the trades of one occasion counting once. */
  minEvents: 10,
  level: 0.95,
  draws: 10_000,
  seed: 20_261_027,
  /** Each book's benchmark over the same span: cash for news, the followed leaders' own trades for copy, holding the
   * eight symbols from the Start for the baseline. Bitcoin is shown beside them as context, never as a benchmark. */
  benchmarks: { news: 'cash', copy: 'leader', baseline: 'hold' }
} as const

/** The mark a book's writer stamps on each paper trade it opens. */
export interface BookMark {
  id: BookId
  /** When the book was started, in seconds: a trade counts in the book's run that began then. */
  startedAt: number
  ledger: BookLedger
  /** What the trade made once stopped, in the quote and in percent of its stake, after fees and funding. */
  result?: { netQuote: number; netPct: number; feesQuote: number; fundingQuote: number; closedAt: number }
}

/** One book's setting: its start and its own caps. */
export interface BookSettings {
  startQuote: number
  /** At most this many open at once. */
  maxOpen: number
  /** One trade stakes at most this share of the book's settled equity. */
  maxStakeShare: number
  /** No new trade the rest of the UTC day once the equity is this many percent under the day's start. */
  dailyStopPct: number
}

export interface PaperBooksSettings {
  /** Whether the three are running (Start paper testing; V8 Stage 9), and since when. */
  running: boolean
  startedAt: number | null
  books: Record<BookId, BookSettings>
}

/** What a fresh install has: nothing running, each book 10,000 USDT. */
export const DEFAULT_PAPER_BOOKS: PaperBooksSettings = {
  running: false,
  startedAt: null,
  books: {
    news: { startQuote: 10_000, maxOpen: 5, maxStakeShare: 0.1, dailyStopPct: 3 },
    copy: { startQuote: 10_000, maxOpen: 15, maxStakeShare: 0.1, dailyStopPct: 3 },
    baseline: { startQuote: 10_000, maxOpen: 8, maxStakeShare: 0.125, dailyStopPct: 5 }
  }
}

/** The arithmetic's version (ENGINE_CONSTANTS.paperBooks). */
export const PAPER_BOOKS_VERSION = 'paper-books-v1'

const START_CHOICES = [1000, 2500, 5000, 10_000, 25_000, 50_000] as const

/** A stored setting, read as one. Running is only `true` as stored; every number outside its choices takes
 * its default. */
export function healPaperBooks(value: unknown): PaperBooksSettings {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Partial<Record<keyof PaperBooksSettings, unknown>>
  const books = (typeof raw.books === 'object' && raw.books !== null ? raw.books : {}) as Partial<Record<BookId, Partial<Record<keyof BookSettings, unknown>>>>
  const between = (x: unknown, low: number, high: number, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) && x >= low && x <= high ? x : fallback)
  const heal = (id: BookId): BookSettings => {
    const stored = books[id] ?? {}
    const defaults = DEFAULT_PAPER_BOOKS.books[id]
    return {
      startQuote: (START_CHOICES as readonly unknown[]).includes(stored.startQuote) ? (stored.startQuote as number) : defaults.startQuote,
      maxOpen: Number.isInteger(stored.maxOpen) ? between(stored.maxOpen, 1, 50, defaults.maxOpen) : defaults.maxOpen,
      maxStakeShare: between(stored.maxStakeShare, 0.01, 0.5, defaults.maxStakeShare),
      dailyStopPct: between(stored.dailyStopPct, 0.5, 20, defaults.dailyStopPct)
    }
  }
  const running = raw.running === true
  const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) && raw.startedAt > 0 ? raw.startedAt : null
  return { running: running && startedAt !== null, startedAt, books: { news: heal('news'), copy: heal('copy'), baseline: heal('baseline') } }
}

/** The book an executor counts in: its mark's, or "other". */
export function bookOf(executor: Pick<ExecutorConfig, 'book' | 'mode'>): BookId | 'other' {
  if (executor.mode !== 'paper' || executor.book === undefined) return 'other'
  return (BOOK_IDS as readonly string[]).includes(executor.book.id) ? executor.book.id : 'other'
}

/** A book's executors in its run that began at `startedAt`. */
export function bookExecutors(executors: readonly ExecutorConfig[], id: BookId, startedAt: number): ExecutorConfig[] {
  return executors.filter((executor) => bookOf(executor) === id && executor.book!.startedAt === startedAt)
}

/** What a book stands at: its start, what its stopped trades made, what its open ones stand at, and its equity. */
export interface BookStanding {
  id: BookId
  startQuote: number
  realizedQuote: number
  /** Open results as the caller priced them now; null where any open trade could not be priced. */
  unrealizedQuote: number | null
  /** Start plus results: what a stake is sized on. */
  settledEquity: number
  /** Settled equity plus open results: what its drawdown and daily stop read. */
  equity: number | null
  open: number
  openStakeQuote: number
  closed: number
}

/** A book's standing from its executors; `openResult` prices an open one now (null where it cannot). */
export function bookStandingOf(
  id: BookId,
  settings: BookSettings,
  executors: readonly ExecutorConfig[],
  startedAt: number,
  openResult: (executor: ExecutorConfig) => number | null
): BookStanding {
  const mine = bookExecutors(executors, id, startedAt)
  let realized = 0
  let closed = 0
  let unrealized: number | null = 0
  let open = 0
  let openStake = 0
  for (const executor of mine) {
    if (executor.status === 'active') {
      open++
      openStake += executor.type === 'position' ? (executor.params as { amountQuote?: number }).amountQuote ?? 0 : 0
      const now = openResult(executor)
      unrealized = unrealized === null || now === null ? null : unrealized + now
    } else if (executor.book?.result !== undefined) {
      realized += executor.book.result.netQuote
      closed++
    }
  }
  const settledEquity = settings.startQuote + realized
  return { id, startQuote: settings.startQuote, realizedQuote: realized, unrealizedQuote: unrealized, settledEquity, equity: unrealized === null ? null : settledEquity + unrealized, open, openStakeQuote: openStake, closed }
}

/** One line of a book's equity marks. */
export interface BookEquityMark {
  v: typeof PAPER_BOOKS_VERSION
  book: BookId
  startedAt: number
  at: number
  equity: number | null
  settledEquity: number
  realizedQuote: number
  unrealizedQuote: number | null
  open: number
  openStakeQuote: number
}

/** The peak equity and the deepest fall from a peak, in percent, over a book's marks in order. */
export function drawdownOf(marks: readonly Pick<BookEquityMark, 'equity' | 'at'>[]): { peak: number | null; drawdownPct: number; deepestPct: number } {
  let peak: number | null = null
  let deepest = 0
  let last = 0
  for (const mark of [...marks].sort((a, b) => a.at - b.at)) {
    if (mark.equity === null) continue
    if (peak === null || mark.equity > peak) peak = mark.equity
    last = peak > 0 ? ((mark.equity - peak) / peak) * 100 : 0
    if (last < deepest) deepest = last
  }
  return { peak, drawdownPct: last, deepestPct: deepest }
}

/** Why a book cannot open one more trade of `stakeQuote` now, or null when it can. `dayStartEquity` is the
 * equity of the book's first mark of the UTC day (its settled equity where it has none yet). */
export function bookRoomProblem(input: {
  books: PaperBooksSettings
  id: BookId
  standing: BookStanding
  stakeQuote: number
  dayStartEquity: number | null
}): string | null {
  const { books, id, standing, stakeQuote } = input
  const settings = books.books[id]
  if (!books.running) return 'The paper books are not running: Start paper testing on Paper Trading starts them.'
  if (standing.open >= settings.maxOpen) return `The ${id} book has ${standing.open} trades open, its most.`
  if (stakeQuote > settings.maxStakeShare * standing.settledEquity + 1e-9) return `A stake of ${stakeQuote.toFixed(2)} is over the ${Math.round(settings.maxStakeShare * 100)}% of the ${id} book's ${standing.settledEquity.toFixed(2)} one trade may stake.`
  const start = input.dayStartEquity ?? standing.settledEquity
  const now = standing.equity ?? standing.settledEquity
  if (start > 0 && now <= start * (1 - settings.dailyStopPct / 100)) return `The ${id} book is ${(((start - now) / start) * 100).toFixed(2)}% under the day's start, past its ${settings.dailyStopPct}% daily stop: no new trade until the next UTC day.`
  return null
}
