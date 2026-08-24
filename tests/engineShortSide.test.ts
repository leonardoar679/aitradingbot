import { describe, expect, it } from 'vitest'
import { simulatePosition, simulateDca, simulateGrid } from '../src/executors/engine'
import type { Candle, DcaExecutorParams, GridExecutorParams, PositionExecutorParams } from '../shared/ipc'

// Every exit condition and both P&L formulas in simulatePosition and simulateDca sit behind an
// `isBuy ? ... : ...` ternary, and every existing test used a buy. Collapsing all 14 of those
// ternaries to their buy branch left the suite green, so nothing checked that a paper SHORT
// takes profit when price FALLS, stops out when it RISES, or earns the sign it earns.
//
// The convention (shared/fees.ts): a sell executor inverts the price move and still pays both
// legs. All figures below are hand-computed from an entry of 100 and amountQuote 100, so qty is
// exactly 1 and every expectation reads as gross-minus-fee.

const T = 1_700_000_000
const c = (i: number, open: number, high: number, low: number, close: number): Candle => ({
  time: T + i * 60, open, high, low, close, volume: 1
})

const short = (over: Partial<PositionExecutorParams>): PositionExecutorParams => ({
  side: 'sell', entryPrice: null, amountQuote: 100,
  takeProfitPct: null, stopLossPct: null, timeLimitSec: null, trailingStop: null,
  ...over
})

describe('simulatePosition on a short', () => {
  it('takes profit when price falls to the target', () => {
    // tp 5% below a 100 entry = 95, reached by the low.
    const state = simulatePosition([c(0, 100, 101, 99, 100), c(1, 98, 99, 94, 95)], short({ takeProfitPct: 5 }))

    expect(state.exitReason).toBe('take_profit')
    // The timestamp matters: reading the trigger as a buy (high >= 95) fires on candle 0, at the
    // very same price, so price alone cannot tell the two apart.
    expect(state.closedAt).toBe(T + 60)
    expect(state.exitPrice).toBe(95)
    // gross 1 x (100 - 95) = +5, fee (100 + 95) x 0.001 = 0.195.
    expect(state.realizedPnl).toBeCloseTo(4.805, 10)
  })

  it('stops out when price rises to the stop', () => {
    // sl 5% above a 100 entry = 105, reached by the high.
    const state = simulatePosition([c(0, 100, 101, 99, 100), c(1, 101, 106, 100, 105)], short({ stopLossPct: 5 }))

    expect(state.exitReason).toBe('stop_loss')
    expect(state.exitPrice).toBe(105)
    // gross 1 x (100 - 105) = -5, fee (100 + 105) x 0.001 = 0.205.
    expect(state.realizedPnl).toBeCloseTo(-5.205, 10)
  })

  it('fills at the open when the candle gaps UP through a short stop', () => {
    // The gap that hurts a short is upward. 105 was never available.
    const state = simulatePosition([c(0, 100, 101, 99, 100), c(1, 110, 112, 109, 111)], short({ stopLossPct: 5 }))

    expect(state.exitPrice).toBe(110)
    // gross 1 x (100 - 110) = -10, fee (100 + 110) x 0.001 = 0.21.
    expect(state.realizedPnl).toBeCloseTo(-10.21, 10)
  })

  it('trails the LOW, arms below the entry, and exits on a rise back', () => {
    const state = simulatePosition([
      c(0, 100, 101, 99, 100),      // entry 100; best price so far 99, not yet armed (needs <= 98)
      c(1, 97.5, 97.6, 97.0, 97.2), // best 97 arms it; trail sits at 97 x 1.01 = 97.97, high 97.6 misses
      c(2, 97.2, 98.5, 97.1, 98.4)  // high 98.5 crosses 97.97
    ], short({ trailingStop: { activationPct: 2, trailPct: 1 } }))

    expect(state.exitReason).toBe('trailing_stop')
    // Peak means best-for-the-position, so for a short it is the lowest low, not the highest high.
    expect(state.trailingPeakPrice).toBe(97)
    expect(state.closedAt).toBe(T + 120)
    expect(state.exitPrice).toBeCloseTo(97.97, 10)
    // gross 1 x (100 - 97.97) = +2.03, fee (100 + 97.97) x 0.001 = 0.19797.
    expect(state.realizedPnl).toBeCloseTo(1.83203, 10)
  })

  it('closes a short at the candle close on a time limit', () => {
    const state = simulatePosition([c(0, 100, 101, 99, 100), c(1, 99, 99, 96, 98)], short({ timeLimitSec: 60 }))

    expect(state.exitReason).toBe('time_limit')
    expect(state.exitPrice).toBe(98)
    // gross 1 x (100 - 98) = +2, fee (100 + 98) x 0.001 = 0.198.
    expect(state.realizedPnl).toBeCloseTo(1.802, 10)
  })
})

describe('simulateDca on a short', () => {
  // One level at offset 0, so it fills at the 100 reference and avg entry is exactly 100.
  const params: DcaExecutorParams = {
    side: 'sell',
    levels: [{ priceOffsetPct: 0, amountQuote: 100 }],
    takeProfitPct: 3, stopLossPct: 3, timeLimitSec: null
  }

  it('takes profit on a fall, not a rise', () => {
    const state = simulateDca([c(0, 100, 101, 99, 100), c(1, 99, 99, 96, 97)], params, 100)

    expect(state.closedAt).toBe(T + 60)
    expect(state.closePrice).toBe(97)
    // gross 1 x (100 - 97) = +3, fee (100 + 97) x 0.001 = 0.197.
    expect(state.realizedPnl).toBeCloseTo(2.803, 10)
  })

  it('stops out on a rise', () => {
    const state = simulateDca([c(0, 100, 101, 99, 100), c(1, 101, 104, 100, 103)], params, 100)

    expect(state.closedAt).toBe(T + 60)
    expect(state.closePrice).toBe(103)
    // gross 1 x (100 - 103) = -3, fee (100 + 103) x 0.001 = 0.203.
    expect(state.realizedPnl).toBeCloseTo(-3.203, 10)
  })

  it('resolves the stop before the take-profit for a short too', () => {
    // One candle crossing both the 103 stop and the 97 target. The buy side already asserts this
    // ordering; a short read it the other way round would book a win where the engine books a loss.
    const state = simulateDca([c(0, 100, 101, 99, 100), c(1, 100, 104, 96, 100)], params, 100)

    expect(state.closePrice).toBe(103)
    expect(state.realizedPnl as number).toBeLessThan(0)
  })

  it('fills a short stop at the open when the candle gaps above it', () => {
    const state = simulateDca([c(0, 100, 101, 99, 100), c(1, 108, 109, 107, 108)], params, 100)

    expect(state.closePrice).toBe(108)
    // gross 1 x (100 - 108) = -8, fee (100 + 108) x 0.001 = 0.208.
    expect(state.realizedPnl).toBeCloseTo(-8.208, 10)
  })
})

describe('simulateGrid take-profit on a short', () => {
  it('books a gain when a filled level falls to its target', () => {
    // Levels [100, 105, 110] carrying 100 quote each. The level that fills is 110, so
    // qty = 100/110, and a SELL grid's per-level target is BELOW the fill: 110 x 0.97 = 106.7.
    const sellGrid: GridExecutorParams = {
      side: 'sell', startPrice: 100, endPrice: 110, totalAmountQuote: 300,
      maxOpenOrders: 10, levelSpreadPct: 5, takeProfitPct: 3, limitPrice: null
    }
    const state = simulateGrid([
      c(0, 109, 111, 108, 110),
      c(1, 108, 108.5, 106, 106.5)
    ], sellGrid)

    expect(state.closedLevels).toBe(1)
    expect(state.filledCount).toBe(0)
    // gross (100/110) x (110 - 106.7) = +3, fee (100/110) x (110 + 106.7) x 0.001 = 0.197.
    expect(state.realizedPnl).toBeCloseTo(2.803, 6)
  })
})
