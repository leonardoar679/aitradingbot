import {
  GPT_INTRADAY_INTERVAL,
  GPT_LOOKBACK_BARS,
  type AiSignalDecision
} from '../../shared/aiSignal'
import type { Candle, Exchange } from '../../shared/ipc'

export interface AiSignal {
  symbol: string
  confidence: number
  recommendation: 'buy' | 'sell' | 'hold'
  rationale?: string
}

export async function requestAiSignal(
  symbol: string,
  context?: { exchange: Exchange; candles: Candle[]; executionIndex: number }
): Promise<AiSignal> {
  let exchange: Exchange = context?.exchange ?? 'binance'
  let candles = context?.candles
  let executionIndex = context?.executionIndex

  if (!candles || executionIndex === undefined) {
    const endSec = Math.floor(Date.now() / 1000)
    const startSec = endSec - (GPT_LOOKBACK_BARS + 2) * 15 * 60
    const fetched = await window.api.market.fetchHistoricalRange(
      exchange,
      symbol,
      GPT_INTRADAY_INTERVAL,
      startSec,
      endSec
    )
    // The final exchange candle may still be forming. Generate for the last completed candle.
    candles = fetched.candles
    executionIndex = candles.length - 1
  }

  if (executionIndex < GPT_LOOKBACK_BARS || candles.length <= executionIndex) {
    return { symbol, confidence: 0, recommendation: 'hold', rationale: 'Not enough completed candles.' }
  }
  const requestId = crypto.randomUUID()
  const tape = await window.api.ai.generateSignalTape({
    requestId,
    exchange,
    symbol,
    interval: GPT_INTRADAY_INTERVAL,
    candles: candles.slice(0, executionIndex + 1),
    startIndex: executionIndex,
    maxDecisions: 1
  })
  const decision: AiSignalDecision | undefined = tape.decisions[0]
  return decision
    ? {
        symbol,
        confidence: decision.confidence,
        recommendation: decision.recommendation,
        rationale: decision.rationale
      }
    : { symbol, confidence: 0, recommendation: 'hold', rationale: 'No signal returned.' }
}
