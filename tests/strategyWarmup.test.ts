import { describe, expect, it } from 'vitest'
import { STRATEGIES, getStrategy } from '../src/backtest/strategies'
import type { Candle } from '../shared/ipc'

// warmupBarsFor is a promise made to every caller that fetches candles: "fetch me this much
// history and I will be able to trade". Nothing enforces that promise at the type level -- it is
// declared in one place and computed in another -- so the drift is what these tests exist to
// catch. A declared warmup that is too SMALL is the dangerous direction: the caller fetches a
// window the strategy cannot trade in, the run reports zero trades, and on screen that is
// indistinguishable from a strategy whose rules simply never fired.

const M15 = 900
const H4 = 4 * 3600
const D1 = 86_400

function series(barSeconds: number, count: number, priceAt: (i: number) => number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = priceAt(i)
    return { time: 1_700_000_000 + i * barSeconds, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 }
  })
}

describe('every registered strategy declares its warmup honestly', () => {
  for (const strategy of STRATEGIES) {
    it(`${strategy.name}: declared warmup covers what generateSignals actually needs`, () => {
      for (const barSeconds of [M15, H4, D1]) {
        const declared = strategy.warmupBarsFor(barSeconds)
        expect(Number.isFinite(declared)).toBe(true)
        expect(declared).toBeGreaterThan(0)

        // A rising series long enough to clear the declared warmup with room to spare.
        const candles = series(barSeconds, declared + 400, (i) => 100 + i * 0.05)
        const actual = strategy.generateSignals(candles).warmupBars
        // Declaring MORE than needed only wastes a little history; declaring less breaks callers.
        expect(declared).toBeGreaterThanOrEqual(actual)
      }
    })

    it(`${strategy.name}: leaves bars to trade on in a window sized by its own declaration`, () => {
      // The promise, end to end: fetch what the strategy asked for plus a window, and the window
      // must survive its warm-up. This is deliberately about the warm-up and NOT about whether
      // the rules fire -- see the note on the fires-at-all test below.
      const declared = strategy.warmupBarsFor(H4)
      const candles = series(H4, declared + 300, (i) => 100 + i * 0.4)
      const tradeable = candles.length - strategy.generateSignals(candles).warmupBars
      expect(tradeable).toBeGreaterThan(0)
    })
  }
})

describe('a window sized by the declaration is enough to actually trade in', () => {
  /** A drifting random walk rather than a straight line. A linear ramp is degenerate for all
   * three of the original strategies at once and reports zero entries for every one of them: it
   * produces no EMA crossover after warm-up, never takes RSI oversold, and on a perfectly
   * straight ramp the close cannot clear the Bollinger upper band at all (the SMA lags by about
   * 9.5 bars of slope while two standard deviations of the same ramp is about 11.5). Testing a
   * fill model against a series nothing fires on proves nothing. */
  function wobblyUptrend(barSeconds: number, count: number): Candle[] {
    let seed = 7
    let price = 100
    return Array.from({ length: count }, (_, i) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      const noise = (seed / 2147483648) * 2 - 1
      price *= 1 + 0.0015 + noise * 0.02
      return { time: 1_700_000_000 + i * barSeconds, open: price, high: price * 1.01, low: price * 0.99, close: price, volume: 1 }
    })
  }

  // RSI Mean-Reversion is excluded, and its absence is the point rather than an oversight: it is
  // documented in its own file as never trading on real data -- across 5,500 candles of BTC/ETH/
  // SOL there was not one bar where RSI(14) sat at or below 30 while price was above the EMA(100),
  // and the repairs were measured and rejected. A test asserting it fires would be asserting a
  // bug were it ever fixed.
  for (const strategy of STRATEGIES.filter((s) => s.id !== 'rsi-reversion' && !s.requiresExternalSignals)) {
    it(`${strategy.name} produces entries after its declared warmup`, () => {
      const declared = strategy.warmupBarsFor(H4)
      const candles = wobblyUptrend(H4, declared + 300)
      const signals = strategy.generateSignals(candles)
      const actionable = signals.entries.filter((e, i) => e && signals.stopPrices[i] !== null)
      expect(actionable.length).toBeGreaterThan(0)
    })
  }
})

describe('warmup scales the way each strategy defines itself', () => {
  it('a bar-count strategy needs the same number of bars whatever they are', () => {
    // EMA(200) is 200 bars of anything -- which is exactly why it means 33 days on 4h and 2 days
    // on 15m, and why it behaves so differently across timeframes.
    const s = getStrategy('ema-cross-atr-stop')
    expect(s.warmupBarsFor(M15)).toBe(s.warmupBarsFor(H4))
    expect(s.warmupBarsFor(H4)).toBe(s.warmupBarsFor(D1))
  })

  it('a day-based strategy needs more bars as the candles get finer', () => {
    const s = getStrategy('trend-regime-ensemble')
    // Same wall-clock span in every case, so the bar count scales exactly with bar size.
    expect(s.warmupBarsFor(M15) * M15).toBe(s.warmupBarsFor(H4) * H4)
    expect(s.warmupBarsFor(H4) * H4).toBe(s.warmupBarsFor(D1) * D1)
    expect(s.warmupBarsFor(M15)).toBeGreaterThan(s.warmupBarsFor(D1))
  })

  it('survives a nonsense bar size rather than returning NaN into a fetch window', () => {
    // The caller multiplies this by a bar size to build a start timestamp. NaN there produces a
    // fetch range that silently returns nothing, which is the failure this whole file is about.
    for (const s of STRATEGIES) {
      for (const bad of [0, -1, NaN]) {
        expect(Number.isFinite(s.warmupBarsFor(bad))).toBe(true)
      }
    }
  })
})
