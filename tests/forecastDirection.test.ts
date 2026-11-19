import { describe, expect, it } from 'vitest'
import { parseRunCalibration, serializeRunCalibration } from '../shared/forecast/calibrationFile'
import { DIRECTION_LINES, calibratedPUp } from '../shared/forecast/direction'
import type { DirectionView } from '../shared/forecast/labView'
import { DIRECTION_MODELS, FORECAST_MODELS, type DirectionModelId, type ForecastModelId } from '../shared/forecast/models'
import { OOS_VERSION, decodeOos, encodeOos, oosDirection } from '../shared/forecast/oosRecord'
import { makePrediction, type PredictionInput } from '../shared/forecast/prediction'
import { DIRECTION_PROMOTION_LINES, directionChecklist } from '../shared/forecast/promotion'
import { ROUND_TRIP_PCT } from '../shared/forecast/edge'
import { buildRunCalibration, cellOf, directionReportOf, directionScore, directionSourceOf, pairHalfOf, rowsOf, scoreOutOfSample, tradeableVerdictsOf, type DirectionScore, type RunCalibration } from '../shared/forecast/runCalibration'
import { breakevenPrecision, directionTable } from '../src/forecastLab/labTables'
import { promoted, recordOf, scaled } from './forecastRecords'

// WHICH WAY, JUDGED (V7.1 Stage 2; shared/forecast/{oosRecord,runCalibration,promotion,prediction}.ts):
// the direction models' readings kept with the walk forward's record, each mapped by the weeks before
// its own and scored on the same weeks as the distribution's P(up), promoted by the checklist alone, and
// the prediction reading its P(up) from the skilled source with the highest skill -- on records whose
// right answers are known: one model that knows the move's way most of the time, one that is noise. Since
// V7.2 Stage 2 the checklist's lines are the direction bar's (a skill of 1%, 200 calls whose precision's lower
// bound clears an even chance, both halves of the weeks and of the pairs above zero, the class floor), a
// model is tradeable by its calls' edge after costs, and it is a source only where two walk forwards in a
// row found it tradeable.

const KNOWS: Partial<Record<DirectionModelId, number>> = { 'dir-gbt': 0.85, 'dir-logistic': 0 }
/** Eight pairs, so that both halves of the pairs (by the fixed hash of their names) hold outcomes. */
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT']

describe('the record', () => {
  it('keeps each direction model\'s reading a row, reads it back, and reads a record from before them without', () => {
    const record = recordOf({ rows: 2000, seed: 41, direction: KNOWS })
    expect(record.directionModels).toEqual(['dir-gbt', 'dir-logistic'])
    const back = decodeOos(encodeOos(record))!
    expect(back).not.toBeNull()
    expect(back.version).toBe(OOS_VERSION)
    expect(back.directionModels).toEqual(['dir-gbt', 'dir-logistic'])
    for (const row of [0, 777, 1999]) {
      for (const model of ['dir-gbt', 'dir-logistic'] as const) expect(oosDirection(back, row, model)).toBeCloseTo(oosDirection(record, row, model)!, 6)
      expect(oosDirection(back, row, 'dir-gbt-price')).toBeUndefined()
    }
    // A record written without readings reads back without them.
    const plain = decodeOos(encodeOos(recordOf({ rows: 500, seed: 42 })))!
    expect(plain.directionModels).toBeUndefined()
    expect(plain.direction).toBeUndefined()
    // The bytes of a forecast-oos-v2 record: the same header but for its version, no direction column.
    const bytes = encodeOos(recordOf({ rows: 500, seed: 42 }))
    const text = new TextDecoder().decode(bytes)
    const at = text.indexOf(OOS_VERSION)
    const v2 = bytes.slice()
    v2.set(new TextEncoder().encode('forecast-oos-v2'), at)
    const old = decodeOos(v2)!
    expect(old).not.toBeNull()
    expect(old.version).toBe('forecast-oos-v2')
    expect(old.directionModels).toBeUndefined()
    expect(old.btc15).toBeDefined()
    expect(old.rows).toBe(500)
  })
})

describe('the score', () => {
  it('is the Brier skill over the better of an even chance and the base rate, with the calls at the lines', () => {
    expect(directionScore([])).toBeNull()
    const score = directionScore([
      { cls: 'mid', week: 2, pUp: 0.7, base: 0.5, z: 1 },
      { cls: 'mid', week: 2, pUp: 0.3, base: 0.5, z: 1 },
      { cls: 'mid', week: 2, pUp: 0.5, base: 0.5, z: -1 }
    ])!
    expect(score.n).toBe(3)
    expect(score.upShare).toBeCloseTo(2 / 3, 9)
    expect(score.calls).toBe(2)
    expect(score.precision).toBe(0.5)
    expect(score.brier).toBeCloseTo((0.09 + 0.49 + 0.25) / 3, 9)
    expect(score.directionSkill).toBeCloseTo(1 - score.brier / 0.25, 9)
    expect(score.curve.reduce((sum, bin) => sum + bin.n, 0)).toBe(3)
    // A call at the line itself counts; one just inside does not; a move of nothing is no call.
    const edge = directionScore([
      { cls: 'mid', week: 2, pUp: DIRECTION_LINES.bullish, base: 0.5, z: 1 },
      { cls: 'mid', week: 2, pUp: DIRECTION_LINES.bullish - 0.001, base: 0.5, z: 1 },
      { cls: 'mid', week: 2, pUp: 1 - DIRECTION_LINES.bullish, base: 0.5, z: 0 }
    ])!
    expect(edge.calls).toBe(1)
    expect(edge.precision).toBe(1)
  })
})

const RECORD = recordOf({ rows: 12_000, seed: 43, horizon: 'hour1', direction: KNOWS, symbols: SYMBOLS })
const ROWS = rowsOf(RECORD)
const SHOWN = scoreOutOfSample(ROWS, 'v2', new Set<ForecastModelId>(['persistence', 'gbt']))
const REPORT = directionReportOf(ROWS, SHOWN, 'hour1')!
/** The calibration as a second walk forward makes it: the run before found both models tradeable. */
const CALIBRATION: RunCalibration = buildRunCalibration(new Map([['hour1', RECORD]]), promoted('hour1', ['persistence', 'gbt']), 'run-way', undefined, { hour1: { 'dir-gbt': true, 'dir-logistic': true } })
const FLAT: RunCalibration = buildRunCalibration(new Map([['hour1', recordOf({ rows: 12_000, seed: 44, horizon: 'hour1' })]]), promoted('hour1', ['persistence', 'gbt']), 'run-flat')

describe('the report', () => {
  it('promotes the model that knew the way, out of sample, and not the one that was noise, beside the distribution', () => {
    expect(Object.keys(REPORT.models).sort()).toEqual(['dir-gbt', 'dir-logistic'])
    const knowing = REPORT.models['dir-gbt']!
    const noise = REPORT.models['dir-logistic']!
    expect(knowing.honest.pooled!.n).toBeGreaterThanOrEqual(DIRECTION_PROMOTION_LINES.minOutcomes)
    expect(knowing.honest.pooled!.directionSkill).toBeGreaterThan(0.2)
    expect(knowing.honest.pooled!.precision).toBeGreaterThan(0.75)
    expect(knowing.promoted).toBe(true)
    // Every line of the bar measured and held, the edge's too: tradeable here, the run before unknown.
    expect(knowing.lines.map((line) => line.id)).toEqual(['outcomes', 'skill', 'calls', 'precision', 'halves', 'classes', 'edge'])
    expect(knowing.lines.map((line) => line.ok)).toEqual([true, true, true, true, true, true, true])
    expect(knowing.tradeable).toBe(true)
    expect(knowing.tradeableBefore).toBeNull()
    expect(knowing.honest.pooled!.edge!.meanPct).toBeGreaterThan(0)
    expect(knowing.honest.pooled!.edge!.ci!.low).toBeGreaterThan(0)
    expect(knowing.honest.pooled!.halves!.weeks.every((skill) => skill !== null && skill > 0.1)).toBe(true)
    expect(knowing.honest.pooled!.halves!.pairs.every((skill) => skill !== null && skill > 0.1)).toBe(true)
    expect(new Set(SYMBOLS.map(pairHalfOf)).size).toBe(2)
    expect(noise.honest.pooled!.directionSkill).toBeLessThan(0.01)
    expect(noise.promoted).toBe(false)
    expect(noise.tradeable).toBe(false)
    expect(noise.lines.find((line) => line.id === 'skill')!.ok).toBe(false)
    // Without the horizon no interval is read, and the precision's and the edge's lines hold the model back.
    const unread = directionReportOf(ROWS, SHOWN)!.models['dir-gbt']!
    expect(unread.promoted).toBe(false)
    expect(unread.lines.filter((line) => line.ok === null).map((line) => line.id)).toEqual(['precision', 'edge'])
    // Scored on the same weeks as the distribution's P(up): the baseline knows nothing here.
    expect(knowing.honest.weeks).toEqual([...new Set(SHOWN.filter((entry) => entry.pUp !== null).map((entry) => entry.week))].sort())
    expect(Math.abs(REPORT.baseline.pooled!.directionSkill)).toBeLessThan(0.02)
    expect(REPORT.baseline.pooled!.n).toBe(SHOWN.filter((entry) => entry.pUp !== null).length)
    // Every class the record holds has a score of its own, and the last week's skill is on it.
    expect(Object.keys(knowing.honest.byClass).length).toBeGreaterThan(3)
    expect(knowing.lastWeekSkill).toBeGreaterThan(0.1)
    expect(knowing.degraded).toBe(false)
    expect(noise.degraded).toBe(noise.lastWeekSkill !== null && noise.lastWeekSkill < 0)
  })

  it('is absent from a record that holds no readings, and written into the calibration where one does', () => {
    expect(directionReportOf(rowsOf(recordOf({ rows: 3000, seed: 45 })), [])).toBeNull()
    expect(FLAT.horizons.hour1!.direction).toBeUndefined()
    expect(CALIBRATION.horizons.hour1!.direction!.models['dir-gbt']!.promoted).toBe(true)
  })
})

describe('the source', () => {
  it('is the promoted model with the highest skill, the distribution where that is skilled alone, the base rate where none is', () => {
    const chosen = directionSourceOf(CALIBRATION.horizons.hour1!, 'mid')
    expect(chosen.source).toBe('dir-gbt')
    expect(chosen.map).not.toBeNull()
    expect(chosen.skill).toBeGreaterThan(0.2)
    expect(CALIBRATION.horizons.hour1!.direction!.models['dir-gbt']).toMatchObject({ promoted: true, tradeable: true, tradeableBefore: true })
    expect(tradeableVerdictsOf(CALIBRATION)).toEqual({ hour1: { 'dir-gbt': true, 'dir-logistic': false } })
    const flat = directionSourceOf(FLAT.horizons.hour1!, 'mid')
    expect(flat.source).toBe('base')
    expect(flat.map).toBeNull()
    // A verdict held once is not a source (V7.2 Stage 2): without the run before's, or with it against, or
    // not tradeable here.
    const once: RunCalibration = JSON.parse(JSON.stringify(CALIBRATION))
    once.horizons.hour1!.direction!.models['dir-gbt']!.tradeableBefore = null
    expect(directionSourceOf(once.horizons.hour1!, 'mid').source).toBe('base')
    once.horizons.hour1!.direction!.models['dir-gbt']!.tradeableBefore = false
    expect(directionSourceOf(once.horizons.hour1!, 'mid').source).toBe('base')
    const untradeable: RunCalibration = JSON.parse(JSON.stringify(CALIBRATION))
    untradeable.horizons.hour1!.direction!.models['dir-gbt']!.tradeable = false
    expect(directionSourceOf(untradeable.horizons.hour1!, 'mid').source).toBe('base')
    // Unpromoted, a model is never the source, whatever its skill reads.
    const unpromoted: RunCalibration = JSON.parse(JSON.stringify(CALIBRATION))
    unpromoted.horizons.hour1!.direction!.models['dir-gbt']!.promoted = false
    expect(directionSourceOf(unpromoted.horizons.hour1!, 'mid').source).toBe('base')
    // Promoted but under the 1% line on these weeks: not skilled enough to be the source either.
    const faint: RunCalibration = JSON.parse(JSON.stringify(CALIBRATION))
    const scores = faint.horizons.hour1!.direction!.models['dir-gbt']!.honest
    scores.pooled!.directionSkill = DIRECTION_LINES.minDirectionSkill - 0.001
    for (const score of Object.values(scores.byClass)) if (score !== undefined) score.directionSkill = DIRECTION_LINES.minDirectionSkill - 0.001
    expect(directionSourceOf(faint.horizons.hour1!, 'mid').source).toBe('base')
    scores.pooled!.directionSkill = DIRECTION_LINES.minDirectionSkill
    for (const score of Object.values(scores.byClass)) if (score !== undefined) score.directionSkill = DIRECTION_LINES.minDirectionSkill
    expect(directionSourceOf(faint.horizons.hour1!, 'mid').source).toBe('dir-gbt')
  })
})

describe('on file', () => {
  it('goes to the calibration file and back whole, and is refused half-made', () => {
    const text = serializeRunCalibration(CALIBRATION)
    const back = parseRunCalibration(text)!
    expect(back).not.toBeNull()
    const made = back.horizons.hour1!.direction!.models['dir-gbt']!
    const original = CALIBRATION.horizons.hour1!.direction!.models['dir-gbt']!
    expect(made.promoted).toBe(true)
    expect(made.tradeable).toBe(true)
    expect(made.tradeableBefore).toBe(true)
    expect(made.lines).toEqual(original.lines)
    for (const half of ['weeks', 'pairs'] as const) for (const at of [0, 1]) expect(made.honest.pooled!.halves![half][at]).toBeCloseTo(original.honest.pooled!.halves![half][at]!, 5)
    expect(made.honest.pooled!.edge!.meanPct).toBeCloseTo(original.honest.pooled!.edge!.meanPct, 5)
    expect(made.honest.pooled!.edge!.ci!.low).toBeCloseTo(original.honest.pooled!.edge!.ci!.low, 5)
    expect(made.honest.pooled!.directionSkill).toBeCloseTo(original.honest.pooled!.directionSkill, 5)
    expect(made.honest.weeks).toEqual(original.honest.weeks)
    expect(made.map.x.length).toBe(original.map.x.length)
    expect(back.horizons.hour1!.direction!.baseline.pooled!.n).toBe(REPORT.baseline.pooled!.n)
    expect(directionSourceOf(back.horizons.hour1!, 'mid').source).toBe('dir-gbt')
    // A flat calibration has no report, and reads back without one.
    expect(parseRunCalibration(serializeRunCalibration(FLAT))!.horizons.hour1!.direction).toBeUndefined()
    const raw = JSON.parse(text)
    raw.horizons.hour1.direction.models['dir-gbt'].promoted = 'yes'
    expect(parseRunCalibration(JSON.stringify(raw))).toBeNull()
    // The two verdicts, the halves and the edge of V7.2 Stage 2: refused part-made.
    const damage = (edit: (copy: typeof raw) => void): unknown => {
      const copy = JSON.parse(text)
      edit(copy)
      return parseRunCalibration(JSON.stringify(copy))
    }
    expect(damage((copy) => delete copy.horizons.hour1.direction.models['dir-gbt'].tradeable)).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.direction.models['dir-gbt'].tradeableBefore = 'maybe'))).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.direction.models['dir-gbt'].honest.pooled.halves = { weeks: [0.1] }))).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.direction.models['dir-gbt'].honest.pooled.edge = { calls: 'many' }))).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.direction.models['dir-gbt'].honest.pooled.edge.ci = { low: 0.2, high: 0.1 }))).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.direction.models['dir-gbt'].tradeableBefore = null))).not.toBeNull()
    const stranger = JSON.parse(text)
    stranger.horizons.hour1.direction.models['dir-other'] = stranger.horizons.hour1.direction.models['dir-gbt']
    expect(parseRunCalibration(JSON.stringify(stranger))).toBeNull()
  })
})

/** One row's models: gbt knows the move's scale and drift, the rest read like persistence. */
function modelsOf(sigma: number, mu: number, floor: number[]): Record<ForecastModelId, number[]> {
  return Object.fromEntries(FORECAST_MODELS.map((model) => [model, model === 'gbt' ? scaled(sigma, mu) : floor])) as Record<ForecastModelId, number[]>
}

function input(calibration: RunCalibration, mu: number, patch: Partial<PredictionInput> = {}): PredictionInput {
  return {
    pair: 'SOLUSDT',
    pairClass: 'mid',
    regime: 'sideways',
    barTime: Date.parse('2026-10-16T15:00:00Z') / 1000,
    price: 182.4,
    generatedAt: Date.parse('2026-10-16T15:00:07Z'),
    rv24h: 0.04,
    rvRatio: 1,
    models: { hour1: modelsOf(1, mu, scaled(1.25)) },
    calibration,
    runId: 'run-way',
    foldsRunId: 'run-way',
    ...patch
  }
}

describe('the prediction', () => {
  it('reads its P(up) from the promoted model\'s reading, by its map, and says so; the call\'s lines unchanged', () => {
    const map = directionSourceOf(CALIBRATION.horizons.hour1!, 'mid').map!
    const up = makePrediction(input(CALIBRATION, 0.4, { direction: { hour1: { 'dir-gbt': 0.9 } } }))!.horizons.hour1!
    expect(up.pUpSource).toBe('dir-gbt')
    expect(up.pUp).toBeCloseTo(calibratedPUp(map, 0.9), 12)
    expect(up.pUp).toBeGreaterThan(DIRECTION_LINES.bullish)
    expect(up.directionSkill).toBeGreaterThan(0.2)
    expect(up.direction).toBe('BULLISH')
    const down = makePrediction(input(CALIBRATION, -0.4, { direction: { hour1: { 'dir-gbt': 0.1 } } }))!.horizons.hour1!
    expect(down.pUpSource).toBe('dir-gbt')
    expect(down.pUp).toBeLessThan(1 - DIRECTION_LINES.bullish)
    expect(down.direction).toBe('BEARISH')
    // Since V10 Stage 1 the middle sits at no move whatever the models' centre (V10-LEAN): it never stands against a
    // measured reading, and a reading of up with the models leaning down is called up.
    const leaning = makePrediction(input(CALIBRATION, -0.4, { direction: { hour1: { 'dir-gbt': 0.9 } } }))!.horizons.hour1!
    expect(leaning.medianPct).toBe(0)
    expect(leaning.direction).toBe('BULLISH')
    // Without a measured reading the same models call no way.
    expect(makePrediction(input(CALIBRATION, -0.4))!.horizons.hour1!.direction).toBe('NEUTRAL')
    // The distribution's own reading stays on its variant.
    expect(up.variants.v2!.pUp).toBe(cellOf(CALIBRATION.horizons.hour1!.variants.v2, 'mid').honest!.upShare)
  })

  it('falls back to the distribution\'s reading without a reading of the model\'s, and to the base rate where nothing is skilled', () => {
    const missing = makePrediction(input(CALIBRATION, 0.4))!.horizons.hour1!
    expect(missing.pUpSource).toBe('base')
    expect(missing.pUp).toBe(cellOf(CALIBRATION.horizons.hour1!.variants.v2, 'mid').honest!.upShare)
    expect(missing.direction).toBe('NEUTRAL')
    const flat = makePrediction(input(FLAT, 0.4, { direction: { hour1: { 'dir-gbt': 0.9 } } }))!.horizons.hour1!
    expect(flat.pUpSource).toBe('base')
    expect(flat.direction).toBe('NEUTRAL')
  })
})

describe('the score (V7.2 Stage 2)', () => {
  it("reads the calls' edge after the round trip, its interval holding the point, and the halves of the weeks and the pairs", () => {
    // Every entry a call up on a move of +1%: the edge is 1% less the round trip, and every draw the same.
    const entries = Array.from({ length: 48 }, (_, at) => ({ cls: 'mid' as const, week: 2 + (at % 2), pUp: 0.7, base: 0.5, z: 1, t: Math.floor(at / 4) * 3600, pair: SYMBOLS[at % 8], movePct: 1 }))
    const score = directionScore(entries, 'hour1')!
    expect(score.edge!.calls).toBe(48)
    expect(score.edge!.meanPct).toBeCloseTo(1 - ROUND_TRIP_PCT, 9)
    expect(score.edge!.ci!.low).toBeCloseTo(1 - ROUND_TRIP_PCT, 9)
    expect(score.edge!.ci!.high).toBeCloseTo(1 - ROUND_TRIP_PCT, 9)
    expect(score.halves!.weeks.every((skill) => skill !== null)).toBe(true)
    expect(score.halves!.pairs.every((skill) => skill !== null)).toBe(true)
    // A call down on the same move loses it; a call made without a move carries no edge.
    expect(directionScore(entries.map((entry) => ({ ...entry, pUp: 0.3 })), 'hour1')!.edge!.meanPct).toBeCloseTo(-1 - ROUND_TRIP_PCT, 9)
    expect(directionScore(entries.map((entry) => ({ ...entry, movePct: undefined })), 'hour1')!.edge).toBeUndefined()
    // Without a pair the pairs' halves are not read; the weeks' are.
    const unpaired = directionScore(entries.map((entry) => ({ ...entry, pair: undefined })), 'hour1')!
    expect(unpaired.halves!.pairs).toEqual([null, null])
    expect(unpaired.halves!.weeks.every((skill) => skill !== null)).toBe(true)
  })
})

describe('the checklist', () => {
  const score = (patch: Partial<DirectionScore> = {}): DirectionScore => ({
    n: 6000,
    brier: 0.23,
    directionSkill: 0.05,
    upShare: 0.5,
    calls: 300,
    precision: 0.6,
    curve: [],
    ci: { directionSkill: { low: 0.03, high: 0.07 }, precision: { low: 0.55, high: 0.65 } },
    halves: { weeks: [0.04, 0.06], pairs: [0.05, 0.05] },
    edge: { calls: 300, meanPct: 0.1, ci: { low: 0.02, high: 0.18 } },
    ...patch
  })

  it('promotes by every line measured and held, calls a model tradeable by its calls\' edge, and holds back what it cannot read', () => {
    const made = directionChecklist(score())
    expect(made).toMatchObject({ promoted: true, tradeable: true })
    expect(made.lines.map((line) => line.id)).toEqual(['outcomes', 'skill', 'calls', 'precision', 'halves', 'classes', 'edge'])
    expect(made.lines.every((line) => line.ok === true)).toBe(true)
    expect(directionChecklist(score({ n: DIRECTION_PROMOTION_LINES.minOutcomes - 1 })).lines[0].ok).toBe(false)
    expect(directionChecklist(score({ directionSkill: DIRECTION_PROMOTION_LINES.minSkill - 0.0001 })).promoted).toBe(false)
    expect(directionChecklist(score({ directionSkill: DIRECTION_PROMOTION_LINES.minSkill })).promoted).toBe(true)
    expect(directionChecklist(score({ calls: DIRECTION_PROMOTION_LINES.minCalls - 1 })).promoted).toBe(false)
    // The precision's lower bound must be above an even chance, not at it.
    expect(directionChecklist(score({ ci: { directionSkill: { low: 0.03, high: 0.07 }, precision: { low: 0.5, high: 0.7 } } })).promoted).toBe(false)
    expect(directionChecklist(score({ ci: { directionSkill: { low: 0.03, high: 0.07 }, precision: { low: 0.501, high: 0.7 } } })).promoted).toBe(true)
    // Both halves of the weeks and both halves of the pairs above zero.
    expect(directionChecklist(score({ halves: { weeks: [0.04, 0], pairs: [0.05, 0.05] } })).promoted).toBe(false)
    expect(directionChecklist(score({ halves: { weeks: [0.04, 0.06], pairs: [-0.01, 0.05] } })).promoted).toBe(false)
    // The class floor: a class with two thousand outcomes under -1% blocks; a smaller one, or one at -1%, does not.
    const poor = score({ n: 2000, directionSkill: -0.02 })
    expect(directionChecklist(score(), { btc: poor }).promoted).toBe(false)
    expect(directionChecklist(score(), { btc: poor }).lines[5].text).toMatch(/^btc under/)
    expect(directionChecklist(score(), { btc: { ...poor, n: 1999 } }).promoted).toBe(true)
    expect(directionChecklist(score(), { btc: { ...poor, directionSkill: -0.01 } }).promoted).toBe(true)
    // Tradeable needs the edge above zero with its lower bound; promoted stands without it.
    expect(directionChecklist(score({ edge: { calls: 300, meanPct: 0.1, ci: { low: 0, high: 0.2 } } }))).toMatchObject({ promoted: true, tradeable: false })
    expect(directionChecklist(score({ edge: { calls: 300, meanPct: -0.1, ci: { low: -0.2, high: 0.01 } } }))).toMatchObject({ promoted: true, tradeable: false })
    // A line that cannot be read holds the model back: no precision interval, a half with nothing in it, no
    // edge or no interval on it.
    expect(directionChecklist(score({ ci: undefined }))).toMatchObject({ promoted: false, tradeable: false })
    expect(directionChecklist(score({ ci: undefined })).lines[3].ok).toBeNull()
    expect(directionChecklist(score({ halves: { weeks: [0.04, null], pairs: [0.05, 0.05] } })).promoted).toBe(false)
    expect(directionChecklist(score({ halves: undefined })).lines[4].ok).toBeNull()
    expect(directionChecklist(score({ edge: { calls: 300, meanPct: 0.1, ci: null } }))).toMatchObject({ promoted: true, tradeable: false })
    expect(directionChecklist(score({ edge: undefined })).lines[6].ok).toBeNull()
    expect(directionChecklist(null)).toMatchObject({ promoted: false, tradeable: false })
  })
})

describe('the Lab\'s table', () => {
  it('sets the distribution, each model and the base rate in rows, with its verdict and the classes it serves', () => {
    const view: DirectionView = { report: REPORT, inUse: { 'dir-gbt': ['mid', 'large'], base: ['btc'] } }
    const table = directionTable({ hour1: view })
    expect(table.headers.slice(1)).toEqual(['Source of P(up)', 'Outcomes', 'Brier skill over the base rate', 'Detectable skill', 'Calls at the lines', 'Calls right', 'Breakeven precision', "The calls' edge after costs", 'Verdict', 'Tradeable twice', 'Last week', 'P(up) of'])
    expect(table.rows[0][1]).toBe("the distribution's P(up)")
    expect(table.rows[0][12]).toBe('—')
    const knowing = table.rows.find((row) => String(row[1]).startsWith('dir-gbt ('))!
    // The skill with its interval, the detectable skill, the calls right with theirs (V7.2 Stage 1); no Lab
    // given, no breakeven; the calls' edge with its interval, the verdict, the run before unknown.
    expect(String(knowing[3])).toMatch(/^\d+\.\d\d% \(-?\d+\.\d\d–\d+\.\d\d\)$/)
    expect(String(knowing[4])).toMatch(/^\d+\.\d\d%$/)
    expect(String(knowing[6])).toMatch(/^\d+\.\d% \(\d+\.\d–\d+\.\d\)$/)
    expect(knowing[7]).toBe('—')
    expect(String(knowing[8])).toMatch(/^[+-]\d+\.\d{3}% \([+-]\d+\.\d{3}%–[+-]\d+\.\d{3}%\)$/)
    expect(knowing[9]).toBe('promoted, tradeable')
    expect(knowing[10]).toBe('no run before')
    expect(knowing[12]).toBe('mid, large')
    const noise = table.rows.find((row) => String(row[1]).startsWith('dir-logistic'))!
    expect(String(noise[9])).toMatch(/^not promoted: skill/)
    expect(table.rows[table.rows.length - 1][1]).toBe('the base rate')
    expect(table.rows[table.rows.length - 1][12]).toBe('btc')
    // The breakeven precision from the Lab's error: half plus the round trip over twice the error.
    expect(breakevenPrecision(0.3)).toBeCloseTo(0.5 + ROUND_TRIP_PCT / 0.6, 12)
    expect(breakevenPrecision(null)).toBeNull()
    expect(breakevenPrecision(0)).toBeNull()
    // Tradeable twice, as a calibration built with the run before's verdicts says.
    const held = directionTable({ hour1: { report: CALIBRATION.horizons.hour1!.direction!, inUse: {} } })
    expect(held.rows.find((row) => String(row[1]).startsWith('dir-gbt ('))![10]).toBe('yes: a P(up) source')
    // A report made without the horizon: no interval, no detectable skill, held back as unread.
    const unread = directionTable({ hour1: { report: directionReportOf(ROWS, SHOWN)!, inUse: {} } })
    const point = unread.rows.find((row) => String(row[1]).startsWith('dir-gbt ('))!
    expect(point[4]).toBe('—')
    expect(String(point[9])).toMatch(/^not promoted: ; not read: precision, edge$|^not promoted: not read: precision, edge$/)
    expect(table.rows.some((row) => String(row[1]).startsWith('dir-gbt-price'))).toBe(false)
    expect(directionTable({}).rows).toEqual([])
    expect(DIRECTION_MODELS.length).toBe(4)
  })
})
