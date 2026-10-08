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
  realizedPnlToday: 0,
  /** Why the exchange's health pauses live entries now (shared/exchangeHealth.ts); none when it does not. */
  unhealthy: [] as string[]
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
vi.mock('../electron/services/exchangeHealthService', () => ({
  liveHealthReasons: () => state.unhealthy
}))
/** What the main process told: the session disarmed by the day's loss (the V4 document, §48). */
const told = vi.hoisted(() => [] as { title: string; body: string; extra: { kind: string; thread?: string } }[])
vi.mock('../electron/services/noticeService', () => ({
  tell: (notice: { title: string; body: string; extra: { kind: string; thread?: string } }) => void told.push(notice),
  tellNotice: async () => true
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
  state.unhealthy = []
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

describe('the size limits are about exposure, not about the margin posted', () => {
  // The gate that has to exist before any leveraged order path does. A limit compared against the
  // margin is silently weaker than the number printed beside it: 25 at 10x is a 250 order in
  // every way that matters for what it can do to a balance.

  it('is unchanged for spot, where the two amounts are the same number', async () => {
    const service = await freshService()
    await service.setLiveTradingConfig({ maxOrderQuote: 25 })

    expect((await service.canPlaceLiveOrder(20)).allowed).toBe(true)
    expect((await service.canPlaceLiveOrder(20, 1)).allowed).toBe(true)
    expect((await service.canPlaceLiveOrder(26, 1)).allowed).toBe(false)
  })

  it('refuses a margin that fits when the exposure it buys does not', async () => {
    const service = await freshService()
    await service.setLiveTradingConfig({ maxOrderQuote: 25 })

    // 20 of margin is inside the limit. 20 at 10x is 200 of market and is not.
    expect((await service.canPlaceLiveOrder(20, 10)).allowed).toBe(false)
  })

  it('says what the exposure was, so the refusal is not baffling', async () => {
    // "Order exceeds the max order size (25)" on an order of 20 reads like a bug unless the
    // sentence also says what the 20 turned into.
    const service = await freshService()
    await service.setLiveTradingConfig({ maxOrderQuote: 25 })
    const result = await service.canPlaceLiveOrder(20, 10)

    expect(result.reason).toContain('10x')
  })

  it('allows a leveraged order whose exposure still fits', async () => {
    const service = await freshService()
    await service.setLiveTradingConfig({ maxOrderQuote: 25 })

    expect((await service.canPlaceLiveOrder(2, 10)).allowed).toBe(true)
  })

  it('charges the daily cap the exposure too', async () => {
    const service = await freshService()
    await service.setLiveTradingConfig({ maxOrderQuote: 25, dailyCapQuote: 20 })

    // 4 at 5x is 20 of notional: exactly the cap, so it fits and one unit more does not. Both are
    // inside the per-order limit, so the cap is what decides.
    expect((await service.canPlaceLiveOrder(4, 5)).allowed).toBe(true)
    expect((await service.canPlaceLiveOrder(5, 5)).allowed).toBe(false)
  })

  it('cannot be paid around: the hard ceiling bounds exposure however the margin is posted', async () => {
    // The ceiling is code-only and cannot be raised from anywhere. Since it now bounds what the
    // order CONTROLS, leverage buys no more room -- it only means less margin is needed to reach
    // the same wall.
    const service = await freshService()
    await service.setLiveTradingConfig({ maxOrderQuote: 1_000 })
    const status = await service.getLiveTradingStatus()

    expect(status.maxOrderQuote).toBe(status.hardMaxOrderQuote)
    expect((await service.canPlaceLiveOrder(3, 10)).allowed).toBe(false)
    expect((await service.canPlaceLiveOrder(2, 10)).allowed).toBe(true)
  })

  it('treats an unusable leverage as 1x rather than as no multiplier at all', async () => {
    // A NaN multiplied into the notional makes every `>` comparison false, which would not weaken
    // the gate -- it would disable it. Falling back to 1x is the only safe direction.
    const service = await freshService()
    await service.setLiveTradingConfig({ maxOrderQuote: 25 })

    expect((await service.canPlaceLiveOrder(20, Number.NaN)).allowed).toBe(true)
    expect((await service.canPlaceLiveOrder(26, Number.NaN)).allowed).toBe(false)
    expect((await service.canPlaceLiveOrder(26, 1_000)).allowed).toBe(false)
  })

  it('charges the allocation the margin, not the exposure', async () => {
    // The opposite choice from the size limits, on purpose: an allocation is how much of the
    // user's own money may be at stake, and a leveraged position stakes its margin and borrows
    // the rest. Charging it for the borrowed part would refuse orders the money could back.
    const service = await freshService()
    await service.setLiveTradingConfig({
      allocationQuote: 1.5,
      maxOrderQuote: 25,
      dailyCapQuote: 10_000,
      dailyLossLimitQuote: 10_000
    })

    // 2 of margin at 10x is 20 of exposure, inside the per-order ceiling -- but 2 of the user's
    // own money, which is more than the 1.50 they allocated. Were the allocation charged the
    // exposure instead, even a 0.20 margin order would be refused against it.
    expect((await service.canPlaceLiveOrder(2, 10)).allowed).toBe(false)
    expect((await service.canPlaceLiveOrder(1, 10)).allowed).toBe(true)
  })
})

// THE EXCHANGE'S HEALTH (the V4 document, §92-93): while the data is stale with REST failing, the
// clock is off, REST is slow or the key's last test failed, no NEW real position is opened. A
// closing order is never refused by it: an open position keeps its protection.
describe('the gate while the exchange is degraded', () => {
  it('refuses a new order and says why, after the arming and the kill switch', async () => {
    const service = await freshService()
    state.unhealthy = ["the clock is 7.4 s ahead of Binance's", "the Binance key's last test failed"]
    expect(await service.canPlaceLiveOrder(5)).toEqual({ allowed: false, reason: "Live trading is paused: the clock is 7.4 s ahead of Binance's; the Binance key's last test failed" })
    // Disarmed, the arming is what refuses: health is read only for an order that could otherwise go.
    await service.setSessionArmed(false)
    expect((await service.canPlaceLiveOrder(5)).reason).toBe('Live trading is not armed for this session')
  })

  it('never refuses a close for it', async () => {
    const service = await freshService()
    state.unhealthy = ['market data stale 95 s and REST has failed 3 reads running']
    expect(await service.canCloseLivePosition()).toEqual({ allowed: true, reason: null })
    expect((await service.canPlaceLiveOrder(5)).allowed).toBe(false)
  })

  it('lets an order through again once the exchange is healthy', async () => {
    const service = await freshService()
    state.unhealthy = ['REST has taken over 5 s 3 reads running']
    expect((await service.canPlaceLiveOrder(5)).allowed).toBe(false)
    state.unhealthy = []
    expect(await service.canPlaceLiveOrder(5)).toEqual({ allowed: true, reason: null })
  })
})

describe('the daily loss limit, told', () => {
  it('tells once when it disarms an armed session, and not again while it stays disarmed', async () => {
    told.length = 0
    const service = await freshService()
    state.realizedPnlToday = -100
    await service.checkLossLimitAndAutoDisarm()
    expect((await service.getLiveTradingStatus()).sessionArmed).toBe(false)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ title: 'Live trading disarmed: the daily loss limit', extra: { kind: 'CIRCUIT_BREAKER', thread: 'live-loss' } })
    expect(told[0].body).toContain('-100.00')
    await service.checkLossLimitAndAutoDisarm()
    expect(told).toHaveLength(1)
  })
})
