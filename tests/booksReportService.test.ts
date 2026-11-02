import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import { DEFAULT_PAPER_BOOKS } from '../shared/paperBooks'
import { PAPER_TESTING_VERSION } from '../shared/paperTesting'

// THE BOOKS' RUN READ IN THE MAIN PROCESS (electron/services/booksReportService.ts; V8 Stage 10): the run that runs or
// ran last, its end its Stop where filed, each book from its trades -- those moved to the archive among them -- and
// marks, the copy book's leaders from their events, the baseline's hold and Bitcoin from Binance's bars; kept a few
// minutes. The settings, the leaders' events and the bars are faked at their services; the books' files are real.

let settings: Record<string, unknown> = {}
const asked = vi.hoisted(() => ({ bars: [] as string[], events: [] as string[] }))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => settings }))
vi.mock('../electron/services/followService', () => ({
  leaderEventsOf: async (traderKey: string) => {
    asked.events.push(traderKey)
    return new Map([
      ['e1', { before: 0, after: 1, px: 100 }],
      ['e2', { before: 1, after: 0, px: 105 }]
    ])
  }
}))
vi.mock('../electron/services/marketService', () => ({
  fetchHistoricalRange: async (_exchange: string, symbol: string, interval: string, fromSec: number, toSec: number) => {
    asked.bars.push(`${symbol}:${interval}`)
    const width = interval === '1d' ? 86_400 : 60
    const candles: Candle[] = []
    for (let time = Math.ceil(fromSec / width) * width; time <= toSec; time += width) {
      // Every symbol up 1% a day from 100; Bitcoin likewise.
      const price = 100 * (1 + 0.01 * ((time - STARTED) / 86_400))
      candles.push({ time, open: price, high: price, low: price, close: price, volume: 1 })
    }
    return { candles, cancelled: false }
  }
}))

const STARTED = 1_793_000_040
const NOW = STARTED + 2 * 86_400 + 3600
let dir = ''

beforeAll(async () => {
  await import('../electron/services/booksReportService')
}, 60_000)

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'books-report-'))
  asked.bars = []
  asked.events = []
  const books = await import('../electron/services/booksService')
  books.booksSeam.dir = () => dir
  books.booksSeam.now = () => NOW
  ;(await import('../electron/services/booksReportService')).resetBooksReport()
})

const follow = (id: string, closedAt: number) => ({
  id,
  type: 'position',
  mode: 'paper',
  status: 'stopped',
  symbol: 'ETHUSDT',
  params: {},
  follow: { traderKey: 'hyperliquid-0x0b4b6beaca45fce66ca818fbd867ec3761ed2143', openedOnKey: `k:${id}`, maxStakeQuote: 1000, side: 'long', legs: [{ eventKey: 'e1' }, { eventKey: 'e2' }], closeReason: 'leader closed' },
  book: { id: 'copy', startedAt: STARTED, ledger: 'follow', result: { netQuote: 30, netPct: 3, feesQuote: 1, fundingQuote: 0, closedAt } }
})

describe("the books' report", () => {
  it('is nothing before the first Start', async () => {
    settings = { paperBooks: DEFAULT_PAPER_BOOKS, executors: [] }
    expect(await (await import('../electron/services/booksReportService')).booksReport(NOW)).toEqual({ startedAt: null, running: false, reports: [] })
  })

  it("reads each book of the run running now: the archive's trades, the leaders' own, the hold and Bitcoin, kept a while", async () => {
    settings = { paperBooks: { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: STARTED }, executors: [follow('f1', STARTED + 3600)] }
    writeFileSync(join(dir, `archive-${new Date(NOW * 1000).toISOString().slice(0, 7)}.jsonl`), `${JSON.stringify(follow('f0', STARTED + 600))}\n`)
    writeFileSync(
      join(dir, `misses-${new Date(NOW * 1000).toISOString().slice(0, 7)}.jsonl`),
      `${JSON.stringify({ v: 'miss-v1', at: STARTED + 60, book: 'news', writer: 'news-rule', pair: 'XUSDT', side: 'down', refPrice: null, stage: 'gate', reason: 'No venue could take this: neither Binance nor Bitget lists a USDT perpetual of X.', predictionId: null, shadow: false })}\n`
    )
    const service = await import('../electron/services/booksReportService')
    const report = await service.booksReport(NOW)
    expect(report).toMatchObject({ startedAt: STARTED, running: true })
    const [news, copy, baseline] = report.reports
    expect(news).toMatchObject({ book: 'news', trades: 0, noVenue: 1, endedAt: NOW })
    expect([report.reports[1].noVenue, report.reports[2].noVenue]).toEqual([0, 0])
    expect(copy).toMatchObject({ book: 'copy', trades: 2, events: 2, benchmark: { kind: 'leader', compared: 2, notCompared: 0 } })
    expect(copy.benchmark.pct).toBeCloseTo(5, 9)
    expect(asked.events).toEqual(['hyperliquid-0x0b4b6beaca45fce66ca818fbd867ec3761ed2143'])
    // Every symbol rose 1% a day from the Start: the hold and Bitcoin moved alike over the run.
    expect(baseline.benchmark.kind).toBe('hold')
    // The Start and the end fall on whole minutes: each read at its own minute's open.
    expect(baseline.benchmark.pct).toBeCloseTo(0.01 * ((NOW - STARTED) / 86_400) * 100, 9)
    expect(baseline.btcPct).toBeCloseTo(baseline.benchmark.pct as number, 9)
    const reads = asked.bars.length
    await service.booksReport(NOW)
    expect(asked.bars).toHaveLength(reads)
  })

  it('ends a stopped run at its Stop, as filed', async () => {
    settings = { paperBooks: { ...DEFAULT_PAPER_BOOKS, running: false, startedAt: STARTED }, executors: [] }
    writeFileSync(join(dir, `runs-${new Date(NOW * 1000).toISOString().slice(0, 7)}.jsonl`), `${JSON.stringify({ v: PAPER_TESTING_VERSION, startedAt: STARTED, stoppedAt: STARTED + 86_400, switched: [], restored: true })}\n`)
    const report = await (await import('../electron/services/booksReportService')).booksReport(NOW)
    expect(report.running).toBe(false)
    expect(report.reports.map((book) => book.endedAt)).toEqual([STARTED + 86_400, STARTED + 86_400, STARTED + 86_400])
  })
})
