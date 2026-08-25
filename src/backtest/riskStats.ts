import type { EquityPoint } from './engine'

/** Sharpe, Sortino and Omega, measured over the part of the run the strategy could actually act in.
 *
 * The equity curve carries one point per candle, including the leading stretch where the strategy
 * is structurally forced flat while its indicators warm up -- 200 bars for the EMA-cross strategy,
 * which is 27% of a two-year daily backtest. Every one of those bars contributes a period return
 * of exactly zero, and those zeros are not observations about the strategy. They are an artifact
 * of when it was allowed to start.
 *
 * Left in, they drag the ratios toward zero: padding n real returns with k structural zeros scales
 * Sharpe by roughly sqrt(n / (n + k)) -- about a 15% understatement on that same two-year daily
 * run. A strategy was being marked down for the period it was not permitted to trade.
 *
 * This is the same correction runBacktest already applies to the buy & hold benchmark, and for the
 * same stated reason: the comparison starts where the strategy starts. Drawdown deliberately still
 * spans the whole curve -- a flat stretch has no drawdown in it, so the number is identical either
 * way -- and so does annualReturnPct, because the capital really was committed for the whole
 * window even while the strategy sat on its hands.
 */

const SECONDS_PER_YEAR = 365 * 24 * 3600

export interface RiskRatios {
  sharpeRatio: number
  sortinoRatio: number
  /** Sum of positive period returns / sum of negative ones. `Infinity` when the curve never had a
   * down period; `0` when it never had an up one. */
  omegaRatio: number
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0
  const m = mean(values)
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)))
}

export function computeRiskRatios(equityCurve: readonly EquityPoint[], warmupBars: number): RiskRatios {
  // Anything that is not a usable count of leading bars measures the whole curve rather than
  // silently discarding all of it -- a NaN slice index would be treated as 0 by slice() anyway,
  // but relying on that is how a guard stops guarding.
  //
  // The Math.min is redundant for the same reason: slice() already clamps an over-long start to
  // the array length. It is kept because that redundancy depends on slice's behaviour rather than
  // on anything visible here, and `skip` reads as a real index. Mutation-tested and recorded as
  // equivalent rather than left looking untested.
  const skip = Number.isFinite(warmupBars) && warmupBars > 0 ? Math.min(Math.floor(warmupBars), equityCurve.length) : 0
  const curve = equityCurve.slice(skip)

  const periodReturns: number[] = []
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].value
    if (prev > 0) periodReturns.push(curve[i].value / prev - 1)
  }

  // Measured across the segment actually used, so a run whose warm-up is most of the range still
  // annualizes on its own candle spacing rather than on the full window's.
  const avgIntervalSec = curve.length > 1 ? (curve[curve.length - 1].time - curve[0].time) / (curve.length - 1) : 0
  const periodsPerYear = avgIntervalSec > 0 ? SECONDS_PER_YEAR / avgIntervalSec : 0

  const returnMean = mean(periodReturns)
  const returnStd = stdDev(periodReturns)
  const sharpeRatio = returnStd > 0 ? (returnMean / returnStd) * Math.sqrt(periodsPerYear) : 0

  const downsideDev = Math.sqrt(mean(periodReturns.map((r) => (r < 0 ? r * r : 0))))
  const sortinoRatio = downsideDev > 0 ? (returnMean / downsideDev) * Math.sqrt(periodsPerYear) : 0

  const gains = periodReturns.filter((r) => r > 0).reduce((a, b) => a + b, 0)
  const losses = Math.abs(periodReturns.filter((r) => r < 0).reduce((a, b) => a + b, 0))
  const omegaRatio = losses > 0 ? gains / losses : gains > 0 ? Infinity : 0

  return { sharpeRatio, sortinoRatio, omegaRatio }
}
