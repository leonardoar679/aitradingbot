import { describe, expect, it } from 'vitest'
import type { ExecutorConfig } from '../shared/ipc'
import type { BookEquityMark } from '../shared/paperBooks'
import { bookRunReportOf, bookTradeRows, bookValueAt, eventKeyOf, leaderPctOf, meanByDay, pairedChangesOf, riskOf, verdictsOf } from '../shared/paperBooksReport'

// HOW A BOOK'S RUN IS READ (shared/paperBooksReport.ts; V8 Stage 10, V8-S9-BOOKS): each closed trade's net in percent and
// in R -- over its stop's distance times its size, or its whole stake without a stop -- the occasions its trades came
// from counted once, means with intervals by day, each book's benchmark, and the verdicts only on the registered counts.

const STARTED = 1_793_000_000
const DAY = 86_400

const result = (netQuote: number, stake: number, closedAt: number) => ({ netQuote, netPct: (netQuote / stake) * 100, feesQuote: 1, fundingQuote: 0, closedAt })
const base = (id: string, over: Record<string, unknown>): ExecutorConfig => ({ id, type: 'position', mode: 'paper', status: 'stopped', params: {}, book: { id: 'news', startedAt: STARTED, ledger: 'rule' }, ...over }) as unknown as ExecutorConfig

const news = (id: string, articleId: number, netQuote: number, closedAt: number, stopPx: number | null = null): ExecutorConfig =>
  base(id, { newsBook: { articleId, entryPx: 1, qty: 1000, stakeQuote: 1000, stopPx }, book: { id: 'news', startedAt: STARTED, ledger: 'rule', result: result(netQuote, 1000, closedAt) } })

describe("a trade's risk and occasion", () => {
  it('is its stop distance times its size where it has a stop, else its stake; and its announcement, position, close or signal', () => {
    expect(riskOf(news('a', 1, 0, STARTED))).toBe(1000)
    expect(riskOf(news('a', 1, 0, STARTED, 1.05))).toBeCloseTo(50, 9)
    const baseline = base('b', { baseline: { symbol: 'BTCUSDT', signalBarSec: 7, entryPx: 100, qty: 12.5, stopPx: 80 } })
    expect(riskOf(baseline)).toBe(250)
    expect(eventKeyOf(baseline)).toBe('baseline:BTCUSDT:7')
    const follow = base('f', { follow: { traderKey: 'k', openedOnKey: 'k:1', maxStakeQuote: 400 } })
    expect([riskOf(follow), eventKeyOf(follow)]).toEqual([400, 'follow:k:k:1'])
    const clone = base('c', { clone: { traderKey: 'k', signalKey: 'k:clone:ETH:1800', stakeQuote: 1000 } })
    // The coins of one close count as one occasion.
    expect([riskOf(clone), eventKeyOf(clone)]).toEqual([1000, 'clone:k:clone:1800'])
    expect(eventKeyOf(news('a', 9, 0, STARTED))).toBe('news:9')
    expect(riskOf(base('x', {}))).toBeNull()
  })

  it("reads a book's closed trades of the run alone, each once", () => {
    const trades = [news('a', 1, 10, STARTED + 100), news('b', 1, -5, STARTED + 50), { ...news('c', 2, 3, STARTED + 70), book: { id: 'news', startedAt: STARTED - 1, ledger: 'rule', result: result(3, 1000, STARTED + 70) } } as ExecutorConfig, base('d', { status: 'active', newsBook: { articleId: 3, entryPx: 1, qty: 1, stakeQuote: 1000, stopPx: null } })]
    const rows = bookTradeRows([...trades, trades[0]], 'news', STARTED)
    expect(rows.map((row) => row.eventKey)).toEqual(['news:1', 'news:1'])
    expect(rows.map((row) => row.netQuote)).toEqual([-5, 10])
  })
})

describe('a mean by day', () => {
  it('is the point with no interval on one day, and an interval resampled by day on several', () => {
    const one = meanByDay([{ atSec: STARTED, value: 1 }, { atSec: STARTED + 10, value: 3 }])
    expect(one?.value).toBe(2)
    expect(Number.isNaN(one?.low)).toBe(true)
    const many = meanByDay(Array.from({ length: 20 }, (_, k) => ({ atSec: STARTED + k * DAY, value: k % 2 === 0 ? 1 : 3 })))
    expect(many?.value).toBeCloseTo(2, 12)
    expect(many!.low).toBeLessThan(2)
    expect(many!.high).toBeGreaterThan(2)
    expect(meanByDay([])).toBeNull()
  })
})

describe("the copy book's leaders", () => {
  const events = new Map([
    ['e1', { before: 0, after: 2, px: 100 }],
    ['e2', { before: 2, after: 3, px: 103 }],
    ['e3', { before: 3, after: 0, px: 110 }]
  ])
  it("is each follow's leader's own percent on the position, from its fills weighted by its size changes", () => {
    const legs = ['e1', 'e2', 'e3'].map((eventKey) => ({ qty: 0, px: 0, atMs: 0, feeQuote: 0, eventKey }))
    // In at (2 x 100 + 1 x 103) / 3, out at 110.
    expect(leaderPctOf({ legs, side: 'long', closeReason: 'leader closed' }, events)).toBeCloseTo((110 / (303 / 3) - 1) * 100, 9)
    expect(leaderPctOf({ legs, side: 'short', closeReason: 'leader closed' }, events)).toBeCloseTo(-(110 / (303 / 3) - 1) * 100, 9)
    // A flip closes the old position in full at its fill.
    const flip = new Map([
      ['e1', { before: 0, after: -2, px: 100 }],
      ['e4', { before: -2, after: 1, px: 90 }]
    ])
    expect(leaderPctOf({ legs: [legs[0], { ...legs[0], eventKey: 'e4' }], side: 'short', closeReason: 'leader flipped' }, flip)).toBeCloseTo(10, 9)
    // A short covered in part at 95, then flipped from the rest to a larger long at 90: out at (1 x 95 + 1 x 90) / 2.
    const partial = new Map([
      ['e1', { before: 0, after: -2, px: 100 }],
      ['e2', { before: -2, after: -1, px: 95 }],
      ['e3', { before: -1, after: 3, px: 90 }]
    ])
    const three = ['e1', 'e2', 'e3'].map((eventKey) => ({ ...legs[0], eventKey }))
    expect(leaderPctOf({ legs: three, side: 'short', closeReason: 'leader flipped' }, partial)).toBeCloseTo(-(92.5 / 100 - 1) * 100, 9)
    // The leader's position still open, or an event not read: no comparison.
    expect(leaderPctOf({ legs, side: 'long', closeReason: 'time' }, events)).toBeNull()
    expect(leaderPctOf({ legs: [...legs, { ...legs[0], eventKey: 'gone' }], side: 'long', closeReason: 'leader closed' }, events)).toBeNull()
  })
})

describe("the baseline's hold", () => {
  it("is the book's and the hold's changes between the same moments, the book valued at its last mark before each", () => {
    const marks: Pick<BookEquityMark, 'at' | 'equity' | 'settledEquity'>[] = [
      { at: STARTED, equity: 10_000, settledEquity: 10_000 },
      { at: STARTED + DAY - 60, equity: 10_100, settledEquity: 10_000 },
      { at: STARTED + 2 * DAY - 60, equity: null, settledEquity: 10_050 }
    ]
    expect(bookValueAt(marks, STARTED + DAY)).toBe(10_100)
    expect(bookValueAt(marks, STARTED + 2 * DAY)).toBe(10_050)
    expect(bookValueAt(marks, STARTED - 1)).toBeNull()
    const changes = pairedChangesOf(
      [
        { atSec: STARTED, value: 1 },
        { atSec: STARTED + DAY, value: 1.02 },
        { atSec: STARTED + 2 * DAY, value: 1.01 }
      ],
      marks
    )
    expect(changes.map((change) => [change.atSec, +change.bookPct.toFixed(6), +change.holdPct.toFixed(6)])).toEqual([
      [STARTED + DAY, 1, 2],
      [STARTED + 2 * DAY, +((10_050 / 10_100 - 1) * 100).toFixed(6), +((1.01 / 1.02 - 1) * 100).toFixed(6)]
    ])
  })
})

describe('the verdicts', () => {
  const figure = (low: number) => ({ value: low + 1, low, high: low + 2, sd: 1 })
  it('are too few to call short of 30 closed trades or 10 events, whatever the figures; then by the lower ends', () => {
    expect(verdictsOf(29, 50, figure(5), figure(5))).toEqual({ profitable: 'too few', better: 'too few' })
    expect(verdictsOf(100, 9, figure(5), figure(5))).toEqual({ profitable: 'too few', better: 'too few' })
    expect(verdictsOf(30, 10, figure(0.01), figure(-0.01))).toEqual({ profitable: 'yes', better: 'no' })
    expect(verdictsOf(30, 10, figure(-0.01), figure(0.01))).toEqual({ profitable: 'no', better: 'yes' })
    expect(verdictsOf(30, 10, null, null)).toEqual({ profitable: 'no', better: 'no' })
  })
})

describe("a book's run, read whole", () => {
  it("is the news book's against cash: its own mean is the difference; its trades no venue could take apart", () => {
    const trades = Array.from({ length: 4 }, (_, k) => news(`n${k}`, k < 2 ? 1 : k, 20 - k * 10, STARTED + k * DAY + 100))
    const report = bookRunReportOf({ book: 'news', startedAt: STARTED, endedAt: STARTED + 5 * DAY, running: true, startQuote: 10_000, executors: trades, marks: [{ v: 'paper-books-v1', book: 'news', startedAt: STARTED, at: STARTED + 5 * DAY, equity: 10_020, settledEquity: 10_020, realizedQuote: 20, unrealizedQuote: 0, open: 0, openStakeQuote: 0 }], leaderEvents: new Map(), hold: [], btcPct: -1.5, noVenue: 2 })
    expect(report).toMatchObject({ trades: 4, events: 3, open: 0, noVenue: 2, btcPct: -1.5, profitable: 'too few', better: 'too few' })
    expect(report.equityReturnPct).toBeCloseTo(0.2, 9)
    expect(report.meanPct?.value).toBeCloseTo((2 + 1 + 0 - 1) / 4, 9)
    expect(report.meanR?.value).toBeCloseTo((0.02 + 0.01 + 0 - 0.01) / 4, 9)
    expect(report.benchmark).toMatchObject({ kind: 'cash', pct: 0, compared: 4 })
    expect(report.benchmark.difference).toEqual(report.meanPct)
  })

  it("is the copy book's against its leaders, follow by follow, those not comparable counted; and the baseline's against its hold", () => {
    const events = new Map([
      ['e1', { before: 0, after: 1, px: 100 }],
      ['e2', { before: 1, after: 0, px: 110 }]
    ])
    const follow = (id: string, legs: string[], closeReason: string, netPct: number): ExecutorConfig =>
      base(id, {
        follow: { traderKey: 'k', openedOnKey: `k:${id}`, maxStakeQuote: 1000, side: 'long', legs: legs.map((eventKey) => ({ qty: 0, px: 0, atMs: 0, feeQuote: 0, eventKey })), closeReason },
        book: { id: 'copy', startedAt: STARTED, ledger: 'follow', result: { netQuote: netPct * 10, netPct, feesQuote: 1, fundingQuote: 0, closedAt: STARTED + DAY } }
      })
    const copy = bookRunReportOf({ book: 'copy', startedAt: STARTED, endedAt: STARTED + 2 * DAY, running: false, startQuote: 10_000, executors: [follow('f1', ['e1', 'e2'], 'leader closed', 8), follow('f2', ['e1'], 'time', 1)], marks: [], leaderEvents: events, hold: [], btcPct: null, noVenue: 0 })
    expect(copy.benchmark).toMatchObject({ kind: 'leader', compared: 1, notCompared: 1 })
    expect(copy.benchmark.pct).toBeCloseTo(10, 9)
    expect(copy.benchmark.difference?.value).toBeCloseTo(-2, 9)
    const baseline = bookRunReportOf({
      book: 'baseline',
      startedAt: STARTED,
      endedAt: STARTED + 2 * DAY,
      running: true,
      startQuote: 10_000,
      executors: [],
      marks: [
        { v: 'paper-books-v1', book: 'baseline', startedAt: STARTED, at: STARTED, equity: 10_000, settledEquity: 10_000, realizedQuote: 0, unrealizedQuote: 0, open: 0, openStakeQuote: 0 },
        { v: 'paper-books-v1', book: 'baseline', startedAt: STARTED, at: STARTED + 2 * DAY, equity: 10_000, settledEquity: 10_000, realizedQuote: 0, unrealizedQuote: 0, open: 0, openStakeQuote: 0 }
      ],
      leaderEvents: new Map(),
      hold: [
        { atSec: STARTED, value: 1 },
        { atSec: STARTED + 2 * DAY, value: 1.05 }
      ],
      btcPct: null,
      noVenue: 0
    })
    expect(baseline.benchmark.kind).toBe('hold')
    expect(baseline.benchmark.pct).toBeCloseTo(5, 9)
    expect(baseline.benchmark.difference?.value).toBeCloseTo(-5, 9)
    expect(baseline.trades).toBe(0)
  })
})
