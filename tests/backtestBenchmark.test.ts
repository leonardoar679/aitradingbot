import { describe, it, expect } from 'vitest'
import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'

const STARTING_BALANCE = 10000
const HOUR4 = 4 * 60 * 60

/** Price doubles across the warm-up stretch, then stays flat. Buy & hold anchored at candle 0
 * would book that doubling; anchored where the strategy can first trade, it books none of it. */
function candlesWithRunUpDuringWarmup(total: number, warmup: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < total; i++) {
    const price = i < warmup ? 100 + (100 * i) / warmup : 200
    out.push({ time: 1_600_000_000 + i * HOUR4, open: price, high: price, low: price, close: price, volume: 1 })
  }
  return out
}

describe('buy & hold benchmark', () => {
  const total = 400
  const result = runBacktest(candlesWithRunUpDuringWarmup(total, 200), 'ema-cross-atr-stop')
  const bench = result.benchmarkCurve

  it('reports the warm-up length the strategy could not trade in', () => {
    expect(result.stats.warmupBars).toBe(200)
  })

  it('starts at the same value as the strategy, on the same candle', () => {
    expect(bench[0].value).toBe(STARTING_BALANCE)
    expect(result.equityCurve[0].value).toBe(STARTING_BALANCE)
    expect(bench[0].time).toBe(result.equityCurve[0].time)
  })

  it('has one point per candle, aligned with the equity curve', () => {
    expect(bench).toHaveLength(total)
    expect(bench).toHaveLength(result.equityCurve.length)
  })

  // The bug: anchored at candles[0], buy & hold banked the whole warm-up run-up before the
  // strategy was allowed to place an order. Measured on real BTC 1d data for 2023, that head
  // start was +79.4% over 55% of the requested range.
  it('does not bank the run-up that happened during warm-up', () => {
    for (let i = 0; i < result.stats.warmupBars; i++) {
      expect(bench[i].value, `candle ${i}`).toBe(STARTING_BALANCE)
    }
    expect(bench[bench.length - 1].value).toBe(STARTING_BALANCE)
  })

  it('does track price once the strategy is able to trade', () => {
    const rising: Candle[] = []
    for (let i = 0; i < 400; i++) {
      const price = i < 200 ? 100 : 100 + (i - 200)
      rising.push({ time: 1_600_000_000 + i * HOUR4, open: price, high: price, low: price, close: price, volume: 1 })
    }
    const r = runBacktest(rising, 'ema-cross-atr-stop')
    const b = r.benchmarkCurve
    expect(b[200].value).toBeCloseTo(STARTING_BALANCE, 6)
    // Price runs 100 -> 299 after warm-up, so buy & hold roughly triples from its anchor.
    expect(b[b.length - 1].value).toBeCloseTo(STARTING_BALANCE * (299 / 100), 6)
  })

  it('stays flat for a range entirely inside the warm-up', () => {
    const shortRun: Candle[] = []
    for (let i = 0; i < 50; i++) {
      const price = 100 + i
      shortRun.push({ time: 1_600_000_000 + i * HOUR4, open: price, high: price, low: price, close: price, volume: 1 })
    }
    const r = runBacktest(shortRun, 'ema-cross-atr-stop')
    expect(r.trades).toHaveLength(0)
    for (const point of r.benchmarkCurve.slice(0, -1)) expect(point.value).toBe(STARTING_BALANCE)
  })

  it('handles an empty candle set without producing a curve', () => {
    const r = runBacktest([], 'ema-cross-atr-stop')
    expect(r.benchmarkCurve).toHaveLength(0)
  })
})
