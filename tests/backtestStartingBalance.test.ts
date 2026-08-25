import { describe, expect, it } from 'vitest'
import { runBacktest, resolveStartingBalance, DEFAULT_STARTING_BALANCE } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'

// The starting balance used to be a constant nobody could reach. Now the Backtest page fills it
// in from the paper account, which means two new things can arrive here that never could before:
// a number the user typed, and a balance of 0 (every asset committed to running strategies). Both
// reach the engine as ordinary numbers, so the tests below pin what each one does to the results.

const H4 = 4 * 3600
const START = 1_700_000_000

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]
    return { time: START + i * H4, open: prev, high: Math.max(c, prev), low: Math.min(c, prev), close: c, volume: 1 }
  })
}

// Bollinger Breakout warms up in 20 bars, so this forces a real entry and exit cheaply. Long
// enough to clear MIN_ANNUALIZATION_DAYS as well, so annualized figures are actually computed.
const TRADED = series([...Array(30).fill(100), 110, ...Array(60).fill(112), ...Array(120).fill(104)])

describe('resolveStartingBalance', () => {
  it('takes a positive number as given', () => {
    expect(resolveStartingBalance(25_000)).toBe(25_000)
    expect(resolveStartingBalance(0.5)).toBe(0.5)
  })

  it('falls back when nothing was asked for', () => {
    expect(resolveStartingBalance(undefined)).toBe(DEFAULT_STARTING_BALANCE)
  })

  it('falls back on zero, which is what a fully-committed account reports as available', () => {
    // Not a hypothetical: availableBalance() returns 0 once every asset is held by a running
    // strategy. A run from 0 makes every trade zero-sized and every stat a division by zero.
    expect(resolveStartingBalance(0)).toBe(DEFAULT_STARTING_BALANCE)
  })

  it('falls back on a negative balance, which availableBalance can also return', () => {
    // availableBalance deliberately goes negative when commitments exceed the balance, rather
    // than clamping and hiding it. That value must not become a backtest's capital.
    expect(resolveStartingBalance(-2_000)).toBe(DEFAULT_STARTING_BALANCE)
  })

  it('falls back on NaN and Infinity rather than reporting NaN money', () => {
    // NaN does not throw here -- it spreads. Every currency figure on the results page would read
    // "NaN" while the percentages beside them still looked like real numbers.
    expect(resolveStartingBalance(Number.NaN)).toBe(DEFAULT_STARTING_BALANCE)
    expect(resolveStartingBalance(Number.POSITIVE_INFINITY)).toBe(DEFAULT_STARTING_BALANCE)
  })
})

describe('runBacktest — what the starting balance changes', () => {
  it('starts an unconfigured run at the default, exactly as before this was settable', () => {
    const result = runBacktest(TRADED, 'bollinger-breakout')

    expect(result.stats.startingBalance).toBe(DEFAULT_STARTING_BALANCE)
    expect(result.equityCurve[0].value).toBe(DEFAULT_STARTING_BALANCE)
    expect(result.benchmarkCurve[0].value).toBe(DEFAULT_STARTING_BALANCE)
  })

  it('reports back the balance it was given, not the default', () => {
    const result = runBacktest(TRADED, 'bollinger-breakout', { startingBalance: 25_000 })

    expect(result.stats.startingBalance).toBe(25_000)
    expect(result.equityCurve[0].value).toBe(25_000)
    expect(result.benchmarkCurve[0].value).toBe(25_000)
  })

  it('scales every currency figure by the same factor and nothing else', () => {
    // The one property that makes the field safe to expose: capital is a multiplier on a
    // fee-proportional, fully-invested model, so 2.5x the money is 2.5x the money and the same
    // strategy. Anything that scaled unevenly would mean one of these figures is computed
    // against a balance the others are not.
    const base = runBacktest(TRADED, 'bollinger-breakout', { startingBalance: 10_000 })
    const big = runBacktest(TRADED, 'bollinger-breakout', { startingBalance: 25_000 })

    expect(base.trades.length).toBeGreaterThan(0)
    expect(big.stats.finishingBalance).toBeCloseTo(base.stats.finishingBalance * 2.5, 6)
    expect(big.stats.totalNetProfit).toBeCloseTo(base.stats.totalNetProfit * 2.5, 6)
    expect(big.stats.totalPaidFees).toBeCloseTo(base.stats.totalPaidFees * 2.5, 6)
    expect(big.stats.expectancy).toBeCloseTo(base.stats.expectancy * 2.5, 6)
    expect(big.stats.largestWinningTrade).toBeCloseTo(base.stats.largestWinningTrade * 2.5, 6)
  })

  it('leaves every ratio and percentage untouched', () => {
    // The counterpart to the above, and the one a beginner reads first: funding a bigger account
    // must not make a strategy look like it returns more.
    const base = runBacktest(TRADED, 'bollinger-breakout', { startingBalance: 10_000 })
    const big = runBacktest(TRADED, 'bollinger-breakout', { startingBalance: 25_000 })

    expect(big.stats.totalNetProfitPct).toBeCloseTo(base.stats.totalNetProfitPct, 9)
    expect(big.stats.expectancyPct).toBeCloseTo(base.stats.expectancyPct, 9)
    expect(big.stats.maxDrawdownPct).toBeCloseTo(base.stats.maxDrawdownPct, 9)
    expect(big.stats.annualReturnPct).not.toBeNull()
    expect(big.stats.annualReturnPct!).toBeCloseTo(base.stats.annualReturnPct!, 9)
    expect(big.stats.winRatePct).toBe(base.stats.winRatePct)
    expect(big.stats.profitFactor).toBeCloseTo(base.stats.profitFactor, 9)
    expect(big.stats.sharpeRatio).toBeCloseTo(base.stats.sharpeRatio, 9)
  })

  it('buys the benchmark with the same capital as the strategy', () => {
    // Buy & hold is the line the equity curve is compared against. Funding one side and not the
    // other turns the comparison into a chart of two different account sizes.
    const result = runBacktest(TRADED, 'bollinger-breakout', { startingBalance: 25_000 })
    const warmupClose = TRADED[result.stats.warmupBars].close
    const last = TRADED[TRADED.length - 1]

    expect(result.benchmarkCurve[result.benchmarkCurve.length - 1].value).toBeCloseTo(
      (25_000 / warmupClose) * last.close,
      6
    )
  })

  it('reports the given balance on a run with no candles at all', () => {
    // finishingBalance has no equity curve to read here and falls back to the starting balance.
    // Falling back to the default instead would report a loss the user never took.
    const result = runBacktest([], 'bollinger-breakout', { startingBalance: 25_000 })

    expect(result.stats.startingBalance).toBe(25_000)
    expect(result.stats.finishingBalance).toBe(25_000)
    expect(result.stats.totalNetProfit).toBe(0)
    expect(result.stats.totalNetProfitPct).toBe(0)
  })

  it('runs at the default when handed a balance it cannot use', () => {
    const nan = runBacktest(TRADED, 'bollinger-breakout', { startingBalance: Number.NaN })
    const good = runBacktest(TRADED, 'bollinger-breakout')

    expect(nan.stats.startingBalance).toBe(DEFAULT_STARTING_BALANCE)
    expect(nan.stats.totalNetProfit).toBeCloseTo(good.stats.totalNetProfit, 9)
    // Every figure, not just the one reported back -- a NaN reaching the equity curve would
    // poison the drawdown and Sharpe too, and those are not obviously wrong on sight.
    expect(Number.isFinite(nan.stats.maxDrawdownPct)).toBe(true)
    expect(nan.equityCurve.every((p) => Number.isFinite(p.value))).toBe(true)
    expect(nan.benchmarkCurve.every((p) => Number.isFinite(p.value))).toBe(true)
  })
})
