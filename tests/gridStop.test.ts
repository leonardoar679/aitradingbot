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
