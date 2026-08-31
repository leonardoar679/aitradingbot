import { describe, expect, it } from 'vitest'
import {
  GPT_INTRADAY_INTERVAL,
  GPT_LOOKBACK_BARS,
  GPT_MAX_DECISIONS,
  decisionRange,
  parseAiSignalResponse,
  promptWindow,
  type AiSignalTape
} from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'
import { generateGptIntradaySignals, gptIntraday } from '../src/backtest/strategies/gptIntraday'
import { runBacktest } from '../src/backtest/engine'
import { aiSignalCacheKey } from '../electron/services/aiSignalService'

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: 1_700_000_000 + index * 900,
    open: 100 + index * 0.1,
    high: 101 + index * 0.1,
    low: 99 + index * 0.1,
    close: 100 + index * 0.1,
    volume: 10 + index
  }))
}

function tape(data: Candle[], decisions: AiSignalTape['decisions']): AiSignalTape {
  return {
    promptVersion: 'test',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: GPT_INTRADAY_INTERVAL,
    decisions,
    cachedCount: 0,
    generatedCount: decisions.length,
    errorCount: decisions.filter((d) => d.error !== null).length
  }
}

describe('GPT signal validation', () => {
  it('accepts only the strict recommendation and confidence range', () => {
    expect(parseAiSignalResponse({ recommendation: 'buy', confidence: 0.8, rationale: 'trend' })).toEqual({
      recommendation: 'buy',
      confidence: 0.8,
      rationale: 'trend'
    })
    expect(parseAiSignalResponse({ recommendation: 'maybe', confidence: 0.8, rationale: 'trend' })).toBeNull()
    expect(parseAiSignalResponse({ recommendation: 'hold', confidence: 2, rationale: 'trend' })).toBeNull()
  })

  it('constructs a no-lookahead window ending before the execution candle', () => {
    const data = candles(GPT_LOOKBACK_BARS + 1)
    const window = promptWindow(data, GPT_LOOKBACK_BARS)
    expect(window).toHaveLength(GPT_LOOKBACK_BARS)
    expect(window.at(-1)?.time).toBe(data[GPT_LOOKBACK_BARS - 1].time)
    expect(window.some((candle) => candle.time === data[GPT_LOOKBACK_BARS].time)).toBe(false)
  })

  it('enforces the seven-day decision ceiling', () => {
    const data = candles(GPT_LOOKBACK_BARS + GPT_MAX_DECISIONS + 20)
    const range = decisionRange({
      requestId: 'test',
      exchange: 'binance',
      symbol: 'BTCUSDT',
      interval: GPT_INTRADAY_INTERVAL,
      candles: data,
      startIndex: GPT_LOOKBACK_BARS,
      maxDecisions: GPT_MAX_DECISIONS + 100
    })
    expect(range.total).toBe(GPT_MAX_DECISIONS)
  })

  it('builds stable cache keys and changes them when position or input changes', () => {
    const data = candles(GPT_LOOKBACK_BARS)
    const input = {
      model: 'test-model',
      exchange: 'binance',
      symbol: 'BTCUSDT',
      interval: GPT_INTRADAY_INTERVAL,
      candleTime: data.at(-1)!.time + 900,
      position: 'flat' as const,
      candles: data
    }
    const first = aiSignalCacheKey(input)
    expect(aiSignalCacheKey(input)).toBe(first)
    expect(aiSignalCacheKey({ ...input, position: 'long' })).not.toBe(first)
    expect(aiSignalCacheKey({ ...input, candles: [...data.slice(0, -1), { ...data.at(-1)!, close: 999 }] })).not.toBe(first)
  })

  it('registers as an external-signal strategy without a live execution mode', () => {
    expect(gptIntraday.requiresExternalSignals).toBe(true)
    expect(gptIntraday).not.toHaveProperty('mode')
    expect(gptIntraday).not.toHaveProperty('placeOrder')
  })
})

describe('GPT Intraday deterministic replay', () => {
  it('maps confident buy/sell decisions and attaches a stop', () => {
    const data = candles(70)
    const decisions: AiSignalTape['decisions'] = [
      {
        candleTime: data[64].time,
        recommendation: 'buy',
        confidence: 0.8,
        rationale: 'trend',
        model: 'test',
        cached: false,
        error: null
      },
      {
        candleTime: data[67].time,
        recommendation: 'sell',
        confidence: 0.9,
        rationale: 'exit',
        model: 'test',
        cached: false,
        error: null
      }
    ]
    const first = generateGptIntradaySignals(data, tape(data, decisions))
    const second = generateGptIntradaySignals(data, tape(data, decisions))
    expect(first).toEqual(second)
    expect(first.entries[64]).toBe(true)
    expect(first.stopPrices[64]).toBeLessThan(data[64].close)
    expect(first.exits[67]).toBe(true)

    const result = runBacktest(data, 'gpt-intraday', { signals: first })
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('signal')
  })

  it('fails closed for low-confidence and errored decisions', () => {
    const data = candles(66)
    const decisions: AiSignalTape['decisions'] = [
      {
        candleTime: data[64].time,
        recommendation: 'buy',
        confidence: 0.5,
        rationale: 'weak',
        model: 'test',
        cached: false,
        error: null
      },
      {
        candleTime: data[65].time,
        recommendation: 'buy',
        confidence: 0.99,
        rationale: 'network fallback',
        model: 'test',
        cached: false,
        error: 'offline'
      }
    ]
    const signals = generateGptIntradaySignals(data, tape(data, decisions))
    expect(signals.entries.every((entry) => !entry)).toBe(true)
  })
})

// Why a failed decision must never be cached, and why the check is on `error` specifically.
//
// A live run against an OpenAI account with no credits returned 429 on all 96 calls. Each fell
// back to safeHold, each was written to the signal cache, and the rerun then reported "96
// confirmed cached, at most 0 API calls" and drew a clean 0-trade backtest. Adding credits would
// not have fixed it -- the cache would have kept answering.
describe('a failed GPT decision is not a decision', () => {
  const safeHoldShape = {
    candleTime: 1_700_000_000,
    recommendation: 'hold' as const,
    confidence: 0,
    rationale: 'Signal unavailable; held by safety fallback.',
    model: 'gpt-5-mini',
    cached: false,
    error: 'OpenAI request failed (429): You have no credits remaining.'
  }

  it('parses as a perfectly valid signal, which is exactly why it poisoned the cache', () => {
    // This is the trap. The cache guard cannot be "is it well formed" -- it is, completely.
    expect(parseAiSignalResponse(safeHoldShape)).not.toBeNull()
    expect(parseAiSignalResponse(safeHoldShape)?.recommendation).toBe('hold')
  })

  it('is distinguishable ONLY by its error field, so that is what the cache must gate on', () => {
    const genuine = { ...safeHoldShape, error: null }
    expect(parseAiSignalResponse(genuine)).not.toBeNull()
    // Identical under validation; opposite under the rule that now gates read and write.
    expect(safeHoldShape.error === null).toBe(false)
    expect(genuine.error === null).toBe(true)
  })

  it('can never open a trade, so a tape of them is 0 trades rather than a strategy result', () => {
    const data = candles(GPT_LOOKBACK_BARS + 12)
    const failed = tape(
      data,
      data.slice(GPT_LOOKBACK_BARS).map((c) => ({ ...safeHoldShape, candleTime: c.time }))
    )
    const signals = generateGptIntradaySignals(data, failed)
    expect(signals.entries.some(Boolean)).toBe(false)
    // The count is what lets a caller tell this apart from a genuine run of holds.
    expect(failed.errorCount).toBe(data.length - GPT_LOOKBACK_BARS)
  })
})
