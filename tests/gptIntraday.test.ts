import { describe, expect, it } from 'vitest'
import {
  GPT_ATR_PERIOD,
  GPT_FALLBACK_STOP_FRACTION,
  GPT_FLAT,
  GPT_INTRADAY_INTERVAL,
  GPT_LOOKBACK_BARS,
  GPT_MAX_DECISIONS,
  decisionRange,
  describeGptCadence,
  gptActionFor,
  gptApplyStop,
  gptAtrSeries,
  gptDecisionsPerDay,
  gptMaxSpanDays,
  gptStopFor,
  isDecisionCandle,
  parseAiSignalResponse,
  promptWindow,
  type AiSignalTape,
  type AiSignalTapeRequest
} from '../shared/aiSignal'
import { buildAiContext } from '../shared/aiContext'
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
    model: 'test/model',
    decisions,
    cachedCount: 0,
    generatedCount: decisions.length,
    callCount: decisions.length,
    errorCount: decisions.filter((d) => d.error !== null).length,
    rejectedCount: decisions.filter((d) => d.rejected).length,
    costUsd: 0
  }
}

/** The first index a decision can execute on. Every test below is written against this rather than
 * a literal, because the lookback is a design decision (it went from 64 bars to 672) and a test
 * that hardcodes it stops testing the rule and starts testing the number. */
const FIRST = GPT_LOOKBACK_BARS

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

  it('builds stable cache keys and changes them when position, input or model changes', () => {
    const data = candles(GPT_LOOKBACK_BARS)
    const meta = { exchange: 'binance' as const, symbol: 'BTCUSDT', interval: GPT_INTRADAY_INTERVAL }
    const contextFor = (series: Candle[], position: 'flat' | 'long') =>
      buildAiContext(series, GPT_LOOKBACK_BARS, { ...meta, position })!
    const first = aiSignalCacheKey({ model: 'test/model', context: contextFor(data, 'flat') })

    expect(aiSignalCacheKey({ model: 'test/model', context: contextFor(data, 'flat') })).toBe(first)
    expect(aiSignalCacheKey({ model: 'test/model', context: contextFor(data, 'long') })).not.toBe(first)
    const moved = [...data.slice(0, -1), { ...data.at(-1)!, close: 999 }]
    expect(aiSignalCacheKey({ model: 'test/model', context: contextFor(moved, 'flat') })).not.toBe(first)
    // The same question put to a different model is a different question. Without the model in
    // the key, switching models would serve the previous model's answers as the new one's.
    expect(aiSignalCacheKey({ model: 'other/model', context: contextFor(data, 'flat') })).not.toBe(first)
  })

  it('gives one candle one key however much history the caller fetched', () => {
    // A backtest, a bot and the chart each fetch a different amount of history for the same
    // candle. If the key moved with the fetch, each would be billed for the same decision.
    const long = candles(GPT_LOOKBACK_BARS + 400)
    const meta = { exchange: 'binance' as const, symbol: 'BTCUSDT', interval: GPT_INTRADAY_INTERVAL, position: 'flat' as const }
    const fromLong = buildAiContext(long, long.length, meta)!
    const fromShort = buildAiContext(long.slice(400), GPT_LOOKBACK_BARS, meta)!
    expect(aiSignalCacheKey({ model: 'm', context: fromShort })).toBe(aiSignalCacheKey({ model: 'm', context: fromLong }))
  })

  it('registers as an external-signal strategy without a live execution mode', () => {
    expect(gptIntraday.requiresExternalSignals).toBe(true)
    expect(gptIntraday).not.toHaveProperty('mode')
    expect(gptIntraday).not.toHaveProperty('placeOrder')
  })
})

describe('GPT Intraday deterministic replay', () => {
  it('maps confident buy/sell decisions and attaches a stop', () => {
    const data = candles(FIRST + 6)
    const decisions: AiSignalTape['decisions'] = [
      {
        candleTime: data[FIRST].time,
        recommendation: 'buy',
        confidence: 0.8,
        rationale: 'trend',
        model: 'test',
        cached: false,
        error: null
      },
      {
        candleTime: data[FIRST + 3].time,
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
    expect(first.entries[FIRST]).toBe(true)
    expect(first.stopPrices[FIRST]).toBeLessThan(data[FIRST].close)
    expect(first.exits[FIRST + 3]).toBe(true)

    const result = runBacktest(data, 'gpt-intraday', { signals: first })
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('signal')
  })

  it('fails closed for low-confidence and errored decisions', () => {
    const data = candles(FIRST + 2)
    const decisions: AiSignalTape['decisions'] = [
      {
        candleTime: data[FIRST].time,
        recommendation: 'buy',
        confidence: 0.5,
        rationale: 'weak',
        model: 'test',
        cached: false,
        error: null
      },
      {
        candleTime: data[FIRST + 1].time,
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
// The three call sites now share one machine. These pin the rules that were spelled differently
// in each of them before, and would have failed against the old service arithmetic.
describe('the GPT position machine, shared by all three call sites', () => {
  /** A perfectly flat series: every true range is zero, so ATR is zero -- finite, so arithmetic on
   * it succeeds silently. This is the case the service got wrong. */
  function flat(count: number): Candle[] {
    return Array.from({ length: count }, (_, index) => ({
      time: 1_700_000_000 + index * 900,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1
    }))
  }

  it('never places the stop AT the entry price when ATR is zero', () => {
    const data = flat(GPT_ATR_PERIOD + 5)
    const atr = gptAtrSeries(data)
    const index = data.length - 1
    expect(atr[index - 1]).toBe(0)

    const stop = gptStopFor(data, atr, index)
    // The old service computed `close - (atr ?? close*0.02) * 1.5`. With atr === 0 that is
    // `close - 0`, i.e. the close itself -- and gptApplyStop fires on `low <= stop`, so the
    // position was stopped out on its own entry candle, every time, on any flat stretch.
    expect(stop).toBeLessThan(data[index].close)
    expect(stop).toBeCloseTo(data[index].close * (1 - GPT_FALLBACK_STOP_FRACTION), 8)
    expect(gptApplyStop({ long: true, stop }, data[index]).long).toBe(true)
  })

  it('treats an errored decision as no decision even though it validates', () => {
    const errored = {
      candleTime: 1,
      recommendation: 'buy' as const,
      confidence: 0.99,
      rationale: 'x',
      model: 'm',
      cached: false,
      error: 'OpenAI request failed (429)'
    }
    // Confident, well formed, and a buy -- rejected purely because it never reached the model.
    expect(parseAiSignalResponse(errored)).not.toBeNull()
    expect(gptActionFor(errored, GPT_FLAT)).toBe('none')
    expect(gptActionFor({ ...errored, error: null }, GPT_FLAT)).toBe('enter')
  })

  it('treats a rejected answer as no decision, whatever it says', () => {
    // A rejection is stored as a zero-confidence hold, which the gate already refuses. This pins
    // the rule to its MEANING: even a rejected record carrying a confident buy must not act.
    const rejected = {
      candleTime: 1,
      recommendation: 'buy' as const,
      confidence: 0.99,
      rationale: '',
      model: 'm',
      cached: true,
      error: null,
      rejected: 'marketRegime is not an allowed value'
    }
    expect(gptActionFor(rejected, GPT_FLAT)).toBe('none')
    expect(gptActionFor({ ...rejected, rejected: null }, GPT_FLAT)).toBe('enter')
  })

  it('will not enter twice or exit flat', () => {
    const buy = { candleTime: 1, recommendation: 'buy' as const, confidence: 0.9, rationale: '', model: 'm', cached: false, error: null }
    const sell = { ...buy, recommendation: 'sell' as const }
    expect(gptActionFor(buy, GPT_FLAT)).toBe('enter')
    expect(gptActionFor(buy, { long: true, stop: 1 })).toBe('none')
    expect(gptActionFor(sell, GPT_FLAT)).toBe('none')
    expect(gptActionFor(sell, { long: true, stop: 1 })).toBe('exit')
  })
})

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

// Asking less often. The ceiling on a run is a number of decisions, so a model asked every four
// hours covers sixteen times the history for the same money -- but only if "every four hours"
// means the same candles to the backtest, to the bot and to the cache, and only if a position is
// still looked after on the candles nobody was asked about.
describe('GPT Intraday asked less often than every candle', () => {
  /** On a four-hour boundary, so that index 0 -- and index 672, seven days later -- open on the hour
   * and on the fourth hour. */
  const ALIGNED_START = 1_700_006_400
  function aligned(count: number): Candle[] {
    return candles(count).map((candle, index) => ({ ...candle, time: ALIGNED_START + index * 900 }))
  }
  function plan(data: Candle[], over: Partial<AiSignalTapeRequest> = {}): AiSignalTapeRequest {
    return { requestId: 'test', exchange: 'binance', symbol: 'BTCUSDT', interval: GPT_INTRADAY_INTERVAL, candles: data, startIndex: FIRST, ...over }
  }
  const buyAt = (time: number): AiSignalTape['decisions'][number] => ({
    candleTime: time,
    recommendation: 'buy',
    confidence: 0.9,
    rationale: '',
    model: 'test',
    cached: false,
    error: null
  })

  it('still asks on every candle at the fastest cadence, whatever the candles are stamped', () => {
    // The fixture every other test here uses does not sit on the quarter-hour at all.
    const data = candles(FIRST + 10)
    expect(data[FIRST].time % 900).not.toBe(0)
    expect(isDecisionCandle(data[FIRST].time, 1, GPT_INTRADAY_INTERVAL)).toBe(true)
    expect(decisionRange(plan(data))).toEqual({ start: FIRST, end: FIRST + 10, total: 10 })
    expect(decisionRange(plan(data, { decideEveryBars: 1 }))).toEqual({ start: FIRST, end: FIRST + 10, total: 10 })
  })

  it('asks only on the candles that open on the cadence', () => {
    const data = aligned(FIRST + 40)
    // Hourly: every fourth candle, the last of them 36 candles in.
    expect(decisionRange(plan(data, { decideEveryBars: 4 }))).toEqual({ start: FIRST, end: FIRST + 37, total: 10 })
    // Every four hours: candles 0, 16 and 32.
    expect(decisionRange(plan(data, { decideEveryBars: 16 }))).toEqual({ start: FIRST, end: FIRST + 33, total: 3 })
    expect(isDecisionCandle(data[FIRST].time, 16, GPT_INTRADAY_INTERVAL)).toBe(true)
    expect(isDecisionCandle(data[FIRST + 4].time, 16, GPT_INTRADAY_INTERVAL)).toBe(false)
    expect(isDecisionCandle(data[FIRST + 4].time, 4, GPT_INTRADAY_INTERVAL)).toBe(true)
    expect(isDecisionCandle(data[FIRST + 5].time, 4, GPT_INTRADAY_INTERVAL)).toBe(false)
  })

  it('takes its candles from the clock, not from where the run happened to start', () => {
    const data = aligned(FIRST + 40)
    // Started one candle later, the same candles are asked about -- minus the one now behind it.
    // Counting every sixteenth candle from the start would have asked about 673, 689 and 705, and
    // a bot and a backtest that began an hour apart would never share an answer.
    expect(decisionRange(plan(data, { startIndex: FIRST + 1, decideEveryBars: 16 }))).toEqual({ start: FIRST + 1, end: FIRST + 33, total: 2 })
  })

  it('counts decisions, not candles, against the ceiling', () => {
    const data = aligned(FIRST + GPT_MAX_DECISIONS * 4 + 40)
    // 2,728 candles to walk, and still 672 questions: the last one 671 hours after the first.
    expect(decisionRange(plan(data, { decideEveryBars: 4 }))).toEqual({
      start: FIRST,
      end: FIRST + (GPT_MAX_DECISIONS - 1) * 4 + 1,
      total: GPT_MAX_DECISIONS
    })
    expect(decisionRange(plan(data, { decideEveryBars: 4, maxDecisions: 2 }))).toEqual({ start: FIRST, end: FIRST + 5, total: 2 })
    expect(decisionRange(plan(data, { decideEveryBars: 4, maxDecisions: GPT_MAX_DECISIONS + 500 })).total).toBe(GPT_MAX_DECISIONS)
  })

  it.each([3, 0, -4, 1.5, 96, Number.NaN])('refuses a cadence of %s, which is not one it offers', (every) => {
    expect(() => decisionRange(plan(aligned(FIRST + 4), { decideEveryBars: every }))).toThrow(/every 15 minutes, every hour or every four hours/)
  })

  it('covers 7, 28 or 112 days with the same number of decisions', () => {
    expect([1, 4, 16].map(gptMaxSpanDays)).toEqual([7, 28, 112])
    expect([1, 4, 16].map(gptDecisionsPerDay)).toEqual([96, 24, 6])
    expect([1, 4, 16].map(describeGptCadence)).toEqual(['15 minutes', 'hour', '4 hours'])
    // The ceiling itself is what the spans are made of.
    for (const every of [1, 4, 16]) expect(gptMaxSpanDays(every) * gptDecisionsPerDay(every)).toBe(GPT_MAX_DECISIONS)
  })

  it('holds a position between two questions', () => {
    const data = aligned(FIRST + 40)
    const signals = generateGptIntradaySignals(data, tape(data, [buyAt(data[FIRST].time), buyAt(data[FIRST + 16].time)]))
    // Long since the first answer, so the second buy has nothing to open.
    expect(signals.entries.filter(Boolean)).toHaveLength(1)
    expect(signals.entries[FIRST]).toBe(true)
    const result = runBacktest(data, 'gpt-intraday', { signals })
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('end_of_data')
  })

  it('still stops a position out on a candle nobody was asked about, so the next answer can act', () => {
    const data = aligned(FIRST + 40)
    // Five candles after the entry, and eleven before the next question, price falls through the stop.
    data[FIRST + 5] = { ...data[FIRST + 5], low: 1 }
    const signals = generateGptIntradaySignals(data, tape(data, [buyAt(data[FIRST].time), buyAt(data[FIRST + 16].time)]))
    expect(signals.entries[FIRST]).toBe(true)
    // Flat again by the time of the second question, so its buy opens a second position.
    expect(signals.entries[FIRST + 16]).toBe(true)
    const result = runBacktest(data, 'gpt-intraday', { signals })
    expect(result.trades.map((trade) => trade.exitReason)).toEqual(['stop_loss', 'end_of_data'])
    expect(result.trades[0].exitTime).toBe(data[FIRST + 5].time)
  })
})
