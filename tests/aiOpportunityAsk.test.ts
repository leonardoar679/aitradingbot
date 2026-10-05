import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_OPPORTUNITY_MARKET_SYSTEM_PROMPT } from '../electron/services/aiPrompt'
import { referenceReturns, type EventReference } from '../shared/aiEventMarket'
import { AI_OPPORTUNITY_MARKET_PROMPT_VERSION, AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION, type AiOpportunityAskRequest } from '../shared/aiOpportunity'
import { eventQuestionCandles, referenceCandles } from './eventCandles'

// An event put to a model, end to end, with the network faked and everything else real: the
// detector, the context, the request, the validator, the cache, the ledger and the daily budget.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' })
}))

const COST = 0.0031
const QUESTION = eventQuestionCandles()
const PRICE = QUESTION.candles1m[QUESTION.candles1m.length - 1].close

function request(overrides: Partial<AiOpportunityAskRequest> = {}): AiOpportunityAskRequest {
  return { exchange: 'binance', symbol: 'SOLUSDT', candles15m: QUESTION.candles15m, candles1m: QUESTION.candles1m, ...overrides }
}

function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recommendation: 'buy',
    confidence: 0.8,
    entryMin: PRICE * 0.998,
    entryMax: PRICE * 1.002,
    validMinutes: 15,
    stopLoss: PRICE * 0.985,
    takeProfit: PRICE * 1.03,
    horizonBars: 4,
    marketRegime: 'bull',
    riskLevel: 'medium',
    reasonCodes: ['breakout'],
    rationale: 'Cleared the range on volume.',
    ...overrides
  })
}

interface Reply {
  status?: number
  content?: string
  error?: string
}

function stubOpenRouter(reply: (call: number) => Reply | Promise<Reply>): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? '{}'))
    const { status = 200, content = answer(), error } = await reply(bodies.length)
    const body =
      status === 200
        ? { provider: 'Test', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 2400, completion_tokens: 500, cost: COST } }
        : { error: { code: status, message: error ?? 'refused' } }
    return { ok: status === 200, status, text: async () => JSON.stringify(body) }
  })
  return { bodies }
}

async function services() {
  const tape = await import('../electron/services/aiSignalService')
  const config = await import('../electron/services/aiConfigService')
  const ledger = await import('../electron/services/aiLedgerService')
  tape.aiRetry.baseDelayMs = 0
  return { ...tape, ...config, ...ledger }
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-opportunity-'))
})

afterEach(() => vi.unstubAllGlobals())

describe('asking a model about an event', () => {
  it('is billed once, and the answer is the cached one from then on', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity, listAiCalls, getAiConfig } = await services()

    const first = await askAiOpportunity(request())
    expect(first).toMatchObject({ recommendation: 'buy', confidence: 0.8, cached: false, error: null, rejected: null, candleTime: QUESTION.eventTime })
    expect(first.detail?.entry).toEqual({ min: PRICE * 0.998, max: PRICE * 1.002, validMinutes: 15 })
    expect(first.usage?.costUsd).toBeCloseTo(COST, 10)

    const second = await askAiOpportunity(request())
    expect(second.cached).toBe(true)
    expect(second.detail?.entry).toEqual(first.detail?.entry)
    expect(bodies).toHaveLength(1)
    expect((await getAiConfig()).spentTodayUsd).toBeCloseTo(COST, 10)

    const { rows } = await listAiCalls({})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'ok',
      source: 'opportunity',
      model: 'openai/gpt-5-mini',
      symbol: 'SOLUSDT',
      interval: '15m',
      position: 'flat',
      promptVersion: AI_OPPORTUNITY_PROMPT_VERSION,
      schemaVersion: AI_OPPORTUNITY_SCHEMA_VERSION,
      candleTime: QUESTION.eventTime,
      referencePrice: PRICE,
      eventId: `binance:SOLUSDT:${QUESTION.eventTime}`,
      eventType: 'breakout',
      recommendation: 'buy'
    })
    expect(rows[0].detail?.entry?.validMinutes).toBe(15)
  })

  it('sends the event, the opportunity schema, and nothing that could place an order', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity } = await services()
    await askAiOpportunity(request())
    const body = bodies[0] as { messages: { role: string; content: string }[]; response_format: { json_schema: { name: string } }; tools?: unknown }
    expect(body.response_format.json_schema.name).toBe('market_opportunity')
    expect(body.messages[0].content).toContain('You assess a market event')
    const sent = JSON.parse(body.messages[1].content) as { event: { time: number; type: string; price: number }; symbol: string }
    expect(sent.event).toMatchObject({ time: QUESTION.eventTime, type: 'breakout', price: PRICE })
    expect(sent.symbol).toBe('SOLUSDT')
    expect(body.tools).toBeUndefined()
  })

  it('is the same question however much history the caller sent, so it is paid for once', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity } = await services()
    await askAiOpportunity(request())
    // A caller that held less history: the last twelve hours and seven days exactly.
    const trimmed = await askAiOpportunity(request({ candles1m: QUESTION.candles1m.slice(-720), candles15m: QUESTION.candles15m.slice(-672) }))
    expect(trimmed.cached).toBe(true)
    expect(bodies).toHaveLength(1)
  })

  it('keeps and bills an answer whose levels do not hold together, and treats it as no trade', async () => {
    const { bodies } = stubOpenRouter(() => ({ content: answer({ stopLoss: PRICE * 1.05 }) }))
    const { askAiOpportunity, listAiCalls, getAiConfig } = await services()
    const refused = await askAiOpportunity(request())
    expect(refused.recommendation).toBe('hold')
    expect(refused.rejected).toMatch(/stop .* is not below the entry range/)
    expect(refused.detail).toBeNull()
    expect((await getAiConfig()).spentTodayUsd).toBeCloseTo(COST, 10)
    // Asked again, it is not bought again.
    const again = await askAiOpportunity(request())
    expect(again.cached).toBe(true)
    expect(again.rejected).toMatch(/not below the entry range/)
    expect(bodies).toHaveLength(1)
    expect((await listAiCalls({})).rows[0]).toMatchObject({ status: 'rejected', recommendation: null })
  })

  it('does not cache a call that never reached a model, and asks again next time', async () => {
    const { bodies } = stubOpenRouter((call) => (call <= 3 ? { status: 503, error: 'overloaded' } : {}))
    const { askAiOpportunity } = await services()
    const failed = await askAiOpportunity(request())
    expect(failed.error).toMatch(/overloaded|503/)
    expect(failed.recommendation).toBe('hold')
    const retried = await askAiOpportunity(request())
    expect(retried.error).toBeNull()
    expect(retried.cached).toBe(false)
    expect(bodies).toHaveLength(4)
  })

  it('asks no model about candles that do not end in an event', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity } = await services()
    const calm = eventQuestionCandles({ pct: 0.02 })
    await expect(askAiOpportunity(request({ candles1m: calm.candles1m, candles15m: calm.candles15m }))).rejects.toThrow(/do not end in an event/)
    await expect(askAiOpportunity(request({ candles1m: QUESTION.candles1m.slice(-100) }))).rejects.toThrow(/do not end in an event/)
    await expect(askAiOpportunity(request({ candles1m: [...QUESTION.candles1m].reverse() }))).rejects.toThrow(/out of order/)
    await expect(askAiOpportunity(request({ symbol: ' ' }))).rejects.toThrow(/needs a symbol/)
    expect(bodies).toEqual([])
  })

  it('will not pay for a minute that has not closed', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity } = await services()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // The clock stands one second before the event's bar closes.
      vi.setSystemTime(new Date((QUESTION.eventTime - 1) * 1000))
      await expect(askAiOpportunity(request())).rejects.toThrow(/has not closed yet/)
      expect(bodies).toEqual([])
      vi.setSystemTime(new Date(QUESTION.eventTime * 1000))
      expect((await askAiOpportunity(request())).error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops at the daily budget, and says so', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity, setAiConfig } = await services()
    await setAiConfig({ dailyCapUsd: 0 })
    await expect(askAiOpportunity(request())).rejects.toThrow(/switched off|budget/i)
    expect(bodies).toEqual([])
  })

  it('asks only a model that is enabled, and never a panel', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity } = await services()
    await expect(askAiOpportunity(request({ model: 'some/other-model' }))).rejects.toThrow()
    await expect(askAiOpportunity(request({ model: 'panel:openai/gpt-5-mini' }))).rejects.toThrow()
    expect(bodies).toEqual([])
  })

  it('makes one call when two askers want the same answer at the same moment', async () => {
    const { bodies } = stubOpenRouter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return {}
    })
    const { askAiOpportunity } = await services()
    const [a, b] = await Promise.all([askAiOpportunity(request()), askAiOpportunity(request())])
    expect(bodies).toHaveLength(1)
    expect([a.cached, b.cached].sort()).toEqual([false, true])
  })
})

describe('peeking at an event', () => {
  it('says what is held and what the rest would cost, and spends nothing', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { peekAiOpportunity, askAiOpportunity, getAiConfig } = await services()

    const before = await peekAiOpportunity({ ...request(), models: ['openai/gpt-5-mini'] })
    expect(before.eventId).toBe(`binance:SOLUSDT:${QUESTION.eventTime}`)
    expect(before.eventTime).toBe(QUESTION.eventTime)
    expect(before.models).toEqual([{ model: 'openai/gpt-5-mini', decision: null, perCallCostUsd: null, costBasis: 'unknown', perCallLatencyMs: null }])
    expect(bodies).toEqual([])

    await askAiOpportunity(request())
    const after = await peekAiOpportunity({ ...request(), models: ['openai/gpt-5-mini'] })
    expect(after.models[0].decision).toMatchObject({ recommendation: 'buy', cached: true, candleTime: QUESTION.eventTime })
    // Priced from its own call now, under this prompt.
    expect(after.models[0].perCallCostUsd).toBeCloseTo(COST, 10)
    expect(after.models[0].costBasis).toBe('history')
    expect(bodies).toHaveLength(1)
    expect((await getAiConfig()).spentTodayUsd).toBeCloseTo(COST, 10)
  })

  it('refuses a list of models that is empty, repeats one, or names one that is not enabled', async () => {
    stubOpenRouter(() => ({}))
    const { peekAiOpportunity } = await services()
    await expect(peekAiOpportunity({ ...request(), models: [] })).rejects.toThrow(/between 1 and 6 models/)
    await expect(peekAiOpportunity({ ...request(), models: ['openai/gpt-5-mini', 'openai/gpt-5-mini'] })).rejects.toThrow(/same model twice/)
    await expect(peekAiOpportunity({ ...request(), models: ['some/other-model'] })).rejects.toThrow()
  })

  it('refuses candles that do not end in an event before looking anything up', async () => {
    stubOpenRouter(() => ({}))
    const { peekAiOpportunity } = await services()
    const calm = eventQuestionCandles({ pct: 0.02 })
    await expect(peekAiOpportunity({ ...request({ candles1m: calm.candles1m, candles15m: calm.candles15m }), models: ['openai/gpt-5-mini'] })).rejects.toThrow(/do not end in an event/)
  })
})

describe('pinned, paced, and patient with a provider that says to wait', () => {
  /** A stub that can answer with headers, and a clock the service's waits move on. */
  function rig(reply: (call: number) => { status?: number; retryAfter?: string; body?: Record<string, unknown> }): { bodies: unknown[] } {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(init.body ?? '{}'))
      const { status = 200, retryAfter, body } = reply(bodies.length)
      const payload =
        status === 200
          ? { provider: 'Test', choices: [{ finish_reason: 'stop', message: { content: answer() } }], usage: { prompt_tokens: 2400, completion_tokens: 500, cost: COST }, ...body }
          : { error: { code: status, message: 'slow down' } }
      return {
        ok: status === 200,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
        text: async () => JSON.stringify(payload)
      }
    })
    return { bodies }
  }
  async function paced() {
    const all = await services()
    const waits: number[] = []
    let virtual = Date.now()
    all.aiPace.now = () => virtual
    all.aiPace.sleep = async (ms) => {
      waits.push(ms)
      virtual += ms
    }
    return { ...all, waits }
  }

  it('writes down which version of the model answered', async () => {
    rig(() => ({ body: { model: 'openai/gpt-5-mini-2025-08-07' } }))
    const { askAiOpportunity, listAiCalls } = await paced()
    await askAiOpportunity(request())
    expect((await listAiCalls({})).rows[0].servedModel).toBe('openai/gpt-5-mini-2025-08-07')
  })

  it('writes down nothing for a version a response does not name', async () => {
    rig(() => ({}))
    const { askAiOpportunity, listAiCalls } = await paced()
    await askAiOpportunity(request())
    expect('servedModel' in (await listAiCalls({})).rows[0]).toBe(false)
  })

  it('waits as long as a refusal asks before trying again, and is answered', async () => {
    const { bodies } = rig((call) => (call === 1 ? { status: 429, retryAfter: '7' } : {}))
    const { askAiOpportunity, listAiCalls, waits } = await paced()
    const decision = await askAiOpportunity(request())
    expect(decision.error).toBeNull()
    expect(bodies).toHaveLength(2)
    expect(waits).toContain(7000)
    // One row: the answer. A try that was refused and then answered is one call, billed once.
    expect((await listAiCalls({})).rows.map((row) => row.status)).toEqual(['ok'])
  })

  it('does not hold a call up for longer than it is worth, and says what it was asked to wait', async () => {
    const { bodies } = rig(() => ({ status: 429, retryAfter: '120' }))
    const { askAiOpportunity, listAiCalls, waits } = await paced()
    const decision = await askAiOpportunity(request())
    expect(decision.error).toMatch(/asked for 120 seconds before another try/)
    expect(bodies).toHaveLength(1)
    expect(waits).toEqual([])
    const rows = (await listAiCalls({})).rows
    expect(rows.map((row) => row.status)).toEqual(['failed'])
    // Not cached: asked again, it is asked.
    rig(() => ({}))
    expect((await askAiOpportunity(request())).cached).toBe(false)
  })

  it('starts no more calls to one model in a minute than the setting allows', async () => {
    rig(() => ({}))
    const { askAiOpportunity, setAiConfig, waits } = await paced()
    await setAiConfig({ callsPerMinute: 10 })
    // Eleven different events: the eleventh waits for the first to be a minute old.
    for (let seed = 1; seed <= 10; seed++) {
      const candles = eventQuestionCandles(undefined, seed)
      await askAiOpportunity(request({ candles1m: candles.candles1m, candles15m: candles.candles15m }))
    }
    expect(waits).toEqual([])
    const eleventh = eventQuestionCandles(undefined, 11)
    await askAiOpportunity(request({ candles1m: eleventh.candles1m, candles15m: eleventh.candles15m }))
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(59_000)
    expect(waits[0]).toBeLessThanOrEqual(60_000)
  })

  it('keeps the pace to one of its choices, and remembers it', async () => {
    rig(() => ({}))
    const { setAiConfig, getAiConfig } = await paced()
    expect((await getAiConfig()).callsPerMinute).toBe(30)
    await expect(setAiConfig({ callsPerMinute: 25 })).rejects.toThrow(/at most 10, 20, 30, 60 times a minute/)
    expect((await setAiConfig({ callsPerMinute: 60 })).callsPerMinute).toBe(60)
    vi.resetModules()
    const again = await import('../electron/services/aiConfigService')
    expect((await again.getAiConfig()).callsPerMinute).toBe(60)
    // A file holding a pace that is not one of the choices reads as the default, not as itself.
    const path = join(process.env.AI_TEST_USER_DATA ?? '', 'aiConfig.json')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf-8')), callsPerMinute: 7 }))
    vi.resetModules()
    const healed = await import('../electron/services/aiConfigService')
    expect((await healed.getAiConfig()).callsPerMinute).toBe(30)
  })
})

describe('an event put with the market around it', () => {
  const reference = (): EventReference => ({ btc: referenceCandles(QUESTION.eventTime, 11), eth: referenceCandles(QUESTION.eventTime, 23) })

  it('is asked under its own prompt and version, and shows the model the market', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity, listAiCalls } = await services()
    const decision = await askAiOpportunity(request({ reference: reference() }))
    expect(decision).toMatchObject({ recommendation: 'buy', cached: false, error: null, rejected: null })
    const body = bodies[0] as { messages: { content: string }[]; response_format: { json_schema: { name: string } } }
    expect(body.messages[0].content).toBe(AI_OPPORTUNITY_MARKET_SYSTEM_PROMPT)
    // The same answer shape as the question about the pair alone.
    expect(body.response_format.json_schema.name).toBe('market_opportunity')
    const sent = JSON.parse(body.messages[1].content) as { market: { btc: object; eth: object; vsBtc: object; vsEth: object } }
    expect(Object.keys(sent.market)).toEqual(['btc', 'eth', 'vsBtc', 'vsEth'])
    expect(sent.market.btc).toEqual(referenceReturns(reference().btc, QUESTION.eventTime))
    const { rows } = await listAiCalls({})
    expect(rows[0]).toMatchObject({ promptVersion: AI_OPPORTUNITY_MARKET_PROMPT_VERSION, schemaVersion: AI_OPPORTUNITY_SCHEMA_VERSION, eventId: `binance:SOLUSDT:${QUESTION.eventTime}` })
  })

  it('is a separate question from the pair alone: each is bought once, and neither is served the other\'s answer', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity, peekAiOpportunity, listAiCalls } = await services()
    await askAiOpportunity(request())
    expect((await peekAiOpportunity({ ...request({ reference: reference() }), models: ['openai/gpt-5-mini'] })).models[0].decision).toBeNull()
    expect((await askAiOpportunity(request({ reference: reference() }))).cached).toBe(false)
    expect((await askAiOpportunity(request())).cached).toBe(true)
    expect((await askAiOpportunity(request({ reference: reference() }))).cached).toBe(true)
    expect((await peekAiOpportunity({ ...request({ reference: reference() }), models: ['openai/gpt-5-mini'] })).models[0].decision).toMatchObject({ cached: true })
    expect(bodies).toHaveLength(2)
    expect((await listAiCalls({})).rows.map((row) => row.promptVersion).sort()).toEqual([AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_MARKET_PROMPT_VERSION])
  })

  it('is the question about the pair alone when the reference is sent as nothing', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity } = await services()
    await askAiOpportunity(request())
    expect((await askAiOpportunity(request({ reference: null }))).cached).toBe(true)
    expect(bodies).toHaveLength(1)
  })

  it('is refused before anything is asked when the market\'s candles stop short of the event, or are not candles', async () => {
    const { bodies } = stubOpenRouter(() => ({}))
    const { askAiOpportunity, peekAiOpportunity, listAiCalls } = await services()
    const short: EventReference = { ...reference(), eth: { ...reference().eth, candles1m: reference().eth.candles1m.slice(0, -1) } }
    await expect(askAiOpportunity(request({ reference: short }))).rejects.toThrow(/do not run unbroken to the minute it was read at/)
    await expect(peekAiOpportunity({ ...request({ reference: short }), models: ['openai/gpt-5-mini'] })).rejects.toThrow(/do not run unbroken/)
    const reversed: EventReference = { ...reference(), btc: { ...reference().btc, candles1m: [...reference().btc.candles1m].reverse() } }
    await expect(askAiOpportunity(request({ reference: reversed }))).rejects.toThrow(/BTCUSDT 1-minute candles of an opportunity are out of order/)
    const broken = { btc: reference().btc, eth: { candles1m: 'none', candles15m: [] } } as unknown as EventReference
    await expect(askAiOpportunity(request({ reference: broken }))).rejects.toThrow(/needs completed ETHUSDT 1-minute candles/)
    const noQuarters = { btc: reference().btc, eth: { candles1m: reference().eth.candles1m, candles15m: 'none' } } as unknown as EventReference
    await expect(askAiOpportunity(request({ reference: noQuarters }))).rejects.toThrow(/needs completed ETHUSDT 15-minute candles/)
    expect(bodies).toEqual([])
    expect((await listAiCalls({})).rows).toEqual([])
  })
})
