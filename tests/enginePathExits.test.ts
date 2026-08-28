import { describe, expect, it } from 'vitest'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'
import type { Candle } from '../shared/ipc'

// The two PATH-DEPENDENT exits: a give-back trailing exit and a re-entry cooldown.
//
// They live in the engine rather than in a strategy because `generateSignals` sees candles and
// nothing else -- it cannot know when the position opened, how far up it is, or when the last one
// closed. Both were added to measure two hypotheses that research/diag.ts raised, and BOTH WERE
// REJECTED: neither improved either shipped strategy on the training window, so nothing in the app
// passes these options today. They stay because the negative results are only reproducible if the
// mechanism that measured them still exists, and an untested engine option is worse than none.
//
// The first test is the one that matters most: absent options must leave every run bit-identical.

const BAR = 3600
const START = 1_700_000_000

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]
    return { time: START + i * BAR, open: prev, high: Math.max(c, prev), low: Math.min(c, prev), close: c, volume: 1 }
  })
}

/** A scripted strategy, so a test asserts the engine's behaviour rather than a real strategy's.
 * Entries and exits are given as bar indices; the stop is far enough away never to fire. */
function scripted(id: string, entries: number[], exits: number[], stopFraction = 0.5): string {
  const def = {
    id,
    name: id,
    description: 'test fixture',
    warmupBarsFor: () => 0,
    generateSignals(candles: Candle[]) {
      const n = candles.length
      return {
        entries: Array.from({ length: n }, (_, i) => entries.includes(i)),
        exits: Array.from({ length: n }, (_, i) => exits.includes(i)),
        stopPrices: Array.from({ length: n }, (_, i) => (entries.includes(i) ? candles[i].close * stopFraction : null)),
        warmupBars: 0
      }
    }
  }
  const at = STRATEGIES.findIndex((s) => s.id === id)
  if (at >= 0) STRATEGIES[at] = def
  else STRATEGIES.push(def)
  return id
}

// Enter at bar 1, ride to 130, fall back. No signal exit at all, so only a path-dependent rule or
// the end-of-data close can end this trade.
const RISE_THEN_FADE = [100, 100, 110, 120, 130, 125, 120, 117, 110, 105, 104, 103]
const RIDE = scripted('t-ride', [1], [])

describe('trailing give-back exit', () => {
  it('changes nothing at all when the option is absent', () => {
    // The property everything else depends on: an inert option cannot alter an existing run.
    const before = runBacktest(series(RISE_THEN_FADE), RIDE, { startingBalance: 10_000 })
    const after = runBacktest(series(RISE_THEN_FADE), RIDE, { startingBalance: 10_000, trailing: undefined })
    expect(after.stats.finishingBalance).toBe(before.stats.finishingBalance)
    expect(after.trades).toEqual(before.trades)
    expect(before.trades.every((t) => t.exitReason !== 'trailing')).toBe(true)
  })

  it('exits when the close falls the given percentage from its best', () => {
    // Peak close is 130 at bar 4. A 10% give-back exits on the first close at or below 117.
    const r = runBacktest(series(RISE_THEN_FADE), RIDE, {
      startingBalance: 10_000,
      trailing: { armAtPct: 5, giveBackPct: 10 }
    })
    expect(r.trades).toHaveLength(1)
    expect(r.trades[0].exitReason).toBe('trailing')
    expect(r.trades[0].exitTime).toBe(START + 7 * BAR)
  })

  it('measures the give-back from the peak, not from the entry', () => {
    // Entry is at 100 and the exit fires at 117, which is +17% on the entry. A rule anchored to
    // the entry could never produce that; only one anchored to the 130 peak can.
    const r = runBacktest(series(RISE_THEN_FADE), RIDE, {
      startingBalance: 10_000,
      trailing: { armAtPct: 5, giveBackPct: 10 }
    })
    expect(r.trades[0].returnPct).toBeGreaterThan(10)
  })

  it('stays inert until the trade has been up by the arming threshold', () => {
    // Armed at +50% the trade never qualifies -- it peaks at +30% -- so the position runs to the
    // end of the data exactly as it would with no trailing exit at all.
    const armed = runBacktest(series(RISE_THEN_FADE), RIDE, {
      startingBalance: 10_000,
      trailing: { armAtPct: 50, giveBackPct: 10 }
    })
    const none = runBacktest(series(RISE_THEN_FADE), RIDE, { startingBalance: 10_000 })
    expect(armed.trades[0].exitReason).toBe('end_of_data')
    expect(armed.stats.finishingBalance).toBe(none.stats.finishingBalance)
  })

  it('never fires on the same bar that set the peak', () => {
    // A monotonic rise sets a new peak every bar, so no bar can be `giveBackPct` below its own
    // peak. Getting the update order wrong here would close every trade immediately.
    const rising = scripted('t-rising', [1], [])
    const r = runBacktest(series([100, 100, 110, 120, 130, 140, 150]), rising, {
      startingBalance: 10_000,
      trailing: { armAtPct: 0, giveBackPct: 1 }
    })
    expect(r.trades[0].exitReason).toBe('end_of_data')
  })

  it('lets the strategy’s own exit win when both fire on the same bar', () => {
    // The strategy's rule is the primary one; the give-back only catches what it is still holding.
    const withExit = scripted('t-both', [1], [7])
    const r = runBacktest(series(RISE_THEN_FADE), withExit, {
      startingBalance: 10_000,
      trailing: { armAtPct: 5, giveBackPct: 10 }
    })
    expect(r.trades[0].exitReason).toBe('signal')
  })

  it('ignores settings that cannot describe a working rule', () => {
    // 0% would exit on any tick down and 100% could never fire. Substituting a working value for
    // either would silently run a strategy the caller did not ask for, so both are dropped.
    const none = runBacktest(series(RISE_THEN_FADE), RIDE, { startingBalance: 10_000 })
    for (const giveBackPct of [0, -5, 100, 140, NaN]) {
      const r = runBacktest(series(RISE_THEN_FADE), RIDE, { startingBalance: 10_000, trailing: { armAtPct: 0, giveBackPct } })
      expect(r.stats.finishingBalance).toBe(none.stats.finishingBalance)
    }
  })
})

// Two separate round trips: in at 1 out at 3, in at 5 out at 7. The second entry is 2 bars after
// the first exit, so any cooldown longer than that blocks it.
const TWO_TRIPS = [100, 100, 110, 120, 118, 118, 130, 140, 140, 140]
const PAIR = scripted('t-pair', [1, 5], [3, 7])

describe('re-entry cooldown', () => {
  it('changes nothing at all when the option is absent', () => {
    const before = runBacktest(series(TWO_TRIPS), PAIR, { startingBalance: 10_000 })
    const after = runBacktest(series(TWO_TRIPS), PAIR, { startingBalance: 10_000, reentryCooldown: undefined })
    expect(after.trades).toEqual(before.trades)
    expect(before.trades).toHaveLength(2)
  })

  it('blocks a re-entry inside the cooldown', () => {
    const r = runBacktest(series(TWO_TRIPS), PAIR, { startingBalance: 10_000, reentryCooldown: { bars: 4 } })
    expect(r.trades).toHaveLength(1)
  })

  it('allows it once the cooldown has passed', () => {
    const r = runBacktest(series(TWO_TRIPS), PAIR, { startingBalance: 10_000, reentryCooldown: { bars: 2 } })
    expect(r.trades).toHaveLength(2)
  })

  it('never holds back the first trade of a run', () => {
    // There is no previous exit to wait after, so a long cooldown must not swallow the opening
    // entry -- which is what a naive "bars since last exit, defaulting to zero" would do.
    const r = runBacktest(series(TWO_TRIPS), PAIR, { startingBalance: 10_000, reentryCooldown: { bars: 10_000 } })
    expect(r.trades).toHaveLength(1)
    expect(r.trades[0].entryTime).toBe(START + 1 * BAR)
  })

  it('waits only after a losing exit when asked to', () => {
    // First trip wins (100 -> 120), so afterLossOnly must let the second entry straight through.
    const r = runBacktest(series(TWO_TRIPS), PAIR, {
      startingBalance: 10_000,
      reentryCooldown: { bars: 4, afterLossOnly: true }
    })
    expect(r.trades).toHaveLength(2)
  })

  it('does wait after a losing exit under the same setting', () => {
    // Same shape, but the first trip loses (100 -> 90), so the cooldown applies.
    const losing = scripted('t-losing', [1, 5], [3, 7])
    const r = runBacktest(series([100, 100, 95, 90, 92, 92, 130, 140, 140, 140]), losing, {
      startingBalance: 10_000,
      reentryCooldown: { bars: 4, afterLossOnly: true }
    })
    expect(r.trades).toHaveLength(1)
    expect(r.trades[0].returnPct).toBeLessThan(0)
  })

  it('ignores a cooldown that is not a positive number of bars', () => {
    const before = runBacktest(series(TWO_TRIPS), PAIR, { startingBalance: 10_000 })
    for (const bars of [0, -5, NaN]) {
      const r = runBacktest(series(TWO_TRIPS), PAIR, { startingBalance: 10_000, reentryCooldown: { bars } })
      expect(r.trades).toHaveLength(before.trades.length)
    }
  })
})
