import type { Candle } from '../shared/ipc'
import type { StrategyDefinition, StrategySignals } from '../src/backtest/strategies/types'
import { computeAtr } from '../src/backtest/strategies/emaCrossAtrStop'

export function sma(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    sum += v[i]
    if (i >= p) sum -= v[i - p]
    if (i >= p - 1) out[i] = sum / p
  }
  return out
}
export function highest(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN)
  for (let i = p - 1; i < v.length; i++) { let m = -Infinity; for (let j = i - p + 1; j <= i; j++) if (v[j] > m) m = v[j]; out[i] = m }
  return out
}
export function lowest(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN)
  for (let i = p - 1; i < v.length; i++) { let m = Infinity; for (let j = i - p + 1; j <= i; j++) if (v[j] < m) m = v[j]; out[i] = m }
  return out
}

/** A: price above a slow MA by a band, out when it falls below by the same band.
 *  The band is the whole point -- a bare MA cross whipsaws across the line and pays the fee
 *  every time. */
export function bandRegime(period: number, bandPct: number, atrMult: number): StrategyDefinition {
  return {
    id: `x-band-${period}-${bandPct}-${atrMult}`,
    name: 'band regime',
    description: '',
    generateSignals(candles: Candle[]): StrategySignals {
      const c = candles.map((x) => x.close)
      const ma = sma(c, period)
      const atr = computeAtr(candles, 14)
      const entries = new Array<boolean>(c.length).fill(false)
      const exits = new Array<boolean>(c.length).fill(false)
      const stopPrices = new Array<number | null>(c.length).fill(null)
      for (let i = period; i < c.length; i++) {
        if (c[i] > ma[i] * (1 + bandPct / 100)) { entries[i] = true; stopPrices[i] = c[i] - atr[i] * atrMult }
        if (c[i] < ma[i] * (1 - bandPct / 100)) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: period }
    }
  }
}

/** B: Donchian breakout -- enter on an N-bar high, leave on an M-bar low. The classic turtle
 *  shape: no moving average at all, the price itself defines the regime. */
export function donchian(entryLb: number, exitLb: number, atrMult: number): StrategyDefinition {
  return {
    id: `x-don-${entryLb}-${exitLb}-${atrMult}`,
    name: 'donchian',
    description: '',
    generateSignals(candles: Candle[]): StrategySignals {
      const hi = highest(candles.map((x) => x.high), entryLb)
      const lo = lowest(candles.map((x) => x.low), exitLb)
      const atr = computeAtr(candles, 14)
      const n = candles.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      const warm = Math.max(entryLb, exitLb) + 1
      for (let i = warm; i < n; i++) {
        if (candles[i].close >= hi[i - 1]) { entries[i] = true; stopPrices[i] = candles[i].close - atr[i] * atrMult }
        if (candles[i].close <= lo[i - 1]) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: warm }
    }
  }
}

/** C: asymmetric band regime. Enter when price clears the MA by `enterPct`, leave only when it
 *  falls `exitPct` below -- a wider exit than entry, so an established trend is given room to
 *  breathe instead of being handed back at the first dip. The stop is a disaster stop, not a
 *  working one: the regime exit is what controls risk here. */
export function asymRegime(period: number, enterPct: number, exitPct: number, atrMult: number): StrategyDefinition {
  return {
    id: `x-asym-${period}-${enterPct}-${exitPct}-${atrMult}`,
    name: 'asym regime',
    description: '',
    generateSignals(candles: Candle[]): StrategySignals {
      const c = candles.map((x) => x.close)
      const ma = sma(c, period)
      const atr = computeAtr(candles, 14)
      const entries = new Array<boolean>(c.length).fill(false)
      const exits = new Array<boolean>(c.length).fill(false)
      const stopPrices = new Array<number | null>(c.length).fill(null)
      for (let i = period; i < c.length; i++) {
        if (c[i] > ma[i] * (1 + enterPct / 100)) { entries[i] = true; stopPrices[i] = c[i] - atr[i] * atrMult }
        if (c[i] < ma[i] * (1 - exitPct / 100)) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: period }
    }
  }
}

/** D: ensemble regime. Instead of betting that one lookback is the right one, ask several and
 *  count votes. Picking "MA50d" from a sweep is a choice fitted to the sample -- and the sweep
 *  that produced it was visibly non-monotonic, MA60d scoring far worse than either neighbour,
 *  which is what a parameter chosen from noise looks like. Averaging over the lookbacks removes
 *  the choice instead of tuning it, and the two thresholds carry the hysteresis that keeps the
 *  fee bill down. */
export function ensembleRegime(periods: number[], enterFrac: number, exitFrac: number, atrMult: number): StrategyDefinition {
  return {
    id: `x-ens-${periods.join('_')}-${enterFrac}-${exitFrac}-${atrMult}`,
    name: 'ensemble regime',
    description: '',
    generateSignals(candles: Candle[]): StrategySignals {
      const c = candles.map((x) => x.close)
      const mas = periods.map((p) => sma(c, p))
      const atr = computeAtr(candles, 14)
      const n = c.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      const warm = Math.max(...periods)
      for (let i = warm; i < n; i++) {
        let votes = 0
        for (const ma of mas) if (c[i] > ma[i]) votes++
        const frac = votes / periods.length
        if (frac >= enterFrac) { entries[i] = true; stopPrices[i] = c[i] - atr[i] * atrMult }
        if (frac <= exitFrac) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: warm }
    }
  }
}

/** E: the shipped ensemble, but with the lookback set as a parameter so the choice can be
 *  measured instead of assumed. The probe put the trend edge in the 20-50 day band; the shipped
 *  set is 20/30/50/80, which straddles past the top of it. */
export function ensembleDays(days: number[], barsPerDay: number, enterFrac: number, exitFrac: number, atrMult: number): StrategyDefinition {
  return {
    id: `x-ensd-${days.join('_')}-${enterFrac}-${exitFrac}`,
    name: 'ensemble days',
    description: '',
    generateSignals(candles: Candle[]): StrategySignals {
      const c = candles.map((x) => x.close)
      const periods = days.map((d) => Math.round(d * barsPerDay))
      const mas = periods.map((p) => sma(c, p))
      const atr = computeAtr(candles, 14)
      const n = c.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      const warm = Math.max(...periods)
      for (let i = warm; i < n; i++) {
        let votes = 0
        for (const ma of mas) if (c[i] > ma[i]) votes++
        const frac = votes / periods.length
        if (frac >= enterFrac) { entries[i] = true; const s = c[i] - atr[i] * atrMult; stopPrices[i] = Number.isFinite(s) && s > 0 ? s : null }
        if (frac <= exitFrac) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: warm }
    }
  }
}
