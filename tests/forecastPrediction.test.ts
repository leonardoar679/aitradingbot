import { describe, expect, it } from 'vitest'
import { DIRECTION_LINES, classify, confidenceOf, type CallInput } from '../shared/forecast/direction'
import type { Horizon } from '../shared/forecast/features'
import { FORECAST_MODELS, type ForecastModelId } from '../shared/forecast/models'
import { PREDICTION_VERSION, bestHorizonOf, makePrediction, type ForecastRange, type PredictionInput } from '../shared/forecast/prediction'
import { RELIABILITY_LINES, reliabilityOf, type ReliabilityInput } from '../shared/forecast/reliability'
import { buildRunCalibration, cellOf, type HonestScore, type RunCalibration } from '../shared/forecast/runCalibration'
import { MARKET_SHOCK_VERSION, type MarketShockRules } from '../shared/forecast/marketShock'
import { noShockRecord, stretchShock } from '../shared/forecast/shock'
import { usualMove } from '../shared/forecast/targets'
import { promoted, recordOf, scaled } from './forecastRecords'

// THE PREDICTION (shared/forecast/{direction,reliability,prediction}.ts; the V6 document, §5-10, §25,
// §30, §38, §57 and §59-61): the call by its fixed lines, line by line; how far a forecast can be
// trusted; and §5's object, made from the models' quantiles and a run's calibration.

const call = (patch: Partial<CallInput> = {}): ReturnType<typeof classify> =>
  classify({ pUp: 0.6, medianPct: 0.5, p10Pct: -0.5, p90Pct: 1.5, width80Pct: 2, usualWidth80Pct: 2, quality: null, directionSkill: 0.02, ...patch })

describe('the call', () => {
  it('is BULLISH at 58% with the median above zero and a direction that was skilful, and NEUTRAL short of any line', () => {
    expect(call()).toEqual({ direction: 'BULLISH', strong: false, uncertain: false })
    expect(call({ pUp: 0.579 }).direction).toBe('NEUTRAL')
    expect(call({ medianPct: 0 }).direction).toBe('NEUTRAL')
    expect(call({ directionSkill: 0.0099 }).direction).toBe('NEUTRAL')
    expect(call({ directionSkill: null }).direction).toBe('NEUTRAL')
    expect(call({ directionSkill: Number.NaN }).direction).toBe('NEUTRAL')
    expect(call({ pUp: DIRECTION_LINES.bullish, directionSkill: DIRECTION_LINES.minDirectionSkill }).direction).toBe('BULLISH')
  })

  it('is BEARISH mirrored', () => {
    expect(call({ pUp: 0.42, medianPct: -0.5, p10Pct: -1.5, p90Pct: 0.5 }).direction).toBe('BEARISH')
    expect(call({ pUp: 0.421, medianPct: -0.5 }).direction).toBe('NEUTRAL')
    expect(call({ pUp: 0.42, medianPct: 0 }).direction).toBe('NEUTRAL')
  })

  it('is STRONG only with 65%, a median of 1%, a quality of 75 and the bad case no further than the median', () => {
    const strong: Partial<CallInput> = { pUp: 0.66, medianPct: 1.2, p10Pct: -1.0, p90Pct: 3, quality: 80 }
    expect(call(strong)).toEqual({ direction: 'BULLISH', strong: true, uncertain: false })
    expect(call({ ...strong, pUp: 0.64 }).strong).toBe(false)
    expect(call({ ...strong, medianPct: 0.99, p10Pct: -0.9 }).strong).toBe(false)
    expect(call({ ...strong, quality: 74 }).strong).toBe(false)
    expect(call({ ...strong, quality: null }).strong).toBe(false)
    expect(call({ ...strong, p10Pct: -1.21 }).strong).toBe(false)
    const bear: Partial<CallInput> = { pUp: 0.34, medianPct: -1.2, p10Pct: -3, p90Pct: 1.0, quality: 80 }
    expect(call(bear)).toEqual({ direction: 'BEARISH', strong: true, uncertain: false })
    expect(call({ ...bear, p90Pct: 1.21 }).strong).toBe(false)
    expect(call({ ...bear, pUp: 0.36 }).strong).toBe(false)
  })

  it('is NEUTRAL, marked UNCERTAIN, where the range is over three times its class\'s usual width, however sure', () => {
    expect(call({ pUp: 0.9, medianPct: 3, width80Pct: 6.01, quality: 99 })).toEqual({ direction: 'NEUTRAL', strong: false, uncertain: true })
    expect(call({ width80Pct: 6 }).uncertain).toBe(false)
    expect(call({ usualWidth80Pct: 0, width80Pct: 100 }).uncertain).toBe(false)
  })

  it('is as sure as the calibrated chance of the way it calls, or leans', () => {
    expect(confidenceOf(0.62, 'BULLISH')).toBe(62)
    expect(confidenceOf(0.62, 'BEARISH')).toBe(38)
    expect(confidenceOf(0.38, 'NEUTRAL')).toBe(62)
  })
})

describe('the reliability', () => {
  const base: ReliabilityInput = { cellRows: 2500, coverage80: 0.81, disagreement: 0.1, regime: 'sideways', rvRatio: 1 }
  const grade = (patch: Partial<ReliabilityInput>): string => reliabilityOf({ ...base, ...patch }).reliability

  it('is HIGH on every count, and as low as its weakest', () => {
    expect(grade({})).toBe('HIGH')
    expect(grade({ cellRows: RELIABILITY_LINES.rows.high - 1 })).toBe('MEDIUM')
    expect(grade({ cellRows: RELIABILITY_LINES.rows.medium - 1 })).toBe('LOW')
    expect(grade({ coverage80: 0.769 })).toBe('MEDIUM')
    expect(grade({ coverage80: 0.861 })).toBe('LOW')
    expect(grade({ coverage80: Number.NaN })).toBe('LOW')
    expect(grade({ disagreement: 0.16 })).toBe('MEDIUM')
    expect(grade({ disagreement: 0.31 })).toBe('LOW')
    expect(grade({ regime: 'panic' })).toBe('LOW')
    expect(grade({ regime: 'high-vol' })).toBe('MEDIUM')
    expect(grade({ rvRatio: RELIABILITY_LINES.rvRatio })).toBe('MEDIUM')
  })

  it('says why, by its weakest readings', () => {
    expect(reliabilityOf({ ...base, regime: 'panic', cellRows: 100 }).reasons).toEqual(['tested on 100 outcomes', 'the market is in panic'])
    expect(reliabilityOf({ ...base, disagreement: 0.2 }).reasons).toEqual(['the models disagree'])
  })
})

/** One row's models: gbt knows the move's scale and drift, the rest read like persistence. */
function modelsOf(sigma: number, mu: number, floor: number[]): Record<ForecastModelId, number[]> {
  return Object.fromEntries(FORECAST_MODELS.map((model) => [model, model === 'gbt' ? scaled(sigma, mu) : floor])) as Record<ForecastModelId, number[]>
}

const FLAT: RunCalibration = buildRunCalibration(
  new Map([
    ['hour1', recordOf({ rows: 12_000, seed: 31, horizon: 'hour1' })],
    ['hours4', recordOf({ rows: 12_000, seed: 32, horizon: 'hours4' })]
  ]),
  [...promoted('hour1', ['persistence', 'gbt']), ...promoted('hours4', ['persistence', 'gbt'])],
  'run-flat'
)
const KNOWING: RunCalibration = buildRunCalibration(new Map([['hour1', recordOf({ rows: 12_000, seed: 33, drift: 0.6, horizon: 'hour1' })]]), promoted('hour1', ['persistence', 'gbt']), 'run-knowing')
const FLOOR = scaled(1.25)

function input(calibration: RunCalibration, mu: number, patch: Partial<PredictionInput> = {}): PredictionInput {
  return {
    pair: 'SOLUSDT',
    pairClass: 'mid',
    regime: 'sideways',
    barTime: Date.parse('2026-10-13T15:00:00Z') / 1000,
    price: 182.4,
    generatedAt: Date.parse('2026-10-13T15:00:07Z'),
    rv24h: 0.04,
    rvRatio: 1,
    models: { hour1: modelsOf(1, mu, FLOOR), hours4: modelsOf(1, mu, FLOOR) },
    calibration,
    runId: 'run-x',
    foldsRunId: 'run-x',
    ...patch
  }
}

describe('the prediction', () => {
  it('is §5\'s object: a likely range a horizon, its prices, a call, a confidence, a reliability and what would undo it', () => {
    const prediction = makePrediction(input(FLAT, 0))!
    expect(prediction).not.toBeNull()
    expect(Object.keys(prediction.horizons).sort()).toEqual(['hour1', 'hours4'])
    expect(prediction).toMatchObject({ pair: 'SOLUSDT', currentPrice: 182.4, generatedAt: Date.parse('2026-10-13T15:00:07Z') })
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(prediction.direction)
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(prediction.reliability)
    expect(typeof prediction.confidence).toBe('number')
    expect(prediction.invalidationConditions.length).toBeGreaterThan(0)
    expect(prediction.modelVersion).toMatch(/run-x$/)
    expect(prediction.versions.prediction).toBe(PREDICTION_VERSION)
    const hour: ForecastRange = prediction.horizons.hour1!
    expect(hour.confidenceLevel).toBe(50)
    expect(hour.quantilesPct.every((value, index) => index === 0 || value >= hour.quantilesPct[index - 1])).toBe(true)
    expect([hour.bearPct, hour.lowPct, hour.medianPct, hour.highPct, hour.bullPct]).toEqual(hour.quantilesPct)
    expect(hour.lowerPrice).toBeCloseTo(182.4 * (1 + hour.lowPct / 100), 9)
    expect(hour.upperPrice).toBeCloseTo(182.4 * (1 + hour.highPct / 100), 9)
    // The 1-hour forecast from the 15:00 close is no longer valid at 16:00 (§38).
    expect(hour.expiresAt).toBe(Date.parse('2026-10-13T16:00:00Z'))
    expect(prediction.horizons.hours4!.expiresAt).toBe(Date.parse('2026-10-13T19:00:00Z'))
    // V3 and V4 are V2 itself where no story moves it.
    expect(Object.keys(hour.variants).sort()).toEqual(['v1', 'v2', 'v3', 'v4'])
    expect(hour.variants.v4).toEqual(hour.variants.v2)
    expect(hour.variants.v2!.quantilesPct).toEqual(hour.quantilesPct)
    expect(hour.variants.v1!.quantilesPct).toHaveLength(5)
    // The class's usual width is in percent, as the range's: a row of the usual size, on the record's
    // day volatility, is about as wide.
    const typical = makePrediction(input(FLAT, 0, { rv24h: 0.03, models: { hour1: modelsOf(1.25, 0, FLOOR) } }))!.horizons.hour1!
    expect(typical.width80Pct / typical.usualWidth80Pct).toBeGreaterThan(0.75)
    expect(typical.width80Pct / typical.usualWidth80Pct).toBeLessThan(1.33)
  })

  it('records each model\'s part, which with the calibration\'s shift adds up to the median', () => {
    const hour = makePrediction(input(FLAT, 0.4))!.horizons.hour1!
    expect(hour.contributions.map((member) => member.model)).toEqual(['gbt'])
    const total = hour.contributions.reduce((sum, member) => sum + member.weight * member.medianLogPct, 0) + hour.calibrationShiftLogPct
    expect(total).toBeCloseTo(Math.log(1 + hour.medianPct! / 100) * 100, 9)
    expect(hour.contributions[0].medianLogPct).toBeCloseTo(0.4 * usualMove(0.04, 12) * 100, 9)
  })

  it('calls no way where the walk forward found no direction, however far up the models read, and says the base rate', () => {
    const prediction = makePrediction(input(FLAT, 1.5))!
    expect(prediction.horizons.hour1!.directionSkill).toBeLessThan(DIRECTION_LINES.minDirectionSkill)
    expect(prediction.horizons.hour1!.direction).toBe('NEUTRAL')
    // Knowing no more than the base rate, it says the base rate, whatever its map read.
    const base = cellOf(FLAT.horizons.hour1!.variants.v2, 'mid').honest!.upShare
    expect(prediction.horizons.hour1!.pUp).toBe(base)
    expect(prediction.horizons.hour1!.variants.v2!.pUp).toBe(base)
    expect(prediction.horizons.hour1!.variants.v1!.pUp).toBe(cellOf(FLAT.horizons.hour1!.variants.v1, 'mid').honest!.upShare)
    expect(prediction.confidence).toBe(Math.round(100 * Math.max(base, 1 - base)))
    expect(prediction.direction).toBe('NEUTRAL')
    expect(prediction.invalidationConditions[0]).toMatch(/^The price leaves .+ the .+ 80% range\.$/)
  })

  it('calls the way where it found one, at the best horizon, with what would undo it', () => {
    const up = makePrediction(input(KNOWING, 1.5, { models: { hour1: modelsOf(1, 1.5, FLOOR) } }))!
    expect(up.bestHorizon).toBe('hour1')
    expect(up.horizons.hour1!.directionSkill).toBeGreaterThan(DIRECTION_LINES.minDirectionSkill)
    expect(up.direction).toBe('BULLISH')
    expect(up.confidence).toBe(Math.round(up.horizons.hour1!.pUp * 100))
    // Its direction skilful, P(up) is the map's reading.
    expect(up.horizons.hour1!.pUp).toBe(up.horizons.hour1!.pUpMapped)
    expect(up.horizons.hour1!.pUp).toBeGreaterThan(0.58)
    expect(up.invalidationConditions[0]).toMatch(/^The price falls below .+, the 1-hour bear case\.$/)
    // And the market turning on it (§5).
    expect(up.invalidationConditions.slice(1)).toEqual(['Bitcoin falls 1% within fifteen minutes.', 'The market turns to panic.', 'A story of impact 70 or more goes against the coin.'])
    const bear = up.horizons.hour1!.quantilePrices[0]
    expect(up.invalidationConditions[0]).toContain(Number(bear.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 10 }))
    const down = makePrediction(input(KNOWING, -1.5, { models: { hour1: modelsOf(1, -1.5, FLOOR) } }))!
    expect(down.direction).toBe('BEARISH')
    expect(down.invalidationConditions[0]).toMatch(/^The price rises above .+, the 1-hour bull case\.$/)
    expect(down.invalidationConditions.slice(1)).toEqual(['Bitcoin rises 1% within fifteen minutes.', 'The market turns to a rally.', 'A story of impact 70 or more goes for the coin.'])
  })

  /** KNOWING with each of its scores at the hour edited. */
  const edited = (patch: Partial<HonestScore>): RunCalibration => {
    const copy = structuredClone(KNOWING)
    const v2 = copy.horizons.hour1!.variants.v2
    Object.assign(v2.honest.pooled!, patch)
    for (const score of Object.values(v2.honest.byClass)) Object.assign(score!, patch)
    return copy
  }

  it('calls no way at a horizon whose direction skill was under its line, and none for the pair without a best horizon', () => {
    const models = { hour1: modelsOf(1, 1.5, FLOOR) }
    // The coin's last hour and the market going its way: its quality clears STRONG's 75.
    const market = { z1h: 1.5, breadth1h: 0.8 }
    const sure = makePrediction(input(KNOWING, 1.5, { models, market }))!
    expect(sure.direction).toBe('BULLISH')
    expect(sure.horizons.hour1!.quality.score).toBeGreaterThanOrEqual(75)
    expect(sure.strong).toBe(true)
    // Against it, the quality is lower; and read from bars five minutes old as well, it falls under
    // STRONG's 75: BULLISH, not STRONG.
    const against = makePrediction(input(KNOWING, 1.5, { models, market: { z1h: -2, breadth1h: 0.1 } }))!
    expect(against.horizons.hour1!.quality.score).toBeLessThan(sure.horizons.hour1!.quality.score)
    expect(against.direction).toBe('BULLISH')
    const late = makePrediction(input(KNOWING, 1.5, { models, market: { z1h: -2, breadth1h: 0.1 }, generatedAt: Date.parse('2026-10-13T15:05:00Z') }))!
    expect(late.horizons.hour1!.quality.score).toBeLessThan(75)
    expect(late.direction).toBe('BULLISH')
    expect(late.strong).toBe(false)
    const unskilled = makePrediction(input(edited({ directionSkill: 0.005 }), 1.5, { models, market }))!
    expect(unskilled.horizons.hour1!.direction).toBe('NEUTRAL')
    const noBest = makePrediction(input(edited({ skill: -0.01 }), 1.5, { models, market }))!
    expect(noBest.bestHorizon).toBeNull()
    expect(noBest.horizons.hour1!.direction).toBe('BULLISH')
    expect(noBest.direction).toBe('NEUTRAL')
    expect(noBest.strong).toBe(false)
  })

  it('takes as its best horizon the one that beat persistence by most, and has none where none did', () => {
    const range = (skill: number | null): ForecastRange => ({ skill }) as ForecastRange
    expect(bestHorizonOf({ hour1: range(0.01), hours4: range(0.03), minutes5: range(0.02) })).toBe('hours4')
    expect(bestHorizonOf({ hour1: range(-0.01), hours4: range(null) })).toBeNull()
  })

  it("reads each cell at the levels the adaptive step keeps for it", () => {
    const asked: string[] = []
    const plain = makePrediction(input(FLAT, 0))!.horizons.hour1!
    const moved = makePrediction(
      input(FLAT, 0, {
        levels: (horizon, variant, cell) => {
          asked.push(`${horizon}/${variant}/${cell}`)
          return [0.05, 0.25, 0.5, 0.75, 0.95]
        }
      })
    )!.horizons.hour1!
    expect(asked).toContain('hour1/v2/mid')
    expect(asked).toContain('hour1/v1/mid')
    expect(moved.width80Pct).toBeGreaterThan(plain.width80Pct)
    // A class without a cell of its own reads the horizon's.
    const pooledOnly = structuredClone(FLAT)
    for (const variant of Object.values(pooledOnly.horizons.hour1!.variants)) delete variant.cells.byClass.btc
    const btc: string[] = []
    makePrediction(input(pooledOnly, 0, { pairClass: 'btc', models: { hour1: modelsOf(1, 0, FLOOR) }, levels: (horizon, variant, cell) => void btc.push(`${horizon}/${variant}/${cell}`) }))
    expect(btc.sort()).toEqual(['hour1/v1/pooled', 'hour1/v2/pooled'])
  })

  it('widens for a thin book only beyond the spread its closes already carry', () => {
    const plain = makePrediction(input(FLAT, 0))!.horizons.hour1!
    const usual = makePrediction(input(FLAT, 0, { spreadPct: 0.1 }))!.horizons.hour1!
    const thin = makePrediction(input(FLAT, 0, { spreadPct: 1 }))!.horizons.hour1!
    expect(usual.spreadStretch).toBe(1)
    expect(usual.width80Pct).toBeCloseTo(plain.width80Pct, 12)
    expect(thin.spreadStretch).toBeGreaterThan(1)
    expect(thin.width80Pct).toBeGreaterThan(plain.width80Pct)
  })

  // V6.1: Bitcoin's sharp move widens a horizon whose rule the walk forward adopted, and nothing else.
  it("widens for Bitcoin's sharp move where the horizon's rule is in use, past its line, and leaves calm moments alone", () => {
    const rule = { ...noShockRecord(), adopted: true, refusal: null, k80: 1.5, k50: 1.25, moments: 12, rows: 400, before: { in80: 0.6, in50: 0.35, pinball: 0.5 }, after: { in80: 0.79, in50: 0.49, pinball: 0.47 } }
    const withRule: RunCalibration = { ...FLAT, horizons: { ...FLAT.horizons, hour1: { ...FLAT.horizons.hour1!, shock: rule } } }
    const plain = makePrediction(input(withRule, 0, { btc15: 1 }))!.horizons.hour1!
    const shocked = makePrediction(input(withRule, 0, { btc15: -2.8 }))!.horizons.hour1!
    expect(PREDICTION_VERSION).toBe('prediction-v6')
    expect(plain.shock).toBeNull()
    expect(plain.quantilesPct).toEqual(makePrediction(input(FLAT, 0))!.horizons.hour1!.quantilesPct)
    expect(shocked.shock).toEqual({ btc15: -2.8, k80: 1.5, k50: 1.25, held: { before: 0.6, after: 0.79 }, state: null })
    // The levels in usual moves stretched about the median: the outer pair by 1.5, the inner by 1.25.
    const usual = usualMove(0.04, 12)
    const asMoves = (range: ForecastRange): number[] => range.quantilesPct.map((value) => Math.log(1 + value / 100) / usual)
    const expected = stretchShock(asMoves(plain), 1.5, 1.25)
    asMoves(shocked).forEach((value, level) => expect(value).toBeCloseTo(expected[level], 9))
    expect(shocked.width80Pct).toBeGreaterThan(plain.width80Pct)
    // A rule not in use, or none at all, widens nothing whatever Bitcoin did.
    const refused: RunCalibration = { ...FLAT, horizons: { ...FLAT.horizons, hour1: { ...FLAT.horizons.hour1!, shock: { ...rule, adopted: false, refusal: 'pinball' } } } }
    expect(makePrediction(input(refused, 0, { btc15: 4 }))!.horizons.hour1!.shock).toBeNull()
    expect(makePrediction(input(FLAT, 0, { btc15: 4 }))!.horizons.hour1!.quantilesPct).toEqual(plain.quantilesPct)
    expect(makePrediction(input(withRule, 0))!.horizons.hour1!.shock).toBeNull()
    // The line's rule says no state widened it; the market's state goes on the forecast either way.
    expect(shocked.shock!.state).toBeNull()
    expect(makePrediction(input(withRule, 0, { btc15: -2.8, marketState: 'POST_EVENT_SHOCK' }))!.marketState).toBe('POST_EVENT_SHOCK')
    expect(makePrediction(input(withRule, 0))!.marketState).toBeNull()
  })

  // V7.1 Stage 11: a horizon that chose the states' rules widens by the state's own, wherever Bitcoin's
  // fifteen minutes stand; one that chose none widens by nothing, whatever the line's rule says.
  it("widens by the market state's rule where the horizon chose the states', and by nothing where it chose none", () => {
    const line = { ...noShockRecord(), adopted: true, refusal: null, k80: 1.5, k50: 1.25, moments: 12, rows: 400, before: { in80: 0.6, in50: 0.35, pinball: 0.5 }, after: { in80: 0.79, in50: 0.49, pinball: 0.47 } }
    const recovery = { ...line, k80: 1.3, k50: 1.1, before: { in80: 0.7, in50: 0.4, pinball: 0.45 }, after: { in80: 0.81, in50: 0.5, pinball: 0.44 } }
    const refused = { ...line, adopted: false, refusal: 'pinball' as const }
    const rules: MarketShockRules = { version: MARKET_SHOCK_VERSION, byState: { RECOVERY: recovery, POST_EVENT_SHOCK: refused }, compared: { rows: 900, before: { in80: 0.62, in50: 0.36, pinball: 0.49 }, line: { in80: 0.78, in50: 0.48, pinball: 0.47 }, states: { in80: 0.8, in50: 0.5, pinball: 0.46 } }, chosen: 'states' }
    const states: RunCalibration = { ...FLAT, horizons: { ...FLAT.horizons, hour1: { ...FLAT.horizons.hour1!, shock: line, marketShock: rules } } }
    const plain = makePrediction(input(FLAT, 0))!.horizons.hour1!
    // In RECOVERY, Bitcoin calm: the state's factors, and the state named.
    const recovering = makePrediction(input(states, 0, { btc15: 0.3, marketState: 'RECOVERY' }))!.horizons.hour1!
    expect(recovering.shock).toEqual({ btc15: 0.3, k80: 1.3, k50: 1.1, held: { before: 0.7, after: 0.81 }, state: 'RECOVERY' })
    const usual = usualMove(0.04, 12)
    const asMoves = (range: ForecastRange): number[] => range.quantilesPct.map((value) => Math.log(1 + value / 100) / usual)
    stretchShock(asMoves(plain), 1.3, 1.1).forEach((value, level) => expect(asMoves(recovering)[level]).toBeCloseTo(value, 9))
    // Past the line in a state whose rule was refused: nothing, though the line's rule would have widened it.
    expect(makePrediction(input(states, 0, { btc15: -3, marketState: 'POST_EVENT_SHOCK' }))!.horizons.hour1!.shock).toBeNull()
    expect(makePrediction(input(states, 0, { btc15: -3, marketState: 'NORMAL' }))!.horizons.hour1!.shock).toBeNull()
    expect(makePrediction(input(states, 0, { btc15: -3 }))!.horizons.hour1!.shock).toBeNull()
    // The horizon chose none: the models alone, whatever the state and the line.
    const none: RunCalibration = { ...FLAT, horizons: { ...FLAT.horizons, hour1: { ...FLAT.horizons.hour1!, shock: line, marketShock: { ...rules, chosen: 'none' } } } }
    expect(makePrediction(input(none, 0, { btc15: -3, marketState: 'RECOVERY' }))!.horizons.hour1!.shock).toBeNull()
    // The horizon chose the line: V6.1 as before, the state only recorded.
    const chosenLine: RunCalibration = { ...FLAT, horizons: { ...FLAT.horizons, hour1: { ...FLAT.horizons.hour1!, shock: line, marketShock: { ...rules, chosen: 'line' } } } }
    const lined = makePrediction(input(chosenLine, 0, { btc15: -3, marketState: 'RECOVERY' }))!
    expect(lined.horizons.hour1!.shock).toMatchObject({ k80: 1.5, k50: 1.25, state: null })
    expect(lined.marketState).toBe('RECOVERY')
  })

  it('leaves out a horizon with no calibration, and is none without any', () => {
    const only = makePrediction(input(FLAT, 0, { models: { hour1: modelsOf(1, 0, FLOOR), hours24: modelsOf(1, 0, FLOOR) } }))!
    expect(Object.keys(only.horizons)).toEqual(['hour1'])
    expect(makePrediction(input(FLAT, 0, { models: { hours24: modelsOf(1, 0, FLOOR) } as Partial<Record<Horizon, Record<ForecastModelId, number[]>>> }))).toBeNull()
    expect(makePrediction(input(FLAT, 0, { price: 0 }))).toBeNull()
  })
})
