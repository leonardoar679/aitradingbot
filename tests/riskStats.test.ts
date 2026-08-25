import { describe, expect, it } from 'vitest'
import { computeRiskRatios } from '../src/backtest/riskStats'
import type { EquityPoint } from '../src/backtest/engine'

// The equity curve carries a point per candle, including the leading stretch where the strategy
// is forced flat waiting for its indicators. Those bars contribute period returns of exactly
// zero, and counting them marks a strategy down for the time it was not allowed to trade.

const DAY = 86_400

function curve(values: number[], startTime = 0): EquityPoint[] {
  return values.map((value, i) => ({ time: startTime + i * DAY, value }))
}

/** A flat warm-up stretch followed by the same live segment, twice over. */
const live = [10_000, 10_400, 10_100, 10_900, 10_600, 11_300]
const warmup = [10_000, 10_000, 10_000, 10_000]

describe('measuring risk from the first bar the strategy could trade', () => {
  it('gives the same answer as if the warm-up had never been recorded', () => {
    const padded = computeRiskRatios(curve([...warmup, ...live]), warmup.length)
    const bare = computeRiskRatios(curve(live), 0)

    expect(padded.sharpeRatio).toBeCloseTo(bare.sharpeRatio, 10)
    expect(padded.sortinoRatio).toBeCloseTo(bare.sortinoRatio, 10)
    expect(padded.omegaRatio).toBeCloseTo(bare.omegaRatio, 10)
  })

  it('reports a higher Sharpe than counting the warm-up zeros would', () => {
    // The direction of the bug this module exists for: structural zeros pull the ratio toward 0,
    // so the uncorrected number understates every strategy with a long warm-up.
    const corrected = computeRiskRatios(curve([...warmup, ...live]), warmup.length)
    const uncorrected = computeRiskRatios(curve([...warmup, ...live]), 0)

    expect(uncorrected.sharpeRatio).toBeLessThan(corrected.sharpeRatio)
    expect(uncorrected.sharpeRatio).toBeGreaterThan(0)
  })

  it('annualizes on the candle spacing of the segment it measured', () => {
    // Daily points and hourly points over the same shape must not produce the same Sharpe -- an
    // hourly strategy compounds far more periods into a year.
    const daily = computeRiskRatios(curve(live), 0)
    const hourly = computeRiskRatios(
      live.map((value, i) => ({ time: i * 3_600, value })),
      0
    )

    expect(hourly.sharpeRatio).toBeGreaterThan(daily.sharpeRatio)
    expect(hourly.sharpeRatio / daily.sharpeRatio).toBeCloseTo(Math.sqrt(24), 6)
  })
})

describe('holding up when there is nothing to measure', () => {
  it('reports zeros when the warm-up swallows the whole run', () => {
    const ratios = computeRiskRatios(curve([...warmup, ...live]), 99)

    expect(ratios).toEqual({ sharpeRatio: 0, sortinoRatio: 0, omegaRatio: 0 })
  })

  it('measures the whole curve when the warm-up count is unusable', () => {
    // Not "discard everything". A NaN reaches slice() as 0 anyway, but a guard that relies on
    // that has stopped being a guard.
    const whole = computeRiskRatios(curve(live), 0)

    for (const bad of [Number.NaN, -5, Number.NEGATIVE_INFINITY]) {
      expect(computeRiskRatios(curve(live), bad).sharpeRatio).toBeCloseTo(whole.sharpeRatio, 10)
    }
  })

  it('does not divide by an equity of zero', () => {
    // A liquidated run really does reach 0, and 0 as a denominator would make every later return
    // Infinity and the whole panel NaN.
    const ratios = computeRiskRatios(curve([10_000, 5_000, 0, 0]), 0)

    expect(Number.isFinite(ratios.sharpeRatio)).toBe(true)
    expect(Number.isFinite(ratios.sortinoRatio)).toBe(true)
  })

  it('reports a flat curve as zero rather than as infinitely good', () => {
    expect(computeRiskRatios(curve([10_000, 10_000, 10_000]), 0)).toEqual({ sharpeRatio: 0, sortinoRatio: 0, omegaRatio: 0 })
  })
})

describe('a run with no downside at all', () => {
  it('reports Sortino as unbounded rather than as the worst score on the board', () => {
    // Zero downside deviation is not zero risk-adjusted return, it is a ratio with nothing to
    // divide by. Reported as 0.00 the safest run in the table sorted last, while the Omega
    // column beside it read as infinite about the very same curve.
    const rising = computeRiskRatios(curve([100, 110, 121, 133]), 0)

    expect(rising.sortinoRatio).toBe(Number.POSITIVE_INFINITY)
    expect(rising.omegaRatio).toBe(Number.POSITIVE_INFINITY)
  })

  it('reports Sharpe as unbounded when the returns never varied but did compound', () => {
    // Doubling each period, so every return is exactly 1 and the deviation is exactly 0. Worth
    // saying why the fixture looks like this: 100/110/121 does NOT work, because 121/110 - 1 is
    // 0.10000000000000009 rather than 0.1 and the deviation comes out tiny but non-zero. The
    // Sharpe branch is all but unreachable on real data for that reason; the Sortino one above
    // is not, which is the one that mattered.
    const steady = computeRiskRatios(curve([100, 200, 400, 800]), 0)

    expect(steady.sharpeRatio).toBe(Number.POSITIVE_INFINITY)
  })

  it('still reports a curve that never moved as zero, not as infinite', () => {
    // The distinction that makes the branch worth having: no movement is not flawless movement.
    const flat = computeRiskRatios(curve([10_000, 10_000, 10_000]), 0)

    expect(flat.sharpeRatio).toBe(0)
    expect(flat.sortinoRatio).toBe(0)
  })

  it('does not call a losing run unbounded', () => {
    const falling = computeRiskRatios(curve([100, 90, 81]), 0)

    expect(falling.sortinoRatio).toBeLessThan(0)
    expect(Number.isFinite(falling.sortinoRatio)).toBe(true)
  })
})

describe('omega', () => {
  it('is infinite when nothing ever went down, and zero when nothing ever went up', () => {
    expect(computeRiskRatios(curve([100, 110, 120]), 0).omegaRatio).toBe(Number.POSITIVE_INFINITY)
    expect(computeRiskRatios(curve([120, 110, 100]), 0).omegaRatio).toBe(0)
  })

  it('is the ratio of the up moves to the down moves', () => {
    // +10% then -10% (of 110) -> gains 0.1, losses 0.0909...
    const ratios = computeRiskRatios(curve([100, 110, 99]), 0)

    expect(ratios.omegaRatio).toBeCloseTo(0.1 / (11 / 110), 10)
  })
})

describe('telling downside apart from movement', () => {
  it('rates a curve that rises hard and dips gently better than its Sharpe does', () => {
    // Sortino only penalises the down moves. A curve with large gains and small losses must score
    // higher on it than on Sharpe, which is charged for the upside too -- squaring every return
    // instead of only the negative ones collapses the two into the same number.
    const jumpy = computeRiskRatios(curve([100, 130, 129, 170, 168, 220]), 0)

    expect(jumpy.sortinoRatio).toBeGreaterThan(jumpy.sharpeRatio * 1.5)
  })
})

describe('a curve whose candles are not evenly spaced', () => {
  it('annualizes on the spacing of the live segment, not of the whole series', () => {
    // Real series have gaps -- an exchange with missing slots leaves a sparse early stretch. The
    // warm-up here is monthly and the live segment daily; measuring the interval across both
    // would claim a year holds a handful of periods and shrink the ratio accordingly.
    const sparseWarmup: EquityPoint[] = [0, 1, 2, 3].map((i) => ({ time: i * 30 * DAY, value: 10_000 }))
    const liveSegment: EquityPoint[] = live.map((value, i) => ({ time: 3 * 30 * DAY + i * DAY, value }))

    const measured = computeRiskRatios([...sparseWarmup, ...liveSegment], sparseWarmup.length)
    const bare = computeRiskRatios(curve(live), 0)

    expect(measured.sharpeRatio).toBeCloseTo(bare.sharpeRatio, 10)
  })
})

describe('the engine actually applying the correction', () => {
  it('reports the warm-up-corrected Sharpe, not the raw one', async () => {
    const { runBacktest } = await import('../src/backtest/engine')
    const wobbleSeries = (n: number, base: number, amp: number, from = 0): number[] =>
      Array.from({ length: n }, (_, i) => base + amp * Math.sin((i + from) / 3))
    const closes = [...wobbleSeries(40, 100, 2), ...wobbleSeries(30, 112, 2, 40), ...wobbleSeries(40, 130, 2, 70)]
    const candles = closes.map((close, i) => ({
      time: i * DAY,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1
    }))

    const result = runBacktest(candles, 'bollinger-breakout', { startingBalance: 10_000 })
    const corrected = computeRiskRatios(result.equityCurve, result.stats.warmupBars)
    const raw = computeRiskRatios(result.equityCurve, 0)

    expect(result.stats.warmupBars).toBeGreaterThan(0)
    expect(result.stats.sharpeRatio).toBeCloseTo(corrected.sharpeRatio, 10)
    expect(result.stats.sharpeRatio).not.toBeCloseTo(raw.sharpeRatio, 6)
  })
})
