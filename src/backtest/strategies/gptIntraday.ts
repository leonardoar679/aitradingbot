import type { Candle } from '../../../shared/ipc'
import {
  GPT_FLAT,
  GPT_INTRADAY_INTERVAL,
  GPT_INTRADAY_STRATEGY_ID,
  GPT_LOOKBACK_BARS,
  gptActionFor,
  gptApplyStop,
  gptAtrSeries,
  gptStopFor,
  type AiSignalTape
} from '../../../shared/aiSignal'
import type { StrategyDefinition, StrategySignals } from './types'

export function generateGptIntradaySignals(candles: Candle[], tape: AiSignalTape): StrategySignals {
  const entries = new Array<boolean>(candles.length).fill(false)
  const exits = new Array<boolean>(candles.length).fill(false)
  const stopPrices = new Array<number | null>(candles.length).fill(null)
  const atr = gptAtrSeries(candles)
  const byTime = new Map(tape.decisions.map((decision) => [decision.candleTime, decision]))
  let position = GPT_FLAT

  for (let index = GPT_LOOKBACK_BARS; index < candles.length; index++) {
    position = gptApplyStop(position, candles[index])
    const action = gptActionFor(byTime.get(candles[index].time), position)
    if (action === 'enter') {
      const stop = gptStopFor(candles, atr, index)
      entries[index] = true
      stopPrices[index] = stop
      position = { long: true, stop }
    } else if (action === 'exit') {
      exits[index] = true
      position = GPT_FLAT
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
