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

// Wilder's smoothed ATR (the same formula talib.ATR uses): seeded by a simple average of the
// first `period` true ranges, then smoothed forward. Entries before the seed index are NaN.
export function computeAtr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN)
  if (candles.length === 0) return out

  const trueRange = new Array<number>(candles.length)
  trueRange[0] = candles[0].high - candles[0].low
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i]
    const prevClose = candles[i - 1].close
    trueRange[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
  }

  if (candles.length < period) return out
  let seedSum = 0
  for (let i = 0; i < period; i++) seedSum += trueRange[i]
  out[period - 1] = seedSum / period
  for (let i = period; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + trueRange[i]) / period
  }
  return out
}

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
  name: 'EMA Crossover + ATR Stop',
  description: 'Trend-following: buys an EMA(20/50) bullish cross while price is above EMA(200), stops out at close − ATR(14)×2.',
  generateSignals
}
