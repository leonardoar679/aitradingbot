import { describe, expect, it } from 'vitest'
import {
  inferBarSeconds,
  rollingSma,
  trendRegimeEnsemble
} from '../src/backtest/strategies/trendRegimeEnsemble'
import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'

// This strategy exists because the other three lose money on intraday candles, and the reason is
// fees: a round trip costs 0.2% while a typical 15m bar moves 0.16%. Everything pinned here is a
// property that, if it broke, would quietly turn this strategy back into one of those -- trading
// far too often, or measuring its trend on the wrong scale and finding noise.

const M15 = 900
const M3 = 180

function series(barSeconds: number, closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * barSeconds,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1
  }))
}

/** A rising ramp long enough to warm the slowest (80-day) lookback at the given bar size. */
function risingRamp(barSeconds: number, days: number): Candle[] {
  const bars = Math.round((days * 86_400) / barSeconds)
  return series(
    barSeconds,
    Array.from({ length: bars }, (_, i) => 100 + i * 0.01)
  )
}

describe('inferBarSeconds', () => {
  it('reads the spacing of an ordinary series', () => {
    expect(inferBarSeconds(series(M15, [1, 2, 3, 4]))).toBe(M15)
  })

  it('ignores a gap instead of being dragged by it', () => {
    // The bug this guards: a mean would read this as far slower than 15m and scale every
    // lookback wrong -- an exchange outage or a stitched-together paginated range is enough to
    // put the moving averages on a scale where the measured edge does not exist.
    const candles = series(M15, [1, 2, 3, 4, 5, 6])
    candles[3].time += 3 * 86_400
    candles[4].time += 3 * 86_400
    candles[5].time += 3 * 86_400
    expect(inferBarSeconds(candles)).toBe(M15)
  })

  it('reports 0 for history too short to measure rather than guessing', () => {
    expect(inferBarSeconds([])).toBe(0)
    expect(inferBarSeconds(series(M15, [1]))).toBe(0)
  })

  it('produces no signals at all when the spacing cannot be read', () => {
    const s = trendRegimeEnsemble.generateSignals(series(M15, [1]))
    expect(s.entries.every((e) => !e)).toBe(true)
    expect(s.exits.every((e) => !e)).toBe(true)
  })
})

describe('rollingSma', () => {
  it('is NaN until the window fills, so a cold lookback abstains from the vote', () => {
    const out = rollingSma([1, 2, 3, 4], 3)
    expect(Number.isNaN(out[0])).toBe(true)
    expect(Number.isNaN(out[1])).toBe(true)
    expect(out[2]).toBeCloseTo(2)
    expect(out[3]).toBeCloseTo(3)
  })

  it('a NaN average never votes, in either direction', () => {
    // The vote is `close > ma`, which is false against NaN. That is what keeps a not-yet-warm
    // lookback from counting as agreement -- and it is why entry requires the FULL count.
    const out = rollingSma([5], 3)
    expect(5 > out[0]).toBe(false)
  })
})

describe('the lookbacks are measured in days, not bars', () => {
  // The design claim this file exists to protect. Written as bar counts, "20 days of 15m" is 4
  // days of 3m -- and the measured trend edge is zero at 1-4 days, so a bar-count version of this
  // strategy silently becomes a noise trader when someone runs it on a faster chart.
  it('warms up over the same wall-clock span on 15m and on 3m', () => {
    const at15 = trendRegimeEnsemble.generateSignals(risingRamp(M15, 90))
    const at3 = trendRegimeEnsemble.generateSignals(risingRamp(M3, 90))
    expect(at15.warmupBars).toBe(80 * 96)
    expect(at3.warmupBars).toBe(80 * 480)
    expect((at15.warmupBars * M15) / 86_400).toBe(80)
    expect((at3.warmupBars * M3) / 86_400).toBe(80)
  })
})

describe('the vote', () => {
  it('holds through a sustained uptrend once every lookback agrees', () => {
    const s = trendRegimeEnsemble.generateSignals(risingRamp(M15, 120))
    expect(s.entries.some((e) => e)).toBe(true)
    // A monotonic rise never puts price below any average, so nothing may exit.
    expect(s.exits.every((e) => !e)).toBe(true)
  })

  it('never enters while price is below the slow averages', () => {
    const bars = Math.round((120 * 86_400) / M15)
    const falling = series(
      M15,
      Array.from({ length: bars }, (_, i) => 10_000 - i * 0.05)
    )
    const s = trendRegimeEnsemble.generateSignals(falling)
    expect(s.entries.every((e) => !e)).toBe(true)
  })

  it('takes very few trades on real-shaped noise, which is the whole design constraint', () => {
    // Random walk with no trend: the strategy should mostly stay out. A regression that made it
    // trade on every vote change would show up here as a trade count in the hundreds, and at
    // 0.2% a round trip that is the difference between this strategy and Bollinger Breakout's
    // -98%.
    let price = 100
    let seed = 42
    const bars = Math.round((400 * 86_400) / M15)
    const closes = Array.from({ length: bars }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      price *= 1 + ((seed / 2147483648) * 2 - 1) * 0.002
      return price
    })
    const candles = series(M15, closes)
    const result = runBacktest(candles, trendRegimeEnsemble.id, { startingBalance: 10_000 })
    expect(result.stats.totalClosedTrades).toBeLessThan(40)
  })
})

describe('the entry stop', () => {
  it('refuses the entry rather than entering with an unusable stop price', () => {
    // stopPrices[i] === null is what the engine reads as "no entry". A bar whose ATR cannot be
    // read must take that path, not enter with a stop that can never be hit.
    const s = trendRegimeEnsemble.generateSignals(risingRamp(M15, 120))
    for (let i = 0; i < s.entries.length; i++) {
      if (s.entries[i] && s.stopPrices[i] !== null) {
        expect(s.stopPrices[i] as number).toBeGreaterThan(0)
      }
    }
    // Every entry the engine will act on carries a positive stop.
    const actionable = s.entries.filter((e, i) => e && s.stopPrices[i] !== null)
    expect(actionable.length).toBeGreaterThan(0)
  })

  it('sets the stop far enough below the close to be a disaster stop, not a working one', () => {
    const candles = risingRamp(M15, 120)
    const s = trendRegimeEnsemble.generateSignals(candles)
    const i = s.entries.findIndex((e, idx) => e && s.stopPrices[idx] !== null)
    expect(i).toBeGreaterThan(-1)
    expect(s.stopPrices[i] as number).toBeLessThan(candles[i].close)
  })
})
