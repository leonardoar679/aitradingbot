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

/** Channel-position ensemble.
 *
 * A vote over DONCHIAN channels is vacuous, which is worth stating because it looks like the
 * obvious move: the channels are NESTED -- highest(8d) >= highest(5d) >= ... -- so "close breaks
 * k of the 4 highs" is just "close breaks the k-th slowest high". Voting across them re-picks a
 * single lookback under another name and adds no robustness at all.
 *
 * Where price sits WITHIN each channel is not nested, so averaging that across lookbacks is a
 * genuinely different signal from any one of them. pos = (close - low) / (high - low), averaged;
 * enter near the top of all the channels at once, leave only when well down them. The asymmetry
 * between the two thresholds is the hysteresis that the scan showed is what keeps the fee bill
 * survivable at this timescale. */
export function channelEnsemble(days: number[], barsPerDay: number, enterAt: number, exitAt: number): StrategyDefinition {
  const periods = days.map((d) => Math.max(2, Math.round(d * barsPerDay)))
  const warm = Math.max(...periods) + 1
  return {
    id: `x-chens-${days.join('_')}-${enterAt}-${exitAt}-${barsPerDay}`,
    name: 'channel ensemble', description: '',
    warmupBarsFor: () => warm,
    generateSignals(candles: Candle[]): StrategySignals {
      const his = periods.map((p) => highest(candles.map((x) => x.high), p))
      const los = periods.map((p) => lowest(candles.map((x) => x.low), p))
      const n = candles.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      for (let i = warm; i < n; i++) {
        const c = candles[i].close
        let sum = 0
        for (let k = 0; k < periods.length; k++) {
          const hi = his[k][i - 1], lo = los[k][i - 1]
          const span = hi - lo
          sum += span > 0 ? Math.min(1, Math.max(0, (c - lo) / span)) : 0.5
        }
        const pos = sum / periods.length
        // Disaster stop only -- the channel exit is the risk control. Never null: the engine
        // refuses to open a position without one.
        if (pos >= enterAt) { entries[i] = true; stopPrices[i] = c * 0.5 }
        if (pos <= exitAt) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: warm }
    }
  }
}
