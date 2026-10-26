import { describe, expect, it } from 'vitest'
import type { ExecutorConfig } from '../shared/ipc'
import {
  BOOK_IDS,
  DEFAULT_PAPER_BOOKS,
  bookExecutors,
  bookOf,
  bookRoomProblem,
  bookStandingOf,
  drawdownOf,
  healPaperBooks,
  type BookMark,
  type PaperBooksSettings
} from '../shared/paperBooks'
import { MISS_VERSION, readMiss } from '../shared/misses'

// THREE PAPER BOOKS, EACH ITS OWN $10,000 (shared/paperBooks.ts; V8 Stage 2): a book reads only the executors its
// writer stamped, its money derived from them -- start, results, open results -- its drawdown from its marks, and
// its room for one more trade from its own caps and daily stop, nothing shared with another book.

const STARTED = 1_792_000_000

function executor(id: string, over: Partial<ExecutorConfig> & { book?: BookMark } = {}): ExecutorConfig {
  return {
    id,
    name: id,
    type: 'position',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    createdAt: STARTED + 60,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    params: { amountQuote: 500 } as never,
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    ...over
  } as ExecutorConfig
}

const mark = (over: Partial<BookMark> = {}): BookMark => ({ id: 'news', startedAt: STARTED, ledger: 'rule', ...over })
const running: PaperBooksSettings = { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: STARTED }

describe('the setting', () => {
  it('is nothing running and 10,000 a book on a fresh install, and heals what is not a choice', () => {
    expect(healPaperBooks(undefined)).toEqual(DEFAULT_PAPER_BOOKS)
    expect(DEFAULT_PAPER_BOOKS.running).toBe(false)
    expect(BOOK_IDS.map((id) => DEFAULT_PAPER_BOOKS.books[id].startQuote)).toEqual([10_000, 10_000, 10_000])
    const healed = healPaperBooks({ running: 'yes', startedAt: STARTED, books: { news: { startQuote: 7777, maxOpen: 2.5, maxStakeShare: 0.9, dailyStopPct: 4 }, copy: { startQuote: 25_000, maxOpen: 3 } } })
    expect(healed.running).toBe(false)
    expect(healed.books.news).toEqual({ ...DEFAULT_PAPER_BOOKS.books.news, dailyStopPct: 4 })
    expect(healed.books.copy).toMatchObject({ startQuote: 25_000, maxOpen: 3 })
    // Running without a start is not running.
    expect(healPaperBooks({ running: true }).running).toBe(false)
    expect(healPaperBooks({ running: true, startedAt: STARTED }).running).toBe(true)
  })
})

describe('which book a trade is in', () => {
  it("is its mark's, for a paper trade alone; everything else is other", () => {
    expect(bookOf(executor('a', { book: mark() }))).toBe('news')
    expect(bookOf(executor('b'))).toBe('other')
    expect(bookOf(executor('c', { book: mark(), mode: 'live' }))).toBe('other')
    expect(bookOf(executor('d', { book: { ...mark(), id: 'forged' as never } }))).toBe('other')
    // A trade of an earlier run of the book is not this run's.
    const list = [executor('now', { book: mark() }), executor('then', { book: mark({ startedAt: STARTED - 86_400 }) }), executor('copy', { book: mark({ id: 'copy', ledger: 'follow' }) })]
    expect(bookExecutors(list, 'news', STARTED).map((entry) => entry.id)).toEqual(['now'])
  })
})

describe("a book's standing", () => {
  const list = [
    executor('won', { status: 'stopped', book: mark({ result: { netQuote: 120, netPct: 12, feesQuote: 2, fundingQuote: 0, closedAt: STARTED + 3600 } }) }),
    executor('lost', { status: 'stopped', book: mark({ result: { netQuote: -40, netPct: -8, feesQuote: 1, fundingQuote: -0.5, closedAt: STARTED + 7200 } }) }),
    executor('open', { book: mark() }),
    executor('stopped-unsettled', { status: 'stopped', book: mark() }),
    executor('other-book', { status: 'stopped', book: mark({ id: 'copy', ledger: 'follow', result: { netQuote: 999, netPct: 9, feesQuote: 0, fundingQuote: 0, closedAt: STARTED } }) }),
    executor('not-a-book', { status: 'stopped' })
  ]

  it('is its start and its own results, open ones priced now, and nothing of another book', () => {
    const standing = bookStandingOf('news', DEFAULT_PAPER_BOOKS.books.news, list, STARTED, (entry) => (entry.id === 'open' ? 15 : null))
    expect(standing).toEqual({ id: 'news', startQuote: 10_000, realizedQuote: 80, unrealizedQuote: 15, settledEquity: 10_080, equity: 10_095, open: 1, openStakeQuote: 500, closed: 2 })
  })

  it('has no equity where an open trade cannot be priced, and keeps its settled equity for sizing', () => {
    const standing = bookStandingOf('news', DEFAULT_PAPER_BOOKS.books.news, list, STARTED, () => null)
    expect(standing.unrealizedQuote).toBeNull()
    expect(standing.equity).toBeNull()
    expect(standing.settledEquity).toBe(10_080)
  })
})

describe('the drawdown', () => {
  it('reads the peak and the deepest fall from the marks in time order, past an unpriced mark', () => {
    const marks = [
      { at: 3, equity: 10_300 },
      { at: 1, equity: 10_000 },
      { at: 2, equity: 10_500 },
      { at: 4, equity: null },
      { at: 5, equity: 9_975 }
    ]
    const drawdown = drawdownOf(marks)
    expect(drawdown.peak).toBe(10_500)
    expect(drawdown.drawdownPct).toBeCloseTo(-5, 10)
    expect(drawdown.deepestPct).toBeCloseTo(-5, 10)
    expect(drawdownOf([])).toEqual({ peak: null, drawdownPct: 0, deepestPct: 0 })
    expect(drawdownOf([{ at: 1, equity: 100 }, { at: 2, equity: 90 }, { at: 3, equity: 120 }]).drawdownPct).toBe(0)
    expect(drawdownOf([{ at: 1, equity: 100 }, { at: 2, equity: 90 }, { at: 3, equity: 120 }]).deepestPct).toBeCloseTo(-10, 10)
  })
})

describe('room for one more trade', () => {
  const standing = (over: Partial<ReturnType<typeof bookStandingOf>> = {}) => ({ id: 'news' as const, startQuote: 10_000, realizedQuote: 0, unrealizedQuote: 0, settledEquity: 10_000, equity: 10_000, open: 0, openStakeQuote: 0, closed: 0, ...over })

  it('is there while the book runs, has room for another, the stake is within its share and the day is above its stop', () => {
    expect(bookRoomProblem({ books: running, id: 'news', standing: standing(), stakeQuote: 1000, dayStartEquity: 10_000 })).toBeNull()
  })

  it('says why it is not: stopped, full, a stake over its share, or past the daily stop', () => {
    expect(bookRoomProblem({ books: DEFAULT_PAPER_BOOKS, id: 'news', standing: standing(), stakeQuote: 100, dayStartEquity: null })).toMatch(/not running/)
    expect(bookRoomProblem({ books: running, id: 'news', standing: standing({ open: 5 }), stakeQuote: 100, dayStartEquity: null })).toMatch(/has 5 trades open, its most/)
    expect(bookRoomProblem({ books: running, id: 'news', standing: standing(), stakeQuote: 1000.01, dayStartEquity: null })).toMatch(/over the 10% of the news book's 10000.00/)
    // 3% under the day's start stops it; just above does not.
    expect(bookRoomProblem({ books: running, id: 'news', standing: standing({ equity: 9_700 }), stakeQuote: 100, dayStartEquity: 10_000 })).toMatch(/past its 3% daily stop/)
    expect(bookRoomProblem({ books: running, id: 'news', standing: standing({ equity: 9_701 }), stakeQuote: 100, dayStartEquity: 10_000 })).toBeNull()
    // Without a priced equity the settled one is read.
    expect(bookRoomProblem({ books: running, id: 'news', standing: standing({ equity: null, settledEquity: 9_600 }), stakeQuote: 100, dayStartEquity: 10_000 })).toMatch(/daily stop/)
  })

  it('sizes a stake on the settled equity, never on open results', () => {
    // 10,000 settled with 2,000 of open profit: 10% is 1,000 of the settled, not 1,200 of the marked.
    expect(bookRoomProblem({ books: running, id: 'news', standing: standing({ equity: 12_000 }), stakeQuote: 1100, dayStartEquity: null })).toMatch(/over the 10%/)
    expect(bookRoomProblem({ books: running, id: 'news', standing: standing({ equity: 12_000 }), stakeQuote: 1000, dayStartEquity: null })).toBeNull()
  })

  it("is each book's own: one book full leaves another its room", () => {
    expect(bookRoomProblem({ books: running, id: 'copy', standing: { ...standing(), id: 'copy', open: 14 }, stakeQuote: 100, dayStartEquity: null })).toBeNull()
    expect(bookRoomProblem({ books: running, id: 'copy', standing: { ...standing(), id: 'copy', open: 15 }, stakeQuote: 100, dayStartEquity: null })).toMatch(/15 trades open/)
  })
})

describe('a missed opportunity', () => {
  const whole = { v: MISS_VERSION, at: STARTED, book: 'news', writer: 'news-card', pair: 'XYZUSDT', side: 'down', refPrice: 1.5, stage: 'liquidity', reason: 'thin', predictionId: 'p:1', shadow: false }

  it('is read as written, and refused where any part is not one', () => {
    expect(readMiss(whole)).toEqual(whole)
    for (const bad of [null, { ...whole, v: 'miss-v0' }, { ...whole, stage: 'bored' }, { ...whole, book: 'mine' }, { ...whole, side: 'flat' }, { ...whole, refPrice: 0 }, { ...whole, writer: '' }, { ...whole, shadow: 'no' }, { ...whole, predictionId: 5 }]) {
      expect(readMiss(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull()
    }
    expect(readMiss({ ...whole, reason: 'x'.repeat(1000) })!.reason).toHaveLength(400)
  })
})

describe("the refusals of the writers that were there before V8", () => {
  it('are misses of book other, a pair told at most once an hour by each writer', async () => {
    const { refusalsAsMisses } = await import('../src/books/recordRefusals')
    const told = new Map<string, number>()
    const first = refusalsAsMisses('lab', [{ pair: 'SOLUSDT', why: 'No live price.' }, { pair: 'ETHUSDT', why: 'Its plan does not hold.' }], STARTED, told)
    expect(first).toEqual([
      { v: MISS_VERSION, at: STARTED, book: 'other', writer: 'lab', pair: 'SOLUSDT', side: null, refPrice: null, stage: 'gate', reason: 'No live price.', predictionId: null, shadow: false },
      { v: MISS_VERSION, at: STARTED, book: 'other', writer: 'lab', pair: 'ETHUSDT', side: null, refPrice: null, stage: 'gate', reason: 'Its plan does not hold.', predictionId: null, shadow: false }
    ])
    expect(first.every((miss) => readMiss(miss) !== null)).toBe(true)
    // The next pass, five minutes on: nothing again for the same pairs; another writer's own.
    expect(refusalsAsMisses('lab', [{ pair: 'SOLUSDT', why: 'No live price.' }], STARTED + 300, told)).toEqual([])
    expect(refusalsAsMisses('forecast-trader', [{ pair: 'SOLUSDT', why: 'x' }], STARTED + 300, told)).toHaveLength(1)
    // An hour on, told again.
    expect(refusalsAsMisses('lab', [{ pair: 'SOLUSDT', why: 'No live price.' }], STARTED + 3600, told)).toHaveLength(1)
  })
})
