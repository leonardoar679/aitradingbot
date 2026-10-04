import { describe, expect, it } from 'vitest'
import type { AiBenchmarkAnswers } from '../shared/aiBenchmark'
import { GPT_INTRADAY_INTERVAL, GPT_LOOKBACK_BARS, type AiSignalDecision } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'
import {
  BENCHMARK_CONCURRENCY,
  BENCHMARK_MAX_CONSECUTIVE_FAILURES,
  BENCHMARK_MAX_CONSECUTIVE_REFUSALS,
  benchmarkAskRequest,
  benchmarkPeekCandles,
  runBenchmark,
  type BenchmarkProgress,
  type BenchmarkRunInput
} from '../src/agents/benchmark'

// The loop that spends a benchmark's money. What these pin is what it must never do: ask for an
// answer it already holds, carry on after it was told to stop, or hand a model a candle from
// after the one it is deciding.

const BAR = 900
const START = 1_699_999_200

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: START + index * BAR,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100 + index * 0.01,
    volume: 10
  }))
}

function answer(over: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime: 0,
    recommendation: 'hold',
    confidence: 0.5,
    rationale: '',
    model: 'test/model',
    cached: false,
    error: null,
    rejected: null,
    detail: null,
    usage: { promptTokens: 10, completionTokens: 10, costUsd: 0.002, latencyMs: 5 },
    ...over
  }
}

const FAILED = answer({ error: '503 no provider', confidence: 0, usage: null })

/** Runs the loop against a scripted `ask`, recording what was asked for and in what order. */
async function run(
  over: Partial<BenchmarkRunInput> & { reply?: (model: string, index: number, call: number) => AiSignalDecision | Promise<AiSignalDecision> }
): Promise<{ result: Awaited<ReturnType<typeof runBenchmark>>; asked: string[] }> {
  const asked: string[] = []
  const { reply = () => answer(), ...input } = over
  const result = await runBenchmark({
    times: [10, 20, 30],
    models: ['a', 'b'],
    known: {},
    ask: async (model, index) => {
      asked.push(`${model}@${index}`)
      return reply(model, index, asked.length)
    },
    ...input
  })
  return { result, asked }
}

describe('what a benchmark asks for', () => {
  it('asks every model every candle, one candle at a time', async () => {
    const { result, asked } = await run({ concurrency: 1 })
    expect(asked).toEqual(['a@0', 'b@0', 'a@1', 'b@1', 'a@2', 'b@2'])
    expect(result).toMatchObject({ asked: 6, answered: 6, stopped: null, dropped: [] })
    expect(result.costUsd).toBeCloseTo(0.012, 10)
    expect(result.answers.a.every((entry) => entry !== null)).toBe(true)
  })

  it('never asks for an answer it already holds', async () => {
    const held = answer({ cached: true, recommendation: 'buy' })
    const known: AiBenchmarkAnswers = { a: [held, null, held], b: [null, held, held] }
    const { result, asked } = await run({ known, concurrency: 1 })
    expect(asked).toEqual(['b@0', 'a@1'])
    expect(result.asked).toBe(2)
    // What was held is handed back untouched, beside what was bought.
    expect(result.answers.a[0]).toBe(held)
    expect(result.answers.a[1]).toMatchObject({ recommendation: 'hold', cached: false })
  })

  it('makes no call at all when everything is held', async () => {
    const held = answer({ cached: true })
    const { result, asked } = await run({ known: { a: [held, held, held], b: [held, held, held] } })
    expect(asked).toEqual([])
    expect(result).toMatchObject({ asked: 0, costUsd: 0, stopped: null })
  })

  it('does not count an answer joined from a call already in the air as its own spend', async () => {
    const { result } = await run({ reply: (_model, index) => answer({ cached: index === 0 }) })
    expect(result.answered).toBe(6)
    expect(result.costUsd).toBeCloseTo(0.008, 10)
  })

  it('keeps no more calls in the air than it is allowed', async () => {
    let inAir = 0
    let most = 0
    const { result } = await run({
      times: Array.from({ length: 12 }, (_, i) => i),
      models: ['a', 'b', 'c'],
      reply: async () => {
        inAir++
        most = Math.max(most, inAir)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inAir--
        return answer()
      }
    })
    expect(result.asked).toBe(36)
    expect(most).toBe(BENCHMARK_CONCURRENCY)
  })

  it('reports each finished call, and what the run has spent so far', async () => {
    const seen: BenchmarkProgress[] = []
    await run({ concurrency: 1, onProgress: (progress) => seen.push({ ...progress }) })
    expect(seen.map((progress) => progress.asked)).toEqual([1, 2, 3, 4, 5, 6])
    expect(seen.every((progress) => progress.toAsk === 6)).toBe(true)
    expect(seen[5].costUsd).toBeCloseTo(0.012, 10)
  })
})

describe('a call that does not come back', () => {
  it('is not kept as an answer, and is not charged', async () => {
    const { result } = await run({ concurrency: 1, reply: (model, index) => (model === 'b' && index === 1 ? FAILED : answer()) })
    expect(result.answers.b[1]).toBeNull()
    expect(result).toMatchObject({ asked: 6, answered: 5, dropped: [], stopped: null })
    expect(result.costUsd).toBeCloseTo(0.01, 10)
  })

  it('stops asking a model that keeps failing, and carries on with the others', async () => {
    const times = Array.from({ length: 8 }, (_, i) => i)
    const { result, asked } = await run({ times, concurrency: 1, reply: (model) => (model === 'b' ? FAILED : answer()) })
    expect(asked.filter((entry) => entry.startsWith('b@'))).toHaveLength(BENCHMARK_MAX_CONSECUTIVE_FAILURES)
    expect(asked.filter((entry) => entry.startsWith('a@'))).toHaveLength(8)
    expect(result.dropped).toEqual([{ model: 'b', error: '503 no provider' }])
    expect(result.answers.b.every((entry) => entry === null)).toBe(true)
    expect(result.stopped).toBeNull()
  })

  it('does not give up on a model whose failures are not in a row', async () => {
    const times = Array.from({ length: 9 }, (_, i) => i)
    // Two failures, an answer, two failures, an answer...
    const { result } = await run({ times, models: ['a'], concurrency: 1, reply: (_model, index) => (index % 3 === 2 ? answer() : FAILED) })
    expect(result.dropped).toEqual([])
    expect(result.asked).toBe(9)
    expect(result.answered).toBe(3)
  })
})

describe('a run that has to stop', () => {
  it('asks for nothing more once the main process refuses, and says why in its words', async () => {
    const { result, asked } = await run({
      times: Array.from({ length: 10 }, (_, i) => i),
      concurrency: 1,
      reply: (_model, _index, call) => {
        if (call === 4) {
          throw new Error("Error invoking remote method 'ai:generateSignalTape': Error: Today's AI budget is used up ($1.00 of $1.00).")
        }
        return answer()
      }
    })
    expect(asked).toHaveLength(4)
    expect(result.stopped).toEqual({ reason: 'refused', message: "Today's AI budget is used up ($1.00 of $1.00)." })
    // The three answers bought before the refusal are kept.
    expect(result).toMatchObject({ asked: 3, answered: 3 })
    expect(result.answers.a[0]).not.toBeNull()
    expect(result.answers.b[1]).toBeNull()
  })

  it('keeps the answers that were already in the air when the refusal arrived', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { result, asked } = await run({
      times: Array.from({ length: 10 }, (_, i) => i),
      concurrency: 2,
      reply: async (_model, _index, call) => {
        if (call === 1) {
          await gate
          return answer({ recommendation: 'buy' })
        }
        // The first call comes back only after this refusal has been dealt with.
        setTimeout(release, 5)
        throw new Error('OpenRouter rejected the API key.')
      }
    })
    expect(asked).toHaveLength(2)
    expect(result.stopped).toMatchObject({ reason: 'refused', message: 'OpenRouter rejected the API key.' })
    expect(result.answers.a[0]).toMatchObject({ recommendation: 'buy' })
    expect(result.answered).toBe(1)
  })

  it('stops asking as soon as it is told to, and keeps what it has', async () => {
    let stop = false
    const { result, asked } = await run({
      times: Array.from({ length: 10 }, (_, i) => i),
      concurrency: 1,
      shouldStop: () => stop,
      reply: (_model, _index, call) => {
        if (call === 3) stop = true
        return answer()
      }
    })
    expect(asked).toHaveLength(3)
    expect(result.stopped).toEqual({ reason: 'cancelled', message: null })
    expect(result.answered).toBe(3)
  })

  it('asks for nothing when it is stopped before it starts', async () => {
    const { result, asked } = await run({ shouldStop: () => true })
    expect(asked).toEqual([])
    expect(result.stopped?.reason).toBe('cancelled')
  })
})

describe('the question a benchmark sends', () => {
  const market = { exchange: 'binance' as const, symbol: 'BTCUSDT' }
  const series = candles(GPT_LOOKBACK_BARS + 200)

  it('carries the lookback and the execution candle, and nothing after it', () => {
    const index = GPT_LOOKBACK_BARS + 40
    const request = benchmarkAskRequest(market, series, index, 'acme/model')
    expect(request.candles).toHaveLength(GPT_LOOKBACK_BARS + 1)
    expect(request.candles[request.candles.length - 1]).toBe(series[index])
    expect(request.candles[0]).toBe(series[index - GPT_LOOKBACK_BARS])
    // The benchmark is holding 159 candles from after this decision. None of them is in it.
    expect(Math.max(...request.candles.map((candle) => candle.time))).toBe(series[index].time)
    expect(request).toMatchObject({
      exchange: 'binance',
      symbol: 'BTCUSDT',
      interval: GPT_INTRADAY_INTERVAL,
      startIndex: GPT_LOOKBACK_BARS,
      maxDecisions: 1,
      model: 'acme/model',
      source: 'benchmark'
    })
  })

  it('gives each question its own request id', () => {
    const a = benchmarkAskRequest(market, series, GPT_LOOKBACK_BARS, 'acme/model')
    const b = benchmarkAskRequest(market, series, GPT_LOOKBACK_BARS, 'acme/model')
    expect(a.requestId).not.toBe(b.requestId)
  })

  it('refuses a candle without a full lookback before it, or one that is not there', () => {
    expect(() => benchmarkAskRequest(market, series, GPT_LOOKBACK_BARS - 1, 'acme/model')).toThrow(/lookback/)
    expect(() => benchmarkAskRequest(market, series, series.length, 'acme/model')).toThrow(/lookback/)
    expect(() => benchmarkAskRequest(market, series, -1, 'acme/model')).toThrow(/lookback/)
  })

  it('sends a peek the candles from the first lookback to the last sampled candle, and none after', () => {
    const times = [series[GPT_LOOKBACK_BARS + 10].time, series[GPT_LOOKBACK_BARS + 26].time, series[GPT_LOOKBACK_BARS + 42].time]
    const sent = benchmarkPeekCandles(series, times)
    expect(sent[0]).toBe(series[10])
    expect(sent[sent.length - 1]).toBe(series[GPT_LOOKBACK_BARS + 42])
    expect(sent).toHaveLength(GPT_LOOKBACK_BARS + 33)
  })

  it('sends a peek nothing when there is nothing to ask, or the first candle has no lookback', () => {
    expect(benchmarkPeekCandles(series, [])).toEqual([])
    expect(benchmarkPeekCandles(series, [series[GPT_LOOKBACK_BARS - 1].time])).toEqual([])
    expect(benchmarkPeekCandles(series, [START - BAR])).toEqual([])
  })
})

describe('a model whose answers keep being refused', () => {
  // What the first real call to a second vendor's model came back as: reached, answered, billed,
  // and not in the shape asked for.
  const REFUSED = answer({ rejected: 'recommendation, confidence or rationale is missing or out of range', confidence: 0 })

  it('is not asked again after five in a row, and the others carry on', async () => {
    const times = Array.from({ length: 12 }, (_, i) => i)
    const { result, asked } = await run({ times, concurrency: 1, reply: (model) => (model === 'b' ? REFUSED : answer()) })
    expect(asked.filter((entry) => entry.startsWith('b@'))).toHaveLength(BENCHMARK_MAX_CONSECUTIVE_REFUSALS)
    expect(asked.filter((entry) => entry.startsWith('a@'))).toHaveLength(12)
    expect(result.dropped).toEqual([{ model: 'b', error: REFUSED.rejected, refused: true }])
    // Unlike a call that failed, each refusal was an answer: it is kept, and it was paid for.
    expect(result.answers.b.filter((entry) => entry !== null)).toHaveLength(BENCHMARK_MAX_CONSECUTIVE_REFUSALS)
    expect(result.costUsd).toBeCloseTo((12 + BENCHMARK_MAX_CONSECUTIVE_REFUSALS) * 0.002, 10)
    expect(result.stopped).toBeNull()
  })

  it('is given the benefit of a refusal here and there', async () => {
    const times = Array.from({ length: 12 }, (_, i) => i)
    // Four refusals, an answer, four refusals, an answer...
    const { result } = await run({ times, models: ['a'], concurrency: 1, reply: (_model, index) => (index % 5 === 4 ? answer() : REFUSED) })
    expect(result.dropped).toEqual([])
    expect(result.asked).toBe(12)
  })
})
