import { beforeEach, describe, expect, it } from 'vitest'
import type { Candle, ExecutorConfig } from '../shared/ipc'
import { computeExecutorPosition } from '../src/executors/computeSnapshot'

// computeExecutorPosition is the only thing that tells the rest of the app what an executor is
// currently holding: the Portfolio values it, and the Inventory handover decides from it whether
// a stopped executor's position can be kept at all. Nothing exercised it directly -- the tests
// that use it mock it -- so the wiring between the simulation's state and the shape those two
// callers read had no coverage in either direction.

const T = 1_700_000_000
const candle = (i: number, open: number, high: number, low: number, close: number): Candle => ({
  time: T + i * 60, open, high, low, close, volume: 1
})

// Flat, so nothing exits and nothing is liquidated: the position is simply open.
let series: Candle[] = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100)]

beforeEach(() => {
  series = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100)]
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { market: { fetchHistoricalRange: async () => ({ candles: series }) } }
  }
})

const position = (params: Record<string, unknown>): ExecutorConfig =>
  ({
    id: 'e1', name: 'E', type: 'position', exchange: 'binance', symbol: 'BTCUSDT',
    baseAsset: 'BTC', quoteAsset: 'USDT', createdAt: T, status: 'running', stoppedAt: null,
    keepPosition: true, mode: 'paper', liveOrder: null, pendingLiveOrderIds: [],
    liveWatcherId: null, liveExitResult: null, liveTwapRunId: null, liveTwapResult: null,
    params: {
      side: 'buy', entryPrice: null, amountQuote: 1_000, takeProfitPct: null,
      stopLossPct: null, timeLimitSec: null, trailingStop: null, ...params
    }
  }) as unknown as ExecutorConfig

describe('computeExecutorPosition on a Position', () => {
  it('carries the leverage out to whoever is going to mark it', async () => {
    // The whole reason this field exists. A caller that marks the position to market without it
    // reports a tenth of what a 10x position has done -- see computePortfolioSnapshot.
    expect(await computeExecutorPosition(position({ leverage: 10 }))).toEqual({
      side: 'buy',
      entryPrice: 100,
      amountQuote: 1_000,
      leverage: 10
    })
  })

  it('reports the margin as the amount, not the notional', async () => {
    // 1,000 at 10x controls 10,000 of BTC, but 1,000 is the money that exists and can be lost.
    // Reporting the notional would show the holder an asset they never bought.
    const open = await computeExecutorPosition(position({ leverage: 10 }))

    expect(open?.amountQuote).toBe(1_000)
  })

  it('reports 1x for a position that has no leverage recorded', async () => {
    // Every Position saved before leverage existed. Reading this as anything but 1 would restate
    // an old spot position as a leveraged one.
    const open = await computeExecutorPosition(position({}))

    expect(open?.leverage).toBe(1)
  })

  it('reports nothing once the position has been liquidated', async () => {
    // Closed is closed: there is nothing left to value or to hand over, and offering a row here
    // would put a position back on the Portfolio that the exchange had already taken.
    series = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 80, 85)]

    expect(await computeExecutorPosition(position({ leverage: 10 }))).toBeNull()
  })
})
