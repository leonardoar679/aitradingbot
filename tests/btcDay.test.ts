import { describe, expect, it } from 'vitest'
import { dayBarsOf, hitOf, thirdOf, trailingVolOf, wilsonInterval, type DayBar } from '../shared/forecast/btcDay'
import type { ForecastBar } from '../shared/forecast/bars'

// BITCOIN'S DAY (shared/forecast/btcDay.ts; V9-BTC-DAY): a big day by its close or its fall from the open, the
// trailing volatility of the 30 daily returns before a day, its third, UTC days from five-minute bars, and a share's
// Wilson interval.

const DAY = 86_400
const bar = (index: number, open: number, high: number, low: number, close: number): DayBar => ({ day: index * DAY, open, high, low, close })

describe("a big Bitcoin day", () => {
  it('is a close 2% or 4% from the open either way, or a low 4% below it', () => {
    expect(hitOf(bar(0, 100, 103, 99, 102), 'close2')).toBe(true)
    expect(hitOf(bar(0, 100, 101, 97.9, 98.1), 'close2')).toBeFalsy()
    expect(hitOf(bar(0, 100, 101, 95, 96), 'close4')).toBe(true)
    expect(hitOf(bar(0, 100, 105, 99, 103.9), 'close4')).toBe(false)
    expect(hitOf(bar(0, 100, 101, 96, 100.5), 'fall4')).toBe(true)
    expect(hitOf(bar(0, 100, 101, 96.1, 100.5), 'fall4')).toBe(false)
  })
})

describe('the trailing volatility', () => {
  it('is the standard deviation of the 30 close-to-close returns before the day, none without them or across a gap', () => {
    // Closes alternating 100 and 101: returns +1% and -0.990..%.
    const bars = Array.from({ length: 40 }, (_, index) => bar(index, 100, 101, 99, index % 2 === 0 ? 100 : 101))
    expect(trailingVolOf(bars, 30)).toBeNull()
    const vol = trailingVolOf(bars, 31)!
    const returns = Array.from({ length: 30 }, (_, k) => bars[1 + k].close / bars[k].close - 1)
    const mean = returns.reduce((sum, value) => sum + value, 0) / 30
    expect(vol).toBeCloseTo(Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 29), 12)
    // A missing day among them: none.
    const gapped = bars.filter((_, index) => index !== 20)
    expect(trailingVolOf(gapped, 31)).toBeNull()
    expect(thirdOf(0.01, [0.02, 0.03])).toBe(0)
    expect(thirdOf(0.02, [0.02, 0.03])).toBe(1)
    expect(thirdOf(0.031, [0.02, 0.03])).toBe(2)
  })
})

describe('UTC days from five-minute bars', () => {
  it('are built from whole days only: the first open, the highest high, the lowest low and the last close', () => {
    const bars: ForecastBar[] = []
    for (let k = 0; k < 288 * 2 - 1; k++) {
      const price = 100 + (k % 288)
      bars.push({ time: k * 300, open: price, high: price + 1, low: price - 1, close: price + 0.5, volume: 1, quoteVolume: 1, takerBuyVolume: 1, trades: 1 })
    }
    const days = dayBarsOf(bars)
    // The second day lacks its last bar: left out.
    expect(days).toEqual([{ day: 0, open: 100, high: 388, low: 99, close: 387.5 }])
  })
})

describe("a share's Wilson interval", () => {
  it('holds the share and narrows with n', () => {
    const small = wilsonInterval(3, 10)
    const large = wilsonInterval(300, 1000)
    expect(small.low).toBeLessThan(0.3)
    expect(small.high).toBeGreaterThan(0.3)
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
    expect(wilsonInterval(30, 100).low).toBeCloseTo(0.2189, 3)
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 })
  })
})
