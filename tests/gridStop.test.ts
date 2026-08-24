import { describe, it, expect } from 'vitest'
import { simulateGrid } from '../src/executors/engine'
import type { Candle, GridExecutorParams } from '../shared/ipc'

const candle = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time, open, high, low, close, volume: 0
})

const params: GridExecutorParams = {
  side: 'buy', startPrice: 90, endPrice: 110, totalAmountQuote: 1000,
  maxOpenOrders: 10, levelSpreadPct: 2, takeProfitPct: 50, limitPrice: 85
}

// Fills levels near 95 and 91, crashes through the 85 stop, then recovers back into range.
const path = [
  candle(1, 100, 101, 99, 100),
  candle(2, 100, 100, 94, 95),
  candle(3, 95, 96, 90, 91),
  candle(4, 91, 92, 84, 85),
  candle(5, 85, 97, 85, 96)
]

describe('grid stop price', () => {
  it('closes every filled level and records when it fired', () => {
    const state = simulateGrid(path, params)
    expect(state.stoppedAt).toBe(4)
    expect(state.filledCount).toBe(0)
    expect(state.closedLevels).toBeGreaterThanOrEqual(2)
  })

  it('freezes the grid permanently, even when price re-enters the range', () => {
    const state = simulateGrid(path, params)
    expect(state.levels.some((l) => l.status === 'filled')).toBe(false)
  })

  it('does nothing when the stop is unset', () => {
    const state = simulateGrid(path, { ...params, limitPrice: null })
    expect(state.stoppedAt).toBeNull()
    expect(state.filledCount).toBeGreaterThan(0)
  })

  it('does nothing when the stop is never crossed', () => {
    const state = simulateGrid([candle(1, 100, 101, 99, 100), candle(2, 100, 100, 94, 95)], params)
    expect(state.stoppedAt).toBeNull()
  })
})

// tests/stopFills.test.ts already pins the BUY grid's stop fills, gap included. Everything below
// is the sell side, which nothing covered: the P&L sign, the trigger direction, and the gap
// adjustment are all behind an isBuy ternary, so buy-only tests leave all three unguarded.
//
// One level, so the numbers are checkable by hand: levels are [100, 105, 110] and each carries
// 300/3 = 100 quote. The candle fills level 110, so qty = 100/110.
const sell: GridExecutorParams = {
  side: 'sell', startPrice: 100, endPrice: 110, totalAmountQuote: 300,
  maxOpenOrders: 10, levelSpreadPct: 5, takeProfitPct: 50, limitPrice: 115
}

describe('grid stop price on a sell grid', () => {
  it('triggers upward, and loses money doing it', () => {
    // A sell grid is stopped out by a RISE, so the trigger reads candle.high, not candle.low.
    const state = simulateGrid([
      candle(1, 109, 111, 108, 110),
      candle(2, 112, 116, 111, 115)
    ], sell)

    expect(state.stoppedAt).toBe(2)
    expect(state.filledCount).toBe(0)
    // gross (100/110) x (110 - 115) = -4.545..., fee (100/110) x (110 + 115) x 0.001 = 0.2045...
    expect(state.realizedPnl).toBeCloseTo(-4.75, 6)
  })

  it('fills at the open when the candle gaps above the stop', () => {
    // Opens at 118, past the 115 stop -- 115 was never available, and for a short the gap is
    // upward. Reporting 115 here would understate the loss, same as it would for a long.
    const state = simulateGrid([
      candle(1, 109, 111, 108, 110),
      candle(2, 118, 119, 117, 118)
    ], sell)

    expect(state.realizedPnl).toBeCloseTo(-7.48, 6)
  })
})
