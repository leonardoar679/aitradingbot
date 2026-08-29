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
    generatedCount: decisions.length
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
