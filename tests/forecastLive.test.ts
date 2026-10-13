import { describe, expect, it } from 'vitest'
import { cellKey, emptyAciTable, levelsOf, parseAciTable, stepAciTable } from '../shared/forecast/aciTable'
import { CALIBRATION_LINES } from '../shared/forecast/calibration'
import { FORECAST_RECORD_VERSION, isMissing, missingOutcomeLine, outcomeLine, parseOutcomeLine, parsePredictionLine, predictionLine, recordMonth, recordedHorizons } from '../shared/forecast/forecastRecord'
import { QUANTILE_LEVELS } from '../shared/forecast/ml/quantile'
import { OUTCOME_LINES, dueAt, errorsOf, outcomeOf, type ForecastedHorizon } from '../shared/forecast/outcome'
import type { ForecastRange, PricePrediction } from '../shared/forecast/prediction'
import { REFRESH_LINES, refreshReasons } from '../shared/forecast/refresh'
import { forecastView } from '../shared/forecast/view'

// THE FORECAST LIVE, RULE BY RULE (shared/forecast/{view,outcome,refresh,aciTable,forecastRecord}.ts;
// the V6 document, §38-43 and §57): a forecast re-expressed from the live price and expiring at its
// horizon's close; an outcome written from the bars that closed after it and the kinds of error it
// made; when a pair is forecast again between closes; the adaptive levels moved once a moment; and
// the record's lines.

const T = Date.parse('2026-10-13T15:00:00Z') / 1000

function range(patch: Partial<ForecastRange> = {}): ForecastRange {
  const quantilesPct = [-2, -1, 0.5, 2, 3]
  return {
    lowPct: -1,
    highPct: 2,
    lowerPrice: 178.2,
    upperPrice: 183.6,
    medianPct: 0.5,
    confidenceLevel: 50,
    quantilesPct,
    quantilePrices: quantilesPct.map((pct) => 180 * (1 + pct / 100)),
    bearPct: -2,
    bullPct: 3,
    pUp: 0.55,
    pUpMapped: 0.55,
    direction: 'NEUTRAL',
    strong: false,
    uncertain: false,
    confidence: 55,
    reliability: 'HIGH',
    reliabilityReasons: [],
    width80Pct: 5,
    usualWidth80Pct: 4,
    skill: 0.01,
    directionSkill: -0.01,
    ownClass: true,
    expiresAt: (T + 3600) * 1000,
    contributions: [{ model: 'gbt', weight: 1, medianLogPct: 0.5 }],
    calibrationShiftLogPct: 0,
    spreadStretch: 1,
    variants: { v1: { medianPct: 0.4, lowPct: -1.1, highPct: 1.9, quantilesPct: [-2.1, -1.1, 0.4, 1.9, 2.9], pUp: 0.54, pUpMapped: 0.54 } },
    ...patch
  }
}

function prediction(horizons: PricePrediction['horizons'] = { hour1: range(), minutes15: range({ expiresAt: (T + 900) * 1000 }) }): PricePrediction {
  return {
    pair: 'SOLUSDT',
    generatedAt: T * 1000 + 7000,
    direction: 'NEUTRAL',
    horizons,
    currentPrice: 180,
    confidence: 55,
    reliability: 'HIGH',
    invalidationConditions: [],
    modelVersion: 'models-v1 run-x',
    id: `SOLUSDT:${T}:${T * 1000 + 7000}`,
    strong: false,
    uncertain: false,
    bestHorizon: 'hour1',
    pairClass: 'large',
    regime: 'sideways',
    barTime: T,
    versions: { prediction: 'prediction-v1', models: 'models-v1', features: 'features-v1', ensemble: 'ensemble-v1', calibration: 'calibration-v1', runCalibration: 'run-calibration-v2', run: 'run-x', foldsRun: 'run-y' }
  }
}

describe('the forecast as the price moves', () => {
  it('keeps its price levels and says them from the live price', () => {
    // §41: read from $180 at 15:00 as +2% ~ +5%; at $184 the same levels.
    const view = forecastView(prediction(), 184, T * 1000 + 7 * 60_000)
    expect(view.priceFrom).toBe('live')
    expect(view.movedPct).toBeCloseTo((184 / 180 - 1) * 100, 12)
    const hour = view.horizons.hour1!
    expect(hour.highPct).toBeCloseTo((180 * 1.02) / 184 * 100 - 100, 12)
    expect(hour.lowPct).toBeCloseTo((180 * 0.99) / 184 * 100 - 100, 12)
    expect(hour.medianPct).toBeLessThan(0)
    expect(hour.timeLeftMs).toBe(53 * 60_000)
    expect(hour.expired).toBe(false)
    expect(hour.invalidated).toBe(false)
  })

  it('says them from the close it was read at where there is no live price', () => {
    const view = forecastView(prediction(), null, T * 1000)
    expect(view.priceFrom).toBe('close')
    expect(view.horizons.hour1!.highPct).toBeCloseTo(2, 12)
    expect(view.horizons.hour1!.invalidated).toBe(false)
  })

  it('expires each horizon at its close, and is FORECAST EXPIRED once every one has', () => {
    const at = (minutes: number): ReturnType<typeof forecastView> => forecastView(prediction(), 180, T * 1000 + minutes * 60_000)
    expect(at(14).horizons.minutes15!.expired).toBe(false)
    expect(at(15).horizons.minutes15!.expired).toBe(true)
    expect(at(15).expired).toBe(false)
    expect(at(60).expired).toBe(true)
    expect(at(65).horizons.hour1!.timeLeftMs).toBe(0)
  })

  it('is invalidated where the live price has left its 80% range', () => {
    expect(forecastView(prediction(), 180 * 1.031, T * 1000).horizons.hour1!.invalidated).toBe(true)
    expect(forecastView(prediction(), 180 * 0.979, T * 1000).horizons.hour1!.invalidated).toBe(true)
    expect(forecastView(prediction(), 180 * 1.029, T * 1000).horizons.hour1!.invalidated).toBe(false)
  })
})

describe('an outcome', () => {
  const hour: ForecastedHorizon = { horizon: 'hour1', quantilesPct: [-2, -1, 0.5, 2, 3], pUp: 0.6, direction: 'BULLISH', width80Pct: 5, usualWidth80Pct: 4 }
  const path = (closes: number[], high = 0, low = 0): { high: number; low: number; close: number }[] => closes.map((close) => ({ close, high: Math.max(close, high), low: low === 0 ? close : Math.min(close, low) }))

  it('is due at its close plus its horizon', () => {
    expect(dueAt(T, 'hour1')).toBe(T + 3600)
    expect(dueAt(T, 'hours24')).toBe(T + 86_400)
  })

  it('is the move to the horizon\'s close, the path\'s best and worst, and where it fell', () => {
    const bars = path([...Array(11).fill(180), 181.8], 183, 179)
    const outcome = outcomeOf(hour, T, 180, bars)!
    expect(outcome.movePct).toBeCloseTo(1, 9)
    expect(outcome.bestPct).toBeCloseTo((183 / 180 - 1) * 100, 9)
    expect(outcome.worstPct).toBeCloseTo((179 / 180 - 1) * 100, 9)
    expect(outcome.below).toEqual([false, false, false, true, true])
    expect(outcome.inside80).toBe(true)
    expect(outcome.inside50).toBe(true)
    expect(outcome.wentUp).toBe(true)
    expect(outcome.dueAt).toBe(T + 3600)
    expect(outcome.errors).toEqual(['CORRECT_DIRECTION', 'RIGHT_RANGE'])
  })

  it('is none before its bars are all there', () => {
    expect(outcomeOf(hour, T, 180, path(Array(11).fill(180)))).toBeNull()
    expect(outcomeOf(hour, T, 0, path(Array(12).fill(180)))).toBeNull()
  })

  it('names each kind of error the close can tell', () => {
    expect(errorsOf(hour, -0.5, 0.2, -0.6)).toEqual(['WRONG_DIRECTION', 'RIGHT_RANGE'])
    // A bear's median is below zero, as its call requires.
    const bear = { ...hour, direction: 'BEARISH' as const, quantilesPct: [-3, -2, -0.5, 1, 2] }
    expect(errorsOf(bear, -0.5, 0.2, -0.6)).toEqual(['CORRECT_DIRECTION', 'RIGHT_RANGE'])
    expect(errorsOf(bear, 0.6, 0.7, -0.1)).toEqual(['WRONG_DIRECTION', 'RIGHT_RANGE'])
    expect(errorsOf({ ...hour, direction: 'NEUTRAL' }, 3.5, 3.6, 0)).toEqual(['TOO_NARROW'])
    expect(errorsOf({ ...hour, direction: 'NEUTRAL' }, -2.01, 0, -2.1)).toEqual(['TOO_NARROW'])
    expect(errorsOf({ ...hour, direction: 'NEUTRAL' }, 0, 0, 0)).toEqual(['RIGHT_RANGE'])
    // On the range's ends, inside it.
    expect(errorsOf({ ...hour, direction: 'NEUTRAL' }, -2, 0, -2)).toEqual(['RIGHT_RANGE'])
    expect(errorsOf({ ...hour, direction: 'NEUTRAL' }, 3, 3, 0)).toEqual(['RIGHT_RANGE'])
    const edge = (103 / 100 - 1) * 100
    expect(outcomeOf({ ...hour, quantilesPct: [-2, -1, 0.5, 2, edge] }, T, 100, Array.from({ length: 12 }, () => ({ high: 103, low: 99, close: 103 })))).toMatchObject({ inside80: true, inside50: false })
    // A range over twice its class's usual width that held the close in its likely range.
    const wide = { ...hour, direction: 'NEUTRAL' as const, width80Pct: OUTCOME_LINES.tooWide * 4 + 0.01 }
    expect(errorsOf(wide, 0.4, 0.5, 0)).toEqual(['RIGHT_RANGE', 'TOO_WIDE'])
    expect(errorsOf({ ...wide, width80Pct: OUTCOME_LINES.tooWide * 4 }, 0.4, 0.5, 0)).toEqual(['RIGHT_RANGE'])
    expect(errorsOf(wide, 2.5, 2.6, 0)).toEqual(['RIGHT_RANGE'])
    // The move came and went: the path reached the median forecast, the close came back below where
    // it started.
    expect(errorsOf(hour, -0.2, 0.6, -0.3)).toEqual(['WRONG_DIRECTION', 'RIGHT_RANGE', 'LATE'])
    expect(errorsOf(hour, -0.2, 0.4, -0.3)).toEqual(['WRONG_DIRECTION', 'RIGHT_RANGE'])
    expect(errorsOf({ ...hour, direction: 'BEARISH', quantilesPct: [-3, -2, -0.5, 1, 2] }, 0.2, 0.3, -0.6)).toEqual(['WRONG_DIRECTION', 'RIGHT_RANGE', 'LATE'])
    // A move of exactly nothing calls neither way right or wrong.
    expect(errorsOf(hour, 0, 0, 0)).toEqual(['RIGHT_RANGE'])
  })
})

describe('a forecast made again before the next close', () => {
  const base = { nowMs: 1_000_000, lastRefreshAt: null }

  it('is made for a story of impact 70, an event, a price out of its range or a volume shock', () => {
    expect(refreshReasons(base)).toEqual([])
    expect(refreshReasons({ ...base, newsImpact: REFRESH_LINES.newsImpact })).toEqual(['news'])
    expect(refreshReasons({ ...base, newsImpact: REFRESH_LINES.newsImpact - 1 })).toEqual([])
    expect(refreshReasons({ ...base, newEvent: true })).toEqual(['event'])
    expect(refreshReasons({ ...base, livePrice: 99, band: [100, 110] })).toEqual(['band'])
    expect(refreshReasons({ ...base, livePrice: 111, band: [100, 110] })).toEqual(['band'])
    expect(refreshReasons({ ...base, livePrice: 105, band: [100, 110] })).toEqual([])
    expect(refreshReasons({ ...base, livePrice: 100, band: [100, 110] })).toEqual([])
    expect(refreshReasons({ ...base, minuteVolume: 30, usualMinuteVolume: 10 })).toEqual(['volume'])
    expect(refreshReasons({ ...base, minuteVolume: 29, usualMinuteVolume: 10 })).toEqual([])
    expect(refreshReasons({ ...base, minuteVolume: 30, usualMinuteVolume: 0 })).toEqual([])
    expect(refreshReasons({ ...base, newsImpact: 90, newEvent: true })).toEqual(['news', 'event'])
  })

  it('at most once a minute', () => {
    expect(refreshReasons({ nowMs: 1_000_000, lastRefreshAt: 1_000_000 - REFRESH_LINES.minGapMs + 1, newEvent: true })).toEqual([])
    expect(refreshReasons({ nowMs: 1_000_000, lastRefreshAt: 1_000_000 - REFRESH_LINES.minGapMs, newEvent: true })).toEqual(['event'])
  })
})

describe('the adaptive levels', () => {
  const key = cellKey('hour1', 'v2', 'mid')

  it('start at the nominal levels and move once a moment by each cell\'s share below', () => {
    const table = emptyAciTable('run-y')
    expect(levelsOf(table, key)).toEqual(QUANTILE_LEVELS)
    expect(levelsOf(null, key)).toEqual(QUANTILE_LEVELS)
    // Three outcomes at a moment, all below the P10: one step, not three.
    const below = [true, true, true, true, true]
    const next = stepAciTable(table, [{ key, below }, { key, below }, { key, below }], T)
    expect(next.levels[key]![0]).toBeCloseTo(0.1 - CALIBRATION_LINES.aciGamma * 0.9, 12)
    expect(next.levels[key]![4]).toBeCloseTo(0.9 - CALIBRATION_LINES.aciGamma * 0.1, 12)
    expect(next.updatedAt).toBe(T)
    expect(next.levels[cellKey('hour1', 'v1', 'mid')]).toBeUndefined()
    // A moment with no outcome moves nothing.
    expect(stepAciTable(next, [], T + 900)).toEqual({ ...next, updatedAt: T })
  })

  it('are read back only whole and within their bounds', () => {
    const table = stepAciTable(emptyAciTable('run-y'), [{ key, below: [false, false, true, true, true] }], T)
    expect(parseAciTable(JSON.parse(JSON.stringify(table)))).toEqual(table)
    expect(parseAciTable({ ...table, levels: { [key]: [0.1, 0.25, 0.5] } })).toBeNull()
    expect(parseAciTable({ ...table, levels: { [key]: [0, 0.25, 0.5, 0.75, 0.9] } })).toBeNull()
    expect(parseAciTable({ ...table, levels: { 'hour1/v9/mid': [0.1, 0.25, 0.5, 0.75, 0.9] } })).toBeNull()
    expect(parseAciTable(null)).toBeNull()
  })
})

describe('the record', () => {
  it('carries the short horizons every quarter-hour and all five on the hour', () => {
    expect(recordedHorizons(T)).toEqual(['minutes5', 'minutes15', 'hour1', 'hours4', 'hours24'])
    expect(recordedHorizons(T + 900)).toEqual(['minutes5', 'minutes15', 'hour1'])
    expect(recordedHorizons(T + 300)).toEqual([])
    expect(recordMonth(T)).toBe('2026-10')
  })

  it('writes a forecast and its outcomes as lines that read back', () => {
    const line = predictionLine(prediction(), ['hour1', 'hours24'], 'refresh', { reasons: ['news'], previous: 'SOLUSDT:prev' })
    expect(Object.keys(line.h)).toEqual(['hour1'])
    expect(line).toMatchObject({ v: FORECAST_RECORD_VERSION, pair: 'SOLUSDT', t: T, price: 180, cls: 'large', why: 'refresh', reasons: ['news'], previous: 'SOLUSDT:prev' })
    expect(line.h.hour1).toMatchObject({ q: [-2, -1, 0.5, 2, 3], dir: 'NEUTRAL', cell: 'large', v1: [-2.1, -1.1, 0.4, 1.9, 2.9], parts: [['gbt', 1, 0.5]] })
    expect(parsePredictionLine(JSON.parse(JSON.stringify(line)))).toEqual(line)
    expect(parsePredictionLine({ ...line, v: 'forecast-record-v0' })).toBeNull()
    expect(parsePredictionLine({ ...line, h: { hour1: { ...line.h.hour1, q: [1, 2] } } })).toBeNull()
    const grid = predictionLine(prediction(), ['hour1'], 'grid')
    expect(grid.reasons).toBeUndefined()
    expect(grid.previous).toBeUndefined()
    // A class without a cell of its own was read in the horizon's.
    expect(predictionLine(prediction({ hour1: range({ ownClass: false }) }), ['hour1'], 'grid').h.hour1!.cell).toBe('pooled')

    // A move of 1.95%: under the shown P75 (2%), over the price-only one (1.9%).
    const outcome = outcomeOf({ horizon: 'hour1', quantilesPct: line.h.hour1!.q, pUp: 0.55, direction: 'NEUTRAL', width80Pct: 5, usualWidth80Pct: 4 }, T, 180, Array.from({ length: 12 }, () => ({ high: 184, low: 179, close: 180 * 1.0195 })))!
    const written = outcomeLine(line, 'hour1', outcome)
    expect(written).toMatchObject({ id: line.id, h: 'hour1', due: T + 3600, below: '00011', v1below: '00001', in80: true, cell: 'large' })
    expect(parseOutcomeLine(JSON.parse(JSON.stringify(written)))).toEqual(written)
    expect(parseOutcomeLine({ ...written, below: '0001' })).toBeNull()
    const missing = missingOutcomeLine(line, 'hour1', T + 3600, 'no bars')
    const back = parseOutcomeLine(JSON.parse(JSON.stringify(missing)))!
    expect(isMissing(back)).toBe(true)
    expect(isMissing(written)).toBe(false)
  })
})
