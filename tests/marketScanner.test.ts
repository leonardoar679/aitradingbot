import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle, SymbolInfo, Ticker24h } from '../shared/ipc'
import type { NewsItem } from '../shared/news'
import { EVENT_LOOKBACK_BARS } from '../shared/marketEvent'
import {
  SCAN_HISTORY_MAX_DAYS,
  eventMonthKey,
  matchesMarketEventFilter,
  nextPassDelayMs,
  parseMarketEventLines,
  pickUniverse,
  scanHistoryRequests,
  spreadPct
} from '../shared/marketScanner'
import { T0, quiet, thenFlat, withMove } from './eventCandles'

vi.mock('electron', () => ({ app: { getPath: () => process.env.SCANNER_TEST_USER_DATA } }))
/** What the main process told (the V4 document, §48): the scanner failing three passes running. */
const told = vi.hoisted(() => [] as { title: string; body: string; extra: { kind: string; thread?: string } }[])
vi.mock('../electron/services/noticeService', () => ({
  tell: (notice: { title: string; body: string; extra: { kind: string; thread?: string } }) => void told.push(notice),
  tellNotice: async () => true
}))

// The exchange, faked at the one seam the scanner reaches it through.
const market = vi.hoisted(() => ({
  symbols: [] as { symbol: string; baseAsset: string; quoteAsset: string }[],
  tickers: [] as { symbol: string; quoteVolume: number }[],
  books: [] as { symbol: string; bidPrice: number; askPrice: number }[],
  booksDown: false,
  candles: new Map<string, unknown[]>(),
  /** Completed bars only: what an exchange's history holds for a stretch that has ended. */
  history: new Map<string, unknown[]>(),
  failing: new Set<string>(),
  recentCalls: [] as string[],
  tickerCalls: 0,
  /** When set, every candle request waits on it. */
  gate: null as Promise<void> | null,
  rangeCalls: [] as { symbol: string; startSec: number; endSec: number; requestId: string }[],
  rangeGate: null as Promise<void> | null,
  cancelled: [] as string[]
}))

vi.mock('../electron/services/marketService', () => ({
  listSymbols: async () => market.symbols,
  scanSourceFor: () => ({
    fetchAllTickers24h: async () => {
      market.tickerCalls++
      return market.tickers
    },
    fetchBookTickers: async () => {
      if (market.booksDown) throw new Error('book ticker down')
      return market.books
    },
    fetchRecentCandles: async (symbol: string, _interval: string, limit: number) => {
      market.recentCalls.push(symbol)
      if (market.gate) await market.gate
      if (market.failing.has(symbol)) throw new Error(`${symbol} is down`)
      return (market.candles.get(symbol) ?? []).slice(-limit)
    }
  }),
  fetchHistoricalRange: async (
    _exchange: string,
    symbol: string,
    _interval: string,
    startSec: number,
    endSec: number,
    requestId: string,
    onProgress: (done: number, total: number) => void
  ) => {
    market.rangeCalls.push({ symbol, startSec, endSec, requestId })
    if (market.rangeGate) await market.rangeGate
    if (market.failing.has(symbol)) throw new Error(`${symbol} is down`)
    const all = (market.history.get(symbol) ?? []) as Candle[]
    const candles = all.filter((candle) => candle.time >= startSec && candle.time < endSec)
    onProgress(candles.length, candles.length)
    return { candles, cancelled: market.cancelled.includes(requestId) }
  },
  cancelHistoricalRangeFetch: (requestId: string) => {
    market.cancelled.push(requestId)
  }
}))

const pair = (base: string, quote = 'USDT'): SymbolInfo => ({ symbol: `${base}${quote}`, baseAsset: base, quoteAsset: quote })
const ticker = (symbol: string, quoteVolume: number): Ticker24h => ({
  symbol,
  lastPrice: 100,
  priceChange: 0,
  priceChangePercent: 0,
  highPrice: 101,
  lowPrice: 99,
  volume: quoteVolume / 100,
  quoteVolume
})

const LEAD = EVENT_LOOKBACK_BARS + 20
/** Open time of the last completed bar every series ends on, and the moment a pass reads it:
 * five seconds into the minute after. */
const LAST = T0 + (LEAD + 14) * 60
const NOW_MS = (LAST + 60) * 1000 + 5_000

/** A series as an exchange returns it: the completed bars, then the one still forming. */
function served(completed: Candle[]): Candle[] {
  const last = completed[completed.length - 1]
  return [...completed, { time: last.time + 60, open: last.close, high: last.close * 5, low: last.close / 5, close: last.close * 3, volume: 9e9 }]
}

async function scanner() {
  return import('../electron/services/marketScannerService')
}

let dir: string

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'scanner-'))
  process.env.SCANNER_TEST_USER_DATA = dir
  market.symbols = [pair('PUMP'), pair('AAA'), pair('BBB'), pair('USDC'), pair('AAA', 'BTC')]
  market.tickers = [ticker('PUMPUSDT', 40_000_000), ticker('AAAUSDT', 90_000_000), ticker('BBBUSDT', 5_000_000), ticker('USDCUSDT', 900_000_000), ticker('AAABTC', 800_000_000)]
  market.books = [
    { symbol: 'PUMPUSDT', bidPrice: 99.99, askPrice: 100.01 },
    { symbol: 'AAAUSDT', bidPrice: 99.995, askPrice: 100.005 },
    { symbol: 'BBBUSDT', bidPrice: 99.9, askPrice: 100.1 }
  ]
  market.booksDown = false
  market.candles = new Map<string, unknown[]>([
    ['PUMPUSDT', served(withMove({ pct: 3, volume: 8 }, LEAD, 7))],
    ['AAAUSDT', served(quiet(LEAD + 15, 11))],
    ['BBBUSDT', served(quiet(LEAD + 15, 13))]
  ])
  market.history = new Map<string, unknown[]>([
    ['PUMPUSDT', withMove({ pct: 3, volume: 8 }, LEAD, 7)],
    ['AAAUSDT', quiet(LEAD + 15, 11)],
    ['BBBUSDT', quiet(LEAD + 15, 13)]
  ])
  market.failing = new Set()
  market.recentCalls = []
  market.tickerCalls = 0
  market.gate = null
  market.rangeCalls = []
  market.rangeGate = null
  market.cancelled = []
})

afterEach(() => {
  vi.useRealTimers()
})

function eventsOnFile(): string[] {
  try {
    return readFileSync(join(dir, 'marketEvents', `events-${eventMonthKey(LAST)}.jsonl`), 'utf-8').split('\n').filter((line) => line !== '')
  } catch {
    return []
  }
}

describe('pickUniverse', () => {
  it('takes the most traded USDT pairs that are not pegged to anything', () => {
    const picked = pickUniverse(market.symbols, market.tickers as Ticker24h[], 2)
    // Not USDCUSDT, the most traded of all, and not a pair quoted in BTC.
    expect(picked.map((entry) => entry.symbol)).toEqual(['AAAUSDT', 'PUMPUSDT'])
    expect(picked[0].quoteVolume24h).toBe(90_000_000)
  })

  it('leaves out a pair with no volume to rank it by, and breaks a tie by name', () => {
    const symbols = [pair('ZZZ'), pair('AAA'), pair('NEW')]
    const tickers = [ticker('ZZZUSDT', 10), ticker('AAAUSDT', 10)]
    expect(pickUniverse(symbols, tickers, 10).map((entry) => entry.symbol)).toEqual(['AAAUSDT', 'ZZZUSDT'])
  })

  it('leaves out a stock token, however much it trades, and takes the next pair in its place', () => {
    const symbols = [{ ...pair('SPCXB'), stockToken: true }, ...market.symbols]
    const tickers = [ticker('SPCXBUSDT', 950_000_000), ...(market.tickers as Ticker24h[])]
    expect(pickUniverse(symbols, tickers, 2).map((entry) => entry.symbol)).toEqual(['AAAUSDT', 'PUMPUSDT'])
  })
})

describe('the small arithmetic', () => {
  it('measures a spread against the mid, and refuses a book that says nothing', () => {
    expect(spreadPct(99.9, 100.1)).toBeCloseTo(0.2, 6)
    expect(spreadPct(0, 100)).toBeNull()
    expect(spreadPct(100.1, 99.9)).toBeNull()
  })

  it('schedules a pass for five seconds after the next minute closes', () => {
    const minute = Date.parse('2026-10-03T12:00:00Z')
    expect(nextPassDelayMs(minute)).toBe(65_000)
    expect(nextPassDelayMs(minute + 5_000)).toBe(60_000)
    // A pass that ends just before a boundary does not read that minute a second later.
    expect(nextPassDelayMs(minute + 59_000)).toBe(6_000)
  })

  it('counts the requests a history scan will make', () => {
    // Thirty days of one pair: 43,200 bars and the lookback, a thousand to a request.
    expect(scanHistoryRequests(1, 0, 30 * 86_400, EVENT_LOOKBACK_BARS)).toBe(44)
    expect(scanHistoryRequests(20, 0, 30 * 86_400, EVENT_LOOKBACK_BARS)).toBe(880)
  })

  it('reads an events file past a torn line, and says that it did', () => {
    const good = { id: 'binance:AAAUSDT:1', symbol: 'AAAUSDT', time: 1, type: 'pump', band: 'candidate', score: 80, price: 1, components: {} }
    const parsed = parseMarketEventLines(`${JSON.stringify(good)}\n{"hello":"world"}\n{"id":"torn","ti`)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.skipped).toBe(2)
  })
})

describe('one pass', () => {
  it('reads every watched pair, shows them strongest first, and raises what qualifies', async () => {
    const { scanOnce } = await scanner()
    const state = await scanOnce(NOW_MS)

    expect(market.recentCalls.sort()).toEqual(['AAAUSDT', 'BBBUSDT', 'PUMPUSDT'])
    expect(state.error).toBeNull()
    expect(state.failed).toBe(0)
    expect(state.pairs.map((entry) => entry.symbol)[0]).toBe('PUMPUSDT')
    expect(state.pairs).toHaveLength(3)
    expect(state.pairs[0]).toMatchObject({ barTime: LAST, band: 'urgent', type: 'breakout', direction: 'up', quoteVolume24h: 40_000_000 })
    expect(state.pairs[0].spreadPct).toBeCloseTo(0.02, 3)

    expect(state.recentEvents).toHaveLength(1)
    const event = state.recentEvents[0]
    expect(event).toMatchObject({ id: `binance:PUMPUSDT:${LAST + 60}`, symbol: 'PUMPUSDT', baseAsset: 'PUMP', time: LAST + 60, type: 'breakout' })
    expect(event.live).toMatchObject({ quoteVolume24h: 40_000_000, rank: 1 })
    expect(event.live?.spreadPct).toBeCloseTo(0.02, 3)

    // And it is on file, as written.
    const lines = eventsOnFile()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual(event)
  })

  it('never reads the bar that is still forming', async () => {
    // The forming bar in every served series is a 200% candle on absurd volume. Had it been
    // read, the quiet pairs would be the strongest events on the page.
    const { scanOnce } = await scanner()
    const state = await scanOnce(NOW_MS)
    for (const entry of state.pairs.filter((candidate) => candidate.symbol !== 'PUMPUSDT')) {
      expect(entry.band).toBe('quiet')
      expect(entry.barTime).toBe(LAST)
    }
  })

  it('raises one event for one pump, however many passes see it', async () => {
    const { scanOnce } = await scanner()
    await scanOnce(NOW_MS)
    const again = await scanOnce(NOW_MS)
    expect(again.recentEvents).toHaveLength(1)
    expect(eventsOnFile()).toHaveLength(1)
  })

  it('does not raise it again because the app was restarted', async () => {
    await (await scanner()).scanOnce(NOW_MS)
    vi.resetModules()
    // A minute later: the pump is over, the price is holding, the reading is still high.
    market.candles.set('PUMPUSDT', served(thenFlat(withMove({ pct: 3, volume: 8 }, LEAD, 7), 1)))
    market.candles.set('AAAUSDT', served(quiet(LEAD + 16, 11)))
    market.candles.set('BBBUSDT', served(quiet(LEAD + 16, 13)))
    const restarted = await scanner()
    const state = await restarted.scanOnce(NOW_MS + 60_000)
    expect(state.recentEvents).toHaveLength(1)
    expect(eventsOnFile()).toHaveLength(1)
  })

  it('hands what is on file to everyone who asks at once, not only to the first', async () => {
    // Overview reads the scanner's state from two cards in the same moment as it opens. A flag set
    // before the read finished gave the second the empty list, and with the scanner off nothing
    // ever put the events back.
    await (await scanner()).scanOnce(NOW_MS)
    vi.resetModules()
    const restarted = await scanner()
    const [first, second, third] = await Promise.all([restarted.getScannerState(), restarted.getScannerState(), restarted.getScannerState()])
    expect([first.recentEvents.length, second.recentEvents.length, third.recentEvents.length]).toEqual([1, 1, 1])
  })

  it('shows a pair whose candles are stale, and raises nothing on them', async () => {
    // Three minutes later, and the exchange has served nothing new: not even a forming bar.
    for (const [symbol, bars] of market.history) market.candles.set(symbol, bars)
    const { scanOnce } = await scanner()
    const state = await scanOnce(NOW_MS + 180_000)
    expect(state.pairs[0]).toMatchObject({ symbol: 'PUMPUSDT', band: 'urgent', barTime: LAST })
    expect(state.recentEvents).toEqual([])
    expect(eventsOnFile()).toEqual([])
  })

  it('carries on past a pair it cannot read', async () => {
    market.failing.add('AAAUSDT')
    const { scanOnce } = await scanner()
    const state = await scanOnce(NOW_MS)
    expect(state.failed).toBe(1)
    expect(state.error).toBeNull()
    expect(state.pairs.map((entry) => entry.symbol).sort()).toEqual(['BBBUSDT', 'PUMPUSDT'])
    expect(state.recentEvents).toHaveLength(1)
  })

  it('says so when it could read nothing', async () => {
    market.failing = new Set(['AAAUSDT', 'BBBUSDT', 'PUMPUSDT'])
    const { scanOnce } = await scanner()
    const state = await scanOnce(NOW_MS)
    expect(state.failed).toBe(3)
    expect(state.error).toMatch(/No pair could be read/)
  })

  it('still reads and ranks when the book cannot be fetched', async () => {
    market.booksDown = true
    const { scanOnce } = await scanner()
    const state = await scanOnce(NOW_MS)
    expect(state.error).toBeNull()
    expect(state.pairs[0].spreadPct).toBeNull()
    expect(state.recentEvents[0].live?.spreadPct).toBeNull()
  })

  it('does not start a second pass while one is running', async () => {
    let release = (): void => undefined
    market.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { scanOnce } = await scanner()
    const first = scanOnce(NOW_MS)
    // Let the first pass reach its candle requests.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await scanOnce(NOW_MS)
    expect(second.pairs).toEqual([])
    release()
    await first
    expect(market.recentCalls).toHaveLength(3)
  })

  it('picks the watched set once an hour, not once a pass', async () => {
    const { scanOnce } = await scanner()
    await scanOnce(NOW_MS)
    await scanOnce(NOW_MS + 60_000)
    expect(market.tickerCalls).toBe(1)
    await scanOnce(NOW_MS + 3_600_000)
    expect(market.tickerCalls).toBe(2)
  })

  it('tells its listeners after each pass', async () => {
    const { scanOnce, onScannerUpdate } = await scanner()
    const seen: number[] = []
    const stop = onScannerUpdate((state) => seen.push(state.pairs.length))
    await scanOnce(NOW_MS)
    stop()
    await scanOnce(NOW_MS + 60_000)
    expect(seen).toEqual([3])
  })
})

describe("an announcement's event", () => {
  // Raised by the news reader (electron/services/newsService.ts) from a delisting it read itself.
  const item: NewsItem = {
    id: 990001,
    catalog: 161,
    title: 'Binance Will Delist AAA, BBB, ZZZ on 2026-10-20',
    releaseSec: LAST + 50,
    seenAt: LAST + 63,
    category: 'DELISTING',
    tickers: ['AAA', 'BBB', 'ZZZ']
  }

  it('raises a delisting from the coin\'s own candles, however quiet they are, and tells everyone listening', async () => {
    const { raiseNewsEvent, getScannerState, onScannerUpdate } = await scanner()
    const heard: string[] = []
    onScannerUpdate((state) => heard.push(state.recentEvents[0]?.id ?? 'none'))
    const event = await raiseNewsEvent(item, 'AAA', NOW_MS)
    expect(event).toMatchObject({
      id: `binance:AAAUSDT:${LAST + 60}`,
      symbol: 'AAAUSDT',
      type: 'delisting',
      direction: 'down',
      band: 'quiet',
      time: LAST + 60,
      news: { articleId: 990001, title: item.title, releaseSec: LAST + 50 },
      live: { detectedAt: LAST + 65, rank: 1, quoteVolume24h: null, spreadPct: null }
    })
    expect(market.recentCalls).toEqual(['AAAUSDT'])
    expect((await getScannerState()).recentEvents[0]).toEqual(event)
    expect(heard).toEqual([event?.id])
    const kept = readFileSync(join(dir, 'marketEvents', `events-${eventMonthKey(LAST + 60)}.jsonl`), 'utf-8').trim().split('\n')
    expect(parseMarketEventLines(kept.join('\n')).rows).toEqual([event])
  })

  it('raises nothing for a coin with no USDT pair, nor twice for one coin at one minute', async () => {
    const { raiseNewsEvent } = await scanner()
    // ZZZ trades -- there are candles under its name -- but Binance lists no USDT pair for it.
    market.candles.set('ZZZUSDT', served(quiet(LEAD + 15, 17)))
    expect(await raiseNewsEvent(item, 'ZZZ', NOW_MS)).toBeNull()
    expect(market.recentCalls).toEqual([])
    expect(await raiseNewsEvent(item, 'AAA', NOW_MS)).not.toBeNull()
    expect(await raiseNewsEvent(item, 'AAA', NOW_MS)).toBeNull()
  })

  it('holds the coin to its cooldown, as any event does: one move, one event', async () => {
    const { raiseNewsEvent, scanOnce } = await scanner()
    await raiseNewsEvent({ ...item, tickers: ['PUMP'] }, 'PUMP', NOW_MS)
    // PUMP's candles end in a move a pass would raise; the delisting raised it already.
    const state = await scanOnce(NOW_MS)
    expect(state.recentEvents.filter((event) => event.symbol === 'PUMPUSDT').map((event) => event.type)).toEqual(['delisting'])
  })

  it('raises a coin added to the Monitoring Tag as an event of its own kind, and nothing for any other kind of news', async () => {
    const { raiseNewsEvent } = await scanner()
    const tag: NewsItem = { ...item, id: 990002, catalog: 49, category: 'MONITORING_TAG', title: 'Binance Will Extend the Monitoring Tag to Include AAA on 2026-10-05', tickers: ['AAA'] }
    expect(await raiseNewsEvent(tag, 'AAA', NOW_MS)).toMatchObject({ type: 'monitoring_tag', direction: 'down', news: { articleId: 990002 } })
    expect(await raiseNewsEvent({ ...item, category: 'FUTURES_LAUNCH' }, 'BBB', NOW_MS)).toBeNull()
    expect(market.recentCalls).toEqual(['AAAUSDT'])
  })
})

describe('the setting', () => {
  it('is on from the first launch (since 8 October 2026), which schedules its first pass', async () => {
    vi.useFakeTimers()
    const { startMarketScanner, getScannerState } = await scanner()
    await startMarketScanner()
    expect(vi.getTimerCount()).toBe(1)
    const state = await getScannerState()
    expect(state.config).toEqual({ enabled: true, universeSize: 60 })
    expect(state.nextPassAt).not.toBeNull()
  })

  it('starts nothing at launch when it was switched off', async () => {
    vi.useFakeTimers()
    writeFileSync(join(dir, 'scanner.json'), JSON.stringify({ enabled: false, universeSize: 60, configVersion: 1 }))
    const { startMarketScanner, getScannerState } = await scanner()
    await startMarketScanner()
    expect(vi.getTimerCount()).toBe(0)
    const state = await getScannerState()
    expect(state.config).toEqual({ enabled: false, universeSize: 60 })
    expect(state.nextPassAt).toBeNull()
    expect(market.recentCalls).toEqual([])
  })

  it('schedules a pass when switched on, cancels it when switched off, and remembers', async () => {
    vi.useFakeTimers()
    const { setScannerConfig, whenScannerSettled } = await scanner()
    const on = await setScannerConfig({ enabled: true, universeSize: 20 })
    await whenScannerSettled()
    expect(on.config).toEqual({ enabled: true, universeSize: 20 })
    expect(on.nextPassAt).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)
    // Written by this app, the file carries its version (shared/configMigration.ts).
    expect(JSON.parse(readFileSync(join(dir, 'scanner.json'), 'utf-8'))).toEqual({ enabled: true, universeSize: 20, configVersion: 1 })

    // Left on: the next launch starts it.
    vi.resetModules()
    const relaunched = await scanner()
    await relaunched.startMarketScanner()
    expect(vi.getTimerCount()).toBe(2)

    const off = await relaunched.setScannerConfig({ enabled: false })
    expect(off.nextPassAt).toBeNull()
    expect(off.config.universeSize).toBe(20)
  })

  it('reads the market at once when switched on, rather than waiting out the minute', async () => {
    vi.useFakeTimers()
    const { setScannerConfig, whenScannerSettled, getScannerState } = await scanner()
    await setScannerConfig({ enabled: true })
    await whenScannerSettled()
    expect(market.recentCalls.sort()).toEqual(['AAAUSDT', 'BBBUSDT', 'PUMPUSDT'])
    expect((await getScannerState()).pairs).toHaveLength(3)
    // Saying "on" again while it is on starts nothing more.
    await setScannerConfig({ enabled: true })
    await whenScannerSettled()
    expect(market.recentCalls).toHaveLength(3)
  })

  it('refuses a size it does not offer', async () => {
    const { setScannerConfig } = await scanner()
    await expect(setScannerConfig({ universeSize: 500 })).rejects.toThrow(/20, 40, 60 or 100/)
  })

  it('heals a settings file holding something unusable, to its defaults: on, and only `false` switches it off', async () => {
    writeFileSync(join(dir, 'scanner.json'), JSON.stringify({ enabled: 'yes', universeSize: 9999 }))
    const { getScannerState } = await scanner()
    expect((await getScannerState()).config).toEqual({ enabled: true, universeSize: 60 })
    // Stamped on that first read, the unusable values left for the heal (the file is read, not rewritten by it).
    expect(JSON.parse(readFileSync(join(dir, 'scanner.json'), 'utf-8'))).toEqual({ enabled: 'yes', universeSize: 9999, configVersion: 1 })
  })
})

describe('events on file', () => {
  it('lists them newest first, filtered, and counts lines it could not read', async () => {
    mkdirSync(join(dir, 'marketEvents'), { recursive: true })
    const event = (symbol: string, time: number, band: string): object => ({
      id: `binance:${symbol}:${time}`,
      exchange: 'binance',
      symbol,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      time,
      type: 'breakout',
      direction: 'up',
      band,
      score: 80,
      components: { price: 80, volume: 80, volatility: 80, pressure: 80, breakout: 80 },
      price: 100,
      returnsPct: { m1: 0, m5: 0, m15: 1, h1: 1, h4: 1 },
      moveSigmas: 5,
      volumeRatio: 8,
      rangeRatio: 4,
      live: null
    })
    const sep = Date.parse('2026-09-20T12:00:00Z') / 1000
    const oct = Date.parse('2026-10-02T12:00:00Z') / 1000
    writeFileSync(join(dir, 'marketEvents', `events-${eventMonthKey(sep)}.jsonl`), `${JSON.stringify(event('AAAUSDT', sep, 'candidate'))}\n`)
    writeFileSync(
      join(dir, 'marketEvents', `events-${eventMonthKey(oct)}.jsonl`),
      `${JSON.stringify(event('AAAUSDT', oct, 'urgent'))}\n${JSON.stringify(event('BBBUSDT', oct + 60, 'candidate'))}\n{"torn`
    )
    const { listMarketEvents } = await scanner()
    const all = await listMarketEvents({})
    expect(all.rows.map((row) => row.id)).toEqual([`binance:BBBUSDT:${oct + 60}`, `binance:AAAUSDT:${oct}`, `binance:AAAUSDT:${sep}`])
    expect(all.skippedLines).toBe(1)
    expect((await listMarketEvents({ symbol: 'aaausdt' })).rows).toHaveLength(2)
    expect((await listMarketEvents({ minBand: 'urgent' })).rows.map((row) => row.time)).toEqual([oct])
    expect((await listMarketEvents({ sinceSec: oct })).rows).toHaveLength(2)
    expect((await listMarketEvents({ limit: 1 })).rows).toHaveLength(1)
    expect(matchesMarketEventFilter(all.rows[0], { minBand: 'urgent' })).toBe(false)
  })
})

describe('a scan of history', () => {
  const request = (overrides: object = {}) => ({
    requestId: 'scan-1',
    pairs: [pair('PUMP'), pair('AAA')],
    startSec: T0 + EVENT_LOOKBACK_BARS * 60,
    endSec: LAST + 120,
    ...overrides
  })

  it('finds the events a running scanner would have raised, and keeps only those', async () => {
    const { scanHistory } = await scanner()
    const progress: number[] = []
    const result = await scanHistory(request(), (update) => progress.push(update.pairsDone))
    expect(result.cancelled).toBe(false)
    expect(result.failed).toEqual([])
    expect(result.events.length).toBeGreaterThanOrEqual(1)
    expect(new Set(result.events.map((event) => event.symbol))).toEqual(new Set(['PUMPUSDT']))
    expect(result.events.every((event) => event.live === null)).toBe(true)
    expect(progress[progress.length - 1]).toBe(2)
    // It asked for the lookback and the cooldown before the window, and for nothing after it.
    const call = market.rangeCalls.find((entry) => entry.symbol === 'PUMPUSDT')
    expect(call?.startSec).toBe(request().startSec - (EVENT_LOOKBACK_BARS + 30) * 60)
    expect(call?.endSec).toBe(request().endSec)
  })

  it('raises the event a live scanner raises on the same candles at the same minute', async () => {
    const { scanHistory, scanOnce } = await scanner()
    const first = (await scanHistory(request({ pairs: [pair('PUMP')] }), () => undefined)).events[0]
    // A live pass at the minute history says the pump first qualified, shown the candles an
    // exchange would have had then.
    const pump = market.history.get('PUMPUSDT') as Candle[]
    market.candles.set('PUMPUSDT', served(pump.filter((bar) => bar.time < first.time)))
    const live = (await scanOnce(first.time * 1000 + 5_000)).recentEvents[0]
    expect(live.time).toBe(first.time)
    expect({ ...live, live: null }).toEqual(first)
  })

  it('reports a pair it could not read and scans the rest', async () => {
    market.failing.add('AAAUSDT')
    const { scanHistory } = await scanner()
    const result = await scanHistory(request(), () => undefined)
    expect(result.failed).toEqual([{ symbol: 'AAAUSDT', error: 'AAAUSDT is down' }])
    expect(result.events.length).toBeGreaterThanOrEqual(1)
  })

  it('stops when told to, and does not report half a window as the whole', async () => {
    let release = (): void => undefined
    market.rangeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { scanHistory, cancelScanHistory } = await scanner()
    const running = scanHistory(request(), () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    cancelScanHistory('scan-1')
    release()
    const result = await running
    expect(result.cancelled).toBe(true)
    expect(result.events).toEqual([])
    expect(market.cancelled.sort()).toEqual(['scan-1:AAAUSDT', 'scan-1:PUMPUSDT'])
  })

  it('is bounded: a start before its end, ninety days, not the future, at least one pair', async () => {
    const { scanHistory } = await scanner()
    const noop = (): void => undefined
    await expect(scanHistory(request({ pairs: [] }), noop)).rejects.toThrow(/at least one pair/)
    await expect(scanHistory(request({ startSec: LAST, endSec: LAST }), noop)).rejects.toThrow(/start before its end/)
    await expect(scanHistory(request({ startSec: T0 - (SCAN_HISTORY_MAX_DAYS + 1) * 86_400, endSec: T0 }), noop)).rejects.toThrow(/at most 90 days/)
    await expect(scanHistory(request({ endSec: Math.floor(Date.now() / 1000) + 3600 }), noop)).rejects.toThrow(/future/)
    await expect(scanHistory(request({ floor: 'quiet' }), noop)).rejects.toThrow(/watch, candidate or urgent/)
    expect(market.rangeCalls).toEqual([])
  })
})

describe('a market-wide move (8 October 2026)', () => {
  const alts = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']

  function wholeMarket(btcPct: number): void {
    market.symbols = [pair('BTC'), ...alts.map((base) => pair(base))]
    market.tickers = [ticker('BTCUSDT', 2_000_000_000), ...alts.map((base, i) => ticker(`${base}USDT`, 40_000_000 + i * 1_000_000))]
    market.books = market.symbols.map((entry) => ({ symbol: entry.symbol, bidPrice: 99.99, askPrice: 100.01 }))
    market.candles = new Map<string, unknown[]>([
      ['BTCUSDT', served(withMove({ pct: btcPct, volume: 4 }, LEAD, 3))],
      ...alts.map((base, i): [string, unknown[]] => [`${base}USDT`, served(withMove({ pct: 3 + i * 0.2, volume: 8 }, LEAD, 7 + i))])
    ])
  }

  it("raises one event on Bitcoin's pair with the pairs that moved its way on it, marks those, and the watch would skip them", async () => {
    wholeMarket(1.5)
    const { scanOnce } = await scanner()
    const state = await scanOnce(NOW_MS)
    expect(state.error).toBeNull()
    const events = [...state.recentEvents].sort((a, b) => (a.live?.rank ?? 0) - (b.live?.rank ?? 0))
    expect(events).toHaveLength(6)
    const move = events[0]
    expect(move).toMatchObject({ symbol: 'BTCUSDT', type: 'market_move', direction: 'up', band: 'urgent' })
    expect(move.live).toMatchObject({ rank: 1 })
    const members = move.live?.members ?? []
    expect(members.map((member) => member.symbol).sort()).toEqual(['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT'])
    // Strongest first; the five pumps all score full marks, so they sort by name.
    for (let i = 1; i < members.length; i++) expect(members[i - 1].score).toBeGreaterThanOrEqual(members[i].score)
    expect(members[0]).toMatchObject({ direction: 'up' })
    for (const member of events.slice(1)) {
      expect(member.type).not.toBe('market_move')
      expect(member.live?.marketMove).toBe(move.id)
      expect(member.live?.rank).toBeGreaterThan(1)
    }
    expect(eventsOnFile()).toHaveLength(6)
    // Once per cooldown: the next pass raises nothing again.
    const again = await scanOnce(NOW_MS + 60_000)
    expect(again.recentEvents).toHaveLength(6)
  })

  it('raises one move per cooldown: a minute later five other pairs moving with Bitcoin raise their own events, and no second move', async () => {
    wholeMarket(1.5)
    const { scanOnce } = await scanner()
    expect((await scanOnce(NOW_MS)).recentEvents.filter((event) => event.type === 'market_move')).toHaveLength(1)
    // The next minute: five pairs the first pass did not watch, each in a fresh pump, Bitcoin still up.
    const others = ['FFF', 'GGG', 'HHH', 'III', 'JJJ']
    market.symbols = [pair('BTC'), ...others.map((base) => pair(base))]
    market.tickers = [ticker('BTCUSDT', 2_000_000_000), ...others.map((base, i) => ticker(`${base}USDT`, 40_000_000 + i * 1_000_000))]
    market.books = market.symbols.map((entry) => ({ symbol: entry.symbol, bidPrice: 99.99, askPrice: 100.01 }))
    market.candles = new Map<string, unknown[]>([
      ['BTCUSDT', served(thenFlat(withMove({ pct: 1.5, volume: 4 }, LEAD, 3), 1))],
      ...others.map((base, i): [string, unknown[]] => [`${base}USDT`, served(thenFlat(withMove({ pct: 3 + i * 0.2, volume: 8 }, LEAD, 17 + i), 1))])
    ])
    // The watched set is re-picked only once an hour; this pass is given the new one. Off while it
    // is set, or the setting (on by default since 8 October 2026) would start a pass of its own on
    // the real clock, and this pass, one at a time, would find it running.
    const { setScannerConfig } = await scanner()
    await setScannerConfig({ enabled: false, universeSize: 20 })
    const again = await scanOnce(NOW_MS + 60_000)
    const moves = again.recentEvents.filter((event) => event.type === 'market_move')
    expect(moves).toHaveLength(1)
    const fresh = again.recentEvents.filter((event) => others.some((base) => event.symbol === `${base}USDT`))
    expect(fresh.length).toBeGreaterThanOrEqual(5)
    expect(fresh.every((event) => event.live?.marketMove === undefined)).toBe(true)
  })

  it('raises the pairs as it always did when Bitcoin did not move with them', async () => {
    wholeMarket(0.3)
    const { scanOnce } = await scanner()
    const state = await scanOnce(NOW_MS)
    expect(state.recentEvents.some((event) => event.type === 'market_move')).toBe(false)
    expect(state.recentEvents.every((event) => event.live?.marketMove === undefined)).toBe(true)
    expect(state.recentEvents.filter((event) => (event.live?.rank ?? 99) <= 3)).toHaveLength(3)
  })
})

describe('the scanner failing', () => {
  it('is told once after three passes running fail, not on the first, and not again on the fourth', async () => {
    told.length = 0
    market.failing = new Set(market.symbols.map((entry) => entry.symbol))
    const { scanOnce } = await scanner()
    expect((await scanOnce(NOW_MS)).error).not.toBeNull()
    await scanOnce(NOW_MS + 60_000)
    expect(told).toEqual([])
    await scanOnce(NOW_MS + 120_000)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ title: 'The scanner is failing', extra: { kind: 'SYSTEM_FAILURE', thread: 'scanner' } })
    expect(told[0].body).toContain('Three passes running')
    await scanOnce(NOW_MS + 180_000)
    expect(told).toHaveLength(1)
  })
})
