import { describe, expect, it } from 'vitest'
import { runBacktest, MIN_ANNUALIZATION_DAYS } from '../src/backtest/engine'
import { FEE_RATE, sellFillPrice } from '../shared/fees'
import type { Candle } from '../shared/ipc'

// Backtest results are the screen a beginner uses to decide whether a strategy is worth real
// money, so the numbers on it have to be honest about what they do and don't know. These tests
// pin the execution model (fills, fees, stops) and the guards that stop a short sample from
// being reported as if it described a year.

const H4 = 4 * 3600
const START = 1_700_000_000

/** Builds candles from a close series; each candle's range spans the move from the previous close. */
function series(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]
    return { time: START + i * H4, open: prev, high: Math.max(c, prev), low: Math.min(c, prev), close: c, volume: 1 }
  })
}

// Bollinger Breakout needs only 20 warmup bars (vs 200 for the EMA strategies), so a flat run-up
// followed by a jump above the upper band is the cheapest way to force a deterministic entry.
const FLAT_THEN_BREAKOUT = [...Array(30).fill(100), 110, ...Array(20).fill(112)]

/** A candle that opens at the prior close (112) and dips to `low` before recovering to it. */
function intrabarDrop(low: number): Candle[] {
  const time = START + FLAT_THEN_BREAKOUT.length * H4
  return [
    { time, open: 112, high: 112, low, close: low, volume: 1 },
    ...Array.from({ length: 10 }, (_, i) => ({
      time: time + (i + 1) * H4,
      open: low,
      high: low,
      low,
      close: low,
      volume: 1
    }))
  ]
}

/** A candle whose open is already far below the prior close — the whole move happened while the
 * market was untradeable, so there is no price between 112 and `openPrice` to fill at. */
function gapDown(openPrice: number): Candle[] {
  const time = START + FLAT_THEN_BREAKOUT.length * H4
  return Array.from({ length: 11 }, (_, i) => ({
    time: time + i * H4,
    open: openPrice,
    high: openPrice,
    low: openPrice,
    close: openPrice,
    volume: 1
  }))
}

describe('runBacktest — annualization guard', () => {
  it('withholds annual return and Calmar on a sample shorter than the minimum', () => {
    const result = runBacktest(series(FLAT_THEN_BREAKOUT.slice(0, 60)), 'bollinger-breakout')

    expect(result.stats.periodDays).toBeLessThan(MIN_ANNUALIZATION_DAYS)
    expect(result.stats.annualReturnPct).toBeNull()
    // Calmar is annual return / drawdown, so it has to be withheld for the same reason.
    expect(result.stats.calmarRatio).toBeNull()
  })

  it('reports annual return once the sample is long enough', () => {
    const closes = [...FLAT_THEN_BREAKOUT, ...Array(190).fill(112)]
    const result = runBacktest(series(closes), 'bollinger-breakout')

    expect(result.stats.periodDays).toBeGreaterThanOrEqual(MIN_ANNUALIZATION_DAYS)
    expect(result.stats.annualReturnPct).not.toBeNull()
    expect(Number.isFinite(result.stats.annualReturnPct as number)).toBe(true)
  })

  it('reports the span of the data it actually got, not the span it was asked for', () => {
    // 241 candles at 4h is exactly 40 days of spacing between first and last.
    const result = runBacktest(series(Array(241).fill(100)), 'bollinger-breakout')
    expect(result.stats.periodDays).toBeCloseTo(40, 6)
  })
})

describe('runBacktest — open position accounting', () => {
  it('counts no open trade when the final position is force-closed', () => {
    const result = runBacktest(series(FLAT_THEN_BREAKOUT), 'bollinger-breakout')

    expect(result.stats.openTrades).toBe(0)
    expect(result.trades.at(-1)?.exitReason).toBe('end_of_data')
  })

  it('counts the still-open position when force-close is off', () => {
    const result = runBacktest(series(FLAT_THEN_BREAKOUT), 'bollinger-breakout', { forceCloseAtEnd: false })

    expect(result.openPositionAtEnd).not.toBeNull()
    // Previously hardcoded to 0, which told a dry run holding a position that it held nothing.
    expect(result.stats.openTrades).toBe(1)
    expect(result.trades.some((t) => t.exitReason === 'end_of_data')).toBe(false)
  })
})

describe('runBacktest — execution model', () => {
  it('charges the fee on both entry and exit, so a flat round trip loses money', () => {
    const result = runBacktest(series(FLAT_THEN_BREAKOUT), 'bollinger-breakout', { forceCloseAtEnd: true })
    const roundTrip = result.trades.at(-1)
    if (!roundTrip) throw new Error('expected a trade')

    // Entry at 110, exit at 112 — a real gain, but both legs pay FEE_RATE of their notional.
    // Asserted as exact identities rather than "less than gross": a one-sided fee still comes
    // out below gross, so an inequality would not notice if one of the two legs stopped paying.
    expect(roundTrip.qty).toBeCloseTo((10000 * (1 - FEE_RATE)) / roundTrip.entryPrice, 10)
    expect(roundTrip.pnl).toBeCloseTo(roundTrip.qty * roundTrip.exitPrice * (1 - FEE_RATE) - 10000, 10)
    expect(result.stats.totalPaidFees).toBeCloseTo(
      10000 * FEE_RATE + roundTrip.qty * roundTrip.exitPrice * FEE_RATE,
      10
    )
  })

  it('fills a stop at the stop price when the candle trades through it', () => {
    // One sharp candle that opens at 112 and dips to 105 — through the ~108.57 ATR stop, but
    // opening above it, so a real stop order would have been filled at its own price.
    const candles = [...series(FLAT_THEN_BREAKOUT), ...intrabarDrop(105)]
    const result = runBacktest(candles, 'bollinger-breakout')
    const stopped = result.trades.find((t) => t.exitReason === 'stop_loss')
    if (!stopped) throw new Error('expected a stop-loss exit')

    expect(stopped.exitPrice).toBeGreaterThan(105)
    expect(stopped.exitPrice).toBeLessThan(112)
    // The stop is checked before the exit signal, so an intrabar stop always wins the candle.
    expect(stopped.exitTime).toBe(candles[FLAT_THEN_BREAKOUT.length].time)
  })

  it('fills a stop at the open when the candle gaps below it', () => {
    const candles = [...series(FLAT_THEN_BREAKOUT), ...gapDown(60)]
    const result = runBacktest(candles, 'bollinger-breakout')
    const stopped = result.trades.find((t) => t.exitReason === 'stop_loss')
    if (!stopped) throw new Error('expected a stop-loss exit')

    // A gap-down cannot fill at the stop price — a real stop order becomes a market order and
    // fills at the open. Reporting the stop price here would invent protection that didn't exist.
    // The open, then, minus the spread that market order gives up: a stop is the one exit that
    // pays slippage twice over, once by gapping and once by being a market order when it does.
    expect(stopped.exitPrice).toBe(sellFillPrice(60))
    expect(stopped.exitPrice).toBeLessThan(60)
    expect(stopped.pnl).toBeLessThan(0)
  })

  it('never re-enters on the same candle it stopped out on', () => {
    const candles = [...series(FLAT_THEN_BREAKOUT), ...gapDown(60)]
    const result = runBacktest(candles, 'bollinger-breakout')
    const stopped = result.trades.find((t) => t.exitReason === 'stop_loss')
    if (!stopped) throw new Error('expected a stop-loss exit')

    expect(result.trades.every((t) => t.entryTime !== stopped.exitTime)).toBe(true)
  })
})

describe('runBacktest — empty and degenerate input', () => {
  it('survives an empty candle set without producing NaN stats', () => {
    const result = runBacktest([], 'bollinger-breakout')

    expect(result.trades).toHaveLength(0)
    expect(result.stats.finishingBalance).toBe(10000)
    expect(result.stats.periodDays).toBe(0)
    expect(result.stats.annualReturnPct).toBeNull()
    expect(Number.isNaN(result.stats.totalNetProfitPct)).toBe(false)
    expect(Number.isNaN(result.stats.winRatePct)).toBe(false)
    expect(Number.isNaN(result.stats.sharpeRatio)).toBe(false)
  })

  it('produces no trades and a flat curve when price never moves', () => {
    const result = runBacktest(series(Array(241).fill(100)), 'bollinger-breakout')

    expect(result.trades).toHaveLength(0)
    expect(result.stats.finishingBalance).toBe(10000)
    expect(result.stats.maxDrawdownPct).toBe(0)
    expect(result.stats.profitFactor).toBe(0)
  })
})
