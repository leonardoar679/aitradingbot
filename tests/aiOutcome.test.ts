import { describe, expect, it } from 'vitest'
import {
  MIN_SCORED_CALLS,
  OUTCOME_PRIMARY_BARS,
  scoreCall,
  scoreCalls,
  summarizeOutcomes,
  type AiOutcome,
  type ScorableCall
} from '../shared/aiOutcome'
import type { AiCallRecord } from '../shared/aiLedger'
import type { Candle } from '../shared/ipc'

const BAR = 900
const T0 = 1_700_000_100

/** Candles whose closes are given outright, with highs and lows hugging them unless stated. */
function candles(closes: number[], wicks: Record<number, { high?: number; low?: number }> = {}): Candle[] {
  return closes.map((close, i) => ({
    time: T0 + i * BAR,
    open: close,
    high: wicks[i]?.high ?? close,
    low: wicks[i]?.low ?? close,
    close,
    volume: 1
  }))
}

function call(overrides: Partial<ScorableCall> = {}): ScorableCall {
  return { candleTime: T0, recommendation: 'buy', stopLoss: null, takeProfit: null, horizonBars: 16, ...overrides }
}

/** 100 at the execution candle, then `after` for every later bar. */
function flatThen(after: number, bars = 100): Candle[] {
  return candles([100, ...new Array<number>(bars).fill(after)])
}

function forwardAt(outcome: AiOutcome, bars: number): number | null {
  return outcome.forward.find((entry) => entry.bars === bars)?.returnPct ?? null
}

describe('scoreCall', () => {
  it('measures from the close of the execution candle, which is where the engine fills', () => {
    const outcome = scoreCall(call(), candles([100, 101, 102, 103, 104, ...new Array<number>(100).fill(110)]), 0)
    expect(outcome.referencePrice).toBe(100)
    expect(forwardAt(outcome, 1)).toBeCloseTo(1, 10)
    expect(forwardAt(outcome, 4)).toBeCloseTo(4, 10)
    expect(forwardAt(outcome, 16)).toBeCloseTo(10, 10)
    expect(forwardAt(outcome, 96)).toBeCloseTo(10, 10)
  })

  it('leaves a horizon unscored until that many bars have actually closed', () => {
    const outcome = scoreCall(call(), candles([100, 101, 102, 103, 104, 105]), 0)
    expect(forwardAt(outcome, 4)).toBeCloseTo(4, 10)
    expect(forwardAt(outcome, 16)).toBeNull()
    expect(outcome.correct).toBeNull()
    // The excursion is over the whole primary horizon or it is nothing: a "worst move so far"
    // that can only get worse is not a figure to print beside finished ones.
    expect(outcome.bestPct).toBeNull()
    expect(outcome.worstPct).toBeNull()
  })

  it('returns nothing at all when the execution candle is not in the candles', () => {
    const outcome = scoreCall(call(), candles([100, 101]), -1)
    expect(outcome.referencePrice).toBeNull()
    expect(outcome.correct).toBeNull()
    expect(outcome.forward.every((entry) => entry.returnPct === null)).toBe(true)
  })

  it('takes the best and worst move from highs and lows, not closes', () => {
    const outcome = scoreCall(call(), candles([100, ...new Array<number>(20).fill(100)], { 3: { high: 107 }, 9: { low: 94 } }), 0)
    expect(outcome.bestPct).toBeCloseTo(7, 10)
    expect(outcome.worstPct).toBeCloseTo(-6, 10)
  })

  describe('whether the call was right', () => {
    it('requires a buy to clear the round-trip cost, not merely to rise', () => {
      // 0.24% is what a round trip costs. A buy followed by +0.2% is a losing trade.
      expect(scoreCall(call(), flatThen(100.2), 0).correct).toBe(false)
      expect(scoreCall(call(), flatThen(100.5), 0).correct).toBe(true)
      expect(scoreCall(call(), flatThen(99), 0).correct).toBe(false)
    })

    it('counts a sell as right when price is lower afterwards', () => {
      expect(scoreCall(call({ recommendation: 'sell' }), flatThen(99.9), 0).correct).toBe(true)
      expect(scoreCall(call({ recommendation: 'sell' }), flatThen(100.1), 0).correct).toBe(false)
    })

    it('does not score a hold, which claims nothing', () => {
      expect(scoreCall(call({ recommendation: 'hold' }), flatThen(120), 0).correct).toBeNull()
      expect(scoreCall(call({ recommendation: null }), flatThen(120), 0).correct).toBeNull()
    })

    it('is judged at the four-hour horizon whatever the model named', () => {
      const path = candles([100, ...new Array<number>(15).fill(90), ...new Array<number>(90).fill(105)])
      expect(forwardAt(scoreCall(call(), path, 0), OUTCOME_PRIMARY_BARS)).toBeCloseTo(5, 10)
      expect(scoreCall(call({ horizonBars: 1 }), path, 0).correct).toBe(true)
    })
  })

  describe("the model's own levels", () => {
    const levels = { stopLoss: 97, takeProfit: 106 }

    it('reports the target when it is reached first', () => {
      const path = candles([100, 101, 102, ...new Array<number>(30).fill(103)], { 2: { high: 106.5 } })
      expect(scoreCall(call(levels), path, 0).barrier).toBe('take_profit')
    })

    it('reports the stop when it is reached first', () => {
      const path = candles([100, 99, 98, ...new Array<number>(30).fill(110)], { 2: { low: 96.5 } })
      expect(scoreCall(call(levels), path, 0).barrier).toBe('stop_loss')
    })

    it('assumes the stop when one bar touches both', () => {
      // The order inside a candle is unknowable from OHLC. Assuming the favourable order would let
      // a model look right on every wide bar; the engine makes the same pessimistic assumption.
      const path = candles([100, ...new Array<number>(30).fill(100)], { 1: { high: 107, low: 96 } })
      expect(scoreCall(call(levels), path, 0).barrier).toBe('stop_loss')
    })

    it('reports neither once the horizon the model named has passed untouched', () => {
      expect(scoreCall(call({ ...levels, horizonBars: 4 }), flatThen(101, 10), 0).barrier).toBe('neither')
    })

    it('stays pending while that horizon is still open', () => {
      expect(scoreCall(call({ ...levels, horizonBars: 16 }), flatThen(101, 5), 0).barrier).toBe('pending')
    })

    it('only looks inside the horizon the model named', () => {
      const path = candles([100, ...new Array<number>(30).fill(100)], { 10: { high: 107 } })
      expect(scoreCall(call({ ...levels, horizonBars: 4 }), path, 0).barrier).toBe('neither')
      expect(scoreCall(call({ ...levels, horizonBars: 16 }), path, 0).barrier).toBe('take_profit')
    })

    it('has nothing to report without levels, or for a call that is not a buy', () => {
      expect(scoreCall(call(), flatThen(101), 0).barrier).toBe('no_levels')
      expect(scoreCall(call({ ...levels, recommendation: 'sell' }), flatThen(101), 0).barrier).toBe('no_levels')
    })
  })
})

function row(overrides: Partial<AiCallRecord>): AiCallRecord {
  return {
    id: 'id',
    at: T0,
    source: 'backtest',
    status: 'ok',
    model: 'a/model',
    provider: null,
    promptVersion: 'p',
    contextVersion: 'c',
    schemaVersion: 's',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: '15m',
    candleTime: T0,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0 },
    error: null,
    recommendation: 'buy',
    confidence: 0.75,
    rationale: '',
    detail: null,
    ...overrides
  }
}

describe('scoreCalls', () => {
  it('scores each row against its own candle and leaves a missing one unscored', () => {
    const path = flatThen(101)
    const outcomes = scoreCalls(
      [row({ id: 'here', candleTime: T0 }), row({ id: 'elsewhere', candleTime: T0 - 5 * BAR })],
      path
    )
    expect(outcomes.get('here')?.correct).toBe(true)
    expect(outcomes.get('elsewhere')?.referencePrice).toBeNull()
  })

  it('does not score a refused or failed row as though it had made a call', () => {
    const outcomes = scoreCalls([row({ id: 'refused', status: 'rejected', recommendation: null })], flatThen(101))
    expect(outcomes.get('refused')?.correct).toBeNull()
  })
})

describe('summarizeOutcomes', () => {
  /** `count` buys by one model, `right` of them correct, all at one confidence. */
  function buys(model: string, count: number, right: number, confidence = 0.75): { rows: AiCallRecord[]; outcomes: Map<string, AiOutcome> } {
    const rows: AiCallRecord[] = []
    const outcomes = new Map<string, AiOutcome>()
    for (let i = 0; i < count; i++) {
      const id = `${model}-${confidence}-${i}`
      rows.push(row({ id, model, confidence }))
      outcomes.set(id, scoreCall(call(), flatThen(i < right ? 101 : 99), 0))
    }
    return { rows, outcomes }
  }

  it('withholds a hit rate below thirty scored calls, and still shows the count', () => {
    const few = buys('a/model', MIN_SCORED_CALLS - 1, 20)
    const [score] = summarizeOutcomes(few.rows, few.outcomes)
    expect(score.scored).toBe(MIN_SCORED_CALLS - 1)
    expect(score.hits).toBe(20)
    expect(score.hitRatePct).toBeNull()
    expect(score.meanBuyReturnPct).toBeNull()
  })

  it('reports it from thirty', () => {
    const enough = buys('a/model', 40, 30)
    const [score] = summarizeOutcomes(enough.rows, enough.outcomes)
    expect(score.hitRatePct).toBeCloseTo(75, 10)
    // 30 buys followed by +1%, 10 by -1%.
    expect(score.meanBuyReturnPct).toBeCloseTo(0.5, 10)
  })

  it('counts holds as decisions but not as calls', () => {
    const acted = buys('a/model', 10, 10)
    const holds = Array.from({ length: 30 }, (_, i) => row({ id: `hold-${i}`, recommendation: 'hold' }))
    const [score] = summarizeOutcomes([...acted.rows, ...holds], acted.outcomes)
    expect(score.decisions).toBe(40)
    expect(score.acted).toBe(10)
    expect(score.actRatePct).toBeCloseTo(25, 10)
    expect(score.scored).toBe(10)
  })

  it('leaves out refused and failed rows, and calls that are still pending', () => {
    const acted = buys('a/model', 5, 5)
    const pendingId = 'pending'
    acted.outcomes.set(pendingId, scoreCall(call(), flatThen(101, 3), 0))
    const [score] = summarizeOutcomes(
      [
        ...acted.rows,
        row({ id: pendingId }),
        row({ id: 'refused', status: 'rejected', recommendation: null, confidence: null }),
        row({ id: 'failed', status: 'failed', recommendation: null, confidence: null })
      ],
      acted.outcomes
    )
    expect(score.decisions).toBe(6)
    expect(score.acted).toBe(6)
    expect(score.scored).toBe(5)
  })

  it('keeps each model apart', () => {
    const a = buys('a/model', 30, 30)
    const b = buys('b/model', 30, 0)
    const scores = summarizeOutcomes([...a.rows, ...b.rows], new Map([...a.outcomes, ...b.outcomes]))
    expect(scores.find((score) => score.model === 'a/model')?.hitRatePct).toBe(100)
    expect(scores.find((score) => score.model === 'b/model')?.hitRatePct).toBe(0)
  })

  // Whether a model's confidence means anything is exactly what this table is for: a model whose
  // 0.9 calls are right no more often than its 0.6 calls is reporting a number with nothing in it.
  it('groups hit rate by confidence, and withholds a thin bucket', () => {
    const sure = buys('a/model', 12, 12, 0.95)
    const unsure = buys('a/model', 12, 3, 0.55)
    const thin = buys('a/model', 4, 4, 0.75)
    const [score] = summarizeOutcomes(
      [...sure.rows, ...unsure.rows, ...thin.rows],
      new Map([...sure.outcomes, ...unsure.outcomes, ...thin.outcomes])
    )
    const bucket = (from: number) => score.calibration.find((entry) => entry.from === from)!
    expect(bucket(0.9).scored).toBe(12)
    expect(bucket(0.9).hitRatePct).toBe(100)
    expect(bucket(0.5).hitRatePct).toBe(25)
    expect(bucket(0.7).scored).toBe(4)
    expect(bucket(0.7).hitRatePct).toBeNull()
    // A confidence of exactly 1 belongs to the top bucket rather than falling off the end.
    const top = buys('a/model', 1, 1, 1)
    expect(summarizeOutcomes(top.rows, top.outcomes)[0].calibration.find((entry) => entry.from === 0.9)?.scored).toBe(1)
  })
})
