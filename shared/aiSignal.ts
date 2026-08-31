import type { Candle, Exchange, Interval } from './ipc'
import { computeAtr } from './atr'

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
  /** Decisions that never reached a model answer and fell back to a safety hold.
   *
   * Exposed because a tape of nothing but failures is indistinguishable, downstream, from a tape
   * of genuine holds: both produce zero entries and a backtest that reports 0 trades, 0.00% and a
   * health check blaming the strategy. An account with no credits returned 96 of these and the
   * results page called it a clean run. Callers must say so rather than render the placeholder. */
  errorCount: number
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

// ---------------------------------------------------------------------------------------------
// THE POSITION MACHINE, ONCE.
//
// GPT Intraday decides in three places and they must agree exactly: estimateAiSignalTape walks it
// to predict cache keys, generateAiSignalTape walks it to fill in each prompt's `position`, and
// generateGptIntradaySignals walks it to emit the entries and exits the engine executes. The
// position is not cosmetic in any of them -- it is IN the prompt and IN the cache key, so a
// disagreement means the model was asked the wrong question and the answer was filed under the
// wrong key.
//
// They had already drifted twice. The service used a plain 14-bar mean of true ranges while the
// engine used Wilder smoothing (11.6% apart on average, 61% at worst), and the confidence gate was
// spelled 0.65 in the service and GPT_MIN_CONFIDENCE in the strategy. A third difference survived
// both of those fixes: on a zero ATR the service placed the stop at `close - 0 * 1.5`, which IS
// the close, so the position stopped out on its own entry candle -- while the strategy fell back
// to a fixed fraction. Three copies of a rule is the defect; these functions are the fix.

export const GPT_ATR_PERIOD = 14
export const GPT_ATR_STOP_MULTIPLE = 1.5
export const GPT_FALLBACK_STOP_FRACTION = 0.03

export interface GptPosition {
  long: boolean
  stop: number | null
}

export const GPT_FLAT: GptPosition = { long: false, stop: null }

/** The ATR series the stop is placed from -- Wilder, the same estimator the engine uses. */
export function gptAtrSeries(candles: Candle[]): number[] {
  return computeAtr(candles, GPT_ATR_PERIOD)
}

/** The stop an entry at `index` receives.
 *
 * The fallback covers two unusable readings, not one: NaN before the ATR seed index, and ZERO on a
 * flat series. Zero is the dangerous one because it is finite and arithmetic on it succeeds
 * silently, placing the stop exactly at the entry close. */
export function gptStopFor(candles: Candle[], atr: number[], index: number): number {
  const reference = atr[index - 1]
  const distance =
    Number.isFinite(reference) && reference > 0
      ? reference * GPT_ATR_STOP_MULTIPLE
      : candles[index].close * GPT_FALLBACK_STOP_FRACTION
  return Math.max(0, candles[index].close - distance)
}

/** Stop-out, evaluated before the bar's own decision -- a stop set yesterday fires on today's low
 * whatever the model says today. */
export function gptApplyStop(position: GptPosition, candle: Candle): GptPosition {
  if (position.long && position.stop !== null && candle.low <= position.stop) return GPT_FLAT
  return position
}

export type GptAction = 'enter' | 'exit' | 'none'

/** What a decision does, given the position carried into the bar.
 *
 * A decision carrying an error is not a decision: safeHold parses as a perfectly valid `hold`, so
 * the error field is the only thing separating "the model said hold" from "the model was never
 * reached". Confidence 0 already fails the gate, but relying on that couples this rule to the
 * shape of the fallback rather than to its meaning. */
export function gptActionFor(decision: AiSignalDecision | undefined, position: GptPosition): GptAction {
  if (!decision || decision.error !== null || decision.confidence < GPT_MIN_CONFIDENCE) return 'none'
  if (decision.recommendation === 'buy' && !position.long) return 'enter'
  if (decision.recommendation === 'sell' && position.long) return 'exit'
  return 'none'
}
