import { describe, expect, it } from 'vitest'
import type { AppSettings, Candle } from '../shared/ipc'
import type { MissRecord } from '../shared/misses'
import type { NewsItem } from '../shared/news'
import type { NewsBookStamp } from '../shared/newsBook'
import { DEFAULT_PAPER_BOOKS, type BookStanding } from '../shared/paperBooks'
import type { FundingRate } from '../shared/traders/delay'
import { closeNewsBookShorts, newsBookExecutors, openNewsBookShorts, settleNewsBookShorts, type NewsBookDeps } from '../src/news/newsBookShort'

// THE NEWS BOOK'S SHORTS (src/news/newsBookShort.ts; V8 Stage 9): an announcement the rule acts on shorted in the news
// book on each coin's perpetual, staking the most the book lets one trade stake, through the book's room and the
// liquidity gate; refused with why, each refusal a miss carrying its key, a coin with no perpetual one no venue could
// take; closed where the perpetual's minutes say, at the funding it published, or at Stop at the price then.

const T0 = Date.UTC(2026, 9, 27, 12, 0, 30)
const MINUTE = Math.floor(T0 / 60_000) * 60
const STARTED = Math.floor(T0 / 1000) - 3600

const item = (over: Partial<NewsItem> = {}): NewsItem =>
  ({ id: 501, category: 'DELISTING', releaseSec: MINUTE - 60, title: 'Binance Will Delist ABC on 2026-11-03', tickers: ['ABC'], ...over }) as unknown as NewsItem

function harness(over: { running?: boolean; perp?: { venue: 'binance' | 'bitget'; symbol: string } | null; price?: number | null; thin?: boolean; bars?: Candle[] | null } = {}) {
  const settings: Pick<AppSettings, 'executors' | 'paperBooks'> = { executors: [], paperBooks: { ...DEFAULT_PAPER_BOOKS, running: over.running ?? true, startedAt: STARTED } }
  const misses: MissRecord[] = []
  const state = { now: T0, price: over.price === undefined ? 1 : over.price, rates: null as FundingRate[] | null, bars: [] as Candle[], tagBars: over.bars === undefined ? null : over.bars, id: 0, priceReads: 0 }
  const standing: BookStanding = { id: 'news', startQuote: 10_000, realizedQuote: 0, unrealizedQuote: 0, settledEquity: 10_000, equity: 10_000, open: 0, openStakeQuote: 0, closed: 0, dayStartEquity: 10_000 }
  const deps: NewsBookDeps = {
    getSettings: async () => settings,
    setExecutors: async (executors) => {
      settings.executors = executors
    },
    queue: (work) => work(),
    newsStanding: async () => standing,
    perpOf: async () => (over.perp === undefined ? { venue: 'binance', symbol: 'ABCUSDT' } : over.perp),
    perpPrice: async () => {
      state.priceReads++
      if (state.price === null) throw new Error('no price')
      return state.price
    },
    perpBook: async () => {
      const px = state.price ?? 1
      return over.thin === true ? { bids: [[px * 0.999, 10]], asks: [[px * 1.001, 10]], atMs: state.now } : { bids: [[px * 0.9999, 1_000_000]], asks: [[px * 1.0001, 1_000_000]], atMs: state.now }
    },
    perpBars: async (_venue, _symbol, fromSec) => (fromSec < MINUTE - 3600 ? (state.tagBars ?? []) : state.bars),
    perpFunding: async () => {
      if (state.rates === null) throw new Error('no rates')
      return state.rates
    },
    miss: async (miss) => void misses.push(miss),
    nowMs: () => state.now,
    newId: () => `n${++state.id}`
  }
  return { settings, misses, state, deps }
}

const stampOf = (settings: Pick<AppSettings, 'executors'>): NewsBookStamp => newsBookExecutors(settings.executors)[0].newsBook as NewsBookStamp

describe("an announcement's short in the news book", () => {
  it("is entered once on the coin's perpetual, at its price, staking a tenth of the book, out four hours after the announcement's minute", async () => {
    const { settings, deps } = harness()
    expect(await openNewsBookShorts(item(), deps)).toEqual(['ABC: entered short ABC at 1 on Binance ABCUSDT'])
    const [executor] = settings.executors
    expect(executor).toMatchObject({ type: 'position', mode: 'paper', exchange: 'binance', symbol: 'ABCUSDT', status: 'active', book: { id: 'news', startedAt: STARTED, ledger: 'rule' } })
    expect(executor.params).toMatchObject({ side: 'sell', entryPrice: 1, amountQuote: 1000, takeProfitPct: null, stopLossPct: null, feeRate: 0.0005 })
    expect(stampOf(settings)).toMatchObject({ articleId: 501, ticker: 'ABC', category: 'DELISTING', venue: 'binance', entryPx: 1, qty: 1000, stakeQuote: 1000, feesQuote: 0.5, exitAtSec: MINUTE - 60 + 240 * 60, stopPx: null, closeReason: null })
    expect(await openNewsBookShorts(item(), deps)).toEqual(['ABC: already entered'])
    expect(settings.executors).toHaveLength(1)
  })

  it("is refused with why, each a miss carrying the announcement's and coin's key: late, no venue, no price, no room, a thin book", async () => {
    const cases: [ReturnType<typeof harness>, NewsItem, MissRecord['stage'], RegExp][] = [
      [harness(), item({ releaseSec: MINUTE - 600 }), 'late', /more than five minutes ago/],
      [harness({ perp: null }), item(), 'gate', /No venue could take this: neither Binance nor Bitget lists a USDT perpetual of ABC/],
      [harness({ price: null }), item(), 'gate', /price could not be read/],
      [harness({ running: false }), item(), 'off', /not running/],
      [harness({ thin: true }), item(), 'liquidity', /hold/]
    ]
    for (const [{ settings, misses, deps }, announcement, stage, reason] of cases) {
      await openNewsBookShorts(announcement, deps)
      expect(settings.executors, String(reason)).toEqual([])
      expect(misses, String(reason)).toHaveLength(1)
      expect(misses[0]).toMatchObject({ book: 'news', writer: 'news-rule', side: 'down', stage, eventKey: 'news:501:ABC' })
      expect(misses[0].reason).toMatch(reason)
    }
  })

  it("is a tag's bracket, read from the perpetual's usual move, entered in its second minute, out at the close of its sixtieth", async () => {
    // Twelve hours of minutes, each moving 0.2%.
    const release = MINUTE - 60
    const bars: Candle[] = []
    for (let k = 0; k < 720; k++) {
      const time = release - 60 - (719 - k) * 60
      const close = k % 2 === 0 ? 1 : 1.002
      bars.push({ time, open: close, high: close, low: close, close, volume: 1000 })
    }
    const { settings, misses, deps } = harness({ bars })
    const tag = item({ category: 'MONITORING_TAG', releaseSec: release + 30, title: 'Binance Will Add ABC to the Monitoring Tag' } as Partial<NewsItem>)
    await openNewsBookShorts(tag, deps)
    expect(misses).toEqual([])
    const stamp = stampOf(settings)
    expect(stamp.category).toBe('MONITORING_TAG')
    expect(stamp.stopPx).toBeGreaterThan(1)
    expect(stamp.targetPx).toBeLessThan(1)
    expect(stamp.exitAtSec).toBe(release + 120 + 60 * 60)
    // Without the minutes, no bracket: refused.
    const blind = harness({ bars: null })
    await openNewsBookShorts(tag, blind.deps)
    expect(blind.misses[0]).toMatchObject({ stage: 'gate' })
    expect(blind.misses[0].reason).toMatch(/usual moves could not be read/)
  })
})

describe("the news book's open short", () => {
  it("closes at its hold, at the funding its perpetual published, and is given the result of one stopped elsewhere", async () => {
    const { settings, state, deps } = harness()
    await openNewsBookShorts(item(), deps)
    state.now = T0 + 4 * 3_600_000
    // The minute still open reaches twice the entry: it is not read until it closes.
    const openMinute = Math.floor(state.now / 60_000) * 60
    state.bars = [
      { time: MINUTE + 60, open: 1, high: 1.1, low: 0.95, close: 0.97, volume: 1 },
      { time: openMinute, open: 1, high: 3, low: 1, close: 2.5, volume: 1 }
    ]
    expect(await settleNewsBookShorts(deps)).toEqual([])
    state.bars = state.bars.slice(0, 1)
    const exitMinute = MINUTE - 60 + 240 * 60
    state.now = (exitMinute + 120) * 1000
    state.bars = [...state.bars, { time: exitMinute, open: 0.8, high: 0.82, low: 0.79, close: 0.8, volume: 1 }]
    state.rates = [{ timeSec: Math.floor(T0 / 1000) + 3 * 3600, rate: 0.0001 }]
    expect(await settleNewsBookShorts(deps)).toEqual(['Delisting short · ABC (news book)'])
    const [ended] = settings.executors
    expect(ended).toMatchObject({ status: 'stopped', newsBook: { closeReason: 'time', exitPx: 0.8 } })
    // 200 made; 0.5 in, 0.4 out; paid 0.01% of 1,000.
    expect(ended.book?.result?.netQuote).toBeCloseTo(200 - 0.9 + 0.1, 12)
    expect(ended.book?.result?.closedAt).toBe(exitMinute)
    // Stopped on its card: given its result at the price then, funding assumed against it where none could be read.
    const elsewhere = harness()
    await openNewsBookShorts(item(), elsewhere.deps)
    elsewhere.settings.executors = elsewhere.settings.executors.map((executor) => ({ ...executor, status: 'stopped' as const }))
    elsewhere.state.price = 1.1
    await settleNewsBookShorts(elsewhere.deps)
    expect(elsewhere.settings.executors[0]).toMatchObject({ newsBook: { closeReason: 'stopped', exitPx: 1.1 } })
    expect(elsewhere.settings.executors[0].book?.result?.netQuote).toBeCloseTo(-100 - 0.5 - 0.55, 12)
  })

  it('is closed at Stop at the price then, once, though Stop runs twice at once, with funding assumed against it where none is read', async () => {
    const { settings, state, deps } = harness()
    let chain: Promise<unknown> = Promise.resolve()
    deps.queue = <T>(work: () => Promise<T>): Promise<T> => {
      const run = chain.then(work)
      chain = run.catch(() => undefined)
      return run
    }
    await openNewsBookShorts(item(), deps)
    state.price = 0.9
    // From 12:00 to 17:00 UTC: 16:00 crossed, 0.01% of the 1,000 staked against it.
    state.now = T0 + 5 * 3_600_000
    const [first, second] = await Promise.all([closeNewsBookShorts(deps), closeNewsBookShorts(deps)])
    expect([...first, ...second]).toEqual(['Delisting short · ABC (news book)'])
    expect(settings.executors[0]).toMatchObject({ status: 'stopped', newsBook: { closeReason: 'stopped', exitPx: 0.9 } })
    expect(settings.executors[0].book?.result?.fundingQuote).toBeCloseTo(-0.1, 12)
    // Nothing left open: Stop reads no price again, and the minute's settlement closes nothing.
    const reads = state.priceReads
    expect(await closeNewsBookShorts(deps)).toEqual([])
    expect(state.priceReads).toBe(reads)
    expect(await settleNewsBookShorts(deps)).toEqual([])
  })
})
