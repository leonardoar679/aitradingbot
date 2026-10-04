import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiOpportunityAskRequest } from '../shared/aiOpportunity'
import { AI_WATCH_FRESH_SECONDS, type AiWatchConfig } from '../shared/aiWatch'
import { eventQuestionCandles } from './eventCandles'

// The watch's limits where the money is spent: the setting, and a call made in the watch's name,
// with the network faked and everything else real -- the settings file, the ledger, the cache.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' })
}))

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'
const QUESTION = eventQuestionCandles()
const PRICE = QUESTION.candles1m[QUESTION.candles1m.length - 1].close
const DAY = 86_400

/** The same candles under another name are another pair's event: enough for a day of them. */
function request(symbol: string, overrides: Partial<AiOpportunityAskRequest> = {}): AiOpportunityAskRequest {
  return { exchange: 'binance', symbol, candles15m: QUESTION.candles15m, candles1m: QUESTION.candles1m, source: 'watch', ...overrides }
}

function answer(): string {
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
    rationale: 'Cleared the range on volume.'
  })
}

function stubOpenRouter(reply: (call: number) => { status?: number } | Promise<{ status?: number }> = () => ({})): { bodies: { model: string }[] } {
  const bodies: { model: string }[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? '{}'))
    const { status = 200 } = await reply(bodies.length)
    const body =
      status === 200
        ? { provider: 'Test', choices: [{ finish_reason: 'stop', message: { content: answer() } }], usage: { prompt_tokens: 2400, completion_tokens: 500, cost: 0.003 } }
        : { error: { code: status, message: 'overloaded' } }
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

const ON: AiWatchConfig = { enabled: true, models: [A], maxEventsPerDay: 5, minBand: 'urgent', firstModelGates: false }

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-watch-'))
  // Twenty seconds after the event's minute closed: the scanner has raised it and it is fresh.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date((QUESTION.eventTime + 20) * 1000))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the watch setting', () => {
  it('is off until it is switched on, and stays on across a restart', async () => {
    const { getAiConfig, setAiConfig } = await services()
    expect((await getAiConfig()).watch).toEqual({ enabled: false, models: [], maxEventsPerDay: 10, minBand: 'urgent', firstModelGates: false })
    expect((await setAiConfig({ watch: ON })).watch).toEqual(ON)
    vi.resetModules()
    expect((await (await services()).getAiConfig()).watch).toEqual(ON)
  })

  it('cannot be switched on with nobody to ask, a model that is not enabled, or a limit that is not a choice', async () => {
    const { getAiConfig, setAiConfig } = await services()
    await expect(setAiConfig({ watch: { enabled: true } })).rejects.toThrow(/at least one model/)
    await expect(setAiConfig({ watch: { ...ON, models: [B] } })).rejects.toThrow(/is not enabled/)
    await expect(setAiConfig({ watch: { ...ON, maxEventsPerDay: 1000 } })).rejects.toThrow(/events a day/)
    await expect(setAiConfig({ watch: { ...ON, enabled: 'yes' as unknown as boolean } })).rejects.toThrow(/on or off/)
    expect((await getAiConfig()).watch.enabled).toBe(false)
  })

  it('cannot be changed while it is on: what it asks is what was agreed to', async () => {
    const { getAiConfig, setAiConfig } = await services()
    await setAiConfig({ enabledModels: [A, B] })
    await setAiConfig({ watch: ON })
    await expect(setAiConfig({ watch: { maxEventsPerDay: 40 } })).rejects.toThrow(/Switch the watch off before changing what it asks/)
    await expect(setAiConfig({ watch: { models: [A, B] } })).rejects.toThrow(/Switch the watch off/)
    await expect(setAiConfig({ watch: { minBand: 'candidate' } })).rejects.toThrow(/Switch the watch off/)
    expect((await getAiConfig()).watch).toEqual(ON)
    // Saying again what is already so is not a change, and off-and-change in one step is allowed.
    await setAiConfig({ watch: { ...ON } })
    expect((await setAiConfig({ watch: { enabled: false, models: [A, B], maxEventsPerDay: 40 } })).watch).toEqual({ ...ON, enabled: false, models: [A, B], maxEventsPerDay: 40 })
  })

  it('refuses to have a model disabled from under it while on, and drops it from the list while off', async () => {
    const { getAiConfig, setAiConfig } = await services()
    await setAiConfig({ enabledModels: [A, B] })
    await setAiConfig({ watch: { ...ON, models: [B, A] } })
    await expect(setAiConfig({ enabledModels: [A] })).rejects.toThrow(/is one of the models the watch asks/)
    expect((await getAiConfig()).enabledModels).toEqual([A, B])
    await setAiConfig({ watch: { enabled: false } })
    expect((await setAiConfig({ enabledModels: [A] })).watch).toMatchObject({ enabled: false, models: [A] })
  })

  it('reads a stored watch that could not have been switched on as off', async () => {
    const dir = process.env.AI_TEST_USER_DATA as string
    writeFileSync(join(dir, 'aiConfig.json'), JSON.stringify({ defaultModel: A, enabledModels: [A], watch: { ...ON, models: [A, B] } }))
    expect((await (await services()).getAiConfig()).watch).toMatchObject({ enabled: false, models: [A] })
  })
})

describe('a call made in the watch\'s name', () => {
  it('is refused, and nothing is asked, while the watch is off', async () => {
    const { bodies } = stubOpenRouter()
    const { askAiOpportunity, listAiCalls } = await services()
    await expect(askAiOpportunity(request('SOLUSDT'))).rejects.toThrow(/watch is off/)
    expect(bodies).toEqual([])
    expect((await listAiCalls({})).rows).toEqual([])
  })

  it('is made when the watch is on, and its row says who asked', async () => {
    const { bodies } = stubOpenRouter()
    const { askAiOpportunity, listAiCalls, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    const decision = await askAiOpportunity(request('SOLUSDT'))
    expect(decision).toMatchObject({ recommendation: 'buy', cached: false, error: null })
    expect(bodies).toHaveLength(1)
    expect((await listAiCalls({ source: 'watch' })).rows).toMatchObject([{ source: 'watch', status: 'ok', eventId: `binance:SOLUSDT:${QUESTION.eventTime}` }])
  })

  it('is refused for a model the watch was not given', async () => {
    const { bodies } = stubOpenRouter()
    const { askAiOpportunity, setAiConfig } = await services()
    await setAiConfig({ enabledModels: [A, B] })
    await setAiConfig({ watch: ON })
    await expect(askAiOpportunity(request('SOLUSDT', { model: B }))).rejects.toThrow(/not one of the models the watch asks/)
    expect(bodies).toEqual([])
  })

  it('does not take up an event more than three minutes old', async () => {
    const { bodies } = stubOpenRouter()
    const { askAiOpportunity, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    vi.setSystemTime(new Date((QUESTION.eventTime + AI_WATCH_FRESH_SECONDS + 1) * 1000))
    await expect(askAiOpportunity(request('SOLUSDT'))).rejects.toThrow(/last 3 minutes/)
    expect(bodies).toEqual([])
    vi.setSystemTime(new Date((QUESTION.eventTime + AI_WATCH_FRESH_SECONDS) * 1000))
    expect((await askAiOpportunity(request('SOLUSDT'))).error).toBeNull()
  })

  it('stops at its events for the day, and still puts one it has taken up to its other models', async () => {
    const { bodies } = stubOpenRouter()
    const { askAiOpportunity, setAiConfig } = await services()
    await setAiConfig({ enabledModels: [A, B] })
    await setAiConfig({ watch: { ...ON, models: [A, B] } })
    for (const symbol of ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'EUSDT']) await askAiOpportunity(request(symbol, { model: A }))
    await expect(askAiOpportunity(request('FUSDT', { model: A }))).rejects.toThrow(/its 5 events for today/)
    expect(bodies).toHaveLength(5)
    // The fifth event has its place: the second model may still be asked about it, minutes later.
    vi.setSystemTime(new Date((QUESTION.eventTime + 600) * 1000))
    expect((await askAiOpportunity(request('EUSDT', { model: B }))).error).toBeNull()
    expect(bodies).toHaveLength(6)
    await expect(askAiOpportunity(request('FUSDT', { model: B }))).rejects.toThrow()
    expect(bodies).toHaveLength(6)
  })

  it('counts an event whose call never reached a model, so a provider that is down is not tried all day', async () => {
    const { bodies } = stubOpenRouter(() => ({ status: 503 }))
    const { askAiOpportunity, setAiConfig, listAiCalls } = await services()
    await setAiConfig({ watch: ON })
    for (const symbol of ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'EUSDT']) expect((await askAiOpportunity(request(symbol))).error).not.toBeNull()
    const made = bodies.length
    await expect(askAiOpportunity(request('FUSDT'))).rejects.toThrow(/its 5 events for today/)
    expect(bodies).toHaveLength(made)
    expect((await listAiCalls({ source: 'watch', status: 'failed' })).rows).toHaveLength(5)
  })

  it('gives the last place of the day to one of two events that ask for it at the same moment', async () => {
    const { bodies } = stubOpenRouter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {}
    })
    const { askAiOpportunity, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    for (const symbol of ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT']) await askAiOpportunity(request(symbol))
    const settled = await Promise.allSettled([askAiOpportunity(request('EUSDT')), askAiOpportunity(request('FUSDT')), askAiOpportunity(request('GUSDT'))])
    expect(settled.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected', 'rejected'])
    expect(bodies).toHaveLength(5)
  })

  it('lets every model of one event through together', async () => {
    const { bodies } = stubOpenRouter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {}
    })
    const { askAiOpportunity, setAiConfig } = await services()
    await setAiConfig({ enabledModels: [A, B] })
    await setAiConfig({ watch: { ...ON, models: [A, B] } })
    for (const symbol of ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT']) await askAiOpportunity(request(symbol, { model: A }))
    const both = await Promise.all([askAiOpportunity(request('EUSDT', { model: A })), askAiOpportunity(request('EUSDT', { model: B }))])
    expect(both.map((decision) => decision.error)).toEqual([null, null])
    expect(bodies).toHaveLength(6)
  })

  it('starts a new count at the next UTC midnight', async () => {
    const { bodies } = stubOpenRouter()
    const { askAiOpportunity, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    for (const symbol of ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'EUSDT']) await askAiOpportunity(request(symbol))
    // The same market a day on: every candle, and so the event, twenty-four hours later.
    const later = (candles: typeof QUESTION.candles1m): typeof QUESTION.candles1m => candles.map((candle) => ({ ...candle, time: candle.time + DAY }))
    vi.setSystemTime(new Date((QUESTION.eventTime + DAY + 20) * 1000))
    expect((await askAiOpportunity(request('FUSDT', { candles1m: later(QUESTION.candles1m), candles15m: later(QUESTION.candles15m) }))).error).toBeNull()
    expect(bodies).toHaveLength(6)
  })

  it('does not stand between anyone and an answer that is already held', async () => {
    const { bodies } = stubOpenRouter()
    const { askAiOpportunity } = await services()
    // Bought by a click. The watch is off, and reading the cache spends nothing.
    await askAiOpportunity(request('SOLUSDT', { source: 'opportunity' }))
    expect(await askAiOpportunity(request('SOLUSDT'))).toMatchObject({ cached: true, error: null })
    expect(bodies).toHaveLength(1)
  })

  it('leaves a call that was not made in its name alone', async () => {
    const { bodies } = stubOpenRouter()
    const { askAiOpportunity, listAiCalls } = await services()
    // Off, stale, no place left: none of it applies to a click or a benchmark.
    vi.setSystemTime(new Date((QUESTION.eventTime + 5000) * 1000))
    await askAiOpportunity(request('AUSDT', { source: 'opportunity' }))
    await askAiOpportunity(request('BUSDT', { source: 'benchmark' }))
    await askAiOpportunity(request('CUSDT', { source: undefined }))
    // A label this call does not take is read as a click, not trusted.
    await askAiOpportunity(request('DUSDT', { source: 'bot' }))
    expect(bodies).toHaveLength(4)
    expect((await listAiCalls({})).rows.map((row) => row.source).sort()).toEqual(['benchmark', 'opportunity', 'opportunity', 'opportunity'])
  })

  it('still stops at the daily budget', async () => {
    const { bodies } = stubOpenRouter()
    const { askAiOpportunity, setAiConfig, listAiCalls } = await services()
    await setAiConfig({ watch: ON, dailyCapUsd: 0 })
    await expect(askAiOpportunity(request('SOLUSDT'))).rejects.toThrow(/switched off|budget/i)
    expect(bodies).toEqual([])
    // Nothing was asked, so the event has not used one of the day's places.
    expect((await listAiCalls({ source: 'watch' })).rows).toEqual([])
  })
})
