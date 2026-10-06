import { describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import { AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION } from '../shared/aiOpportunity'
import type { AiSignalDetail } from '../shared/aiSignal'
import { LIVE_MAX_INTEREST, emptyLiveState, type LiveState } from '../shared/liveMarket'
import type { MarketEvent } from '../shared/marketEvent'
import type { ResearchPair } from '../shared/marketResearch'
import type { NewsFeedState, ReadStory } from '../shared/newsFeed'
import { assembleFeed, rightNowRows } from '../src/agents/opportunities'
import { TABLE_RECENT_SHOWN, opportunityTableRows, tableSymbols } from '../src/agents/opportunityTable'

// src/agents/opportunityTable.ts: the rows of the Opportunities table (the second V3 document,
// §43-44) -- what is on offer and the last hour's other events, each with its signal, worked out
// from what the page already holds.

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'
const T = Date.parse('2026-10-06T09:07:00Z') / 1000
const NOW = T + 120

function event(symbol: string, time = T, overrides: Partial<MarketEvent> = {}): MarketEvent {
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
    components: { price: 90, volume: 95, volatility: 50, pressure: 90, breakout: 95 },
    price: 100,
    returnsPct: { m1: 0.4, m5: 1.5, m15: 3, h1: 3.2, h4: 2.5 },
    moveSigmas: 6,
    volumeRatio: 4.7,
    rangeRatio: 2.5,
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
const NONE: AiSignalDetail = { ...LONG, stopLoss: null, takeProfit: null, entry: null }

function call(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  const symbol = overrides.symbol ?? 'SOLUSDT'
  const time = overrides.candleTime ?? T
  return {
    id: `${overrides.model ?? A}:${symbol}:${time}`,
    at: time + 25,
    source: 'watch',
    status: 'ok',
    model: A,
    provider: 'Test',
    promptVersion: AI_OPPORTUNITY_PROMPT_VERSION,
    contextVersion: 'context-v1',
    schemaVersion: AI_OPPORTUNITY_SCHEMA_VERSION,
    exchange: 'binance',
    symbol,
    interval: '15m',
    candleTime: time,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.003, latencyMs: 14_000 },
    error: null,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range on volume.',
    detail: LONG,
    eventId: `binance:${symbol}:${time}`,
    eventType: 'breakout',
    ...overrides
  }
}

function story(ticker: string): ReadStory {
  return {
    id: `coindesk:${ticker}`,
    source: 'coindesk',
    sourceName: 'CoinDesk',
    sourceClass: 'media',
    title: `Binance lists ${ticker} futures`,
    url: 'https://www.coindesk.com/x',
    publishedAt: T - 300,
    seenAt: T - 290,
    summary: '',
    assets: [{ ticker, relationship: 'DIRECT' }],
    marketWide: false,
    eventType: 'LISTING',
    credibility: 0.85,
    impact: 75,
    stale: false,
    alsoIn: []
  }
}

const news = (stories: ReadStory[]): NewsFeedState => ({ version: 'feed-v1', sources: [], stories, reactions: {}, impact: [], measured: 0, updatedAt: NOW })

function researched(symbol: string, change24hPct: number, change7dPct: number | null): ResearchPair {
  return { symbol, baseAsset: symbol.replace('USDT', ''), price: 100, change24hPct, quoteVolume24h: 3e7, change7dPct, volumeExpansion: null, upDays: null, fromHigh7dPct: null, trending: false }
}

function rows(feedEvents: MarketEvent[], calls: AiCallRecord[], over: { live?: LiveState | null; stories?: ReadStory[]; pairs?: ResearchPair[] } = {}): ReturnType<typeof opportunityTableRows> {
  return opportunityTableRows({
    feed: assembleFeed(feedEvents, calls),
    bars: new Map(),
    live: over.live === undefined ? null : over.live,
    pairs: over.pairs ?? [],
    regime: 'bull',
    news: news(over.stories ?? []),
    nowSec: NOW,
    nowMs: NOW * 1000
  })
}

describe('the opportunities table', () => {
  it('ranks the entries on offer by their signal, not by how strong the event alone was', () => {
    const strong = event('ETHUSDT', T, { live: { detectedAt: T + 8, quoteVolume24h: 9e8, spreadPct: 0.01, candidateScore: 97, rank: 1 } })
    const weak = event('ADAUSDT', T, { live: { detectedAt: T + 8, quoteVolume24h: 2e7, spreadPct: 0.05, candidateScore: 80, rank: 2 } })
    const calls = [call({ symbol: 'ADAUSDT' }), call({ symbol: 'ETHUSDT' })]
    // The scanner's order: ETH first.
    expect(rightNowRows(assembleFeed([weak, strong], calls), new Map(), NOW).map((row) => row.item.event.symbol)).toEqual(['ETHUSDT', 'ADAUSDT'])
    // A listing on ADA puts it first by its signal.
    const table = rows([weak, strong], calls, { stories: [story('ADA')] })
    expect(table.onOffer.map((row) => row.item.event.symbol)).toEqual(['ADAUSDT', 'ETHUSDT'])
    expect(table.onOffer[0].signal.story?.id).toBe('coindesk:ADA')
    expect(table.onOffer[0].signal.score).toBeGreaterThan(table.onOffer[1].signal.score)
    expect(table.onOffer[0]).toMatchObject({ side: 'long', status: 'valid', agreement: { taking: 1, answered: 1 } })
    expect(table.recent).toEqual([])
  })

  it("lists the last hour's other events beside them, with where each stands", () => {
    const asked = event('XRPUSDT', T - 600)
    const waiting = event('DOGEUSDT', T - 1200, { direction: 'down', type: 'breakdown' })
    const old = event('LTCUSDT', T - 3600 - 121)
    const table = rows([asked, waiting, old], [call({ symbol: 'XRPUSDT', candleTime: T - 600, recommendation: 'hold', confidence: 0.6, detail: NONE }), call({ symbol: 'XRPUSDT', candleTime: T - 600, model: B, status: 'rejected', error: 'refused' })])
    expect(table.onOffer).toEqual([])
    expect(table.recent.map((row) => [row.item.event.symbol, row.status, row.side, row.agreement])).toEqual([
      ['XRPUSDT', 'asked', 'long', { taking: 0, answered: 1 }],
      ['DOGEUSDT', 'waiting', 'short', { taking: 0, answered: 0 }]
    ])
    // Nothing on offer: no live check, and no entry.
    expect(table.recent[0]).toMatchObject({ offer: null, live: null })
  })

  it('shows at most so many of the others, the strongest signal first', () => {
    // Each a point of signal stronger than the one before: a quarter of four points of event score.
    const many = Array.from({ length: TABLE_RECENT_SHOWN + 3 }, (_, k) => event(`P${k}USDT`, T - k * 60, { score: 56 + 4 * k }))
    const table = rows(many, [])
    expect(table.recent).toHaveLength(TABLE_RECENT_SHOWN)
    expect(table.recent[0].item.event.symbol).toBe(`P${TABLE_RECENT_SHOWN + 2}USDT`)
  })

  it('reads the price from the live book, and the day and week from the research', () => {
    const live: LiveState = {
      ...emptyLiveState(),
      books: { SOLUSDT: { symbol: 'SOLUSDT', bid: 99.99, bidQty: 10, ask: 100.01, askQty: 10, updatedAt: NOW * 1000, source: 'stream' } }
    }
    const table = rows([event('SOLUSDT')], [call()], { live, pairs: [researched('SOLUSDT', 4.2, -3.1)] })
    expect(table.onOffer[0].price).toBeCloseTo(100, 10)
    expect(table.onOffer[0].research).toEqual({ change24hPct: 4.2, change7dPct: -3.1 })
    expect(table.onOffer[0].live?.verdict.state).toBe('enterable')
    // Unstreamed and unresearched: nothing is made up.
    const bare = rows([event('SOLUSDT')], [call()])
    expect(bare.onOffer[0]).toMatchObject({ price: null, research: null, live: null })
  })

  it('wants the live prices of the pairs on offer first, then the others, as many as the stream takes', () => {
    const offered = event('SOLUSDT', T, { score: 70 })
    const others = Array.from({ length: LIVE_MAX_INTEREST + 2 }, (_, k) => event(`Q${k}USDT`, T - k * 60, { score: 75 + k }))
    const symbols = tableSymbols(assembleFeed([offered, ...others], [call()]), new Map(), NOW)
    expect(symbols).toHaveLength(LIVE_MAX_INTEREST)
    expect(symbols[0]).toBe('SOLUSDT')
    expect(symbols[1]).toBe(`Q${LIVE_MAX_INTEREST + 1}USDT`)
    // An event from over an hour ago, or not yet raised, is not wanted.
    expect(tableSymbols(assembleFeed([event('OLDUSDT', T - 3600 - 121), event('NEWUSDT', NOW + 60)], []), new Map(), NOW)).toEqual([])
  })
})
