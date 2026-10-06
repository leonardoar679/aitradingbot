import { describe, it, expect } from 'vitest'
import { FEE_RATE, positionSlippageRate, roundTripFee, spreadCaptureFee, netRealizedPnl, netUnrealizedPct } from '../shared/fees'
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

describe("a position's slippage (PositionExecutorParams.slippageRate)", () => {
  const rate = 0.001
  const base: PositionExecutorParams = {
    side: 'buy', entryPrice: null, amountQuote: 1000,
    takeProfitPct: 10, stopLossPct: 10, timeLimitSec: null, trailingStop: null
  }

  it('reads a usable rate, and anything else as none', () => {
    expect(positionSlippageRate({ slippageRate: 0.0005 })).toBe(0.0005)
    expect(positionSlippageRate({ slippageRate: 0 })).toBe(0)
    expect(positionSlippageRate({})).toBe(0)
    for (const bad of [null, Number.NaN, Infinity, -0.001, 1, 2]) expect(positionSlippageRate({ slippageRate: bad })).toBe(0)
  })

  it('fills the entry worse, keeps the levels where the market put them, and pays a target exactly', () => {
    const state = simulatePosition([candle(1, 100, 101, 99, 100), candle(2, 100, 115, 100, 112)], { ...base, slippageRate: rate })
    // Bought at 100.1 on an open of 100; the target is 10% above the 100, a resting limit, paid exactly.
    expect(state).toMatchObject({ exitReason: 'take_profit', entryPrice: 100 * (1 + rate), levelPrice: 100 })
    expect(state.exitPrice).toBeCloseTo(110, 9)
    const qty = 1000 / (100 * (1 + rate))
    expect(state.realizedPnl).toBeCloseTo(qty * (110 - 100.1) - qty * (100.1 + 110) * FEE_RATE, 9)
  })

  it('loses what the entry gave up whichever way it ends, as against a recommendation\'s own levels', () => {
    const paths: Candle[][] = [
      [candle(1, 100, 101, 99, 100), candle(2, 100, 115, 100, 112)],
      [candle(1, 100, 101, 99, 100), candle(2, 100, 100, 85, 88)],
      [candle(0, 100, 100, 100, 100), candle(60, 100, 101, 99, 100.5)]
    ]
    for (const bars of paths) {
      const params: PositionExecutorParams = { ...base, timeLimitSec: 60 }
      const charged = simulatePosition(bars, { ...params, slippageRate: rate })
      const free = simulatePosition(bars, params)
      expect(charged.exitReason).toBe(free.exitReason)
      expect(charged.realizedPnl as number).toBeLessThan((free.realizedPnl as number) - 0.9)
    }
  })

  it('fills a stop, a trailing stop and the time limit worse than their price', () => {
    const stopped = simulatePosition([candle(1, 100, 101, 99, 100), candle(2, 100, 100, 85, 88)], { ...base, takeProfitPct: null, slippageRate: rate })
    expect(stopped.exitReason).toBe('stop_loss')
    expect(stopped.exitPrice).toBeCloseTo(90 * (1 - rate), 9)
    const trailed = simulatePosition([candle(1, 100, 100.5, 99, 100), candle(2, 104, 105, 103, 103.5)], {
      ...base, takeProfitPct: null, stopLossPct: null, trailingStop: { activationPct: 1, trailPct: 1 }, slippageRate: rate
    })
    expect(trailed.exitReason).toBe('trailing_stop')
    expect(trailed.exitPrice).toBeCloseTo(105 * 0.99 * (1 - rate), 9)
    // Its activation, 1% up, is measured from the 100 the market traded at, not the 100.1 paid.
    const activated = simulatePosition([candle(1, 100, 100.5, 99, 100), candle(2, 101, 101.05, 100, 100.2)], {
      ...base, takeProfitPct: null, stopLossPct: null, trailingStop: { activationPct: 1, trailPct: 1 }, slippageRate: rate
    })
    expect(activated.exitReason).toBe('trailing_stop')
    expect(activated.exitPrice).toBeCloseTo(101.05 * 0.99 * (1 - rate), 9)
    const timed = simulatePosition([candle(0, 100, 100, 100, 100), candle(60, 100, 101, 99, 100.5)], {
      ...base, takeProfitPct: null, stopLossPct: null, timeLimitSec: 60, slippageRate: rate
    })
    expect(timed).toMatchObject({ exitReason: 'time_limit', exitPrice: 100.5 * (1 - rate) })
  })

  it("charges a short both ways: sold lower, bought back higher", () => {
    const short = simulatePosition([candle(1, 100, 101, 99, 100), candle(2, 100, 115, 100, 112)], { ...base, side: 'sell', takeProfitPct: null, slippageRate: rate })
    expect(short).toMatchObject({ exitReason: 'stop_loss', entryPrice: 100 * (1 - rate), levelPrice: 100 })
    expect(short.exitPrice).toBeCloseTo(110 * (1 + rate), 9)
    expect(short.realizedPnl as number).toBeLessThan(simulatePosition([candle(1, 100, 101, 99, 100), candle(2, 100, 115, 100, 112)], { ...base, side: 'sell', takeProfitPct: null }).realizedPnl as number)
  })

  it("charges an entry by a range, and one at a limit, as a recommendation's score charges every entry", () => {
    const ranged = simulatePosition([candle(1, 100, 100.5, 99.5, 100)], { ...base, entryRange: { min: 99.8, max: 100.2 }, slippageRate: rate })
    expect(ranged).toMatchObject({ entryPrice: 100 * (1 + rate), levelPrice: 100 })
    const limited = simulatePosition([candle(1, 101, 101, 99, 100)], { ...base, entryPrice: 100, slippageRate: rate })
    expect(limited).toMatchObject({ entryPrice: 100 * (1 + rate), levelPrice: 100 })
  })

  it('without a rate, fills exactly as it always did', () => {
    const bars = [candle(1, 100, 101, 99, 100), candle(2, 100, 115, 85, 112), candle(3, 112, 113, 90, 95)]
    const variants: PositionExecutorParams[] = [base, { ...base, side: 'sell' }, { ...base, takeProfitPct: null }, { ...base, stopLossPct: null, takeProfitPct: null, timeLimitSec: 60 }]
    for (const params of variants) {
      for (const slippageRate of [0, null, undefined, Number.NaN]) expect(simulatePosition(bars, { ...params, slippageRate })).toEqual(simulatePosition(bars, params))
      const state = simulatePosition(bars, params)
      expect(state.levelPrice).toBe(state.entryPrice)
    }
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

describe('netUnrealizedPct', () => {
  it('is the price move minus the round trip it would take to realize it', () => {
    // +10% gross on a 100 -> 110 move, minus 0.1% of each leg measured against the basis.
    expect(netUnrealizedPct(100, 110)).toBeCloseTo(10 - 0.21, 10)
  })

  it('agrees with netRealizedPnl over cost basis, at any quantity', () => {
    for (const qty of [0.001, 1, 37.5]) {
      const fromPnl = (netRealizedPnl(qty, 100, 110) / (qty * 100)) * 100
      expect(netUnrealizedPct(100, 110)).toBeCloseTo(fromPnl, 10)
    }
  })

  it('reads negative at the entry price, because closing there costs both fees', () => {
    expect(netUnrealizedPct(100, 100)).toBeCloseTo(-0.2, 10)
  })

  it('inverts the move for a paper short but still charges both legs', () => {
    // A short is in profit when price falls, and the fee drag is the same either way.
    expect(netUnrealizedPct(100, 90, 'sell')).toBeCloseTo(10 - 0.19, 10)
    expect(netUnrealizedPct(100, 110, 'sell')).toBeCloseTo(-10 - 0.21, 10)
  })

  it('is always below the gross move', () => {
    for (const [entry, mark] of [[100, 130], [100, 70], [50000, 51000]]) {
      expect(netUnrealizedPct(entry, mark)).toBeLessThan(((mark - entry) / entry) * 100)
    }
  })

  it('returns 0 for a non-positive entry price rather than dividing by it', () => {
    expect(netUnrealizedPct(0, 100)).toBe(0)
    expect(netUnrealizedPct(-5, 100)).toBe(0)
  })
})
