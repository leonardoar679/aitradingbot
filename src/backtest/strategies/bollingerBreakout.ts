import { BollingerBands } from 'technicalindicators'
import type { Candle } from '../../../shared/ipc'
import type { StrategyDefinition, StrategySignals } from './types'
import { computeAtr } from './emaCrossAtrStop'

// Breakout, long-only: buys a close above the Bollinger Band(20, 2) upper band — a volatility
// expansion out of the recent range, rather than the trend/mean-reversion styles of the other two
// built-in strategies. Exits on a close back below the middle band (the breakout has failed/
// reverted) or an ATR(14)×2 stop, whichever comes first.
const BB_PERIOD = 20
const BB_STD_DEV = 2
const ATR_PERIOD = 14
const ATR_STOP_MULTIPLIER = 2

function generateSignals(candles: Candle[]): StrategySignals {
  const closes = candles.map((c) => c.close)
  const atr = computeAtr(candles, ATR_PERIOD)

  // Same offset-alignment convention as rsiReversion.ts / TradingChart.tsx's chart-side RSI use.
  const bands = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STD_DEV, values: closes })
  const bbOffset = candles.length - bands.length
  const bandAt = (i: number): (typeof bands)[number] | null => {
    const idx = i - bbOffset
    return idx >= 0 && idx < bands.length ? bands[idx] : null
  }

  const warmupBars = bbOffset + 1
  const entries = new Array<boolean>(candles.length).fill(false)
  const exits = new Array<boolean>(candles.length).fill(false)
  const stopPrices = new Array<number | null>(candles.length).fill(null)

  for (let i = warmupBars; i < candles.length; i++) {
    const prevBand = bandAt(i - 1)
    const band = bandAt(i)
    if (prevBand === null || band === null) continue

    const brokeOutUp = closes[i - 1] <= prevBand.upper && closes[i] > band.upper
    exits[i] = closes[i - 1] >= prevBand.middle && closes[i] < band.middle

    if (brokeOutUp) {
      entries[i] = true
      stopPrices[i] = closes[i] - atr[i] * ATR_STOP_MULTIPLIER
    }
  }

  return { entries, exits, stopPrices, warmupBars }
}

export const bollingerBreakout: StrategyDefinition = {
  id: 'bollinger-breakout',
  // BB_PERIOD bars to fill the first band, plus the bar that band is read on.
  // The 4h bar these three were written and validated against, kept as-is. Their lookbacks are in
  // BARS (EMA200, Bollinger 20) rather than days, so unlike the two trend strategies the interval
  // is part of what the strategy MEANS -- EMA200 is 33 days at 4h and 2 days at 15m, which is a
  // different rule, not the same rule sampled faster. Nothing here was re-measured, so this
  // records the interval they already assumed instead of claiming a new finding.
  preferredInterval: '4h',
  warmupBarsFor: () => BB_PERIOD + 1,
  name: 'Bollinger Breakout',
  description: 'Buys a close above the Bollinger Band(20, 2) upper band, exits on a close back below the middle band or an ATR(14)×2 stop.',
  generateSignals
}
