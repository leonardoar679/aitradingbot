import { beforeEach, describe, expect, it } from 'vitest'
import { EVENT_BENCHMARK_SETTLE_SEC, summarizeEventBenchmark } from '../shared/aiEventBenchmark'
import { matchesAiCallFilter, type AiCallFilter, type AiCallRecord } from '../shared/aiLedger'
import { AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION } from '../shared/aiOpportunity'
import type { AiSignalDetail } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import { matchesMarketEventFilter, type MarketEventFilter } from '../shared/marketScanner'
import { LIVE_BOARD_DAYS, WITH_REVIEWER, clearLiveBars, loadLiveBars, readLiveAnswers, withReviewer, type LiveBoardDeps } from '../src/agents/liveBoard'

// The leaderboard of what the watch asked live: which answers it reads, how they are joined to
// their events, and the candles that score them.

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'
const DAY = 86_400
const T = Date.parse('2026-09-10T12:07:00Z') / 1000
const NOW = T + 3 * DAY

function event(symbol: string, time = T): MarketEvent {
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
    live: { detectedAt: time + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 }
  }
}

const LONG: AiSignalDetail = {
  marketRegime: 'bull',
  riskLevel: 'medium',
  horizonBars: 4,
  stopLoss: 98.5,
  takeProfit: 102,
  reasonCodes: ['breakout'],
  levelsNote: null,
  entry: { min: 99.8, max: 100.2, validMinutes: 15 }
}

function call(symbol: string, overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    id: `${symbol}-${overrides.model ?? A}-${overrides.at ?? T + 20}`,
    at: T + 20,
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
    candleTime: T,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.003, latencyMs: 9000 },
    error: null,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range on volume.',
    detail: LONG,
    eventId: `binance:${symbol}:${T}`,
    eventType: 'breakout',
    ...overrides
  }
}

/** Minute bars from `time`: flat at 100 for three minutes, then at 103. */
function path(time: number, count = 120): Candle[] {
  return Array.from({ length: count }, (_, n) => {
    const open = n > 3 ? 103 : 100
    const close = n >= 3 ? 103 : 100
    return { time: time + n * 60, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 }
  })
}

function deps(calls: AiCallRecord[], events: MarketEvent[]): { deps: LiveBoardDeps; callFilters: AiCallFilter[]; eventFilters: MarketEventFilter[]; fetches: string[] } {
  const callFilters: AiCallFilter[] = []
  const eventFilters: MarketEventFilter[] = []
  const fetches: string[] = []
  return {
    callFilters,
    eventFilters,
    fetches,
    deps: {
      // Newest first, as the ledger and the scanner's file are read.
      listCalls: async (filter) => {
        callFilters.push(filter)
        return { rows: calls.filter((row) => matchesAiCallFilter(row, filter)).sort((a, b) => b.at - a.at), skippedLines: 0 }
      },
      listEvents: async (filter) => {
        eventFilters.push(filter)
        return { rows: events.filter((entry) => matchesMarketEventFilter(entry, filter)).sort((a, b) => b.time - a.time), skippedLines: 0 }
      },
      fetchCandles: async (_exchange, symbol, _interval, startSec) => {
        fetches.push(symbol)
        return path(startSec)
      }
    }
  }
}

beforeEach(() => clearLiveBars())

describe('the watch with and without the reviewer', () => {
  const review = (eventId: string, verdict: 'APPROVE' | 'REJECT'): AiCallRecord =>
    call('SOLUSDT', {
      id: `review-${eventId}`,
      source: 'addition',
      model: A,
      promptVersion: 'reviewer-v1',
      schemaVersion: 'review-verdict-v1',
      eventId: undefined,
      recommendation: null,
      detail: null,
      addition: 'review',
      subjectId: eventId,
      additionAnswer: { verdict, confidence: 0.7, reason: 'checked' }
    })

  it("reads the reviewer's verdicts, and adds a row with each rejected call taken as no trade", async () => {
    const sol = event('SOLUSDT')
    const eth = event('ETHUSDT')
    const rig = deps(
      [call('SOLUSDT'), call('ETHUSDT', { eventId: eth.id }), call('SOLUSDT', { model: B, recommendation: 'hold', detail: null }), call('ETHUSDT', { model: B, eventId: eth.id }), review(sol.id, 'REJECT'), review(eth.id, 'APPROVE')],
      [sol, eth]
    )
    const live = await readLiveAnswers([A, B], NOW, rig.deps)
    expect(live.reviews).toEqual({ [sol.id]: { verdict: 'REJECT', confidence: 0.7, reason: 'checked' }, [eth.id]: { verdict: 'APPROVE', confidence: 0.7, reason: 'checked' } })
    const reviewed = withReviewer(live, [A, B])
    // Only A had a call to trade the rejected event: B's row stands as it is.
    expect(reviewed.models).toEqual([A, B, `${A}${WITH_REVIEWER}`])
    const index = live.events.findIndex((entry) => entry.id === sol.id)
    expect(reviewed.answers[`${A}${WITH_REVIEWER}`][index]?.recommendation).toBe('hold')
    expect(reviewed.answers[`${A}${WITH_REVIEWER}`][1 - index]).toEqual(live.answers[A][1 - index])
    // Still answered, so it is compared on the same events; and it trades one fewer.
    const bars = Object.fromEntries(live.events.map((entry) => [entry.id, path(entry.time)]))
    const summary = summarizeEventBenchmark({ events: live.events, ...reviewed, bars, nowSec: NOW })
    expect(summary.compared).toBe(2)
    expect(summary.models.map((row) => [row.name, row.actionable])).toEqual([
      [A, 2],
      [B, 1],
      [`${A}${WITH_REVIEWER}`, 1]
    ])
  })

  it('adds nothing when the reviewer rejected nothing', async () => {
    const sol = event('SOLUSDT')
    const live = await readLiveAnswers([A], NOW, deps([call('SOLUSDT'), review(sol.id, 'APPROVE')], [sol]).deps)
    expect(withReviewer(live, [A]).models).toEqual([A])
  })
})

describe('readLiveAnswers', () => {
  it('reads the watch\'s answers, under the opportunity prompts it asks live, for the last thirty days', async () => {
    const rig = deps([], [])
    await readLiveAnswers([A], NOW, rig.deps)
    // The scanner's question and an announcement's: both are put to events as they happen.
    expect(rig.callFilters).toEqual([
      { source: 'watch', promptVersions: ['opportunity-v1', 'opportunity-news-v1', 'opportunity-tag-v1', 'market-move-v1'], sinceSec: NOW - LIVE_BOARD_DAYS * DAY, limit: 5000 },
      // And the reviewer's verdicts on them (shared/aiAdditions.ts).
      { source: 'addition', promptVersion: 'reviewer-v1', sinceSec: NOW - LIVE_BOARD_DAYS * DAY, limit: 5000 }
    ])
    expect(rig.eventFilters[0].sinceSec).toBeLessThan(NOW - LIVE_BOARD_DAYS * DAY)
  })

  it('joins each answer to its event, oldest event first, with when it arrived', async () => {
    const earlier = event('ETHUSDT', T - 3600)
    const rig = deps(
      [
        call('SOLUSDT', { at: T + 20 }),
        call('SOLUSDT', { model: B, at: T + 45, recommendation: 'hold', confidence: 0.5, detail: null }),
        call('ETHUSDT', { at: T - 3600 + 12, eventId: earlier.id, candleTime: earlier.time })
      ],
      [event('SOLUSDT'), earlier, event('NOBODYUSDT')]
    )
    const live = await readLiveAnswers([A, B], NOW, rig.deps)
    expect(live.events.map((entry) => entry.symbol)).toEqual(['ETHUSDT', 'SOLUSDT'])
    expect(live.answers[A].map((decision) => decision?.recommendation)).toEqual(['buy', 'buy'])
    expect(live.answers[B].map((decision) => decision?.recommendation)).toEqual([undefined, 'hold'])
    expect(live.answeredAt).toEqual({ [A]: [T - 3600 + 12, T + 20], [B]: [null, T + 45] })
    expect(live.missing).toBe(0)
  })

  it('leaves out what a click or a benchmark bought, a call that reached no model, and a model not being compared', async () => {
    const rig = deps(
      [
        call('AUSDT', { source: 'opportunity' }),
        call('BUSDT', { source: 'benchmark' }),
        call('CUSDT', { status: 'failed', recommendation: null, detail: null, error: 'timeout' }),
        call('DUSDT', { model: B }),
        call('EUSDT')
      ],
      ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT', 'EUSDT'].map((symbol) => event(symbol))
    )
    const live = await readLiveAnswers([A], NOW, rig.deps)
    expect(live.events.map((entry) => entry.symbol)).toEqual(['EUSDT'])
  })

  it('keeps a refused answer, which was billed and is no trade', async () => {
    const rig = deps([call('SOLUSDT', { status: 'rejected', recommendation: null, confidence: null, detail: null, error: 'The stop is not below the entry range.' })], [event('SOLUSDT')])
    const live = await readLiveAnswers([A], NOW, rig.deps)
    expect(live.answers[A][0]).toMatchObject({ recommendation: 'hold', rejected: 'The stop is not below the entry range.' })
  })

  it('keeps the first answer a model gave for an event', async () => {
    const rig = deps([call('SOLUSDT', { at: T + 90, confidence: 0.9 }), call('SOLUSDT', { at: T + 20, confidence: 0.7 })], [event('SOLUSDT')])
    const live = await readLiveAnswers([A], NOW, rig.deps)
    expect(live.answers[A][0]?.confidence).toBe(0.7)
    expect(live.answeredAt[A]).toEqual([T + 20])
  })

  it('counts an event whose record is no longer on file, and does not score it', async () => {
    const rig = deps([call('SOLUSDT'), call('GONEUSDT')], [event('SOLUSDT')])
    const live = await readLiveAnswers([A], NOW, rig.deps)
    expect(live.events.map((entry) => entry.symbol)).toEqual(['SOLUSDT'])
    expect(live.missing).toBe(1)
  })

  it('scores a live answer from the second it arrived', async () => {
    // Twenty seconds after the event the price was still in the entry range; two hundred seconds
    // after it, the price had gone. The same recommendation, and only its arrival differs.
    const board = async (at: number): Promise<{ closed: number; expired: number }> => {
      const rig = deps([call('SOLUSDT', { at })], [event('SOLUSDT')])
      const live = await readLiveAnswers([A], NOW, rig.deps)
      const bars = await loadLiveBars(live.events, NOW, rig.deps.fetchCandles)
      const row = summarizeEventBenchmark({ events: live.events, models: [A], answers: live.answers, answeredAt: live.answeredAt, bars, nowSec: NOW }).models[0]
      return { closed: row.closed, expired: row.expired }
    }
    expect(await board(T + 20)).toEqual({ closed: 1, expired: 0 })
    clearLiveBars()
    expect(await board(T + 200)).toEqual({ closed: 0, expired: 1 })
  })
})

describe('loadLiveBars', () => {
  it('reads the candles after each event once, and keeps them once nothing more can happen to it', async () => {
    const rig = deps([], [])
    const events = [event('SOLUSDT'), event('ETHUSDT')]
    const first = await loadLiveBars(events, NOW, rig.deps.fetchCandles)
    expect(rig.fetches.sort()).toEqual(['ETHUSDT', 'SOLUSDT'])
    expect(first[events[0].id]).toHaveLength(120)
    const again = await loadLiveBars(events, NOW + 60, rig.deps.fetchCandles)
    expect(rig.fetches).toHaveLength(2)
    expect(again[events[0].id]).toBe(first[events[0].id])
  })

  it('reads an event again while a recommendation on it can still change', async () => {
    const rig = deps([], [])
    const recent = event('SOLUSDT', NOW - 3600)
    await loadLiveBars([recent], NOW, rig.deps.fetchCandles)
    await loadLiveBars([recent], NOW + 60, rig.deps.fetchCandles)
    expect(rig.fetches).toHaveLength(2)
    // A day and an hour and ten minutes after the event, and a minute more, it is settled.
    const settledAt = recent.time + EVENT_BENCHMARK_SETTLE_SEC + 60
    await loadLiveBars([recent], settledAt, rig.deps.fetchCandles)
    await loadLiveBars([recent], settledAt + 60, rig.deps.fetchCandles)
    expect(rig.fetches).toHaveLength(3)
  })

  it('does not keep a fetch that failed, so the next look tries again', async () => {
    let fail = true
    const fetches: string[] = []
    const fetchCandles: LiveBoardDeps['fetchCandles'] = async (_exchange, symbol, _interval, startSec) => {
      fetches.push(symbol)
      if (fail) throw new Error('the exchange did not answer')
      return path(startSec)
    }
    const events = [event('SOLUSDT')]
    expect((await loadLiveBars(events, NOW, fetchCandles))[events[0].id]).toEqual([])
    fail = false
    expect((await loadLiveBars(events, NOW, fetchCandles))[events[0].id]).toHaveLength(120)
    expect(fetches).toHaveLength(2)
  })
})
