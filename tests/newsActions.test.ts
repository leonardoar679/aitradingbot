import { describe, expect, it } from 'vitest'
import type { Candle, ExecutorConfig, PaperAccount, PositionExecutorParams, SymbolInfo } from '../shared/ipc'
import { DEFAULT_NEWS_CONFIG, applyNewsConfigPatch, healNewsConfig, type NewsConfig, type NewsItem } from '../shared/news'
import {
  delistingHolderNotice,
  delistingShortBlock,
  delistingShortParams,
  describeNewsShortOrigin,
  heldPlaces,
  isFreshDelisting,
  newsShortExecutors,
  type Holdings
} from '../shared/newsActions'
import { simulatePosition } from '../src/executors/engine'
import { newsShortExecutor, openDelistingShorts, settleNewsShorts, type NewsShortDeps } from '../src/news/newsPaperShort'

// What a delisting announcement does, as the user chose on 2026-10-05 (shared/newsActions.ts,
// src/news/): a notice to someone holding the coin, and a PAPER short by the rule research/NEWS.md
// measured -- out at the open four hours after the announcement's minute, no stop, no target.

/** ICX, SCRT and STORJ: Binance's announcement of 20 August 2026, 06:00 UTC. */
const A = Date.parse('2026-08-20T06:00:00Z') / 1000

const item: NewsItem = {
  id: 301,
  catalog: 161,
  title: 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03',
  releaseSec: A,
  seenAt: A + 3,
  category: 'DELISTING',
  tickers: ['ICX', 'SCRT', 'STORJ']
}

const pair = (base: string): SymbolInfo => ({ symbol: `${base}USDT`, baseAsset: base, quoteAsset: 'USDT' })

describe("the rule's short", () => {
  it('is out at the open four hours after the announcement, whenever in the minute it is opened', () => {
    // Opened in the minute after the announcement's: in at the next open, two minutes after it.
    expect(delistingShortParams({ releaseSec: A + 2, createdAt: A + 63, stakeQuote: 100 })).toEqual({
      side: 'sell',
      entryPrice: null,
      amountQuote: 100,
      takeProfitPct: null,
      stopLossPct: null,
      timeLimitSec: 237 * 60,
      trailingStop: null
    })
    // Opened in the announcement's own minute: in a minute sooner, held a minute longer.
    expect(delistingShortParams({ releaseSec: A, createdAt: A + 3, stakeQuote: 100 }).timeLimitSec).toBe(238 * 60)
    expect(delistingShortParams({ releaseSec: A, createdAt: A + 60, stakeQuote: 100 }).timeLimitSec).toBe(238 * 60)
  })

  it('is closed by the engine at the close of the minute before the four hours are up', () => {
    const params = delistingShortParams({ releaseSec: A, createdAt: A + 63, stakeQuote: 100 })
    // In at 10 at A+2min; the coin rises to 11 at A+200min and stays there.
    const bars: Candle[] = []
    for (let t = A + 120; t <= A + 250 * 60; t += 60) {
      const price = t < A + 200 * 60 ? 10 : 11
      bars.push({ time: t, open: price, high: price, low: price, close: price, volume: 1 })
    }
    const state = simulatePosition(bars, params as PositionExecutorParams)
    expect(state).toMatchObject({ status: 'closed', exitReason: 'time_limit', entryPrice: 10, enteredAt: A + 120, closedAt: A + 239 * 60 })
    // A short of a coin that rose: it lost the rise and the fees.
    expect(state.realizedPnl).toBeCloseTo(-10 - (100 + 110) * 0.001, 6)
  })

  it('opens only on a delisting of that coin, within five minutes, once', () => {
    const base = { item, ticker: 'ICX', nowSec: A + 63, executors: [] as ExecutorConfig[] }
    expect(delistingShortBlock(base)).toBeNull()
    expect(delistingShortBlock({ ...base, ticker: 'BTC' })).toMatch(/not a delisting of this coin/)
    expect(delistingShortBlock({ ...base, item: { ...item, category: 'FUTURES_LAUNCH' } })).toMatch(/not a delisting/)
    expect(delistingShortBlock({ ...base, nowSec: A + 5 * 60 })).toBeNull()
    expect(delistingShortBlock({ ...base, nowSec: A + 5 * 60 + 1 })).toMatch(/more than five minutes ago/)
    const opened = newsShortExecutor({ id: 'x', item, ticker: 'ICX', pair: pair('ICX'), stakeQuote: 100, nowSec: A + 63 })
    expect(delistingShortBlock({ ...base, executors: [opened] })).toMatch(/already opened its short on this coin/)
    expect(delistingShortBlock({ ...base, ticker: 'SCRT', executors: [opened] })).toBeNull()
  })

  it('is paper, unlevered and kept nowhere when it stops, and its card says where it came from', () => {
    const made = newsShortExecutor({ id: 'x', item, ticker: 'ICX', pair: pair('ICX'), stakeQuote: 250, nowSec: A + 63 })
    expect(made).toMatchObject({ type: 'position', mode: 'paper', exchange: 'binance', symbol: 'ICXUSDT', status: 'active', keepPosition: false, createdAt: A + 63 })
    expect(made.newsRule).toEqual({ articleId: 301, ticker: 'ICX', releaseSec: A, title: item.title })
    expect((made.params as PositionExecutorParams).leverage).toBeUndefined()
    expect(made.watch).toBeUndefined()
    expect(describeNewsShortOrigin(made.newsRule as NonNullable<ExecutorConfig['newsRule']>)).toBe(
      "Opened by the news reader, with nobody pressing anything, on Binance's announcement at 06:00 UTC that it will delist ICX: a short held four hours by the rule research/NEWS.md measured. Paper."
    )
    // A live executor carrying the mark is never one of the rule's.
    expect(newsShortExecutors([made, { ...made, id: 'y', mode: 'live' }]).map((executor) => executor.id)).toEqual(['x'])
  })
})

describe('the notice to someone holding the coin', () => {
  const nothing: Holdings = { live: null, paperAccount: null, heldPositions: [], executors: [] }

  it('says nothing to someone who holds none of the coins', () => {
    expect(delistingHolderNotice(item, nothing)).toBeNull()
    expect(delistingHolderNotice(item, { ...nothing, live: [{ asset: 'BTC', free: 1, locked: 0 }] })).toBeNull()
    expect(delistingHolderNotice({ ...item, category: 'SPOT_LISTING' }, { ...nothing, live: [{ asset: 'ICX', free: 1, locked: 0 }] })).toBeNull()
  })

  it('names each place a coin is held, and says nothing was sold', () => {
    const account: PaperAccount = { balances: { USDT: 500, SCRT: 12.5 }, initialBalances: { USDT: 1000 }, createdAt: A - 86_400, ledger: [] }
    const running = newsShortExecutor({ id: 'r', item, ticker: 'ICX', pair: pair('ICX'), stakeQuote: 100, nowSec: A })
    const holdings: Holdings = {
      live: [{ asset: 'ICX', free: 100, locked: 20.5 }],
      paperAccount: account,
      heldPositions: [],
      executors: [{ ...running, id: 'mine', newsRule: undefined }, running]
    }
    expect(heldPlaces('ICX', holdings)).toEqual(['120.5 ICX on Binance', 'an executor running on ICX'])
    expect(heldPlaces('SCRT', holdings)).toEqual(['12.5 SCRT in the paper account'])
    expect(heldPlaces('STORJ', holdings)).toEqual([])
    expect(delistingHolderNotice(item, holdings)).toEqual({
      title: 'Binance will delist ICX, SCRT, which you hold',
      body:
        'You hold 120.5 ICX on Binance and an executor running on ICX; 12.5 SCRT in the paper account. Nothing has been sold. ' +
        'Coins Binance announced it would delist were on average 13% lower four hours later (research/NEWS.md). Announced 06:00 UTC: "Binance Will Delist ICX, SCRT, STORJ on 2026-09-03"'
    })
    // What must survive a notice cut at 400 characters comes first.
    const long = delistingHolderNotice({ ...item, title: 'x'.repeat(600) }, holdings)
    expect(long?.body.slice(0, 400)).toContain('Nothing has been sold.')
  })

  it('is given only for a delisting read in this session, and not a day after it', () => {
    const at = { sessionStartSec: A - 60, nowSec: A + 60, latestSeconds: 24 * 3600 }
    expect(isFreshDelisting(item, at)).toBe(true)
    expect(isFreshDelisting({ ...item, seenAt: A - 61 }, at)).toBe(false)
    expect(isFreshDelisting(item, { ...at, nowSec: A + 24 * 3600 + 1 })).toBe(false)
    expect(isFreshDelisting({ ...item, category: null }, at)).toBe(false)
  })
})

describe('its setting', () => {
  it('reads a file it cannot use as off, and keeps the notice on unless told otherwise', () => {
    expect(healNewsConfig(null)).toEqual(DEFAULT_NEWS_CONFIG)
    expect(DEFAULT_NEWS_CONFIG).toEqual({ enabled: false, notifyHeld: true, paperShort: { enabled: false, stakeQuote: 100 } })
    expect(healNewsConfig({ enabled: 'true', notifyHeld: false, paperShort: { enabled: 1, stakeQuote: 333 } })).toEqual({
      enabled: false,
      notifyHeld: false,
      paperShort: { enabled: false, stakeQuote: 100 }
    })
    expect(healNewsConfig({ enabled: true, paperShort: { enabled: true, stakeQuote: 250 } })).toEqual({ enabled: true, notifyHeld: true, paperShort: { enabled: true, stakeQuote: 250 } })
  })

  it('takes a change it can use, and says why it refuses one it cannot', () => {
    const on = applyNewsConfigPatch(DEFAULT_NEWS_CONFIG, { enabled: true, paperShort: { enabled: true } }) as NewsConfig
    expect(on).toEqual({ enabled: true, notifyHeld: true, paperShort: { enabled: true, stakeQuote: 100 } })
    expect(applyNewsConfigPatch(on, { paperShort: { stakeQuote: 500 } })).toEqual({ ...on, paperShort: { enabled: true, stakeQuote: 500 } })
    expect(applyNewsConfigPatch(on, { enabled: 'yes' as never })).toBe('The news reader is either on or off')
    expect(applyNewsConfigPatch(on, { notifyHeld: 1 as never })).toBe('The notice to holders is either on or off')
    expect(applyNewsConfigPatch(on, { paperShort: { stakeQuote: 7 } })).toBe('A paper short stakes 25, 50, 100, 250, 500, 1000')
    expect(applyNewsConfigPatch(on, { paperShort: null as never })).toBe('Not a setting for the paper short')
    // The config it was given is not changed.
    expect(DEFAULT_NEWS_CONFIG.paperShort.enabled).toBe(false)
  })
})

interface Rig {
  deps: NewsShortDeps
  state: { executors: ExecutorConfig[]; account: PaperAccount | null; now: number; candles: Candle[]; pairs: SymbolInfo[] }
  notices: { title: string; body: string }[]
  settled: string[]
}

function rig(initial: Partial<Rig['state']> = {}): Rig {
  const state: Rig['state'] = { executors: [], account: null, now: A + 63, candles: [], pairs: [pair('ICX'), pair('SCRT'), { symbol: 'STORJBTC', baseAsset: 'STORJ', quoteAsset: 'BTC' }], ...initial }
  const made: Rig = { deps: undefined as unknown as NewsShortDeps, state, notices: [], settled: [] }
  let tail: Promise<unknown> = Promise.resolve()
  let ids = 0
  made.deps = {
    getSettings: async () => ({ executors: [...state.executors], paperAccount: state.account }),
    setExecutors: async (executors) => {
      state.executors = executors
    },
    listPairs: async () => state.pairs,
    fetchCandles: async () => state.candles,
    settle: async (target) => {
      made.settled.push(target.id)
    },
    notify: (title, body) => {
      made.notices.push({ title, body })
    },
    nowSec: () => state.now,
    newId: () => `short-${++ids}`,
    queue: <T>(work: () => Promise<T>): Promise<T> => {
      const run = tail.then(work)
      tail = run.catch(() => undefined)
      return run
    }
  }
  return made
}

const ON = { paperShort: { enabled: true, stakeQuote: 100 } }

describe('opening the shorts', () => {
  it('opens nothing while it is switched off', async () => {
    const r = rig()
    expect(await openDelistingShorts(item, { paperShort: { enabled: false, stakeQuote: 100 } }, r.deps)).toEqual([])
    expect(r.state.executors).toEqual([])
  })

  it('opens one paper short on each coin with a USDT pair, and says why not on the others', async () => {
    const r = rig()
    expect(await openDelistingShorts(item, ON, r.deps)).toEqual([
      'ICX: a paper short of 100 USDT was opened.',
      'SCRT: a paper short of 100 USDT was opened.',
      'STORJ: no paper short, as it has no USDT pair on Binance.'
    ])
    expect(r.state.executors.map((executor) => [executor.symbol, executor.mode, (executor.params as PositionExecutorParams).side, executor.newsRule?.ticker])).toEqual([
      ['ICXUSDT', 'paper', 'sell', 'ICX'],
      ['SCRTUSDT', 'paper', 'sell', 'SCRT']
    ])
    expect(r.notices.map((notice) => notice.title)).toEqual(['Paper short: ICXUSDT', 'Paper short: SCRTUSDT'])
    expect(r.notices[0].body).toContain('Paper: nothing real was placed.')

    // Read again -- the same announcement opens nothing more.
    expect(await openDelistingShorts(item, ON, r.deps)).toEqual([
      'ICX: no paper short. The rule has already opened its short on this coin for this announcement.',
      'SCRT: no paper short. The rule has already opened its short on this coin for this announcement.',
      'STORJ: no paper short, as it has no USDT pair on Binance.'
    ])
    expect(r.state.executors).toHaveLength(2)
  })

  it('opens none it is too late for, and none the paper account cannot fund', async () => {
    const late = rig({ now: A + 6 * 60 })
    expect((await openDelistingShorts(item, ON, late.deps))[0]).toMatch(/^ICX: no paper short. It was announced more than five minutes ago/)
    expect(late.state.executors).toEqual([])

    const poor = rig({ account: { balances: { USDT: 150 }, initialBalances: { USDT: 150 }, createdAt: A - 86_400, ledger: [] } })
    const lines = await openDelistingShorts(item, ON, poor.deps)
    expect(lines[0]).toBe('ICX: a paper short of 100 USDT was opened.')
    expect(lines[1]).toMatch(/^SCRT: no paper short. /)
    expect(poor.state.executors).toHaveLength(1)
  })
})

describe('settling the shorts', () => {
  it('stops and settles a short once its four hours are up, once, with how it ended written on it', async () => {
    const r = rig()
    await openDelistingShorts(item, ON, r.deps)
    const bars: Candle[] = []
    for (let t = A + 120; t <= A + 245 * 60; t += 60) bars.push({ time: t, open: 10, high: 10, low: 9, close: t < A + 100 * 60 ? 10 : 9, volume: 1 })
    r.state.candles = bars

    // Still inside the four hours: nothing.
    r.state.now = A + 200 * 60
    expect(await settleNewsShorts(r.deps)).toEqual([])

    r.state.now = A + 241 * 60
    expect(await settleNewsShorts(r.deps)).toEqual(['Delisting short · ICXUSDT', 'Delisting short · SCRTUSDT'])
    expect(r.settled).toEqual(['short-1', 'short-2'])
    const ended = r.state.executors[0]
    expect(ended).toMatchObject({ status: 'stopped', stoppedAt: A + 241 * 60 })
    expect(ended.newsRule?.result).toMatchObject({ exit: 'time_limit', closedAt: A + 239 * 60 })
    expect(ended.newsRule?.result?.pnlQuote).toBeGreaterThan(0)

    // Settled once.
    expect(await settleNewsShorts(r.deps)).toEqual([])
    expect(r.settled).toHaveLength(2)
  })

  it('is settled once by two passes that overlap, and not at all once someone stopped it first', async () => {
    const r = rig()
    await openDelistingShorts({ ...item, tickers: ['ICX'] }, ON, r.deps)
    r.state.candles = Array.from({ length: 126 * 4 }, (_, i) => ({ time: A + 120 + i * 60, open: 10, high: 10, low: 10, close: 10, volume: 1 }))
    r.state.now = A + 241 * 60
    const [first, second] = await Promise.all([settleNewsShorts(r.deps), settleNewsShorts(r.deps)])
    expect([...first, ...second]).toEqual(['Delisting short · ICXUSDT'])
    expect(r.settled).toEqual(['short-1'])

    // Stopped by hand while its candles were being read: whoever stopped it booked it.
    const byHand = rig()
    await openDelistingShorts({ ...item, tickers: ['ICX'] }, ON, byHand.deps)
    byHand.state.candles = r.state.candles
    byHand.state.now = A + 241 * 60
    const read = byHand.deps.fetchCandles
    byHand.deps.fetchCandles = async (...args) => {
      byHand.state.executors = byHand.state.executors.map((executor) => ({ ...executor, status: 'stopped' as const, stoppedAt: A + 100 * 60 }))
      return read(...args)
    }
    expect(await settleNewsShorts(byHand.deps)).toEqual([])
    expect(byHand.settled).toEqual([])
    expect(byHand.state.executors[0].newsRule?.result).toBeUndefined()
  })

  it("leaves alone every executor that is not one of the rule's shorts", async () => {
    const r = rig()
    await openDelistingShorts(item, ON, r.deps)
    r.state.executors = r.state.executors.map((executor) => ({ ...executor, newsRule: undefined }))
    r.state.candles = [{ time: A + 120, open: 10, high: 10, low: 10, close: 10, volume: 1 }]
    r.state.now = A + 300 * 60
    expect(await settleNewsShorts(r.deps)).toEqual([])
  })
})
