import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiRoute } from '../shared/aiRoute'
import { GPT_INTRADAY_INTERVAL, GPT_LOOKBACK_BARS, type AiSignalTapeRequest } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'

// A routed tape, end to end, with the network faked and everything else real -- the same harness
// as aiSignalTape.test.ts, with one difference: the fake answers per model, because under a route
// WHO was asked is the thing being tested. What these pin is what a route costs when it is wrong:
// a second model asked about every candle, a decision acted on without the second opinion that
// was promised, an answer paid for twice, or a run that names no route and gets one anyway.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' })
}))

const BAR = 900
const START = 1_699_999_200
const FIRST = 'openai/gpt-5-mini'
const SECOND = 'acme/frontier'
const COSTS: Record<string, number> = { [FIRST]: 0.002, [SECOND]: 0.013 }
const ACTING: AiRoute = { model: SECOND, when: 'acting' }
const UNSURE: AiRoute = { model: SECOND, when: 'unsure' }

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

/** `decisions` candles to decide on, after a full lookback. Every candle after the first decision
 * sits at that candle's close, so a position opened there is never stopped out: what the next
 * question says about the position then depends on the models' answers and on nothing else. */
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
    source: 'backtest',
    ...over
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

const BUY = answer({ recommendation: 'buy', confidence: 0.9 })
const SURE_HOLD = answer({ confidence: 0.9 })

interface Reply {
  status?: number
  content?: string
}

interface Sent {
  model: string
  messages: { role: string; content: string }[]
  /** The position the question was asked with. */
  position: string
}

/** Fakes OpenRouter's completion endpoint, one script per model. A script is told how many times
 * its model has been asked, this request included. A model with no script must not be asked. */
function stubModels(scripts: Record<string, (call: number) => Reply | Promise<Reply>>): { sent: Sent[]; to: (model: string) => Sent[] } {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as { model: string; messages: Sent['messages'] }
    sent.push({ model: body.model, messages: body.messages, position: JSON.parse(body.messages[1].content).position })
    const script = scripts[body.model]
    if (!script) throw new Error(`${body.model} was asked and has no script`)
    const { status = 200, content = answer() } = await script(sent.filter((entry) => entry.model === body.model).length)
    const reply =
      status === 200
        ? { provider: 'Test', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: COSTS[body.model] } }
        : { error: { code: status, message: 'no provider' } }
    return { ok: status === 200, status, text: async () => JSON.stringify(reply) }
  })
  return { sent, to: (model) => sent.filter((entry) => entry.model === model) }
}

/** Fresh module state for every test, with both models enabled. */
async function services() {
  const tape = await import('../electron/services/aiSignalService')
  const config = await import('../electron/services/aiConfigService')
  const ledger = await import('../electron/services/aiLedgerService')
  tape.aiRetry.baseDelayMs = 0
  await config.setAiConfig({ enabledModels: [FIRST, SECOND] })
  return { ...tape, ...config, ...ledger }
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-route-'))
})

afterEach(() => vi.unstubAllGlobals())

describe('a route that passes on the decisions that would trade', () => {
  it('asks the second model only about those, and asks it the same question', async () => {
    const { sent, to } = stubModels({
      [FIRST]: (call) => ({ content: call === 1 ? BUY : answer() }),
      [SECOND]: () => ({ content: SURE_HOLD })
    })
    const { generateAiSignalTape, listAiCalls, getAiConfig } = await services()

    const tape = await generateAiSignalTape(request(3, { route: ACTING }))
    // Three candles, one of them worth a second answer: four calls, not six.
    expect(sent.map((entry) => entry.model)).toEqual([FIRST, SECOND, FIRST, FIRST])
    // Byte for byte the question the first model was put, so its answer is filed where any other
    // call to that model about that candle looks -- and it is not told what the first one said.
    expect(to(SECOND)[0].messages).toEqual(to(FIRST)[0].messages)

    expect(tape).toMatchObject({
      model: FIRST,
      route: { model: SECOND, when: 'acting', escalated: 1 },
      callCount: 4,
      generatedCount: 3,
      cachedCount: 0,
      errorCount: 0,
      rejectedCount: 0
    })
    expect(tape.costUsd).toBeCloseTo(3 * COSTS[FIRST] + COSTS[SECOND], 10)
    expect((await getAiConfig()).spentTodayUsd).toBeCloseTo(3 * COSTS[FIRST] + COSTS[SECOND], 10)

    // The decision is the second model's, and says what the first had wanted.
    expect(tape.decisions[0]).toMatchObject({ recommendation: 'hold', confidence: 0.9, model: SECOND, cached: false, error: null })
    expect(tape.decisions[0].first).toEqual({ model: FIRST, recommendation: 'buy', confidence: 0.9, rejected: null })
    expect(tape.decisions[1]).toMatchObject({ model: FIRST, recommendation: 'hold' })
    expect(tape.decisions[1].first).toBeUndefined()

    const { rows } = await listAiCalls({})
    expect(rows).toHaveLength(4)
    const second = rows.filter((row) => row.model === SECOND)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ escalatedFrom: FIRST, source: 'backtest', status: 'ok', recommendation: 'hold' })
    expect(rows.filter((row) => row.model === FIRST).every((row) => row.escalatedFrom === undefined)).toBe(true)
  })

  it('does not open the position the first model wanted when the second says no', async () => {
    const { sent } = stubModels({
      [FIRST]: (call) => ({ content: call === 1 ? BUY : answer() }),
      [SECOND]: () => ({ content: SURE_HOLD })
    })
    const { generateAiSignalTape } = await services()
    await generateAiSignalTape(request(2, { route: ACTING }))
    // Had the first model's buy been acted on, the second candle would have been asked "long".
    expect(sent.map((entry) => `${entry.model} ${entry.position}`)).toEqual([`${FIRST} flat`, `${SECOND} flat`, `${FIRST} flat`])
  })

  it('opens it when the second agrees', async () => {
    const { sent } = stubModels({
      [FIRST]: (call) => ({ content: call === 1 ? BUY : answer() }),
      [SECOND]: () => ({ content: answer({ recommendation: 'buy', confidence: 0.7 }) })
    })
    const { generateAiSignalTape } = await services()
    await generateAiSignalTape(request(2, { route: ACTING }))
    expect(sent.map((entry) => `${entry.model} ${entry.position}`)).toEqual([`${FIRST} flat`, `${SECOND} flat`, `${FIRST} long`])
  })

  it('passes an exit on too, and keeps the position when the second model would hold it', async () => {
    const { sent } = stubModels({
      [FIRST]: (call) => ({ content: call === 1 ? BUY : call === 2 ? answer({ recommendation: 'sell', confidence: 0.8 }) : answer() }),
      [SECOND]: (call) => ({ content: call === 1 ? answer({ recommendation: 'buy', confidence: 0.7 }) : SURE_HOLD })
    })
    const { generateAiSignalTape } = await services()
    const tape = await generateAiSignalTape(request(3, { route: ACTING }))
    expect(sent.map((entry) => `${entry.model} ${entry.position}`)).toEqual([
      `${FIRST} flat`,
      `${SECOND} flat`,
      `${FIRST} long`,
      `${SECOND} long`,
      // Still long: the sell was the first model's, and the second did not agree.
      `${FIRST} long`
    ])
    expect(tape.decisions[1]).toMatchObject({ recommendation: 'hold', model: SECOND })
    expect(tape.decisions[1].first).toMatchObject({ recommendation: 'sell', confidence: 0.8 })
    expect(tape.route?.escalated).toBe(2)
  })

  it('keeps a hesitant buy, a hold and a sell with nothing to sell to the first model alone', async () => {
    const { to } = stubModels({
      [FIRST]: (call) => ({
        content: call === 1 ? answer({ recommendation: 'buy', confidence: 0.5 }) : call === 2 ? SURE_HOLD : answer({ recommendation: 'sell', confidence: 0.9 })
      })
    })
    const { generateAiSignalTape } = await services()
    const tape = await generateAiSignalTape(request(3, { route: ACTING }))
    expect(to(SECOND)).toHaveLength(0)
    expect(tape).toMatchObject({ callCount: 3, route: { escalated: 0 } })
    expect(tape.decisions.every((decision) => decision.first === undefined && decision.model === FIRST)).toBe(true)
  })
})

describe('a route that passes on what the first model is unsure of', () => {
  it('hands the unsure decision to the second model and lets the confident ones stand', async () => {
    const { sent, to } = stubModels({
      [FIRST]: (call) => ({
        // Unsure, then two answers it is sure of: a hold, and the sell that closes the position.
        content: call === 1 ? answer() : call === 2 ? SURE_HOLD : call === 3 ? answer({ recommendation: 'sell', confidence: 0.7 }) : SURE_HOLD
      }),
      [SECOND]: () => ({ content: BUY })
    })
    const { generateAiSignalTape } = await services()
    const tape = await generateAiSignalTape(request(4, { route: UNSURE }))
    expect(sent.map((entry) => `${entry.model} ${entry.position}`)).toEqual([
      `${FIRST} flat`,
      `${SECOND} flat`,
      // The second model's buy opened the position...
      `${FIRST} long`,
      `${FIRST} long`,
      // ...and the first model's confident sell closed it, with no second opinion asked for.
      `${FIRST} flat`
    ])
    expect(to(SECOND)).toHaveLength(1)
    expect(tape.decisions[0]).toMatchObject({ recommendation: 'buy', model: SECOND })
    expect(tape.decisions[0].first).toMatchObject({ recommendation: 'hold', confidence: 0.4 })
    expect(tape.decisions[2]).toMatchObject({ recommendation: 'sell', model: FIRST })
    expect(tape.decisions[2].first).toBeUndefined()
    expect(tape.route).toEqual({ model: SECOND, when: 'unsure', escalated: 1 })
  })

  it('acts on a confident entry without asking the second model at all', async () => {
    const { sent, to } = stubModels({ [FIRST]: (call) => ({ content: call === 1 ? BUY : SURE_HOLD }) })
    const { generateAiSignalTape } = await services()
    await generateAiSignalTape(request(2, { route: UNSURE }))
    expect(to(SECOND)).toHaveLength(0)
    expect(sent.map((entry) => entry.position)).toEqual(['flat', 'long'])
  })
})

describe('an answer the first model could not give', () => {
  const REFUSED = answer({ recommendation: 'buy', confidence: 0.95, marketRegime: 'sideways' })

  it('is passed on when it was refused and the route passes on the unsure, and not when it passes on trades', async () => {
    const { to } = stubModels({ [FIRST]: () => ({ content: REFUSED }), [SECOND]: () => ({ content: SURE_HOLD }) })
    const { generateAiSignalTape } = await services()

    const unsure = await generateAiSignalTape(request(1, { route: UNSURE }))
    expect(to(SECOND)).toHaveLength(1)
    // The decision is the second model's usable answer, so nothing on the tape was refused.
    expect(unsure.rejectedCount).toBe(0)
    expect(unsure.decisions[0]).toMatchObject({ model: SECOND, recommendation: 'hold', confidence: 0.9 })
    expect(unsure.decisions[0].first?.rejected).toContain('marketRegime')

    // The refused answer is cached. Under the other rule it is not a trade, so it stays a hold.
    const acting = await generateAiSignalTape(request(1, { route: ACTING, requestId: 'acting' }))
    expect(to(SECOND)).toHaveLength(1)
    expect(acting).toMatchObject({ rejectedCount: 1, callCount: 0, route: { escalated: 0 } })
  })

  it('is never passed on when the first model was not reached', async () => {
    const { to } = stubModels({ [FIRST]: () => ({ status: 503 }), [SECOND]: () => ({ content: BUY }) })
    const { generateAiSignalTape } = await services()
    for (const route of [UNSURE, ACTING]) {
      const tape = await generateAiSignalTape(request(1, { route, requestId: route.when }))
      expect(tape.errorCount).toBe(1)
      expect(tape.decisions[0].error).toContain('503')
      expect(tape.decisions[0].first).toBeUndefined()
      expect(tape.route?.escalated).toBe(0)
    }
    // Asked again each time -- three attempts a run -- and never handed to the second model.
    expect(to(FIRST)).toHaveLength(6)
    expect(to(SECOND)).toHaveLength(0)
  })
})

describe('what a routed decision costs', () => {
  it('is not acted on when the second model cannot be reached, and only the second is asked again', async () => {
    let secondUp = false
    const { to } = stubModels({
      [FIRST]: () => ({ content: BUY }),
      [SECOND]: () => (secondUp ? { content: SURE_HOLD } : { status: 503 })
    })
    const { generateAiSignalTape, listAiCalls } = await services()

    const failed = await generateAiSignalTape(request(1, { route: ACTING }))
    expect(failed.errorCount).toBe(1)
    expect(failed.decisions[0]).toMatchObject({ model: SECOND, recommendation: 'hold', confidence: 0 })
    expect(failed.decisions[0].error).toContain('503')
    expect(failed.decisions[0].first).toMatchObject({ recommendation: 'buy' })
    // Both models were tried; only the one that answered was paid.
    expect(failed.callCount).toBe(2)
    expect(failed.costUsd).toBeCloseTo(COSTS[FIRST], 10)
    expect(to(SECOND)).toHaveLength(3)

    secondUp = true
    const retried = await generateAiSignalTape(request(1, { route: ACTING, requestId: 'retried' }))
    // The first model's answer was kept, so it is not paid for twice.
    expect(to(FIRST)).toHaveLength(1)
    expect(to(SECOND)).toHaveLength(4)
    expect(retried).toMatchObject({ callCount: 1, generatedCount: 1, cachedCount: 0, errorCount: 0 })
    expect(retried.costUsd).toBeCloseTo(COSTS[SECOND], 10)
    expect((await listAiCalls({ model: SECOND })).rows.map((row) => row.status)).toEqual(['ok', 'failed'])
  })

  it('stops a run whose second model stays down, and says which model it was', async () => {
    // The first model wants in on every candle and the second is never reached, so the account
    // stays flat and every decision fails the same way. Five of those and the run stops: the first
    // model answered each time, so this is not "five calls failed in a row", and the model named
    // is the one that is down.
    const { to } = stubModels({ [FIRST]: () => ({ content: BUY }), [SECOND]: () => ({ status: 503 }) })
    const { generateAiSignalTape } = await services()
    await expect(generateAiSignalTape(request(20, { route: ACTING }))).rejects.toThrow(
      new RegExp(`Stopped after 5 decisions in a row could not be answered\\..*Last error \\(${SECOND}\\): .*503`)
    )
    expect(to(FIRST)).toHaveLength(5)
    expect(to(SECOND)).toHaveLength(15)
    // The first model's five answers were paid for and are kept.
    const resumed = await generateAiSignalTape(request(1, { route: null, requestId: 'first-alone' }))
    expect(resumed).toMatchObject({ callCount: 0, cachedCount: 1 })
  })

  it('reuses an answer the second model gave elsewhere, and a rerun costs nothing', async () => {
    const { sent } = stubModels({ [FIRST]: () => ({ content: BUY }), [SECOND]: () => ({ content: SURE_HOLD }) })
    const { generateAiSignalTape, listAiCalls } = await services()

    // The second model asked on its own -- as a benchmark, the Analyze tab or a backtest would.
    await generateAiSignalTape(request(1, { model: SECOND, requestId: 'alone' }))
    expect(sent.map((entry) => entry.model)).toEqual([SECOND])

    const routed = await generateAiSignalTape(request(1, { route: ACTING, requestId: 'routed' }))
    // Only the first model is asked: the second's answer to this question is already held.
    expect(sent.map((entry) => entry.model)).toEqual([SECOND, FIRST])
    expect(routed).toMatchObject({ callCount: 1, generatedCount: 1, cachedCount: 0, route: { escalated: 1 } })
    expect(routed.costUsd).toBeCloseTo(COSTS[FIRST], 10)
    expect(routed.decisions[0]).toMatchObject({ model: SECOND, cached: false })
    // One decision is one row: the answer bought alone is not recorded again as a second opinion.
    expect((await listAiCalls({ model: SECOND })).rows).toHaveLength(1)
    expect((await listAiCalls({ model: SECOND })).rows[0].escalatedFrom).toBeUndefined()

    const rerun = await generateAiSignalTape(request(1, { route: ACTING, requestId: 'rerun' }))
    expect(sent).toHaveLength(2)
    expect(rerun).toMatchObject({ callCount: 0, generatedCount: 0, cachedCount: 1, costUsd: 0, route: { escalated: 1 } })
    expect(rerun.decisions[0]).toMatchObject({ model: SECOND, cached: true })
    expect(rerun.decisions[0].first).toMatchObject({ model: FIRST, recommendation: 'buy' })

    // And what the route bought is there for a run that asks the first model alone.
    const alone = await generateAiSignalTape(request(1, { requestId: 'first-alone' }))
    expect(sent).toHaveLength(2)
    expect(alone).toMatchObject({ callCount: 0, cachedCount: 1 })
    expect(alone).not.toHaveProperty('route')
  })

  it('stops between the two calls when the budget runs out, and resumes with the second alone', async () => {
    const { sent } = stubModels({ [FIRST]: () => ({ content: BUY }), [SECOND]: () => ({ content: SURE_HOLD }) })
    const { generateAiSignalTape, estimateAiSignalTape, setAiConfig } = await services()
    // Room for the first call and no more: the budget is checked before EACH call, the second
    // opinion included.
    await setAiConfig({ dailyCapUsd: COSTS[FIRST] })
    await expect(generateAiSignalTape(request(3, { route: ACTING }))).rejects.toThrow(/budget is used up/)
    expect(sent.map((entry) => entry.model)).toEqual([FIRST])

    await setAiConfig({ dailyCapUsd: 1 })
    // The first decision has its first answer and not its second: one call short of settled, so
    // five calls at most for three decisions rather than six.
    expect(await estimateAiSignalTape(request(3, { route: ACTING }))).toMatchObject({
      total: 3,
      cached: 0,
      maximumApiCalls: 5,
      route: { model: SECOND, when: 'acting', maximumApiCalls: 3 }
    })
    const resumed = await generateAiSignalTape(request(1, { route: ACTING, requestId: 'resumed' }))
    expect(sent.map((entry) => entry.model)).toEqual([FIRST, SECOND])
    expect(resumed).toMatchObject({ callCount: 1, generatedCount: 1 })
  })

  it('is paid for once when two callers reach the same decision together', async () => {
    // Each model's reply is held until both callers have had time to reach it.
    const gate = (): { open: () => void; opened: Promise<void> } => {
      let open: () => void = () => undefined
      const opened = new Promise<void>((resolve) => {
        open = resolve
      })
      return { open, opened }
    }
    const gates = { [FIRST]: gate(), [SECOND]: gate() }
    const { to } = stubModels({
      [FIRST]: async () => {
        await gates[FIRST].opened
        return { content: BUY }
      },
      [SECOND]: async () => {
        await gates[SECOND].opened
        return { content: SURE_HOLD }
      }
    })
    const { generateAiSignalTape } = await services()

    const a = generateAiSignalTape(request(1, { route: ACTING, requestId: 'a' }))
    const b = generateAiSignalTape(request(1, { route: ACTING, requestId: 'b' }))
    for (const model of [FIRST, SECOND]) {
      await vi.waitFor(() => expect(to(model)).toHaveLength(1))
      // Long enough for the other caller to have asked this model too, had it been going to.
      await new Promise((resolve) => setTimeout(resolve, 30))
      gates[model].open()
    }

    const tapes = await Promise.all([a, b])
    expect(to(FIRST)).toHaveLength(1)
    expect(to(SECOND)).toHaveLength(1)
    // Two calls and two bills between them, whichever caller happened to make each.
    expect(tapes.reduce((sum, tape) => sum + tape.callCount, 0)).toBe(2)
    expect(tapes.reduce((sum, tape) => sum + tape.costUsd, 0)).toBeCloseTo(COSTS[FIRST] + COSTS[SECOND], 10)
    expect(tapes.every((tape) => tape.decisions[0].model === SECOND && tape.decisions[0].first?.recommendation === 'buy')).toBe(true)
  })

  it('counts one call a decision on a tape with no route', async () => {
    stubModels({ [FIRST]: () => ({ content: BUY }) })
    const { generateAiSignalTape } = await services()
    const tape = await generateAiSignalTape(request(2))
    expect(tape).toMatchObject({ callCount: 2, generatedCount: 2 })
    expect(tape).not.toHaveProperty('route')
    expect(await generateAiSignalTape(request(2, { requestId: 'rerun' }))).toMatchObject({ callCount: 0, cachedCount: 2 })
  })
})

describe('estimating a routed run', () => {
  it('allows two calls for every open decision, and prices each model on its own', async () => {
    stubModels({ [FIRST]: (call) => ({ content: call === 1 ? BUY : answer() }), [SECOND]: () => ({ content: SURE_HOLD }) })
    const { generateAiSignalTape, estimateAiSignalTape } = await services()

    const before = await estimateAiSignalTape(request(3, { route: ACTING }))
    expect(before).toMatchObject({ total: 3, cached: 0, maximumApiCalls: 6, model: FIRST })
    expect(before.route).toEqual({
      model: SECOND,
      when: 'acting',
      maximumApiCalls: 3,
      perCallCostUsd: null,
      costBasis: 'unknown',
      perCallLatencyMs: null
    })
    expect(before.estimatedCostUsd).toBeNull()

    await generateAiSignalTape(request(3, { route: ACTING }))
    const after = await estimateAiSignalTape(request(3, { route: ACTING }))
    // Settled, the passed-on decision included: both of its answers are held.
    expect(after).toMatchObject({ total: 3, cached: 3, maximumApiCalls: 0, costBasis: 'history' })
    expect(after.route).toMatchObject({ maximumApiCalls: 0, costBasis: 'history' })
    expect(after.route?.perCallCostUsd).toBeCloseTo(COSTS[SECOND], 10)
    expect(after.perCallCostUsd).toBeCloseTo(COSTS[FIRST], 10)
    expect(after.estimatedCostUsd).toBe(0)

    // Two more candles: each may need both models, each priced at what that model has cost.
    const longer = await estimateAiSignalTape(request(5, { route: ACTING }))
    expect(longer).toMatchObject({ total: 5, cached: 3, maximumApiCalls: 4 })
    expect(longer.route?.maximumApiCalls).toBe(2)
    expect(longer.estimatedCostUsd).toBeCloseTo(2 * COSTS[FIRST] + 2 * COSTS[SECOND], 10)
  })

  it('follows the routed decision, not the first model\'s, to find what is already held', async () => {
    // The first model wants in on the first candle and the second says no, so the account stays
    // flat. An estimate that followed the first model would go looking for a "long" answer on the
    // second candle, find none, and price a finished run as needing more calls.
    stubModels({ [FIRST]: (call) => ({ content: call === 1 ? BUY : answer() }), [SECOND]: () => ({ content: SURE_HOLD }) })
    const { generateAiSignalTape, estimateAiSignalTape } = await services()
    await generateAiSignalTape(request(2, { route: ACTING }))
    expect(await estimateAiSignalTape(request(2, { route: ACTING }))).toMatchObject({ cached: 2, maximumApiCalls: 0 })
  })

  it('says nothing about a second model for a run that names none', async () => {
    stubModels({ [FIRST]: () => ({}) })
    const { estimateAiSignalTape } = await services()
    const estimate = await estimateAiSignalTape(request(3))
    expect(estimate).toMatchObject({ total: 3, maximumApiCalls: 3 })
    expect(estimate).not.toHaveProperty('route')
  })
})

describe('a route a request may not run', () => {
  it('is refused before anything is asked', async () => {
    const { sent } = stubModels({ [FIRST]: () => ({ content: BUY }), [SECOND]: () => ({ content: BUY }) })
    const { generateAiSignalTape, estimateAiSignalTape } = await services()
    const refused: [unknown, RegExp][] = [
      // The second model is held to the rule the first is: it has to be one the user enabled.
      [{ model: 'acme/unlisted', when: 'acting' }, /acme\/unlisted is not enabled/],
      [{ model: FIRST, when: 'acting' }, /two different models/],
      [{ model: SECOND, when: 'always' }, /wants to trade, or when it is unsure/],
      [{ model: SECOND }, /wants to trade, or when it is unsure/],
      ['acme/frontier', /second model and when/]
    ]
    for (const [route, message] of refused) {
      await expect(generateAiSignalTape(request(1, { route: route as AiRoute }))).rejects.toThrow(message)
      await expect(estimateAiSignalTape(request(1, { route: route as AiRoute }))).rejects.toThrow(message)
    }
    expect(sent).toHaveLength(0)
  })

  it('is not picked up from the settings by a request that names none', async () => {
    // The setting is what a backtest and a bot being switched on copy into their request, after
    // saying so. A bot switched on before routes existed names none, and must go on asking one model.
    const { to } = stubModels({ [FIRST]: () => ({ content: BUY }), [SECOND]: () => ({ content: BUY }) })
    const { generateAiSignalTape, estimateAiSignalTape, setAiConfig } = await services()
    await setAiConfig({ route: ACTING })

    expect(await estimateAiSignalTape(request(1))).not.toHaveProperty('route')
    const tape = await generateAiSignalTape(request(1))
    expect(to(SECOND)).toHaveLength(0)
    expect(tape).not.toHaveProperty('route')
    expect(tape.callCount).toBe(1)
    // And "no route" said out loud is the same thing.
    await generateAiSignalTape(request(1, { route: null, requestId: 'null' }))
    expect(to(SECOND)).toHaveLength(0)
  })
})

describe('the route setting', () => {
  it('is stored, returned and still there the next time the app starts', async () => {
    const { setAiConfig, getAiConfig } = await services()
    expect((await getAiConfig()).route).toBeNull()
    expect((await setAiConfig({ route: UNSURE })).route).toEqual(UNSURE)

    vi.resetModules()
    const restarted = await import('../electron/services/aiConfigService')
    expect((await restarted.getAiConfig()).route).toEqual(UNSURE)
    // A change to something else leaves it alone.
    expect((await restarted.setAiConfig({ dailyCapUsd: 2 })).route).toEqual(UNSURE)
  })

  it('needs a second model that is enabled and is not the default', async () => {
    const { setAiConfig, getAiConfig } = await services()
    await expect(setAiConfig({ route: { model: 'acme/unlisted', when: 'acting' } })).rejects.toThrow(/not enabled/)
    await expect(setAiConfig({ route: { model: FIRST, when: 'acting' } })).rejects.toThrow(/already the default/)
    await expect(setAiConfig({ route: { model: SECOND, when: 'always' } as unknown as AiRoute })).rejects.toThrow(/wants to trade, or when it is unsure/)
    expect((await getAiConfig()).route).toBeNull()
  })

  it('cannot be stranded: its second model can be neither disabled nor made the default while it is on', async () => {
    const { setAiConfig, getAiConfig } = await services()
    await setAiConfig({ route: ACTING })
    await expect(setAiConfig({ enabledModels: [FIRST] })).rejects.toThrow(/Switch routing off before disabling it/)
    await expect(setAiConfig({ defaultModel: SECOND })).rejects.toThrow(/Switch routing off before making it the default/)
    expect(await getAiConfig()).toMatchObject({ defaultModel: FIRST, enabledModels: [FIRST, SECOND], route: ACTING })

    // Off, and then both are allowed.
    expect((await setAiConfig({ route: null })).route).toBeNull()
    expect((await setAiConfig({ enabledModels: [FIRST] })).enabledModels).toEqual([FIRST])
  })

  it('can be turned round in one change: the second model becomes the default, the default the second', async () => {
    const { setAiConfig } = await services()
    await setAiConfig({ route: ACTING })
    expect(await setAiConfig({ defaultModel: SECOND, route: { model: FIRST, when: 'unsure' } })).toMatchObject({
      defaultModel: SECOND,
      route: { model: FIRST, when: 'unsure' }
    })
  })

  it('is dropped when the file on disk holds one that could not run', async () => {
    const stored = (route: unknown, enabledModels = [FIRST, SECOND]): void =>
      writeFileSync(join(process.env.AI_TEST_USER_DATA as string, 'aiConfig.json'), JSON.stringify({ defaultModel: FIRST, enabledModels, route }))
    const read = async () => {
      vi.resetModules()
      return (await import('../electron/services/aiConfigService')).getAiConfig()
    }

    stored(ACTING)
    expect((await read()).route).toEqual(ACTING)
    // Its second model is not enabled, it is the default itself, or its rule cannot be read.
    stored(ACTING, [FIRST])
    expect((await read()).route).toBeNull()
    stored({ model: FIRST, when: 'acting' })
    expect((await read()).route).toBeNull()
    stored({ model: SECOND, when: 'whenever' })
    expect((await read()).route).toBeNull()
    stored('acme/frontier')
    expect((await read()).route).toBeNull()
  })
})
