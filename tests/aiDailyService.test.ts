import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AI_ADDITION_INFO, AI_ADDITION_PROMPT_VERSIONS, AI_ADDITION_SCHEMA_VERSIONS, AI_DAILY_LINES, DEFAULT_AI_ADDITIONS, validateDailyDirection, type AiAdditionOutcome, type DailyDirectionAnswer, type DailyDirectionQuestion } from '../shared/aiAdditions'
import type { SourcePrediction } from '../shared/evaluation/predictionRecord'
import { AI_ADDITION_SCHEMAS, AI_ADDITION_SYSTEM_PROMPTS, buildAdditionMessages } from '../electron/services/aiAdditionPrompts'

// THE DAILY DIRECTION TEST (electron/services/aiDailyService.ts; V10 Stage 7, judged by V10-AI-FORWARD): once a UTC day,
// a little after it opens, one question to the deciding model on ten coins fixed when it first asks; its own dollar a
// day before anything is asked; a fresh answer's calls recorded as the source 'ai-daily', each at its coin's price;
// nothing it is shown from after the question; nothing traded.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/aiAdditionsService', () => ({ askAddition: async () => ({ status: 'skipped', reason: 'not in this test' }), additionCacheKey: (kind: string, model: string) => `${kind}:${model}:key` }))
vi.mock('../electron/services/aiLedgerService', () => ({ listAiCalls: async () => ({ rows: [] }) }))
vi.mock('../electron/services/effectiveConfigService', () => ({ getEffectiveConfig: async () => ({ engineVersion: 'e1', configVersion: 'c1' }) }))
// The live forecasts as forecastService gives them, in the pairs' alphabetical order, and the universe most traded first.
const live = vi.hoisted(() => ({ forecasts: [] as { pair: string; currentPrice: number; horizons: { hours24?: { quantilesPct: number[] } } }[], universe: [] as string[] }))
vi.mock('../electron/services/forecastService', () => ({ latestForecasts: () => [...live.forecasts].sort((a, b) => a.pair.localeCompare(b.pair)) }))
vi.mock('../electron/services/forecastDataService', () => ({ forecastUniverse: () => [...live.universe] }))
vi.mock('../electron/services/newsFeedService', () => ({ getNewsFeedState: () => ({ stories: [] }) }))
vi.mock('../electron/services/predictionLedgerService', () => ({ recordSourcePrediction: async () => undefined }))

const DAY = 86_400
const T0 = Date.UTC(2026, 10, 20) / 1000
const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'TRXUSDT', 'LINKUSDT', 'AVAXUSDT', 'SUIUSDT', 'TONUSDT']

type Ask = { kind: string; subjectId: string; automatic: boolean; payload: DailyDirectionQuestion; validate: (value: unknown) => { ok: boolean } }

/** Daily closes for each pair from 60 days before T0 to 10 days after: the day's own close included where it is past. */
function closes(pairs: readonly string[], short: string | null = null): Map<string, { time: number; close: number }[]> {
  return new Map(
    pairs.map((pair, index) => {
      const from = pair === short ? T0 - 12 * DAY : T0 - 60 * DAY
      const rows: { time: number; close: number }[] = []
      for (let time = from; time <= T0 + 10 * DAY; time += DAY) rows.push({ time, close: 100 + index + (time - T0) / DAY })
      return [pair, rows]
    })
  )
}

async function setup(answer: (question: DailyDirectionQuestion) => AiAdditionOutcome<DailyDirectionAnswer> = (question) => ({
  status: 'answered',
  cached: false,
  model: 'anthropic/claude-opus-5.5',
  answer: { calls: question.coins.map((coin, index) => ({ pair: coin.pair, way: index % 3 === 0 ? 'down' : 'up', confidence: 0.6 })) }
})) {
  vi.resetModules()
  const service = await import('../electron/services/aiDailyService')
  service.resetAiDaily()
  const dir = mkdtempSync(join(tmpdir(), 'ai-daily-'))
  const clock = { now: T0 + 10 * 60 }
  const asked: Ask[] = []
  const recorded: SourcePrediction[] = []
  const state = { order: [...PAIRS], spent: 0, short: null as string | null, stories: [] as { title: string; source: string; publishedAt: number }[], answer }
  service.aiDailySeam.dir = () => dir
  service.aiDailySeam.nowSec = () => clock.now
  service.aiDailySeam.forecasts = () => state.order.map((pair, index) => ({ pair, price: 50 + index, expectedMove24hPct: 3 + index / 10 }))
  service.aiDailySeam.closes = async () => closes(PAIRS, state.short)
  service.aiDailySeam.headlines = () => state.stories
  service.aiDailySeam.spentToday = async () => state.spent
  service.aiDailySeam.ask = (async (input: Ask) => {
    asked.push(input)
    return state.answer(input.payload)
  }) as never
  service.aiDailySeam.record = async (prediction) => {
    recorded.push(prediction)
    return true as never
  }
  service.aiDailySeam.versions = async () => ({ engine: 'e1', config: 'c1' })
  return { service, dir, clock, asked, recorded, state }
}

describe('when it asks', () => {
  it('asks once a UTC day, from five minutes after the day opens, and again the next day', async () => {
    const { service, clock, asked } = await setup()
    clock.now = T0 + 4 * 60
    await service.aiDailyTurn()
    expect(asked).toHaveLength(0)
    clock.now = T0 + AI_DAILY_LINES.askAfterSec
    await service.aiDailyTurn()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'direction', subjectId: '2026-11-20', automatic: true })
    clock.now = T0 + 20 * 3600
    await service.aiDailyTurn()
    expect(asked).toHaveLength(1)
    clock.now = T0 + DAY + 10 * 60
    await service.aiDailyTurn()
    expect(asked).toHaveLength(2)
    expect(asked[1].subjectId).toBe('2026-11-21')
  })

  it('keeps the day asked across a restart (aiDaily.json)', async () => {
    const first = await setup()
    await first.service.aiDailyTurn()
    expect(first.asked).toHaveLength(1)
    const saved = JSON.parse(readFileSync(join(first.dir, 'aiDaily.json'), 'utf-8')) as { lastDay: number; coins: string[] }
    expect(saved.lastDay).toBe(T0)
    first.service.resetAiDaily()
    first.clock.now = T0 + 3 * 3600
    await first.service.aiDailyTurn()
    expect(first.asked).toHaveLength(1)
  })

  it('asks nothing once the day has spent its dollar, and says so', async () => {
    const { service, asked, state } = await setup()
    state.spent = AI_DAILY_LINES.dailyCapUsd
    await service.aiDailyTurn()
    expect(asked).toHaveLength(0)
    expect(service.aiDailyNote()).toContain('dollar a day')
    state.spent = 0.04
    await service.aiDailyTurn()
    expect(asked).toHaveLength(1)
  })

  it('asks again later the same day when the addition skipped it (switched off, the watch off), and not after a failure', async () => {
    const { service, clock, asked, recorded, state } = await setup(() => ({ status: 'skipped', reason: 'The daily direction test is switched off.' }))
    await service.aiDailyTurn()
    expect(asked).toHaveLength(1)
    expect(service.aiDailyNote()).toBe('The daily direction test is switched off.')
    clock.now += 600
    state.answer = () => ({ status: 'failed', reason: 'timed out' })
    await service.aiDailyTurn()
    expect(asked).toHaveLength(2)
    clock.now += 600
    await service.aiDailyTurn()
    expect(asked).toHaveLength(2)
    expect(recorded).toEqual([])
  })
})

describe('what it asks about', () => {
  it("reads the forecast's coins most traded first, not by name, each with its price and its day's expected move", async () => {
    vi.resetModules()
    const { aiDailySeam, mostTradedFirst } = await import('../electron/services/aiDailyService')
    live.universe = [...PAIRS]
    live.forecasts = PAIRS.map((pair, index) => ({ pair, currentPrice: 10 + index, horizons: { hours24: { quantilesPct: [-4, -1.5, 0, 1.5, 4] } } }))
    live.forecasts.push({ pair: 'AAVEUSDT', currentPrice: 1, horizons: {} })
    const read = aiDailySeam.forecasts()
    expect(read.map((entry) => entry.pair)).toEqual([...PAIRS, 'AAVEUSDT'])
    expect(read[0]).toEqual({ pair: 'BTCUSDT', price: 10, expectedMove24hPct: read[0].expectedMove24hPct })
    expect(read[0].expectedMove24hPct).toBeGreaterThan(1)
    expect(read[read.length - 1].expectedMove24hPct).toBeNull()
    expect(mostTradedFirst([{ pair: 'B' }, { pair: 'Z' }, { pair: 'A' }], ['A', 'B']).map((entry) => entry.pair)).toEqual(['A', 'B', 'Z'])
  })

  it("asks about the forecast's ten most traded when it first asks, and keeps them", async () => {
    const { service, clock, asked, state } = await setup()
    await service.aiDailyTurn()
    expect(asked[0].payload.coins.map((coin) => coin.pair)).toEqual(PAIRS.slice(0, AI_DAILY_LINES.coins))
    state.order = [...PAIRS].reverse()
    clock.now = T0 + DAY + 10 * 60
    await service.aiDailyTurn()
    expect(asked[1].payload.coins.map((coin) => coin.pair)).toEqual(PAIRS.slice(0, AI_DAILY_LINES.coins))
  })

  it("shows each coin its last thirty closes before the day, never the day's own, and its expected move", async () => {
    const { service, asked } = await setup()
    await service.aiDailyTurn()
    const btc = asked[0].payload.coins[0]
    expect(btc.closes).toHaveLength(AI_DAILY_LINES.closes)
    // The last close shown is the day before's: the day in progress, and every day after, are not.
    expect(btc.closes[btc.closes.length - 1]).toBe(100 - 1)
    expect(btc.closes[0]).toBe(100 - 30)
    expect(btc.expectedMove24hPct).toBe(3)
  })

  it('leaves out a coin without thirty closes, and asks nothing when none has them', async () => {
    const { service, asked, state } = await setup()
    state.short = 'ETHUSDT'
    await service.aiDailyTurn()
    expect(asked[0].payload.coins.map((coin) => coin.pair)).not.toContain('ETHUSDT')
    expect(asked[0].payload.coins).toHaveLength(AI_DAILY_LINES.coins - 1)
    const question = service.dailyDirectionQuestionOf(['ETHUSDT'], T0, T0 + 600, closes(PAIRS, 'ETHUSDT'), [], [])
    expect(question).toBeNull()
  })

  it('shows the latest headlines published before it asks, cut to their length, with their age in hours', async () => {
    const { service, asked, state } = await setup()
    state.stories = [
      { title: 'A future story', source: 'Later', publishedAt: T0 + 3600 },
      { title: 'x'.repeat(400), source: 'CoinDesk', publishedAt: T0 - 3 * 3600 },
      ...Array.from({ length: 30 }, (_, index) => ({ title: `Story ${index}`, source: 'Feed', publishedAt: T0 - (4 + index) * 3600 }))
    ]
    await service.aiDailyTurn()
    const headlines = asked[0].payload.headlines
    expect(headlines).toHaveLength(AI_DAILY_LINES.headlines)
    expect(headlines.some((story) => story.source === 'Later')).toBe(false)
    expect(headlines[0]).toEqual({ title: 'x'.repeat(AI_DAILY_LINES.headlineChars), source: 'CoinDesk', hoursAgo: 3 })
  })
})

describe('what it records', () => {
  it("records a fresh answer's calls as the source ai-daily, each a day's way at its coin's price, scored like every source", async () => {
    const { service, recorded, clock } = await setup()
    await service.aiDailyTurn()
    expect(recorded).toHaveLength(AI_DAILY_LINES.coins)
    const first = recorded[0]
    expect(first).toMatchObject({
      source: 'ai-daily',
      sourceVersion: 'daily-direction-v1@anthropic/claude-opus-5.5',
      kind: 'direction',
      pair: 'BTCUSDT',
      venue: 'binance',
      madeAt: clock.now,
      horizonSec: DAY,
      refPrice: 50,
      side: 'down',
      movePct: null,
      dist: { pRight: 0.6, q: null, pMove: null },
      cost: { roundTripPct: AI_DAILY_LINES.roundTripPct, basis: 'flat', stakeQuote: 0 },
      unit: Math.floor(clock.now / DAY),
      versions: { engine: 'e1', config: 'c1' }
    })
    expect(recorded[1]).toMatchObject({ pair: 'ETHUSDT', side: 'up', refPrice: 51 })
    expect(new Set(recorded.map((entry) => entry.id)).size).toBe(recorded.length)
  })

  it('records nothing for an answer from the cache, or a refusal', async () => {
    const cached = await setup((question) => ({ status: 'answered', cached: true, model: 'm', answer: { calls: question.coins.map((coin) => ({ pair: coin.pair, way: 'up', confidence: 0.6 })) } }))
    await cached.service.aiDailyTurn()
    expect(cached.recorded).toEqual([])
    const refused = await setup(() => ({ status: 'refused', reason: 'a call on a coin not asked about', cached: false, model: 'm' }))
    await refused.service.aiDailyTurn()
    expect(refused.recorded).toEqual([])
  })

  it('checks the answer against the question: every coin once, up or down, a confidence from 0.5 to 1', async () => {
    const { service, asked } = await setup()
    await service.aiDailyTurn()
    const { validate, payload } = asked[0]
    const good = payload.coins.map((coin) => ({ pair: coin.pair, way: 'up', confidence: 0.5 }))
    expect(validate({ calls: good }).ok).toBe(true)
    expect(validate({ calls: good.slice(1) }).ok).toBe(false)
    expect(validate({ calls: [...good, good[0]] }).ok).toBe(false)
    expect(validate({ calls: [{ ...good[0], pair: 'PEPEUSDT' }, ...good.slice(1)] }).ok).toBe(false)
    expect(validate({ calls: [{ ...good[0], way: 'none' }, ...good.slice(1)] }).ok).toBe(false)
    expect(validate({ calls: [{ ...good[0], confidence: 0.49 }, ...good.slice(1)] }).ok).toBe(false)
    expect(validate({ calls: [{ ...good[0], confidence: 1.01 }, ...good.slice(1)] }).ok).toBe(false)
    expect(validateDailyDirection(null, payload).ok).toBe(false)
  })
})

describe('the test, pinned', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
  it('ships off, asks the deciding model by itself while the watch is on, one call a day', () => {
    expect(DEFAULT_AI_ADDITIONS.direction).toBe(false)
    expect(AI_ADDITION_INFO.direction.automatic).toBe(true)
    expect(AI_DAILY_LINES).toEqual({ coins: 10, closes: 30, headlines: 20, headlineChars: 160, horizonSec: 86_400, askAfterSec: 300, dailyCapUsd: 1, roundTripPct: 0.24 })
  })

  it("pins the test's prompt and schema, which name no trade", () => {
    expect([AI_ADDITION_PROMPT_VERSIONS.direction, sha(AI_ADDITION_SYSTEM_PROMPTS.direction)]).toEqual(['daily-direction-v1', 'fd74a4ae18ee3c005eb0ddf99be828b4af585b45fef5b4f15d13b3e13418423f'])
    expect([AI_ADDITION_SCHEMA_VERSIONS.direction, sha(JSON.stringify(AI_ADDITION_SCHEMAS.direction))]).toEqual(['daily-direction-v1', '0e1984b566054a71aeaa2a0bfb29fda120662667bf52c3a85021305a5aa9241e'])
    expect(AI_ADDITION_SCHEMAS.direction.name).toBe('daily_direction')
    expect(JSON.stringify(AI_ADDITION_SCHEMAS.direction)).not.toMatch(/side|entry|stop|target|leverage|size|amount/i)
    const question = { day: '2026-11-20', askedAt: T0, coins: [{ pair: 'BTCUSDT', closes: [1, 2], expectedMove24hPct: 3 }], headlines: [] }
    const [system, user] = buildAdditionMessages('direction', question)
    expect(system).toEqual({ role: 'system', content: AI_ADDITION_SYSTEM_PROMPTS.direction })
    expect(JSON.parse(user.content)).toEqual(question)
  })
})
