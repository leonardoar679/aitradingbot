import { describe, expect, it } from 'vitest'
import { stopFillPrice, simulatePosition, simulateDca, simulateGrid, buildGridLevels } from '../src/executors/engine'
import { roundTripFee } from '../shared/fees'
import type { Candle, DcaExecutorParams, GridExecutorParams, PositionExecutorParams } from '../shared/ipc'

// A stop order becomes a market order when triggered, so a candle that opens beyond the stop
// never trades at the stop price at all. src/backtest/engine.ts has always modelled this; the
// executor simulations reported the stop price regardless, which overstates the result on
// exactly the exits that hurt. Live 1m data says this is not hypothetical: GOPAX BTC-KRW had 16
// of 23 slots missing and 4.5% of candles opening ≥0.5% away from the prior close.

const T = 1_700_000_000
const c = (i: number, open: number, high: number, low: number, close: number): Candle => ({
  time: T + i * 60, open, high, low, close, volume: 1
})

describe('stopFillPrice', () => {
  it('returns the stop price when the candle opened above it (long)', () => {
    expect(stopFillPrice(99, 95, true)).toBe(95)
  })

  it('returns the open when a long gaps below the stop', () => {
    expect(stopFillPrice(90, 95, true)).toBe(90)
  })

  it('mirrors for a short', () => {
    expect(stopFillPrice(101, 105, false)).toBe(105)
    expect(stopFillPrice(110, 105, false)).toBe(110)
  })
})

describe('simulatePosition stop fills', () => {
  const params: PositionExecutorParams = {
    side: 'buy', entryPrice: null, amountQuote: 100,
    takeProfitPct: null, stopLossPct: 5, timeLimitSec: null, trailingStop: null
  }

  it('fills at the stop price when the candle traded through it', () => {
    const state = simulatePosition([c(0, 100, 101, 99, 100), c(1, 99, 99, 94, 96)], params)

    expect(state.exitReason).toBe('stop_loss')
    expect(state.exitPrice).toBe(95)
  })

  it('fills at the open when the candle gaps straight through the stop', () => {
    const state = simulatePosition([c(0, 100, 101, 99, 100), c(1, 90, 90, 88, 89)], params)

    expect(state.exitReason).toBe('stop_loss')
    // Not 95 — there was never a trade at 95 to be filled at.
    expect(state.exitPrice).toBe(90)
    const qty = 100 / 100
    expect(state.realizedPnl).toBeCloseTo(qty * (90 - 100) - roundTripFee(qty, 100, 90), 10)
  })

  it('reports a worse loss on a gap than the stop price implies', () => {
    const gapped = simulatePosition([c(0, 100, 101, 99, 100), c(1, 90, 90, 88, 89)], params)
    const clean = simulatePosition([c(0, 100, 101, 99, 100), c(1, 99, 99, 94, 96)], params)

    expect(gapped.realizedPnl as number).toBeLessThan(clean.realizedPnl as number)
  })
})

describe('simulateDca exit resolution', () => {
  const params: DcaExecutorParams = {
    side: 'buy',
    levels: [{ priceOffsetPct: 0, amountQuote: 100 }],
    takeProfitPct: 3, stopLossPct: 3, timeLimitSec: null
  }

  it('resolves the stop before the take-profit when one candle hits both', () => {
    // Fills at 100, then a candle spanning 96 to 104 crosses the 97 stop and the 103 target.
    const state = simulateDca([c(0, 100, 101, 99, 100), c(1, 100, 104, 96, 100)], params, 100)

    // DCA used to read this as a take-profit — a win where simulatePosition and the backtest
    // engine both call the same price action a loss.
    expect(state.closePrice).toBe(97)
    expect(state.realizedPnl as number).toBeLessThan(0)
  })

  it('fills a gapped stop at the open', () => {
    const state = simulateDca([c(0, 100, 101, 99, 100), c(1, 90, 91, 88, 89)], params, 100)

    expect(state.closePrice).toBe(90)
  })

  it('still takes the profit when only the target is hit', () => {
    const state = simulateDca([c(0, 100, 101, 99, 100), c(1, 100, 104, 99, 103)], params, 100)

    expect(state.closePrice).toBe(103)
    expect(state.realizedPnl as number).toBeGreaterThan(0)
  })
})

describe('simulateGrid stop price fills', () => {
  const params: GridExecutorParams = {
    side: 'buy', startPrice: 100, endPrice: 110, totalAmountQuote: 300,
    maxOpenOrders: 3, levelSpreadPct: 5, takeProfitPct: 10, limitPrice: 95
  }

  it('fills every open level at the open when the candle gaps through the stop', () => {
    expect(buildGridLevels(params)).toContain(100)
    const state = simulateGrid([c(0, 100, 101, 99, 100), c(1, 90, 91, 88, 89)], params)

    expect(state.stoppedAt).toBe(T + 60)
    expect(state.filledCount).toBe(0)
    const amountPerLevel = state.amountPerLevel
    const qty = amountPerLevel / 100
    // Closed at 90, the open — not at the 95 stop price.
    expect(state.realizedPnl).toBeCloseTo(qty * (90 - 100) - roundTripFee(qty, 100, 90), 10)
  })

  it('fills at the stop price when the candle merely traded through it', () => {
    const state = simulateGrid([c(0, 100, 101, 99, 100), c(1, 99, 99, 94, 96)], params)
    const qty = state.amountPerLevel / 100

    expect(state.realizedPnl).toBeCloseTo(qty * (95 - 100) - roundTripFee(qty, 100, 95), 10)
  })
})
