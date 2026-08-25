import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveOrder, LivePosition } from '../shared/ipc'

// canPlaceLiveOrder is the one function every real order has to get past, and the file it lives
// in had no tests. Its own comment says a renderer-side check is a UX nicety and this is the
// actual gate -- so this is the gate whose failure modes matter, and nothing was pinning them.
// Everything it reads from disk or from another service is mocked here so each limit can be
// driven to its edge on purpose.

const state = {
  openPositions: [] as LivePosition[],
  restingOrders: [] as LiveOrder[],
  realizedPnlToday: 0
}

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-test-userdata' } }))
vi.mock('../electron/services/atomicWrite', () => ({ writeJsonAtomic: async () => undefined }))
vi.mock('../electron/services/livePositionsService', () => ({
  listOpenLivePositions: async () => state.openPositions,
  getRealizedPnlToday: async () => state.realizedPnlToday,
  getLastObservedFeeRate: async () => null
}))
vi.mock('../electron/services/liveOrdersService', () => ({
  listOpenLiveOrders: async () => state.restingOrders
}))

type Service = typeof import('../electron/services/liveTradingService')

/** A fresh copy of the service each time: it caches its state in module scope, and sessionArmed
 * is module scope too, so tests would otherwise inherit each other's arming and limits. */
async function freshService(): Promise<Service> {
  vi.resetModules()
  const service = (await import('../electron/services/liveTradingService')) as Service
  await service.setSessionArmed(true)
  return service
}

/** Every gate except the allocation lifted clear of the sizes used below, so a refusal in an
 * allocation test is the allocation refusing and nothing else. Without this the default max
 * order size of 10 does the refusing and the test passes without exercising anything. */
async function allocationOnly(service: Service, allocationQuote: number): Promise<void> {
  await service.setLiveTradingConfig({
    allocationQuote,
    maxOrderQuote: 25,
    dailyCapQuote: 10_000,
    dailyLossLimitQuote: 10_000
  })
}

const position = (over: Partial<LivePosition> = {}): LivePosition =>
  ({
    id: 'p1',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: 0.0005,
    avgCost: 60_000,
    openedAt: 1,
    closedAt: null,
    exitPrice: null,
    realizedPnl: null,
    ...over
  }) as LivePosition

const restingBuy = (over: Partial<LiveOrder> = {}): LiveOrder =>
  ({
    id: 'o1',
    executorId: 'e1',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    side: 'buy',
    orderId: 1,
    limitPrice: 60_000,
    quantity: 0.0005,
    status: 'open',
    filledQty: 0,
    avgFillPrice: null,
    placedAt: 1,
    resolvedAt: null,
    ...over
  }) as LiveOrder

beforeEach(() => {
  state.openPositions = []
  state.restingOrders = []
  state.realizedPnlToday = 0
})

describe('the gate with no allocation configured', () => {
  it('lets a normal order through', async () => {
    const service = await freshService()

    expect(await service.canPlaceLiveOrder(5)).toEqual({ allowed: true, reason: null })
  })

  it('still refuses one that is not armed, which is the gate that has to come first', async () => {
    vi.resetModules()
    const service = (await import('../electron/services/liveTradingService')) as Service

    expect((await service.canPlaceLiveOrder(5)).allowed).toBe(false)
  })

  it('ignores what is already committed, because there is no pot to measure it against', async () => {
    // Twenty open positions and the order is still fine: an allocation is opt-in, and turning it
    // on by accident would silently stop a setup that was working.
    const service = await freshService()
    state.openPositions = Array.from({ length: 20 }, (_, i) => position({ id: `p${i}` }))

    expect((await service.canPlaceLiveOrder(5)).allowed).toBe(true)
  })
})

describe('the gate with an allocation', () => {
  it('allows an order that fits inside what is left', async () => {
    const service = await freshService()
    await allocationOnly(service, 40)
    state.openPositions = [position()] // costs 30

    expect((await service.canPlaceLiveOrder(8)).allowed).toBe(true)
  })

  it('refuses one that does not, and says what is committed and what is left', async () => {
    // This message is the whole of what the user sees when a real order is refused.
    const service = await freshService()
    await allocationOnly(service, 40)
    state.openPositions = [position()]

    const result = await service.canPlaceLiveOrder(12)

    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('30.00')
    expect(result.reason).toContain('40.00')
    expect(result.reason).toContain('10.00')
  })

  it('counts a resting buy order as committed, not only a filled one', async () => {
    // Otherwise the same funds are committed twice over by placing orders faster than they fill.
    const service = await freshService()
    await allocationOnly(service, 40)
    state.restingOrders = [restingBuy()]

    expect((await service.canPlaceLiveOrder(12)).allowed).toBe(false)
  })

  it('frees the capital back up once the position is closed', async () => {
    const service = await freshService()
    await allocationOnly(service, 40)
    state.openPositions = [position({ closedAt: 2, exitPrice: 61_000 })]

    expect((await service.canPlaceLiveOrder(12)).allowed).toBe(true)
  })

  it('blocks everything at an allocation of zero, which is not the same as none', async () => {
    const service = await freshService()
    await service.setLiveTradingConfig({ allocationQuote: 0 })

    expect((await service.canPlaceLiveOrder(1)).allowed).toBe(false)
  })

  it('reports the allocation and what is committed in the status', async () => {
    const service = await freshService()
    await allocationOnly(service, 40)
    state.openPositions = [position()]
    const status = await service.getLiveTradingStatus()

    expect(status.allocationQuote).toBe(40)
    expect(status.allocationCommittedQuote).toBe(30)
  })

  it('reports no committed figure at all when there is no allocation to measure it against', async () => {
    // A committed number shown beside no allocation invites being read as a limit.
    const service = await freshService()
    state.openPositions = [position()]

    expect((await service.getLiveTradingStatus()).allocationCommittedQuote).toBe(0)
  })
})

describe('setting the allocation', () => {
  it('refuses a value that is not a usable number, and keeps the one already set', async () => {
    // A stored NaN would reach a gate made of `>` comparisons, every one of which is false
    // against it. Rejected at the door rather than coerced, so the user is told.
    const service = await freshService()
    await service.setLiveTradingConfig({ allocationQuote: 40 })

    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      await expect(service.setLiveTradingConfig({ allocationQuote: bad })).rejects.toThrow()
    }
    expect((await service.getLiveTradingStatus()).allocationQuote).toBe(40)
  })

  it('leaves the allocation alone when the patch does not mention it', async () => {
    // Every other field is patched the same way, and an allocation silently cleared by an
    // unrelated Save is a gate turned off by accident.
    const service = await freshService()
    await service.setLiveTradingConfig({ allocationQuote: 40 })
    await service.setLiveTradingConfig({ maxOrderQuote: 20 })

    expect((await service.getLiveTradingStatus()).allocationQuote).toBe(40)
  })

  it('clears it when the patch says null, which is a different instruction from not mentioning it', async () => {
    const service = await freshService()
    await service.setLiveTradingConfig({ allocationQuote: 40 })
    await service.setLiveTradingConfig({ allocationQuote: null })

    expect((await service.getLiveTradingStatus()).allocationQuote).toBeNull()
  })
})

describe('closing a position is never blocked by the allocation', () => {
  it('is allowed even when the allocation is full to the brim', async () => {
    // Every limit in this file bounds new risk. An allocation that could trap someone inside a
    // position they are trying to exit would be the one gate here that makes things worse.
    const service = await freshService()
    await allocationOnly(service, 1)
    state.openPositions = [position()]

    expect(await service.canCloseLivePosition()).toEqual({ allowed: true, reason: null })
  })
})
