import { describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import type { AiSignalDecision, AiSignalDetail } from '../shared/aiSignal'
import {
  AI_WATCH_BREAKER_CALLS,
  AI_WATCH_FRESH_SECONDS,
  DEFAULT_AI_WATCH,
  aiWatchProblem,
  describeAiWatchCost,
  healAiWatch,
  sameWatchTerms,
  watchCallProblem,
  watchEventIdsToday,
  watchNotice,
  watchPausedModels,
  watchSkipReason,
  type AiWatchConfig
} from '../shared/aiWatch'
import type { MarketEvent } from '../shared/marketEvent'

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'
const ENABLED = [A, B]
const T = Date.parse('2026-09-10T12:07:00Z') / 1000
const MIDNIGHT = Date.parse('2026-09-10T00:00:00Z') / 1000

function watch(overrides: Partial<AiWatchConfig> = {}): AiWatchConfig {
  return { enabled: true, models: [A, B], maxEventsPerDay: 10, minBand: 'urgent', firstModelGates: false, ...overrides }
}

function event(overrides: Partial<MarketEvent> = {}): MarketEvent {
  return {
    id: `binance:SOLUSDT:${T}`,
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    time: T,
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
    live: { detectedAt: T + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 },
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

function decision(overrides: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime: T,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range on volume.',
    model: A,
    cached: false,
    error: null,
    rejected: null,
    detail: LONG,
    usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.003, latencyMs: 14_000 },
    ...overrides
  }
}

describe('healAiWatch', () => {
  it('reads anything unreadable as the default, which is off', () => {
    for (const stored of [undefined, null, 'on', 7, []]) expect(healAiWatch(stored, ENABLED)).toEqual(DEFAULT_AI_WATCH)
    expect(DEFAULT_AI_WATCH.enabled).toBe(false)
  })

  it('keeps a watch that is exactly one that could have been switched on', () => {
    expect(healAiWatch(watch({ minBand: 'candidate', firstModelGates: true, maxEventsPerDay: 40 }), ENABLED)).toEqual(
      watch({ minBand: 'candidate', firstModelGates: true, maxEventsPerDay: 40 })
    )
  })

  it('is switched on by `true` and by nothing else', () => {
    for (const enabled of ['true', 1, {}, null]) expect(healAiWatch({ ...watch(), enabled }, ENABLED).enabled).toBe(false)
  })

  it('switches off a watch whose list had to be repaired, rather than run it in another shape', () => {
    // One of its models is no longer enabled. The list is repaired; the watch does not go on
    // asking the other at a price nobody agreed to.
    expect(healAiWatch(watch(), [A])).toEqual(watch({ enabled: false, models: [A] }))
    expect(healAiWatch(watch({ models: [A, A] }), ENABLED)).toMatchObject({ enabled: false, models: [A] })
    expect(healAiWatch(watch({ models: [A, `panel:${A}`] }), ENABLED)).toMatchObject({ enabled: false, models: [A] })
    expect(healAiWatch({ ...watch(), models: [A, 7] }, ENABLED)).toMatchObject({ enabled: false, models: [A] })
    expect(healAiWatch(watch({ models: [] }), ENABLED)).toMatchObject({ enabled: false, models: [] })
    expect(healAiWatch({ ...watch(), models: 'all' }, ENABLED)).toMatchObject({ enabled: false, models: [] })
  })

  it('switches off a watch with a limit, a band or a gate that is not one of the choices', () => {
    expect(healAiWatch(watch({ maxEventsPerDay: 500 }), ENABLED)).toMatchObject({ enabled: false, maxEventsPerDay: 10 })
    expect(healAiWatch({ ...watch(), minBand: 'watch' }, ENABLED)).toMatchObject({ enabled: false, minBand: 'urgent' })
    expect(healAiWatch({ ...watch(), firstModelGates: 'yes' }, ENABLED)).toMatchObject({ enabled: false, firstModelGates: false })
  })
})

describe('aiWatchProblem', () => {
  it('accepts a watch that can run, and one that is off with nothing chosen yet', () => {
    expect(aiWatchProblem(watch(), ENABLED)).toBeNull()
    expect(aiWatchProblem(DEFAULT_AI_WATCH, ENABLED)).toBeNull()
  })

  it('refuses what came over the bridge in the wrong shape', () => {
    expect(aiWatchProblem({ ...watch(), enabled: 'yes' } as unknown as AiWatchConfig, ENABLED)).toMatch(/on or off/)
    expect(aiWatchProblem({ ...watch(), firstModelGates: 1 } as unknown as AiWatchConfig, ENABLED)).toMatch(/on or off/)
    expect(aiWatchProblem({ ...watch(), models: A } as unknown as AiWatchConfig, ENABLED)).toMatch(/list of models/)
    expect(aiWatchProblem({ ...watch(), models: [A, 3] } as unknown as AiWatchConfig, ENABLED)).toMatch(/list of models/)
  })

  it('refuses a list it could not ask', () => {
    expect(aiWatchProblem(watch({ models: [] }), ENABLED)).toMatch(/at least one model/)
    expect(aiWatchProblem(watch({ models: [A, A] }), ENABLED)).toMatch(/same model twice/)
    expect(aiWatchProblem(watch({ models: [A, 'some/other-model'] }), ENABLED)).toMatch(/some\/other-model is not enabled/)
    // A panel is refused as a panel, not as one more model that happens not to be enabled.
    expect(aiWatchProblem(watch({ models: [`panel:${A}`] }), ENABLED)).toMatch(/A panel of agents has no question to put to an event/)
    const seven = Array.from({ length: 7 }, (_, index) => `acme/model-${index}`)
    expect(aiWatchProblem(watch({ models: seven }), seven)).toMatch(/at most 6 models/)
  })

  it('refuses a limit or a band that is not one of the choices', () => {
    expect(aiWatchProblem(watch({ maxEventsPerDay: 11 }), ENABLED)).toMatch(/5, 10, 20, 40 events a day/)
    expect(aiWatchProblem(watch({ maxEventsPerDay: Number.POSITIVE_INFINITY }), ENABLED)).toMatch(/events a day/)
    expect(aiWatchProblem({ ...watch(), minBand: 'watch' } as unknown as AiWatchConfig, ENABLED)).toMatch(/candidate or at urgent/)
  })
})

describe('sameWatchTerms', () => {
  it('is about what is asked and at what price, not whether it is on', () => {
    expect(sameWatchTerms(watch(), watch({ enabled: false }))).toBe(true)
    expect(sameWatchTerms(watch(), watch({ models: [A] }))).toBe(false)
    // The order is who is asked first, which is what a gate goes by.
    expect(sameWatchTerms(watch(), watch({ models: [B, A] }))).toBe(false)
    expect(sameWatchTerms(watch(), watch({ maxEventsPerDay: 20 }))).toBe(false)
    expect(sameWatchTerms(watch(), watch({ minBand: 'candidate' }))).toBe(false)
    expect(sameWatchTerms(watch(), watch({ firstModelGates: true }))).toBe(false)
  })
})

describe('watchEventIdsToday', () => {
  const row = (overrides: Partial<Pick<AiCallRecord, 'at' | 'source' | 'eventId'>>): Pick<AiCallRecord, 'at' | 'source' | 'eventId'> => ({
    at: T,
    source: 'watch',
    eventId: 'binance:SOLUSDT:1',
    ...overrides
  })

  it('counts each event the watch took up since the last UTC midnight once, however many models it asked', () => {
    const taken = watchEventIdsToday([row({}), row({ at: T + 5 }), row({ eventId: 'binance:ETHUSDT:2' })], T + 60)
    expect([...taken].sort()).toEqual(['binance:ETHUSDT:2', 'binance:SOLUSDT:1'])
  })

  it('leaves out what was asked by a click or a benchmark, what has no event, and yesterday', () => {
    const taken = watchEventIdsToday(
      [
        row({ source: 'opportunity', eventId: 'binance:AUSDT:1' }),
        row({ source: 'benchmark', eventId: 'binance:BUSDT:1' }),
        row({ eventId: undefined }),
        row({ at: MIDNIGHT - 1, eventId: 'binance:CUSDT:1' }),
        row({ at: MIDNIGHT, eventId: 'binance:DUSDT:1' })
      ],
      T
    )
    expect([...taken]).toEqual(['binance:DUSDT:1'])
  })
})

describe('watchSkipReason', () => {
  const state = (overrides: Partial<{ nowSec: number; takenToday: ReadonlySet<string> }> = {}): { nowSec: number; takenToday: ReadonlySet<string> } => ({
    nowSec: T + 10,
    takenToday: new Set<string>(),
    ...overrides
  })

  it('takes up a fresh, strong, live event', () => {
    expect(watchSkipReason(event(), watch(), state())).toBeNull()
  })

  it('takes up nothing while it is off or has nobody to ask', () => {
    expect(watchSkipReason(event(), watch({ enabled: false }), state())).toMatch(/off/)
    expect(watchSkipReason(event(), watch({ models: [] }), state())).toMatch(/no model/)
  })

  it('leaves an event that was found in history, or has no direction', () => {
    expect(watchSkipReason(event({ live: null }), watch(), state())).toMatch(/scanning history/)
    expect(watchSkipReason(event({ direction: 'none', type: 'volume_spike' }), watch(), state())).toMatch(/no direction/)
  })

  it('leaves an event below its band, and takes a candidate only when asked to', () => {
    expect(watchSkipReason(event({ band: 'candidate' }), watch(), state())).toMatch(/below the urgent band/)
    expect(watchSkipReason(event({ band: 'candidate' }), watch({ minBand: 'candidate' }), state())).toBeNull()
    expect(watchSkipReason(event({ band: 'urgent' }), watch({ minBand: 'candidate' }), state())).toBeNull()
  })

  it('leaves an event that was not among the strongest three of its minute', () => {
    const live = { detectedAt: T + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 80 }
    expect(watchSkipReason(event({ live: { ...live, rank: 3 } }), watch(), state())).toBeNull()
    expect(watchSkipReason(event({ live: { ...live, rank: 4 } }), watch(), state())).toMatch(/strongest 3/)
  })

  it('leaves an event more than three minutes old, so that an app opened later buys nothing about the morning', () => {
    expect(watchSkipReason(event(), watch(), state({ nowSec: T + AI_WATCH_FRESH_SECONDS }))).toBeNull()
    expect(watchSkipReason(event(), watch(), state({ nowSec: T + AI_WATCH_FRESH_SECONDS + 1 }))).toMatch(/more than 3 minutes old/)
  })

  it('stops at its events for the day, and still finishes one it has already taken up', () => {
    const others = new Set(Array.from({ length: 10 }, (_, index) => `binance:X${index}USDT:1`))
    expect(watchSkipReason(event(), watch(), state({ takenToday: others }))).toMatch(/its 10 events for today/)
    expect(watchSkipReason(event(), watch({ maxEventsPerDay: 20 }), state({ takenToday: others }))).toBeNull()
    const withThis = new Set([...[...others].slice(1), event().id])
    expect(watchSkipReason(event(), watch(), state({ takenToday: withThis }))).toBeNull()
  })
})

describe('watchCallProblem', () => {
  const call = (overrides: Partial<Parameters<typeof watchCallProblem>[0]> = {}): Parameters<typeof watchCallProblem>[0] => ({
    watch: watch(),
    model: A,
    eventId: event().id,
    eventTime: T,
    nowSec: T + 10,
    takenToday: new Set<string>(),
    ...overrides
  })

  it('allows a fresh event while there is a place for it', () => {
    expect(watchCallProblem(call())).toBeNull()
  })

  it('refuses while the watch is off, whatever else is true', () => {
    expect(watchCallProblem(call({ watch: watch({ enabled: false }), takenToday: new Set([event().id]) }))).toMatch(/watch is off/)
  })

  it('refuses a model the watch was not given', () => {
    expect(watchCallProblem(call({ model: 'some/other-model' }))).toMatch(/not one of the models the watch asks/)
    expect(watchCallProblem(call({ model: B }))).toBeNull()
  })

  it('refuses to take up an event that is no longer fresh', () => {
    expect(watchCallProblem(call({ nowSec: T + AI_WATCH_FRESH_SECONDS }))).toBeNull()
    expect(watchCallProblem(call({ nowSec: T + AI_WATCH_FRESH_SECONDS + 1 }))).toMatch(/last 3 minutes/)
  })

  it('refuses a new event once the day has had its number', () => {
    const others = new Set(Array.from({ length: 10 }, (_, index) => `binance:X${index}USDT:1`))
    expect(watchCallProblem(call({ takenToday: new Set([...others].slice(1)) }))).toBeNull()
    expect(watchCallProblem(call({ takenToday: others }))).toMatch(/its 10 events for today/)
  })

  it('lets an event already taken up be put to the rest of its models, late and with the day full', () => {
    // The first model has answered and passed it on. That may be minutes later, and the event
    // already has its place.
    const full = new Set([...Array.from({ length: 9 }, (_, index) => `binance:X${index}USDT:1`), event().id])
    expect(watchCallProblem(call({ model: B, nowSec: T + 600, takenToday: full }))).toBeNull()
    // Which is not a way round the list.
    expect(watchCallProblem(call({ model: 'some/other-model', nowSec: T + 600, takenToday: full }))).toMatch(/not one of the models/)
  })
})

describe('the breaker: a model that keeps failing is not asked again that day', () => {
  type Row = Pick<AiCallRecord, 'at' | 'source' | 'model' | 'status'>
  const row = (model: string, status: Row['status'], at: number, source: Row['source'] = 'watch'): Row => ({ at, source, model, status })

  it('pauses a model whose last three calls for the watch today all failed or were refused', () => {
    expect(AI_WATCH_BREAKER_CALLS).toBe(3)
    const rows = [row(A, 'failed', T - 300), row(A, 'rejected', T - 200), row(A, 'failed', T - 100)]
    expect([...watchPausedModels(rows, T)]).toEqual([A])
    // Whatever order the ledger hands them over in.
    expect([...watchPausedModels([...rows].reverse(), T)]).toEqual([A])
  })

  it('does not pause on two, or when any of the last three was answered', () => {
    expect(watchPausedModels([row(A, 'failed', T - 200), row(A, 'failed', T - 100)], T).size).toBe(0)
    expect(watchPausedModels([row(A, 'failed', T - 300), row(A, 'ok', T - 200), row(A, 'failed', T - 100)], T).size).toBe(0)
    // Three failures, then an answer: the last three are no longer all bad.
    expect(watchPausedModels([row(A, 'failed', T - 400), row(A, 'failed', T - 300), row(A, 'failed', T - 200), row(A, 'ok', T - 100)], T).size).toBe(0)
    // An answer, then three failures: they are.
    expect(watchPausedModels([row(A, 'ok', T - 400), row(A, 'failed', T - 300), row(A, 'failed', T - 200), row(A, 'failed', T - 100)], T).has(A)).toBe(true)
  })

  it('judges each model on its own calls', () => {
    const rows = [row(A, 'failed', T - 300), row(B, 'ok', T - 250), row(A, 'failed', T - 200), row(B, 'ok', T - 150), row(A, 'failed', T - 100)]
    expect([...watchPausedModels(rows, T)]).toEqual([A])
  })

  it('counts only the watch\'s calls, and only since the last UTC midnight', () => {
    const byClick = [row(A, 'failed', T - 300, 'opportunity'), row(A, 'failed', T - 200, 'benchmark'), row(A, 'failed', T - 100, 'opportunity')]
    expect(watchPausedModels(byClick, T).size).toBe(0)
    const yesterday = [row(A, 'failed', MIDNIGHT - 300), row(A, 'failed', MIDNIGHT - 200), row(A, 'failed', MIDNIGHT - 1)]
    expect(watchPausedModels(yesterday, T).size).toBe(0)
    // And a day that began with failures is clear again once the next one has.
    const today = [row(A, 'failed', MIDNIGHT), row(A, 'failed', MIDNIGHT + 60), row(A, 'failed', MIDNIGHT + 120)]
    expect(watchPausedModels(today, T).has(A)).toBe(true)
    expect(watchPausedModels(today, MIDNIGHT + 86_400).size).toBe(0)
  })

  it('refuses a call to a paused model where the money is spent, and says until when', () => {
    const call = { watch: watch(), eventId: event().id, eventTime: T, nowSec: T + 10, takenToday: new Set<string>() }
    expect(watchCallProblem({ ...call, model: A, paused: new Set([A]) })).toBe(
      'openai/gpt-5-mini failed or was refused on its last 3 calls for the watch today, so the watch is not asking it again until midnight UTC.'
    )
    // The other model of the same watch is still asked, about the same event.
    expect(watchCallProblem({ ...call, model: B, paused: new Set([A]) })).toBeNull()
    // Even an event already taken up is not put to a paused model.
    expect(watchCallProblem({ ...call, model: A, takenToday: new Set([event().id]), paused: new Set([A]) })).toMatch(/until midnight UTC/)
    expect(watchCallProblem({ ...call, model: A })).toBeNull()
  })

  it('takes up no event when every model it asks is paused, and still takes one up when one is left', () => {
    const state = { nowSec: T + 10, takenToday: new Set<string>() }
    expect(watchSkipReason(event(), watch(), { ...state, paused: new Set([A]) })).toBeNull()
    expect(watchSkipReason(event(), watch(), { ...state, paused: new Set([A, B]) })).toMatch(/Every model the watch asks/)
    expect(watchSkipReason(event(), watch({ models: [A] }), { ...state, paused: new Set([A]) })).toMatch(/openai\/gpt-5-mini failed or was refused/)
    expect(watchSkipReason(event(), watch(), state)).toBeNull()
  })
})

describe('describeAiWatchCost', () => {
  const models = [
    { model: A, perCallCostUsd: 0.002, costBasis: 'history' as const },
    { model: B, perCallCostUsd: 0.01, costBasis: 'pricing' as const }
  ]
  const input = (overrides: Partial<Parameters<typeof describeAiWatchCost>[0]> = {}): Parameters<typeof describeAiWatchCost>[0] => ({
    watch: watch(),
    models,
    budgetRemainingUsd: 0.8,
    dailyCapUsd: 1,
    scannerOn: true,
    ...overrides
  })

  it('states the most a day can cost: every model, for every event the limit allows', () => {
    const text = describeAiWatchCost(input())
    expect(text).toContain('each urgent event the scanner puts forward is put to 2 models through OpenRouter without a click')
    expect(text).toContain('At most 10 events a day:')
    expect(text).toContain('about $0.002 a call going by its recent calls here')
    expect(text).toContain('about $0.01 a call going by its price list, an estimate')
    // (0.002 + 0.01) x 10.
    expect(text).toContain('At most about $0.12 a day.')
    expect(text).toContain("The daily AI budget of $1.00 still applies, and $0.80 of today's is left.")
    expect(text).toContain('It places nothing real')
    expect(text.trimEnd().endsWith('Switch it on?')).toBe(true)
  })

  it('says the least as well when the first model is asked alone', () => {
    const text = describeAiWatchCost(input({ watch: watch({ firstModelGates: true }) }))
    expect(text).toContain('is asked first, and the other only when it calls a trade.')
    expect(text).toContain('At most about $0.12 a day, if every event is passed on; about $0.02 if none is.')
  })

  it('does not put a figure on a day it cannot price', () => {
    const text = describeAiWatchCost(input({ models: [models[0], { model: B, perCallCostUsd: null, costBasis: 'unknown' }] }))
    expect(text).toContain('cost not known')
    expect(text).toContain('What that can cost in a day is not known')
    expect(text).not.toContain('At most about')
  })

  it('says so when a day of it is more than the daily budget', () => {
    const text = describeAiWatchCost(input({ watch: watch({ maxEventsPerDay: 40 }), dailyCapUsd: 0.3, budgetRemainingUsd: 0.3 }))
    expect(text).toContain('At most about $0.48 a day.')
    expect(text).toContain('That is more than the daily AI budget of $0.30')
    expect(text).toContain('so does everything else that asks a model that day')
  })

  it('names the band when it is not urgent only, and says when the scanner is off', () => {
    const text = describeAiWatchCost(input({ watch: watch({ minBand: 'candidate', models: [A] }), models: [models[0]], scannerOn: false }))
    expect(text).toContain('each event the scanner puts forward is put to 1 model')
    expect(text).toContain('The scanner is off')
    expect(describeAiWatchCost(input())).not.toContain('The scanner is off')
  })
})

describe('watchNotice', () => {
  it('announces a call this app would act on, and says nothing has been placed', () => {
    const notice = watchNotice(event(), decision())
    expect(notice).toMatchObject({ key: event().id, title: 'SOLUSDT: BUY' })
    expect(notice?.body).toContain('at 80% confidence, on the breakout at 12:07 UTC')
    expect(notice?.body).toContain('Nothing has been placed.')
    // Fifteen minutes from the event, not from now.
    expect(notice?.body).toContain('good until 12:22 UTC')
  })

  it('says a short can only be paper traded', () => {
    const short = decision({ recommendation: 'sell', detail: { ...LONG, stopLoss: 101.5, takeProfit: 97 } })
    const notice = watchNotice(event({ type: 'breakdown', direction: 'down' }), short)
    expect(notice?.title).toBe('SOLUSDT: SELL')
    expect(notice?.body).toContain('Nothing has been placed, and a short can only be paper traded.')
  })

  it('announces nothing for no trade, a call below 65%, a refused answer, or one that never arrived', () => {
    expect(watchNotice(event(), decision({ recommendation: 'hold', detail: null }))).toBeNull()
    expect(watchNotice(event(), decision({ confidence: 0.64 }))).toBeNull()
    expect(watchNotice(event(), decision({ rejected: 'The stop is not below the entry range.', recommendation: 'hold', detail: null }))).toBeNull()
    expect(watchNotice(event(), decision({ error: 'timeout' }))).toBeNull()
  })

  it('uses one key an event, so several models calling it raise one notice', () => {
    expect(watchNotice(event(), decision())?.key).toBe(watchNotice(event(), decision({ model: B, confidence: 0.9 }))?.key)
  })
})

describe('a member of a market-wide move', () => {
  const state = (): { nowSec: number; takenToday: ReadonlySet<string> } => ({ nowSec: T + 10, takenToday: new Set<string>() })

  it('is skipped: the move itself is the event the watch asks about', () => {
    const member = event({ live: { ...(event().live as NonNullable<MarketEvent['live']>), marketMove: `binance:BTCUSDT:${T}` } })
    expect(watchSkipReason(member, watch(), state())).toBe('It is part of a market-wide move, which the watch asks about as one event.')
    const move = event({ symbol: 'BTCUSDT', baseAsset: 'BTC', id: `binance:BTCUSDT:${T}`, type: 'market_move' })
    expect(watchSkipReason(move, watch(), state())).toBeNull()
  })
})
