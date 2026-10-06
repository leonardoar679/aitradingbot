import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewsReading } from '../shared/aiAdditions'
import type { AiWatchConfig } from '../shared/aiWatch'
import type { NewsFeedState, ReadStory } from '../shared/newsFeed'

// electron/services/aiAdditionsService.ts: the AI additions' calls where the money is spent, with the
// network faked and everything else real -- the setting, the ledger, the cache, the budget.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' })
}))
const feed = vi.hoisted(() => ({ listener: null as ((state: NewsFeedState) => void) | null }))
vi.mock('../electron/services/newsFeedService', () => ({
  onNewsFeedUpdate: (listener: (state: NewsFeedState) => void) => {
    feed.listener = listener
    return () => undefined
  }
}))

const A = 'openai/gpt-5-mini'
const NOW = Date.parse('2026-10-06T12:00:00Z') / 1000
const ON: AiWatchConfig = { enabled: true, models: [A], maxEventsPerDay: 5, minBand: 'urgent', firstModelGates: false }
const READING: NewsReading = { ticker: 'SOL', relationship: 'DIRECT', direction: 'up', impact: 72, horizon: '4h', confidence: 0.7, pricedIn: false, reasons: 'A large listing.' }

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
    const { status = 200, content = JSON.stringify(READING) } = await reply(bodies.length)
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

describe('what Settings › AI shows', () => {
  it("says each addition's switch, what it asked today, and what a call costs", async () => {
    stubOpenRouter()
    const { getAiAdditionsStatus, analyseStory, setAiConfig } = await services()
    await setAiConfig({ watch: ON })
    expect(await getAiAdditionsStatus()).toEqual({
      model: A,
      watchOn: true,
      additions: { news: true },
      limits: { news: 40 },
      today: { news: 0 },
      perCall: { news: { usd: null, basis: 'unknown' } }
    })
    await analyseStory(story('a'), true)
    expect(await getAiAdditionsStatus()).toMatchObject({ today: { news: 1 }, perCall: { news: { usd: 0.001, basis: 'history' } } })
  })
})
