import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DailySummaryAnswer, DailySummaryRequest, ExitCheckRequest, ExitVerdict, NewsReading, ReviewVerdict, WhyConclusion } from '../shared/aiAdditions'
import type { MarketEvent } from '../shared/marketEvent'
import type { AiWatchConfig } from '../shared/aiWatch'
import type { Candle, ExecutorConfig } from '../shared/ipc'
import type { NewsFeedState, ReadStory } from '../shared/newsFeed'

// electron/services/aiAdditionsService.ts: the AI additions' calls where the money is spent, with the
// network faked and everything else real -- the setting, the ledger, the cache, the budget.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' })
}))
const feed = vi.hoisted(() => ({ listener: null as ((state: NewsFeedState) => void) | null, stories: [] as ReadStory[] }))
vi.mock('../electron/services/newsFeedService', () => ({
  onNewsFeedUpdate: (listener: (state: NewsFeedState) => void) => {
    feed.listener = listener
    return () => undefined
  },
  getNewsFeedState: () => ({ stories: feed.stories, reactions: {} })
}))
const settings = vi.hoisted(() => ({ executors: [] as ExecutorConfig[] }))
const told = vi.hoisted(() => ({ notices: [] as { title: string; extra: { kind: string; thread?: string } }[] }))
// A notice the main process builds in the person's language (V6 Stage 14) is handed as a builder:
// built here in English, as the language of a profile that chose none.
vi.mock('../electron/services/noticeService', async () => {
  const { ENGLISH } = await import('../shared/i18n/translate')
  type Told = { title: string; extra: { kind: string; thread?: string } }
  return {
    tell: (notice: Told | ((i18n: typeof ENGLISH) => Told)) => void told.notices.push(typeof notice === 'function' ? notice(ENGLISH) : notice)
  }
})
vi.mock('../electron/services/settingsService', () => ({
  getSettings: async () => ({ executors: settings.executors })
}))
const market = vi.hoisted(() => ({ bars: {} as Record<string, Candle[]>, asked: [] as string[] }))
vi.mock('../electron/services/marketService', () => ({
  scanSourceFor: () => ({
    fetchRecentCandles: async (symbol: string) => {
      market.asked.push(symbol)
      const bars = market.bars[symbol]
      if (bars === undefined) throw new Error(`${symbol} is not traded`)
      return bars
    }
  })
}))

const A = 'openai/gpt-5-mini'
const NOW = Date.parse('2026-10-06T12:00:00Z') / 1000
const ON: AiWatchConfig = { enabled: true, models: [A], maxEventsPerDay: 5, minBand: 'urgent', firstModelGates: false, confirmLive: false, askAt: 'detected' }
const READING: NewsReading = { ticker: 'SOL', relationship: 'DIRECT', direction: 'up', impact: 72, horizon: '4h', confidence: 0.7, pricedIn: false, reasons: 'A large listing.' }
const CONCLUSION: WhyConclusion = { conclusion: 'The futures listing drew buyers, on three times the usual volume.', cites: ['story:a'], confidence: 0.6 }
const VERDICT: ReviewVerdict = { verdict: 'REJECT', confidence: 0.7, reason: 'Another model sells it, and the move is overextended.' }
const EXIT_VERDICT: ExitVerdict = { verdict: 'EXIT', confidence: 0.65, reason: 'It broke the level it was bought on.' }
const DAILY: DailySummaryAnswer = { summary: 'Bitcoin rose 2.1% and the regime closed bull; one major story, a SOL futures listing, with SOL up 1.2% in the hour after; three paper trades opened and two ended, +1.40 USDT; one model ranked; nothing paused.', confidence: 0.55 }

/** Four hours of closed minutes ending before NOW: flat at 100, and over the last hour to `end`. */
function minutes(end: number): Candle[] {
  const last = Math.floor(NOW / 60) * 60 - 60
  const out: Candle[] = []
  for (let k = 239; k >= 0; k--) {
    const close = k >= 60 ? 100 : 100 + ((end - 100) * (60 - k)) / 60
    out.push({ time: last - k * 60, open: close, high: close, low: close, close, volume: 10 })
  }
  return out
}

function story(id: string, over: Partial<ReadStory> = {}): ReadStory {
  return {
    id,
    source: 'coindesk',
    sourceName: 'CoinDesk',
    sourceClass: 'media',
    title: `Binance lists SOL futures (${id})`,
    url: 'https://www.coindesk.com/x',
    publishedAt: NOW - 600,
    seenAt: NOW - 590,
    summary: 'A summary.',
    assets: [{ ticker: 'SOL', relationship: 'DIRECT' }],
    marketWide: false,
    eventType: 'LISTING',
    credibility: 0.85,
    impact: 75,
    stale: false,
    alsoIn: [],
    ...over
  }
}

type Reply = { status?: number; content?: string }

function stubOpenRouter(reply: (call: number) => Reply | Promise<Reply> = () => ({})): { bodies: { model: string; messages: { role: string; content: string }[]; response_format: { json_schema: { name: string } } }[] } {
  const bodies: { model: string; messages: { role: string; content: string }[]; response_format: { json_schema: { name: string } } }[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? '{}'))
    const asked = bodies[bodies.length - 1].response_format?.json_schema?.name
    const answer = asked === 'why_conclusion' ? CONCLUSION : asked === 'review_verdict' ? VERDICT : asked === 'exit_verdict' ? EXIT_VERDICT : asked === 'daily_summary' ? DAILY : READING
    const { status = 200, content = JSON.stringify(answer) } = await reply(bodies.length)
    const body =
      status === 200
        ? { provider: 'Test', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 600, completion_tokens: 120, cost: 0.001 } }
        : { error: { code: status, message: 'overloaded' } }
    return { ok: status === 200, status, text: async () => JSON.stringify(body) }
  })
  return { bodies }
}

async function services() {
  const signal = await import('../electron/services/aiSignalService')
  const config = await import('../electron/services/aiConfigService')
  const ledger = await import('../electron/services/aiLedgerService')
  const additions = await import('../electron/services/aiAdditionsService')
  const prompts = await import('../electron/services/aiAdditionPrompts')
  signal.aiRetry.baseDelayMs = 0
  return { ...config, ...ledger, ...additions, ...prompts }
}

beforeEach(() => {
  vi.resetModules()
  feed.listener = null
  feed.stories = []
  settings.executors = []
  market.bars = {}
  market.asked = []
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-additions-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW * 1000))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the news analyst', () => {
  it('asks nothing by itself while the watch is off, and says why', async () => {
    const { bodies } = stubOpenRouter()
    const { analyseStory } = await services()
    expect(await analyseStory(story('a'), true)).toEqual({ status: 'skipped', reason: 'The news analyst asks by itself only while the watch is on.' })
    expect(bodies).toHaveLength(0)
  })

  it('asks once with the watch on, writes what it asked and paid, and serves the cache after', async () => {
    const { bodies } = stubOpenRouter()
    const { analyseStory, setAiConfig, getAiConfig, listAiCalls, AI_ADDITION_SYSTEM_PROMPTS } = await services()
    await setAiConfig({ watch: ON })
    expect(await analyseStory(story('a'), true)).toEqual({ status: 'answered', answer: READING, cached: false, model: A })
    expect(bodies).toHaveLength(1)
    expect(bodies[0].model).toBe(A)
    expect(bodies[0].messages[0]).toEqual({ role: 'system', content: AI_ADDITION_SYSTEM_PROMPTS.news })
    expect(JSON.parse(bodies[0].messages[1].content)).toMatchObject({ story: { id: 'a', kind: 'LISTING', coins: [{ ticker: 'SOL', relationship: 'DIRECT' }] } })
    expect(bodies[0].response_format.json_schema.name).toBe('news_reading')
    const [row] = (await listAiCalls({ source: 'addition' })).rows
    expect(row).toMatchObject({
      source: 'addition',
      addition: 'news',
      subjectId: 'a',
      status: 'ok',
      model: A,
      promptVersion: 'news-analyst-v1',
      schemaVersion: 'news-reading-v1',
      symbol: 'SOLUSDT',
      candleTime: NOW - 600,
      recommendation: null,
      confidence: 0.7,
      rationale: 'A large listing.',
      additionAnswer: READING
    })
    // It is not an answer to an event: nothing that joins answers to events will read it.
    expect(row.eventId).toBeUndefined()
    expect((await getAiConfig()).spentTodayUsd).toBeCloseTo(0.001, 10)
    // Asked again, it is served for nothing.
    expect(await analyseStory(story('a'), true)).toEqual({ status: 'answered', answer: READING, cached: true, model: A })
    expect(bodies).toHaveLength(1)
  })

  it('is asked by a person with the watch off', async () => {
    stubOpenRouter()
    const { analyseStory } = await services()
    expect((await analyseStory(story('a'), false)).status).toBe('answered')
  })

  it('keeps an answer it refuses, with what was sent, and never pays for it again', async () => {
    const { bodies } = stubOpenRouter(() => ({ content: JSON.stringify({ ...READING, impact: 900 }) }))
    const { analyseStory, setAiConfig, listAiCalls } = await services()
    await setAiConfig({ watch: ON })
    expect(await analyseStory(story('a'), true)).toEqual({ status: 'refused', reason: 'impact is not a whole number from 0 to 100.', cached: false, model: A })
    const [row] = (await listAiCalls({ source: 'addition' })).rows
    expect(row).toMatchObject({ status: 'rejected', error: 'impact is not a whole number from 0 to 100.' })
    expect(row.answerExcerpt).toContain('"impact":900')
    expect(row.additionAnswer).toBeUndefined()
    expect(await analyseStory(story('a'), true)).toEqual({ status: 'refused', reason: 'impact is not a whole number from 0 to 100.', cached: true, model: A })
    expect(bodies).toHaveLength(1)
  })

  it('counts a call that never got an answer, caches nothing, and asks again next time', async () => {
    const { bodies } = stubOpenRouter((call) => (call <= 3 ? { status: 503 } : {}))
    const { analyseStory, setAiConfig, listAiCalls } = await services()
    await setAiConfig({ watch: ON })
    expect((await analyseStory(story('a'), true)).status).toBe('failed')
    expect((await listAiCalls({ source: 'addition' })).rows.map((row) => row.status)).toEqual(['failed'])
    expect((await analyseStory(story('a'), true)).status).toBe('answered')
    expect(bodies).toHaveLength(4)
  })

  it('stops at its daily limit, counting every call made today', async () => {
    const { bodies } = stubOpenRouter()
    const { analyseStory, setAiConfig, appendAiCall } = await services()
    await setAiConfig({ watch: ON })
    for (let k = 0; k < 40; k++) {
      await appendAiCall({
        id: `r${k}`,
        at: NOW - k,
        source: 'addition',
        status: k % 2 === 0 ? 'ok' : 'failed',
        model: A,
        provider: null,
        promptVersion: 'news-analyst-v1',
        contextVersion: 'addition-v1',
        schemaVersion: 'news-reading-v1',
        exchange: 'binance',
        symbol: 'SOLUSDT',
        interval: '1m',
        candleTime: NOW,
        position: 'flat',
        referencePrice: 0,
        usage: { promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: 0 },
        error: null,
        recommendation: null,
        confidence: null,
        rationale: null,
        detail: null,
        addition: 'news',
        subjectId: `old-${k}`
      })
    }
    expect(await analyseStory(story('a'), true)).toEqual({ status: 'skipped', reason: 'The news analyst has made its 40 calls today.' })
    expect(bodies).toHaveLength(0)
  })

  it('gives the last place under its limit to one of two calls arriving together', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { bodies } = stubOpenRouter(async () => {
      await held
      return {}
    })
    const { analyseStory, setAiConfig, appendAiCall } = await services()
    await setAiConfig({ watch: ON })
    for (let k = 0; k < 39; k++) {
      await appendAiCall({
        id: `r${k}`,
        at: NOW - k,
        source: 'addition',
        status: 'ok',
        model: A,
        provider: null,
        promptVersion: 'news-analyst-v1',
        contextVersion: 'addition-v1',
        schemaVersion: 'news-reading-v1',
        exchange: 'binance',
        symbol: 'SOLUSDT',
        interval: '1m',
        candleTime: NOW,
        position: 'flat',
        referencePrice: 0,
        usage: { promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: 0 },
        error: null,
        recommendation: null,
        confidence: null,
        rationale: null,
        detail: null
      })
    }
    const first = analyseStory(story('a'), true)
    const second = analyseStory(story('b'), true)
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    release()
    const outcomes = (await Promise.all([first, second])).map((outcome) => outcome.status).sort()
    expect(outcomes).toEqual(['answered', 'skipped'])
  })

  it('is not asked switched off, or once the daily budget is spent, which is told once a day on the budget\'s thread (8 October 2026)', async () => {
    told.notices.length = 0
    const { bodies } = stubOpenRouter()
    const { analyseStory, setAiConfig } = await services()
    await setAiConfig({ watch: ON, additions: { news: false } })
    expect(await analyseStory(story('a'), true)).toEqual({ status: 'skipped', reason: 'The news analyst is switched off under Settings › AI.' })
    await setAiConfig({ additions: { news: true }, dailyCapUsd: 0 })
    const outcome = await analyseStory(story('a'), true)
    expect(outcome.status).toBe('skipped')
    expect(bodies).toHaveLength(0)
    // Told on the budget's daily thread, as the watch's own calls are; the handler keeps the thread.
    expect(told.notices.map((notice) => [notice.title, notice.extra.kind, notice.extra.thread])).toEqual([["Today's AI budget is spent", 'CIRCUIT_BREAKER', 'ai-budget']])
  })

  it('takes up each fresh story of high impact once, and one the price confirmed', async () => {
    const { takeUpHighStories } = await services()
    const state = {
      stories: [
        story('high'),
        story('low', { impact: 40 }),
        story('confirmed', { impact: 40 }),
        story('stale', { stale: true }),
        story('old', { publishedAt: NOW - 3601 }),
        story('ahead', { publishedAt: NOW + 60 })
      ],
      reactions: { confirmed: { verdict: 'CONFIRMED' } } as unknown as NewsFeedState['reactions']
    }
    expect(takeUpHighStories(state, NOW).map((entry) => entry.id)).toEqual(['high', 'confirmed'])
    expect(takeUpHighStories(state, NOW)).toEqual([])
  })

  it('reads the stories of high impact the feed reports, by itself', async () => {
    const { bodies } = stubOpenRouter()
    const { startAiAdditions, setAiConfig, listAiCalls } = await services()
    await setAiConfig({ watch: ON })
    startAiAdditions()
    expect(feed.listener).not.toBeNull()
    feed.listener?.({ stories: [story('high'), story('low', { impact: 30 })], reactions: {} } as unknown as NewsFeedState)
    await vi.waitFor(async () => expect((await listAiCalls({ source: 'addition' })).rows.map((row) => row.subjectId)).toEqual(['high']))
    expect(bodies).toHaveLength(1)
  })
})

describe('the conclusion to "Why did it move?"', () => {
  it('is asked on a click with the watch off, about evidence rebuilt here, and cites only what was listed', async () => {
    const { bodies } = stubOpenRouter()
    const { concludeMove, listAiCalls, AI_ADDITION_SYSTEM_PROMPTS } = await services()
    market.bars = { SOLUSDT: minutes(102.5), BTCUSDT: minutes(100) }
    feed.stories = [story('a', { publishedAt: NOW - 50 * 60, seenAt: NOW - 49 * 60 })]
    const result = await concludeMove('SOLUSDT', false)
    expect(result.explanation).toMatchObject({ label: 'PROBABLE', movePct: expect.closeTo(2.5, 6) })
    expect(result.question?.evidence.map((item) => item.id)).toEqual(['story:a'])
    expect(result.outcome).toEqual({ status: 'answered', answer: CONCLUSION, cached: false, model: A })
    expect(market.asked).toEqual(['SOLUSDT', 'BTCUSDT'])
    expect(bodies).toHaveLength(1)
    expect(bodies[0].messages[0].content).toBe(AI_ADDITION_SYSTEM_PROMPTS.why)
    expect(JSON.parse(bodies[0].messages[1].content)).toEqual(result.question)
    expect(bodies[0].response_format.json_schema.name).toBe('why_conclusion')
    const minute = Math.floor(NOW / 60) * 60
    expect((await listAiCalls({ source: 'addition' })).rows[0]).toMatchObject({
      addition: 'why',
      subjectId: `SOLUSDT:${minute}`,
      symbol: 'SOLUSDT',
      candleTime: minute,
      promptVersion: 'why-conclusion-v1',
      status: 'ok',
      rationale: CONCLUSION.conclusion,
      additionAnswer: CONCLUSION
    })
  })

  it('asks nothing when there is nothing to conclude: a quiet pair, or no evidence', async () => {
    const { bodies } = stubOpenRouter()
    const { concludeMove } = await services()
    market.bars = { SOLUSDT: minutes(100.2), BTCUSDT: minutes(100) }
    feed.stories = [story('a', { publishedAt: NOW - 50 * 60, seenAt: NOW - 49 * 60 })]
    expect((await concludeMove('SOLUSDT', false)).outcome).toBeNull()
    market.bars = { SOLUSDT: minutes(102.5), BTCUSDT: minutes(100) }
    feed.stories = [story('a', { assets: [{ ticker: 'XRP', relationship: 'DIRECT' }] })]
    const quiet = await concludeMove('SOLUSDT', false)
    expect(quiet.question).toBeNull()
    expect(quiet.outcome).toBeNull()
    expect(bodies).toHaveLength(0)
  })

  it('drops a conclusion that cites what was not listed', async () => {
    stubOpenRouter(() => ({ content: JSON.stringify({ ...CONCLUSION, cites: ['market'] }) }))
    const { concludeMove } = await services()
    market.bars = { SOLUSDT: minutes(102.5), BTCUSDT: minutes(100) }
    feed.stories = [story('a', { publishedAt: NOW - 50 * 60, seenAt: NOW - 49 * 60 })]
    expect((await concludeMove('SOLUSDT', false)).outcome).toEqual({ status: 'refused', reason: 'It cites "market", which is not one of the evidence listed.', cached: false, model: A })
  })

  it('reads a pair only as Binance names one against USDT', async () => {
    stubOpenRouter()
    const { concludeMove } = await services()
    await expect(concludeMove('sol', false)).rejects.toThrow('A pair is named as Binance names it, against USDT.')
    await expect(concludeMove('SOLBTC', false)).rejects.toThrow('A pair is named as Binance names it, against USDT.')
    await expect(concludeMove('XYZUSDT', false)).rejects.toThrow('XYZUSDT is not traded')
  })

  it('is asked by itself for the coin a story of high impact names, after the analyst', async () => {
    const { bodies } = stubOpenRouter()
    const { startAiAdditions, setAiConfig, listAiCalls } = await services()
    await setAiConfig({ watch: ON })
    market.bars = { SOLUSDT: minutes(102.5), BTCUSDT: minutes(100) }
    feed.stories = [story('a', { publishedAt: NOW - 50 * 60, seenAt: NOW - 49 * 60 })]
    startAiAdditions()
    feed.listener?.({ stories: feed.stories, reactions: {} } as unknown as NewsFeedState)
    await vi.waitFor(async () => expect((await listAiCalls({ source: 'addition' })).rows.map((row) => row.addition).sort()).toEqual(['news', 'why']))
    expect(bodies.map((body) => body.response_format.json_schema.name)).toEqual(['news_reading', 'why_conclusion'])
  })
})

describe('the reviewer', () => {
  const B = 'mistralai/mistral-small-2603'
  const EVENT: MarketEvent = {
    id: `binance:SOLUSDT:${NOW - 60}`,
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    time: NOW - 60,
    type: 'breakout',
    direction: 'up',
    band: 'urgent',
    score: 91,
    components: { price: 90, volume: 95, volatility: 85, pressure: 90, breakout: 95 },
    price: 100,
    returnsPct: { m1: 0.4, m5: 1.5, m15: 3, h1: 3.2, h4: 2.5 },
    moveSigmas: 6,
    volumeRatio: 4.7,
    rangeRatio: 3,
    live: { detectedAt: NOW - 52, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 }
  }
  const DECISION = {
    candleTime: EVENT.time,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range on volume.',
    model: A,
    cached: false,
    error: null,
    rejected: null,
    detail: { marketRegime: 'bull', riskLevel: 'medium', horizonBars: 4, stopLoss: 98.5, takeProfit: 103, reasonCodes: [], levelsNote: null, entry: { min: 99.8, max: 100.2, validMinutes: 15 } }
  }
  /** A model's answer to the same event, on file: another model's unless said. */
  async function answerOnFile(appendAiCall: (row: never) => Promise<void>, recommendation: 'buy' | 'sell', model = B): Promise<void> {
    await appendAiCall({
      id: `answer-${model}`,
      at: NOW - 30,
      source: 'watch',
      status: 'ok',
      model,
      provider: 'Test',
      promptVersion: 'opportunity-v1',
      contextVersion: 'context-v1',
      schemaVersion: 'opportunity-schema-v1',
      exchange: 'binance',
      symbol: 'SOLUSDT',
      interval: '15m',
      candleTime: EVENT.time,
      position: 'flat',
      referencePrice: 100,
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 1000 },
      error: null,
      recommendation,
      confidence: 0.7,
      rationale: 'other',
      detail: { ...DECISION.detail, stopLoss: recommendation === 'sell' ? 101.5 : 98.5, takeProfit: recommendation === 'sell' ? 97 : 103 },
      eventId: EVENT.id,
      eventType: 'breakout'
    } as never)
  }

  it('asks nothing when nothing about the trade stands out', async () => {
    const { bodies } = stubOpenRouter()
    const { reviewTrade, setAiConfig, appendAiCall } = await services()
    await setAiConfig({ watch: ON })
    await answerOnFile(appendAiCall as never, 'buy')
    expect(await reviewTrade({ event: EVENT, decision: DECISION })).toEqual({ asked: false, triggers: [], outcome: null })
    expect(bodies).toHaveLength(0)
  })

  it('asks when another model on file takes the other side, telling it so, and returns its verdict', async () => {
    const { bodies } = stubOpenRouter()
    const { reviewTrade, setAiConfig, appendAiCall, listAiCalls, AI_ADDITION_SYSTEM_PROMPTS } = await services()
    await setAiConfig({ watch: ON })
    // The reviewed model's own answer is on file too, as it is when its trade would open: it is the
    // call under review, not another one.
    await answerOnFile(appendAiCall as never, 'buy', A)
    await answerOnFile(appendAiCall as never, 'sell')
    expect(await reviewTrade({ event: EVENT, decision: DECISION })).toEqual({
      asked: true,
      triggers: ['models_disagree'],
      outcome: { status: 'answered', answer: VERDICT, cached: false, model: A }
    })
    expect(bodies[0].messages[0].content).toBe(AI_ADDITION_SYSTEM_PROMPTS.review)
    expect(bodies[0].response_format.json_schema.name).toBe('review_verdict')
    expect(JSON.parse(bodies[0].messages[1].content)).toMatchObject({
      event: { pair: 'SOLUSDT', movePct15m: 3, quoteVolume24h: 80_000_000 },
      call: { model: A, side: 'long', entryMin: 99.8, entryMax: 100.2, stopLoss: 98.5, takeProfit: 103 },
      others: [{ model: B, call: 'SELL', confidence: 0.7 }],
      news: [],
      triggers: ['models_disagree']
    })
    const [row] = (await listAiCalls({ source: 'addition' })).rows
    expect(row).toMatchObject({ addition: 'review', subjectId: EVENT.id, symbol: 'SOLUSDT', candleTime: EVENT.time, referencePrice: 100, rationale: VERDICT.reason, additionAnswer: VERDICT })
    expect(row.eventId).toBeUndefined()
  })

  it('is held to the watch: with it off, nothing is asked', async () => {
    const { bodies } = stubOpenRouter()
    const { reviewTrade, appendAiCall } = await services()
    await answerOnFile(appendAiCall as never, 'sell')
    expect(await reviewTrade({ event: EVENT, decision: DECISION })).toEqual({
      asked: true,
      triggers: ['models_disagree'],
      outcome: { status: 'skipped', reason: 'The reviewer asks by itself only while the watch is on.' }
    })
    expect(bodies).toHaveLength(0)
  })

  it('refuses a request that is not an event and a call', async () => {
    stubOpenRouter()
    const { reviewTrade } = await services()
    await expect(reviewTrade({ event: EVENT })).rejects.toThrow('A review is asked about an event and a call to trade it.')
  })
})

describe('the exit check', () => {
  const OPENED = NOW - 3600
  const ENTERED = OPENED + 60
  const EVENT_ID = `binance:SOLUSDT:${OPENED - 60}`
  const TRADE: ExecutorConfig = {
    id: 'w1',
    name: 'Watch: BUY SOLUSDT',
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: OPENED,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    watch: { eventId: EVENT_ID, eventTime: OPENED - 60, model: A, confidence: 0.8 },
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { side: 'buy', entryPrice: null, amountQuote: 100, takeProfitPct: 4, stopLossPct: 2, timeLimitSec: 7200, trailingStop: null }
  }
  /** Near its stop: 98.4 is 80% of the way from 100 to a 2% stop. */
  const NEAR_STOP: ExitCheckRequest = { executorId: 'w1', entryPrice: 100, enteredAt: ENTERED, priceTime: NOW - 60, price: 98.4, move15mPct: -0.5, regimeAtEntry: 'bull', regimeNow: 'bull' }

  /** The call the watch followed, on file as the watch wrote it. */
  async function callOnFile(appendAiCall: (row: never) => Promise<void>): Promise<void> {
    await appendAiCall({
      id: 'the-call',
      at: OPENED - 30,
      source: 'watch',
      status: 'ok',
      model: A,
      provider: 'Test',
      promptVersion: 'opportunity-v1',
      contextVersion: 'context-v1',
      schemaVersion: 'opportunity-schema-v1',
      exchange: 'binance',
      symbol: 'SOLUSDT',
      interval: '15m',
      candleTime: OPENED - 60,
      position: 'flat',
      referencePrice: 100,
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 1000 },
      error: null,
      recommendation: 'buy',
      confidence: 0.8,
      rationale: 'Cleared the range on volume.',
      detail: null,
      eventId: EVENT_ID,
      eventType: 'breakout'
    } as never)
  }

  it('asks nothing when nothing about the trade has changed', async () => {
    const { bodies } = stubOpenRouter()
    const { exitCheck, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    settings.executors = [TRADE]
    expect(await exitCheck({ ...NEAR_STOP, price: 99 })).toEqual({ asked: false, triggers: [], outcome: null })
    expect(bodies).toHaveLength(0)
  })

  it('asks near the stop, telling it the trade as the executors on file have it and the call it was opened on', async () => {
    const { bodies } = stubOpenRouter()
    const { exitCheck, setAiConfig, appendAiCall, listAiCalls, AI_ADDITION_SYSTEM_PROMPTS } = await services()
    await setAiConfig({ watch: ON })
    await callOnFile(appendAiCall as never)
    settings.executors = [TRADE]
    expect(await exitCheck(NEAR_STOP)).toEqual({ asked: true, triggers: ['near_stop'], outcome: { status: 'answered', answer: EXIT_VERDICT, cached: false, model: A } })
    expect(bodies).toHaveLength(1)
    expect(bodies[0].messages[0].content).toBe(AI_ADDITION_SYSTEM_PROMPTS.exit)
    expect(bodies[0].response_format.json_schema.name).toBe('exit_verdict')
    expect(JSON.parse(bodies[0].messages[1].content)).toEqual({
      trade: {
        pair: 'SOLUSDT',
        side: 'long',
        openedBy: `the watch, following ${A}'s call on a market event`,
        thesis: 'Cleared the range on volume.',
        entryPrice: 100,
        minutesOpen: 59,
        stopPct: 2,
        targetPct: 4,
        minutesLeft: 61
      },
      now: { price: 98.4, gainPct: -1.6, move15mPct: -0.5, regimeAtEntry: 'bull', regimeNow: 'bull' },
      news: [],
      triggers: ['near_stop']
    })
    const [row] = (await listAiCalls({ source: 'addition' })).rows
    expect(row).toMatchObject({ addition: 'exit', subjectId: 'w1:near_stop', symbol: 'SOLUSDT', candleTime: NOW - 60, referencePrice: 98.4, rationale: EXIT_VERDICT.reason, additionAnswer: EXIT_VERDICT })
    expect(row.eventId).toBeUndefined()
  })

  it('asks once a trade and a reason: not again for the same one, and again for a new one', async () => {
    const { bodies } = stubOpenRouter()
    const { exitCheck, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    settings.executors = [TRADE]
    expect((await exitCheck(NEAR_STOP)).asked).toBe(true)
    expect(await exitCheck({ ...NEAR_STOP, price: 98.3 })).toEqual({ asked: false, triggers: ['near_stop'], outcome: null })
    expect(bodies).toHaveLength(1)
    // News on the coin since it was opened is a reason it has not been asked for.
    feed.stories = [story('hack', { title: 'Solana bridge hacked', eventType: 'HACK', impact: 85, publishedAt: NOW - 300 })]
    expect(await exitCheck(NEAR_STOP)).toMatchObject({ asked: true, triggers: ['near_stop', 'news'], outcome: { status: 'answered' } })
    expect(JSON.parse(bodies[1].messages[1].content).news).toEqual([{ title: 'Solana bridge hacked', source: 'CoinDesk', kind: 'HACK', impact: 85, minutesAgo: 5 }])
    expect((await exitCheck(NEAR_STOP)).asked).toBe(false)
    expect(bodies).toHaveLength(2)
    // A call that got no answer is counted as asked too: one ask a trade and a reason.
    const { bodies: failing } = stubOpenRouter(() => ({ status: 400 }))
    expect(await exitCheck({ ...NEAR_STOP, regimeNow: 'bear' })).toMatchObject({ asked: true, triggers: ['near_stop', 'news', 'regime_change'], outcome: { status: 'failed' } })
    expect(await exitCheck({ ...NEAR_STOP, regimeNow: 'bear' })).toMatchObject({ asked: false })
    expect(failing).toHaveLength(1)
  })

  it('is held to the watch: with it off, nothing is asked', async () => {
    const { bodies } = stubOpenRouter()
    const { exitCheck } = await services()
    settings.executors = [TRADE]
    expect(await exitCheck(NEAR_STOP)).toEqual({ asked: true, triggers: ['near_stop'], outcome: { status: 'skipped', reason: 'The exit check asks by itself only while the watch is on.' } })
    expect(bodies).toHaveLength(0)
  })

  it("looks only at the app's own open paper trades, and refuses everything else", async () => {
    const { bodies } = stubOpenRouter()
    const { exitCheck, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    const refused = async (executors: ExecutorConfig[], request: unknown = NEAR_STOP): Promise<string> => {
      settings.executors = executors
      return exitCheck(request).then(
        () => 'asked',
        (failure: Error) => failure.message
      )
    }
    expect(await refused([{ ...TRADE, mode: 'live' }])).toBe("The exit check looks only at the app's own open paper trades, and it is not a paper position.")
    expect(await refused([{ ...TRADE, watch: undefined }])).toBe("The exit check looks only at the app's own open paper trades, and it was not opened by the watch or a news rule.")
    expect(await refused([{ ...TRADE, status: 'stopped' }])).toBe("The exit check looks only at the app's own open paper trades, and it has been stopped.")
    expect(await refused([])).toBe("The exit check looks only at the app's own open paper trades, and there is no such trade on file.")
    expect(await refused([TRADE], { ...NEAR_STOP, executorId: undefined })).toBe("An exit check is asked about one of the app's own open paper trades, as it stands.")
    expect(await refused([TRADE], { ...NEAR_STOP, priceTime: NOW - 600 })).toBe('The price the exit check would be shown is not of the last few minutes.')
    expect(await refused([TRADE], { ...NEAR_STOP, priceTime: NOW + 60 })).toBe('The price the exit check would be shown is not of the last few minutes.')
    expect(await refused([TRADE], { ...NEAR_STOP, enteredAt: OPENED - 120 })).toBe('The entry the exit check would be shown is before the trade was opened.')
    expect(bodies).toHaveLength(0)
  })

  it("tells it a news rule's short by its announcement", async () => {
    const { bodies } = stubOpenRouter()
    const { exitCheck, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    settings.executors = [
      {
        ...TRADE,
        id: 'n1',
        symbol: 'ABCUSDT',
        baseAsset: 'ABC',
        watch: undefined,
        newsRule: { articleId: 7, ticker: 'ABC', releaseSec: OPENED - 30, title: 'Binance Will Delist ABC', category: 'DELISTING' },
        params: { side: 'sell', entryPrice: null, amountQuote: 100, takeProfitPct: null, stopLossPct: null, timeLimitSec: 14_400, trailingStop: null }
      }
    ]
    // A sharp bounce against the short.
    expect(await exitCheck({ ...NEAR_STOP, executorId: 'n1', price: 103, move15mPct: 2.5 })).toMatchObject({ asked: true, triggers: ['opposite_move'] })
    expect(JSON.parse(bodies[0].messages[1].content).trade).toMatchObject({
      pair: 'ABCUSDT',
      side: 'short',
      openedBy: "the delisting rule, on Binance's announcement",
      thesis: `Binance announced the coin's delisting: "Binance Will Delist ABC".`,
      stopPct: null,
      targetPct: null
    })
  })
})

describe('what Settings › AI shows', () => {
  it("says each addition's switch, what it asked today, and what a call costs", async () => {
    stubOpenRouter()
    const { getAiAdditionsStatus, analyseStory, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    expect(await getAiAdditionsStatus()).toEqual({
      model: A,
      // Before roles (V7.2-R Stage 1) every addition asks the model the watch's paper trades follow, here its first.
      // The daily direction test asks the deciding model always (V10 Stage 7).
      models: { news: A, why: A, exit: A, review: A, daily: A, article: A, direction: A },
      byRole: false,
      watchOn: true,
      additions: { news: true, why: true, exit: true, review: true, daily: true, article: false, direction: false },
      limits: { news: 40, why: 20, exit: 30, review: 20, daily: 1, article: 20, direction: 1 },
      today: { news: 0, why: 0, exit: 0, review: 0, daily: 0, article: 0, direction: 0 },
      perCall: {
        news: { usd: null, basis: 'unknown' },
        why: { usd: null, basis: 'unknown' },
        exit: { usd: null, basis: 'unknown' },
        review: { usd: null, basis: 'unknown' },
        daily: { usd: null, basis: 'unknown' },
        article: { usd: null, basis: 'unknown' },
        direction: { usd: null, basis: 'unknown' }
      }
    })
    await analyseStory(story('a', { publishedAt: NOW - 50 * 60, seenAt: NOW - 49 * 60 }), true)
    expect(await getAiAdditionsStatus()).toMatchObject({ today: { news: 1, why: 0, exit: 0, review: 0, daily: 0, article: 0 }, perCall: { news: { usd: 0.001, basis: 'history' } } })
  })
})

describe('the daily summary', () => {
  const request: DailySummaryRequest = {
    day: '2026-10-05',
    question: {
      day: '2026-10-05',
      market: { regime: 'bull', btcDayPct: 2.1, ethDayPct: -0.4, breadthPct: 61, pairsRead: 60, moversUp: [{ pair: 'SOLUSDT', dayPct: 8 }], moversDown: [{ pair: 'XRPUSDT', dayPct: -6 }] },
      news: [{ title: 'Binance lists SOL futures', source: 'CoinDesk', impact: 80, tickers: ['SOL'], hourAfterPct: 1.2 }],
      newsKept: true,
      trades: { opened: 3, ended: 2, openNow: 1, net: [{ asset: 'USDT', amount: 1.4 }], r: 0.6, rTrades: 2, bestPct: 2.1, worstPct: -1.2, refused: [] },
      calls: { made: 12, answered: 12, valid: 11, costUsd: 0.09 },
      answers: { buy: 4, sell: 1, hold: 5, noTrade: 2 },
      models: [{ model: A, closed: 40, netPctATrade: 0.2, profitFactor: 1.3 }],
      risk: { pausedWatch: false, pausedNews: false, aiSpentUsd: 0.31, aiCapUsd: 5, healthPauses: 0, highAlerts: 3 }
    }
  }

  it('asks once about a day that is over, files the paragraph under the day, and serves the cache after', async () => {
    const { bodies } = stubOpenRouter()
    const { summarizeDay, setAiConfig, listAiCalls } = await services()
    await setAiConfig({ watch: ON })
    const first = await summarizeDay(request, true)
    expect(first).toEqual({ asked: true, outcome: { status: 'answered', answer: DAILY, cached: false, model: A } })
    expect(bodies).toHaveLength(1)
    expect(bodies[0].response_format.json_schema.name).toBe('daily_summary')
    expect(bodies[0].messages[0].content).toContain("You write the day's summary")
    expect(JSON.parse(bodies[0].messages[1].content)).toEqual(request.question)
    const rows = (await listAiCalls({ source: 'addition', limit: 10 })).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ addition: 'daily', subjectId: 'day:2026-10-05', promptVersion: 'daily-summary-v1', schemaVersion: 'daily-summary-v1', status: 'ok', symbol: 'BTCUSDT', additionAnswer: DAILY })
    // The same figures again: the paragraph on file, nothing spent.
    expect(await summarizeDay(request, false)).toEqual({ asked: true, outcome: { status: 'answered', answer: DAILY, cached: true, model: A } })
    expect(bodies).toHaveLength(1)
    // Figures that changed: one call a day, and it was made.
    const changed = { ...request, question: { ...request.question, risk: { ...request.question.risk, highAlerts: 4 } } }
    expect(await summarizeDay(changed, false)).toEqual({ asked: true, outcome: { status: 'skipped', reason: 'The daily summary has made its one call today.' } })
    expect(bodies).toHaveLength(1)
  })

  it('is held to the watch when it asks by itself, and not when a person asks', async () => {
    const { bodies } = stubOpenRouter()
    const { summarizeDay } = await services()
    expect(await summarizeDay(request, true)).toEqual({ asked: true, outcome: { status: 'skipped', reason: 'The daily summary asks by itself only while the watch is on.' } })
    expect(bodies).toHaveLength(0)
    expect((await summarizeDay(request, false)).outcome).toMatchObject({ status: 'answered', cached: false })
    expect(bodies).toHaveLength(1)
  })

  it('refuses a request that is not a day and its figures, and a day that is not over', async () => {
    stubOpenRouter()
    const { summarizeDay } = await services()
    await expect(summarizeDay({ day: '2026-10-05' }, false)).rejects.toThrow("A daily summary is asked about one UTC day's report")
    await expect(summarizeDay({ ...request, day: '2026-10-06', question: { ...request.question, day: '2026-10-06' } }, false)).rejects.toThrow('2026-10-06 is not over yet (UTC).')
  })
})
