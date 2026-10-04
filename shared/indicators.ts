import type { Candle } from './ipc'

// Indicator arithmetic read from BOTH sides of the process boundary, in one place for the same
// reason shared/atr.ts exists: two implementations of one estimator drift, and nothing fails when
// they do.
//
// The strategies in src/backtest/strategies act on computeEma, and the Market Conditions card acts
// on wilderAdx. shared/aiContext.ts now tells a model what those same indicators read. If the
// context computed its own, a model could be told "EMA20 is above EMA50" on a bar where the EMA
// Crossover strategy sees the opposite. Both functions moved here unchanged; their old homes
// re-export or import them, so every existing caller reads the identical number it always did.

/** EMA seeded with the first value, so `out[0]` is that value rather than NaN. The first `period`
 * or so entries are therefore still converging; callers that need a warm reading skip them. */
export function computeEma(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = new Array(values.length)
  let prev = values[0]
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** Wilder's own smoothing, alpha = 1/period rather than an EMA's 2/(n+1). Substituting an EMA is a
 * common and silent error: it produces a plausible curve with every value shifted, which would move
 * readings across the 20 boundary the Market Conditions readout turns on.
 *
 * Reads only the last `2 * period + 1` bars, so the result depends on the tail of the series and
 * not on how much history precedes it. NaN when there are too few bars, or when the market moved
 * in no direction at all and ADX is mathematically undefined. */
export function wilderAdx(candles: Candle[], period: number): number {
  const need = 2 * period + 1
  if (candles.length < need + 1) return NaN

  let smoothedTr = 0
  let smoothedPlus = 0
  let smoothedMinus = 0
  const dxValues: number[] = []

  for (let i = candles.length - need; i < candles.length; i++) {
    const prev = candles[i - 1]
    const cur = candles[i]
    const upMove = cur.high - prev.high
    const downMove = prev.low - cur.low
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0
    const trueRange = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close))

    smoothedTr = smoothedTr - smoothedTr / period + trueRange
    smoothedPlus = smoothedPlus - smoothedPlus / period + plusDm
    smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm

    if (smoothedTr > 0) {
      const plusDi = (100 * smoothedPlus) / smoothedTr
      const minusDi = (100 * smoothedMinus) / smoothedTr
      const sum = plusDi + minusDi
      if (sum > 0) dxValues.push((100 * Math.abs(plusDi - minusDi)) / sum)
    }
  }

  if (dxValues.length < period) return NaN
  const last = dxValues.slice(-period)
  return last.reduce((a, b) => a + b, 0) / last.length
}
