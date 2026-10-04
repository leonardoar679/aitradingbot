import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_BENCHMARK_MAX_DECISIONS, AI_BENCHMARK_MAX_MODELS, type AiBenchmarkPeekRequest } from '../shared/aiBenchmark'
import { DEFAULT_AI_MODEL, GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'
import { benchmarkAskRequest, benchmarkPeekCandles } from '../src/agents/benchmark'

// A benchmark across the bridge, with the network faked and everything else real: the renderer's
// own request builders on one side, the main process's cache, ledger and budget on the other.
// What these pin is that looking costs nothing, that every model is asked the same thing, and that
// an answer is found again by whoever asks for it -- the benchmark, a backtest or a bot.

const credential = vi.hoisted(() => ({ missing: false }))

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => {
    if (credential.missing) throw new Error('No OpenRouter API key configured. Add one on the Agents page.')
    return { apiKey: 'sk-or-test' }
  }
}))

const BAR = 900
const START = 1_699_999_200
const COST = 0.0021
const OTHER = 'acme/other-model'
const MARKET = { exchange: 'binance' as const, symbol: 'BTCUSDT' }

function series(count: number): Candle[] {
  let seed = 11
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < count; i++) {
    const open = price
    price = Math.max(1, price + (next() - 0.5) * 1.2)
    out.push({ time: START + i * BAR, open, high: Math.max(open, price) + 0.3, low: Math.min(open, price) - 0.3, close: price, volume: 80 + next() * 40 })
  }
  return out
}

/** A market with four sampled decisions, sixteen bars apart, and candles running on past the last. */
const SERIES = series(GPT_LOOKBACK_BARS + 80)
const INDICES = [0, 16, 32, 48].map((offset) => GPT_LOOKBACK_BARS + offset)
const TIMES = INDICES.map((index) => SERIES[index].time)

function peekRequest(over: Partial<AiBenchmarkPeekRequest> = {}): AiBenchmarkPeekRequest {
  return { ...MARKET, interval: '15m', candles: benchmarkPeekCandles(SERIES, TIMES), times: TIMES, models: [DEFAULT_AI_MODEL], ...over }
}

function stubOpenRouter(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? '{}'))
    const content = JSON.stringify({
      recommendation: 'hold',
      confidence: 0.4,
      marketRegime: 'neutral',
      riskLevel: 'medium',
      horizonBars: 16,
      stopLoss: null,
      takeProfit: null,
      reasonCodes: ['range_bound'],
      rationale: 'nothing decisive'
    })
    const body = { provider: 'Test', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: COST } }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
  return { bodies }
}

async function services() {
  const signal = await import('../electron/services/aiSignalService')
  const config = await import('../electron/services/aiConfigService')
  const ledger = await import('../electron/services/aiLedgerService')
  signal.aiRetry.baseDelayMs = 0
  return { ...signal, ...config, ...ledger }
}

beforeEach(() => {
  vi.resetModules()
  credential.missing = false
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-benchmark-'))
})

afterEach(() => vi.unstubAllGlobals())

describe('looking at what a benchmark holds', () => {
  it('reaches no model, writes no row and spends nothing', async () => {
    const { bodies } = stubOpenRouter()
    const { peekAiBenchmark, listAiCalls, getAiConfig } = await services()

    const peek = await peekAiBenchmark(peekRequest())
    expect(peek.models).toEqual([
      { model: DEFAULT_AI_MODEL, decisions: [null, null, null, null], perCallCostUsd: null, costBasis: 'unknown', callsPerAnswer: 1 }
    ])
    expect(peek.budgetRemainingUsd).toBe(1)
    expect(bodies).toHaveLength(0)
    expect((await listAiCalls({})).rows).toHaveLength(0)
    expect((await getAiConfig()).spentTodayUsd).toBe(0)
  })

  it("finds the answer the benchmark's own call paid for, and nothing it did not", async () => {
    const { bodies } = stubOpenRouter()
    const { peekAiBenchmark, generateAiSignalTape, listAiCalls } = await services()

    const tape = await generateAiSignalTape(benchmarkAskRequest(MARKET, SERIES, INDICES[1], DEFAULT_AI_MODEL))
    expect(tape).toMatchObject({ generatedCount: 1, cachedCount: 0 })

    const { models, budgetRemainingUsd } = await peekAiBenchmark(peekRequest())
    expect(models[0].decisions.map((decision) => decision !== null)).toEqual([false, true, false, false])
    expect(models[0].decisions[1]).toMatchObject({ recommendation: 'hold', confidence: 0.4, cached: true, error: null, candleTime: TIMES[1] })
    expect(budgetRemainingUsd).toBeCloseTo(1 - COST, 10)

    // Asked for again, it is the cached answer: one request went out, and one row was written.
    const again = await generateAiSignalTape(benchmarkAskRequest(MARKET, SERIES, INDICES[1], DEFAULT_AI_MODEL))
    expect(again).toMatchObject({ generatedCount: 0, cachedCount: 1 })
    expect(bodies).toHaveLength(1)
    const { rows } = await listAiCalls({})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'benchmark', position: 'flat', candleTime: TIMES[1], promptVersion: GPT_PROMPT_VERSION, interval: '15m' })
    expect(rows[0].strategyId).toBeUndefined()
  })

  it('finds the answer a backtest already paid for at that candle, however much history that run had fetched', async () => {
    const { bodies } = stubOpenRouter()
    const { peekAiBenchmark, generateAiSignalTape } = await services()

    // A backtest's tape: every candle from the start of its fetch, not the benchmark's slice.
    await generateAiSignalTape({
      requestId: 'backtest',
      ...MARKET,
      interval: '15m',
      candles: SERIES.slice(0, INDICES[2] + 1),
      startIndex: INDICES[2],
      maxDecisions: 1,
      source: 'backtest'
    })
    const { models } = await peekAiBenchmark(peekRequest())
    expect(models[0].decisions.map((decision) => decision !== null)).toEqual([false, false, true, false])

    // And the other way round: what the benchmark would ask for is what that tape already holds.
    const mine = await generateAiSignalTape(benchmarkAskRequest(MARKET, SERIES, INDICES[2], DEFAULT_AI_MODEL))
    expect(mine.cachedCount).toBe(1)
    expect(bodies).toHaveLength(1)
  })

  it('gives the same answers whether or not it is sent candles from after the last decision', async () => {
    stubOpenRouter()
    const { peekAiBenchmark, generateAiSignalTape } = await services()
    await generateAiSignalTape(benchmarkAskRequest(MARKET, SERIES, INDICES[3], DEFAULT_AI_MODEL))
    const trimmed = await peekAiBenchmark(peekRequest())
    const whole = await peekAiBenchmark(peekRequest({ candles: SERIES }))
    expect(whole).toEqual(trimmed)
    expect(trimmed.models[0].decisions[3]).not.toBeNull()
  })
})

describe('several models', () => {
  it('are each sent exactly the same question about the same candle', async () => {
    const { bodies } = stubOpenRouter()
    const { generateAiSignalTape, setAiConfig } = await services()
    await setAiConfig({ enabledModels: [DEFAULT_AI_MODEL, OTHER] })

    await generateAiSignalTape(benchmarkAskRequest(MARKET, SERIES, INDICES[0], DEFAULT_AI_MODEL))
    await generateAiSignalTape(benchmarkAskRequest(MARKET, SERIES, INDICES[0], OTHER))
    expect(bodies).toHaveLength(2)
    expect(bodies.map((body) => body.model)).toEqual([DEFAULT_AI_MODEL, OTHER])
    expect(bodies[1].messages).toEqual(bodies[0].messages)
    // Byte for byte, not merely equal after parsing: it is the bytes that are hashed and billed.
    expect(JSON.stringify(bodies[1].messages)).toBe(JSON.stringify(bodies[0].messages))
    const context = JSON.parse((bodies[0].messages as { content: string }[])[1].content)
    expect(context.position).toBe('flat')
    expect(context.lastClose).toBe(SERIES[INDICES[0] - 1].close)
  })

  it('hold their own answers: one model having answered is not another having answered', async () => {
    const { bodies } = stubOpenRouter()
    const { peekAiBenchmark, generateAiSignalTape, setAiConfig } = await services()
    await setAiConfig({ enabledModels: [DEFAULT_AI_MODEL, OTHER] })
    await generateAiSignalTape(benchmarkAskRequest(MARKET, SERIES, INDICES[0], OTHER))

    const { models } = await peekAiBenchmark(peekRequest({ models: [DEFAULT_AI_MODEL, OTHER] }))
    expect(models.map((entry) => entry.model)).toEqual([DEFAULT_AI_MODEL, OTHER])
    expect(models[0].decisions[0]).toBeNull()
    expect(models[1].decisions[0]).toMatchObject({ model: OTHER, cached: true })
    expect(bodies).toHaveLength(1)
  })

  it('are each priced from their own calls', async () => {
    stubOpenRouter()
    const { peekAiBenchmark, generateAiSignalTape, setAiConfig } = await services()
    await setAiConfig({ enabledModels: [DEFAULT_AI_MODEL, OTHER] })
    await generateAiSignalTape(benchmarkAskRequest(MARKET, SERIES, INDICES[0], DEFAULT_AI_MODEL))

    const { models } = await peekAiBenchmark(peekRequest({ models: [DEFAULT_AI_MODEL, OTHER] }))
    expect(models[0].costBasis).toBe('history')
    expect(models[0].perCallCostUsd).toBeCloseTo(COST, 10)
    // Never called here, and no price list held: its cost is not known, and is not borrowed.
    expect(models[1]).toMatchObject({ perCallCostUsd: null, costBasis: 'unknown' })
  })
})

describe('a missing key', () => {
  it('is reported before anyone is asked to agree to a run, but only when a call would be needed', async () => {
    stubOpenRouter()
    const { peekAiBenchmark, generateAiSignalTape } = await services()
    for (const index of INDICES) await generateAiSignalTape(benchmarkAskRequest(MARKET, SERIES, index, DEFAULT_AI_MODEL))

    credential.missing = true
    // Everything is already paid for: reading it back needs no key.
    const held = await peekAiBenchmark(peekRequest())
    expect(held.models[0].decisions.every((decision) => decision !== null)).toBe(true)
    // One more candle is not held, so the run could not start, and this is the moment to say so.
    const more = [...TIMES, SERIES[INDICES[3] + 16].time]
    await expect(peekAiBenchmark(peekRequest({ candles: benchmarkPeekCandles(SERIES, more), times: more }))).rejects.toThrow(/No OpenRouter API key/)
  })
})

describe('a peek that is not a benchmark', () => {
  const shuffled = [...SERIES.slice(0, 5).reverse(), ...SERIES.slice(5)]
  const tooMany = Array.from({ length: AI_BENCHMARK_MAX_DECISIONS + 1 }, (_, i) => START + i * BAR)

  it.each<[string, Partial<AiBenchmarkPeekRequest>, RegExp]>([
    ['another bar size', { interval: '1h' }, /15-minute/],
    ['no symbol', { symbol: ' ' }, /symbol/],
    ['no model', { models: [] }, /between 1 and/],
    ['more models than a benchmark compares', { models: Array.from({ length: AI_BENCHMARK_MAX_MODELS + 1 }, (_, i) => `acme/m${i}`) }, /between 1 and/],
    ['the same model twice', { models: [DEFAULT_AI_MODEL, DEFAULT_AI_MODEL] }, /same model twice/],
    ['a model that has not been enabled', { models: [DEFAULT_AI_MODEL, 'acme/unlisted'] }, /not enabled/],
    ['a model that is not a model id', { models: [undefined as unknown as string] }, /not a model id/],
    ['no decisions', { times: [] }, /between 1 and/],
    ['more decisions than a run may ask', { times: tooMany }, /between 1 and/],
    ['decisions out of order', { times: [TIMES[1], TIMES[0]] }, /out of order/],
    ['the same decision twice', { times: [TIMES[0], TIMES[0]] }, /out of order/],
    ['a decision on a candle that never opened', { times: [TIMES[0] + 1] }, /needs a candle opening/],
    ['a decision without a full lookback before it', { candles: SERIES.slice(1, INDICES[0] + 1), times: [TIMES[0]] }, /needs a candle opening/],
    ['candles out of order', { candles: shuffled }, /out of order/],
    ['something that is not a candle', { candles: [...SERIES.slice(0, -1), { time: Number.NaN } as Candle] }, /completed candles/]
  ])('is refused when it carries %s', async (_label, over, message) => {
    const { bodies } = stubOpenRouter()
    const { peekAiBenchmark } = await services()
    await expect(peekAiBenchmark(peekRequest(over))).rejects.toThrow(message)
    expect(bodies).toHaveLength(0)
  })

  it('does not take a missing model for "the default"', async () => {
    // resolveAiModel reads undefined that way for a run that names no model. A list has no such
    // entry: every model in a benchmark is one somebody ticked.
    stubOpenRouter()
    const { peekAiBenchmark } = await services()
    await expect(peekAiBenchmark(peekRequest({ models: [undefined as unknown as string] }))).rejects.toThrow()
  })
})
