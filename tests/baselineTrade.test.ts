import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle, ExecutorConfig } from '../shared/ipc'
import type { MissRecord } from '../shared/misses'
import { DEFAULT_PAPER_BOOKS, type BookStanding } from '../shared/paperBooks'

// THE BASELINE BOOK'S WRITER (src/baseline/baselineTrade.ts; V8 Stage 9): at each 4-hour close, each symbol's exits,
// then its entry -- once, the run's own, on time, through the book's room and Binance's book -- every refusal a miss
// under the symbol's and bar's key, written once; and at Stop, every open trade closed at the price then. The strategy's
// signals are set by each test here (the strategy itself is read in tests/baseline.test.ts).

const plan = vi.hoisted(() => ({
  signalOf: (() => ({ entry: false, exit: false, stop: null })) as (symbol: string, time: number) => { entry: boolean; exit: boolean; stop: number | null },
  symbolOf: new WeakMap<object, string>()
}))

vi.mock('../src/backtest/strategies/trendRegimeEnsemble', () => ({
  trendRegimeEnsemble: {
    id: 'trend-regime-ensemble',
    preferredInterval: '4h',
    warmupBarsFor: () => 480,
    generateSignals: (candles: Candle[]) => {
      const symbol = candles.length === 0 ? '' : (plan.symbolOf.get(candles[0]) ?? '')
      const rows = candles.map((candle) => plan.signalOf(symbol, candle.time))
      return { entries: rows.map((row) => row.entry), exits: rows.map((row) => row.exit), stopPrices: rows.map((row) => (row.entry ? row.stop : null)), warmupBars: 480 }
    }
  }
}))

const { BASELINE_ENTRY_WINDOW_SEC, baselineDueBarOf, baselineExecutors, baselineKeyOf, baselineSeriesFromSec, closeBaselineTrades, readBaseline } = await import('../src/baseline/baselineTrade')
type Deps = Parameters<typeof readBaseline>[0]

const BAR = 4 * 3600
/** Started at 08:10 UTC: the 04:00 bar, closed at 08:00, is the last closed before the Start; the 08:00 bar is the first after. */
const START = Date.UTC(2026, 9, 27, 8, 10) / 1000
const B08 = Date.UTC(2026, 9, 27, 8) / 1000
const B12 = B08 + BAR
const B16 = B08 + 2 * BAR
/** A read 30 s after a bar's close. */
const readAt = (barSec: number, lateSec = 0): number => (barSec + BAR + 30 + lateSec) * 1000

interface World {
  settings: { executors: ExecutorConfig[]; paperBooks: unknown }
  misses: MissRecord[]
  now: number
  prices: Record<string, number>
  /** Bars changed from the flat 100, by symbol and time. */
  bars: Map<string, Partial<Candle>>
  unreadable: Set<string>
  standing: BookStanding | null
  book: { bids: [number, number][]; asks: [number, number][] } | null
  writes: number
  bookReads: number
}

let world: World
let n = 0
let chain: Promise<unknown> = Promise.resolve()

const standingOf = (over: Partial<BookStanding> = {}): BookStanding => ({ id: 'baseline', startQuote: 10_000, realizedQuote: 0, unrealizedQuote: 0, settledEquity: 10_000, equity: 10_000, open: 0, openStakeQuote: 0, closed: 0, dayStartEquity: 10_000, ...over })

const deps: Deps = {
  getSettings: async () => structuredClone(world.settings) as never,
  setExecutors: async (executors) => {
    world.settings = { ...world.settings, executors: structuredClone(executors) }
    world.writes++
  },
  // One at a time, as the app's one queue of writes is.
  queue: (work) => {
    const next = chain.then(work)
    chain = next.catch(() => undefined)
    return next
  },
  baselineStanding: async () => world.standing,
  bars: async (symbol, fromSec, toSec) => {
    if (world.unreadable.has(symbol)) throw new Error('down')
    const out: Candle[] = []
    // Through the bar forming at `toSec`, as the exchange gives it.
    for (let time = fromSec; time <= toSec; time += BAR) {
      const candle = { time, open: 100, high: 101, low: 99, close: 100, volume: 1, ...world.bars.get(`${symbol}:${time}`) }
      plan.symbolOf.set(candle, symbol)
      out.push(candle)
    }
    return out
  },
  price: async (symbol) => {
    const px = world.prices[symbol]
    if (px === undefined) throw new Error('no price')
    return px
  },
  book: async () => {
    world.bookReads++
    if (world.book === null) throw new Error('no book')
    return { ...world.book, atMs: world.now }
  },
  misses: async (sinceSec) => world.misses.filter((miss) => miss.at >= sinceSec),
  miss: async (miss) => {
    world.misses.push(miss)
    return miss
  },
  nowMs: () => world.now,
  newId: () => `t${++n}`
}

/** BTC's entry signal holds from the 08:00 bar on, its stop at 80; no other symbol's ever does. */
const btcFrom = (fromSec: number, stop = 80) => (symbol: string, time: number) => ({ entry: symbol === 'BTCUSDT' && time >= fromSec, exit: false, stop })

beforeEach(() => {
  n = 0
  world = {
    settings: { executors: [], paperBooks: { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: START } },
    misses: [],
    now: readAt(B08),
    prices: Object.fromEntries(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT'].map((symbol) => [symbol, 100])),
    bars: new Map(),
    unreadable: new Set(),
    standing: standingOf(),
    book: { bids: [[99.99, 1000]], asks: [[100.01, 1000]] },
    writes: 0,
    bookReads: 0
  }
  plan.signalOf = () => ({ entry: false, exit: false, stop: null })
})

const open = (): ExecutorConfig[] => baselineExecutors(world.settings.executors).filter((executor) => executor.status === 'active')

describe('the bar a read acts on, and the bars it reads', () => {
  it("is the latest closed thirty seconds before, on a series fixed by the run's Start", () => {
    expect(baselineDueBarOf(B12 + 29)).toBe(B08 - BAR)
    expect(baselineDueBarOf(B12 + 30)).toBe(B08)
    expect(baselineSeriesFromSec(START)).toBe(B08 - 520 * BAR)
    expect(baselineKeyOf('BTCUSDT', B08)).toBe(`baseline:BTCUSDT:${B08}`)
  })
})

describe('an entry', () => {
  it('is made at a fresh signal after the Start: paper, long on spot, in the baseline book, a tenth and a quarter of it', async () => {
    plan.signalOf = btcFrom(B08)
    world.prices.BTCUSDT = 100.5
    const { lines, complete } = await readBaseline(deps)
    expect(complete).toBe(true)
    expect(lines[0]).toBe('BTCUSDT: entered long at 100.5, its stop at 80')
    expect(lines.slice(1).every((entry) => entry.endsWith('no entry signal'))).toBe(true)
    const [trade] = open()
    expect(trade).toMatchObject({ mode: 'paper', type: 'position', exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', book: { id: 'baseline', startedAt: START, ledger: 'baseline' } })
    expect(trade.baseline).toEqual({ symbol: 'BTCUSDT', signalBarSec: B08, entryPx: 100.5, qty: 1250 / 100.5, stakeQuote: 1250, feesQuote: 1.25, openedAtMs: readAt(B08), stopPx: 80, closeReason: null, exitPx: null })
    expect(trade.params).toMatchObject({ side: 'buy', amountQuote: 1250, stopLossPct: (1 - 80 / 100.5) * 100, timeLimitSec: null, feeRate: 0.001 })
    // Read again at the same close: once.
    await readBaseline(deps)
    expect(baselineExecutors(world.settings.executors)).toHaveLength(1)
    expect(world.misses).toEqual([])
  })

  it('is never one of a regime standing at the Start, until it has broken; nor at a bar that closed before the Start', async () => {
    plan.signalOf = (symbol, time) => ({ entry: symbol === 'BTCUSDT' && time !== B12, exit: false, stop: 80 })
    expect((await readBaseline(deps)).lines[0]).toBe("BTCUSDT: its regime has stood since before the Start: not the run's to take")
    world.now = readAt(B12)
    expect((await readBaseline(deps)).lines[0]).toBe('BTCUSDT: no entry signal')
    world.now = readAt(B16)
    expect((await readBaseline(deps)).lines[0]).toBe('BTCUSDT: entered long at 100, its stop at 80')
    // Started at 12:00:10: the 08:00 bar closed before it.
    world.settings.executors = []
    world.settings.paperBooks = { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: B12 + 10 }
    plan.signalOf = btcFrom(B08)
    world.now = readAt(B08)
    expect((await readBaseline(deps)).lines[0]).toBe("BTCUSDT: its regime has stood since before the Start: not the run's to take")
    expect(world.misses).toEqual([])
  })

  it('read more than five minutes after its close is missed as late, once', async () => {
    plan.signalOf = btcFrom(B08)
    world.now = readAt(B08, BASELINE_ENTRY_WINDOW_SEC - 29)
    await readBaseline(deps)
    await readBaseline(deps)
    expect(open()).toEqual([])
    expect(world.misses).toHaveLength(1)
    expect(world.misses[0]).toMatchObject({ book: 'baseline', writer: 'baseline', pair: 'BTCUSDT', side: 'up', stage: 'late', refPrice: 100, eventKey: baselineKeyOf('BTCUSDT', B08), shadow: false })
    // Within the window it is made.
    world.misses = []
    world.now = readAt(B08, BASELINE_ENTRY_WINDOW_SEC - 31)
    await readBaseline(deps)
    expect(open()).toHaveLength(1)
  })

  it("is refused, and missed once, where the book has no room, its book is thin, or the price is under the strategy's stop", async () => {
    plan.signalOf = btcFrom(B08)
    world.standing = standingOf({ equity: 9400, dayStartEquity: 10_000 })
    await readBaseline(deps)
    await readBaseline(deps)
    expect(world.misses.map((miss) => [miss.stage, miss.reason])).toEqual([['cap', expect.stringMatching(/daily stop/)]])
    world.misses = []
    world.standing = standingOf()
    world.book = { bids: [[99.99, 1]], asks: [[100.01, 1]] }
    await readBaseline(deps)
    expect(world.misses.map((miss) => miss.stage)).toEqual(['liquidity'])
    world.misses = []
    world.book = { bids: [[99.99, 1000]], asks: [[100.01, 1000]] }
    world.prices.BTCUSDT = 79
    await readBaseline(deps)
    expect(world.misses.map((miss) => [miss.stage, miss.refPrice])).toEqual([['gate', 79]])
    expect(open()).toEqual([])
    // Its standing unread: no stake can be sized.
    world.misses = []
    world.prices.BTCUSDT = 100
    world.standing = null
    await readBaseline(deps)
    expect(world.misses.map((miss) => [miss.stage, miss.reason])).toEqual([['cap', "the baseline book's standing could not be read"]])
  })

  it('stakes on the settled equity, and is not made where its bar was not among those read, or a symbol could not be read', async () => {
    plan.signalOf = btcFrom(B08)
    world.standing = standingOf({ settledEquity: 8000, equity: 8000, dayStartEquity: 8000 })
    world.unreadable.add('ETHUSDT')
    const { lines, complete } = await readBaseline(deps)
    expect(complete).toBe(false)
    expect(lines[1]).toBe('ETHUSDT: its bars could not be read')
    expect(open()[0].baseline?.stakeQuote).toBe(1000)
    // The read made before its bar is there (the data host behind): nothing entered, made again.
    world.settings.executors = []
    world.unreadable.clear()
    world.now = (B08 + BAR) * 1000 + 30_000
    const early = deps.bars
    deps.bars = async (symbol, fromSec) => early(symbol, fromSec, B08 - 1)
    try {
      const again = await readBaseline(deps)
      expect(again.complete).toBe(false)
      expect(again.lines[0]).toMatch(/^BTCUSDT: its bar of 2026-10-27 08:00 UTC was not among those read/)
    } finally {
      deps.bars = early
    }
  })

  it('is made once a close though its trade was stopped by hand meanwhile; and not where paper testing stopped before it was', async () => {
    plan.signalOf = btcFrom(B08)
    await readBaseline(deps)
    world.settings.executors = world.settings.executors.map((executor) => ({ ...executor, status: 'stopped', stoppedAt: 1 }))
    expect((await readBaseline(deps)).lines[0]).toBe('BTCUSDT: closed as stopped at 100, already entered')
    expect(baselineExecutors(world.settings.executors)).toHaveLength(1)
    // Stop pressed while the read weighed the entry: nothing entered, and the miss says why.
    world.settings.executors = []
    const standing = deps.baselineStanding
    deps.baselineStanding = async () => {
      world.settings.paperBooks = { ...DEFAULT_PAPER_BOOKS, running: false, startedAt: null }
      return standingOf()
    }
    try {
      expect((await readBaseline(deps)).lines[0]).toBe('BTCUSDT: missed: paper testing was stopped before the entry was made')
    } finally {
      deps.baselineStanding = standing
    }
    expect(world.misses.map((miss) => miss.stage)).toEqual(['off'])
    expect(world.settings.executors).toEqual([])
  })

  it('is none on the bar still forming, nor while paper testing is not running', async () => {
    plan.signalOf = (symbol, time) => ({ entry: symbol === 'BTCUSDT' && time === B12, exit: false, stop: 80 })
    world.now = readAt(B08) + 60_000
    expect((await readBaseline(deps)).lines[0]).toBe('BTCUSDT: no entry signal')
    plan.signalOf = btcFrom(B08)
    world.settings.paperBooks = { ...DEFAULT_PAPER_BOOKS, running: false, startedAt: START }
    expect(await readBaseline(deps)).toEqual({ lines: [], complete: true })
    expect(open()).toEqual([])
  })
})

describe('an exit', () => {
  async function entered(): Promise<void> {
    plan.signalOf = btcFrom(B08)
    await readBaseline(deps)
    expect(open()).toHaveLength(1)
  }

  it("is at a bar reaching the strategy's stop, at the stop or the open past it; and no entry at the close it stopped at", async () => {
    await entered()
    world.bars.set(`BTCUSDT:${B12}`, { open: 100, low: 70, close: 75 })
    world.now = readAt(B12)
    const { lines } = await readBaseline(deps)
    expect(lines[0]).toBe('BTCUSDT: closed at its stop at 80, stopped out at this close: no entry at it')
    const [trade] = baselineExecutors(world.settings.executors)
    expect(trade.status).toBe('stopped')
    expect(trade.baseline).toMatchObject({ closeReason: 'stop', exitPx: 80 })
    const qty = 1250 / 100
    expect(trade.book?.result?.netQuote).toBeCloseTo((80 - 100) * qty - 1.25 - 0.001 * qty * 80, 9)
    expect(trade.book?.result).toMatchObject({ fundingQuote: 0, closedAt: B12 + BAR })
    // At the next close the strategy's position is joined again, its regime unbroken since the run's own entry.
    world.now = readAt(B16)
    expect((await readBaseline(deps)).lines[0]).toBe('BTCUSDT: entered long at 100, its stop at 80')
  })

  it('is at the close of a bar its exit signal holds at; and a trade held is not entered twice', async () => {
    await entered()
    // A bar still forming is not read: its low under the stop is not yet a bar that reached it.
    world.bars.set(`BTCUSDT:${B12}`, { low: 70 })
    world.now = readAt(B08) + 60_000
    expect((await readBaseline(deps)).lines[0]).toBe('BTCUSDT: holding')
    world.bars.delete(`BTCUSDT:${B12}`)
    world.now = readAt(B12)
    const booksRead = world.bookReads
    expect((await readBaseline(deps)).lines[0]).toBe('BTCUSDT: holding')
    // Held, its entry is not weighed again: no book is read for it.
    expect(world.bookReads).toBe(booksRead)
    plan.signalOf = (symbol, time) => ({ entry: symbol === 'BTCUSDT' && time < B16, exit: symbol === 'BTCUSDT' && time === B16, stop: 80 })
    world.bars.set(`BTCUSDT:${B16}`, { close: 104 })
    world.now = readAt(B16)
    expect((await readBaseline(deps)).lines[0]).toBe('BTCUSDT: closed at its exit signal at 104, no entry signal')
    expect(baselineExecutors(world.settings.executors)[0].baseline).toMatchObject({ closeReason: 'signal', exitPx: 104 })
  })

  it('of a trade stopped elsewhere is at the price then; and at Stop every open trade is closed at its price', async () => {
    await entered()
    world.settings.executors = world.settings.executors.map((executor) => ({ ...executor, status: 'stopped', stoppedAt: 1 }))
    world.prices.BTCUSDT = 103
    world.now = readAt(B12)
    await readBaseline(deps)
    expect(baselineExecutors(world.settings.executors)[0]).toMatchObject({ stoppedAt: 1, baseline: { closeReason: 'stopped', exitPx: 103 } })
    // A new trade, closed by Stop, once though Stop runs twice at once.
    world.settings.executors = []
    world.now = readAt(B08)
    await readBaseline(deps)
    world.prices.BTCUSDT = 97
    const [first, second] = await Promise.all([closeBaselineTrades(deps), closeBaselineTrades(deps)])
    expect([...first, ...second]).toEqual(['Trend Regime Ensemble · BTCUSDT (baseline book)'])
    expect(baselineExecutors(world.settings.executors)[0]).toMatchObject({ status: 'stopped', baseline: { closeReason: 'stopped', exitPx: 97 } })
    expect(baselineExecutors(world.settings.executors)[0].book?.result?.closedAt).toBe(Math.floor(readAt(B08) / 1000))
  })
})
