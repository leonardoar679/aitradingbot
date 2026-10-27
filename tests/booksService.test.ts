import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MISS_VERSION } from '../shared/misses'
import { DEFAULT_PAPER_BOOKS } from '../shared/paperBooks'
import { SOURCE_RECORD_VERSION } from '../shared/evaluation/predictionRecord'

// THE PAPER BOOKS' FILES AND BRIDGES (electron/services/booksService.ts, electron/ipc/handlers/booksHandlers.ts;
// V8 Stage 2): a miss written and read back, each book's equity marked only while the books run, and the window
// held to recording its own kind of prediction alone.

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
let settings: Record<string, unknown> = {}

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) } }))
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => settings }))

let dir = ''
const STARTED = 1_792_000_000

beforeEach(() => {
  vi.resetModules()
  handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'books-'))
  settings = {}
})

async function service() {
  const module = await import('../electron/services/booksService')
  module.booksSeam.dir = () => dir
  module.booksSeam.now = () => STARTED + 3600
  return module
}

const miss = { v: MISS_VERSION, at: STARTED + 10, book: 'copy', writer: 'follow', pair: 'ETHUSDT', side: 'up', refPrice: 2400, stage: 'cap', reason: 'five open for the trader', predictionId: null, shadow: false }

describe('a missed opportunity on file', () => {
  it('is written whole into its month, read back, and a broken one is refused before anything is written', async () => {
    const books = await service()
    await books.recordMiss(miss)
    await books.recordMiss({ ...miss, at: STARTED - 400 * 86_400, pair: 'OLDUSDT' })
    await expect(books.recordMiss({ ...miss, stage: 'bored' })).rejects.toThrow(/not a whole miss-v1 line/)
    expect((await books.listMisses()).map((entry) => entry.pair)).toEqual(['OLDUSDT', 'ETHUSDT'])
    expect((await books.listMisses(STARTED)).map((entry) => entry.pair)).toEqual(['ETHUSDT'])
    const month = new Date((STARTED + 10) * 1000).toISOString().slice(0, 7)
    expect(readFileSync(join(dir, `misses-${month}.jsonl`), 'utf-8').trim().split('\n')).toHaveLength(1)
  })
})

describe("the books' equity marks", () => {
  it('writes nothing while the books are stopped', async () => {
    settings = { paperBooks: DEFAULT_PAPER_BOOKS, executors: [] }
    const books = await service()
    expect(await books.markBookEquity()).toEqual([])
  })

  it('marks each book while they run, and reads a book of its run back alone', async () => {
    settings = { paperBooks: { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: STARTED }, executors: [] }
    const books = await service()
    const marks = await books.markBookEquity()
    expect(marks.map((mark) => [mark.book, mark.equity, mark.settledEquity, mark.open])).toEqual([
      ['news', 10_000, 10_000, 0],
      ['copy', 10_000, 10_000, 0],
      ['baseline', 10_000, 10_000, 0]
    ])
    expect((await books.listEquityMarks('copy', STARTED)).map((mark) => mark.book)).toEqual(['copy'])
    expect(await books.listEquityMarks('copy', STARTED - 1)).toEqual([])
  })
})

describe('the bridges', () => {
  async function registered() {
    const ledger = await import('../electron/services/predictionLedgerService')
    ledger.resetPredictionLedger()
    ledger.predictionLedgerSeam.dir = () => dir
    const books = await import('../electron/services/booksService')
    books.booksSeam.dir = () => dir
    const module = await import('../electron/ipc/handlers/booksHandlers')
    module.registerBooksHandlers()
    return { ledger, module }
  }
  const prediction = (source: string) => ({
    v: SOURCE_RECORD_VERSION,
    id: `${source}:BTCUSDT:${STARTED}`,
    source,
    sourceVersion: 'v1',
    kind: 'direction',
    pair: 'BTCUSDT',
    venue: 'binance',
    madeAt: STARTED,
    bar: null,
    horizonSec: 3600,
    refPrice: 80_000,
    side: 'up',
    movePct: 1,
    targetPrice: 80_800,
    window: null,
    dist: { pRight: null, q: null, pMove: null },
    scenarios: null,
    cost: null,
    expectedNet: null,
    reason: 'my view',
    evidence: [],
    unit: 1,
    versions: { engine: 'e', config: 'c' }
  })

  it("record a person's own call from the window, and never a rule's, a reading's or a trader's", async () => {
    const { ledger, module } = await registered()
    expect(module.WINDOW_SOURCES).toEqual(['user'])
    const record = handlers.get('predictions:record')!
    expect(await record({}, prediction('user'))).toEqual({ ok: true, id: `user:BTCUSDT:${STARTED}` })
    for (const source of ['delisting-rule', 'article', 'trader', 'big-movers']) {
      await expect(record({}, prediction(source))).rejects.toThrow(`The window cannot record a ${source} prediction.`)
    }
    await expect(record({}, { ...prediction('user'), kind: 'nonsense' })).rejects.toThrow(/Not a whole prediction/)
    expect(ledger.owedCount()).toBe(1)
    expect((await handlers.get('predictions:list')!({}, { source: 'user' })) as unknown[]).toHaveLength(1)
  })

  it('refuse a book that is not one, and read the misses since a moment', async () => {
    await registered()
    await expect(handlers.get('books:marks')!({}, { book: 'mine', startedAt: STARTED })).rejects.toThrow(/Name a book/)
    await handlers.get('books:miss')!({}, miss)
    expect(((await handlers.get('books:misses')!({}, 'soon')) as unknown[]).length).toBe(1)
  })
})

describe("the books' archive (V8 Stage 8)", () => {
  const trade = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    type: 'position',
    mode: 'paper',
    status: 'stopped',
    params: { amountQuote: 1000 },
    book: { id: 'copy', startedAt: STARTED, ledger: 'follow', result: { netQuote: 25, netPct: 2.5, feesQuote: 1, fundingQuote: 0, closedAt: STARTED + 60 } },
    ...over
  })

  it("keeps only a book's settled trades, and a book's standing counts them beside the settings, each once", async () => {
    const books = await service()
    const open = trade('open', { status: 'active', book: { id: 'copy', startedAt: STARTED, ledger: 'follow' } })
    const person = trade('person', { book: undefined })
    // A trade stopped with no result yet, or one still open that somehow carries one, stays.
    const unsettled = trade('unsettled', { book: { id: 'copy', startedAt: STARTED, ledger: 'follow' } })
    const running = trade('running', { status: 'active' })
    expect(await books.archiveSettled([trade('a'), open, person, unsettled, running, trade('live', { mode: 'live' }), 'junk'])).toBe(1)
    expect(await books.archiveSettled('nothing')).toBe(0)
    settings = { paperBooks: { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: STARTED }, executors: [trade('b'), trade('a')] }
    const copy = (await books.bookStandings()).standings.find((standing) => standing.id === 'copy')
    // "a" is in both the settings and the archive: counted once; "b" from the settings.
    expect(copy).toMatchObject({ realizedQuote: 50, closed: 2, settledEquity: 10_050 })
    settings = { paperBooks: { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: STARTED }, executors: [] }
    expect((await books.bookStandings()).standings.find((standing) => standing.id === 'copy')).toMatchObject({ realizedQuote: 25, closed: 1 })
  })
})

describe("a book's standing, its open trades valued (V8 Stage 9)", () => {
  it("values each open trade from its stamp at its price now, and reads the day's start from the run's marks", async () => {
    const books = await service()
    const now = STARTED + 3600
    const prices: string[] = []
    books.booksSeam.price = async (ref) => {
      prices.push(`${ref.kind}:${ref.symbol}`)
      return ref.symbol === 'ETHUSDT' ? 1900 : null
    }
    const follow = {
      id: 'f',
      type: 'position',
      mode: 'paper',
      status: 'active',
      params: { amountQuote: 1000 },
      book: { id: 'copy', startedAt: STARTED, ledger: 'follow' },
      follow: { venue: 'binance', symbol: 'ETHUSDT', side: 'short', size: 0.5, avgPx: 2000, realizedQuote: 0, feesQuote: 0.5, maxStakeQuote: 1000, openedAtMs: (now - 60) * 1000 }
    }
    // A trade of an earlier run is not this run's: not priced.
    const earlier = { ...follow, id: 'old', book: { ...follow.book, startedAt: STARTED - 86_400 }, follow: { ...follow.follow, symbol: 'OLDUSDT' } }
    settings = { paperBooks: { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: STARTED }, executors: [follow, earlier] }
    let copy = (await books.bookStandings()).standings.find((standing) => standing.id === 'copy')!
    // Short 0.5 from 2,000 at 1,900: 50, less 0.5 in and 0.475 out.
    expect(copy.unrealizedQuote).toBeCloseTo(50 - 0.5 - 0.475, 9)
    expect(copy.equity).toBeCloseTo(10_000 + 50 - 0.975, 9)
    expect(prices).toEqual(['perp:ETHUSDT'])
    // With no mark yet the day began at the book's start; the day's first mark once there is one.
    expect(copy.dayStartEquity).toBe(10_000)
    await books.markBookEquity()
    copy = (await books.bookStandings()).standings.find((standing) => standing.id === 'copy')!
    expect(copy.dayStartEquity).toBeCloseTo(10_000 + 50 - 0.975, 9)
    // A trade whose price cannot be read leaves its book's equity unknown, as before.
    settings = { ...settings, executors: [{ ...follow, follow: { ...follow.follow, symbol: 'XYZUSDT' } }] }
    expect((await books.bookStandings()).standings.find((standing) => standing.id === 'copy')!.equity).toBeNull()
    // Stopped books read no marks.
    settings = { paperBooks: { ...DEFAULT_PAPER_BOOKS, running: false, startedAt: null }, executors: [] }
    expect((await books.bookStandings()).standings.every((standing) => standing.dayStartEquity === null)).toBe(true)
  })
})
