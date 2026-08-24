import { describe, it, expect } from 'vitest'
import { simulateTwap, simulateOrder, simulatePosition, simulateGrid, twapNumOrders, buildGridLevels } from '../src/executors/engine'
import { FEE_RATE } from '../shared/fees'
import type { Candle, TwapExecutorParams, OrderExecutorParams, PositionExecutorParams, GridExecutorParams } from '../shared/ipc'

const c = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 0 })

describe('simulateTwap', () => {
  const params: TwapExecutorParams = { side: 'buy', totalAmountQuote: 1000, totalDurationSec: 300, orderIntervalSec: 100 }

  it('derives slice count from duration / interval', () => {
    expect(twapNumOrders(params)).toBe(3)
    expect(twapNumOrders({ ...params, totalDurationSec: 50 })).toBe(1) // never below one
  })

  it('splits the notional evenly across slices', () => {
    const s = simulateTwap([c(0, 10, 10, 10, 10)], params, 0)
    expect(s.numOrders).toBe(3)
    expect(s.amountPerOrder).toBeCloseTo(1000 / 3, 9)
  })

  it('reports partial progress before every slice is due', () => {
    const s = simulateTwap([c(0, 10, 10, 10, 10)], params, 0)
    expect(s.fills).toHaveLength(1)
    expect(s.progressPct).toBeCloseTo(100 / 3, 6)
    expect(s.done).toBe(false)
  })

  it('completes once every slice time has passed and averages by VWAP', () => {
    const s = simulateTwap([c(0, 10, 10, 10, 10), c(100, 20, 20, 20, 20), c(200, 40, 40, 40, 40)], params, 0)
    expect(s.done).toBe(true)
    expect(s.fills).toHaveLength(3)
    const per = 1000 / 3
    const qty = per / 10 + per / 20 + per / 40
    expect(s.vwap).toBeCloseTo(1000 / qty, 6)
    // VWAP must be below the arithmetic mean of 10/20/40, since equal *quote* buys more when cheap
    expect(s.vwap!).toBeLessThan((10 + 20 + 40) / 3)
  })

  it('has no VWAP before any slice fills', () => {
    expect(simulateTwap([], params, 0).vwap).toBeNull()
  })
})

describe('simulateOrder', () => {
  it('fills a market order at the first open', () => {
    const s = simulateOrder([c(1, 42, 50, 40, 45)], { side: 'buy', amountQuote: 100, executionStrategy: 'market', limitPrice: null })
    expect(s.status).toBe('filled')
    expect(s.fillPrice).toBe(42)
  })

  it('leaves a limit order pending until price touches it', () => {
    const p: OrderExecutorParams = { side: 'buy', amountQuote: 100, executionStrategy: 'limit', limitPrice: 30 }
    expect(simulateOrder([c(1, 42, 50, 40, 45)], p).status).toBe('pending')
    const s = simulateOrder([c(1, 42, 50, 40, 45), c(2, 40, 41, 29, 31)], p)
    expect(s.status).toBe('filled')
    expect(s.fillPrice).toBe(30)
    expect(s.filledAt).toBe(2)
  })

  it('stays pending when a limit order has no price', () => {
    expect(simulateOrder([c(1, 42, 50, 40, 45)], { side: 'buy', amountQuote: 100, executionStrategy: 'limit', limitPrice: null }).status).toBe('pending')
  })

  it('returns pending with no candles at all', () => {
    expect(simulateOrder([], { side: 'buy', amountQuote: 100, executionStrategy: 'market', limitPrice: null }).status).toBe('pending')
  })
})

describe('simulatePosition barriers', () => {
  const p: PositionExecutorParams = {
    side: 'buy', entryPrice: null, amountQuote: 1000,
    takeProfitPct: null, stopLossPct: null, timeLimitSec: null, trailingStop: null
  }

  it('enters at market on the first candle when no entry price is set', () => {
    const s = simulatePosition([c(1, 100, 101, 99, 100)], p)
    expect(s.status).toBe('open')
    expect(s.entryPrice).toBe(100)
  })

  it('waits for a touch when an entry price is set', () => {
    const s = simulatePosition([c(1, 100, 101, 99, 100)], { ...p, entryPrice: 90 })
    expect(s.status).toBe('pending')
  })

  it('exits on a time limit with the reason recorded', () => {
    const s = simulatePosition([c(1, 100, 101, 99, 100), c(500, 100, 101, 99, 100)], { ...p, timeLimitSec: 10 })
    expect(s.status).toBe('closed')
    expect(s.exitReason).toBe('time_limit')
  })

  it('only trails after the activation threshold is cleared', () => {
    const trailing: PositionExecutorParams = { ...p, trailingStop: { activationPct: 10, trailPct: 5 } }
    // Rises to 105 (below the 110 activation) then falls back -- must NOT have trailed out.
    const notActivated = simulatePosition([c(1, 100, 101, 99, 100), c(2, 100, 105, 99, 100)], trailing)
    expect(notActivated.status).toBe('open')
    // Rises past 110, then drops more than 5% off the peak -> trailing stop fires.
    const activated = simulatePosition([c(1, 100, 101, 99, 100), c(2, 100, 120, 99, 118), c(3, 118, 118, 100, 101)], trailing)
    expect(activated.status).toBe('closed')
    expect(activated.exitReason).toBe('trailing_stop')
  })
})

describe('grid level construction and cycling', () => {
  const params: GridExecutorParams = {
    side: 'buy', startPrice: 90, endPrice: 110, totalAmountQuote: 1000,
    maxOpenOrders: 10, levelSpreadPct: 2, takeProfitPct: 5, limitPrice: null
  }

  it('spans the configured range', () => {
    const levels = buildGridLevels(params)
    expect(levels[0]).toBeCloseTo(90, 9)
    expect(levels[levels.length - 1]).toBeCloseTo(110, 9)
    expect(levels.length).toBeGreaterThan(2)
  })

  it('handles an inverted or degenerate range without throwing', () => {
    expect(buildGridLevels({ ...params, startPrice: 110, endPrice: 90 })[0]).toBeCloseTo(90, 9)
    expect(buildGridLevels({ ...params, startPrice: 100, endPrice: 100 })).toHaveLength(2)
  })

  it('caps concurrently open levels at maxOpenOrders', () => {
    const capped = simulateGrid([c(1, 110, 110, 90, 95)], { ...params, maxOpenOrders: 2 })
    expect(capped.filledCount).toBe(2)
  })

  it('books profit and frees a level to refill after take-profit', () => {
    const s = simulateGrid([c(1, 110, 110, 90, 95), c(2, 95, 130, 95, 128)], { ...params, maxOpenOrders: 1 })
    expect(s.closedLevels).toBeGreaterThanOrEqual(1)
    expect(s.realizedPnl).toBeGreaterThan(0)
  })

  it('takes the round-trip fee out of a take-profit close', () => {
    // Asserting only "profit" let the fee be dropped entirely from this branch without any
    // test noticing -- and take-profit is how a grid normally makes money, so every grid
    // would have reported inflated realized P&L.
    //
    // The exact figure needs no reference to which level filled: gross is
    // qty * (target - entry) where qty = amountPerLevel / entry and target = entry * (1 + tp),
    // so entry cancels and gross is amountPerLevel * tp. The fee is charged on both sides of
    // the same round trip, giving amountPerLevel * (2 + tp) * FEE_RATE.
    const single = { ...params, maxOpenOrders: 1 }
    const amountPerLevel = single.totalAmountQuote / buildGridLevels(single).length
    const tp = single.takeProfitPct / 100

    const s = simulateGrid([c(1, 110, 110, 90, 95), c(2, 95, 130, 95, 128)], single)
    expect(s.closedLevels).toBe(1)
    expect(s.realizedPnl).toBeCloseTo(amountPerLevel * tp - amountPerLevel * (2 + tp) * FEE_RATE, 9)
  })
})
