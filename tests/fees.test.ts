import { describe, it, expect } from 'vitest'
import { FEE_RATE, roundTripFee, spreadCaptureFee, netRealizedPnl } from '../shared/fees'
import { simulatePosition } from '../src/executors/engine'
import { simulateArbitrage, simulateXemm } from '../src/executors/spreadEngine'
import type { Candle, PositionExecutorParams, ArbitrageExecutorParams, XemmExecutorParams } from '../shared/ipc'

const candle = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time, open, high, low, close, volume: 0
})

const spreadMarkets = {
  buyingMarket: { exchange: 'binance' as const, symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  sellingMarket: { exchange: 'bithumb' as const, symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }
}

describe('fee model', () => {
  it('charges both sides of a round trip', () => {
    expect(roundTripFee(10, 100, 110)).toBeCloseTo((10 * 100 + 10 * 110) * FEE_RATE, 12)
  })

  it('charges both legs of a spread capture, including the richer sell leg', () => {
    expect(spreadCaptureFee(1000, 0.2)).toBeCloseTo((1000 + 1000 * 1.002) * FEE_RATE, 12)
  })
})

describe('executor realized P&L is net of fees', () => {
  const params: PositionExecutorParams = {
    side: 'buy', entryPrice: 100, amountQuote: 1000,
    takeProfitPct: 10, stopLossPct: null, timeLimitSec: null, trailingStop: null
  }

  it('subtracts the round trip from a winning position', () => {
    const state = simulatePosition([candle(1, 100, 101, 99, 100), candle(2, 100, 115, 100, 112)], params)
    // qty 10, gross 100.00, fees 2.10
    expect(state.realizedPnl).toBeCloseTo(97.9, 6)
  })

  it('makes a losing position WORSE, never better (guards a sign error)', () => {
    const losing: PositionExecutorParams = { ...params, takeProfitPct: null, stopLossPct: 10 }
    const state = simulatePosition([candle(1, 100, 101, 99, 100), candle(2, 100, 100, 85, 88)], losing)
    expect(state.realizedPnl).toBeCloseTo(-101.9, 6)
    expect(state.realizedPnl!).toBeLessThan(-100)
  })
})

describe('spread captures account for two legs', () => {
  it('reports a capture that does not clear its fees as a real loss', () => {
    // A 0.2% spread was the old XEMM default -- it loses money on every capture.
    const arb = simulateArbitrage([{ time: 1, priceA: 100, priceB: 100.2 }], {
      ...spreadMarkets, orderAmountQuote: 1000, minProfitabilityPct: 0.2
    } as ArbitrageExecutorParams)
    expect(arb.realizedPnl).toBeLessThan(0)
    expect(arb.realizedPnl).toBeCloseTo(1000 * 0.002 - (1000 + 1000 * 1.002) * FEE_RATE, 9)
  })

  it('keeps a genuinely wide spread profitable', () => {
    const arb = simulateArbitrage([{ time: 1, priceA: 100, priceB: 101 }], {
      ...spreadMarkets, orderAmountQuote: 1000, minProfitabilityPct: 0.4
    } as ArbitrageExecutorParams)
    expect(arb.realizedPnl).toBeCloseTo(7.99, 6)
  })

  it('applies the same two-leg cost to XEMM', () => {
    const x = simulateXemm([{ time: 1, priceA: 100, priceB: 100.2 }], {
      ...spreadMarkets, orderAmountQuote: 1000, minProfitabilityPct: 0.2
    } as XemmExecutorParams)
    expect(x.realizedPnl).toBeLessThan(0)
  })
})

describe('netRealizedPnl', () => {
  it('subtracts the fee on both fills from the gross move', () => {
    // 1 unit bought at 100, sold at 110: $10 gross, minus 0.1% of 100 and 0.1% of 110.
    expect(netRealizedPnl(1, 100, 110)).toBeCloseTo(10 - 0.1 - 0.11, 10)
  })

  it('turns a flat round trip into a loss', () => {
    // The real ledger backs the daily loss gate, so a break-even trade must not read as zero.
    expect(netRealizedPnl(1, 100, 100)).toBeLessThan(0)
    expect(netRealizedPnl(1, 100, 100)).toBeCloseTo(-0.2, 10)
  })

  it('makes a loss larger, never smaller', () => {
    const gross = 1 * (90 - 100)
    expect(netRealizedPnl(1, 100, 90)).toBeLessThan(gross)
  })

  it('scales with quantity', () => {
    expect(netRealizedPnl(3, 100, 110)).toBeCloseTo(3 * netRealizedPnl(1, 100, 110), 10)
  })

  it('agrees with gross minus roundTripFee', () => {
    expect(netRealizedPnl(2, 50, 70)).toBeCloseTo(2 * (70 - 50) - roundTripFee(2, 50, 70), 10)
  })

  it('is zero-qty safe', () => {
    expect(netRealizedPnl(0, 100, 110)).toBe(0)
  })
})
