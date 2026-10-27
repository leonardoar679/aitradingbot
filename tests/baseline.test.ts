import { describe, expect, it } from 'vitest'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import { BASELINE_BAR_SEC, BASELINE_LINES, baselineExitOf, baselineFreshAt, baselineOpenNetOf, baselineResultOf, type BaselineStamp } from '../shared/baseline'
import type { Candle } from '../shared/ipc'

// THE BASELINE'S ARITHMETIC (shared/baseline.ts; V8 Stage 9): which of Trend Regime Ensemble's entry signals a run
// takes -- at a bar closed after its Start, never on a regime already standing then until it has broken -- where a
// trade leaves, read from its bars as the backtest engine reads them, and what it made after the taker fee each way.

const BAR = BASELINE_BAR_SEC
const T0 = Date.UTC(2026, 0, 1) / 1000

const bar = (time: number, open: number, high: number, low: number, close = open): Candle => ({ time, open, high, low, close, volume: 1 })

/** A series of closes as 4-hour bars, each opening at the close before it. */
function seriesOf(closes: number[]): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]
    return bar(T0 + i * BAR, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close)
  })
}

const line = (from: number, to: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n)

describe('the strategy the baseline runs', () => {
  it('is Trend Regime Ensemble at its own interval, its warm-up read from it', () => {
    expect(trendRegimeEnsemble.id).toBe(BASELINE_LINES.strategy)
    expect(trendRegimeEnsemble.preferredInterval).toBe(BASELINE_LINES.interval)
    expect(BAR).toBe(4 * 3600)
    expect(trendRegimeEnsemble.warmupBarsFor(BAR)).toBe(480)
  })
})

describe('an entry the run takes', () => {
  // Down for 600 bars, up for 200 (the four lookbacks agree), down for 100 (they no longer do), up again.
  const bars = seriesOf([...line(300, 100, 600), ...line(100, 400, 200), ...line(400, 150, 100), ...line(150, 600, 200)])
  const signals = trendRegimeEnsemble.generateSignals(bars)
  const first = signals.entries.findIndex((entry, i) => entry && i >= signals.warmupBars)
  const broken = signals.entries.findIndex((entry, i) => i > first && !entry)
  const again = signals.entries.findIndex((entry, i) => i > broken && entry)
  const fresh = (index: number, startedAtSec: number): boolean => baselineFreshAt({ bars, entries: signals.entries, warmupBars: signals.warmupBars, index, startedAtSec })

  it('is a signal at a bar that closed after the Start, the regime not standing then', () => {
    expect(first).toBeGreaterThan(600)
    expect(broken).toBeGreaterThan(first + 3)
    expect(again).toBeGreaterThan(broken)
    // Started while the regime was off: its first entry is the run's.
    const startedAt = bars[first - 5].time + BAR + 60
    expect(fresh(first, startedAt)).toBe(true)
    // So is the bar forming at the Start, which closed after it, the regime off at the last close before.
    expect(signals.entries[first - 1]).toBe(false)
    expect(fresh(first, bars[first].time + 60)).toBe(true)
    // A bar that closed before the Start, or at it, is not.
    expect(fresh(first, bars[first].time + BAR)).toBe(false)
    expect(fresh(first, bars[first].time + BAR + 1)).toBe(false)
  })

  it('is never one of a regime standing at the Start, until that regime has broken', () => {
    const startedAt = bars[first + 2].time + BAR + 60
    expect(signals.entries[first + 2]).toBe(true)
    expect(fresh(first + 3, startedAt)).toBe(false)
    expect(fresh(broken - 1, startedAt)).toBe(false)
    expect(fresh(again, startedAt)).toBe(true)
  })

  it('is none where the strategy could not yet be read at the Start', () => {
    expect(fresh(first, bars[signals.warmupBars - 2].time + BAR)).toBe(false)
    expect(fresh(-1, T0)).toBe(false)
    expect(fresh(bars.length, T0)).toBe(false)
  })
})

describe("a trade's exit", () => {
  const stamp = { signalBarSec: T0, stopPx: 90 }
  it('reads only the bars after its signal, its stop before its exit signal in one bar, a gap at the open', () => {
    const bars = [bar(T0, 100, 101, 50), bar(T0 + BAR, 100, 102, 98, 101), bar(T0 + 2 * BAR, 99, 100, 89, 95), bar(T0 + 3 * BAR, 95, 96, 94)]
    // The signal bar's own low of 50 is before the entry: not read.
    expect(baselineExitOf(stamp, bars, [false, false, true, true])).toEqual({ reason: 'stop', px: 90, atSec: T0 + 3 * BAR, barTime: T0 + 2 * BAR })
    expect(baselineExitOf(stamp, [bars[0], bar(T0 + BAR, 85, 86, 80)], [false, false])).toMatchObject({ reason: 'stop', px: 85 })
    expect(baselineExitOf(stamp, bars, [false, true, false, false])).toEqual({ reason: 'signal', px: 101, atSec: T0 + 2 * BAR, barTime: T0 + BAR })
    // An exit signal at the signal bar itself is not read either.
    expect(baselineExitOf(stamp, bars.slice(0, 2), [true, false])).toBeNull()
  })
})

describe("a trade's result", () => {
  const stamp: Pick<BaselineStamp, 'entryPx' | 'qty' | 'stakeQuote' | 'feesQuote'> = { entryPx: 100, qty: 12.5, stakeQuote: 1250, feesQuote: 1.25 }
  it('is its move on its size after the taker fee each way, and no funding', () => {
    const result = baselineResultOf(stamp, { px: 110, atSec: T0 })
    expect(result.feesQuote).toBeCloseTo(1.25 + 0.001 * 1375, 12)
    expect(result.netQuote).toBeCloseTo(125 - 1.25 - 1.375, 12)
    expect(result.netPct).toBeCloseTo(((125 - 2.625) / 1250) * 100, 12)
    expect(result).toMatchObject({ fundingQuote: 0, closedAt: T0 })
    expect(baselineOpenNetOf(stamp, 90)).toBeCloseTo(-125 - 1.25 - 1.125, 12)
  })
})
