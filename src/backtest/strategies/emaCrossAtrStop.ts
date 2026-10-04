import type { Candle } from '../../../shared/ipc'
import type { StrategyDefinition, StrategySignals } from './types'

// EMA(20)/EMA(50) crossover, long-only, spot (no shorting, no leverage). Enters on a bullish
// cross when price is above EMA(200) — a long-term regime filter added after backtesting the
// un-filtered version showed its profit was almost entirely concentrated in the 2023-24 bull run,
// with 5 of 6 tested assets flat-to-negative since. The filter blocks new entries during a
// broader downtrend, on the theory that the crossover has no edge against the prevailing regime.
// A stop-loss price (close − ATR(14) × 2) is set at entry. Exits on a bearish EMA(20/50) cross —
// the regime filter only gates entries, not exits. Ported from a reference Freqtrade strategy
// (Python) into this project's TS-only backtest engine.
const FAST_EMA_PERIOD = 20
const SLOW_EMA_PERIOD = 50
const REGIME_EMA_PERIOD = 200
const ATR_PERIOD = 14
const ATR_STOP_MULTIPLIER = 2

// Re-exported, not defined here, for the same reason as computeAtr below: the AI context builder
// in shared/aiContext.ts tells a model what EMA(20) and EMA(50) read, and it must be the EMA this
// strategy acts on. The implementation lives in shared/indicators.ts.
import { computeEma } from '../../../shared/indicators'
export { computeEma }

// Wilder's smoothed ATR (the same formula talib.ATR uses): seeded by a simple average of the
// first `period` true ranges, then smoothed forward. Entries before the seed index are NaN.
// Re-exported, not defined here. The canonical implementation lives in shared/atr.ts so that
// main-process services can use the identical estimator -- aiSignalService.ts previously had its
// own, and the two disagreed by up to 61%. Every existing importer of computeAtr keeps working.
import { computeAtr } from '../../../shared/atr'
export { computeAtr }

function generateSignals(candles: Candle[]): StrategySignals {
  const closes = candles.map((c) => c.close)
  const fastEma = computeEma(closes, FAST_EMA_PERIOD)
  const slowEma = computeEma(closes, SLOW_EMA_PERIOD)
  const regimeEma = computeEma(closes, REGIME_EMA_PERIOD)
  const atr = computeAtr(candles, ATR_PERIOD)

  const entries = new Array<boolean>(candles.length).fill(false)
  const exits = new Array<boolean>(candles.length).fill(false)
  const stopPrices = new Array<number | null>(candles.length).fill(null)

  for (let i = REGIME_EMA_PERIOD; i < candles.length; i++) {
    const bearishCross = fastEma[i - 1] >= slowEma[i - 1] && fastEma[i] < slowEma[i]
    exits[i] = bearishCross

    const bullishCross = fastEma[i - 1] <= slowEma[i - 1] && fastEma[i] > slowEma[i]
    const aboveRegime = closes[i] > regimeEma[i]
    if (bullishCross && aboveRegime) {
      entries[i] = true
      stopPrices[i] = closes[i] - atr[i] * ATR_STOP_MULTIPLIER
    }
  }

  return { entries, exits, stopPrices, warmupBars: REGIME_EMA_PERIOD }
}

export const emaCrossAtrStop: StrategyDefinition = {
  id: 'ema-cross-atr-stop',
  // Defined in bars, so the answer does not depend on the bar size -- and that is exactly why
  // this strategy behaves so differently across timeframes. EMA(200) is 33 days of 4h candles
  // and 2 days of 15m ones, and the measured trend edge exists at the first and not the second.
  // The 4h bar these three were written and validated against, kept as-is. Their lookbacks are in
  // BARS (EMA200, Bollinger 20) rather than days, so unlike the two trend strategies the interval
  // is part of what the strategy MEANS -- EMA200 is 33 days at 4h and 2 days at 15m, which is a
  // different rule, not the same rule sampled faster. Nothing here was re-measured, so this
  // records the interval they already assumed instead of claiming a new finding.
  preferredInterval: '4h',
  warmupBarsFor: () => REGIME_EMA_PERIOD,
  name: 'EMA Crossover + ATR Stop',
  description: 'Trend-following: buys an EMA(20/50) bullish cross while price is above EMA(200), stops out at close − ATR(14)×2.',
  generateSignals
}
