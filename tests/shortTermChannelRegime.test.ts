import { describe, expect, it } from 'vitest'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { shortTermChannelRegime } from '../src/backtest/strategies/shortTermChannelRegime'
import { regimeAgreement, trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { Candle } from '../shared/ipc'

// This strategy makes exactly one claim: it is Short-Term Channel with entries suppressed while
// the trend regime disagrees. Everything below pins a way that claim could quietly stop being
// true -- the dangerous direction being a gate that looks applied but is not, which would ship the
// ungated strategy under a name saying otherwise and read as a successful measurement.

const M15 = 900

function series(barSeconds: number, count: number, priceAt: (i: number) => number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = priceAt(i)
    return {
      time: 1_700_000_000 + i * barSeconds,
      open: close,
      high: close * 1.001,
      low: close * 0.999,
      close,
      volume: 1
    }
  })
}

/** Long enough to clear the 80-day regime warm-up at 15m with room to trade afterwards. */
const LENGTH = trendRegimeEnsemble.warmupBarsFor(M15) + 3000

describe('Short-Term Channel + Trend Regime', () => {
  it('takes a subset of the ungated strategy signals, never a different set', () => {
    // A gate can only ever REMOVE entries. An implementation that recomputed the channel rules
    // instead of deferring to them could produce entries the ungated strategy never had, and the
    // name would then describe something that does not exist.
    const candles = series(M15, LENGTH, (i) => 100 + Math.sin(i / 90) * 12 + i * 0.01)
    const base = shortTermChannel.generateSignals(candles)
    const gated = shortTermChannelRegime.generateSignals(candles)
    for (let i = 0; i < candles.length; i++) {
      if (gated.entries[i]) expect(base.entries[i], `entry at ${i} not present ungated`).toBe(true)
    }
    expect(base.entries.filter(Boolean).length, 'vacuous: ungated took no entries').toBeGreaterThan(0)
    expect(gated.entries.filter(Boolean).length).toBeLessThanOrEqual(base.entries.filter(Boolean).length)
  })

  it('never enters on a bar where the four lookbacks disagree', () => {
    const candles = series(M15, LENGTH, (i) => 100 + Math.sin(i / 120) * 20 + i * 0.005)
    const gated = shortTermChannelRegime.generateSignals(candles)
    const agreement = regimeAgreement(candles, M15)
    expect(gated.entries.filter(Boolean).length, 'vacuous: gated took no entries').toBeGreaterThan(0)
    for (let i = 0; i < candles.length; i++) {
      if (gated.entries[i]) expect(agreement[i], `entered at ${i} on partial agreement`).toBe(1)
    }
  })

  it('actually suppresses something on a market that turns down', () => {
    // The test above passes trivially if the gate rejects everything, and the subset test passes
    // trivially if it rejects nothing. This pins that it does neither on a series that rises long
    // enough to warm up and trade, then falls far enough to switch the regime off.
    const turn = Math.floor(LENGTH * 0.75)
    const candles = series(M15, LENGTH, (i) => (i < turn ? 100 + i * 0.02 : 100 + turn * 0.02 - (i - turn) * 0.05))
    const base = shortTermChannel.generateSignals(candles)
    const gated = shortTermChannelRegime.generateSignals(candles)
    const baseCount = base.entries.filter(Boolean).length
    const gatedCount = gated.entries.filter(Boolean).length
    expect(baseCount).toBeGreaterThan(0)
    expect(gatedCount).toBeGreaterThan(0)
    expect(gatedCount).toBeLessThan(baseCount)
  })

  it('passes exits and stops through untouched', () => {
    // Gating exits was measured and was worse: an exit blocked by a falling regime is blocked
    // exactly when it is needed. That decision lives in code as "do nothing", which is precisely
    // the kind of thing a later edit removes without noticing.
    const candles = series(M15, LENGTH, (i) => 100 + Math.cos(i / 70) * 9 + i * 0.008)
    const base = shortTermChannel.generateSignals(candles)
    const gated = shortTermChannelRegime.generateSignals(candles)
    expect(gated.exits).toEqual(base.exits)
    expect(gated.stopPrices).toEqual(base.stopPrices)
  })

  it('declares the slower of the two warm-ups', () => {
    // Declaring Short-Term Channel's 8 days would not give a faster start. rollingSma is NaN until
    // its window fills and `close > NaN` is false, so every unwarmed lookback votes no -- the
    // strategy would sit flat for 80 days anyway and report those bars as a choice it made.
    for (const barSeconds of [M15, 3600, 14_400]) {
      const declared = shortTermChannelRegime.warmupBarsFor(barSeconds)
      expect(declared).toBe(
        Math.max(shortTermChannel.warmupBarsFor(barSeconds), trendRegimeEnsemble.warmupBarsFor(barSeconds))
      )
      expect(declared).toBeGreaterThanOrEqual(trendRegimeEnsemble.warmupBarsFor(barSeconds))
    }
  })

  it('holds flat rather than guessing when the bar spacing is unreadable', () => {
    // Same contract trendRegimeEnsemble honours: no usable spacing means the day-based lookbacks
    // have no scale, and inventing one would put the gate on an arbitrary basis.
    const flat: Candle[] = Array.from({ length: 500 }, () => ({
      time: 1_700_000_000,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1
    }))
    const signals = shortTermChannelRegime.generateSignals(flat)
    expect(signals.entries.some(Boolean)).toBe(false)
    expect(signals.warmupBars).toBe(flat.length)
  })
})
