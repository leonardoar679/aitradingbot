import { describe, expect, it } from 'vitest'
import type { AiSignalDecision } from '../shared/aiSignal'
import { RESTART_REFUSAL_TEXT, answeredBeforeStart, restartMisses, type AnsweredRow } from '../shared/restartMisses'

// The record whole across a restart (shared/restartMisses.ts; the V5 document, §94): an event with
// an answer to act on, no trade and no refusal is written as a refusal at stage `restart`; one
// traded, refused, held, split, or answered since this start is not.

const T = 1_791_500_000

const decision = (model: string, recommendation: 'buy' | 'sell' | 'hold', confidence = 0.8, patch: Partial<AiSignalDecision> = {}): AiSignalDecision => ({
  candleTime: T - 60,
  recommendation,
  confidence,
  rationale: 'because',
  model,
  cached: false,
  error: null,
  callId: `call-${model}-${recommendation}`,
  detail: recommendation === 'hold' ? null : { entry: { min: 99, max: 101 }, stopLoss: 97, takeProfit: 105, validMinutes: 15, horizonBars: 4, marketRegime: 'neutral', riskLevel: 'medium', reasonCodes: [] },
  ...patch
})

describe('restartMisses', () => {
  it('writes a refusal at stage restart for an answer to act on with no trade and no refusal, in words that say why', () => {
    const out = restartMisses({
      answered: [{ eventId: 'binance:SOLUSDT:1791499000', symbol: 'SOLUSDT', decisions: [decision('a/one', 'buy')] }],
      traded: new Set(),
      refused: new Set(),
      nowSec: T
    })
    expect(out).toEqual([
      {
        id: 'binance:SOLUSDT:1791499000:restart:1791500000',
        at: T,
        source: 'watch',
        symbol: 'SOLUSDT',
        text: RESTART_REFUSAL_TEXT,
        eventId: 'binance:SOLUSDT:1791499000',
        model: 'a/one',
        callId: 'call-a/one-buy',
        side: 'buy',
        stage: 'restart'
      }
    ])
    expect(RESTART_REFUSAL_TEXT).toBe('No paper trade: the app was not running when it could have been entered.')
    expect(restartMisses({ answered: [{ eventId: 'e', symbol: 'SOLUSDT', decisions: [decision('a/one', 'sell')] }], traded: new Set(), refused: new Set(), nowSec: T })[0].side).toBe('sell')
  })

  it('writes nothing for an event traded, refused, held, below the confidence it acts on, or split', () => {
    const buy = [decision('a/one', 'buy')]
    const base = { traded: new Set<string>(), refused: new Set<string>(), nowSec: T }
    expect(restartMisses({ ...base, answered: [{ eventId: 'e', symbol: 'S', decisions: buy }], traded: new Set(['e']) })).toEqual([])
    expect(restartMisses({ ...base, answered: [{ eventId: 'e', symbol: 'S', decisions: buy }], refused: new Set(['e']) })).toEqual([])
    expect(restartMisses({ ...base, answered: [{ eventId: 'e', symbol: 'S', decisions: [decision('a/one', 'hold')] }] })).toEqual([])
    expect(restartMisses({ ...base, answered: [{ eventId: 'e', symbol: 'S', decisions: [decision('a/one', 'buy', 0.3)] }] })).toEqual([])
    expect(restartMisses({ ...base, answered: [{ eventId: 'e', symbol: 'S', decisions: [decision('a/one', 'buy'), decision('b/two', 'sell'), decision('c/three', 'hold')] }] })).toEqual([])
    // A rejected answer is not one to act on.
    expect(restartMisses({ ...base, answered: [{ eventId: 'e', symbol: 'S', decisions: [decision('a/one', 'buy', 0.8, { rejected: 'malformed' })] }] })).toEqual([])
  })

  it('follows the vote where more than one model answered: the agreeing model with the highest confidence', () => {
    const out = restartMisses({
      answered: [{ eventId: 'e', symbol: 'S', decisions: [decision('a/one', 'buy', 0.7), decision('b/two', 'buy', 0.9), decision('c/three', 'hold')] }],
      traded: new Set(),
      refused: new Set(),
      nowSec: T
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ model: 'b/two', callId: 'call-b/two-buy', side: 'buy', stage: 'restart' })
    // Two of three on one side with none opposite trades; one of three does not.
    expect(
      restartMisses({ answered: [{ eventId: 'e', symbol: 'S', decisions: [decision('a/one', 'buy'), decision('b/two', 'hold'), decision('c/three', 'hold')] }], traded: new Set(), refused: new Set(), nowSec: T })
    ).toEqual([])
  })

  it('writes one refusal per event, however many times it is listed', () => {
    const answered = [
      { eventId: 'e', symbol: 'S', decisions: [decision('a/one', 'buy')] },
      { eventId: 'e', symbol: 'S', decisions: [decision('a/one', 'buy')] }
    ]
    expect(restartMisses({ answered, traded: new Set(), refused: new Set(), nowSec: T })).toHaveLength(1)
  })
})

describe('answeredBeforeStart', () => {
  const row = (eventId: string, model: string, at: number, recommendation: 'buy' | 'hold' = 'buy', status = 'ok'): AnsweredRow => ({
    eventId,
    symbol: 'SOLUSDT',
    model,
    status,
    at,
    decision: decision(model, recommendation)
  })

  it('keeps the first answer a model gave for an event, leaves a failed call and a row since this start, and groups by event', () => {
    const rows = [row('e1', 'a/one', T - 300), row('e1', 'a/one', T - 200, 'hold'), row('e1', 'b/two', T - 250), row('e2', 'a/one', T - 100, 'buy', 'failed'), row('e3', 'a/one', T + 5)]
    const answered = answeredBeforeStart(rows, T)
    expect(answered).toEqual([{ eventId: 'e1', symbol: 'SOLUSDT', decisions: [decision('a/one', 'buy'), decision('b/two', 'buy')] }])
    // Exactly at the start is this run's.
    expect(answeredBeforeStart([row('e4', 'a/one', T)], T)).toEqual([])
    expect(answeredBeforeStart([row('e4', 'a/one', T - 1)], T)).toHaveLength(1)
  })

  it('reads the rows in time order whatever order they came in', () => {
    const rows = [row('e1', 'a/one', T - 100, 'hold'), row('e1', 'a/one', T - 300, 'buy')]
    expect(answeredBeforeStart(rows, T)[0].decisions[0].recommendation).toBe('buy')
  })
})
