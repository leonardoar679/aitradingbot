import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_ADDITION_PROMPT_VERSIONS } from '../shared/aiAdditions'
import { GPT_INTRADAY_INTERVAL, GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION } from '../shared/aiSignal'
import type { AiCallRecord } from '../shared/aiLedger'
import type { Candle } from '../shared/ipc'
import { eventQuestionCandles } from './eventCandles'

// WHO ASKS WHICH MODEL, IN THE MAIN PROCESS (electron/services/aiConfigService.ts; V7.2-R Stage 1): the user's
// profile as found on 20 October 2026 -- the default on Claude Opus 5.5, the watch, its paper trades, the
// additions and the hourly bot all on GPT-5 Mini -- with the settings file, the bots, the ledger and the price
// list real and the network faked. Disabling GPT-5 Mini names everything that asks it; one move, applied with
// its preview's token, puts every caller on the roles; GPT-5 Mini can then be disabled; and what answers is
// held to what was asked.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({ getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' }) }))
vi.mock('../electron/services/noticeService', () => ({ tell: () => undefined, tellNotice: async () => true }))

const MINI = 'openai/gpt-5-mini'
const OPUS = 'anthropic/claude-opus-5.5'
const ARGON = 'google/gemini-4-argon@low'
const LUNA = 'openai/gpt-6-luna@minimal'
const QUESTION = eventQuestionCandles()
const NOW = QUESTION.eventTime + 20
const DAY = 86_400

const CATALOGUE = {
  fetchedAt: NOW,
  models: [
    { id: MINI, name: 'OpenAI: GPT-5 Mini', contextLength: 400_000, promptPricePerToken: 2.5e-7, completionPricePerToken: 2e-6, structuredOutputs: true, reasoning: true },
    { id: OPUS, name: 'Anthropic: Claude Opus 5.5', contextLength: 1_000_000, promptPricePerToken: 4e-6, completionPricePerToken: 2e-5, structuredOutputs: true, reasoning: true },
    { id: 'google/gemini-4-argon', name: 'Google: Gemini 4 Argon', contextLength: 1_048_576, promptPricePerToken: 2e-6, completionPricePerToken: 1e-5, structuredOutputs: true, reasoning: true },
    { id: 'openai/gpt-6-luna', name: 'OpenAI: GPT-6 Luna', contextLength: 1_050_000, promptPricePerToken: 1e-7, completionPricePerToken: 5e-7, structuredOutputs: true, reasoning: true }
  ]
}

const FOUND = {
  defaultModel: OPUS,
  enabledModels: [MINI, OPUS, 'google/gemini-4-argon', 'openai/gpt-6-luna', LUNA, ARGON],
  route: null,
  dailyCapUsd: 5,
  dailyUsage: null,
  watch: { enabled: true, models: [MINI], maxEventsPerDay: 10, minBand: 'urgent', firstModelGates: false, confirmLive: true, askAt: 'detected' },
  watchPaper: { enabled: true, model: MINI, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1 },
  callsPerMinute: 30,
  additions: { news: true, why: true, exit: true, review: true, daily: true },
  configVersion: 1
}

const BOTS = [
  { id: 'gpt', name: 'GPT BTC hourly', exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', strategy: 'GPT Intraday', strategyId: 'gpt-intraday', enabled: true, enabledAt: NOW - 30 * DAY, archived: false, aiModel: MINI, aiEveryBars: 4 },
  { id: 'trend', name: 'Trend Regime BTC', exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', strategy: 'Trend Regime', strategyId: 'trend-regime-ensemble', enabled: true, enabledAt: NOW - 30 * DAY, archived: false }
]

/** A ledger row of a call GPT-5 Mini answered. */
function row(source: AiCallRecord['source'], at: number, extra: Partial<AiCallRecord>, tokens: [number, number], cost: number): AiCallRecord {
  return {
    id: `${source}-${at}-${Math.random()}`,
    at,
    source,
    status: 'ok',
    model: MINI,
    provider: 'OpenAI',
    servedModel: MINI,
    promptVersion: GPT_PROMPT_VERSION,
    contextVersion: 'ctx',
    schemaVersion: 'schema',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: '15m',
    candleTime: at,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: tokens[0], completionTokens: tokens[1], costUsd: cost, latencyMs: 9000 },
    error: null,
    recommendation: 'hold',
    confidence: 0.5,
    rationale: 'x',
    detail: null,
    ...extra
  } as AiCallRecord
}

function seed(dir: string): void {
  writeFileSync(join(dir, 'aiModels.json'), JSON.stringify(CATALOGUE))
  writeFileSync(join(dir, 'aiConfig.json'), JSON.stringify(FOUND))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ bots: BOTS, botRuns: [], executors: [] }))
  const rows: AiCallRecord[] = []
  // Three watch events yesterday, a bot decision every hour of it, one daily summary.
  for (let k = 0; k < 3; k++) rows.push(row('watch', NOW - DAY + k * 3600, { eventId: `binance:SOLUSDT:${k}`, promptVersion: 'opportunity-v3' }, [5000, 1600], 0.0045))
  for (let k = 0; k < 24; k++) rows.push(row('bot', NOW - DAY + k * 3600, { strategyId: undefined }, [3000, 1200], 0.0032))
  rows.push(row('addition', NOW - DAY + 600, { addition: 'daily', promptVersion: AI_ADDITION_PROMPT_VERSIONS.daily, recommendation: null }, [700, 1500], 0.0033))
  mkdirSync(join(dir, 'aiLedger'), { recursive: true })
  const month = new Date((NOW - DAY) * 1000).toISOString().slice(0, 7)
  writeFileSync(join(dir, 'aiLedger', `calls-${month}.jsonl`), rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
}

async function services() {
  const config = await import('../electron/services/aiConfigService')
  const tape = await import('../electron/services/aiSignalService')
  const ledger = await import('../electron/services/aiLedgerService')
  const additions = await import('../electron/services/aiAdditionsService')
  tape.aiRetry.baseDelayMs = 0
  return { ...config, ...tape, ...ledger, ...additions }
}

const CHOICE = { decide: OPUS, gate: ARGON, summarize: LUNA }

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-routing-'))
  seed(process.env.AI_TEST_USER_DATA)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW * 1000))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const settingsOnFile = (): { bots: (typeof BOTS)[number] & { aiModelHistory?: { model: string; untilSec: number }[] }[] } =>
  JSON.parse(readFileSync(join(process.env.AI_TEST_USER_DATA as string, 'settings.json'), 'utf-8'))

describe('the profile as found', () => {
  it('cannot disable GPT-5 Mini, and the refusal names everything that asks it and the way out', async () => {
    const { setAiConfig, getAiConfig } = await services()
    expect((await getAiConfig()).roles).toBeNull()
    await expect(setAiConfig({ enabledModels: FOUND.enabledModels.filter((model) => model !== MINI) })).rejects.toThrow(
      /openai\/gpt-5-mini is one of the models the watch asks \(asked by: The watch, The watch's paper trades, News analyst, .*Daily summary, Bot GPT BTC hourly\)\. Move them to your choices under Settings › AI/
    )
  })
})

describe('the move to roles', () => {
  it('is priced before anything changes: each caller, its calls a day and the day altogether', async () => {
    const { previewAiRoles, getAiConfig } = await services()
    const preview = await previewAiRoles(CHOICE)
    expect(preview.plan.watch).toMatchObject({ enabled: true, models: [ARGON, OPUS], firstModelGates: true, maxEventsPerDay: 10, confirmLive: true })
    expect(preview.plan.bots).toEqual([{ id: 'gpt', name: 'GPT BTC hourly', from: MINI, to: OPUS }])
    const cost = (id: string) => preview.costs.find((entry) => entry.id === id)!
    // The watch: neither new model has a call here, so each is priced at the watch's own token counts (5,000 in, 1,600 out).
    expect(cost('watch').basis).toEqual(['pricing', 'pricing'])
    expect(cost('watch').perCallUsd[0]).toBeCloseTo(5000 * 2e-6 + 1600 * 1e-5, 10)
    expect(cost('watch').perCallUsd[1]).toBeCloseTo(5000 * 4e-6 + 1600 * 2e-5, 10)
    expect(cost('watch').callsADay).toBe(3)
    expect(cost('watch').mostUsd).toBeCloseTo(10 * (0.026 + 0.052), 10)
    // The hourly bot: 24 decisions a day on Opus, at its own token counts.
    expect(cost('bot:gpt')).toMatchObject({ models: [OPUS], callsADay: 24, mostCallsADay: 24 })
    expect(cost('bot:gpt').expectedUsd).toBeCloseTo(24 * (3000 * 4e-6 + 1200 * 2e-5), 10)
    // The daily summary on Luna at minimal effort; an addition that never asked costs nothing a day at its recent rate.
    expect(cost('addition:daily').perCallUsd[0]).toBeCloseTo(700 * 1e-7 + 1500 * 5e-7, 10)
    expect(cost('addition:news')).toMatchObject({ callsADay: 0, expectedUsd: 0 })
    expect(cost('addition:news').mostUsd).toBeCloseTo(40 * (700 * 1e-7 + 1500 * 5e-7), 10)
    expect(preview.expectedDailyUsd).toBeCloseTo(preview.costs.filter((entry) => entry.on).reduce((sum, entry) => sum + (entry.expectedUsd ?? 0), 0), 10)
    expect(preview.capUsd).toBe(5)
    expect(preview.token).toMatch(/^[0-9a-f]{16}$/)
    expect(preview.text).toContain(`Bot GPT BTC hourly: ${MINI} -> ${OPUS}.`)
    // Nothing changed by looking.
    expect((await getAiConfig()).watch.models).toEqual([MINI])
  })

  it('is refused with a stale token, and applied with the right one: every caller on the roles, the bot moved from now on', async () => {
    const { previewAiRoles, applyAiRoles, getAiConfig, setAiConfig } = await services()
    const preview = await previewAiRoles(CHOICE)
    await expect(applyAiRoles({ choice: CHOICE, token: 'stale' })).rejects.toThrow(/Something changed since this move was priced/)
    expect((await getAiConfig()).roles).toBeNull()
    const done = await applyAiRoles({ choice: CHOICE, token: preview.token })
    expect(done.movedBots).toEqual([{ id: 'gpt', name: 'GPT BTC hourly', from: MINI, to: OPUS }])
    expect(done.config).toMatchObject({
      defaultModel: OPUS,
      roles: { gate: ARGON, summarize: LUNA },
      watch: { enabled: true, models: [ARGON, OPUS], firstModelGates: true, maxEventsPerDay: 10, minBand: 'urgent', confirmLive: true },
      watchPaper: { enabled: true, model: OPUS, stakeQuote: 100, maxOpen: 3 }
    })
    const bots = settingsOnFile().bots
    expect(bots.find((bot) => bot.id === 'gpt')).toMatchObject({ aiModel: OPUS, aiModelHistory: [{ model: MINI, untilSec: NOW }], enabledAt: NOW - 30 * DAY })
    expect(bots.find((bot) => bot.id === 'trend')).toEqual(BOTS[1])
    // Nothing asks GPT-5 Mini now: it can be disabled, and the watch stays on.
    const disabled = await setAiConfig({ enabledModels: FOUND.enabledModels.filter((model) => model !== MINI) })
    expect(disabled.enabledModels).not.toContain(MINI)
    expect(disabled.watch.enabled).toBe(true)
    // A role's model is not dropped quietly.
    await expect(setAiConfig({ enabledModels: disabled.enabledModels.filter((model) => model !== LUNA) })).rejects.toThrow(/takes the watch's summaries/)
    // A preview of the same move now changes nothing more, and its token differs from the first.
    const again = await previewAiRoles(CHOICE)
    expect(again.plan.bots).toEqual([])
    expect(again.token).not.toBe(preview.token)
  })

  it('stands across a restart, and the additions then ask by role', async () => {
    const first = await services()
    await first.applyAiRoles({ choice: CHOICE, token: (await first.previewAiRoles(CHOICE)).token })
    vi.resetModules()
    const { getAiConfig, getAiAdditionsStatus } = await services()
    expect(await getAiConfig()).toMatchObject({ defaultModel: OPUS, roles: { gate: ARGON, summarize: LUNA }, watch: { enabled: true, models: [ARGON, OPUS] }, watchPaper: { enabled: true, model: OPUS } })
    const status = await getAiAdditionsStatus()
    expect(status.byRole).toBe(true)
    expect(status.models).toEqual({ news: LUNA, why: LUNA, exit: OPUS, review: OPUS, daily: LUNA })
  })
})

type Reply = { model?: string }

/** OpenRouter faked: every request's model recorded, every answer a hold, served under `served` (the model asked by default). */
function stubOpenRouter(served: (asked: string) => string | undefined = (asked) => asked): { asked: string[] } {
  const asked: string[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as { model: string }
    asked.push(body.model)
    const reply: Reply = { model: served(body.model) }
    const content = JSON.stringify({ recommendation: 'hold', confidence: 0.4, marketRegime: 'neutral', riskLevel: 'medium', horizonBars: 16, stopLoss: null, takeProfit: null, reasonCodes: ['range_bound'], rationale: 'nothing decisive' })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ provider: 'Test', ...(reply.model === undefined ? {} : { model: reply.model }), choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: 0.002 } })
    }
  })
  return { asked }
}

function candles(count: number, start: number): Candle[] {
  let price = 100
  return Array.from({ length: count }, (_, k) => {
    const open = price
    price = Math.max(1, price + Math.sin(k / 3) * 0.6)
    return { time: start + k * 900, open, high: Math.max(open, price) + 0.3, low: Math.min(open, price) - 0.3, close: price, volume: 100 }
  })
}

describe('what answers', () => {
  it('is held to what was asked: another provider refused and marked, a variant kept and marked', async () => {
    const { generateAiSignalTape, listAiCalls } = await services()
    stubOpenRouter((asked) => (asked === OPUS ? 'openai/gpt-6-luna' : 'google/gemini-4-flash'))
    const start = Math.floor((NOW - (GPT_LOOKBACK_BARS + 3) * 900) / 900) * 900
    const base = { exchange: 'binance' as const, symbol: 'BTCUSDT', interval: GPT_INTRADAY_INTERVAL, candles: candles(GPT_LOOKBACK_BARS + 2, start), startIndex: GPT_LOOKBACK_BARS, maxDecisions: 1, source: 'backtest' as const }
    const refused = await generateAiSignalTape({ ...base, requestId: 'other', model: OPUS })
    expect(refused.decisions[0].rejected).toMatch(/came from openai\/gpt-6-luna, not from anthropic\/claude-opus-5\.5/)
    expect(refused.rejectedCount).toBe(1)
    const rows = (await listAiCalls({ limit: 10 })).rows
    expect(rows.find((entry) => entry.model === OPUS)).toMatchObject({ status: 'rejected', servedModel: 'openai/gpt-6-luna', servedMismatch: 'other' })
    // The same provider under another name: shown, and the answer used.
    const variant = await generateAiSignalTape({ ...base, requestId: 'variant', model: 'google/gemini-4-argon', candles: candles(GPT_LOOKBACK_BARS + 2, start + 900) })
    expect(variant.decisions[0].rejected ?? null).toBeNull()
    expect((await listAiCalls({ model: 'google/gemini-4-argon', limit: 5 })).rows[0]).toMatchObject({ status: 'ok', servedMismatch: 'variant' })
  })

  it("marks the watch's calls with their role once roles are applied: the first look and the decider", async () => {
    const services1 = await services()
    await services1.applyAiRoles({ choice: CHOICE, token: (await services1.previewAiRoles(CHOICE)).token })
    stubOpenRouter()
    const { askAiOpportunity, listAiCalls } = services1
    const request = { exchange: 'binance' as const, symbol: 'SOLUSDT', candles15m: QUESTION.candles15m, candles1m: QUESTION.candles1m, source: 'watch' as const }
    await askAiOpportunity({ ...request, model: ARGON })
    await askAiOpportunity({ ...request, model: OPUS })
    const rows = (await listAiCalls({ source: 'watch', limit: 10 })).rows.filter((entry) => entry.at >= NOW - 60)
    expect(rows.map((entry) => [entry.model, entry.role]).sort()).toEqual(
      [
        [ARGON, 'gate'],
        [OPUS, 'decide']
      ].sort()
    )
  })
})
