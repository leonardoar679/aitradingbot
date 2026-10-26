import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import {
  SOURCE_RECORD_LINES,
  SOURCE_RECORD_VERSION,
  dayUnitOf,
  dueAt,
  hourUnitOf,
  readSourceOutcome,
  readSourcePrediction,
  sourceFiguresOf,
  sourceOutcomeOf,
  sourcePredictionId,
  type SourcePrediction
} from '../shared/evaluation/predictionRecord'

// ONE RECORD FOR EVERY PREDICTION THAT IS NOT THE FORECAST'S OWN (shared/evaluation/predictionRecord.ts; V8 Stage 2):
// a prediction scored from its venue's one-minute bars -- its way, its size, its target's touch, its net after the
// route's cost -- and a source's figures read with intervals by its own unit of evidence.

const MADE = 1_792_000_040 // 20 seconds into a minute
const REF = 100

function prediction(over: Partial<SourcePrediction> = {}): SourcePrediction {
  return {
    v: SOURCE_RECORD_VERSION,
    id: sourcePredictionId('delisting-rule', 'XYZUSDT', MADE),
    source: 'delisting-rule',
    sourceVersion: 'delisting-card-v1',
    kind: 'direction',
    pair: 'XYZUSDT',
    venue: 'binance',
    madeAt: MADE,
    bar: null,
    horizonSec: 600,
    refPrice: REF,
    side: 'down',
    movePct: 5,
    targetPrice: 95,
    window: { fromSec: 0, toSec: 600 },
    dist: { pRight: 0.86, q: null, pMove: null },
    scenarios: { upPct: 15, downPct: -20, worstPct: -80 },
    cost: { roundTripPct: 0.4, basis: 'book', stakeQuote: 100 },
    expectedNet: { pct: 10, low: 6, high: 14 },
    reason: 'Binance announced the delisting.',
    evidence: ['287557'],
    unit: hourUnitOf(MADE),
    versions: { engine: 'e', config: 'c' },
    ...over
  }
}

/** One-minute bars from the minute after MADE: closes as given, each bar's high and low a step either side. */
function bars(closes: number[], first = Math.ceil(MADE / 60) * 60, swing = 0.5): Candle[] {
  return closes.map((close, k) => ({ time: first + k * 60, open: close, high: close + swing, low: close - swing, close, volume: 1 }))
}

describe('a prediction scored', () => {
  it('says a short right when the price fell, by how much its size was off, when it touched its target, and its net', () => {
    // Ten minutes: down to 94 by the fourth, closing at 96.
    const outcome = sourceOutcomeOf(prediction(), bars([99, 97, 95.4, 94, 95, 96, 96, 96, 96, 96]), dueAt(prediction()) + 60)
    expect(outcome).toMatchObject({ status: 'settled', closePrice: 96, right: true, touched: true })
    expect(outcome.movePct).toBeCloseTo(-4, 10)
    // In the call's favour it made 4%, against the 5% said: a size error of -1.
    expect(outcome.sizeErrorPct).toBeCloseTo(-1, 10)
    // The target of 95 was touched on the third bar (its low 94.9), 160 seconds after the call.
    expect(outcome.touchSec).toBe(Math.ceil(MADE / 60) * 60 + 120 - MADE)
    expect(outcome.netPct).toBeCloseTo(4 - 0.4, 10)
    expect(outcome.bestPct).toBeCloseTo(-0.5 + 0, 10)
    expect(outcome.worstPct).toBeCloseTo(-6.5, 10)
  })

  it('says a long wrong when the price fell, and nets the fall less the cost', () => {
    const outcome = sourceOutcomeOf(prediction({ side: 'up', targetPrice: 105 }), bars(Array(10).fill(98)), dueAt(prediction()) + 60)
    expect(outcome.right).toBe(false)
    expect(outcome.touched).toBe(false)
    expect(outcome.touchSec).toBeNull()
    expect(outcome.netPct).toBeCloseTo(-2 - 0.4, 10)
  })

  it('counts a call whose price ended where it began as not right', () => {
    const flat = sourceOutcomeOf(prediction({ side: 'up', targetPrice: 101 }), bars(Array(10).fill(REF)), dueAt(prediction()) + 60)
    expect(flat.movePct).toBe(0)
    expect(flat.right).toBe(false)
  })

  it('scores a size alone by the move either way, with no side, net or touch', () => {
    const outcome = sourceOutcomeOf(prediction({ kind: 'size', side: null, movePct: 2, targetPrice: null, cost: null }), bars([...Array(9).fill(100), 97]), dueAt(prediction()) + 60)
    expect(outcome).toMatchObject({ right: null, netPct: null, touched: null })
    expect(outcome.sizeErrorPct).toBeCloseTo(3 - 2, 10)
  })

  it('reads no price from the minute the call was made in, nor from after its horizon', () => {
    const early = [{ time: Math.floor(MADE / 60) * 60, open: 100, high: 200, low: 1, close: 100, volume: 1 }]
    const after = [{ time: dueAt(prediction()) + 60, open: 100, high: 200, low: 1, close: 50, volume: 1 }]
    const outcome = sourceOutcomeOf(prediction(), [...early, ...bars(Array(10).fill(100)), ...after], dueAt(prediction()) + 60)
    expect(outcome.bestPct).toBeCloseTo(0.5, 10)
    expect(outcome.worstPct).toBeCloseTo(-0.5, 10)
    expect(outcome.closePrice).toBe(100)
  })

  it('is late after its grace, and missing with a reason when the bars do not reach its end', () => {
    expect(sourceOutcomeOf(prediction(), bars(Array(10).fill(99)), dueAt(prediction()) + SOURCE_RECORD_LINES.graceSec).status).toBe('settled')
    expect(sourceOutcomeOf(prediction(), bars(Array(10).fill(99)), dueAt(prediction()) + SOURCE_RECORD_LINES.graceSec + 1).status).toBe('late')
    expect(sourceOutcomeOf(prediction(), bars(Array(8).fill(99)), dueAt(prediction()) + 60)).toMatchObject({ status: 'missing', why: 'the bars end before the horizon does', right: null, netPct: null })
    expect(sourceOutcomeOf(prediction(), [], dueAt(prediction()) + 60)).toMatchObject({ status: 'missing', why: 'no bar of the venue covers the horizon' })
    expect(sourceOutcomeOf(prediction({ refPrice: 0 }), bars([99]), dueAt(prediction()) + 60).status).toBe('missing')
  })
})

describe("a source's figures", () => {
  /** A prediction of one announcement hour with its outcome. */
  const scored = (hour: number, right: boolean, net: number): { prediction: SourcePrediction; outcome: ReturnType<typeof sourceOutcomeOf> } => {
    const made = hour * 3600 + 30
    const p = prediction({ id: `p:${hour}:${right}:${net}`, madeAt: made, unit: hourUnitOf(made) })
    const closes = Array(10).fill(right ? 100 - net - 0.4 : 100 + Math.abs(net))
    return { prediction: p, outcome: sourceOutcomeOf(p, bars(closes, Math.ceil(made / 60) * 60), dueAt(p) + 60) }
  }

  it('counts its predictions and the independent units they rest on, and leaves the missing out of every figure', () => {
    const rows = [scored(1000, true, 5), scored(1000, true, 4), scored(1001, false, 2), scored(1002, true, 6), { prediction: prediction({ id: 'gone' }), outcome: sourceOutcomeOf(prediction({ id: 'gone' }), [], MADE + 700) }, { prediction: prediction({ id: 'owed' }), outcome: null }]
    const figures = sourceFiguresOf(rows)
    expect(figures).toMatchObject({ n: 4, units: 3, missing: 1 })
    expect(figures.right!.value).toBeCloseTo(0.75, 10)
    expect(figures.right!.low).toBeGreaterThanOrEqual(0)
    expect(figures.right!.high).toBeLessThanOrEqual(1)
    expect(figures.net!.value).toBeCloseTo((5 + 4 - 2.4 + 6) / 4, 6)
    // Seeded: the same rows give the same interval.
    expect(sourceFiguresOf(rows).net).toEqual(figures.net)
  })

  it('has no interval on a single unit, and no figure where nothing is scored', () => {
    const one = sourceFiguresOf([scored(1000, true, 5), scored(1000, true, 3)])
    expect(one.units).toBe(1)
    expect(one.net!.value).toBeCloseTo(4, 6)
    expect(Number.isNaN(one.net!.low)).toBe(true)
    expect(sourceFiguresOf([])).toEqual({ n: 0, units: 0, missing: 0, right: null, net: null, sizeError: null, touched: null })
  })

  it('reads days and hours as the units they are', () => {
    expect(dayUnitOf(86_400 * 3 + 5)).toBe(3)
    expect(hourUnitOf(3600 * 7 + 5)).toBe(7)
  })
})

describe('a line read back', () => {
  it('is read as it was written, and a line of another version or shape is not', () => {
    const p = prediction()
    expect(readSourcePrediction(JSON.parse(JSON.stringify(p)))).toEqual(p)
    for (const bad of [null, 1, { ...p, v: 'source-record-v0' }, { ...p, horizonSec: 0 }, { ...p, kind: 'way' }, { ...p, side: 'sideways' }, { ...p, kind: 'direction', side: null }, { ...p, id: 3 }]) {
      expect(readSourcePrediction(bad), JSON.stringify(bad)?.slice(0, 40)).toBeNull()
    }
    const outcome = sourceOutcomeOf(p, bars(Array(10).fill(99)), dueAt(p) + 60)
    expect(readSourceOutcome(JSON.parse(JSON.stringify(outcome)))).toEqual(outcome)
    expect(readSourceOutcome({ ...outcome, status: 'pending' })).toBeNull()
    expect(sourcePredictionId('user', 'BTCUSDT', 5, 2)).toBe('user:BTCUSDT:5:2')
  })
})
