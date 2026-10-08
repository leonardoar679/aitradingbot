import { describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import type { ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import { EV_LINES, calibratedWinRate, describeExpectedValue, expectedValue, expectedValueBlock, tradeExpectedValue, watchOutcomes, type WatchOutcome } from '../shared/expectedValue'

// shared/expectedValue.ts: what a call is worth before a trade is made, at a calibrated win rate
// where the watch's own record allows one, and where it refuses. Each line is tried at it and
// just short of it.

const NOW = Date.parse('2026-10-08T12:00:00Z') / 1000
const A = 'openai/gpt-5-mini'

function trade(id: string, over: { model?: string; side?: 'buy' | 'sell'; pnlQuote?: number | null; closedAt?: number; callId?: string; eventId?: string; exit?: 'take_profit' | 'stop_loss' | 'btc_moved'; mode?: 'paper' | 'live'; type?: 'position' | 'order' } = {}): ExecutorConfig {
  const eventId = over.eventId ?? `binance:${id}USDT:1`
  const result = over.pnlQuote === null ? {} : { result: { exit: over.exit ?? ((over.pnlQuote ?? 1) > 0 ? 'take_profit' : 'stop_loss'), pnlQuote: over.pnlQuote ?? 1, closedAt: over.closedAt ?? NOW - 3600 } }
  return {
    id,
    name: id,
    type: over.type ?? 'position',
    exchange: 'binance',
    symbol: `${id}USDT`,
    baseAsset: id,
    quoteAsset: 'USDT',
    createdAt: NOW - 7200,
    status: 'stopped',
    stoppedAt: NOW - 3600,
    keepPosition: false,
    mode: over.mode ?? 'paper',
    watch: { eventId, eventTime: 1, model: over.model ?? A, confidence: 0.8, ...(over.callId === undefined ? {} : { callId: over.callId }), ...result },
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { side: over.side ?? 'buy', entryPrice: null, amountQuote: 100, takeProfitPct: 3, stopLossPct: 1.5, timeLimitSec: 3600, trailingStop: null } as PositionExecutorParams
  } as ExecutorConfig
}

const row = (id: string, eventId: string, model = A, eventType: string | undefined = 'breakout'): Pick<AiCallRecord, 'id' | 'eventId' | 'model' | 'eventType'> => ({ id, eventId, model, eventType })

function outcomes(count: number, over: Partial<WatchOutcome> = {}): WatchOutcome[] {
  return Array.from({ length: count }, (_, index) => ({ model: A, eventType: 'breakout', side: 'buy', win: index % 2 === 0, closedAt: NOW - 3600 - index * 60, ...over }))
}

describe('the lines', () => {
  it('are ninety days, thirty trades, and the round trip', () => {
    expect(EV_LINES).toEqual({ days: 90, sample: 30, marginPct: 0.24 })
  })
})

describe('the outcomes the rate is read from', () => {
  it("are the watch's closed paper trades, joined to the ledger by the row the mark names, else by the event and the model", () => {
    const executors = [trade('a', { callId: 'c-a', pnlQuote: 2 }), trade('b', { pnlQuote: -1, side: 'sell' }), trade('c', { pnlQuote: 0 })]
    const rows = [row('c-a', 'binance:aUSDT:1', A, 'pump'), row('other', 'binance:bUSDT:1', A, 'dump'), row('x', 'binance:cUSDT:1', 'other/model', 'breakout')]
    expect(watchOutcomes(executors, rows)).toEqual([
      { model: A, eventType: 'pump', side: 'buy', win: true, closedAt: NOW - 3600 },
      { model: A, eventType: 'dump', side: 'sell', win: false, closedAt: NOW - 3600 },
      { model: A, eventType: null, side: 'buy', win: false, closedAt: NOW - 3600 }
    ])
  })

  it('leave out a trade still open, one dropped before it entered, a live executor and anything that is not a position', () => {
    const executors = [trade('open', { pnlQuote: null }), trade('dropped', { pnlQuote: 0, exit: 'btc_moved' }), trade('live', { mode: 'live' }), trade('order', { type: 'order' })]
    expect(watchOutcomes(executors, [])).toEqual([])
  })
})

describe('the calibrated win rate', () => {
  it('is the rate on this model, kind of event and side at thirty or more, else the model over all its events at thirty, else none', () => {
    expect(calibratedWinRate(outcomes(30), { model: A, eventType: 'breakout', side: 'buy' }, NOW)).toEqual({ rate: 0.5, sample: 30, scope: 'event type' })
    expect(calibratedWinRate(outcomes(29), { model: A, eventType: 'breakout', side: 'buy' }, NOW)).toBeNull()
    // Twenty-nine of this kind and ten of another: thirty-nine over all events.
    const mixed = [...outcomes(29), ...outcomes(10, { eventType: 'pump', win: true })]
    expect(calibratedWinRate(mixed, { model: A, eventType: 'breakout', side: 'buy' }, NOW)).toEqual({ rate: (15 + 10) / 39, sample: 39, scope: 'all events' })
    // The side is part of the kind.
    expect(calibratedWinRate(outcomes(30, { side: 'sell' }), { model: A, eventType: 'breakout', side: 'buy' }, NOW)).toEqual({ rate: 0.5, sample: 30, scope: 'all events' })
    expect(calibratedWinRate(outcomes(30), { model: 'other/model', eventType: 'breakout', side: 'buy' }, NOW)).toBeNull()
  })

  it('reads back ninety days and no further, and nothing dated after now', () => {
    const old = outcomes(30, { closedAt: NOW - 91 * 86_400 })
    expect(calibratedWinRate(old, { model: A, eventType: 'breakout', side: 'buy' }, NOW)).toBeNull()
    const edge = outcomes(30, { closedAt: NOW - 90 * 86_400 })
    expect(calibratedWinRate(edge, { model: A, eventType: 'breakout', side: 'buy' }, NOW)?.sample).toBe(30)
    const future = outcomes(30, { closedAt: NOW + 60 })
    expect(calibratedWinRate(future, { model: A, eventType: 'breakout', side: 'buy' }, NOW)).toBeNull()
  })
})

describe('the expected value', () => {
  it('is the win rate times the target less the loss rate times the stop, less the round trip, in percent and in R', () => {
    // 0.55 × 3 − 0.45 × 1.5 − 0.24 = 0.735; over the 1.5% stop, 0.49 R.
    const ev = expectedValue({ winRate: 0.55, stopPct: 1.5, targetPct: 3 })
    expect(ev?.pct).toBeCloseTo(0.735, 10)
    expect(ev?.r).toBeCloseTo(0.49, 10)
    expect(ev?.costsPct).toBeCloseTo(0.24, 10)
    // Half the spread and the trade's own slippage on both fills are part of the round trip.
    expect(expectedValue({ winRate: 0.55, stopPct: 1.5, targetPct: 3, spreadPct: 0.1, slippageRate: 0.0005 })?.costsPct).toBeCloseTo(0.2 + 0.05 + 0.1, 10)
    expect(expectedValue({ winRate: 1, stopPct: 1.5, targetPct: 3 })?.pct).toBeCloseTo(2.76, 10)
    // The model's answers' cost a trade, as a share of the stake, is a cost too (8 October 2026, the V5 document's §73).
    const withAi = expectedValue({ winRate: 0.55, stopPct: 1.5, targetPct: 3, aiCostPct: 0.05 })
    expect(withAi?.costsPct).toBeCloseTo(0.29, 10)
    expect(withAi?.aiCostPct).toBe(0.05)
    expect(withAi?.pct).toBeCloseTo(0.685, 10)
    for (const none of [null, undefined, 0, -1, Number.NaN]) expect(expectedValue({ winRate: 0.55, stopPct: 1.5, targetPct: 3, aiCostPct: none })?.aiCostPct).toBe(0)
    expect(tradeExpectedValue({ confidence: 0.8, calibrated: null, stopPct: 1.5, targetPct: 3, aiCostPct: 0.0512 })).toMatchObject({ pct: 1.81, costsPct: 0.291, aiCostPct: 0.051 })
    expect(expectedValue({ winRate: 0, stopPct: 1.5, targetPct: 3 })?.pct).toBeCloseTo(-1.74, 10)
  })

  it('is nothing without a stop and a target, or a rate between nought and one', () => {
    expect(expectedValue({ winRate: 0.5, stopPct: null, targetPct: 3 })).toBeNull()
    expect(expectedValue({ winRate: 0.5, stopPct: 1.5, targetPct: 0 })).toBeNull()
    expect(expectedValue({ winRate: 1.2, stopPct: 1.5, targetPct: 3 })).toBeNull()
    expect(expectedValue({ winRate: 0.5, stopPct: 1.5, targetPct: 3, spreadPct: Number.NaN, slippageRate: -1 })?.costsPct).toBeCloseTo(0.24, 10)
  })

  it("is read at the calibrated rate where there is one, else at the model's confidence, and says which", () => {
    const calibrated = { rate: 0.55, sample: 41, scope: 'event type' as const }
    expect(tradeExpectedValue({ confidence: 0.8, calibrated, stopPct: 1.5, targetPct: 3 })).toEqual({ pct: 0.74, r: 0.49, basis: 'calibrated', winRate: 0.55, sample: 41, scope: 'event type', costsPct: 0.24, aiCostPct: 0 })
    // 0.8 × 3 − 0.2 × 1.5 − 0.24 = 1.86.
    expect(tradeExpectedValue({ confidence: 0.8, calibrated: null, stopPct: 1.5, targetPct: 3 })).toEqual({ pct: 1.86, r: 1.24, basis: 'confidence', winRate: 0.8, sample: 0, scope: null, costsPct: 0.24, aiCostPct: 0 })
    expect(tradeExpectedValue({ confidence: 0.8, calibrated, stopPct: null, targetPct: 3 })).toBeNull()
  })
})

describe('in words, and as a refusal', () => {
  it('says the value, the rate and what it was measured on', () => {
    expect(describeExpectedValue({ pct: 0.74, r: 0.49, basis: 'calibrated', winRate: 0.55, sample: 41, scope: 'event type' }, 'breakout')).toBe('EV +0.74% (+0.49 R) at a 55% calibrated win rate on 41 breakout events.')
    expect(describeExpectedValue({ pct: -0.2, r: -0.13, basis: 'calibrated', winRate: 0.4, sample: 35, scope: 'all events' }, 'pump')).toBe('EV -0.20% (-0.13 R) at a 40% calibrated win rate on 35 of its trades, all events.')
    expect(describeExpectedValue({ pct: 1.86, r: 1.24, basis: 'confidence', winRate: 0.8, sample: 0, scope: null }, 'breakout')).toBe("EV +1.86% (+1.24 R) at the model's own 80% confidence; no calibrated win rate yet.")
    expect(describeExpectedValue({ pct: 0.5, r: null, basis: 'calibrated', winRate: 0.6, sample: 30, scope: 'event type' }, 'something_else')).toBe('EV +0.50% at a 60% calibrated win rate on 30 events of this kind.')
    // The costs are named only where the model's answers are in them.
    expect(describeExpectedValue({ pct: 1.81, r: 1.21, basis: 'confidence', winRate: 0.8, sample: 0, scope: null, costsPct: 0.291, aiCostPct: 0.051 }, 'breakout')).toBe(
      "EV +1.81% (+1.21 R) at the model's own 80% confidence; no calibrated win rate yet. Net of costs of 0.29%, of which the model's answers 0.05% of the stake."
    )
    expect(describeExpectedValue({ pct: 0.74, r: 0.49, basis: 'calibrated', winRate: 0.55, sample: 41, scope: 'event type', costsPct: 0.24, aiCostPct: 0 }, 'breakout')).toBe('EV +0.74% (+0.49 R) at a 55% calibrated win rate on 41 breakout events.')
  })

  it('refuses only at a calibrated rate under the round trip, never at the confidence, and not at the line', () => {
    expect(expectedValueBlock({ pct: 0.23, r: 0.15, basis: 'calibrated', winRate: 0.5, sample: 30, scope: 'event type' })).toBe('Its expected value is +0.23% at the calibrated win rate (50% on 30 trades of this kind), under the 0.24% a round trip costs.')
    expect(expectedValueBlock({ pct: -1.74, r: -1.16, basis: 'calibrated', winRate: 0, sample: 35, scope: 'all events' })).toBe('Its expected value is -1.74% at the calibrated win rate (0% on 35 of its trades), under the 0.24% a round trip costs.')
    expect(expectedValueBlock({ pct: 0.24, r: 0.16, basis: 'calibrated', winRate: 0.5, sample: 30, scope: 'event type' })).toBeNull()
    expect(expectedValueBlock({ pct: -5, r: -3, basis: 'confidence', winRate: 0.7, sample: 0, scope: null })).toBeNull()
    expect(expectedValueBlock(null)).toBeNull()
  })
})
