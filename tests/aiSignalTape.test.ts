import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GPT_INTRADAY_INTERVAL, GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION, type AiSignalTapeRequest } from '../shared/aiSignal'
import type { AiCallRecord } from '../shared/aiLedger'
import type { Candle } from '../shared/ipc'

// The paid path, end to end, with the network faked and everything else real: the context, the
// request, the validator, the cache, the ledger and the daily budget all run as shipped, against
// a throwaway user-data folder. What these pin is what each rule costs when it is wrong -- a
// decision billed twice, a dead key asked two thousand times, a run that spends past its budget.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' })
}))

const BAR = 900
const START = 1_699_999_200
const COST = 0.0021

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

function request(decisions: number, requestId = 'run'): AiSignalTapeRequest {
  return {
    requestId,
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: GPT_INTRADAY_INTERVAL,
    candles: series(GPT_LOOKBACK_BARS + decisions),
    startIndex: GPT_LOOKBACK_BARS,
    maxDecisions: decisions,
    source: 'backtest'
  }
}

function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recommendation: 'hold',
    confidence: 0.4,
    marketRegime: 'neutral',
    riskLevel: 'medium',
    horizonBars: 16,
    stopLoss: null,
    takeProfit: null,
    reasonCodes: ['range_bound'],
    rationale: 'nothing decisive',
    ...overrides
  })
}

interface Reply {
  status?: number
  content?: string
  error?: string
}

/** Fakes OpenRouter's completion endpoint. `reply` is asked once per request, so a test can answer
 * differently each time; `bodies` keeps what was sent. */
function stubOpenRouter(reply: (call: number) => Reply | Promise<Reply>): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? '{}'))
    const { status = 200, content = answer(), error } = await reply(bodies.length)
    const body =
      status === 200
        ? { provider: 'Test', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: COST } }
        : { error: { code: status, message: error ?? 'refused' } }
    return { ok: status === 200, status, text: async () => JSON.stringify(body) }
  })
  return { bodies }
}

/** Fresh module state for every test: the config cache, the in-flight map and the ledger's append
 * queues are all module-level, and one test's budget must not be the next one's. */
async function services() {
  const tape = await import('../electron/services/aiSignalService')
  const config = await import('../electron/services/aiConfigService')
  const ledger = await import('../electron/services/aiLedgerService')
  tape.aiRetry.baseDelayMs = 0
  return { ...tape, ...config, ...ledger }
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-tape-'))
})

afterEach(() => vi.unstubAllGlobals())

describe('one decision', () => {
  it('is asked for once, and the rerun is served from the cache', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape, listAiCalls, getAiConfig } = await services()

    const first = await generateAiSignalTape(request(1))
    expect(first.generatedCount).toBe(1)
    expect(first.cachedCount).toBe(0)
    expect(first.costUsd).toBeCloseTo(COST, 10)
    expect(first.model).toBe('openai/gpt-5-mini')
    expect(first.decisions[0].detail?.marketRegime).toBe('neutral')

    const second = await generateAiSignalTape(request(1, 'rerun'))
    expect(second.cachedCount).toBe(1)
    expect(second.generatedCount).toBe(0)
    expect(second.costUsd).toBe(0)
    expect(bodies).toHaveLength(1)

    // One row, not two: the rerun spent nothing and so has nothing to record.
    const { rows } = await listAiCalls({})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'ok', model: 'openai/gpt-5-mini', source: 'backtest', symbol: 'BTCUSDT', recommendation: 'hold' })
    expect(rows[0].usage).toMatchObject({ promptTokens: 1500, completionTokens: 400, costUsd: COST })
    expect((await getAiConfig()).spentTodayUsd).toBeCloseTo(COST, 10)
  })

  it('sends the model the context and nothing that could place an order', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape } = await services()
    await generateAiSignalTape(request(1))

    const messages = bodies[0].messages as { role: string; content: string }[]
    const context = JSON.parse(messages[1].content)
    expect(context.symbol).toBe('BTCUSDT')
    expect(context.position).toBe('flat')
    expect(context.timeframes).toHaveLength(3)
    // No tools, no functions: the model is given a snapshot and returns a JSON object. It has no
    // way to ask this app to do anything.
    expect(bodies[0]).not.toHaveProperty('tools')
    expect(bodies[0]).not.toHaveProperty('functions')
  })

  it('tells the model it is long on the candle after a confident buy', async () => {
    // The position is in the prompt, so the position machine has to be walked while the tape is
    // generated -- a model asked "should I buy" while already long is being asked the wrong thing.
    const { bodies } = stubOpenRouter((call) => ({ content: call === 1 ? answer({ recommendation: 'buy', confidence: 0.9 }) : answer() }))
    const { generateAiSignalTape } = await services()
    await generateAiSignalTape(request(2))
    const positions = bodies.map((body) => JSON.parse((body.messages as { content: string }[])[1].content).position)
    expect(positions).toEqual(['flat', 'long'])
  })
})

describe('an answer that cannot be used', () => {
  it('is cached when the model gave it, so it is not paid for twice', async () => {
    const { bodies } = stubOpenRouter(() => ({ content: answer({ recommendation: 'buy', confidence: 0.95, marketRegime: 'sideways' }) }))
    const { generateAiSignalTape, listAiCalls } = await services()

    const first = await generateAiSignalTape(request(1))
    expect(first.rejectedCount).toBe(1)
    expect(first.errorCount).toBe(0)
    // Refused whole: the confident buy inside it does not survive as a signal.
    expect(first.decisions[0]).toMatchObject({ recommendation: 'hold', confidence: 0, error: null })
    expect(first.decisions[0].rejected).toContain('marketRegime')

    const second = await generateAiSignalTape(request(1, 'rerun'))
    expect(second.cachedCount).toBe(1)
    expect(second.rejectedCount).toBe(1)
    expect(bodies).toHaveLength(1)
    expect((await listAiCalls({})).rows[0]).toMatchObject({ status: 'rejected', recommendation: null })
  })

  it('is refused when it is not JSON at all', async () => {
    stubOpenRouter(() => ({ content: 'I think you should buy.' }))
    const { generateAiSignalTape } = await services()
    const tape = await generateAiSignalTape(request(1))
    expect(tape.decisions[0].rejected).toContain('not valid JSON')
  })

  it('is NOT cached when the model was never reached', async () => {
    const { bodies } = stubOpenRouter(() => ({ status: 503, error: 'no provider' }))
    const { generateAiSignalTape, listAiCalls, getAiConfig } = await services()

    const first = await generateAiSignalTape(request(1))
    expect(first.errorCount).toBe(1)
    expect(first.decisions[0].error).toContain('503')
    expect(bodies).toHaveLength(3) // tried three times before giving up on this decision

    // The whole point: a failure must be asked again, or one bad afternoon is cached for good.
    await generateAiSignalTape(request(1, 'rerun'))
    expect(bodies).toHaveLength(6)
    expect((await listAiCalls({})).rows.map((row) => row.status)).toEqual(['failed', 'failed'])
    expect((await getAiConfig()).spentTodayUsd).toBe(0)
  })
})

describe('a run that should stop', () => {
  it('stops on the first call when the refusal will not change', async () => {
    const { bodies } = stubOpenRouter(() => ({ status: 401, error: 'No auth credentials found' }))
    const { generateAiSignalTape } = await services()
    await expect(generateAiSignalTape(request(6))).rejects.toThrow(/rejected the API key/)
    // One request. Not three per decision across six decisions.
    expect(bodies).toHaveLength(1)
  })

  it('gives up after five decisions fail in a row', async () => {
    const { bodies } = stubOpenRouter(() => ({ status: 429, error: 'slow down' }))
    const { generateAiSignalTape } = await services()
    await expect(generateAiSignalTape(request(20))).rejects.toThrow(/Stopped after 5 AI calls failed in a row/)
    expect(bodies).toHaveLength(15)
  })

  it('makes no call at all when the budget is zero', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape, setAiConfig } = await services()
    await setAiConfig({ dailyCapUsd: 0 })
    await expect(generateAiSignalTape(request(1))).rejects.toThrow(/switched off/)
    expect(bodies).toHaveLength(0)
  })

  it('stops when the budget runs out, and loses nothing it had already paid for', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape, setAiConfig } = await services()
    // Room for one call and part of a second: the check is made before each call, so the second
    // is allowed to start and the third is not.
    await setAiConfig({ dailyCapUsd: COST * 1.5 })
    await expect(generateAiSignalTape(request(5))).rejects.toThrow(/budget is used up/)
    expect(bodies).toHaveLength(2)

    await setAiConfig({ dailyCapUsd: 1 })
    const resumed = await generateAiSignalTape(request(5, 'resumed'))
    expect(resumed.cachedCount).toBe(2)
    expect(resumed.generatedCount).toBe(3)
    expect(bodies).toHaveLength(5)
  })

  it('refuses a model that has not been enabled', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape } = await services()
    await expect(generateAiSignalTape({ ...request(1), model: 'acme/unlisted' })).rejects.toThrow(/not enabled/)
    expect(bodies).toHaveLength(0)
  })
})

describe('two callers at once', () => {
  it('pay once for the same candle', async () => {
    // A bot is polled by its card, its detail view, the Positions page and the portfolio
    // scheduler. Two of them missing the cache together must not mean two bills.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { bodies } = stubOpenRouter(async () => {
      await held
      return {}
    })
    const { generateAiSignalTape } = await services()

    const a = generateAiSignalTape(request(1, 'a'))
    const b = generateAiSignalTape(request(1, 'b'))
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    // Long enough for the second caller to have reached the model too, had it been going to.
    await new Promise((resolve) => setTimeout(resolve, 30))
    release()

    const tapes = await Promise.all([a, b])
    expect(bodies).toHaveLength(1)
    expect(tapes.map((tape) => tape.generatedCount).sort()).toEqual([0, 1])
    // The joiner is not charged for a call it did not make.
    expect(tapes.reduce((sum, tape) => sum + tape.costUsd, 0)).toBeCloseTo(COST, 10)
  })

  it('lets a cancelled run go while its call finishes and is kept', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { bodies } = stubOpenRouter(async () => {
      await held
      return {}
    })
    const { generateAiSignalTape, cancelAiSignalTape } = await services()

    const run = generateAiSignalTape(request(1, 'cancel-me'))
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    cancelAiSignalTape('cancel-me')
    await expect(run).rejects.toThrow(/cancelled/)

    // The request was already with the provider and has very likely been billed. Its answer is
    // kept, so the next run does not pay for the same decision again.
    release()
    await vi.waitFor(async () => expect((await generateAiSignalTape(request(1, 'after'))).cachedCount).toBe(1))
    expect(bodies).toHaveLength(1)
  })
})

describe('estimateAiSignalTape', () => {
  it('counts what is cached and prices the rest from what this model has actually cost', async () => {
    stubOpenRouter(() => ({}))
    const { generateAiSignalTape, estimateAiSignalTape } = await services()

    const before = await estimateAiSignalTape(request(3))
    expect(before).toMatchObject({ total: 3, cached: 0, maximumApiCalls: 3, model: 'openai/gpt-5-mini' })
    // Never called and no price list held: the honest answer is that the cost is not known.
    expect(before.costBasis).toBe('unknown')
    expect(before.estimatedCostUsd).toBeNull()
    expect(before.budgetRemainingUsd).toBe(1)

    await generateAiSignalTape(request(2))
    const after = await estimateAiSignalTape(request(3))
    expect(after).toMatchObject({ total: 3, cached: 2, maximumApiCalls: 1, costBasis: 'history' })
    expect(after.perCallCostUsd).toBeCloseTo(COST, 10)
    expect(after.estimatedCostUsd).toBeCloseTo(COST, 10)
    expect(after.budgetRemainingUsd).toBeCloseTo(1 - 2 * COST, 10)
  })

  it('still prices a call when no decision is due yet, as for a bot switched on this instant', async () => {
    stubOpenRouter(() => ({}))
    const { generateAiSignalTape, estimateAiSignalTape } = await services()
    await generateAiSignalTape(request(1))
    const estimate = await estimateAiSignalTape({ ...request(1), candles: series(GPT_LOOKBACK_BARS) })
    expect(estimate.total).toBe(0)
    expect(estimate.estimatedCostUsd).toBe(0)
    expect(estimate.perCallCostUsd).toBeCloseTo(COST, 10)
  })
})

// A model asked every hour or every four hours instead of on every candle. `series` starts on the
// hour and two hours past a four-hour boundary, so from the first tradeable candle (index 672)
// every fourth candle opens on the hour, and the four-hour candles are 680, 696, 712 ...
describe('a tape asked less often than every candle', () => {
  function spaced(extra: number, over: Partial<AiSignalTapeRequest> = {}): AiSignalTapeRequest {
    return {
      requestId: 'spaced',
      exchange: 'binance',
      symbol: 'BTCUSDT',
      interval: GPT_INTRADAY_INTERVAL,
      candles: series(GPT_LOOKBACK_BARS + extra),
      startIndex: GPT_LOOKBACK_BARS,
      source: 'backtest',
      ...over
    }
  }
  const positionsSent = (bodies: Record<string, unknown>[]): string[] =>
    bodies.map((body) => JSON.parse((body.messages as { content: string }[])[1].content).position)

  it('asks only about the candles that open on the hour', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape } = await services()
    const request = spaced(16, { decideEveryBars: 4 })

    const tape = await generateAiSignalTape(request)
    expect(bodies).toHaveLength(4)
    expect(tape.generatedCount).toBe(4)
    expect(tape.decisions.map((decision) => decision.candleTime)).toEqual(
      [0, 4, 8, 12].map((offset) => request.candles[GPT_LOOKBACK_BARS + offset].time)
    )
    expect(tape.decisions.every((decision) => decision.candleTime % 3600 === 0)).toBe(true)
  })

  it('asks on the four-hour clock, not on every sixteenth candle from where the run began', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape } = await services()
    const request = spaced(32, { decideEveryBars: 16 })

    const tape = await generateAiSignalTape(request)
    expect(bodies).toHaveLength(2)
    expect(tape.decisions.map((decision) => decision.candleTime)).toEqual([request.candles[680].time, request.candles[696].time])
    expect(tape.decisions.every((decision) => decision.candleTime % 14_400 === 0)).toBe(true)
  })

  it('asks the very question an every-candle run asks at that candle, so neither pays for the other', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape } = await services()

    // One candle, asked the old way...
    await generateAiSignalTape(request(1))
    expect(bodies).toHaveLength(1)
    // ...is the first of the hourly run's four, and is not asked again.
    const hourly = await generateAiSignalTape(spaced(16, { decideEveryBars: 4 }))
    expect(hourly).toMatchObject({ cachedCount: 1, generatedCount: 3 })
    expect(bodies).toHaveLength(4)
    // And the other way round: an every-candle run over the same stretch asks only for the twelve
    // candles the hourly run skipped.
    const dense = await generateAiSignalTape(spaced(16, { requestId: 'dense' }))
    expect(dense).toMatchObject({ cachedCount: 4, generatedCount: 12 })
    expect(bodies).toHaveLength(16)
  })

  it('applies a stop on a candle between two questions, so the next question is asked flat', async () => {
    // A confident buy on the first candle, then four quiet candles to the next question.
    const { bodies } = stubOpenRouter((call) => ({ content: call === 1 ? answer({ recommendation: 'buy', confidence: 0.9 }) : answer() }))
    const { generateAiSignalTape, estimateAiSignalTape } = await services()
    const quiet = series(GPT_LOOKBACK_BARS + 8)
    const entry = quiet[GPT_LOOKBACK_BARS].close
    for (let index = GPT_LOOKBACK_BARS + 1; index < quiet.length; index++) {
      quiet[index] = { ...quiet[index], open: entry, high: entry + 0.1, low: entry - 0.1, close: entry }
    }
    // The same market, except that two candles after the entry price falls through the stop.
    const crashed = quiet.map((candle, index) => (index === GPT_LOOKBACK_BARS + 2 ? { ...candle, low: 1 } : candle))

    await generateAiSignalTape(spaced(8, { decideEveryBars: 4, candles: crashed }))
    expect(positionsSent(bodies)).toEqual(['flat', 'flat'])
    // The estimate walks the same path to find what is already paid for. If it skipped that stop
    // it would look for a "long" answer nobody has, and price a finished run as one call short.
    expect(await estimateAiSignalTape(spaced(8, { decideEveryBars: 4, candles: crashed }))).toMatchObject({ total: 2, cached: 2, maximumApiCalls: 0 })
    // Without the fall the position is still open at the second question, and the model is told so.
    await generateAiSignalTape(spaced(8, { decideEveryBars: 4, candles: quiet, requestId: 'quiet' }))
    expect(positionsSent(bodies)).toEqual(['flat', 'flat', 'long'])
  })

  it('counts decisions, not candles, in its estimate and against its ceiling', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape, estimateAiSignalTape } = await services()

    expect(await estimateAiSignalTape(spaced(16, { decideEveryBars: 4 }))).toMatchObject({ total: 4, cached: 0, maximumApiCalls: 4, decideEveryBars: 4 })
    const everyCandle = await estimateAiSignalTape(spaced(16))
    expect(everyCandle).toMatchObject({ total: 16, maximumApiCalls: 16 })
    expect(everyCandle).not.toHaveProperty('decideEveryBars')

    const capped = await generateAiSignalTape(spaced(16, { decideEveryBars: 4, maxDecisions: 2 }))
    expect(capped.decisions).toHaveLength(2)
    expect(bodies).toHaveLength(2)
    expect(await estimateAiSignalTape(spaced(16, { decideEveryBars: 4 }))).toMatchObject({ total: 4, cached: 2, maximumApiCalls: 2 })
  })

  it('refuses a cadence it does not offer before asking anything', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape, estimateAiSignalTape } = await services()
    await expect(generateAiSignalTape(spaced(16, { decideEveryBars: 3 }))).rejects.toThrow(/every 15 minutes, every hour or every four hours/)
    await expect(estimateAiSignalTape(spaced(16, { decideEveryBars: 0 }))).rejects.toThrow(/every 15 minutes, every hour or every four hours/)
    expect(bodies).toHaveLength(0)
  })
})

describe('a model asked at a lower reasoning effort', () => {
  const LOW = 'openai/gpt-5-mini@low'

  it('is the same model on the wire with the effort as a parameter, and its own answer everywhere else', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape, setAiConfig, listAiCalls } = await services()
    await setAiConfig({ enabledModels: ['openai/gpt-5-mini', LOW] })

    const low = await generateAiSignalTape({ ...request(1), model: LOW })
    expect(low.model).toBe(LOW)
    expect(low.decisions[0].model).toBe(LOW)
    expect(bodies[0]).toMatchObject({ model: 'openai/gpt-5-mini', reasoning: { effort: 'low' } })

    // The same candle put to the model at its own default is another question's answer: it is
    // asked, not served from the low-effort one, and goes out with no reasoning parameter at all.
    const plain = await generateAiSignalTape(request(1, 'plain'))
    expect(plain.generatedCount).toBe(1)
    expect(bodies).toHaveLength(2)
    expect(bodies[1].model).toBe('openai/gpt-5-mini')
    expect(bodies[1]).not.toHaveProperty('reasoning')
    // What is asked is identical. Only how hard the model is told to think about it differs.
    expect(bodies[1].messages).toEqual(bodies[0].messages)

    // Each is cached under its own id.
    expect((await generateAiSignalTape({ ...request(1, 'low again'), model: LOW })).cachedCount).toBe(1)
    expect((await generateAiSignalTape(request(1, 'plain again'))).cachedCount).toBe(1)
    expect(bodies).toHaveLength(2)

    // And recorded under it, so what each effort costs is added up separately.
    const { rows } = await listAiCalls({})
    expect(rows.map((row) => row.model).sort()).toEqual(['openai/gpt-5-mini', LOW])
    expect((await listAiCalls({ model: LOW })).rows).toHaveLength(1)
  })

  it('is refused until it has been enabled, like any model', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { generateAiSignalTape } = await services()
    await expect(generateAiSignalTape({ ...request(1), model: LOW })).rejects.toThrow(/is not enabled/)
    expect(bodies).toHaveLength(0)
  })
})

describe('how long a run will take', () => {
  it('is read from what this model has taken to answer under the same prompt', async () => {
    stubOpenRouter(() => ({}))
    const { estimateAiSignalTape, appendAiCall } = await services()
    // Nothing has been asked here, so there is nothing to go by. Unlike a price, a pace has no list.
    expect((await estimateAiSignalTape(request(3))).perCallLatencyMs).toBeNull()

    const now = Math.floor(Date.now() / 1000)
    const row = (id: string, latencyMs: number, overrides: Partial<AiCallRecord> = {}): AiCallRecord => ({
      id,
      at: now,
      source: 'backtest',
      status: 'ok',
      model: 'openai/gpt-5-mini',
      provider: 'Test',
      promptVersion: GPT_PROMPT_VERSION,
      contextVersion: 'context-v1',
      schemaVersion: 'signal-v2',
      exchange: 'binance',
      symbol: 'BTCUSDT',
      interval: '15m',
      candleTime: now,
      position: 'flat',
      referencePrice: 100,
      usage: { promptTokens: 2900, completionTokens: 1100, costUsd: 0.003, latencyMs },
      error: null,
      recommendation: 'hold',
      confidence: 0.4,
      rationale: 'nothing decisive',
      detail: null,
      ...overrides
    })
    await appendAiCall(row('a', 12_000))
    await appendAiCall(row('b', 14_000))
    // None of these is this model answering this prompt.
    await appendAiCall(row('c', 60_000, { status: 'failed' }))
    await appendAiCall(row('d', 2_000, { promptVersion: 'panel-trend-v1' }))
    await appendAiCall(row('e', 1_000, { model: 'acme/other' }))
    await appendAiCall(row('f', 3_000, { model: 'openai/gpt-5-mini@low' }))

    const estimate = await estimateAiSignalTape(request(3))
    expect(estimate.perCallLatencyMs).toBe(13_000)
    expect(estimate.costBasis).toBe('history')
  })
})

describe('a model whose answers keep being refused', () => {
  // An answer that parses and is not in shape: what a model listed as taking a strict schema sent
  // back for this one on its first real call. It was billed, and it is kept.
  const outOfShape = { content: '{}' }

  it('stops being asked after five in a row, and a rerun stops in the same place for nothing', async () => {
    const { bodies } = stubOpenRouter(() => outOfShape)
    const { generateAiSignalTape, getAiConfig } = await services()

    await expect(generateAiSignalTape(request(12))).rejects.toThrow(
      /the last 5 answers from openai\/gpt-5-mini were refused, and each was billed.*Choose another model/
    )
    // Five paid for, not twelve.
    expect(bodies).toHaveLength(5)
    expect((await getAiConfig()).spentTodayUsd).toBeCloseTo(5 * COST, 10)

    // The five are answers: held, and not bought again. The sixth is still not asked for.
    await expect(generateAiSignalTape(request(12, 'again'))).rejects.toThrow(/were refused/)
    expect(bodies).toHaveLength(5)
  })

  it('carries on through a refusal here and there', async () => {
    const { bodies } = stubOpenRouter((call) => (call % 3 === 0 ? {} : outOfShape))
    const { generateAiSignalTape } = await services()
    const tape = await generateAiSignalTape(request(9))
    expect(tape.decisions).toHaveLength(9)
    expect(tape.rejectedCount).toBe(6)
    expect(bodies).toHaveLength(9)
  })

  it('is stopped only by an answer it would have to buy, never by one it holds', async () => {
    const { bodies } = stubOpenRouter((call) => (call <= 5 ? outOfShape : {}))
    const { generateAiSignalTape } = await services()
    await expect(generateAiSignalTape(request(6))).rejects.toThrow(/were refused/)
    expect(bodies).toHaveLength(5)

    // The sixth decision is then answered some other way: the same question, asked on its own.
    const sixth = await generateAiSignalTape({ ...request(6, 'sixth'), startIndex: GPT_LOOKBACK_BARS + 5, maxDecisions: 1 })
    expect(sixth.generatedCount).toBe(1)
    expect(bodies).toHaveLength(6)

    // Now the whole run is held. Five refusals in a row are in it, and it replays all the same:
    // there is nothing left to pay for, so there is nothing for the stop to protect.
    const whole = await generateAiSignalTape(request(6, 'whole'))
    expect(whole).toMatchObject({ cachedCount: 6, rejectedCount: 5, callCount: 0 })
    expect(bodies).toHaveLength(6)
  })

  it('replays refusals it already holds when nothing more has to be bought', async () => {
    const { bodies } = stubOpenRouter(() => outOfShape)
    const { generateAiSignalTape } = await services()
    expect((await generateAiSignalTape(request(5))).rejectedCount).toBe(5)
    // A run that ends on its fifth refusal has nothing left to ask, so there is nothing to stop.
    const again = await generateAiSignalTape(request(5, 'again'))
    expect(again.cachedCount).toBe(5)
    expect(bodies).toHaveLength(5)
  })
})
