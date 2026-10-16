import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// THE TWO BOOKS (electron/services/livePositionsService.ts, liveOrdersService.ts,
// livePositionWatchersService.ts; V7.1 Stage 8): the real account's ledgers and the demo book's are
// files of their own, read and written by the book named, the real one by default -- so a demo fill
// never reaches the ledger the loss gate reads, and a demo watcher never guards a real position.

const dir = mkdtempSync(join(tmpdir(), 'live-books-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))
vi.mock('../electron/services/marketService', () => ({ fetchTicker24h: async () => ({ lastPrice: 100 }) }))
vi.mock('../electron/services/liveExecutionService', () => ({ executeLiveClose: async () => undefined, cancelSiblingLiveOrders: async () => undefined }))
vi.mock('../electron/services/noticeService', () => ({ tell: () => undefined }))

const { getRealizedPnlToday, listClosedLivePositions, listOpenLivePositions, recordLiveFill } = await import('../electron/services/livePositionsService')
const { createLiveOrder, getLiveOrder, listOpenLiveOrders, resolveLiveOrder } = await import('../electron/services/liveOrdersService')
const { createWatcher, deactivateWatcher, drainResolvedWatcherEvents, listActiveWatchers } = await import('../electron/services/livePositionWatchersService')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the position ledgers', () => {
  it('keep a demo fill in demoPositions.json, apart from the real ledger and the loss gate', async () => {
    const demo = await recordLiveFill('bitget', 'BTCUSDT', 'BTC', 'USDT', 'buy', 0.001, 80000, {}, undefined, 'demo')
    expect(demo).toMatchObject({ exchange: 'bitget', symbol: 'BTCUSDT', qty: 0.001, avgCost: 80000, closedAt: null })
    expect(await listOpenLivePositions('demo')).toHaveLength(1)
    expect(await listOpenLivePositions()).toEqual([])
    expect(existsSync(join(dir, 'demoPositions.json'))).toBe(true)
    expect(existsSync(join(dir, 'livePositions.json'))).toBe(false)
    // Closed at a loss on the demo book: nothing of it in the real day's realized total.
    await recordLiveFill('bitget', 'BTCUSDT', 'BTC', 'USDT', 'sell', 0.001, 79000, {}, undefined, 'demo')
    expect(await listOpenLivePositions('demo')).toEqual([])
    expect((await listClosedLivePositions('demo'))[0].realizedPnl).toBeLessThan(0)
    expect(await getRealizedPnlToday()).toBe(0)
    const real = await recordLiveFill('binance', 'ETHUSDT', 'ETH', 'USDT', 'buy', 1, 2000)
    expect(real).toMatchObject({ exchange: 'binance', qty: 1 })
    expect(await listOpenLivePositions()).toHaveLength(1)
    expect(await listOpenLivePositions('demo')).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'livePositions.json'), 'utf-8')).positions).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'demoPositions.json'), 'utf-8')).positions).toHaveLength(1)
  })

  it("name the book in a fill's refusal", async () => {
    await expect(recordLiveFill('bitget', 'BTCUSDT', 'BTC', 'USDT', 'buy', Number.NaN, 1, {}, undefined, 'demo')).rejects.toThrow("this app's demo ledger does not include it")
    await expect(recordLiveFill('binance', 'BTCUSDT', 'BTC', 'USDT', 'buy', Number.NaN, 1)).rejects.toThrow("this app's live ledger does not include it")
  })
})

describe('the order ledgers', () => {
  it('keep demo orders in demoOrders.json with their string ids, resolved by their own book', async () => {
    const demo = await createLiveOrder({ executorId: 'e1', exchange: 'bitget', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', side: 'buy', orderId: '1494849323637915648', limitPrice: 80000, quantity: 0.001 }, 'demo')
    expect(demo.orderId).toBe('1494849323637915648')
    expect(await listOpenLiveOrders('demo')).toHaveLength(1)
    expect(await listOpenLiveOrders()).toEqual([])
    expect(await getLiveOrder(demo.id)).toBeNull()
    expect(await getLiveOrder(demo.id, 'demo')).not.toBeNull()
    expect(await resolveLiveOrder(demo.id, 'filled', 0.001, 80000)).toBeNull()
    expect((await resolveLiveOrder(demo.id, 'filled', 0.001, 80000, 'demo'))?.status).toBe('filled')
    expect(await listOpenLiveOrders('demo')).toEqual([])
    expect(existsSync(join(dir, 'demoOrders.json'))).toBe(true)
    expect(existsSync(join(dir, 'liveOrders.json'))).toBe(false)
  })
})

describe('the watchers', () => {
  it('guard each book on their own: a demo watcher on a pair is no conflict for a real one, and each is listed, stopped and drained by its book', async () => {
    const input = { executorId: 'e2', livePositionId: 'p', exchange: 'bitget' as const, symbol: 'BTCUSDT', entryPrice: 80000, takeProfitPct: 2, stopLossPct: 1, timeLimitSec: null, trailingStop: null }
    const demo = await createWatcher(input, 'demo')
    await expect(createWatcher(input, 'demo')).rejects.toThrow('Already watching a demo position on BTCUSDT — only one at a time is supported')
    const real = await createWatcher({ ...input, exchange: 'binance' })
    expect((await listActiveWatchers('demo')).map((w) => w.id)).toEqual([demo.id])
    expect((await listActiveWatchers()).map((w) => w.id)).toEqual([real.id])
    await deactivateWatcher(demo.id)
    expect(await listActiveWatchers('demo')).toHaveLength(1)
    await deactivateWatcher(demo.id, 'demo')
    expect(await listActiveWatchers('demo')).toEqual([])
    expect(await listActiveWatchers()).toHaveLength(1)
    expect(await drainResolvedWatcherEvents('demo')).toEqual([])
    expect(existsSync(join(dir, 'demoPositionWatchers.json'))).toBe(true)
    expect(existsSync(join(dir, 'livePositionWatchers.json'))).toBe(true)
  })
})
