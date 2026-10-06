import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewsReading, ReviewVerdict, WhyConclusion } from '../shared/aiAdditions'
import type { MarketEvent } from '../shared/marketEvent'
import type { AiWatchConfig } from '../shared/aiWatch'
import type { Candle } from '../shared/ipc'
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
const ON: AiWatchConfig = { enabled: true, models: [A], maxEventsPerDay: 5, minBand: 'urgent', firstModelGates: false }
const READING: NewsReading = { ticker: 'SOL', relationship: 'DIRECT', direction: 'up', impact: 72, horizon: '4h', confidence: 0.7, pricedIn: false, reasons: 'A large listing.' }
const CONCLUSION: WhyConclusion = { conclusion: 'The futures listing drew buyers, on three times the usual volume.', cites: ['story:a'], confidence: 0.6 }
const VERDICT: ReviewVerdict = { verdict: 'REJECT', confidence: 0.7, reason: 'Another model sells it, and the move is overextended.' }

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
    const { status = 200, content = JSON.stringify(asked === 'why_conclusion' ? CONCLUSION : asked === 'review_verdict' ? VERDICT : READING) } = await reply(bodies.length)
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

  it('is not asked switched off, or once the daily budget is spent', async () => {
    const { bodies } = stubOpenRouter()
    const { analyseStory, setAiConfig } = await services()
    await setAiConfig({ watch: ON, additions: { news: false } })
    expect(await analyseStory(story('a'), true)).toEqual({ status: 'skipped', reason: 'The news analyst is switched off under Settings › AI.' })
    await setAiConfig({ additions: { news: true }, dailyCapUsd: 0 })
    const outcome = await analyseStory(story('a'), true)
    expect(outcome.status).toBe('skipped')
    expect(bodies).toHaveLength(0)
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
    feed.stories = [story('a')]
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
    feed.stories = [story('a')]
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
    feed.stories = [story('a')]
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
    feed.stories = [story('a')]
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

describe('what Settings › AI shows', () => {
  it("says each addition's switch, what it asked today, and what a call costs", async () => {
    stubOpenRouter()
    const { getAiAdditionsStatus, analyseStory, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    expect(await getAiAdditionsStatus()).toEqual({
      model: A,
      watchOn: true,
      additions: { news: true, why: true, review: true },
      limits: { news: 40, why: 20, review: 20 },
      today: { news: 0, why: 0, review: 0 },
      perCall: { news: { usd: null, basis: 'unknown' }, why: { usd: null, basis: 'unknown' }, review: { usd: null, basis: 'unknown' } }
    })
    await analyseStory(story('a'), true)
    expect(await getAiAdditionsStatus()).toMatchObject({ today: { news: 1, why: 0, review: 0 }, perCall: { news: { usd: 0.001, basis: 'history' } } })
  })
})
