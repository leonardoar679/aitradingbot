import { describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import { AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION } from '../shared/aiOpportunity'
import type { AiSignalDetail } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import { assembleFeed, describeWhatItLacks, overviewOpportunity, proposalForAnswer, OVERVIEW_CANDIDATE_SECONDS } from '../src/agents/opportunities'
import { describeBtcRegime } from '../src/overview/marketSummary'

// Overview leads with what can be acted on (src/agents/opportunities.ts, overviewOpportunity):
// the strongest recommendation still on offer, or -- the usual case -- that there is none, with
// the strongest event of the last hour and what it lacks. Its Paper trade fills in the same form
// Opportunities does (proposalForAnswer).

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
    source: 'watch',
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

/** Minute candles from the event on, at a price that never trades in the entry range. */
function above(from: number, minutes: number): Candle[] {
  return Array.from({ length: minutes }, (_, i) => ({ time: from + i * 60, open: 101, high: 101.1, low: 100.9, close: 101, volume: 1 }))
}

describe('what Overview leads with', () => {
  it('leads with the strongest recommendation still on offer, and the answer it rests on', () => {
    const feed = assembleFeed([event()], [call()])
    const pick = overviewOpportunity(feed, new Map(), T + 120)
    expect(pick.kind).toBe('valid')
    if (pick.kind !== 'valid') return
    expect(pick.row.item.event.symbol).toBe('SOLUSDT')
    expect(pick.answer.model).toBe('openai/gpt-5-mini')
    expect([pick.row.entryMin, pick.row.entryMax]).toEqual([99.8, 100.2])
  })

  it('says there is none, and names the strongest event of the hour, when nothing can be acted on', () => {
    const quiet = event('ADAUSDT', T + 60, { score: 80, live: undefined })
    const strong = event('SOLUSDT', T, { score: 91 })
    const feed = assembleFeed([quiet, strong], [])
    const pick = overviewOpportunity(feed, new Map(), T + 300)
    expect(pick).toEqual({ kind: 'none', candidate: { item: feed[1], status: 'waiting', lacks: 'No model has been asked about it.' } })
  })

  it('says so when no model would act: the surest answer, and the line the app acts at', () => {
    const feed = assembleFeed([event()], [call({ confidence: 0.55 }), call({ id: 'b', model: 'acme/other', recommendation: 'hold', confidence: 0.4, detail: undefined })])
    const pick = overviewOpportunity(feed, new Map(), T + 120)
    expect(pick.kind).toBe('none')
    if (pick.kind !== 'none' || pick.candidate === null) throw new Error('expected a candidate')
    expect(pick.candidate.status).toBe('asked')
    expect(pick.candidate.lacks).toBe('No model would act on it: the surest answer was openai/gpt-5-mini\'s BUY at 55%, and this app acts at 65% or more.')
  })

  it('says an entry ran out when the candles show it never filled in time', () => {
    const feed = assembleFeed([event()], [call()])
    const now = T + 20 * 60
    const pick = overviewOpportunity(feed, new Map([[feed[0].event.id, above(T, 20)]]), now)
    expect(pick.kind).toBe('none')
    if (pick.kind !== 'none' || pick.candidate === null) throw new Error('expected a candidate')
    expect(pick.candidate.status).toBe('expired')
    expect(pick.candidate.lacks).toBe('Its entry ran out without filling.')
  })

  it('looks back an hour and no further, and names nothing when nothing was raised in it', () => {
    const feed = assembleFeed([event('SOLUSDT', T)], [])
    const atTheHour = overviewOpportunity(feed, new Map(), T + OVERVIEW_CANDIDATE_SECONDS)
    expect(atTheHour.kind === 'none' ? atTheHour.candidate?.item.event.symbol : null).toBe('SOLUSDT')
    expect(overviewOpportunity(feed, new Map(), T + OVERVIEW_CANDIDATE_SECONDS + 1)).toEqual({ kind: 'none', candidate: null })
  })

  it('says every answer was refused rather than naming a surest one', () => {
    const feed = assembleFeed([event()], [call({ status: 'rejected', error: 'out of range', recommendation: null, confidence: null, detail: undefined })])
    expect(describeWhatItLacks(feed[0], 'asked')).toBe('Every answer to it was refused.')
  })
})

describe('the order form a recommendation fills in', () => {
  const item = assembleFeed([event()], [call()])[0]

  it('is made at the price now, when that is still inside the entry', async () => {
    const result = await proposalForAnswer(item, item.answers[0], async () => 100, () => T + 60)
    expect('proposal' in result).toBe(true)
    if (!('proposal' in result)) return
    expect(result.proposal.pair.symbol).toBe('SOLUSDT')
    expect(result.proposal.model).toBe('openai/gpt-5-mini')
  })

  it('is refused, with the reason, when the price is already through the stop', async () => {
    const result = await proposalForAnswer(item, item.answers[0], async () => 98, () => T + 60)
    expect('problem' in result).toBe(true)
    if (!('problem' in result)) return
    expect(result.problem.length).toBeGreaterThan(10)
  })

  it('stands in the price the model saw when the price now cannot be read', async () => {
    const result = await proposalForAnswer(
      item,
      item.answers[0],
      async () => {
        throw new Error('offline')
      },
      () => T + 60
    )
    expect('proposal' in result).toBe(true)
  })
})

describe("Bitcoin's four hours", () => {
  const btc = (h4: number): { returnsPct: { m5: number; m15: number; h1: number; h4: number } } => ({ returnsPct: { m5: 0, m15: 0, h1: 0, h4 } })

  it('reads rising, falling or flat by the rule the benchmark slices by', () => {
    expect(describeBtcRegime(btc(1.4))).toBe('Bitcoin is rising: +1.40% over four hours.')
    expect(describeBtcRegime(btc(-2))).toBe('Bitcoin is falling: -2.00% over four hours.')
    expect(describeBtcRegime(btc(0.3))).toBe('Bitcoin is flat: +0.30% over four hours, inside 1% either way.')
  })
})
