import { beforeEach, describe, expect, it } from 'vitest'
import { describeAiOpportunityCost } from '../shared/aiCost'
import { MARKET_BARS_15M, MARKET_BARS_1M } from '../shared/aiEventMarket'
import type { AiCallRecord } from '../shared/aiLedger'
import { AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION } from '../shared/aiOpportunity'
import type { AiSignalDecision, AiSignalDetail } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'
import { EVENT_LOOKBACK_BARS, type MarketEvent } from '../shared/marketEvent'
import {
  askModels,
  assembleFeed,
  clearSettledFeedBars,
  decisionOfCall,
  feedItemHorizonSeconds,
  fetchEventQuestion,
  loadFeedBars,
  scoreAnswer,
  type CandleFetch
} from '../src/agents/opportunities'

const T = Date.parse('2026-09-10T12:07:00Z') / 1000

function event(symbol = 'SOLUSDT', time = T, overrides: Partial<MarketEvent> = {}): MarketEvent {
  return {
    id: `binance:${symbol}:${time}`,
    exchange: 'binance',
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    time,
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
    live: { detectedAt: time + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 },
    ...overrides
  }
}

const LONG: AiSignalDetail = {
  marketRegime: 'bull',
  riskLevel: 'medium',
  horizonBars: 4,
  stopLoss: 98.5,
  takeProfit: 103,
  reasonCodes: ['breakout'],
  levelsNote: null,
  entry: { min: 99.8, max: 100.2, validMinutes: 15 }
}

function call(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    id: 'key',
    at: T + 25,
    source: 'opportunity',
    status: 'ok',
    model: 'openai/gpt-5-mini',
    provider: 'OpenAI',
    promptVersion: AI_OPPORTUNITY_PROMPT_VERSION,
    contextVersion: 'context-v1',
    schemaVersion: AI_OPPORTUNITY_SCHEMA_VERSION,
    exchange: 'binance',
    symbol: 'SOLUSDT',
    interval: '15m',
    candleTime: T,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.003, latencyMs: 14_000 },
    error: null,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range on volume.',
    detail: LONG,
    eventId: `binance:SOLUSDT:${T}`,
    eventType: 'breakout',
    ...overrides
  }
}

describe('fetchEventQuestion', () => {
  it('asks for the twelve hours of minutes and seven days of quarter hours that end at the event', async () => {
    const asked: { interval: string; startSec: number; endSec: number }[] = []
    const fetch: CandleFetch = async (_exchange, _symbol, interval, startSec, endSec) => {
      asked.push({ interval, startSec, endSec })
      return []
    }
    await fetchEventQuestion(event(), fetch)
    // The event is at 12:07; the last quarter hour to have closed did so at 12:00.
    const boundary = Date.parse('2026-09-10T12:00:00Z') / 1000
    expect(asked.sort((a, b) => a.interval.localeCompare(b.interval))).toEqual([
      { interval: '15m', startSec: boundary - 672 * 900, endSec: boundary },
      { interval: '1m', startSec: T - EVENT_LOOKBACK_BARS * 60, endSec: T }
    ])
  })

  it('cuts off the bar an exchange returns for the end of the range: the first candle of the future', async () => {
    const bar = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })
    const fetch: CandleFetch = async (_exchange, _symbol, interval, startSec, endSec) => {
      const step = interval === '1m' ? 60 : 900
      const out: Candle[] = []
      // Inclusive of the end, as Binance's endTime is.
      for (let time = startSec; time <= endSec; time += step) out.push(bar(time))
      return out
    }
    const question = await fetchEventQuestion(event(), fetch)
    expect(question.candles1m).toHaveLength(EVENT_LOOKBACK_BARS)
    expect(question.candles1m[question.candles1m.length - 1].time).toBe(T - 60)
    expect(question.candles15m).toHaveLength(672)
    expect(question.candles15m[question.candles15m.length - 1].time + 900).toBeLessThanOrEqual(T)
    // The question about the pair alone carries no market.
    expect('reference' in question).toBe(false)
  })

  it("with the market, also reads Bitcoin's and ether's four hours of minutes and day of quarter hours, cut at the same minute", async () => {
    const asked: { symbol: string; interval: string; startSec: number; endSec: number }[] = []
    const bar = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })
    const fetch: CandleFetch = async (_exchange, symbol, interval, startSec, endSec) => {
      asked.push({ symbol, interval, startSec, endSec })
      const step = interval === '1m' ? 60 : 900
      const out: Candle[] = []
      for (let time = startSec; time <= endSec; time += step) out.push(bar(time))
      return out
    }
    const question = await fetchEventQuestion(event(), fetch, { market: true })
    const boundary = Date.parse('2026-09-10T12:00:00Z') / 1000
    expect(asked.filter((entry) => entry.symbol !== 'SOLUSDT').sort((a, b) => (a.symbol + a.interval).localeCompare(b.symbol + b.interval))).toEqual([
      { symbol: 'BTCUSDT', interval: '15m', startSec: boundary - MARKET_BARS_15M * 900, endSec: boundary },
      { symbol: 'BTCUSDT', interval: '1m', startSec: T - MARKET_BARS_1M * 60, endSec: T },
      { symbol: 'ETHUSDT', interval: '15m', startSec: boundary - MARKET_BARS_15M * 900, endSec: boundary },
      { symbol: 'ETHUSDT', interval: '1m', startSec: T - MARKET_BARS_1M * 60, endSec: T }
    ])
    for (const market of [question.reference?.btc, question.reference?.eth]) {
      expect(market?.candles1m).toHaveLength(MARKET_BARS_1M)
      expect(market?.candles1m[MARKET_BARS_1M - 1].time).toBe(T - 60)
      expect(market?.candles15m).toHaveLength(MARKET_BARS_15M)
      expect((market?.candles15m[MARKET_BARS_15M - 1].time ?? Infinity) + 900).toBeLessThanOrEqual(T)
    }
    // And the pair's own candles are what they are without the market.
    expect(question.candles1m).toEqual((await fetchEventQuestion(event(), fetch)).candles1m)
  })
})

describe('assembleFeed', () => {
  it('puts each answer on its event, with the moment it arrived', () => {
    const feed = assembleFeed(
      [event(), event('ADAUSDT', T + 600)],
      [call(), call({ model: 'mistralai/mistral-small-2603', at: T + 12, recommendation: 'hold', detail: { ...LONG, stopLoss: null, takeProfit: null, entry: null } })]
    )
    expect(feed.map((item) => item.event.symbol)).toEqual(['SOLUSDT', 'ADAUSDT'])
    expect(feed[0].answers.map((answer) => [answer.model, answer.answeredAt])).toEqual([
      ['mistralai/mistral-small-2603', T + 12],
      ['openai/gpt-5-mini', T + 25]
    ])
    expect(feed[1].answers).toEqual([])
  })

  it('keeps a refused answer, as refused, and leaves out a call that never reached a model', () => {
    const feed = assembleFeed([event()], [call({ status: 'rejected', error: 'The stop is not below the entry range', recommendation: null, confidence: null, detail: null }), call({ model: 'x/down', status: 'failed', error: '503' })])
    expect(feed[0].answers).toHaveLength(1)
    expect(feed[0].answers[0].decision).toMatchObject({ recommendation: 'hold', rejected: 'The stop is not below the entry range', error: null, detail: null })
  })

  it('keeps one answer a model, the first it gave, and ignores rows that are about no event', () => {
    const feed = assembleFeed([event()], [call({ at: T + 400, confidence: 0.5 }), call({ at: T + 25, confidence: 0.8 }), call({ eventId: undefined, model: 'other/model' })])
    expect(feed[0].answers).toHaveLength(1)
    expect(feed[0].answers[0].decision.confidence).toBe(0.8)
  })

  it('reads a row back as the decision it recorded', () => {
    expect(decisionOfCall(call())).toMatchObject({ candleTime: T, recommendation: 'buy', confidence: 0.8, model: 'openai/gpt-5-mini', cached: true, error: null, rejected: null, detail: LONG })
  })
})

describe('scoring the feed', () => {
  beforeEach(() => clearSettledFeedBars())

  const item = assembleFeed([event()], [call()])[0]
  /** Flat at 100 for a minute after the event, then a rise to the target in the sixth minute. */
  const rising: Candle[] = Array.from({ length: 80 }, (_, n) => ({ time: T + n * 60, open: 100, high: n === 6 ? 103.5 : 100.05, low: 99.95, close: n === 6 ? 103.2 : 100, volume: 1 }))

  it('needs candles for as long as a recommendation can still change, and none for no trade', () => {
    // Fifteen minutes to enter, an hour to hold, a minute to spare.
    expect(feedItemHorizonSeconds(item)).toBe(15 * 60 + 4 * 900 + 60)
    const none = assembleFeed([event()], [call({ recommendation: 'hold', detail: { ...LONG, stopLoss: null, takeProfit: null, entry: null } })])[0]
    expect(feedItemHorizonSeconds(none)).toBe(0)
    expect(scoreAnswer(none, none.answers[0], rising, T + 100_000)).toBeNull()
  })

  it('enters only after the answer arrived, and pays this pair its own slippage', () => {
    const outcome = scoreAnswer(item, item.answers[0], rising, T + 100_000)
    // Answered 25 seconds after the event: the first usable minute opens at T + 60.
    expect(outcome).toMatchObject({ status: 'closed', entryTime: T + 60, exit: 'take_profit', exitPrice: 103 })
    // 80 million a day is a deep pair: the app's usual 0.02% on the entry.
    expect(outcome?.entryPrice).toBeCloseTo(100 * 1.0002, 8)
    const thin = { ...item, event: event('SOLUSDT', T, { live: { detectedAt: T + 8, quoteVolume24h: 2_000_000, spreadPct: 0.1, candidateScore: 70, rank: 1 } }) }
    expect(scoreAnswer(thin, thin.answers[0], rising, T + 100_000)?.entryPrice).toBeCloseTo(100 * 1.001, 8)
  })

  it('fetches one stretch an event, only for events with a trade on them, and stops once it is settled', async () => {
    const asked: { symbol: string; startSec: number; endSec: number }[] = []
    const fetch: CandleFetch = async (_exchange, symbol, _interval, startSec, endSec) => {
      asked.push({ symbol, startSec, endSec })
      return rising
    }
    const quietEvent = assembleFeed([event('ADAUSDT', T)], [])[0]
    const early = await loadFeedBars([item, quietEvent], T + 600, fetch)
    expect(asked).toEqual([{ symbol: 'SOLUSDT', startSec: T, endSec: T + 600 }])
    expect(early.get(item.event.id)).toBe(rising)
    expect(early.has(quietEvent.event.id)).toBe(false)

    // Long after: asked once more, to the end of its window, and then never again.
    await loadFeedBars([item], T + 100_000, fetch)
    await loadFeedBars([item], T + 200_000, fetch)
    expect(asked).toHaveLength(2)
    expect(asked[1]).toEqual({ symbol: 'SOLUSDT', startSec: T, endSec: T + feedItemHorizonSeconds(item) })
  })

  it('shows a trade as waiting, not missing, when its candles could not be fetched', async () => {
    const bars = await loadFeedBars([item], T + 600, async () => {
      throw new Error('exchange down')
    })
    expect(bars.get(item.event.id)).toEqual([])
    expect(scoreAnswer(item, item.answers[0], [], T + 600)?.status).toBe('waiting')
  })
})

describe('askModels', () => {
  const answered = (model: string, overrides: Partial<AiSignalDecision> = {}): AiSignalDecision => ({
    candleTime: T,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: '',
    model,
    cached: false,
    error: null,
    rejected: null,
    detail: LONG,
    usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.003, latencyMs: 1000 },
    ...overrides
  })

  it('asks every model at once, and each on its own', async () => {
    let inAir = 0
    let most = 0
    const result = await askModels(['a/one', 'b/two', 'c/three'], async (model) => {
      inAir++
      most = Math.max(most, inAir)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inAir--
      return answered(model)
    })
    expect(most).toBe(3)
    expect(result.results.map((entry) => entry.model)).toEqual(['a/one', 'b/two', 'c/three'])
    expect(result.results.every((entry) => entry.decision !== null && entry.problem === null)).toBe(true)
    expect(result.costUsd).toBeCloseTo(0.009, 10)
  })

  it('lets the others answer when one is refused or not reached, and says which', async () => {
    const result = await askModels(['a/one', 'b/two', 'c/three'], async (model) => {
      if (model === 'b/two') throw new Error("Error invoking remote method 'ai:askOpportunity': Error: Today's AI budget is used up")
      if (model === 'c/three') return answered(model, { error: 'OpenRouter 503' })
      return answered(model)
    })
    expect(result.results[0].decision).not.toBeNull()
    expect(result.results[1]).toMatchObject({ decision: null, problem: "Today's AI budget is used up" })
    expect(result.results[2]).toMatchObject({ decision: null, problem: 'OpenRouter 503' })
    expect(result.costUsd).toBeCloseTo(0.003, 10)
  })

  it('counts nothing for an answer that was already held', async () => {
    const result = await askModels(['a/one'], async (model) => answered(model, { cached: true }))
    expect(result.costUsd).toBe(0)
  })
})

describe('describeAiOpportunityCost', () => {
  const model = (name: string, overrides: object = {}) => ({ model: name, held: false, perCallCostUsd: 0.0033, costBasis: 'history' as const, perCallLatencyMs: 13_000, ...overrides })

  it('prices each call on its own line, and takes the slowest model as the wait', () => {
    const text = describeAiOpportunityCost({
      symbol: 'SOLUSDT',
      event: 'breakout',
      models: [model('openai/gpt-5-mini'), model('mistralai/mistral-small-2603', { perCallCostUsd: 0.0007, perCallLatencyMs: 2000 }), model('openai/gpt-5-mini@low', { held: true })],
      budgetRemainingUsd: 0.93
    })
    expect(text).toContain('Ask 3 models about the breakout on SOLUSDT through OpenRouter.')
    expect(text).toContain('1 has already answered and is not asked again.')
    expect(text).toContain('2 calls will be made:')
    expect(text).toContain('openai/gpt-5-mini: about $0.0033 going by its recent calls here')
    expect(text).toContain('About $0.004 in all.')
    expect(text).toContain('that takes about 13 seconds: as long as the slowest of them')
    expect(text).toContain("$0.93 of today's AI budget is left.")
    expect(text.trim().endsWith('Continue?')).toBe(true)
  })

  it('says what it does not know rather than leaving it out', () => {
    const text = describeAiOpportunityCost({
      symbol: 'SOLUSDT',
      event: 'breakdown',
      models: [model('new/model', { perCallCostUsd: null, costBasis: 'unknown', perCallLatencyMs: null })],
      budgetRemainingUsd: 1
    })
    expect(text).toContain('Ask 1 model about the breakdown')
    expect(text).toContain('1 call will be made:')
    expect(text).toContain('cost not known')
    expect(text).toContain('What that will cost in all is not known.')
    expect(text).toContain('How long that takes is not known')
  })

  it('says outright when the budget will not cover it', () => {
    const text = describeAiOpportunityCost({ symbol: 'SOLUSDT', event: 'breakout', models: [model('openai/gpt-5-mini')], budgetRemainingUsd: 0.001 })
    expect(text).toContain('which is less than that')
    expect(text).toContain('That takes about 13 seconds at the pace it has answered here.')
  })
})
