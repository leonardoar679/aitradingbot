import type { Candle, Exchange, Interval } from './ipc'

export const GPT_INTRADAY_STRATEGY_ID = 'gpt-intraday'
export const GPT_INTRADAY_INTERVAL: Interval = '15m'
export const GPT_LOOKBACK_BARS = 64
export const GPT_MAX_DECISIONS = 672
export const GPT_MIN_CONFIDENCE = 0.65
export const GPT_PROMPT_VERSION = 'gpt-intraday-v1'

export type AiRecommendation = 'buy' | 'sell' | 'hold'
export type AiPositionState = 'flat' | 'long'

export interface AiCredentialStatus {
  configured: boolean
  model: string
  addedAt: number | null
  lastTestedAt: number | null
  lastTestOk: boolean | null
}

export interface AiSignalDecision {
  candleTime: number
  recommendation: AiRecommendation
  confidence: number
  rationale: string
  model: string
  cached: boolean
  error: string | null
}

export interface AiSignalTapeRequest {
  requestId: string
  exchange: Exchange
  symbol: string
  interval: Interval
  candles: Candle[]
  /** First execution-candle index. Its prompt ends at candles[startIndex - 1]. */
  startIndex: number
  maxDecisions?: number
}

export interface AiSignalTape {
  promptVersion: string
  exchange: Exchange
  symbol: string
  interval: Interval
  decisions: AiSignalDecision[]
  cachedCount: number
  generatedCount: number
}

export interface AiSignalProgress {
  requestId: string
  completed: number
  total: number
  cached: number
}

export interface AiSignalEstimate {
  total: number
  cached: number
  maximumApiCalls: number
}

export interface ParsedAiSignal {
  recommendation: AiRecommendation
  confidence: number
  rationale: string
}

export function parseAiSignalResponse(value: unknown): ParsedAiSignal | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.recommendation !== 'buy' && record.recommendation !== 'sell' && record.recommendation !== 'hold') {
    return null
  }
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return null
  if (record.confidence < 0 || record.confidence > 1) return null
  if (typeof record.rationale !== 'string') return null
  return {
    recommendation: record.recommendation,
    confidence: record.confidence,
    rationale: record.rationale.slice(0, 500)
  }
}

export function decisionRange(request: AiSignalTapeRequest): { start: number; end: number; total: number } {
  if (request.interval !== GPT_INTRADAY_INTERVAL) {
    throw new Error('GPT Intraday only supports 15-minute candles')
  }
  const start = Math.max(GPT_LOOKBACK_BARS, Math.floor(request.startIndex))
  const requested = request.maxDecisions ?? GPT_MAX_DECISIONS
  const limit = Math.min(GPT_MAX_DECISIONS, Math.max(0, Math.floor(requested)))
  const end = Math.min(request.candles.length, start + limit)
  return { start, end, total: Math.max(0, end - start) }
}

export function promptWindow(candles: Candle[], executionIndex: number): Candle[] {
  if (executionIndex < GPT_LOOKBACK_BARS || executionIndex > candles.length) return []
  return candles.slice(executionIndex - GPT_LOOKBACK_BARS, executionIndex)
}
