import { describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import { AI_OPPORTUNITY_PROMPT_VERSION } from '../shared/aiOpportunity'
import type { WatchPaperOutcome } from '../shared/aiWatchPaper'
import type { Candle, ExecutorConfig } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import { describeTracePrices, traceWatchTrade, type TradeFill, type WatchTradeRecords } from '../shared/tradeLifecycle'
import { loadWatchTradeRecords, parseEventId, type TimelineDeps } from '../src/agents/watchTradeRecords'

// One trade's whole story (shared/tradeLifecycle.ts): the event, each model's answer, the paper
// position the watch opened, where it filled and how it ended -- joined by the ids that already
// link the records, with nothing new stored and nothing guessed.

const T = Date.parse('2026-09-10T12:07:00Z') / 1000
const EVENT_ID = `binance:SOLUSDT:${T}`

function event(overrides: Partial<MarketEvent> = {}): MarketEvent {
  return {
    id: EVENT_ID,
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

function call(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    id: 'a',
    at: T + 25,
    source: 'watch',
    status: 'ok',
    model: 'acme/follower',
    provider: 'Acme',
    promptVersion: AI_OPPORTUNITY_PROMPT_VERSION,
    contextVersion: 'context-v1',
    schemaVersion: 'opportunity-schema-v1',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    interval: '15m',
    candleTime: T,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.003, latencyMs: 9_400 },
    error: null,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range.',
    detail: {
      marketRegime: 'bull',
      riskLevel: 'medium',
      horizonBars: 4,
      stopLoss: 98.5,
      takeProfit: 103,
      reasonCodes: ['breakout'],
      levelsNote: null,
      entry: { min: 99.8, max: 100.2, validMinutes: 15 }
    },
    eventId: EVENT_ID,
    eventType: 'breakout',
    ...overrides
  }
}

function watchTrade(overrides: Partial<ExecutorConfig> = {}, result: WatchPaperOutcome | null = { exit: 'take_profit', pnlQuote: 3.79, closedAt: T + 1500 }): ExecutorConfig {
  return {
    id: 'ex1',
    name: 'Watch SOLUSDT',
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: T + 60,
    status: 'stopped',
    stoppedAt: T + 1560,
    keepPosition: false,
    mode: 'paper',
    watch: { eventId: EVENT_ID, eventTime: T, model: 'acme/follower', confidence: 0.8, ...(result === null ? {} : { result }) },
    params: {
      side: 'buy',
      entryPrice: null,
      amountQuote: 100,
      takeProfitPct: 3,
      stopLossPct: 1.5,
      timeLimitSec: 3600,
      trailingStop: null,
      entryExpiresAt: T + 960,
      entryRange: { min: 99.8, max: 100.2 }
    },
    ...overrides
  } as ExecutorConfig
}

const FILL: TradeFill = { status: 'closed', enteredAt: T + 180, entryPrice: 100.1, exitReason: 'take_profit', closedAt: T + 1500, realizedPnl: 3.79 }

function records(overrides: Partial<WatchTradeRecords> = {}): WatchTradeRecords {
  return {
    eventId: EVENT_ID,
    model: 'acme/follower',
    event: event(),
    calls: [call({ id: 'b', at: T + 40, model: 'acme/contrarian', status: 'rejected', recommendation: null, confidence: null, error: 'its stop was above its entry', detail: null }), call()],
    executor: watchTrade(),
    fill: FILL,
    ...overrides
  }
}

describe("one trade's timeline", () => {
  it('tells it in order: the event, each answer, the plan, the fill, the close', () => {
    const trace = traceWatchTrade(records())
    expect(trace.steps.map((step) => step.label)).toEqual(['Event raised', 'acme/follower', 'acme/contrarian', 'Paper position opened', 'Entered', 'Closed'])
    const times = trace.steps.map((step) => step.at).filter((at): at is number => at !== null)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(trace.steps[0].detail).toBe('SOLUSDT breakout, score 91 (urgent), ranked 1 in its minute, at a price of 100.')
    expect(trace.steps[1].detail).toBe('BUY at 80% in 9.4s, asked by the watch.')
    expect(trace.steps[2].detail).toBe('answered, and the answer was refused: its stop was above its entry.')
    expect(trace.steps[3].detail).toBe(
      "BUY 100 USDT on acme/follower's call at 80%, entering between 99.8 and 100.2 until 12:23:00 UTC, stop 1.5% and target 3% from the fill, held at most 1 hour. Paper: nothing real was placed."
    )
    expect(trace.steps[4].detail).toBe('Filled at 100.1.')
    expect(trace.steps[5].detail).toContain('after fees.')
  })

  it('sets the three prices side by side, and keeps the ids that joined them', () => {
    const trace = traceWatchTrade(records())
    expect(trace.prices).toEqual({ atEvent: 100, rangeMin: 99.8, rangeMax: 100.2, fill: 100.1 })
    expect(trace.ids).toEqual({ eventId: EVENT_ID, callIds: ['a', 'b'], executorId: 'ex1' })
    expect(trace.lifecycle.outcome).toEqual({ exit: 'take_profit', pnlQuote: 3.79, closedAt: T + 1500 })
  })

  it('says an entry that never traded never entered', () => {
    const trace = traceWatchTrade(records({ executor: watchTrade({}, { exit: 'entry_expired', pnlQuote: 0, closedAt: T + 960 }), fill: { ...FILL, status: 'closed', enteredAt: null, entryPrice: null, exitReason: 'entry_expired' } }))
    expect(trace.steps.at(-1)).toMatchObject({ label: 'Never entered', tone: 'muted' })
    expect(trace.prices.fill).toBeNull()
  })

  it('names the version a provider served when it is not the one asked for', () => {
    const trace = traceWatchTrade(records({ calls: [call({ servedModel: 'acme/follower-2026-09' })] }))
    expect(trace.steps[1].detail).toBe('BUY at 80%, served as acme/follower-2026-09 in 9.4s, asked by the watch.')
  })

  it('says a call under the line was not acted on', () => {
    const trace = traceWatchTrade(records({ calls: [call({ confidence: 0.55 })], executor: null, fill: null }))
    expect(trace.steps[1].detail).toBe('BUY at 55% in 9.4s, asked by the watch: under the 65% this app acts at.')
    expect(trace.steps.at(-1)).toEqual({ at: null, label: 'No paper position', detail: 'None: this was not a call this app acts on.', tone: 'muted' })
  })

  it('does not guess why no paper position was opened on a call the app would act on', () => {
    const trace = traceWatchTrade(records({ executor: null, fill: null }))
    expect(trace.steps.at(-1)?.label).toBe('No paper position')
    expect(trace.steps.at(-1)?.detail).toContain('which one was not recorded')
    expect(trace.prices).toEqual({ atEvent: 100, rangeMin: 99.8, rangeMax: 100.2, fill: null })
  })

  it('says when the event is no longer on file, and still tells the rest', () => {
    const trace = traceWatchTrade(records({ event: null }))
    expect(trace.steps[0]).toMatchObject({ at: T, label: 'Event raised', detail: `${EVENT_ID}: no longer among the events on file.` })
    expect(trace.prices.atEvent).toBe(100)
  })

  it('says a position stopped by hand before it closed was stopped by hand', () => {
    const trace = traceWatchTrade(records({ executor: watchTrade({}, null), fill: { ...FILL, status: 'open', exitReason: null, closedAt: null, realizedPnl: null } }))
    expect(trace.steps.at(-1)).toMatchObject({ label: 'Stopped', detail: 'Stopped by hand before its position had closed.' })
  })

  it('says when the model it follows gave no answer at all', () => {
    const trace = traceWatchTrade(records({ calls: [call({ model: 'acme/contrarian' })], executor: null, fill: null }))
    expect(trace.steps.at(-1)?.detail).toBe('None: acme/follower gave no answer to act on.')
    expect(traceWatchTrade(records({ calls: [], executor: null, fill: null })).steps.map((step) => step.label)).toEqual(['Event raised', 'No answer', 'No paper position'])
  })
})

describe('the three prices, in words', () => {
  const PENDING: TradeFill = { status: 'pending', enteredAt: null, entryPrice: null, exitReason: null, closedAt: null, realizedPnl: null }
  const say = (overrides: Partial<WatchTradeRecords>): string => describeTracePrices(traceWatchTrade(records(overrides)))

  it('sets them side by side', () => {
    expect(say({})).toBe('Price the model saw: 100 · range it named: 99.8 – 100.2 · fill: 100.1.')
  })

  it('says why there is no fill rather than "none yet"', () => {
    expect(say({ executor: null, fill: null })).toContain('fill: none, as no paper position was opened.')
    expect(say({ executor: watchTrade({}, { exit: 'entry_expired', pnlQuote: 0, closedAt: T + 960 }), fill: { ...PENDING, status: 'closed', exitReason: 'entry_expired' } })).toContain(
      'fill: none, as it never entered.'
    )
    // Either record is enough to say it never entered: what the watch wrote when it stopped it,
    // or the candles before the watch has got to it.
    expect(say({ executor: watchTrade({}, { exit: 'entry_expired', pnlQuote: 0, closedAt: T + 960 }), fill: null })).toContain('fill: none, as it never entered.')
    expect(say({ executor: watchTrade({ status: 'active', stoppedAt: null }, null), fill: { ...PENDING, status: 'closed', exitReason: 'entry_expired' } })).toContain(
      'fill: none, as it never entered.'
    )
    expect(say({ fill: null })).toContain('fill: not worked out, as its candles could not be read.')
    expect(say({ executor: watchTrade({}, null), fill: PENDING })).toContain('fill: none, as it was stopped before it entered.')
    expect(say({ executor: watchTrade({ status: 'active', stoppedAt: null }, null), fill: PENDING })).toContain('fill: none yet.')
  })

  it('says when there is no price on file and no range named', () => {
    expect(say({ event: null, calls: [], executor: null, fill: null })).toBe('Price the model saw: not on file · range it named: none · fill: none, as no paper position was opened.')
  })
})

describe('reading one trade by its ids', () => {
  const flat = (time: number, price: number): Candle => ({ time, open: price, high: price, low: price, close: price, volume: 1 })
  const deps = (executors: ExecutorConfig[]): TimelineDeps => ({
    listEvents: async () => ({ rows: [event({ id: 'binance:SOLUSDT:1', time: T - 600 }), event()], skippedLines: 0 }),
    listCalls: async () => ({ rows: [call(), call({ id: 'other', eventId: 'binance:SOLUSDT:1' })], skippedLines: 0 }),
    listExecutors: async () => executors,
    // Above the range for two minutes, then in it.
    fetchCandles: async () => [flat(T + 60, 101), flat(T + 120, 101), { time: T + 180, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1 }, flat(T + 240, 100), flat(T + 300, 100)],
    nowSec: () => T + 4000
  })

  it('finds the event, its answers and the paper position by their ids, and works out where it filled', async () => {
    const live = watchTrade({ id: 'live', mode: 'live' })
    const read = await loadWatchTradeRecords(EVENT_ID, 'acme/follower', null, deps([live, watchTrade()]))
    expect(read.event?.id).toBe(EVENT_ID)
    expect(read.calls.map((row) => row.id)).toEqual(['a'])
    // A live executor carrying the same mark is never one of the watch's: it cannot make one.
    expect(read.executor?.id).toBe('ex1')
    expect(read.fill).toMatchObject({ enteredAt: T + 180, entryPrice: 100 })
  })

  it('reads no paper position for a model the watch did not follow', async () => {
    const read = await loadWatchTradeRecords(EVENT_ID, 'acme/contrarian', null, deps([watchTrade()]))
    expect(read.executor).toBeNull()
    expect(read.fill).toBeNull()
  })

  it('takes an event id apart, and refuses one it cannot', () => {
    expect(parseEventId('binance:BTCUSDT:1791187260')).toEqual({ symbol: 'BTCUSDT', time: 1791187260 })
    expect(parseEventId('nonsense')).toBeNull()
    expect(parseEventId('binance::12')).toBeNull()
  })
})
