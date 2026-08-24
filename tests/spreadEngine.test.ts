import { describe, it, expect } from 'vitest'
import { alignByTime, spreadPct, simulateXemm, simulateArbitrage } from '../src/executors/spreadEngine'
import { spreadCaptureFee } from '../shared/fees'
import type { Candle, XemmExecutorParams, ArbitrageExecutorParams } from '../shared/ipc'

const c = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 0 })
const markets = {
  buyingMarket: { exchange: 'binance' as const, symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  sellingMarket: { exchange: 'bithumb' as const, symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }
}
const xemm = (minPct: number): XemmExecutorParams => ({ ...markets, orderAmountQuote: 1000, minProfitabilityPct: minPct })
const arb = (minPct: number): ArbitrageExecutorParams => ({ ...markets, orderAmountQuote: 1000, minProfitabilityPct: minPct })

describe('alignByTime', () => {
  it('inner-joins on shared timestamps, dropping gaps on either side', () => {
    const a = [c(1, 10), c(2, 20), c(3, 30)]
    const b = [c(2, 21), c(3, 31), c(4, 41)]
    expect(alignByTime(a, b).map((p) => p.time)).toEqual([2, 3])
  })

  it('returns nothing when the two series never overlap', () => {
    expect(alignByTime([c(1, 10)], [c(2, 20)])).toEqual([])
  })
})

describe('spreadPct', () => {
  it('is positive when the selling market is richer', () => {
    expect(spreadPct(100, 101)).toBeCloseTo(1, 9)
    expect(spreadPct(100, 99)).toBeCloseTo(-1, 9)
  })
})

describe('capture arming', () => {
  const wide = { time: 1, priceA: 100, priceB: 105 }

  it('does not re-capture while the spread stays wide', () => {
    const points = [wide, { ...wide, time: 2 }, { ...wide, time: 3 }]
    expect(simulateXemm(points, xemm(1)).captures).toHaveLength(1)
  })

  it('re-arms only after the spread retreats below half the threshold', () => {
    const points = [wide, { time: 2, priceA: 100, priceB: 100.1 }, { time: 3, priceA: 100, priceB: 105 }]
    expect(simulateXemm(points, xemm(1)).captures).toHaveLength(2)
  })

  it('ignores a spread that never reaches the threshold', () => {
    expect(simulateXemm([{ time: 1, priceA: 100, priceB: 100.1 }], xemm(1)).captures).toHaveLength(0)
  })
})

describe('capture profit', () => {
  // These tests exercised only capture COUNTS. The profit on a capture could have the fee
  // dropped entirely, and realizedPnl could overwrite instead of accumulate -- reporting the
  // last capture as the total -- with the whole file still green.
  const wide = { time: 1, priceA: 100, priceB: 105 }
  const retreat = { time: 2, priceA: 100, priceB: 100.1 }
  const twoCaptures = [wide, retreat, { ...wide, time: 3 }]

  // A 5% spread on 1000 quote: 50 gross, less the fee on both legs of the same round trip.
  const expectedPerCapture = 1000 * 0.05 - spreadCaptureFee(1000, 5)

  it('charges both legs of a XEMM capture', () => {
    const s = simulateXemm([wide], xemm(1))
    expect(s.captures).toHaveLength(1)
    expect(s.captures[0].profitQuote).toBeCloseTo(expectedPerCapture, 9)
    expect(s.captures[0].profitQuote).toBeLessThan(50)
  })

  it('charges both legs of an arbitrage capture, on an inverted spread too', () => {
    // Arbitrage profits either way, so the fee has to come off the absolute move as well.
    const s = simulateArbitrage([{ time: 1, priceA: 100, priceB: 95 }], arb(1))
    expect(s.captures).toHaveLength(1)
    expect(s.captures[0].profitQuote).toBeCloseTo(expectedPerCapture, 9)
  })

  it('sums every capture into realized P&L, rather than reporting the last one', () => {
    const s = simulateXemm(twoCaptures, xemm(1))
    expect(s.captures).toHaveLength(2)
    expect(s.realizedPnl).toBeCloseTo(expectedPerCapture * 2, 9)
  })

  it('sums arbitrage captures too', () => {
    const s = simulateArbitrage(twoCaptures, arb(1))
    expect(s.captures).toHaveLength(2)
    expect(s.realizedPnl).toBeCloseTo(expectedPerCapture * 2, 9)
  })

  it('reports no profit at all when nothing was captured', () => {
    expect(simulateXemm([retreat], xemm(1)).realizedPnl).toBe(0)
  })
})

describe('XEMM is directional, arbitrage is not', () => {
  const inverted = [{ time: 1, priceA: 100, priceB: 95 }] // selling market is CHEAPER

  it('XEMM ignores an inverted spread', () => {
    expect(simulateXemm(inverted, xemm(1)).captures).toHaveLength(0)
  })

  it('arbitrage captures it either way', () => {
    expect(simulateArbitrage(inverted, arb(1)).captures).toHaveLength(1)
  })

  it('records the signed spread even when capturing the absolute move', () => {
    expect(simulateArbitrage(inverted, arb(1)).captures[0].spreadPct).toBeCloseTo(-5, 9)
  })

  it('tracks the latest spread regardless of captures', () => {
    expect(simulateXemm([{ time: 1, priceA: 100, priceB: 100.5 }], xemm(5)).lastSpreadPct).toBeCloseTo(0.5, 9)
  })
})
