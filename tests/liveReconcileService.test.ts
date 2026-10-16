import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveOrder, LivePosition } from '../shared/ipc'
import type { OpenOrderOnExchange } from '../shared/reconcileLive'

// The reconciliation (electron/services/liveReconcileService.ts; the V5 document, §102), with the
// exchange, the credentials, the ledgers, the one resolution function and the notices faked: what
// it tells of a resting order the ledger does not know, what it does with a ledger order the
// exchange no longer rests, what it tells of a holding the account does not back, and what it
// never does: rewrite a ledger.

const rig = vi.hoisted(() => ({
  keyStored: true,
  onExchange: [] as OpenOrderOnExchange[],
  ledger: [] as LiveOrder[],
  positions: [] as LivePosition[],
  balances: { rows: [] as { asset: string; free: number; locked: number }[], unreadable: [] as string[], fail: false },
  queried: [] as number[],
  queryAnswer: { orderId: 778, status: 'CANCELED', filledQty: 0, avgFillPrice: 0, cummulativeQuoteQty: 0, commissions: {} },
  queryFails: false,
  resolved: [] as { order: LiveOrder; result: unknown }[],
  resolution: null as null | { executorId: string; liveOrderId: string; liveOrder: unknown; status: string },
  queued: [] as unknown[],
  fetches: 0,
  /** A second, Bitget key beside Binance's: on a Classic account, or a unified one (16 October 2026). */
  bitgetKey: null as null | 'classic' | 'uta',
  balanceReads: [] as string[],
  bitgetOrderReads: 0
}))

const told = vi.hoisted(() => [] as { title: string; body: string; extra: Record<string, unknown> }[])

vi.mock('../electron/services/credentialsService', () => ({
  listCredentialStatus: async () => [
    { exchange: 'binance', configured: rig.keyStored, lastTestOk: true },
    ...(rig.bitgetKey === null ? [] : [{ exchange: 'bitget', slot: 'real', configured: true, lastTestOk: true, accountType: rig.bitgetKey }])
  ],
  getDecryptedCredential: async () => ({ apiKey: 'key', apiSecret: 'secret', passphrase: 'pass' }),
  readLiveBalances: async (exchange: string, _force: boolean, slot?: string) => {
    rig.balanceReads.push(`${exchange}:${slot ?? 'real'}`)
    if (exchange === 'bitget') return { exchange: 'bitget', rows: [], unreadable: [], fetchedAt: Date.now() }
    if (rig.balances.fail) throw new Error('Binance account request failed: 503')
    return { exchange: 'binance', rows: rig.balances.rows, unreadable: rig.balances.unreadable, fetchedAt: Date.now() }
  }
}))
// Bitget's real account refuses every unified order read as a Classic account would: whether the
// reconciliation asks at all is the point.
vi.mock('../electron/services/exchanges/bitgetTrading', () => ({
  fetchBitgetOpenOrders: async () => {
    rig.bitgetOrderReads += 1
    throw new Error('Bitget open orders failed: 40084 You are in Classic Account mode, and the Unified Account API is not supported at this time')
  },
  queryBitgetOrder: async () => {
    rig.bitgetOrderReads += 1
    throw new Error('Bitget order failed: 40084 You are in Classic Account mode, and the Unified Account API is not supported at this time')
  }
}))
vi.mock('../electron/services/exchanges/binanceTrading', () => ({
  fetchOpenOrders: async () => {
    rig.fetches += 1
    await new Promise((r) => setTimeout(r, 5))
    return rig.onExchange
  },
  queryOrder: async (_k: string, _s: string, _symbol: string, orderId: number) => {
    rig.queried.push(orderId)
    if (rig.queryFails) throw new Error('Binance order request failed: 503')
    return rig.queryAnswer
  }
}))
vi.mock('../electron/services/liveExecutionService', () => ({
  resolveOrderFromExchange: async (order: LiveOrder, result: unknown) => {
    rig.resolved.push({ order, result })
    return rig.resolution
  }
}))
vi.mock('../electron/services/liveOrdersService', () => ({ listOpenLiveOrders: async () => rig.ledger }))
vi.mock('../electron/services/livePositionsService', () => ({ listOpenLivePositions: async () => rig.positions }))
vi.mock('../electron/services/liveUserStreamService', () => ({ queueStreamResolution: (resolution: unknown) => void rig.queued.push(resolution) }))
// A notice the main process builds in the person's language (V6 Stage 14) is handed as a builder:
// built here in English, as the language of a profile that chose none.
vi.mock('../electron/services/noticeService', async () => {
  const { ENGLISH } = await import('../shared/i18n/translate')
  type Told = { title: string; body: string; extra: Record<string, unknown> }
  return {
    tell: (notice: Told | ((i18n: typeof ENGLISH) => Told)) => void told.push(typeof notice === 'function' ? notice(ENGLISH) : notice)
  }
})

import { getReconciliationState, reconcileOnce, resetLiveReconcile } from '../electron/services/liveReconcileService'

const T = Math.floor(Date.parse('2026-10-08T12:00:00Z') / 1000)

const ledgerOrder = (orderId: number): LiveOrder => ({
  id: `lo${orderId}`,
  executorId: 'ex1',
  exchange: 'binance',
  symbol: 'ETHUSDT',
  baseAsset: 'ETH',
  quoteAsset: 'USDT',
  side: 'buy',
  orderId,
  limitPrice: 4000,
  quantity: 1,
  status: 'open',
  filledQty: 0,
  avgFillPrice: null,
  placedAt: T - 600,
  resolvedAt: null
})

const resting = (orderId: number, side: 'buy' | 'sell' = 'sell'): OpenOrderOnExchange => ({ orderId, symbol: 'ETHUSDT', side, status: 'NEW', origQty: 0.05, executedQty: 0, price: 4000, placedAt: T })

const position = (asset: string, qty: number): LivePosition => ({
  id: `lp-${asset}`,
  exchange: 'binance',
  symbol: `${asset}USDT`,
  baseAsset: asset,
  quoteAsset: 'USDT',
  qty,
  avgCost: 4000,
  openedAt: T - 3600,
  closedAt: null,
  exitPrice: null,
  realizedPnl: null
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T * 1000)
  resetLiveReconcile()
  rig.keyStored = true
  rig.onExchange = []
  rig.ledger = []
  rig.positions = []
  rig.balances = { rows: [], unreadable: [], fail: false }
  rig.queried = []
  rig.queryFails = false
  rig.resolved = []
  rig.resolution = null
  rig.queued = []
  rig.fetches = 0
  rig.bitgetKey = null
  rig.balanceReads = []
  rig.bitgetOrderReads = 0
  told.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the reconciliation', () => {
  it('has nothing to check without a key, and asks the exchange nothing', async () => {
    rig.keyStored = false
    expect(getReconciliationState().at).toBeNull()
    const readout = await reconcileOnce()
    expect(readout).toMatchObject({ at: T, keyStored: false, unknownOrders: [], discrepancies: [], error: null })
    expect(rig.fetches).toBe(0)
    expect(told).toEqual([])
  })

  it('tells a resting order the ledger does not know, HIGH on its own thread, and not one it knows', async () => {
    rig.onExchange = [resting(777), resting(778, 'buy')]
    rig.ledger = [ledgerOrder(778)]
    const readout = await reconcileOnce()
    expect(readout.unknownOrders).toEqual([resting(777)])
    expect(told).toEqual([
      {
        title: 'A resting order this app does not know',
        body: 'ETHUSDT: a SELL of 0.05 at 4000 is resting on Binance (order 777, placed 12:00 UTC), and this app has no record of it. Nothing was changed: the record is yours to put right.',
        extra: { kind: 'RECONCILIATION', thread: 'reconcile:order:ETHUSDT:777', severity: 'high', threadSeconds: 4 * 3600 }
      }
    ])
    // The known order rests on both sides: nothing to ask, nothing to resolve.
    expect(rig.queried).toEqual([])
    expect(rig.resolved).toEqual([])
    expect(readout).toMatchObject({ keyStored: true, resolvedByCheck: 0, error: null })
  })

  it('asks about a ledger order the exchange no longer rests and resolves it as the poll does, handing the resolution on', async () => {
    rig.ledger = [ledgerOrder(778), ledgerOrder(779)]
    rig.onExchange = [resting(779, 'buy')]
    rig.resolution = { executorId: 'ex1', liveOrderId: 'lo778', liveOrder: {}, status: 'cancelled' }
    const readout = await reconcileOnce()
    expect(rig.queried).toEqual([778])
    expect(rig.resolved).toEqual([{ order: rig.ledger[0], result: rig.queryAnswer }])
    expect(rig.queued).toEqual([rig.resolution])
    expect(readout.resolvedByCheck).toBe(1)
    expect(told).toEqual([])

    // Asked again a minute later with the order still on the ledger (the resolution function found
    // it already resolved and answered null): nothing is queued and the count stands.
    rig.resolution = null
    expect((await reconcileOnce()).resolvedByCheck).toBe(1)
    expect(rig.queued).toHaveLength(1)
  })

  it('keeps looking when one order cannot be asked about', async () => {
    rig.ledger = [ledgerOrder(778)]
    rig.queryFails = true
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const readout = await reconcileOnce()
    spy.mockRestore()
    expect(rig.resolved).toEqual([])
    expect(readout).toMatchObject({ at: T, error: null, resolvedByCheck: 0 })
  })

  it('tells a holding the account does not back, on the asset\'s thread, and never rewrites the ledger', async () => {
    rig.positions = [position('ETH', 1), position('SOL', 10)]
    rig.balances.rows = [
      { asset: 'ETH', free: 0.4, locked: 0 },
      { asset: 'SOL', free: 4, locked: 6 }
    ]
    const readout = await reconcileOnce()
    expect(readout.discrepancies).toEqual([{ asset: 'ETH', ledgerQty: 1, exchangeQty: 0.4, shortfall: 0.6, symbols: ['ETHUSDT'] }])
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe('A holding the account does not back')
    expect(told[0].body).toMatch(/ETH/)
    expect(told[0].body).toMatch(/Nothing was changed: the record is yours to put right\.$/)
    expect(told[0].extra).toEqual({ kind: 'RECONCILIATION', thread: 'reconcile:asset:ETH', severity: 'high', threadSeconds: 4 * 3600 })
    // The position is read, never written: the service imports no writer.
    expect(rig.positions[0].qty).toBe(1)
  })

  it('keeps a balance that could not be read as the error, telling nothing of it', async () => {
    rig.positions = [position('ETH', 1)]
    rig.balances.fail = true
    const readout = await reconcileOnce()
    expect(readout).toMatchObject({ at: T, keyStored: true, error: 'Binance account request failed: 503', discrepancies: [] })
    expect(told).toEqual([])
    rig.balances.fail = false
    rig.balances.rows = [{ asset: 'ETH', free: 1, locked: 0 }]
    expect(await reconcileOnce()).toMatchObject({ error: null, discrepancies: [] })
  })

  it('reports an asset it could not read as unchecked rather than as agreeing', async () => {
    rig.positions = [position('ETH', 1)]
    rig.balances.rows = []
    rig.balances.unreadable = ['ETH']
    const readout = await reconcileOnce()
    expect(readout.unchecked).toEqual(['ETH'])
    expect(readout.discrepancies).toEqual([])
    expect(told).toEqual([])
  })

  it('looks once at a time', async () => {
    const [a, b] = await Promise.all([reconcileOnce(), reconcileOnce()])
    expect(rig.fetches).toBe(1)
    expect(a.at).toBe(T)
    expect(b).toEqual(a.at === null ? b : expect.objectContaining({}))
  })

  it("asks a key on Bitget's Classic account no unified order read, and still checks its balances against the positions, beside Binance's findings (16 October 2026)", async () => {
    rig.bitgetKey = 'classic'
    rig.onExchange = [resting(777)]
    // A ledger order on Bitget is not asked about either: no unified read answers on a Classic account.
    rig.ledger = [{ ...ledgerOrder(5), exchange: 'bitget', symbol: 'BTCUSDT', baseAsset: 'BTC' }]
    const readout = await reconcileOnce()
    expect(rig.bitgetOrderReads).toBe(0)
    expect(rig.queried).toEqual([])
    expect(rig.balanceReads).toEqual(['binance:real', 'bitget:real'])
    expect(readout).toMatchObject({ keyStored: true, error: null, unknownOrders: [resting(777)], discrepancies: [], resolvedByCheck: 0 })
    expect(told).toHaveLength(1)
  })

  it("keeps one venue's failure its own: the other venue's findings reach the state, and the failure is the error", async () => {
    rig.bitgetKey = 'uta'
    rig.onExchange = [resting(777)]
    const readout = await reconcileOnce()
    expect(rig.bitgetOrderReads).toBe(1)
    expect(rig.balanceReads).toEqual(['binance:real'])
    expect(readout.unknownOrders).toEqual([resting(777)])
    expect(readout.error).toBe('Bitget open orders failed: 40084 You are in Classic Account mode, and the Unified Account API is not supported at this time')
    expect(readout.keyStored).toBe(true)
  })
})
