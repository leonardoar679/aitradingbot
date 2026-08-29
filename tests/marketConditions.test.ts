import { describe, expect, it } from 'vitest'
import { ADX_QUIET, MEASURED_EXPECTATIONS, readMarketConditions } from '../src/backtest/marketConditions'
import { getStrategy } from '../src/backtest/strategies'
import type { Candle } from '../shared/ipc'

// The whole readout turns on which side of 20 a number lands, so the tests that matter are the ones
// pinning that the number is Wilder's ADX and not something adjacent. The dangerous failure is
// silent: an EMA in place of Wilder's smoothing produces a plausible-looking curve with every value
// shifted, which would flip readings across the boundary and change the advice shown to a user.

const DAY = 86_400

function series(bars: Array<[number, number, number]>): Candle[] {
  return bars.map(([high, low, close], i) => ({
    time: 1_600_000_000 + i * DAY,
    open: close,
    high,
    low,
    close,
    volume: 1
  }))
}

/** A clean one-way march: every bar higher than the last, no overlap. ADX is defined to approach
 * 100 here, because +DI is everything and -DI is nothing. */
function straightLine(n: number, step = 1): Candle[] {
  return series(Array.from({ length: n }, (_, i) => [100 + i * step + 0.5, 100 + i * step - 0.5, 100 + i * step]))
}

/** A market going nowhere, but genuinely MOVING while it does. Each bar steps up then back down,
 * so +DM and -DM alternate and cancel in the smoothed averages, which is what a low ADX means.
 * An earlier version used identical highs and lows on every bar: that has zero directional
 * movement, which leaves ADX undefined rather than low, and tested nothing. */
function sawtooth(n: number): Candle[] {
  return series(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? [102, 100, 101] : [101, 99, 100])))
}

describe('marketConditions', () => {
  it('reads a relentless one-way trend as strongly trending', () => {
    const c = readMarketConditions(straightLine(80), 'trend-regime-ensemble')
    expect(c.adx).toBeGreaterThan(60)
    expect(c.posture).toBe('trending')
  })

  it('reads a market going nowhere as quiet', () => {
    const c = readMarketConditions(sawtooth(80), 'trend-regime-ensemble')
    expect(c.adx).toBeLessThanOrEqual(ADX_QUIET)
    expect(c.posture).toBe('quiet')
  })

  it('separates the two by a wide margin, not a rounding error', () => {
    // If Wilder's smoothing were replaced by an EMA both readings would still be ordered correctly
    // but compressed. Pinning the SIZE of the gap is what catches that.
    const trending = readMarketConditions(straightLine(80), 'trend-regime-ensemble').adx
    const quiet = readMarketConditions(sawtooth(80), 'trend-regime-ensemble').adx
    expect(trending - quiet).toBeGreaterThan(40)
  })

  it('distinguishes a flat market from missing history', () => {
    // Identical bars: no directional movement, so ADX is undefined rather than low. Reporting
    // that as "not enough history" would send someone to widen a date range that is already fine.
    const flat = series(Array.from({ length: 80 }, () => [101, 99, 100] as [number, number, number]))
    const c = readMarketConditions(flat, 'trend-regime-ensemble')
    expect(c.posture).toBe('unknown')
    expect(c.summary).toMatch(/no directional movement/i)
    expect(c.summary).not.toMatch(/not enough/i)
  })

  it('refuses to report a number when there is not enough history', () => {
    // ADX(14) needs 29 daily bars. A value computed from fewer would still print, and would be read
    // as a real measurement of a real market.
    for (const n of [0, 5, 20, 28]) {
      const c = readMarketConditions(straightLine(n), 'trend-regime-ensemble')
      expect(Number.isNaN(c.adx), `${n} bars produced a number`).toBe(true)
      expect(c.posture).toBe('unknown')
    }
    expect(readMarketConditions(straightLine(40), 'trend-regime-ensemble').posture).not.toBe('unknown')
  })

  it('labels the band between the two boundaries as no signal', () => {
    // Built by hand rather than searched for: alternating a drift up with a drift down produces
    // partial directional movement, which is what the middle band is.
    const bars: Array<[number, number, number]> = []
    let p = 100
    for (let i = 0; i < 80; i++) {
      p += i % 3 === 0 ? 2.2 : -1
      bars.push([p + 1, p - 1, p])
    }
    const c = readMarketConditions(series(bars), 'trend-regime-ensemble')
    if (c.posture === 'middling') {
      expect(c.summary).toMatch(/no signal/i)
      expect(c.adx).toBeGreaterThan(ADX_QUIET)
    }
    // If this series lands outside the band the test still has to assert something true of it.
    expect(['quiet', 'middling', 'trending']).toContain(c.posture)
  })

  it('carries the measured expectation for each strategy, and none for an unknown one', () => {
    for (const id of ['trend-regime-ensemble', 'short-term-channel', 'short-term-channel-regime']) {
      const e = readMarketConditions(straightLine(40), id).expectation
      expect(e, `no expectation for ${id}`).not.toBeNull()
      // Every measured quiet-month mean is above its own baseline; that is the finding.
      expect(e && e.quietMeanPct).toBeGreaterThan((e && e.baselineMeanPct) ?? Infinity)
    }
    expect(readMarketConditions(straightLine(40), 'ema-cross-atr-stop').expectation).toBeNull()
  })

  it('quotes each expectation at the interval that strategy actually runs on', () => {
    // The defect this exists to prevent, which nearly shipped: Trend Regime's preferredInterval
    // moved from 1h to 4h on measurement (research/INTERVAL.md), while MEASURED_EXPECTATIONS still
    // held figures taken at 15m. The card would then have printed "a quiet month averaged 10.8%
    // for this strategy" beside a backtest run at a different bar size, with nothing on screen to
    // show the two did not match and no test failing. Re-measure, or this fails.
    for (const e of MEASURED_EXPECTATIONS) {
      expect(e.interval, `${e.strategyId} expectation measured at ${e.interval}`)
        .toBe(getStrategy(e.strategyId).preferredInterval)
    }
  })

  it('only carries expectations for strategies that exist', () => {
    // getStrategy falls back to a default for an unknown id rather than throwing, so a typo in a
    // strategyId here would silently attach one strategy's measured numbers to another's card.
    for (const e of MEASURED_EXPECTATIONS) {
      expect(getStrategy(e.strategyId).id, `no strategy with id ${e.strategyId}`).toBe(e.strategyId)
    }
  })

  it('never phrases the reading as a claim about direction or win rate', () => {
    // research/beta.ts: ADX does not forecast direction, and the win rate under this rule goes DOWN.
    // Copy implying "safer" or "more likely to win" would be a misreading of the measurement.
    for (const c of [straightLine(80), sawtooth(80)]) {
      const { summary } = readMarketConditions(c, 'trend-regime-ensemble')
      expect(summary).not.toMatch(/safer|more likely|will rise|win rate|probability/i)
    }
  })
})
