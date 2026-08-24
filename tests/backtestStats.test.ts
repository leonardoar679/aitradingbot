import { describe, expect, it } from 'vitest'
import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'

// The Backtest results page is thirty-odd numbers, and they are what a beginner uses to decide
// whether a strategy deserves real money. The existing engine tests pin the execution model --
// fills, fees, stops, annualization guards -- but nothing pinned the statistics computed from
// those trades. Inverting win rate to count losers, flipping profit factor, or reversing the
// sign of net profit all left the suite green.

const H4 = 4 * 3600
const START = 1_700_000_000

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]
    return { time: START + i * H4, open: prev, high: Math.max(c, prev), low: Math.min(c, prev), close: c, volume: 1 }
  })
}

// Bollinger Breakout needs only 20 warmup bars, so a flat stretch then a jump above the upper
// band forces a deterministic long entry.
const FLAT_THEN_BREAKOUT = [...Array(30).fill(100), 110, ...Array(20).fill(112)]

/** Breakout, then a long climb -- one trade, closed in profit at end of data. */
const WINNING = series([...FLAT_THEN_BREAKOUT, ...Array(15).fill(130)])

/** Breakout, then a collapse -- one trade, stopped out well below entry. */
const LOSING = series([...FLAT_THEN_BREAKOUT, ...Array(15).fill(80)])

describe('backtest statistics', () => {
  it('reports a profitable run as profitable', () => {
    const { stats, trades } = runBacktest(WINNING, 'bollinger-breakout')
    expect(trades.length).toBeGreaterThan(0)
    // Sign, not magnitude: `finishingBalance - STARTING_BALANCE` reversed still produced a
    // plausible-looking number on every existing test.
    expect(stats.totalNetProfit).toBeGreaterThan(0)
    expect(stats.totalNetProfitPct).toBeGreaterThan(0)
  })

  it('reports a losing run as losing', () => {
    const { stats } = runBacktest(LOSING, 'bollinger-breakout')
    expect(stats.totalNetProfit).toBeLessThan(0)
    expect(stats.totalNetProfitPct).toBeLessThan(0)
  })

  it('counts winners, not losers, in the win rate', () => {
    expect(runBacktest(WINNING, 'bollinger-breakout').stats.winRatePct).toBe(100)
    expect(runBacktest(LOSING, 'bollinger-breakout').stats.winRatePct).toBe(0)
  })

  it('keeps every trade count consistent with the trades it returned', () => {
    const { stats, trades } = runBacktest(LOSING, 'bollinger-breakout')
    expect(stats.totalClosedTrades).toBe(trades.length)
    expect(stats.totalWinningTrades + stats.totalLosingTrades).toBe(trades.length)
  })

  it('divides profit by trade count for expectancy, not by starting balance', () => {
    const { stats } = runBacktest(WINNING, 'bollinger-breakout')
    expect(stats.expectancy).toBeCloseTo(stats.totalNetProfit / stats.totalClosedTrades, 8)
  })

  it('puts profit over loss in the profit factor, not the reverse', () => {
    // No losses at all -> the ratio has no denominator, which is reported as Infinity rather
    // than as a finite-looking number.
    expect(runBacktest(WINNING, 'bollinger-breakout').stats.profitFactor).toBe(Infinity)
    // No profit at all -> zero, and the inverted form would be Infinity here instead.
    expect(runBacktest(LOSING, 'bollinger-breakout').stats.profitFactor).toBe(0)
  })

  it('puts average win over average loss in the ratio, not the reverse', () => {
    // With no winners, avgWin is 0 and the ratio is 0; inverted it would divide by zero.
    expect(runBacktest(LOSING, 'bollinger-breakout').stats.avgWinLossRatio).toBe(0)
  })

  it('measures drawdown from the running peak, and reports it as a fall', () => {
    const { stats } = runBacktest(LOSING, 'bollinger-breakout')
    // Negative because it is a fall. Tracking the peak with `Math.max` over the curve is what
    // makes it non-zero at all -- resetting the peak to each point, or taking the max instead of
    // the min of the drops, both silently produce a flat 0.00% on a run that lost money.
    expect(stats.maxDrawdownPct).toBeLessThan(0)
  })

  it('reports only a shallow drawdown on a run that ends well up', () => {
    const { stats } = runBacktest(WINNING, 'bollinger-breakout')
    // Not zero: the entry fee is charged before the price moves, so the curve dips about a
    // tenth of a percent first. Drawdown is never positive, and on this run it stays tiny --
    // both of which the losing run above contradicts, which is the pairing that matters.
    expect(stats.maxDrawdownPct).toBeLessThanOrEqual(0)
    expect(stats.maxDrawdownPct).toBeGreaterThan(-1)
  })
})
