import { RSI } from 'technicalindicators'
import type { Candle } from '../../../shared/ipc'
import type { StrategyDefinition, StrategySignals } from './types'
import { computeEma, computeAtr } from './emaCrossAtrStop'

// Mean-reversion, long-only: buys a bounce off oversold RSI(14) rather than a trend continuation.
// Gated by an EMA(100) regime filter so it buys dips within an uptrend instead of catching a
// falling knife in a downtrend — the same "filter gates entries only" shape as the EMA-cross
// strategy. Exits on RSI recovering back above the overbought line (the mean-reversion move has
// played out) or an ATR(14)×2 stop, whichever comes first.
const RSI_PERIOD = 14
const RSI_OVERSOLD = 30
const RSI_OVERBOUGHT = 70
const REGIME_EMA_PERIOD = 100
const ATR_PERIOD = 14
const ATR_STOP_MULTIPLIER = 2

function generateSignals(candles: Candle[]): StrategySignals {
  const closes = candles.map((c) => c.close)
  const regimeEma = computeEma(closes, REGIME_EMA_PERIOD)
  const atr = computeAtr(candles, ATR_PERIOD)

  // technicalindicators returns a shorter array (no leading NaN padding) — align it back onto
  // the candle index the same way this codebase's chart-side RSI usage already does
  // (src/charts/TradingChart.tsx): rsi[i] corresponds to candles[i + rsiOffset].
  const rsiValues = RSI.calculate({ period: RSI_PERIOD, values: closes })
  const rsiOffset = candles.length - rsiValues.length
  const rsiAt = (i: number): number | null => {
    const idx = i - rsiOffset
    return idx >= 0 && idx < rsiValues.length ? rsiValues[idx] : null
  }

  const warmupBars = Math.max(REGIME_EMA_PERIOD, rsiOffset + 1)
  const entries = new Array<boolean>(candles.length).fill(false)
  const exits = new Array<boolean>(candles.length).fill(false)
  const stopPrices = new Array<number | null>(candles.length).fill(null)

  for (let i = warmupBars; i < candles.length; i++) {
    const rsiPrev = rsiAt(i - 1)
    const rsiNow = rsiAt(i)
    if (rsiPrev === null || rsiNow === null) continue

    const crossedUpFromOversold = rsiPrev <= RSI_OVERSOLD && rsiNow > RSI_OVERSOLD
    exits[i] = rsiPrev < RSI_OVERBOUGHT && rsiNow >= RSI_OVERBOUGHT

    const aboveRegime = closes[i] > regimeEma[i]
    if (crossedUpFromOversold && aboveRegime) {
      entries[i] = true
      stopPrices[i] = closes[i] - atr[i] * ATR_STOP_MULTIPLIER
    }
  }

  return { entries, exits, stopPrices, warmupBars }
}

export const rsiReversion: StrategyDefinition = {
  id: 'rsi-reversion',
  name: 'RSI Mean-Reversion',
  description: 'Buys an RSI(14) bounce off oversold (30) while price is above EMA(100), exits on RSI overbought (70) or an ATR(14)×2 stop.',
  generateSignals
}
