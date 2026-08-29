import type { Candle } from '../../../shared/ipc'
import {
  GPT_INTRADAY_INTERVAL,
  GPT_INTRADAY_STRATEGY_ID,
  GPT_LOOKBACK_BARS,
  GPT_MIN_CONFIDENCE,
  type AiSignalTape
} from '../../../shared/aiSignal'
import { computeAtr } from './emaCrossAtrStop'
import type { StrategyDefinition, StrategySignals } from './types'

const ATR_PERIOD = 14
const ATR_STOP_MULTIPLE = 1.5
const FALLBACK_STOP_FRACTION = 0.03

export function generateGptIntradaySignals(candles: Candle[], tape: AiSignalTape): StrategySignals {
  const entries = new Array<boolean>(candles.length).fill(false)
  const exits = new Array<boolean>(candles.length).fill(false)
  const stopPrices = new Array<number | null>(candles.length).fill(null)
  const atr = computeAtr(candles, ATR_PERIOD)
  const byTime = new Map(tape.decisions.map((decision) => [decision.candleTime, decision]))
  let inPosition = false
  let activeStop: number | null = null

  for (let index = GPT_LOOKBACK_BARS; index < candles.length; index++) {
    if (inPosition && activeStop !== null && candles[index].low <= activeStop) {
      inPosition = false
      activeStop = null
    }
    const decision = byTime.get(candles[index].time)
    if (!decision || decision.error || decision.confidence < GPT_MIN_CONFIDENCE) continue
    if (decision.recommendation === 'buy' && !inPosition) {
      const referenceAtr = atr[index - 1]
      const distance =
        Number.isFinite(referenceAtr) && referenceAtr > 0
          ? referenceAtr * ATR_STOP_MULTIPLE
          : candles[index].close * FALLBACK_STOP_FRACTION
      entries[index] = true
      stopPrices[index] = Math.max(0, candles[index].close - distance)
      inPosition = true
      activeStop = stopPrices[index]
    } else if (decision.recommendation === 'sell' && inPosition) {
      exits[index] = true
      inPosition = false
      activeStop = null
    }
  }

  return { entries, exits, stopPrices, warmupBars: GPT_LOOKBACK_BARS }
}

function holdSignals(candles: Candle[]): StrategySignals {
  return {
    entries: new Array<boolean>(candles.length).fill(false),
    exits: new Array<boolean>(candles.length).fill(false),
    stopPrices: new Array<number | null>(candles.length).fill(null),
    warmupBars: GPT_LOOKBACK_BARS
  }
}

export const gptIntraday: StrategyDefinition = {
  id: GPT_INTRADAY_STRATEGY_ID,
  name: 'GPT Intraday (Paper Only)',
  description:
    'GPT buy/sell/hold decisions on completed 15-minute candles, with a local confidence gate and ATR disaster stop.',
  preferredInterval: GPT_INTRADAY_INTERVAL,
  requiresExternalSignals: true,
  warmupBarsFor: () => GPT_LOOKBACK_BARS,
  // GPT generation is asynchronous and must be supplied as a deterministic tape to the engine.
  // A direct engine call therefore fails closed to hold rather than making network requests.
  generateSignals: holdSignals
}
