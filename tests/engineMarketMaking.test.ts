import { describe, it, expect } from 'vitest'
import { simulateMarketMaking } from '../src/executors/engine'
import type { Candle, MarketMakingExecutorParams } from '../shared/ipc'

const c = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 0 })

const params: MarketMakingExecutorParams = {
  side: 'both', spreadPct: 1, orderRefreshSec: 60, orderAmountQuote: 100,
  inventoryTargetPct: null, inventorySkewIntensity: 0.3
}

describe('simulateMarketMaking', () => {
  it('quotes a bid below and an ask above the mid at half the spread each side', () => {
    const s = simulateMarketMaking([c(0, 100, 100, 100, 100)], params)
    expect(s.bidPrice).toBeCloseTo(100 * (1 - 0.005), 9)
    expect(s.askPrice).toBeCloseTo(100 * (1 + 0.005), 9)
  })

  it('accumulates inventory when only the bid is hit', () => {
    // Low dips to the bid, high never reaches the ask.
    const s = simulateMarketMaking([c(0, 100, 100, 99, 100)], params)
    expect(s.filledBuys).toBe(1)
    expect(s.filledSells).toBe(0)
    expect(s.inventoryBaseQty).toBeGreaterThan(0)
    expect(s.avgCost).toBeCloseTo(s.bidPrice!, 9)
  })

  it('books realized profit on a round trip', () => {
    // Candle 1 fills the bid at 99.5. Candle 2 requotes off its own close (100.6), so the ask sits
    // at ~101.10 -- the candle's high must clear that, not merely exceed the original ask.
    const s = simulateMarketMaking([c(0, 100, 100, 99, 100), c(100, 100, 102, 100.5, 100.6)], params)
    expect(s.filledBuys).toBe(1)
    expect(s.filledSells).toBe(1)
    expect(s.realizedPnl).toBeGreaterThan(0)
  })

  it('leaves the residual inventory a requote creates, rather than forcing flat', () => {
    // Standing quantity is orderAmountQuote / price, recomputed at every refresh -- so a sell
    // priced higher than the buy covers slightly less base than was bought, and a little long
    // inventory legitimately remains. Asserting "returns to flat" here would be wrong.
    const s = simulateMarketMaking([c(0, 100, 100, 99, 100), c(100, 100, 102, 100.5, 100.6)], params)
    expect(s.inventoryBaseQty).toBeGreaterThan(0)
    expect(s.inventoryBaseQty).toBeLessThan(100 / 99.5 - 100 / 100.6 + 1e-9)
  })

  it('respects a one-sided mandate', () => {
    const buyOnly = simulateMarketMaking([c(0, 100, 101, 99, 100)], { ...params, side: 'buy' })
    expect(buyOnly.filledSells).toBe(0)
    const sellOnly = simulateMarketMaking([c(0, 100, 101, 99, 100)], { ...params, side: 'sell' })
    expect(sellOnly.filledBuys).toBe(0)
  })

  it('goes short when only the ask is hit, tracking a negative inventory', () => {
    const s = simulateMarketMaking([c(0, 100, 101, 100, 100)], { ...params, side: 'sell' })
    expect(s.inventoryBaseQty).toBeLessThan(0)
    expect(s.avgCost).toBeCloseTo(s.askPrice!, 9)
  })

  it('skews quotes down when long, to bias back toward the inventory target', () => {
    const skewed: MarketMakingExecutorParams = { ...params, inventoryTargetPct: 0, inventorySkewIntensity: 1 }
    const path = [c(0, 100, 100, 99, 100), c(100, 100, 100, 100, 100)]
    const withSkew = simulateMarketMaking(path, skewed)
    const noSkew = simulateMarketMaking(path, params)
    // Long inventory from the first fill pulls the requoted mid downward.
    expect(withSkew.bidPrice!).toBeLessThan(noSkew.bidPrice!)
    expect(withSkew.askPrice!).toBeLessThan(noSkew.askPrice!)
  })

  it('is flat and quiet with no candles', () => {
    const s = simulateMarketMaking([], params)
    expect(s.inventoryBaseQty).toBe(0)
    expect(s.avgCost).toBeNull()
    expect(s.realizedPnl).toBe(0)
  })
})

describe('simulateMarketMaking — a quote is consumed when it fills', () => {
  // A limit order fills once and is then off the book until it is requoted. The sim used to
  // re-fill the same standing order on every candle whose range still crossed it, so the number
  // of reported trades was bounded by candle count rather than by how often the strategy
  // actually quoted — and every phantom fill paid a real round-trip fee.
  const MM_PARAMS: MarketMakingExecutorParams = {
    side: 'both',
    spreadPct: 1,
    orderRefreshSec: 300,
    orderAmountQuote: 100,
    inventoryTargetPct: null,
    inventorySkewIntensity: 0
  }

  /** 1-minute candles whose range always crosses both sides of a 1% spread around 100. */
  function alwaysCrossing(count: number): Candle[] {
    return Array.from({ length: count }, (_, i) => ({
      time: 1_700_000_000 + i * 60,
      open: 100,
      high: 105,
      low: 95,
      close: 100,
      volume: 1
    }))
  }

  it('fills each side at most once per refresh cycle', () => {
    // 5 one-minute candles inside a single 300s refresh window: one quote, one fill per side.
    const state = simulateMarketMaking(alwaysCrossing(5), MM_PARAMS)

    expect(state.filledBuys).toBe(1)
    expect(state.filledSells).toBe(1)
  })

  it('quotes again after the refresh interval elapses', () => {
    // 15 candles spans three 300s windows, so three quotes and three fills per side.
    const state = simulateMarketMaking(alwaysCrossing(15), MM_PARAMS)

    expect(state.filledBuys).toBe(3)
    expect(state.filledSells).toBe(3)
  })

  it('never reports more fills than the strategy placed orders', () => {
    const candleCount = 240
    const state = simulateMarketMaking(alwaysCrossing(candleCount), MM_PARAMS)
    // 240 one-minute candles / 300s refresh = 48 quoting cycles.
    const cycles = Math.ceil((candleCount * 60) / MM_PARAMS.orderRefreshSec)

    expect(state.filledBuys).toBeLessThanOrEqual(cycles)
    expect(state.filledSells).toBeLessThanOrEqual(cycles)
    // Before the fix this was 240 per side — one per candle.
    expect(state.filledBuys).toBeLessThan(candleCount)
  })

  it('charges fees only on fills that really happened', () => {
    // Buys and sells alternate around a flat mid at a fixed spread, so each completed round trip
    // earns the spread minus its fees. Phantom re-fills used to add pure fee drag on top.
    const withCap = simulateMarketMaking(alwaysCrossing(60), MM_PARAMS)
    const perCycle = simulateMarketMaking(alwaysCrossing(5), MM_PARAMS)

    expect(withCap.filledBuys).toBe(12)
    // Scaling is linear in cycles, not in candles.
    expect(withCap.filledBuys).toBe(perCycle.filledBuys * 12)
  })
})
