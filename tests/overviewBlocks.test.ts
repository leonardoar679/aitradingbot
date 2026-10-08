import { describe, expect, it } from 'vitest'
import type { AiSignalDecision, AiSignalDetail } from '../shared/aiSignal'
import type { ExecutorConfig } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import type { NewsReading } from '../shared/aiAdditions'
import type { ReadStory, StoryReaction } from '../shared/newsFeed'
import type { EventFeedItem } from '../src/agents/opportunities'
import type { AlertRecord } from '../src/news/alertStore'
import { BREAKING_SHOWN, breakingEvents, describeAnswers, describeReaction, describeTally, majorAlerts, newsImpact, tallyAnswers, todaysPaper } from '../src/overview/overviewBlocks'

// Overview's blocks (the second V3 document, §51): the last hour's events, the news that matters,
// and what the app's own paper trades did today, each a selection over what is on file.

const T = Date.parse('2026-10-08T09:00:00Z') / 1000

function event(over: Partial<MarketEvent> = {}): MarketEvent {
  return {
    id: `binance:SOLUSDT:${over.time ?? T - 300}`,
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    time: T - 300,
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
    live: { detectedAt: T - 292, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 },
    ...over
  }
}

const LONG: AiSignalDetail = { marketRegime: 'bull', riskLevel: 'medium', horizonBars: 4, stopLoss: 98.5, takeProfit: 103, reasonCodes: ['breakout'], levelsNote: null, entry: { min: 99.8, max: 100.2, validMinutes: 15 } }

function decision(over: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime: T - 300,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range on volume.',
    model: 'openai/gpt-5-mini',
    cached: false,
    error: null,
    rejected: null,
    detail: LONG,
    usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 1000 },
    ...over
  }
}

const item = (over: Partial<MarketEvent> = {}, answers: AiSignalDecision[] = []): EventFeedItem => ({
  event: event(over),
  answers: answers.map((entry, index) => ({ model: `${entry.model}:${index}`, decision: entry, answeredAt: T - 280 }))
})

describe('breaking events', () => {
  it("lists the last hour's events at candidate or above, strongest first, and no more than shown", () => {
    const feed = [
      item({ id: 'old', time: T - 3601, score: 99 }),
      item({ id: 'watch', time: T - 60, band: 'watch', score: 70 }),
      item({ id: 'candidate', time: T - 120, band: 'candidate', score: 80 }),
      item({ id: 'urgent', time: T - 180, score: 91 }),
      item({ id: 'future', time: T + 1, score: 95 })
    ]
    expect(breakingEvents(feed, T).map((entry) => entry.event.id)).toEqual(['urgent', 'candidate'])
    const many = Array.from({ length: BREAKING_SHOWN + 3 }, (_, index) => item({ id: `e${index}`, time: T - 10 - index, score: 80 + index }))
    expect(breakingEvents(many, T)).toHaveLength(BREAKING_SHOWN)
    expect(breakingEvents(many, T)[0].event.id).toBe(`e${BREAKING_SHOWN + 2}`)
  })

  it('counts what the models said, by side, and says it in a few words', () => {
    const answers = [decision(), decision({ model: 'b' }), decision({ model: 'c', recommendation: 'hold', confidence: 0.4 }), decision({ model: 'd', rejected: 'bad shape' })]
    const tally = tallyAnswers(item({}, answers).answers)
    expect(tally).toEqual({ long: 2, short: 0, none: 1, refused: 1 })
    expect(describeTally(tally)).toBe('2 BUY, 1 NO TRADE, 1 refused')
    expect(describeTally(tallyAnswers([]))).toBe('no answer yet')
  })

  it('keeps the alerts at HIGH or above', () => {
    const alert = (severity: AlertRecord['severity'], id: string): AlertRecord => ({ id, severity, title: id, body: '', at: T, seen: false, dismissed: false })
    expect(majorAlerts([alert('info', 'a'), alert('watch', 'b'), alert('high', 'c'), alert('critical', 'd')]).map((entry) => entry.id)).toEqual(['c', 'd'])
  })
})

describe('news impact', () => {
  const story = (over: Partial<ReadStory> = {}): ReadStory =>
    ({
      id: 'coindesk:1',
      source: 'coindesk',
      sourceName: 'CoinDesk',
      sourceClass: 'media',
      title: 'A story',
      url: 'https://www.coindesk.com/a',
      publishedAt: T - 600,
      seenAt: T - 590,
      summary: '',
      assets: [{ ticker: 'SOL', relationship: 'DIRECT' }],
      marketWide: false,
      eventType: 'HACK',
      credibility: 0.85,
      impact: 77,
      stale: false,
      alsoIn: [],
      ...over
    }) as ReadStory

  it('keeps the strongest stories of the last six hours that name a coin, with their reading and reaction', () => {
    const stories = [
      story({ id: 'weak', impact: 20 }),
      story({ id: 'strong', impact: 90 }),
      story({ id: 'old', impact: 95, publishedAt: T - 6 * 3600 - 1 }),
      story({ id: 'nobody', impact: 95, assets: [] }),
      story({ id: 'stale', impact: 95, stale: true })
    ]
    const reading: NewsReading = { ticker: 'SOL', relationship: 'DIRECT', direction: 'down', impact: 85, horizon: '4h', confidence: 0.7, pricedIn: false, reasons: 'read' }
    const reaction = { storyId: 'strong', verdict: 'CONFIRMED', after: { m5: -0.5, m15: -2.14, h1: null, h4: null } } as unknown as StoryReaction
    const rows = newsImpact(stories, { strong: reading }, { strong: reaction }, T)
    expect(rows.map((row) => row.story.id)).toEqual(['strong', 'weak'])
    expect(rows[0].reading).toBe(reading)
    expect(rows[0].reaction).toBe(reaction)
    expect(rows[1].reading).toBeNull()
    expect(describeReaction(reaction)).toBe('CONFIRMED, -2.1% at 15m')
    expect(describeReaction({ ...reaction, after: { ...reaction.after, m15: null } })).toBe('CONFIRMED')
    expect(newsImpact(stories, {}, {}, T, 1)).toHaveLength(1)
  })
})

describe("today's paper trades", () => {
  const trade = (over: Record<string, unknown> = {}, result: Record<string, unknown> | null = { exit: 'take_profit', pnlQuote: 2.5, closedAt: T - 100, btcMovePct: 0 }): ExecutorConfig =>
    ({
      id: String(over.id ?? 'a'),
      mode: 'paper',
      type: 'position',
      status: result === null ? 'active' : 'stopped',
      symbol: 'SOLUSDT',
      quoteAsset: 'USDT',
      createdAt: T - 1800,
      stoppedAt: result === null ? null : T - 100,
      watch: { eventId: 'e', eventTime: T - 1900, model: 'm', confidence: 0.8, ...(result === null ? {} : { result }) },
      params: { side: 'buy', amountQuote: 100, stopLossPct: 2, takeProfitPct: 4, slippageRate: 0.0002 },
      ...over
    }) as unknown as ExecutorConfig

  it('counts the day by UTC: opened, closed having entered, open now; the net and R; the best and the worst', () => {
    const dayStart = Math.floor(T / 86_400) * 86_400
    const executors = [
      trade({ id: 'won' }),
      trade({ id: 'lost', symbol: 'XRPUSDT' }, { exit: 'stop_loss', pnlQuote: -1.2, closedAt: T - 50, btcMovePct: 0 }),
      trade({ id: 'expired' }, { exit: 'entry_expired', pnlQuote: 0, closedAt: T - 40, btcMovePct: 0 }),
      trade({ id: 'open' }, null),
      trade({ id: 'yesterday', createdAt: dayStart - 7200 }, { exit: 'take_profit', pnlQuote: 9, closedAt: dayStart - 3600, btcMovePct: 0 }),
      trade({ id: 'hand', watch: undefined }),
      trade({ id: 'live', mode: 'live' })
    ]
    const today = todaysPaper(executors, T)
    expect(today).toMatchObject({ opened: 4, closed: 2, openNow: 1, rTrades: 2, best: { symbol: 'SOLUSDT', pnlQuote: 2.5 }, worst: { symbol: 'XRPUSDT', pnlQuote: -1.2 } })
    expect(today.net).toEqual([{ asset: 'USDT', amount: 1.3 }])
    expect(today.r).toBeGreaterThan(0)
    expect(todaysPaper([], T)).toEqual({ opened: 0, closed: 0, openNow: 0, net: [], r: 0, rTrades: 0, best: null, worst: null })
  })
})

describe('a market-wide move among the breaking events', () => {
  // The pairs that moved with Bitcoin out-score the move (its score is Bitcoin's own), and none of
  // them was asked about: the move was, once. Overview puts the move first and says so of them.
  const MOVE = `binance:BTCUSDT:${T - 120}`
  const move = item({
    id: MOVE,
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    time: T - 120,
    type: 'market_move',
    direction: 'down',
    score: 85,
    live: { detectedAt: T - 112, quoteVolume24h: 2_000_000_000, spreadPct: 0.01, candidateScore: 90, rank: 1, members: [{ symbol: 'ETHUSDT', direction: 'down', score: 93, returnM15Pct: -4.5, volumeRatio: 20 }] }
  })
  const member = (symbol: string, score: number, rank: number): EventFeedItem =>
    item({ id: `binance:${symbol}:${T - 120}`, symbol, time: T - 120, type: 'breakdown', direction: 'down', score, live: { detectedAt: T - 112, quoteVolume24h: 1_000_000_000, spreadPct: 0.02, candidateScore: score, rank, marketMove: MOVE } })
  const other = item({ id: `binance:LINKUSDT:${T - 600}`, symbol: 'LINKUSDT', time: T - 600, score: 88 })

  it('comes before the pairs in it, however they score, and after a stronger event of its own', () => {
    const feed = [member('ETHUSDT', 93, 2), member('BNBUSDT', 92, 3), other, move]
    expect(breakingEvents(feed, T).map((entry) => entry.event.symbol)).toEqual(['LINKUSDT', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT'])
  })

  it('is the event that was asked about; a pair in it says so instead of waiting for an answer', () => {
    expect(describeAnswers(member('ETHUSDT', 93, 2))).toBe('part of a market-wide move')
    expect(describeAnswers(move)).toBe('no answer yet')
    expect(describeAnswers(item({}, [decision({ recommendation: 'buy' })]))).toBe('1 BUY')
  })
})
