import { describe, expect, it } from 'vitest'
import { FORECAST_BAR_SECONDS, coarseBars, type ForecastBar } from '../shared/forecast/bars'
import { parseRunCalibration, serializeRunCalibration } from '../shared/forecast/calibrationFile'
import { type PairSeries } from '../shared/forecast/features'
import { EXCURSION_MIN_ROWS, FIRST_TOUCH, TOUCH_WINDOWS, arrivalOf, excursionCalibrationOf, firstTouchTable, touchBarsOf, type ExcursionRow, type FirstTouchTable } from '../shared/forecast/firstTouch'
import { outcomeLine, parseOutcomeLine, parsePredictionLine, predictionLine } from '../shared/forecast/forecastRecord'
import { timingOf } from '../shared/forecast/lab'
import { EXCURSION_LEVELS, FORECAST_MODELS, type ForecastModelId } from '../shared/forecast/models'
import { decodeOos, encodeOos, oosExcursion, EXCURSION_WIDTH } from '../shared/forecast/oosRecord'
import { firstTouchSec, outcomeOf } from '../shared/forecast/outcome'
import { buildPanel } from '../shared/forecast/panel'
import { makePrediction, type ForecastRange, type PredictionInput } from '../shared/forecast/prediction'
import { buildRunCalibration, type RunCalibration } from '../shared/forecast/runCalibration'
import { usualMove } from '../shared/forecast/targets'
import { arrivalWord, likelyLevels } from '../src/forecast/forecastWords'
import { promoted, recordOf, scaled } from './forecastRecords'

// PRICE AND TIME (V7.1 Stage 3; shared/forecast/{firstTouch,outcome,prediction,lab}.ts): when a target is
// reached, from the bars alone; how far the path goes, from the excursion models' levels scaled by what
// the tested paths did; the stamps an outcome keeps of when its levels were first touched; and the words
// the card and the drawer say of it -- on markets whose answers are known.

const T0 = Date.parse('2026-09-01T00:00:00Z') / 1000
/** A row needs 600 hours of history (shared/forecast/features.ts NEED): the grid starts 26 days in. */
const DAYS = 34
const GRID_FROM = T0 + 26 * 86_400

/** A walk whose moves alternate up by `up` and down by `down` of its size, so that it trends and has a
 * volatility of its own; a `seed` jitters the sizes so that no two bars are alike. */
function walk(seed: number, base: number, up: number, down: number): ForecastBar[] {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const bars: ForecastBar[] = []
  let price = base
  for (let index = 0; index < DAYS * 288; index++) {
    const open = price
    const size = 0.002 * (0.75 + 0.5 * next())
    price = price * Math.exp(index % 2 === 0 ? up * size : -down * size)
    const volume = 100 * (0.5 + next())
    bars.push({ time: T0 + index * FORECAST_BAR_SECONDS, open, high: Math.max(open, price) * (1 + 0.0005 * next()), low: Math.min(open, price) * (1 - 0.0005 * next()), close: price, volume, quoteVolume: volume * price, takerBuyVolume: volume * next(), trades: 10 })
  }
  return bars
}

/** Bitcoin, ether and a coin: the market's cross-section needs the first two. */
function marketOf(up: number, down: number): Map<string, PairSeries> {
  return new Map<string, PairSeries>(
    [
      ['BTCUSDT', walk(3, 60_000, up, down)],
      ['ETHUSDT', walk(4, 2_500, up, down)],
      ['SOLUSDT', walk(5, 150, up, down)]
    ].map(([symbol, m5]) => [symbol as string, { m5: m5 as ForecastBar[], h1: coarseBars(m5 as ForecastBar[], '1h', Number.POSITIVE_INFINITY) }])
  )
}

describe('the first-touch table', () => {
  const market = marketOf(1, 1)
  const panel = buildPanel(market, { stepSec: 900, fromSec: GRID_FROM, toSec: T0 + DAYS * 86_400 })
  const table = firstTouchTable(market, panel)

  it('counts, for every moment with the bars after it, whether each level was touched within each window, and when', () => {
    expect(table.n).toBeGreaterThan(1000)
    expect(table.n).toBeLessThan(panel.rows)
    for (const side of ['up', 'down'] as const) {
      const curve = table[side]
      expect(curve.within).toHaveLength(FIRST_TOUCH.levels.length)
      for (const [level, shares] of curve.within.entries()) {
        expect(shares).toHaveLength(TOUCH_WINDOWS.length)
        // A share, growing with the window: what is touched within five minutes is touched within an hour.
        for (const [at, share] of shares.entries()) {
          expect(share).toBeGreaterThanOrEqual(0)
          expect(share).toBeLessThanOrEqual(1)
          if (at > 0) expect(share).toBeGreaterThanOrEqual(shares[at - 1])
        }
        // And falling with the level: a farther target is reached less often.
        if (level > 0) for (const at of shares.keys()) expect(shares[at]).toBeLessThanOrEqual(curve.within[level - 1][at])
        const median = curve.medianBars[level]
        if (median !== null) {
          expect(median).toBeGreaterThanOrEqual(1)
          expect(median).toBeLessThanOrEqual(FIRST_TOUCH.windows.hours4)
        }
      }
    }
    // A quarter of an hourly move is mostly reached within four hours even on this zig-zag, which wanders
    // nowhere; three hourly moves almost never within five minutes.
    expect(table.up.within[0][3]).toBeGreaterThan(0.5)
    expect(table.up.within[FIRST_TOUCH.levels.length - 1][0]).toBeLessThan(0.05)
    // A zig-zag's regime is sideways throughout, and with rows enough it has a curve of its own, the pooled
    // one's figures; a regime with too few rows has none.
    expect(Object.keys(table.byRegime)).toEqual(['sideways'])
    expect(table.byRegime.sideways!.n).toBe(table.n)
    expect(table.byRegime.sideways!.up.within[1][2]).toBe(table.up.within[1][2])
    expect(table.byRegime.panic).toBeUndefined()
  })

  it('counts a touch from the first bar that reached the level, and none beyond the longest window', () => {
    // A usual hourly move of 1% in log terms: a high just past e^0.005 touches the half level.
    const flat = { high: 100, low: 100 }
    const after = [flat, { high: 100 * Math.exp(0.0051), low: 100 }, flat, { high: 100 * Math.exp(0.0201), low: 100 * Math.exp(-0.0026) }]
    const bars = touchBarsOf(100, 0.01, after)
    expect(bars.up).toEqual([2, 2, 4, 4, 4, 4, 0])
    expect(bars.down).toEqual([4, 0, 0, 0, 0, 0, 0])
    expect(touchBarsOf(100, 0.01, []).up).toEqual([0, 0, 0, 0, 0, 0, 0])
    // A touch on the 49th bar is beyond four hours: not counted.
    const late = Array.from({ length: 60 }, (_, at) => (at === 48 ? { high: 100 * Math.exp(0.05), low: 100 } : flat))
    expect(touchBarsOf(100, 0.01, late).up).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(touchBarsOf(100, 0.01, late.slice(1)).up[0]).toBe(48)
  })

  it('reads a market that climbs as reaching up sooner than down', () => {
    const climbing = marketOf(2, 1)
    const up = firstTouchTable(climbing, buildPanel(climbing, { stepSec: 900, fromSec: GRID_FROM, toSec: T0 + DAYS * 86_400 }))
    for (const level of [1, 2, 3]) expect(up.up.within[level][3]).toBeGreaterThan(up.down.within[level][3])
    expect(up.up.medianBars[1]!).toBeLessThan(up.down.medianBars[1] ?? Number.POSITIVE_INFINITY)
  })

  it('is read at a distance between its levels, at the ends beyond them, and in the pooled curve without the regime\'s', () => {
    const at = (k: number): number => arrivalOf(table, k, 'up').pWithin.hour1
    const levels = FIRST_TOUCH.levels
    expect(at(levels[0])).toBeCloseTo(table.up.within[0][2], 12)
    expect(at(levels[2])).toBeCloseTo(table.up.within[2][2], 12)
    const between = at((levels[1] + levels[2]) / 2)
    expect(between).toBeCloseTo((table.up.within[1][2] + table.up.within[2][2]) / 2, 12)
    expect(at(0.01)).toBe(at(levels[0]))
    expect(at(99)).toBe(at(levels[levels.length - 1]))
    expect(arrivalOf(table, -1, 'down').pWithin.hours4).toBe(arrivalOf(table, 1, 'down').pWithin.hours4)
    // A regime without a curve of its own reads the pooled one; one with its own reads that.
    expect(arrivalOf(table, 1, 'up', 'panic')).toEqual(arrivalOf(table, 1, 'up'))
    expect(arrivalOf(table, 1, 'up', 'sideways').pWithin.hour1).toBeCloseTo(table.byRegime.sideways!.up.within[3][2], 12)
    const reached = arrivalOf(table, 0.5, 'up')
    expect(Object.keys(reached.pWithin).sort()).toEqual([...TOUCH_WINDOWS].sort())
    expect(reached.medianBars).not.toBeNull()
  })
})

describe('the excursion calibration', () => {
  /** Rows whose levels read b, 2b and 4b (b growing with the row) and whose high came `ratio` x b, the low
   * mirrored: ratios that are exact in binary, so that a scaled level holds exactly where it should. */
  const rows = (count: number, ratio: number, week: (index: number) => number): ExcursionRow[] =>
    Array.from({ length: count }, (_, index) => {
      const b = 1 + index / count
      return { best: ratio * b, worst: -ratio * b, high: [b, 2 * b, 4 * b], low: [-b, -2 * b, -4 * b], week: week(index) }
    })

  it('scales each level by the quantile of what came against what was read, inside its bounds, and scores it on later weeks', () => {
    // The high came twice the first level's reading: the factors make the levels hold their shares.
    const made = excursionCalibrationOf(rows(2000, 2, (index) => Math.floor((index * 4) / 2000)))!
    expect(made).not.toBeNull()
    expect(made.high).toEqual([2, 1, 0.5])
    expect(made.low).toEqual([2, 1, 0.5])
    expect(made.honest.n).toBe(1500)
    // Scored on weeks 2 to 4 with factors from the weeks before: every scaled level held; unscaled, the
    // first did not and the others did.
    expect(made.honest.high).toEqual([1, 1, 1])
    expect(made.honest.low).toEqual([1, 1, 1])
    expect(made.honest.rawHigh).toEqual([0, 1, 1])
    expect(made.honest.rawLow).toEqual([0, 1, 1])
    // A reading a hundredth of what came is scaled no more than tenfold.
    expect(excursionCalibrationOf(rows(2000, 100, (index) => Math.floor((index * 4) / 2000)))!.high[0]).toBe(10)
    expect(excursionCalibrationOf(rows(EXCURSION_MIN_ROWS - 1, 2, () => 1))).toBeNull()
  })
})

describe('an outcome\'s touches', () => {
  const bar = (high: number, low: number): { high: number; low: number; close: number } => ({ high, low, close: (high + low) / 2 })
  const path = [bar(100.2, 99.9), bar(100.3, 99.8), bar(100.6, 100.1), bar(100.4, 99.5), bar(100.9, 99.9), bar(101, 100), bar(100.8, 97.9), bar(100.5, 99.1), bar(100.7, 99.2), bar(100.8, 99.4), bar(100.9, 99.6), bar(101.2, 99.7)]

  it('stamps when the path first reached each level, and never where it did not', () => {
    expect(firstTouchSec(0.5, 100, path)).toBe(900)
    expect(firstTouchSec(-2, 100, path)).toBe(2100)
    expect(firstTouchSec(3, 100, path)).toBeNull()
    expect(firstTouchSec(0, 100, path)).toBe(300)
    // A high at the level itself is a touch; so is a low at it.
    expect(firstTouchSec(0, 100, [bar(99.9, 99.5), bar(100, 99.7)])).toBe(600)
    expect(firstTouchSec(-1, 100, [bar(100.4, 99.2), bar(100.1, 99)])).toBe(600)
    const outcome = outcomeOf({ horizon: 'hour1', quantilesPct: [-2, -1, 0.5, 2, 3], pUp: 0.5, direction: 'NEUTRAL', width80Pct: 5, usualWidth80Pct: 4 }, T0, 100, path)!
    expect(outcome.touch).toEqual({ target: 900, upper: null, lower: 2100 })
  })
})

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
    quality: { score: 55, parts: { direction: 0, range: 80, calibration: 90, news: null, confirmation: null, agreement: 100, freshness: 100 } },
    width80Pct: 5,
    usualWidth80Pct: 4,
    skill: 0.01,
    directionSkill: -0.01,
    ownClass: true,
    expiresAt: (T0 + 3600) * 1000,
    contributions: [{ model: 'gbt', weight: 1, medianLogPct: 0.5 }],
    calibrationShiftLogPct: 0,
    newsShiftLogPct: 0,
    news: { v3: null, v4: null },
    spreadStretch: 1,
    variants: { v1: { medianPct: 0.4, lowPct: -1.1, highPct: 1.9, quantilesPct: [-2.1, -1.1, 0.4, 1.9, 2.9], pUp: 0.54, pUpMapped: 0.54 } },
    excursion: { highPct: [0.8, 1.5, 2.2], lowPct: [-0.7, -1.3, -1.9], held: { high: [0.5, 0.8, 0.9], low: [0.5, 0.79, 0.9] } },
    arrival: { targetPct: 0.5, k: 0.6, pWithin: { minutes5: 0.1, minutes15: 0.25, hour1: 0.55, hours4: 0.8 }, medianMinutes: 25, unlikely: false },
    ...patch
  }
}

const PREDICTION = {
  pair: 'SOLUSDT',
  generatedAt: T0 * 1000 + 7000,
  direction: 'NEUTRAL' as const,
  horizons: { hour1: range() },
  currentPrice: 180,
  confidence: 55,
  reliability: 'HIGH' as const,
  invalidationConditions: [],
  modelVersion: 'models-v3',
  id: 'SOLUSDT:1:2',
  strong: false,
  uncertain: false,
  bestHorizon: 'hour1' as const,
  pairClass: 'mid' as const,
  regime: 'sideways' as const,
  barTime: T0,
  market: null,
  versions: { prediction: 'p', models: 'm', features: 'f', ensemble: 'e', calibration: 'c', runCalibration: 'r', news: 'n', quality: 'q', run: 'run', foldsRun: 'run' }
}

describe('on record', () => {
  it('keeps the likely levels and the arrival on a forecast\'s line, the touches on its outcome\'s, and reads them back', () => {
    const line = predictionLine(PREDICTION, ['hour1'], 'grid')
    expect(line.h.hour1!.ex).toEqual([0.8, 1.5, 2.2, -0.7, -1.3, -1.9])
    expect(line.h.hour1!.arr).toEqual({ k: 0.6, p: [0.1, 0.25, 0.55, 0.8], med: 25, unlikely: false })
    expect(parsePredictionLine(JSON.parse(JSON.stringify(line)))).toEqual(line)
    const bare = predictionLine({ ...PREDICTION, horizons: { hour1: range({ excursion: undefined, arrival: undefined }) } }, ['hour1'], 'grid')
    expect(bare.h.hour1!.ex).toBeUndefined()
    expect(bare.h.hour1!.arr).toBeUndefined()
    const path = Array.from({ length: 12 }, (_, at) => ({ high: 180 * (1 + (at >= 4 ? 0.006 : 0.001)), low: 180 * (1 - 0.001), close: 180 }))
    const outcome = outcomeOf({ horizon: 'hour1', quantilesPct: range().quantilesPct, pUp: 0.55, direction: 'NEUTRAL', width80Pct: 5, usualWidth80Pct: 4 }, T0, 180, path)!
    const written = outcomeLine(line, 'hour1', outcome)
    expect(written.touch).toEqual([1500, null, null])
    expect(parseOutcomeLine(JSON.parse(JSON.stringify(written)))).toEqual(written)
  })

  it('judges the arrival said against the touch seen, the word UNLIKELY, the minutes, and whether the 80% levels held', () => {
    const line = predictionLine(PREDICTION, ['hour1'], 'grid')
    const unlikely = predictionLine({ ...PREDICTION, id: 'SOLUSDT:1:3', horizons: { hour1: range({ arrival: { targetPct: 3, k: 3, pWithin: { minutes5: 0.01, minutes15: 0.03, hour1: 0.1, hours4: 0.3 }, medianMinutes: null, unlikely: true } }) } }, ['hour1'], 'grid')
    const predictions = new Map([line, unlikely].map((entry) => [entry.id, entry]))
    const outcomes = [
      // Reached at the hour's very end: within the hour's window still.
      { ...outcomeLine(line, 'hour1', { barTime: T0, dueAt: T0 + 3600, movePct: 1, bestPct: 1.4, worstPct: -0.5, below: [false, false, false, true, true], inside80: true, inside50: true, wentUp: true, errors: [], touch: { target: 3600, upper: null, lower: null } }) },
      { ...outcomeLine(unlikely, 'hour1', { barTime: T0, dueAt: T0 + 3600, movePct: -0.2, bestPct: 1.6, worstPct: -1.4, below: [false, false, true, true, true], inside80: true, inside50: true, wentUp: false, errors: [], touch: { target: null, upper: null, lower: null } }) }
    ]
    const timing = timingOf(predictions, outcomes, 'hour1')!
    expect(timing.n).toBe(2)
    expect(timing.predicted).toBeCloseTo((0.55 + 0.1) / 2, 12)
    expect(timing.reached).toBe(0.5)
    expect(timing.unlikely).toBe(1)
    expect(timing.unlikelyReached).toBe(0)
    expect(timing.saidMinutes).toBe(25)
    expect(timing.seenMinutes).toBe(60)
    // The first path stayed under the 80% high and above the 80% low; the second rose past 1.5 and fell past -1.3.
    expect(timing.excursion).toEqual({ n: 2, high80: 0.5, low80: 0.5 })
    expect(timingOf(predictions, outcomes, 'hours4')).toBeNull()
  })
})

describe('the words', () => {
  it('say the likely levels as prices from the close, and when the expected price is reached', () => {
    const levels = likelyLevels(PREDICTION, range())!
    expect(levels.highPct).toBe(1.5)
    expect(levels.high).toBeCloseTo(180 * 1.015, 9)
    expect(levels.lowPct).toBe(-1.3)
    expect(likelyLevels(PREDICTION, range({ excursion: undefined }))).toBeNull()
    expect(arrivalWord(range(), 'hour1')).toBe('55% within 1 hour, typically in 25 min')
    expect(arrivalWord(range({ arrival: { ...range().arrival!, medianMinutes: null } }), 'hours24')).toBe('80% within 4 hours')
    expect(arrivalWord(range({ arrival: { ...range().arrival!, unlikely: true } }), 'minutes15')).toBe('unlikely within 15 min (25%)')
    expect(arrivalWord(range({ arrival: undefined }), 'hour1')).toBe('—')
  })
})

/** One row's models: gbt knows the move's scale and drift, the rest read like persistence. */
function modelsOf(sigma: number, mu: number, floor: number[]): Record<ForecastModelId, number[]> {
  return Object.fromEntries(FORECAST_MODELS.map((model) => [model, model === 'gbt' ? scaled(sigma, mu) : floor])) as Record<ForecastModelId, number[]>
}

describe('the prediction', () => {
  const market = marketOf(1, 1)
  const panel = buildPanel(market, { stepSec: 900, fromSec: GRID_FROM, toSec: T0 + DAYS * 86_400 })
  const touch: FirstTouchTable = firstTouchTable(market, panel)
  const calibration: RunCalibration = buildRunCalibration(new Map([['hour1', recordOf({ rows: 6000, seed: 61, horizon: 'hour1' })]]), promoted('hour1', ['persistence', 'gbt']), 'run-time', touch)
  calibration.horizons.hour1!.excursion = { version: 'excursion-v1', high: [1, 1.25, 1.5], low: [1, 1.25, 1.5], honest: { high: [0.5, 0.8, 0.9], low: [0.5, 0.8, 0.9], rawHigh: [0.4, 0.7, 0.8], rawLow: [0.4, 0.7, 0.8], n: 4000 } }

  const input = (patch: Partial<PredictionInput> = {}): PredictionInput => ({
    pair: 'SOLUSDT',
    pairClass: 'mid',
    regime: 'sideways',
    barTime: T0 + 5 * 86_400,
    price: 182.4,
    generatedAt: (T0 + 5 * 86_400) * 1000 + 7000,
    rv24h: 0.04,
    rvRatio: 1,
    models: { hour1: modelsOf(1, 0.4, scaled(1.25)) },
    calibration,
    runId: 'run-time',
    foldsRunId: 'run-time',
    ...patch
  })

  it('carries the likely high and low, scaled by the calibration, and when its median is reached, from the table', () => {
    const hour = makePrediction(input({ excursion: { hour1: { high: [0.5, 1, 1.5], low: [-0.5, -1, -1.5] } } }))!.horizons.hour1!
    const usual = usualMove(0.04, 12)
    expect(hour.excursion).toBeDefined()
    expect(hour.excursion!.highPct).toHaveLength(EXCURSION_LEVELS.length)
    expect(hour.excursion!.highPct[0]).toBeCloseTo((Math.exp(0.5 * usual) - 1) * 100, 9)
    expect(hour.excursion!.highPct[1]).toBeCloseTo((Math.exp(1.25 * usual) - 1) * 100, 9)
    expect(hour.excursion!.lowPct[2]).toBeCloseTo((Math.exp(-2.25 * usual) - 1) * 100, 9)
    expect(hour.excursion!.held).toEqual({ high: [0.5, 0.8, 0.9], low: [0.5, 0.8, 0.9] })
    expect(hour.arrival).toBeDefined()
    expect(hour.arrival!.targetPct).toBe(hour.medianPct)
    expect(hour.arrival!.k).toBeCloseTo(Math.abs(Math.log(1 + hour.medianPct! / 100)) / usual, 9)
    expect(hour.arrival!.pWithin).toEqual(arrivalOf(touch, hour.arrival!.k, hour.medianPct! >= 0 ? 'up' : 'down', 'sideways').pWithin)
    expect(hour.arrival!.unlikely).toBe(!(hour.arrival!.pWithin.hour1 >= FIRST_TOUCH.unlikely))
    // The typical time is read between two levels' medians: minutes, not whole bars.
    expect(hour.arrival!.medianMinutes === null || hour.arrival!.medianMinutes > 0).toBe(true)
    // A median five usual moves away is almost never reached within the hour: UNLIKELY, and no time said.
    const far = makePrediction(input({ models: { hour1: modelsOf(1, 5, scaled(1.25)) } }))!.horizons.hour1!
    expect(far.arrival!.pWithin.hour1).toBeLessThan(FIRST_TOUCH.unlikely)
    expect(far.arrival!.unlikely).toBe(true)
    expect(hour.arrival!.unlikely).toBe(false)
    // Without readings of the excursion models, no levels; without a table, no arrival.
    expect(makePrediction(input())!.horizons.hour1!.excursion).toBeUndefined()
    const tableless: RunCalibration = { ...calibration, touch: undefined }
    expect(makePrediction(input({ calibration: tableless, excursion: { hour1: { high: [0.5, 1, 1.5], low: [-0.5, -1, -1.5] } } }))!.horizons.hour1!.arrival).toBeUndefined()
  })

  it('goes to the calibration file and back with its table and levels, and the record with its readings', () => {
    const back = parseRunCalibration(serializeRunCalibration(calibration))!
    expect(back).not.toBeNull()
    expect(back.touch!.n).toBe(touch.n)
    expect(back.touch!.up.within[0][3]).toBeCloseTo(touch.up.within[0][3], 6)
    expect(back.horizons.hour1!.excursion!.high).toEqual([1, 1.25, 1.5])
    const damaged = JSON.parse(serializeRunCalibration(calibration))
    damaged.touch.up.within[0] = [0.1]
    expect(parseRunCalibration(JSON.stringify(damaged))).toBeNull()
    const record = recordOf({ rows: 300, seed: 62 })
    record.excursion = Float32Array.from({ length: 300 * EXCURSION_WIDTH }, (_, at) => (at % EXCURSION_WIDTH < 3 ? 1 + (at % EXCURSION_WIDTH) : -(at % EXCURSION_WIDTH)))
    const read = decodeOos(encodeOos(record))!
    expect(oosExcursion(read, 7)).toEqual({ high: [1, 2, 3], low: [-3, -4, -5] })
    expect(oosExcursion(decodeOos(encodeOos(recordOf({ rows: 300, seed: 63 })))!, 7)).toBeUndefined()
  })
})
