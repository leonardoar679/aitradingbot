import { describe, expect, it } from 'vitest'
import { SLIPPAGE_RATE, buyFillPrice, sellFillPrice, FEE_RATE } from '../shared/fees'
import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'

// Slippage is the second half of what a fill costs, and the half that is easy to get subtly
// wrong: applied in the wrong direction it becomes free money, applied twice it double-charges a
// single sell, and applied to a liquidation it reports a price the account never traded at.

const H4 = 4 * 3600
const START = 1_700_000_000

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    time: START + i * H4,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1
  }))
}

describe('the direction of slippage', () => {
  it('makes a buy pay more and a sell receive less', () => {
    expect(buyFillPrice(100)).toBeGreaterThan(100)
    expect(sellFillPrice(100)).toBeLessThan(100)
  })

  it('never helps the trader in either direction', () => {
    // The one asymmetry that has to hold. A model where slippage sometimes improved a fill would
    // let a strategy earn money out of the noise in its own cost assumptions -- and it would earn
    // most from whichever strategy trades most, which is precisely backwards.
    for (const price of [0.0001, 1, 100, 78_000]) {
      expect(buyFillPrice(price)).toBeGreaterThanOrEqual(price)
      expect(sellFillPrice(price)).toBeLessThanOrEqual(price)
    }
  })

  it('is far smaller than the fee, which is the cost that actually decides intraday strategies', () => {
    // Documented in shared/fees.ts and worth pinning: if these ever invert, the comment
    // explaining why Bollinger Breakout loses 98% to fees stops being true.
    expect(SLIPPAGE_RATE).toBeLessThan(FEE_RATE)
  })
})

describe('slippage in a backtest', () => {
  // Flat long enough to warm EMA(200), then up (which produces a bullish cross above the regime
  // line, so an entry), then down (a bearish cross, so a signal exit). A monotonic ramp is no use
  // here: its only crossover happens during warmup, so it never trades at all -- which is how the
  // first version of these two tests came to pass on an empty trade list.
  const RAMP = candles([
    ...Array.from({ length: 260 }, (_, i) => 100 + (i % 2 === 0 ? 0.4 : -0.4)),
    ...Array.from({ length: 160 }, (_, i) => 100 + i * 0.5),
    ...Array.from({ length: 160 }, (_, i) => 180 - i * 0.5)
  ])

  it('records an entry above the close it was signalled from, not at it', () => {
    const r = runBacktest(RAMP, 'ema-cross-atr-stop', { startingBalance: 10_000 })
    const byTime = new Map(RAMP.map((c) => [c.time, c]))
    expect(r.trades.length).toBeGreaterThan(0)
    for (const t of r.trades) {
      const signalBar = byTime.get(t.entryTime)
      if (!signalBar) throw new Error('entry time is not a candle in the series')
      // The whole point: the strategy decided on this bar's close, and paid more than it.
      expect(t.entryPrice).toBeCloseTo(buyFillPrice(signalBar.close), 8)
      expect(t.entryPrice).toBeGreaterThan(signalBar.close)
    }
  })

  it('leaves a signal exit below the close it was signalled from', () => {
    const r = runBacktest(RAMP, 'ema-cross-atr-stop', { startingBalance: 10_000 })
    const byTime = new Map(RAMP.map((c) => [c.time, c]))
    const signalExits = r.trades.filter((t) => t.exitReason === 'signal')
    expect(signalExits.length).toBeGreaterThan(0)
    for (const t of signalExits) {
      const bar = byTime.get(t.exitTime)
      if (!bar) throw new Error('exit time is not a candle in the series')
      expect(t.exitPrice).toBeCloseTo(sellFillPrice(bar.close), 8)
      expect(t.exitPrice).toBeLessThan(bar.close)
    }
  })

  it('is charged once on a stop exit, not twice', () => {
    // The stop path applies slippage early, because the decision about whether the stop beat the
    // liquidation level needs the true fill. closePosition must therefore NOT apply it again --
    // a double charge would be invisible in a total and wrong in every stop-heavy strategy.
    const rising = [
      ...Array.from({ length: 260 }, (_, i) => 100 + (i % 2 === 0 ? 0.4 : -0.4)),
      ...Array.from({ length: 160 }, (_, i) => 100 + i * 0.5)
    ]
    const gapDown: Candle[] = [
      ...candles(rising),
      { time: START + rising.length * H4, open: 60, high: 60, low: 55, close: 58, volume: 1 }
    ]
    const r = runBacktest(gapDown, 'ema-cross-atr-stop', { startingBalance: 10_000 })
    const stopped = r.trades.find((t) => t.exitReason === 'stop_loss')
    // Asserted rather than skipped: a `return` here would let this test pass by finding nothing,
    // which is exactly how the two above first went green against an empty trade list.
    if (!stopped) throw new Error('expected the gap-down to trigger a stop-loss exit')
    // One application of the rate off the open, not two.
    expect(stopped.exitPrice).toBeCloseTo(sellFillPrice(60), 8)
    expect(stopped.exitPrice).not.toBeCloseTo(sellFillPrice(sellFillPrice(60)), 8)
  })

  it('leaves a run that never trades exactly where it started', () => {
    // Slippage must be a property of fills, not of time. A flat market with no signals has no
    // fills, so it must cost nothing at all.
    const flat = candles(new Array(400).fill(100))
    const r = runBacktest(flat, 'ema-cross-atr-stop', { startingBalance: 10_000 })
    expect(r.stats.totalClosedTrades).toBe(0)
    expect(r.stats.finishingBalance).toBe(10_000)
  })
})
