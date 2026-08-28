import { describe, expect, it } from 'vitest'
import { STRATEGIES, getStrategy, DEFAULT_STRATEGY_ID } from '../src/backtest/strategies'
import { INTERVALS, INTERVAL_SECONDS, type Interval } from '../shared/ipc'

// preferredInterval is the second promise a strategy makes to its callers, alongside
// warmupBarsFor: "this is the bar size I was measured on". It exists because the app previously
// had THREE hardcoded and mutually inconsistent answers -- the Backtest page opened on 15m, a
// bot's paper dry run polled 4h, and Routines used DEFAULT_INTERVAL -- so a bot could be created
// from a backtest at one bar size and then paper-traded at another. The backtest that justified
// the bot was then a backtest of something else.
//
// These tests pin the properties every caller relies on. They deliberately do NOT assert the
// specific measured values (1h, 15m); those belong to research/ivfair.ts and are expected to
// change when re-measured, whereas everything below must hold whatever the measurement says.

const VALID: Interval[] = INTERVALS.map((i) => i.id)

describe('every strategy declares a usable preferred interval', () => {
  it('names an interval the app can actually fetch', () => {
    // A typo here -- '1H', '60m', '3m' -- would typecheck against a widened string but produce a
    // fetch for an interval no exchange adapter maps, which surfaces as an empty candle list and
    // therefore as "0 trades" rather than as an error.
    for (const s of STRATEGIES) {
      expect(VALID, `${s.id} declares ${s.preferredInterval}`).toContain(s.preferredInterval)
    }
  })

  it('can warm up inside the Backtest page default 90-day range', () => {
    // The failure this guards is the one types.ts describes at length: a strategy needing more
    // history than the default range provides spends the whole window warming up, reports zero
    // trades, and reads exactly like a strategy that does not work. Trend Regime needs 80 days,
    // so the margin here is real but thin -- which is the point of pinning it.
    const NINETY_DAYS = 90 * 86_400
    for (const s of STRATEGIES) {
      const barSec = INTERVAL_SECONDS[s.preferredInterval]
      const warmupSec = s.warmupBarsFor(barSec) * barSec
      expect(warmupSec, `${s.id} warms up in ${(warmupSec / 86_400).toFixed(0)}d`).toBeLessThan(NINETY_DAYS)
    }
  })

  it('leaves enough bars after warmup to produce signals', () => {
    // Warming up inside the range is not sufficient: a strategy that finishes warming with four
    // bars to spare cannot show anything either. Requires at least a tenth of the window.
    const NINETY_DAYS = 90 * 86_400
    for (const s of STRATEGIES) {
      const barSec = INTERVAL_SECONDS[s.preferredInterval]
      const tradeableSec = NINETY_DAYS - s.warmupBarsFor(barSec) * barSec
      expect(tradeableSec, `${s.id}`).toBeGreaterThan(NINETY_DAYS / 10)
    }
  })
})

describe('the interval follows the strategy', () => {
  it('gives the default strategy a concrete interval rather than a shared constant', () => {
    expect(VALID).toContain(getStrategy(DEFAULT_STRATEGY_ID).preferredInterval)
  })

  it('lets different strategies disagree about the right bar size', () => {
    // The whole reason this is per-strategy rather than one app-wide default. If every strategy
    // ever agreed, a single constant would be correct and this field would be dead weight --
    // so this asserts the field is doing work, not that any particular pair differs.
    const distinct = new Set(STRATEGIES.map((s) => s.preferredInterval))
    expect(distinct.size).toBeGreaterThan(1)
  })

  it('falls back to a real interval for an unknown strategy id', () => {
    // getStrategy falls through to a default rather than throwing, and callers immediately read
    // .preferredInterval off whatever comes back. An undefined there becomes an undefined
    // interval in a fetch URL.
    expect(VALID).toContain(getStrategy('no-such-strategy').preferredInterval)
  })
})
