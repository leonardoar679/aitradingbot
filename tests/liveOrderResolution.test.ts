import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveOrder } from '../shared/ipc'

// One resting order's fate written into the ledgers once (liveExecutionService.ts
// resolveOrderFromExchange; the V5 document, §101): shared by the 5-second poll, the account's own
// stream and the reconciliation, so whichever hears a fill first books it and the next finds the
// order resolved and does nothing.

const rig = vi.hoisted(() => ({
  current: null as null | LiveOrder,
  resolved: [] as unknown[][],
  usage: [] as unknown[][],
  fills: [] as unknown[][],
  lossChecks: 0
}))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-test-userdata' } }))
vi.mock('../electron/services/credentialsService', () => ({
  getDecryptedCredential: async () => ({ apiKey: 'key', apiSecret: 'secret' }),
  freeBalanceFor: async () => null
}))
vi.mock('../electron/services/exchanges/binanceTrading', () => ({
  placeMarketOrder: async () => undefined,
  placeMarketSellByQuantity: async () => undefined,
  cancelOrder: async () => undefined,
  fetchSymbolRules: async () => undefined
}))
vi.mock('../electron/services/liveTradingService', () => ({
  canPlaceLiveOrder: async () => ({ allowed: true }),
  canCloseLivePosition: async () => ({ allowed: true }),
  recordLiveOrderUsage: async (...args: unknown[]) => void rig.usage.push(args),
  checkLossLimitAndAutoDisarm: async () => void (rig.lossChecks += 1)
}))
vi.mock('../electron/services/livePositionsService', () => ({
  recordLiveFill: async (...args: unknown[]) => void rig.fills.push(args)
}))
vi.mock('../electron/services/liveOrdersService', () => ({
  listOpenLiveOrders: async () => (rig.current?.status === 'open' ? [rig.current] : []),
  getLiveOrder: async () => rig.current,
  resolveLiveOrder: async (...args: unknown[]) => {
    rig.resolved.push(args)
    if (rig.current !== null) rig.current = { ...rig.current, status: args[1] as LiveOrder['status'] }
  }
}))

import { resolveOrderFromExchange } from '../electron/services/liveExecutionService'

const T = 1_791_500_000

const order = (side: 'buy' | 'sell' = 'buy'): LiveOrder => ({
  id: 'lo1',
  executorId: 'ex1',
  exchange: 'binance',
  symbol: 'ETHUSDT',
  baseAsset: 'ETH',
  quoteAsset: 'USDT',
  side,
  orderId: 77,
  limitPrice: 4000,
  quantity: 1,
  status: 'open',
  filledQty: 0,
  avgFillPrice: null,
  placedAt: T,
  resolvedAt: null
})

const result = (status: string, filledQty: number, avgFillPrice: number, cummulativeQuoteQty: number) => ({
  orderId: 77,
  status,
  filledQty,
  avgFillPrice,
  cummulativeQuoteQty,
  commissions: filledQty > 0 ? { ETH: 0.001 } : {}
})

beforeEach(() => {
  rig.current = order()
  rig.resolved = []
  rig.usage = []
  rig.fills = []
  rig.lossChecks = 0
})

describe('resolveOrderFromExchange', () => {
  it('books nothing while the order rests', async () => {
    expect(await resolveOrderFromExchange(order(), result('NEW', 0, 0, 0))).toBeNull()
    expect(await resolveOrderFromExchange(order(), result('PARTIALLY_FILLED', 0.5, 4000, 2000))).toBeNull()
    expect(rig.resolved).toEqual([])
    expect(rig.usage).toEqual([])
    expect(rig.fills).toEqual([])
  })

  it('books a fill once: the order resolved, the reservation settled against what executed, the fill on the position', async () => {
    const filled = result('FILLED', 1, 3990, 3990)
    expect(await resolveOrderFromExchange(order(), filled)).toEqual({ executorId: 'ex1', liveOrderId: 'lo1', liveOrder: { ...filled, placedAt: T }, status: 'filled' })
    // The book named last, the real one (V7.1 Stage 8).
    expect(rig.resolved).toEqual([['lo1', 'filled', 1, 3990, 'real']])
    // Reserved 1 x 4000 at placement; executed for 3990: ten back to the day's cap, dated at the placement.
    expect(rig.usage).toEqual([[-10, T]])
    expect(rig.fills).toEqual([['binance', 'ETHUSDT', 'ETH', 'USDT', 'buy', 1, 3990, { ETH: 0.001 }, undefined, 'real']])
    expect(rig.lossChecks).toBe(0)
  })

  it('looks at the loss limit after a sell', async () => {
    rig.current = order('sell')
    await resolveOrderFromExchange(order('sell'), result('FILLED', 1, 4010, 4010))
    expect(rig.lossChecks).toBe(1)
  })

  it('the second to hear the same fill finds the order resolved and does nothing, even when both hear it at once', async () => {
    const filled = result('FILLED', 1, 3990, 3990)
    const [first, second] = await Promise.all([resolveOrderFromExchange(order(), filled), resolveOrderFromExchange(order(), filled)])
    expect([first === null, second === null].filter((x) => x)).toHaveLength(1)
    expect(rig.resolved).toHaveLength(1)
    expect(rig.fills).toHaveLength(1)
    expect(rig.usage).toHaveLength(1)
    expect(await resolveOrderFromExchange(order(), filled)).toBeNull()
    expect(rig.fills).toHaveLength(1)
  })

  it('books the part of a cancelled order that filled, and no fill for one that expired empty', async () => {
    expect((await resolveOrderFromExchange(order(), result('CANCELED', 0.4, 4000, 1600)))?.status).toBe('cancelled')
    expect(rig.resolved).toEqual([['lo1', 'cancelled', 0.4, 4000, 'real']])
    expect(rig.usage).toEqual([[-2400, T]])
    expect(rig.fills).toEqual([['binance', 'ETHUSDT', 'ETH', 'USDT', 'buy', 0.4, 4000, { ETH: 0.001 }, undefined, 'real']])

    rig.current = order()
    rig.resolved = []
    rig.usage = []
    rig.fills = []
    expect((await resolveOrderFromExchange(order(), result('EXPIRED', 0, 0, 0)))?.status).toBe('expired')
    expect(rig.resolved).toEqual([['lo1', 'expired', 0, null, 'real']])
    expect(rig.usage).toEqual([[-4000, T]])
    expect(rig.fills).toEqual([])
  })

  it('does nothing for an order the ledger no longer holds', async () => {
    rig.current = null
    expect(await resolveOrderFromExchange(order(), result('FILLED', 1, 3990, 3990))).toBeNull()
    expect(rig.resolved).toEqual([])
  })
})
