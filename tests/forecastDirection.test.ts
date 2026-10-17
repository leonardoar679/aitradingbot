import { describe, expect, it } from 'vitest'
import { parseRunCalibration, serializeRunCalibration } from '../shared/forecast/calibrationFile'
import { DIRECTION_LINES, calibratedPUp } from '../shared/forecast/direction'
import type { DirectionView } from '../shared/forecast/labView'
import { DIRECTION_MODELS, FORECAST_MODELS, type DirectionModelId, type ForecastModelId } from '../shared/forecast/models'
import { OOS_VERSION, decodeOos, encodeOos, oosDirection } from '../shared/forecast/oosRecord'
import { makePrediction, type PredictionInput } from '../shared/forecast/prediction'
import { DIRECTION_PROMOTION_LINES, directionChecklist } from '../shared/forecast/promotion'
import { buildRunCalibration, cellOf, directionReportOf, directionScore, directionSourceOf, rowsOf, scoreOutOfSample, type DirectionScore, type RunCalibration } from '../shared/forecast/runCalibration'
import { directionTable } from '../src/forecastLab/labTables'
import { promoted, recordOf, scaled } from './forecastRecords'

// WHICH WAY, JUDGED (V7.1 Stage 2; shared/forecast/{oosRecord,runCalibration,promotion,prediction}.ts):
// the direction models' readings kept with the walk forward's record, each mapped by the weeks before
// its own and scored on the same weeks as the distribution's P(up), promoted by the checklist alone, and
// the prediction reading its P(up) from the skilled source with the highest skill -- on records whose
// right answers are known: one model that knows the move's way most of the time, one that is noise.

const KNOWS: Partial<Record<DirectionModelId, number>> = { 'dir-gbt': 0.85, 'dir-logistic': 0 }

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

const RECORD = recordOf({ rows: 12_000, seed: 43, horizon: 'hour1', direction: KNOWS })
const ROWS = rowsOf(RECORD)
const SHOWN = scoreOutOfSample(ROWS, 'v2', new Set<ForecastModelId>(['persistence', 'gbt']))
const REPORT = directionReportOf(ROWS, SHOWN)!
const CALIBRATION: RunCalibration = buildRunCalibration(new Map([['hour1', RECORD]]), promoted('hour1', ['persistence', 'gbt']), 'run-way')
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
    // The distribution's P(up) hugs the base rate here, so it calls too seldom to be set against: the
    // calls line is not measured, and does not block.
    expect(knowing.lines.map((line) => line.ok)).toEqual([true, true, null])
    expect(noise.honest.pooled!.directionSkill).toBeLessThan(0.01)
    expect(noise.promoted).toBe(false)
    expect(noise.lines.find((line) => line.id === 'skill')!.ok).toBe(false)
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
    const flat = directionSourceOf(FLAT.horizons.hour1!, 'mid')
    expect(flat.source).toBe('base')
    expect(flat.map).toBeNull()
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
    expect(made.lines).toEqual(original.lines)
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
    // The reading says up but the median says down: the lines hold, and it is NEUTRAL.
    expect(makePrediction(input(CALIBRATION, -0.4, { direction: { hour1: { 'dir-gbt': 0.9 } } }))!.horizons.hour1!.direction).toBe('NEUTRAL')
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

describe('the checklist', () => {
  const score = (patch: Partial<DirectionScore> = {}): DirectionScore => ({ n: 6000, brier: 0.23, directionSkill: 0.05, upShare: 0.5, calls: 100, precision: 0.6, curve: [], ...patch })

  it('needs the outcomes, a skill above zero and, where both call enough, calls no less often right than the distribution\'s', () => {
    const baseline = score({ directionSkill: 0.001, precision: 0.55 })
    expect(directionChecklist(score(), baseline)).toMatchObject({ promoted: true })
    expect(directionChecklist(score(), baseline).lines.map((line) => line.ok)).toEqual([true, true, true])
    expect(directionChecklist(score({ n: 4999 }), baseline).lines[0].ok).toBe(false)
    expect(directionChecklist(score({ directionSkill: 0 }), baseline).lines[1].ok).toBe(false)
    expect(directionChecklist(score({ precision: 0.54 }), baseline).promoted).toBe(false)
    expect(directionChecklist(score({ precision: 0.55 }), baseline).promoted).toBe(true)
    // Too few calls on either side to set them against each other: not measured, not blocking.
    expect(directionChecklist(score({ calls: DIRECTION_PROMOTION_LINES.minCalls - 1, precision: 0.1 }), baseline)).toMatchObject({ promoted: true })
    expect(directionChecklist(score({ precision: 0.1 }), score({ calls: 5 })).lines[2].ok).toBeNull()
    expect(directionChecklist(score({ precision: 0.1 }), null).lines[2].ok).toBeNull()
    expect(directionChecklist(null, baseline)).toMatchObject({ promoted: false })
  })
})

describe('the Lab\'s table', () => {
  it('sets the distribution, each model and the base rate in rows, with its verdict and the classes it serves', () => {
    const view: DirectionView = { report: REPORT, inUse: { 'dir-gbt': ['mid', 'large'], base: ['btc'] } }
    const table = directionTable({ hour1: view })
    expect(table.headers[1]).toBe('Source of P(up)')
    expect(table.headers[4]).toBe('Detectable skill')
    expect(table.rows[0][1]).toBe("the distribution's P(up)")
    expect(table.rows[0][9]).toBe('—')
    const knowing = table.rows.find((row) => String(row[1]).startsWith('dir-gbt ('))!
    expect(knowing[7]).toBe('promoted')
    expect(knowing[9]).toBe('mid, large')
    // A report made without the horizon carries no interval and no detectable skill: the points alone.
    expect(knowing[4]).toBe('—')
    expect(String(knowing[3])).toMatch(/^\d+\.\d\d%$/)
    const noise = table.rows.find((row) => String(row[1]).startsWith('dir-logistic'))!
    expect(String(noise[7])).toMatch(/^not promoted: skill/)
    expect(table.rows[table.rows.length - 1][1]).toBe('the base rate')
    expect(table.rows[table.rows.length - 1][9]).toBe('btc')
    // With the horizon, the skill carries its interval and the model its detectable skill (V7.2 Stage 1).
    const worth = directionTable({ hour1: { report: directionReportOf(ROWS, SHOWN, 'hour1')!, inUse: {} } })
    const measured = worth.rows.find((row) => String(row[1]).startsWith('dir-gbt ('))!
    expect(String(measured[3])).toMatch(/^\d+\.\d\d% \(-?\d+\.\d\d–\d+\.\d\d\)$/)
    expect(String(measured[4])).toMatch(/^\d+\.\d\d%$/)
    expect(String(measured[6])).toMatch(/^\d+\.\d% \(\d+\.\d–\d+\.\d\)$/)
    expect(table.rows.some((row) => String(row[1]).startsWith('dir-gbt-price'))).toBe(false)
    expect(directionTable({}).rows).toEqual([])
    expect(DIRECTION_MODELS.length).toBe(4)
  })
})
