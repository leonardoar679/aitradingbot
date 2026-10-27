import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutorConfig } from '../shared/ipc'

// computePortfolioSnapshot produces every number on the landing page -- the one screen a new user
// is guaranteed to see. It had no tests at all: the existing portfolio test file imports only its
// type. Thirteen mutations of it, including inverting a short's value and blending real money
// with paper money into one row, all left the suite green.

const positions = new Map<string, { side: 'buy' | 'sell'; entryPrice: number; amountQuote: number; leverage?: number } | null>()
const throwingExecutors = new Set<string>()

vi.mock('../src/executors/computeSnapshot', () => ({
  computeExecutorPosition: async (executor: ExecutorConfig) => {
    if (throwingExecutors.has(executor.id)) throw new Error('boom')
    return positions.get(executor.id) ?? null
  },
  // Used by committedByAsset, which the account-cash path calls to work out what is already
  // committed. Mirrors the real helper for the position executors these tests build.
  executorAllocatedQuote: (executor: ExecutorConfig) =>
    (executor.params as { amountQuote?: number })?.amountQuote ?? 0
}))

const botTrades = new Map<string, number[] | null>()

vi.mock('../src/bots/useDryRun', () => ({
  fetchBotDryRunResult: async (bot: { id: string }) => {
    const t = botTrades.get(bot.id)
    if (t === null || t === undefined) throw new Error('dry run failed')
    return { result: { trades: t } }
  },
  summarizePaperTrades: (trades: number[]) => ({
    paperTrades: trades,
    paperWins: 0,
    paperNetPct: trades.length > 0 ? trades[0] : 0
  })
}))

const { computePortfolioSnapshot } = await import('../src/portfolio/computePortfolioSnapshot')

const executor = (id: string, over: Partial<ExecutorConfig> = {}): ExecutorConfig =>
  ({
    id,
    name: id,
    type: 'position',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    status: 'active',
    mode: 'paper',
    ...over
  }) as ExecutorConfig

let settings: { executors: ExecutorConfig[]; bots: unknown[]; heldPositions: unknown[]; paperAccount: unknown }
let livePositions: unknown[]
let prices: Record<string, number>

function install(): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      settings: { get: async () => settings },
      liveTrading: { listPositions: async () => livePositions },
      market: {
        fetchTicker24h: async (exchange: string, symbol: string) => {
          const p = prices[`${exchange}:${symbol}`]
          if (p === undefined) throw new Error('no price')
          return { lastPrice: p }
        }
      }
    }
  }
}

beforeEach(() => {
  positions.clear()
  throwingExecutors.clear()
  botTrades.clear()
  settings = { executors: [], bots: [], heldPositions: [], paperAccount: null }
  livePositions = []
  prices = {}
  install()
})

describe('computePortfolioSnapshot values a position', () => {
  beforeEach(() => {
    prices = { 'binance:BTCUSDT': 110, 'binance:ETHUSDT': 110 }
  })

  it('marks a long up when price rises', async () => {
    settings.executors = [executor('long')]
    positions.set('long', { side: 'buy', entryPrice: 100, amountQuote: 1000 })

    const snap = await computePortfolioSnapshot()
    // +10% on 1000.
    expect(snap.totalValue).toBeCloseTo(1100, 10)
  })

  it('marks a short DOWN on the same move', async () => {
    // The whole point of a short. Reading it as a long reports a 10% gain on a losing position.
    settings.executors = [executor('short', { symbol: 'ETHUSDT', baseAsset: 'ETH' })]
    positions.set('short', { side: 'sell', entryPrice: 100, amountQuote: 1000 })

    const snap = await computePortfolioSnapshot()
    expect(snap.totalValue).toBeCloseTo(900, 10)
  })
  it('marks a leveraged long by the leverage, not by the price move alone', async () => {
    // 1,000 at 10x in a 10% rally is worth 2,000, not 1,100. Reporting the 1,100 would show a
    // beginner a tenth of what their position has actually done -- in the direction that makes
    // leverage look mild.
    settings.executors = [executor('long')]
    positions.set('long', { side: 'buy', entryPrice: 100, amountQuote: 1000, leverage: 10 })

    const snap = await computePortfolioSnapshot()
    expect(snap.totalValue).toBeCloseTo(2000, 10)
  })

  it('never values a wiped-out leveraged position below zero', async () => {
    // A 10% move the wrong way on 10x takes the whole deposit and stops there -- isolated margin
    // cannot go negative. Left unfloored this row is -1,000 and quietly subtracts a thousand
    // dollars from the portfolio total, as though the loss carried on into the rest of the money.
    settings.executors = [executor('short', { symbol: 'ETHUSDT', baseAsset: 'ETH' })]
    positions.set('short', { side: 'sell', entryPrice: 100, amountQuote: 1000, leverage: 20 })

    const snap = await computePortfolioSnapshot()
    expect(snap.totalValue).toBe(0)
  })

  it('treats a position with no leverage recorded as 1x', async () => {
    settings.executors = [executor('long')]
    positions.set('long', { side: 'buy', entryPrice: 100, amountQuote: 1000, leverage: undefined })

    const snap = await computePortfolioSnapshot()
    expect(snap.totalValue).toBeCloseTo(1100, 10)
  })
})

describe('computePortfolioSnapshot keeps real money separate', () => {
  it('never merges a live row into a paper row for the same asset', async () => {
    // Blending these would show someone a single BTC number mixing money they actually have with
    // money they do not.
    prices = { 'binance:BTCUSDT': 110 }
    livePositions = [{ exchange: 'binance', symbol: 'BTCUSDT', qty: 2, baseAsset: 'BTC', quoteAsset: 'USDT' }]
    settings.executors = [executor('paper')]
    positions.set('paper', { side: 'buy', entryPrice: 100, amountQuote: 1000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.holdings).toHaveLength(2)
    const live = snap.holdings.find((h) => h.isLive)
    const paper = snap.holdings.find((h) => !h.isLive)
    expect(live?.value).toBeCloseTo(220, 10)
    expect(paper?.value).toBeCloseTo(1100, 10)
  })

  it('never merges two currencies into one row, or into the dollar total', async () => {
    // There is no exchange-rate table in this app, so a KRW holding summed into a dollar figure
    // would be off by roughly a thousandfold.
    prices = { 'binance:BTCUSDT': 110, 'bithumb:BTC_KRW': 110 }
    settings.executors = [executor('usd')]
    positions.set('usd', { side: 'buy', entryPrice: 100, amountQuote: 1000 })
    settings.heldPositions = [
      { exchange: 'bithumb', symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW', entryPrice: 100, amountQuote: 1000, side: 'buy' }
    ]

    const snap = await computePortfolioSnapshot()

    expect(snap.holdings).toHaveLength(2)
    expect(snap.totalValue).toBeCloseTo(1100, 10)
    expect(snap.holdings.map((h) => h.quoteAsset)).toEqual(['USDT', 'KRW'])
  })

  it('ranks dollar rows first even when another currency has a bigger raw number', async () => {
    // 800000 KRW is worth far less than 5000 USDT, so sorting on the raw number puts it on top.
    prices = { 'binance:BTCUSDT': 100, 'bithumb:BTC_KRW': 100 }
    settings.executors = [executor('usd')]
    positions.set('usd', { side: 'buy', entryPrice: 100, amountQuote: 5000 })
    settings.heldPositions = [
      { exchange: 'bithumb', symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW', entryPrice: 100, amountQuote: 800_000, side: 'buy' }
    ]

    const snap = await computePortfolioSnapshot()

    expect(snap.holdings[0].quoteAsset).toBe('USDT')
    expect(snap.holdings[0].value).toBeCloseTo(5000, 10)
  })
})

describe('computePortfolioSnapshot picks the right executors', () => {
  it('does not replay a live executor as a paper position', async () => {
    // A live executor has its own real ledger; simulating it here would double-count it.
    prices = { 'binance:BTCUSDT': 110 }
    settings.executors = [executor('live-one', { mode: 'live' })]
    positions.set('live-one', { side: 'buy', entryPrice: 100, amountQuote: 1000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.holdings).toHaveLength(0)
    expect(snap.totalValue).toBe(0)
    // Still counted as running, though -- it is active.
    expect(snap.activeExecutorCount).toBe(1)
  })

  it("does not value a trade of one of V8's books as the paper account's (V8 Stage 8)", async () => {
    prices = { 'binance:BTCUSDT': 110 }
    settings.executors = [executor('book', { book: { id: 'copy', startedAt: 1, ledger: 'follow' } })]
    positions.set('book', { side: 'buy', entryPrice: 100, amountQuote: 1000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.holdings).toHaveLength(0)
    expect(snap.totalValue).toBe(0)
  })

  it('ignores stopped executors entirely', async () => {
    prices = { 'binance:BTCUSDT': 110 }
    settings.executors = [executor('stopped', { status: 'stopped' })]
    positions.set('stopped', { side: 'buy', entryPrice: 100, amountQuote: 1000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.activeExecutorCount).toBe(0)
    expect(snap.holdings).toHaveLength(0)
  })
})

describe('computePortfolioSnapshot admits what is missing', () => {
  it('reports a position it could not price instead of quietly shrinking the total', async () => {
    // Every one of these used to just `continue`, so the headline number got smaller and nothing
    // said why.
    prices = {}
    settings.executors = [executor('unpriced')]
    positions.set('unpriced', { side: 'buy', entryPrice: 100, amountQuote: 1000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.totalValue).toBe(0)
    expect(snap.unavailable.unpricedPositions).toBe(1)
  })

  it('reports an executor whose position could not be computed', async () => {
    prices = { 'binance:BTCUSDT': 110 }
    settings.executors = [executor('broken')]
    throwingExecutors.add('broken')

    const snap = await computePortfolioSnapshot()

    expect(snap.unavailable.failedExecutors).toBe(1)
  })

  it('reports a bot whose dry run failed', async () => {
    settings.bots = [{ id: 'bad', enabled: true, enabledAt: 1 }]
    botTrades.set('bad', null)

    const snap = await computePortfolioSnapshot()

    expect(snap.unavailable.failedBots).toBe(1)
    expect(snap.botsAggregatePct).toBeNull()
  })
})

describe('computePortfolioSnapshot averages bots honestly', () => {
  it('returns null, not 0%, when no enabled bot has traded yet', async () => {
    // 0% reads as "tried and broke even". Null is "has not traded", and the page says so.
    settings.bots = [{ id: 'quiet', enabled: true, enabledAt: 1 }]
    botTrades.set('quiet', [])

    const snap = await computePortfolioSnapshot()

    expect(snap.botsAggregatePct).toBeNull()
  })

  it('averages only the bots that actually traded', async () => {
    settings.bots = [
      { id: 'traded', enabled: true, enabledAt: 1 },
      { id: 'quiet', enabled: true, enabledAt: 1 },
      { id: 'off', enabled: false, enabledAt: 1 }
    ]
    botTrades.set('traded', [10])
    botTrades.set('quiet', [])
    botTrades.set('off', [999])

    const snap = await computePortfolioSnapshot()

    // A bot with no trades must not drag the average toward zero, and a disabled one is not
    // fetched at all.
    expect(snap.botsAggregatePct).toBeCloseTo(10, 10)
  })
})

// There are three separate "could not price this" branches -- live positions, paper executors,
// and handed-over held positions -- each with its own copy of the counter. Mutating any one of
// them must fail, so each needs its own case; covering one branch leaves the other two free to
// drop a position silently.
describe('computePortfolioSnapshot reports an unpriced position from every source', () => {
  it('counts a live position it could not price', async () => {
    prices = {}
    livePositions = [{ exchange: 'binance', symbol: 'BTCUSDT', qty: 2, baseAsset: 'BTC', quoteAsset: 'USDT' }]

    const snap = await computePortfolioSnapshot()

    expect(snap.holdings).toHaveLength(0)
    expect(snap.unavailable.unpricedPositions).toBe(1)
  })

  it('counts a held position it could not price', async () => {
    prices = {}
    settings.heldPositions = [
      { exchange: 'bithumb', symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW', entryPrice: 100, amountQuote: 1000, side: 'buy' }
    ]

    const snap = await computePortfolioSnapshot()

    expect(snap.unavailable.unpricedPositions).toBe(1)
  })

  it('adds up unpriced positions across all three sources', async () => {
    prices = {}
    livePositions = [{ exchange: 'binance', symbol: 'BTCUSDT', qty: 2, baseAsset: 'BTC', quoteAsset: 'USDT' }]
    settings.executors = [executor('paper', { symbol: 'ETHUSDT', baseAsset: 'ETH' })]
    positions.set('paper', { side: 'buy', entryPrice: 100, amountQuote: 1000 })
    settings.heldPositions = [
      { exchange: 'bithumb', symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW', entryPrice: 100, amountQuote: 1000, side: 'buy' }
    ]

    const snap = await computePortfolioSnapshot()

    expect(snap.unavailable.unpricedPositions).toBe(3)
    expect(snap.totalValue).toBe(0)
  })
})

// Phase 1d: the paper account's uncommitted cash is part of the portfolio. The hazard is
// double-counting -- money a running strategy holds is already represented by that strategy's
// open position, and money that bought an Inventory row already left the balance.
describe('computePortfolioSnapshot includes account cash', () => {
  const account = (balances: Record<string, number>) =>
    ({ balances, initialBalances: { ...balances }, createdAt: 1_700_000_000, ledger: [] }) as never

  it('adds uncommitted cash to the total', async () => {
    settings.paperAccount = account({ USDT: 10_000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.totalValue).toBeCloseTo(10_000, 10)
  })

  it('counts money a running strategy holds ONCE, as the position', async () => {
    // 10,000 funded, 1,000 committed to a strategy whose position is now worth 1,100.
    // Right answer: 9,000 cash + 1,100 position = 10,100. Adding the full balance instead would
    // report 11,100 -- a 1,000 gain that never happened.
    prices = { 'binance:BTCUSDT': 110 }
    settings.paperAccount = account({ USDT: 10_000 })
    // params matters here, not just the position: what counts as committed is read from the
    // executor's own size, so an executor without params commits nothing and the cash is never
    // reduced -- which is precisely the double count under test.
    settings.executors = [executor('running', { params: { side: 'buy', amountQuote: 1_000 } } as never)]
    positions.set('running', { side: 'buy', entryPrice: 100, amountQuote: 1_000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.totalValue).toBeCloseTo(10_100, 10)
  })

  it('leaves the part of a strategy not yet in the market as cash', async () => {
    // The hazard in the other direction, and the one that was real. A 1,000 grid with three of
    // thirteen rungs filled holds about 231; the other 769 is still cash in the account, because
    // a paper strategy's money only ever moves when it stops. Fencing off the whole 1,000 while
    // adding back just the open lots reported 770 of the user's own money as simply gone --
    // measured in the running app as 10,000 in the account and 9,229.64 on the screen.
    prices = { 'binance:BTCUSDT': 100 }
    settings.paperAccount = account({ USDT: 10_000 })
    settings.executors = [executor('grid', { params: { side: 'buy', amountQuote: 1_000 } } as never)]
    positions.set('grid', { side: 'buy', entryPrice: 100, amountQuote: 231 })

    const snap = await computePortfolioSnapshot()

    // 9,769 cash + 231 of BTC at cost = the 10,000 that never left.
    expect(snap.totalValue).toBeCloseTo(10_000, 10)
    expect(snap.holdings.find((h) => h.baseAsset === 'USDT')?.value).toBeCloseTo(9_769, 10)
    expect(snap.holdings.find((h) => h.baseAsset === 'BTC')?.value).toBeCloseTo(231, 10)
  })

  it('leaves a strategy that holds nothing yet entirely as cash', async () => {
    // A Position executor still waiting for its entry price, or a TWAP that has no position at
    // all: its whole stake is untouched cash, and deducting it made the total drop the moment a
    // strategy was started.
    settings.paperAccount = account({ USDT: 10_000 })
    settings.executors = [executor('waiting', { params: { side: 'buy', amountQuote: 4_000 } } as never)]
    positions.set('waiting', null)

    const snap = await computePortfolioSnapshot()

    expect(snap.totalValue).toBeCloseTo(10_000, 10)
  })

  it('does not deduct the cost of a position it could not price', async () => {
    // No price means no holding row, so taking its cost out of the cash would understate the
    // total in exactly the way this whole rule exists to prevent. The unpriced count says so.
    prices = {}
    settings.paperAccount = account({ USDT: 10_000 })
    settings.executors = [executor('dark', { params: { side: 'buy', amountQuote: 1_000 } } as never)]
    positions.set('dark', { side: 'buy', entryPrice: 100, amountQuote: 600 })

    const snap = await computePortfolioSnapshot()

    expect(snap.totalValue).toBeCloseTo(10_000, 10)
    expect(snap.unavailable.unpricedPositions).toBe(1)
  })

  it('keeps a KRW balance out of the dollar total', async () => {
    settings.paperAccount = account({ USDT: 1_000, KRW: 5_000_000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.totalValue).toBeCloseTo(1_000, 10)
    expect(snap.holdings.some((h) => h.quoteAsset === 'KRW')).toBe(true)
  })

  it('leaves an emptied balance out of the holdings list', async () => {
    settings.paperAccount = account({ USDT: 0 })

    const snap = await computePortfolioSnapshot()

    expect(snap.holdings).toHaveLength(0)
  })

  it('changes nothing for someone who never set up an account', async () => {
    prices = { 'binance:BTCUSDT': 110 }
    settings.paperAccount = null
    settings.executors = [executor('running')]
    positions.set('running', { side: 'buy', entryPrice: 100, amountQuote: 1_000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.totalValue).toBeCloseTo(1_100, 10)
  })
})

// What the positions in the total cost from outside it: with no paper account a paper position's
// stake enters the total when it opens, as a real position's always does. Overview reads what the
// positions made as the total less this (src/overview/portfolioValueLine.ts).
describe('computePortfolioSnapshot says what came from outside the total', () => {
  it("counts a paper position's stake with no paper account, and says there is none", async () => {
    prices = { 'binance:BTCUSDT': 110 }
    settings.executors = [executor('running')]
    positions.set('running', { side: 'buy', entryPrice: 100, amountQuote: 1_000 })
    settings.heldPositions = [{ exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', side: 'buy', entryPrice: 100, amountQuote: 300 }]

    const snap = await computePortfolioSnapshot()

    expect(snap).toMatchObject({ hasPaperAccount: false, costOutsideQuote: 1_300 })
    expect(snap.totalValue - snap.costOutsideQuote).toBeCloseTo(130, 10)
  })

  it('counts none of it with a paper account, whose cash the stake was held back from', async () => {
    prices = { 'binance:BTCUSDT': 110 }
    settings.paperAccount = { balances: { USDT: 10_000 }, initialBalances: { USDT: 10_000 }, createdAt: 1_700_000_000, ledger: [] }
    settings.executors = [executor('running', { params: { side: 'buy', amountQuote: 1_000 } } as never)]
    positions.set('running', { side: 'buy', entryPrice: 100, amountQuote: 1_000 })

    const snap = await computePortfolioSnapshot()

    expect(snap).toMatchObject({ hasPaperAccount: true, costOutsideQuote: 0 })
    expect(snap.totalValue).toBeCloseTo(10_100, 10)
  })

  it("counts a real position at its cost, or, its cost unknown, at its worth, so it moves nothing", async () => {
    prices = { 'binance:BTCUSDT': 110, 'binance:ETHUSDT': 50 }
    livePositions = [
      { exchange: 'binance', symbol: 'BTCUSDT', qty: 2, avgCost: 100, baseAsset: 'BTC', quoteAsset: 'USDT' },
      { exchange: 'binance', symbol: 'ETHUSDT', qty: 3, baseAsset: 'ETH', quoteAsset: 'USDT' }
    ]
    settings.paperAccount = { balances: { USDT: 1_000 }, initialBalances: { USDT: 1_000 }, createdAt: 1_700_000_000, ledger: [] }

    const snap = await computePortfolioSnapshot()

    expect(snap.costOutsideQuote).toBeCloseTo(200 + 150, 10)
    expect(snap.totalValue - snap.costOutsideQuote).toBeCloseTo(1_000 + 20, 10)
  })

  it('leaves out what the total leaves out: a position it could not price, and one in another currency', async () => {
    prices = { 'bithumb:BTC_KRW': 110 }
    settings.executors = [executor('dark'), executor('krw', { exchange: 'bithumb', symbol: 'BTC_KRW', quoteAsset: 'KRW' })]
    positions.set('dark', { side: 'buy', entryPrice: 100, amountQuote: 1_000 })
    positions.set('krw', { side: 'buy', entryPrice: 100, amountQuote: 50_000 })

    const snap = await computePortfolioSnapshot()

    expect(snap.costOutsideQuote).toBe(0)
    expect(snap.totalValue).toBe(0)
  })
})
