export interface AiSignal {
  symbol: string
  confidence: number
  recommendation: 'buy' | 'sell' | 'hold'
}

export async function requestAiSignal(symbol: string): Promise<AiSignal> {
  // Placeholder — wire up to backend/ AI service.
  return { symbol, confidence: 0, recommendation: 'hold' }
}
