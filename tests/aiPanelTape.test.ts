import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiAgentReports } from '../shared/aiPanel'
import type { AiRoute } from '../shared/aiRoute'
import { GPT_INTRADAY_INTERVAL, GPT_LOOKBACK_BARS, type AiSignalTapeRequest } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'

// A panel of agents, end to end, with the network faked and everything else real -- the harness
// aiSignalTape.test.ts uses, with a fake that answers by WHICH QUESTION it was asked, because a
// panel is four different questions to one model. What these pin is what a panel costs when it is
// wrong: a decision made without a report it was promised, a call paid for twice, a fifth call
// nobody mentioned, or a panel's name sent to the provider as though it were a model.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' })
}))

const BAR = 900
const START = 1_699_999_200
const COST = 0.002
const MODEL = 'openai/gpt-5-mini'
const OTHER = 'acme/frontier'
const PANEL = `panel:${MODEL}`

type Kind = 'signal' | 'trend' | 'momentum' | 'risk' | 'decision'

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

/** `decisions` candles to decide on after a full lookback; every candle after the first decision
 * sits at its close, so a position opened there is never stopped out. */
function request(decisions: number, over: Partial<AiSignalTapeRequest> = {}): AiSignalTapeRequest {
  const candles = series(GPT_LOOKBACK_BARS + decisions)
  const entry = candles[GPT_LOOKBACK_BARS].close
  for (let index = GPT_LOOKBACK_BARS + 1; index < candles.length; index++) {
    candles[index] = { ...candles[index], open: entry, high: entry + 0.1, low: entry - 0.1, close: entry }
  }
  return {
    requestId: 'run',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: GPT_INTRADAY_INTERVAL,
    candles,
    startIndex: GPT_LOOKBACK_BARS,
    maxDecisions: decisions,
    source: 'agent',
    ...over
  }
}

const REPORTS: AiAgentReports = {
  trend: { regime: 'bull', confidence: 0.7, reasonCodes: ['trend_up'], note: 'Higher highs on the 4h.' },
  momentum: { momentum: 'up', confidence: 0.6, reasonCodes: ['momentum_up'], note: 'RSI rising.' },
  risk: { riskLevel: 'medium', verdict: 'attractive', confidence: 0.65, reasonCodes: ['low_volatility'], note: 'ATR contained.' }
}

function signal(overrides: Record<string, unknown> = {}): string {
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

const BUY = signal({ recommendation: 'buy', confidence: 0.9 })

interface Reply {
  status?: number
  content?: string
  /** What the call is billed at; COST when the script does not say. */
  cost?: number
}

interface Sent {
  model: string
  kind: Kind
  /** The user message, exactly as sent. */
  user: string
  position: string
}

function kindOf(system: string): Kind {
  if (system.startsWith('You are the trend analyst')) return 'trend'
  if (system.startsWith('You are the momentum analyst')) return 'momentum'
  if (system.startsWith('You are the risk analyst')) return 'risk'
  if (system.startsWith('You make the decision for a panel')) return 'decision'
  if (system.startsWith('You are a conservative crypto signal classifier')) return 'signal'
  throw new Error(`a prompt this fake does not know: ${system.slice(0, 60)}`)
}

/** Fakes OpenRouter's completion endpoint. `script` may answer any kind of question; what it
 * leaves alone gets a usable default. `inAir` is the most requests that were ever open at once. */
function stubOpenRouter(script: (sent: Sent, nth: number) => Reply | Promise<Reply> | undefined = () => undefined): {
  sent: Sent[]
  kinds: () => Kind[]
  inAir: () => number
} {
  const sent: Sent[] = []
  let open = 0
  let most = 0
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as { model: string; messages: { content: string }[] }
    const entry: Sent = { model: body.model, kind: kindOf(body.messages[0].content), user: body.messages[1].content, position: JSON.parse(body.messages[1].content).position }
    sent.push(entry)
    open++
    most = Math.max(most, open)
    try {
      const scripted = await script(entry, sent.filter((other) => other.kind === entry.kind).length)
      const fallback = entry.kind === 'signal' || entry.kind === 'decision' ? signal() : JSON.stringify(REPORTS[entry.kind])
      const { status = 200, content = fallback, cost = COST } = scripted ?? {}
      const reply =
        status === 200
          ? { provider: 'Test', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost } }
          : { error: { code: status, message: 'no provider' } }
      return { ok: status === 200, status, text: async () => JSON.stringify(reply) }
    } finally {
      open--
    }
  })
  return { sent, kinds: () => sent.map((entry) => entry.kind), inAir: () => most }
}

async function services() {
  const tape = await import('../electron/services/aiSignalService')
  const config = await import('../electron/services/aiConfigService')
  const ledger = await import('../electron/services/aiLedgerService')
  tape.aiRetry.baseDelayMs = 0
  // A panel is four calls a decision, so a few decisions go past a minute's pace. Its waits are
  // counted on a clock of their own, which a wait moves on, rather than sat through.
  let virtual = Date.now()
  tape.aiPace.now = () => virtual
  tape.aiPace.sleep = async (ms) => {
    virtual += ms
  }
  return { ...tape, ...config, ...ledger }
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-panel-'))
})

afterEach(() => vi.unstubAllGlobals())

describe('one decision by a panel', () => {
  it('is four calls to its model: three analysts on the snapshot, then the decision on their reports', async () => {
    const { sent, kinds, inAir } = stubOpenRouter((entry) => (entry.kind === 'decision' ? { content: BUY } : undefined))
    const { generateAiSignalTape, listAiCalls, getAiConfig, getAiUsageSummary } = await services()

    const tape = await generateAiSignalTape(request(1, { model: PANEL }))
    expect(kinds()).toEqual(['trend', 'momentum', 'risk', 'decision'])
    // The panel's name never travels: every request names the model it runs on.
    expect(sent.every((entry) => entry.model === MODEL)).toBe(true)
    // One at a time, so a run can pass the budget by one call and no more.
    expect(inAir()).toBe(1)

    // Each analyst is sent the very bytes a standalone signal is...
    await generateAiSignalTape(request(1, { requestId: 'alone' }))
    const standalone = sent[4]
    expect(standalone.kind).toBe('signal')
    for (const analyst of sent.slice(0, 3)) expect(analyst.user).toBe(standalone.user)
    // ...and the decision is sent them again with the three reports on the end.
    const { agents, ...snapshot } = JSON.parse(sent[3].user)
    expect(JSON.stringify(snapshot)).toBe(standalone.user)
    expect(agents).toEqual(REPORTS)

    expect(tape).toMatchObject({ model: PANEL, callCount: 4, generatedCount: 1, cachedCount: 0, errorCount: 0, rejectedCount: 0 })
    expect(tape.costUsd).toBeCloseTo(4 * COST, 10)
    const decision = tape.decisions[0]
    expect(decision).toMatchObject({ model: PANEL, recommendation: 'buy', confidence: 0.9, cached: false, error: null })
    expect(decision.agents).toEqual(REPORTS)
    // What the decision cost is what all four calls cost.
    expect(decision.usage).toMatchObject({ promptTokens: 6000, completionTokens: 1600 })
    expect(decision.usage?.costUsd).toBeCloseTo(4 * COST, 10)

    const rows = (await listAiCalls({ source: 'agent', limit: 10 })).rows.filter((row) => row.agent !== undefined).reverse()
    expect(rows.map((row) => [row.agent, row.promptVersion, row.model, row.status])).toEqual([
      ['trend', 'panel-trend-v1', MODEL, 'ok'],
      ['momentum', 'panel-momentum-v1', MODEL, 'ok'],
      ['risk', 'panel-risk-v1', MODEL, 'ok'],
      ['decision', 'panel-v1', MODEL, 'ok']
    ])
    // An analyst made no call on the market: its row carries a report and nothing to score.
    expect(rows[0]).toMatchObject({ recommendation: null, detail: null, confidence: 0.7, report: REPORTS.trend, schemaVersion: 'agent-v1' })
    expect(rows[3]).toMatchObject({ recommendation: 'buy', confidence: 0.9, schemaVersion: 'signal-v2' })
    expect(rows[3].report).toBeUndefined()

    // What a panel spends is counted under the model it spent it on.
    expect((await getAiConfig()).spentTodayUsd).toBeCloseTo(5 * COST, 10)
    expect((await getAiUsageSummary()).today).toMatchObject([{ model: MODEL, calls: 5 }])
  })

  it('is served whole from the cache the second time, reports and price included', async () => {
    const { sent } = stubOpenRouter((entry) => (entry.kind === 'decision' ? { content: BUY } : undefined))
    const { generateAiSignalTape } = await services()
    await generateAiSignalTape(request(1, { model: PANEL }))

    const again = await generateAiSignalTape(request(1, { model: PANEL, requestId: 'again' }))
    expect(sent).toHaveLength(4)
    expect(again).toMatchObject({ callCount: 0, generatedCount: 0, cachedCount: 1, costUsd: 0 })
    expect(again.decisions[0]).toMatchObject({ model: PANEL, recommendation: 'buy', cached: true })
    expect(again.decisions[0].agents).toEqual(REPORTS)
    expect(again.decisions[0].usage?.costUsd).toBeCloseTo(4 * COST, 10)
  })

  it('is not the answer the model gives alone, and neither is served as the other', async () => {
    const { kinds } = stubOpenRouter((entry) => (entry.kind === 'decision' ? { content: BUY } : undefined))
    const { generateAiSignalTape } = await services()
    const panel = await generateAiSignalTape(request(1, { model: PANEL }))
    const alone = await generateAiSignalTape(request(1, { requestId: 'alone' }))
    // Same model, same candle, two questions: five calls, and two different answers kept apart.
    expect(kinds()).toEqual(['trend', 'momentum', 'risk', 'decision', 'signal'])
    expect(panel.decisions[0]).toMatchObject({ model: PANEL, recommendation: 'buy' })
    expect(alone.decisions[0]).toMatchObject({ model: MODEL, recommendation: 'hold' })
    expect(alone.decisions[0].agents).toBeUndefined()
  })

  it('pays once for each call when two callers reach the same decision together', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { sent } = stubOpenRouter(async () => {
      await held
      return undefined
    })
    const { generateAiSignalTape } = await services()

    const a = generateAiSignalTape(request(1, { model: PANEL, requestId: 'a' }))
    const b = generateAiSignalTape(request(1, { model: PANEL, requestId: 'b' }))
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    release()

    const tapes = await Promise.all([a, b])
    expect(sent.map((entry) => entry.kind)).toEqual(['trend', 'momentum', 'risk', 'decision'])
    expect(tapes.reduce((sum, tape) => sum + tape.callCount, 0)).toBe(4)
    expect(tapes.reduce((sum, tape) => sum + tape.costUsd, 0)).toBeCloseTo(4 * COST, 10)
    expect(tapes.every((tape) => tape.decisions[0].model === PANEL && tape.decisions[0].agents !== undefined)).toBe(true)
  })
})

describe('a panel that cannot hear from an analyst', () => {
  it('does not decide when a report is refused, and does not pay to be told so twice', async () => {
    const { kinds } = stubOpenRouter((entry) => (entry.kind === 'momentum' ? { content: JSON.stringify({ ...REPORTS.momentum, momentum: 'sideways' }) } : undefined))
    const { generateAiSignalTape, listAiCalls } = await services()

    const tape = await generateAiSignalTape(request(1, { model: PANEL }))
    // Nothing after the refused report is asked: the panel is one report short of being a panel.
    expect(kinds()).toEqual(['trend', 'momentum'])
    expect(tape).toMatchObject({ callCount: 2, rejectedCount: 1, errorCount: 0 })
    expect(tape.decisions[0]).toMatchObject({ model: PANEL, recommendation: 'hold', confidence: 0, error: null })
    expect(tape.decisions[0].rejected).toBe("The momentum analyst's answer was refused: momentum is not an allowed value")
    expect((await listAiCalls({ status: 'rejected' })).rows).toMatchObject([{ agent: 'momentum', model: MODEL }])

    const again = await generateAiSignalTape(request(1, { model: PANEL, requestId: 'again' }))
    expect(kinds()).toHaveLength(2)
    expect(again).toMatchObject({ callCount: 0, cachedCount: 1, rejectedCount: 1 })
    expect(again.decisions[0].rejected).toContain('momentum analyst')
  })

  it('fails when an analyst cannot be reached, keeps the reports it has, and asks only for the rest', async () => {
    let riskUp = false
    const { kinds } = stubOpenRouter((entry) => (entry.kind === 'risk' && !riskUp ? { status: 503 } : entry.kind === 'decision' ? { content: BUY } : undefined))
    const { generateAiSignalTape } = await services()

    const failed = await generateAiSignalTape(request(1, { model: PANEL }))
    expect(kinds()).toEqual(['trend', 'momentum', 'risk', 'risk', 'risk'])
    expect(failed).toMatchObject({ callCount: 3, errorCount: 1, rejectedCount: 0 })
    expect(failed.costUsd).toBeCloseTo(2 * COST, 10)
    expect(failed.decisions[0]).toMatchObject({ model: PANEL, recommendation: 'hold', confidence: 0, cached: false })
    expect(failed.decisions[0].error).toMatch(/^The risk analyst could not be reached: .*503/)

    riskUp = true
    const retried = await generateAiSignalTape(request(1, { model: PANEL, requestId: 'retried' }))
    expect(kinds().slice(5)).toEqual(['risk', 'decision'])
    expect(retried).toMatchObject({ callCount: 2, errorCount: 0 })
    expect(retried.decisions[0]).toMatchObject({ recommendation: 'buy', error: null })
    // What it cost in all, whichever run paid for which call.
    expect(retried.decisions[0].usage?.costUsd).toBeCloseTo(4 * COST, 10)
  })

  it('fails the same way when the decision itself cannot be reached, with every report kept', async () => {
    let decisionUp = false
    const { kinds } = stubOpenRouter((entry) => (entry.kind === 'decision' && !decisionUp ? { status: 503 } : undefined))
    const { generateAiSignalTape, estimateAiSignalTape } = await services()

    const failed = await generateAiSignalTape(request(1, { model: PANEL }))
    expect(failed).toMatchObject({ callCount: 4, errorCount: 1 })
    expect(failed.decisions[0]).toMatchObject({ model: PANEL, cached: false })
    expect(failed.decisions[0].error).toContain('503')
    expect(failed.decisions[0].agents).toEqual(REPORTS)
    // Three of its four answers are held, so one call is what is left to make.
    expect(await estimateAiSignalTape(request(1, { model: PANEL }))).toMatchObject({ cached: 0, maximumApiCalls: 1 })

    decisionUp = true
    const retried = await generateAiSignalTape(request(1, { model: PANEL, requestId: 'retried' }))
    expect(kinds().slice(-1)).toEqual(['decision'])
    expect(kinds().filter((kind) => kind !== 'decision')).toHaveLength(3)
    expect(retried).toMatchObject({ callCount: 1, errorCount: 0 })
  })

  it('stops between two of its calls when the budget runs out, and resumes with the ones not made', async () => {
    const { kinds } = stubOpenRouter()
    const { generateAiSignalTape, estimateAiSignalTape, setAiConfig } = await services()
    // Room for two calls: the budget is checked before each of the four.
    await setAiConfig({ dailyCapUsd: COST * 2 })
    await expect(generateAiSignalTape(request(1, { model: PANEL }))).rejects.toThrow(/budget is used up/)
    expect(kinds()).toEqual(['trend', 'momentum'])

    await setAiConfig({ dailyCapUsd: 1 })
    // Two of the four are held, so two are left to make.
    expect(await estimateAiSignalTape(request(1, { model: PANEL }))).toMatchObject({ total: 1, cached: 0, maximumApiCalls: 2, callsPerDecision: 4 })
    const resumed = await generateAiSignalTape(request(1, { model: PANEL, requestId: 'resumed' }))
    expect(kinds()).toEqual(['trend', 'momentum', 'risk', 'decision'])
    expect(resumed).toMatchObject({ callCount: 2, generatedCount: 1 })
  })
})

describe('a panel as the second step of a route', () => {
  const ROUTE: AiRoute = { model: PANEL, when: 'acting' }

  it('is asked only about the decisions the first model passes on, four calls each', async () => {
    const { sent, kinds } = stubOpenRouter((entry, nth) => (entry.kind === 'signal' && nth === 1 ? { content: BUY } : undefined))
    const { generateAiSignalTape, listAiCalls } = await services()

    const tape = await generateAiSignalTape(request(3, { route: ROUTE, source: 'backtest' }))
    // One call a candle, and four more on the one the model wanted to trade.
    expect(kinds()).toEqual(['signal', 'trend', 'momentum', 'risk', 'decision', 'signal', 'signal'])
    expect(sent.every((entry) => entry.model === MODEL)).toBe(true)
    expect(tape).toMatchObject({ model: MODEL, route: { model: PANEL, when: 'acting', escalated: 1 }, callCount: 7, generatedCount: 3 })
    expect(tape.costUsd).toBeCloseTo(7 * COST, 10)
    // The decision is the panel's, and says what the model alone had wanted.
    expect(tape.decisions[0]).toMatchObject({ model: PANEL, recommendation: 'hold' })
    expect(tape.decisions[0].first).toMatchObject({ model: MODEL, recommendation: 'buy', confidence: 0.9 })
    expect(tape.decisions[0].agents).toEqual(REPORTS)
    // The panel held, so the account stayed flat and the next candle was asked flat.
    expect(sent.map((entry) => entry.position)).toEqual(new Array(7).fill('flat'))
    // All four of its calls were made because of what the first model said.
    const panelRows = (await listAiCalls({ limit: 20 })).rows.filter((row) => row.agent !== undefined)
    expect(panelRows).toHaveLength(4)
    expect(panelRows.every((row) => row.escalatedFrom === MODEL && row.source === 'backtest')).toBe(true)
  })

  it('opens the position when the panel agrees', async () => {
    const { sent } = stubOpenRouter((entry, nth) => (entry.kind === 'decision' || (entry.kind === 'signal' && nth === 1) ? { content: BUY } : undefined))
    const { generateAiSignalTape } = await services()
    await generateAiSignalTape(request(2, { route: ROUTE }))
    expect(sent.map((entry) => `${entry.kind} ${entry.position}`)).toEqual(['signal flat', 'trend flat', 'momentum flat', 'risk flat', 'decision flat', 'signal long'])
  })

  it('is priced at four calls for every decision that could be passed on', async () => {
    stubOpenRouter((entry, nth) => (entry.kind === 'signal' && nth === 1 ? { content: BUY } : undefined))
    const { generateAiSignalTape, estimateAiSignalTape, setAiConfig } = await services()

    const before = await estimateAiSignalTape(request(3, { route: ROUTE }))
    expect(before).toMatchObject({ total: 3, cached: 0, maximumApiCalls: 15, model: MODEL })
    expect(before).not.toHaveProperty('callsPerDecision')
    expect(before.route).toMatchObject({ model: PANEL, maximumApiCalls: 12, callsPerDecision: 4 })

    // The first model has answered the first candle and the panel has two of its four calls in.
    await setAiConfig({ dailyCapUsd: COST * 3 })
    await expect(generateAiSignalTape(request(3, { route: ROUTE }))).rejects.toThrow(/budget is used up/)
    await setAiConfig({ dailyCapUsd: 1 })
    const partway = await estimateAiSignalTape(request(3, { route: ROUTE }))
    // Nothing more from the first model for that candle, two more from the panel; then two candles
    // at one call and at most four.
    expect(partway).toMatchObject({ cached: 0, maximumApiCalls: 2 + (2 + 2 * 4) })
    expect(partway.route?.maximumApiCalls).toBe(2 + 2 * 4)

    await generateAiSignalTape(request(3, { route: ROUTE, requestId: 'finished' }))
    const after = await estimateAiSignalTape(request(3, { route: ROUTE }))
    expect(after).toMatchObject({ cached: 3, maximumApiCalls: 0 })
    // Priced from what each of its four prompts has actually cost: a call at a time.
    expect(after.route?.perCallCostUsd).toBeCloseTo(COST, 10)
    expect(after.route?.costBasis).toBe('history')
  })
})

describe('what a panel is expected to cost', () => {
  it('is unknown until something is known about its model, and four calls either way', async () => {
    stubOpenRouter()
    const { estimateAiSignalTape } = await services()
    const estimate = await estimateAiSignalTape(request(1, { model: PANEL }))
    expect(estimate).toMatchObject({ total: 1, cached: 0, maximumApiCalls: 4, callsPerDecision: 4, model: PANEL, perCallCostUsd: null, costBasis: 'unknown' })
    expect(estimate.estimatedCostUsd).toBeNull()
    // Every decision after the first is four more: the ceiling is in calls, not in decisions.
    expect(await estimateAiSignalTape(request(3, { model: PANEL }))).toMatchObject({ total: 3, cached: 0, maximumApiCalls: 12 })
  })

  it('is priced from the model\'s price list before it has been asked, one prompt at a time', async () => {
    writeFileSync(
      join(process.env.AI_TEST_USER_DATA as string, 'aiModels.json'),
      JSON.stringify({
        fetchedAt: Math.floor(Date.now() / 1000),
        models: [{ id: MODEL, name: 'GPT-5 Mini', contextLength: 400000, promptPricePerToken: 0.00000025, completionPricePerToken: 0.000002, structuredOutputs: true }]
      })
    )
    stubOpenRouter()
    const { estimateAiSignalTape } = await services()
    const panel = await estimateAiSignalTape(request(1, { model: PANEL }))
    const alone = await estimateAiSignalTape(request(1))
    expect(panel.costBasis).toBe('pricing')
    expect(alone.costBasis).toBe('pricing')
    // Four questions of about the size of the one, so about four times the price.
    const ratio = (panel.estimatedCostUsd as number) / (alone.estimatedCostUsd as number)
    expect(ratio).toBeGreaterThan(3.9)
    expect(ratio).toBeLessThan(4.6)
  })

  it("prices each of its four prompts from that prompt's own calls", async () => {
    // A decision is a longer answer than a report and costs more. Taken from the decision's
    // history alone, a panel would be priced at twice what its four calls come to.
    const billed = { trend: 0.001, momentum: 0.002, risk: 0.003, decision: 0.006, signal: 0.004 }
    stubOpenRouter((entry) => ({ cost: billed[entry.kind] }))
    const { generateAiSignalTape, estimateAiSignalTape } = await services()
    await generateAiSignalTape(request(1, { model: PANEL }))
    const estimate = await estimateAiSignalTape(request(2, { model: PANEL }))
    expect(estimate).toMatchObject({ cached: 1, maximumApiCalls: 4, costBasis: 'history' })
    expect(estimate.perCallCostUsd).toBeCloseTo(0.012 / 4, 10)
    expect(estimate.estimatedCostUsd).toBeCloseTo(0.012, 10)
  })

  it('does not hide what the model costs alone behind its own reports', async () => {
    // One call of the model alone, then thirteen panel decisions on it: fifty-two rows, every one
    // newer than that first call. The price of the model alone is still what that call cost.
    stubOpenRouter()
    const { generateAiSignalTape, estimateAiSignalTape, listAiCalls } = await services()
    await generateAiSignalTape(request(1))
    await generateAiSignalTape(request(13, { model: PANEL, requestId: 'panel' }))
    expect((await listAiCalls({ model: MODEL, limit: 50 })).rows.every((row) => row.agent !== undefined)).toBe(true)
    expect((await listAiCalls({ model: MODEL, promptVersion: 'intraday-v2', limit: 50 })).rows).toHaveLength(1)

    const alone = await estimateAiSignalTape(request(2))
    expect(alone).toMatchObject({ cached: 1, maximumApiCalls: 1, costBasis: 'history' })
    expect(alone.perCallCostUsd).toBeCloseTo(COST, 10)
  })

  it('is priced from what its own four prompts have cost once they have been asked', async () => {
    stubOpenRouter()
    const { generateAiSignalTape, estimateAiSignalTape } = await services()
    await generateAiSignalTape(request(1, { model: PANEL }))
    const estimate = await estimateAiSignalTape(request(2, { model: PANEL }))
    expect(estimate).toMatchObject({ total: 2, cached: 1, maximumApiCalls: 4, costBasis: 'history' })
    expect(estimate.perCallCostUsd).toBeCloseTo(COST, 10)
    expect(estimate.estimatedCostUsd).toBeCloseTo(4 * COST, 10)
  })
})

describe('a panel set beside models in a benchmark', () => {
  it('is looked up for free like a model, and says it takes four calls an answer', async () => {
    const { sent } = stubOpenRouter((entry) => (entry.kind === 'decision' ? { content: BUY } : undefined))
    const { generateAiSignalTape, peekAiBenchmark } = await services()
    const candles = request(1).candles
    const peek = { exchange: 'binance' as const, symbol: 'BTCUSDT', interval: GPT_INTRADAY_INTERVAL, candles, times: [candles[GPT_LOOKBACK_BARS].time], models: [MODEL, PANEL] }

    const before = await peekAiBenchmark(peek)
    expect(sent).toHaveLength(0)
    expect(before.models).toMatchObject([
      { model: MODEL, decisions: [null], callsPerAnswer: 1 },
      { model: PANEL, decisions: [null], callsPerAnswer: 4 }
    ])

    // The one-decision tape a benchmark asks with.
    await generateAiSignalTape(request(1, { model: PANEL, source: 'benchmark' }))
    const after = await peekAiBenchmark(peek)
    expect(sent).toHaveLength(4)
    expect(after.models[0].decisions).toEqual([null])
    expect(after.models[1].decisions[0]).toMatchObject({ model: PANEL, recommendation: 'buy', cached: true, candleTime: peek.times[0] })
    expect(after.models[1].decisions[0]?.agents).toEqual(REPORTS)
    expect(after.models[1].perCallCostUsd).toBeCloseTo(COST, 10)
  })
})

describe('where a panel may and may not be named', () => {
  it('runs only on a model that is enabled, and only when it names one', async () => {
    const { sent } = stubOpenRouter()
    const { generateAiSignalTape, estimateAiSignalTape, peekAiBenchmark } = await services()
    const candles = request(1).candles
    const refused: [string, RegExp][] = [
      [`panel:${OTHER}`, /acme\/frontier is not enabled, so a panel cannot be run on it/],
      ['panel:', /does not name a panel of agents on a model/],
      [`panel:${PANEL}`, /does not name a panel of agents on a model/]
    ]
    for (const [model, message] of refused) {
      await expect(generateAiSignalTape(request(1, { model }))).rejects.toThrow(message)
      await expect(estimateAiSignalTape(request(1, { model }))).rejects.toThrow(message)
      await expect(generateAiSignalTape(request(1, { route: { model, when: 'acting' } }))).rejects.toThrow(message)
      await expect(
        peekAiBenchmark({ exchange: 'binance', symbol: 'BTCUSDT', interval: GPT_INTRADAY_INTERVAL, candles, times: [candles[GPT_LOOKBACK_BARS].time], models: [model] })
      ).rejects.toThrow(message)
    }
    // A panel passing a decision on to itself is not a route.
    await expect(generateAiSignalTape(request(1, { model: PANEL, route: { model: PANEL, when: 'acting' } }))).rejects.toThrow(/two different models/)
    expect(sent).toHaveLength(0)
  })

  it('is not a model an entry review can be put to', async () => {
    // A review is one question to one model. It resolves the old way, where a panel is not one.
    const { sent } = stubOpenRouter()
    const { confirmAiEntry, peekAiEntryConfirmation } = await services()
    const review = {
      exchange: 'binance' as const,
      symbol: 'BTCUSDT',
      interval: '4h' as const,
      window: series(GPT_LOOKBACK_BARS),
      strategy: { id: 'trend-regime-ensemble', name: 'Trend Regime', rule: 'Long while the close is above its averages.', stopDistancePct: 10, readings: [] },
      model: PANEL
    }
    await expect(confirmAiEntry(review)).rejects.toThrow(/is not enabled/)
    await expect(peekAiEntryConfirmation(review)).rejects.toThrow(/is not enabled/)
    expect(sent).toHaveLength(0)
  })

  it('can never be the default or sit in the list of enabled models', async () => {
    const { setAiConfig, getAiConfig } = await services()
    await expect(setAiConfig({ defaultModel: PANEL })).rejects.toThrow(/cannot be enabled or made the default/)
    await expect(setAiConfig({ enabledModels: [MODEL, PANEL] })).rejects.toThrow(/cannot be enabled or made the default/)
    expect(await getAiConfig()).toMatchObject({ defaultModel: MODEL, enabledModels: [MODEL] })
  })

  it('is dropped from a settings file that names one as a model', async () => {
    writeFileSync(
      join(process.env.AI_TEST_USER_DATA as string, 'aiConfig.json'),
      JSON.stringify({ defaultModel: PANEL, enabledModels: [OTHER, PANEL, `panel:${OTHER}`], route: { model: 'panel:', when: 'acting' } })
    )
    const { getAiConfig } = await services()
    // The default falls back to the built-in one, and nothing written as a panel stays enabled.
    expect(await getAiConfig()).toMatchObject({ defaultModel: MODEL, enabledModels: [MODEL, OTHER], route: null })
  })

  it('can be the second step of the route that is set, on any enabled model, the default included', async () => {
    const { setAiConfig } = await services()
    await setAiConfig({ enabledModels: [MODEL, OTHER] })
    // The default model screens and its own panel decides.
    expect((await setAiConfig({ route: { model: PANEL, when: 'acting' } })).route).toEqual({ model: PANEL, when: 'acting' })
    expect((await setAiConfig({ route: { model: `panel:${OTHER}`, when: 'unsure' } })).route).toEqual({ model: `panel:${OTHER}`, when: 'unsure' })
    await expect(setAiConfig({ route: { model: 'panel:acme/unlisted', when: 'acting' } })).rejects.toThrow(/acme\/unlisted is not enabled/)
    await expect(setAiConfig({ route: { model: 'panel:', when: 'acting' } })).rejects.toThrow(/does not name a panel/)

    // The model the route's panel runs on cannot be switched off from under it...
    await expect(setAiConfig({ enabledModels: [MODEL] })).rejects.toThrow(/acme\/frontier is the model the current route's panel runs on/)
    // ...but it can become the default: the route is then that model, and its panel when it matters.
    expect(await setAiConfig({ defaultModel: OTHER })).toMatchObject({ defaultModel: OTHER, route: { model: `panel:${OTHER}` } })
  })
})
