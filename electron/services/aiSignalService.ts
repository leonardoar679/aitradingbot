import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  GPT_MAX_DECISIONS,
  GPT_MIN_CONFIDENCE,
  GPT_PROMPT_VERSION,
  decisionRange,
  parseAiSignalResponse,
  promptWindow,
  type AiPositionState,
  type AiSignalDecision,
  type AiSignalEstimate,
  type AiSignalProgress,
  type AiSignalTape,
  type AiSignalTapeRequest,
  type ParsedAiSignal
} from '../../shared/aiSignal'
import type { Candle } from '../../shared/ipc'
import { computeAtr } from '../../shared/atr'
import { writeJsonAtomic } from './atomicWrite'
import { getDecryptedAiCredential } from './aiCredentialsService'

interface CachedDecision extends AiSignalDecision {
  promptVersion: string
}

const activeControllers = new Map<string, AbortController>()
const cancelledRequests = new Set<string>()

function cacheDirectory(): string {
  return join(app.getPath('userData'), 'aiSignalCache')
}

function stableCandle(candle: Candle): number[] {
  return [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume]
}

export function aiSignalCacheKey(input: {
  model: string
  exchange: string
  symbol: string
  interval: string
  candleTime: number
  position: AiPositionState
  candles: Candle[]
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        GPT_PROMPT_VERSION,
        input.model,
        input.exchange,
        input.symbol,
        input.interval,
        input.candleTime,
        input.position,
        input.candles.map(stableCandle)
      ])
    )
    .digest('hex')
}

async function readCached(key: string): Promise<CachedDecision | null> {
  try {
    const parsed = JSON.parse(await readFile(join(cacheDirectory(), `${key}.json`), 'utf-8')) as CachedDecision
    if (parsed.promptVersion !== GPT_PROMPT_VERSION) return null
    if (!parseAiSignalResponse(parsed)) return null
    // A previously-cached failure is a miss, not a hit. Writes are gated on this too, so nothing
    // new can land here -- but caches written before that gate existed are still on disk, and a
    // machine holding them would otherwise never call OpenAI again for those candles no matter
    // how many credits were added. Refusing them here retires the poisoned entries on read.
    if (parsed.error !== null) return null
    return parsed
  } catch {
    return null
  }
}

async function writeCached(key: string, decision: CachedDecision): Promise<void> {
  await mkdir(cacheDirectory(), { recursive: true })
  await writeJsonAtomic(join(cacheDirectory(), `${key}.json`), decision)
}

function compactCandles(candles: Candle[]): number[][] {
  return candles.map(stableCandle)
}

// The stop simulated here must be the stop the ENGINE will place, because the position it implies
// goes into the prompt and into the cache key. This used to be a local mean of the last 14 true
// ranges while the engine used Wilder smoothing; on BTCUSDT 15m the two differ by 11.6% on average
// and 61% at worst, so the two sides could disagree about whether a position was still open.
function atrAt(candles: Candle[], index: number, period = 14): number | null {
  if (index < period - 1) return null
  const value = computeAtr(candles.slice(0, index + 1), period)[index]
  return Number.isFinite(value) ? value : null
}

async function requestOpenAi(
  apiKey: string,
  model: string,
  symbol: string,
  position: AiPositionState,
  candles: Candle[],
  signal: AbortSignal
): Promise<ParsedAiSignal> {
  const schema = {
    name: 'intraday_signal',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        recommendation: { type: 'string', enum: ['buy', 'sell', 'hold'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        rationale: { type: 'string', maxLength: 500 }
      },
      required: ['recommendation', 'confidence', 'rationale']
    }
  }
  const body = {
    model,
    response_format: { type: 'json_schema', json_schema: schema },
    messages: [
      {
        role: 'system',
        content:
          'You are a conservative 15-minute crypto signal classifier. Return only the requested JSON. ' +
          'Account for trend, momentum, volatility, volume, fees and whipsaw risk. Prefer hold when evidence is weak. ' +
          'Never claim certainty and never provide position sizing.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          symbol,
          position,
          candleColumns: ['unixTime', 'open', 'high', 'low', 'close', 'volume'],
          candles: compactCandles(candles),
          instruction: 'Decide the action for the next 15-minute candle using only this completed history.'
        })
      }
    ]
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`OpenAI request failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error('OpenAI returned no signal')
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('OpenAI returned invalid JSON')
  }
  const validated = parseAiSignalResponse(parsed)
  if (!validated) throw new Error('OpenAI returned an invalid signal shape')
  return validated
}

async function requestOpenAiWithRetry(
  apiKey: string,
  model: string,
  symbol: string,
  position: AiPositionState,
  candles: Candle[],
  signal: AbortSignal
): Promise<ParsedAiSignal> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await requestOpenAi(apiKey, model, symbol, position, candles, signal)
    } catch (error) {
      lastError = error
      if (signal.aborted || attempt === 2) break
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
    }
  }
  throw lastError
}

function safeHold(candleTime: number, model: string, error: unknown): AiSignalDecision {
  return {
    candleTime,
    recommendation: 'hold',
    confidence: 0,
    rationale: 'Signal unavailable; held by safety fallback.',
    model,
    cached: false,
    error: error instanceof Error ? error.message : String(error)
  }
}

export function cancelAiSignalTape(requestId: string): void {
  cancelledRequests.add(requestId)
  activeControllers.get(requestId)?.abort()
}

export async function estimateAiSignalTape(request: AiSignalTapeRequest): Promise<AiSignalEstimate> {
  const { model } = await getDecryptedAiCredential()
  const { start, end, total } = decisionRange(request)
  let position: AiPositionState = 'flat'
  let activeStop: number | null = null
  let cached = 0
  for (let index = start; index < end; index++) {
    if (position === 'long' && activeStop !== null && request.candles[index].low <= activeStop) {
      position = 'flat'
      activeStop = null
    }
    const window = promptWindow(request.candles, index)
    const decision = await readCached(
      aiSignalCacheKey({
        model,
        exchange: request.exchange,
        symbol: request.symbol,
        interval: request.interval,
        candleTime: request.candles[index].time,
        position,
        candles: window
      })
    )
    // Position is part of later cache keys. Once one decision is missing, later keys cannot be
    // predicted safely, so the remainder is reported as a conservative maximum API-call count.
    if (!decision) break
    cached++
    if (decision.recommendation === 'buy' && decision.confidence >= GPT_MIN_CONFIDENCE && position === 'flat') {
      position = 'long'
      const atr = atrAt(request.candles, index - 1)
      activeStop = request.candles[index].close - (atr ?? request.candles[index].close * 0.02) * 1.5
    } else if (decision.recommendation === 'sell' && decision.confidence >= GPT_MIN_CONFIDENCE && position === 'long') {
      position = 'flat'
      activeStop = null
    }
  }
  return { total, cached, maximumApiCalls: total - cached }
}

export async function generateAiSignalTape(
  request: AiSignalTapeRequest,
  onProgress?: (progress: AiSignalProgress) => void
): Promise<AiSignalTape> {
  if (!request.requestId.trim()) throw new Error('Signal request ID is required')
  if (request.maxDecisions !== undefined && request.maxDecisions > GPT_MAX_DECISIONS) {
    throw new Error(`GPT Intraday is limited to ${GPT_MAX_DECISIONS} decisions per run`)
  }
  const { apiKey, model } = await getDecryptedAiCredential()
  const { start, end, total } = decisionRange(request)
  const decisions: AiSignalDecision[] = []
  let position: AiPositionState = 'flat'
  let activeStop: number | null = null
  let cachedCount = 0
  let errorCount = 0
  cancelledRequests.delete(request.requestId)

  try {
    for (let index = start; index < end; index++) {
      if (cancelledRequests.has(request.requestId)) throw new Error('GPT signal generation cancelled')
      if (position === 'long' && activeStop !== null && request.candles[index].low <= activeStop) {
        position = 'flat'
        activeStop = null
      }
      const window = promptWindow(request.candles, index)
      const candleTime = request.candles[index].time
      const key = aiSignalCacheKey({
        model,
        exchange: request.exchange,
        symbol: request.symbol,
        interval: request.interval,
        candleTime,
        position,
        candles: window
      })
      const cached = await readCached(key)
      let decision: AiSignalDecision
      if (cached) {
        decision = { ...cached, cached: true }
        cachedCount++
      } else {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        activeControllers.set(request.requestId, controller)
        try {
          const parsed = await requestOpenAiWithRetry(apiKey, model, request.symbol, position, window, controller.signal)
          decision = { candleTime, ...parsed, model, cached: false, error: null }
        } catch (error) {
          if (cancelledRequests.has(request.requestId)) throw new Error('GPT signal generation cancelled')
          decision = safeHold(candleTime, model, error)
        } finally {
          clearTimeout(timeout)
          activeControllers.delete(request.requestId)
        }
        // ONLY a real answer is cached. A safeHold is the ABSENCE of a decision, not a decision to
        // hold, and it parses as a perfectly valid one -- recommendation 'hold', confidence 0, a
        // rationale string -- so readCached would serve it back forever. Caching it turns a
        // transient failure into a permanent one: an account that was simply out of credits
        // produced 96 cached holds, and the rerun then reported "96 confirmed cached, at most 0
        // API calls" and 0 trades, with nothing anywhere saying the run had never reached OpenAI.
        // Adding credits would not have fixed it; only deleting the cache would.
        if (decision.error === null) {
          await writeCached(key, { ...decision, promptVersion: GPT_PROMPT_VERSION })
        } else {
          errorCount++
        }
      }

      decisions.push(decision)
      if (decision.recommendation === 'buy' && decision.confidence >= GPT_MIN_CONFIDENCE && position === 'flat') {
        position = 'long'
        const atr = atrAt(request.candles, index - 1)
        activeStop = request.candles[index].close - (atr ?? request.candles[index].close * 0.02) * 1.5
      }
      if (decision.recommendation === 'sell' && decision.confidence >= GPT_MIN_CONFIDENCE && position === 'long') {
        position = 'flat'
        activeStop = null
      }
      onProgress?.({ requestId: request.requestId, completed: decisions.length, total, cached: cachedCount })
    }
  } finally {
    activeControllers.delete(request.requestId)
    cancelledRequests.delete(request.requestId)
  }

  return {
    promptVersion: GPT_PROMPT_VERSION,
    exchange: request.exchange,
    symbol: request.symbol,
    interval: request.interval,
    decisions,
    cachedCount,
    generatedCount: decisions.length - cachedCount,
    errorCount
  }
}
