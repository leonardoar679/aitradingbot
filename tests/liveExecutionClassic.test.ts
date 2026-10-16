import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveOrder, LivePosition } from '../shared/ipc'
import type { TradingVenue } from '../electron/services/exchanges/venues'

// A REAL ORDER ON A CLASSIC ACCOUNT (electron/services/liveExecutionService.ts assertAccountCanTrade;
// 16 October 2026): a Bitget key made on an account not upgraded to the Unified Trading Account is
// read by this app and refused a real order before anything is sent, with the way said; a unified
// account's key, the demo book, an exchange without account modes, and a close, a cancel and a query
// are not held back by it. Everything the service reaches is faked: no gate, no ledger, no exchange.
// The executor form's own reading of the key is pinned from its source.

const fake = vi.hoisted(() => ({
  market: 0,
  limit: 0,
  sells: 0,
  cancels: 0,
  queries: 0,
  accountType: 'classic' as 'classic' | 'uta' | 'unknown' | null,
  /** A ledger order resting on Bitget's real account, for the cancel and the poll. */
  order: {
    id: 'o1',
    executorId: 'e1',
    exchange: 'bitget',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    side: 'buy',
    orderId: '1',
    limitPrice: 70000,
    quantity: 0.001,
    status: 'open',
    filledQty: 0,
    avgFillPrice: null,
    placedAt: 1,
    resolvedAt: null
  }
}))
vi.mock('electron', () => ({ app: { getPath: () => 'nowhere' } }))
vi.mock('../electron/services/liveTradingService', () => ({
  canPlaceLiveOrder: async () => ({ allowed: true }),
  canCloseLivePosition: async () => ({ allowed: true }),
  recordLiveOrderUsage: async () => undefined,
  checkLossLimitAndAutoDisarm: async () => undefined
}))
vi.mock('../electron/services/livePositionsService', () => ({ recordLiveFill: async () => ({}) }))
vi.mock('../electron/services/liveOrdersService', () => ({
  listOpenLiveOrders: async () => [],
  getLiveOrder: async (id: string) => (id === 'o1' ? fake.order : null),
  resolveLiveOrder: async () => null
}))
vi.mock('../electron/services/credentialsService', () => ({
  // The demo slot's key is on a Classic account too: the demo book is never held back by the account's mode.
  credentialAccountType: async (exchange: string, slot: string) => (exchange !== 'bitget' ? null : slot === 'real' ? fake.accountType : 'classic'),
  freeBalanceFor: async () => null,
  getDecryptedCredential: async () => ({ apiKey: 'k', apiSecret: 's', passphrase: 'p' })
}))
vi.mock('../electron/services/exchanges/venues', () => {
  const result = { orderId: '1', status: 'FILLED', filledQty: 0.001, avgFillPrice: 80000, cummulativeQuoteQty: 80, commissions: {} }
  const venue = (exchange: string, book: string, slot: string, label: string) => ({
    exchange,
    book,
    slot,
    label,
    placeMarketOrder: async () => {
      fake.market++
      return result
    },
    placeMarketSellByQuantity: async () => {
      fake.sells++
      return result
    },
    placeLimitOrder: async () => {
      fake.limit++
      return result
    },
    queryOrder: async () => {
      fake.queries++
      return result
    },
    cancelOrder: async () => {
      fake.cancels++
      return result
    },
    fetchOpenOrders: async () => [],
    fetchSymbolRules: async () => ({ minNotional: 1, minQty: 0, stepSize: '0.000001', tickSize: '0.01' })
  })
  const venues = [venue('binance', 'real', 'real', 'Binance'), venue('bitget', 'real', 'real', 'Bitget'), venue('bitget', 'demo', 'demo', 'Bitget demo')]
  return {
    venueFor: (exchange: string, book: string) => venues.find((entry) => entry.exchange === exchange && entry.book === book) ?? null,
    venuesOf: (book: string) => venues.filter((entry) => entry.book === book)
  }
})

const { assertAccountCanTrade, cancelLiveOrderById, executeLiveClose, placeLiveLimitOrderOn, placeLiveMarketOrder, pollLiveOrder } = await import('../electron/services/liveExecutionService')

const REFUSAL = 'This Bitget key is for a Classic account, which this app reads but cannot place an order on: switch the account to the Unified Trading Account on Bitget, then test the key again on Connections.'
const venueOf = (exchange: string, book: string, slot: string, label: string): TradingVenue => ({ exchange, book, slot, label }) as unknown as TradingVenue

beforeEach(() => {
  fake.market = 0
  fake.limit = 0
  fake.sells = 0
  fake.cancels = 0
  fake.queries = 0
  fake.accountType = 'classic'
})

describe('a real order on a Classic account', () => {
  it('is refused before anything is sent, a market order and a limit order alike, in words that say the way', async () => {
    await expect(placeLiveMarketOrder('bitget', 'BTCUSDT', 'BTC', 'USDT', 'buy', 50)).rejects.toThrow(REFUSAL)
    await expect(placeLiveLimitOrderOn('bitget', 'BTCUSDT', 'buy', 0.001, 70000)).rejects.toThrow(REFUSAL)
    expect(fake).toMatchObject({ market: 0, limit: 0 })
  })

  it('is placed on the demo book whatever the account, on an exchange without account modes, and on a unified account or one whose mode is not known', async () => {
    await placeLiveMarketOrder('bitget', 'BTCUSDT', 'BTC', 'USDT', 'buy', 50, 'demo')
    await placeLiveLimitOrderOn('bitget', 'BTCUSDT', 'buy', 0.001, 70000, 'demo')
    expect(fake).toMatchObject({ market: 1, limit: 1 })
    await placeLiveMarketOrder('binance', 'BTCUSDT', 'BTC', 'USDT', 'buy', 50)
    expect(fake.market).toBe(2)
    fake.accountType = 'uta'
    await placeLiveMarketOrder('bitget', 'BTCUSDT', 'BTC', 'USDT', 'buy', 50)
    await placeLiveLimitOrderOn('bitget', 'BTCUSDT', 'buy', 0.001, 70000)
    expect(fake).toMatchObject({ market: 3, limit: 2 })
    fake.accountType = 'unknown'
    await placeLiveMarketOrder('bitget', 'BTCUSDT', 'BTC', 'USDT', 'buy', 50)
    expect(fake.market).toBe(4)
  })

  it('never holds back a close, a cancel or a query: the check bounds new exposure and nothing else', async () => {
    await expect(assertAccountCanTrade(venueOf('bitget', 'real', 'real', 'Bitget'))).rejects.toThrow(REFUSAL)
    await expect(assertAccountCanTrade(venueOf('bitget', 'demo', 'demo', 'Bitget demo'))).resolves.toBeUndefined()
    await expect(assertAccountCanTrade(venueOf('binance', 'real', 'real', 'Binance'))).resolves.toBeUndefined()
    const position = { id: 'p1', exchange: 'bitget', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', qty: 0.002, avgCost: 80000, openedAt: 1, closedAt: null } as unknown as LivePosition
    await expect(executeLiveClose(position, 0.001)).resolves.toMatchObject({ status: 'FILLED' })
    await expect(cancelLiveOrderById('o1')).resolves.toMatchObject({ status: 'FILLED' })
    await expect(pollLiveOrder(fake.order as LiveOrder)).resolves.toMatchObject({ status: 'filled', liveOrderId: 'o1' })
    expect(fake).toMatchObject({ sells: 1, cancels: 1, queries: 1, market: 0, limit: 0 })
  })
})

describe('the executor form on a Classic key', () => {
  it('reads the account from the real key alone, keeps live out of reach, and says the reason and the way', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'executors', 'NewExecutorModal.tsx'), 'utf-8')
    expect(source).toContain("setLiveKeyClassic(list.some((c) => c.exchange === exchange && (c.slot ?? 'real') === 'real' && c.configured && c.accountType === 'classic'))")
    expect(source).toMatch(/const canGoLive =[\s\S]*?liveKeyConfigured &&\s*!liveKeyClassic &&/)
    expect(source).toContain("t('the {exchange} key is for a Classic account', { exchange: exchangeName })")
    expect(source).toContain(
      "t('This {exchange} key is for a Classic account: its balance is read, and a real order needs the Unified Trading Account. Switch the account on Bitget, then test the key again on Connections.', { exchange: exchangeName })"
    )
  })
})
