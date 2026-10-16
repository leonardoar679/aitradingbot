import { describe, expect, it } from 'vitest'
import { FORECAST_BAR_SECONDS, coarseBars, type ForecastBar } from '../shared/forecast/bars'
import { FEATURE_NAMES, HORIZON_BARS, PRICE_FEATURES, crossSectionAt, featuresAt, quickAt, type PairQuick, type PairSeries } from '../shared/forecast/features'
import { QUANTILE_LEVELS, quantileOfSorted } from '../shared/forecast/ml/quantile'
import { MODEL_FILE_VERSION, parseFitted, serializeFitted } from '../shared/forecast/modelFile'
import { DIRECTION_MODELS, EXCURSION_LEVELS, FORECAST_MODELS, TECH_FEATURES, fitHorizon, normalizedExcursion, normalizedTarget, predictDirection, predictExcursion, predictHorizon, volatilityInputs, type FittedHorizon } from '../shared/forecast/models'
import { buildPanel, type Panel } from '../shared/forecast/panel'
import { outcomeAt, usualMove } from '../shared/forecast/targets'
import { finalSplit, rowsFor } from '../shared/forecast/walkForward'

// THE ROWS AND THE MODELS (shared/forecast/{panel,models,modelFile}.ts; the V6 document, §13 and §51):
// a made-up market of four pairs over five weeks whose step size wanders, so that how big the next
// move is can be read from how big the last ones were and which way it goes cannot -- as in the real
// one. One horizon is fitted, the hour.

const T0 = Date.parse('2026-08-01T00:00:00Z') / 1000
const DAYS = 34
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']

function walk(seed: number, base: number): ForecastBar[] {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const gauss = (): number => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next())
  const bars: ForecastBar[] = []
  let price = base
  let logSigma = Math.log(0.002)
  for (let index = 0; index < DAYS * 288; index++) {
    // The step size wanders slowly back to its mean: volatility clusters.
    logSigma += 0.02 * (Math.log(0.002) - logSigma) + 0.08 * gauss()
    const sigma = Math.exp(logSigma)
    const open = price
    price = price * Math.exp(sigma * gauss())
    const volume = 100 * (1 + 50 * sigma) * (0.5 + next())
    bars.push({ time: T0 + index * FORECAST_BAR_SECONDS, open, high: Math.max(open, price) * (1 + sigma * next()), low: Math.min(open, price) * (1 - sigma * next()), close: price, volume, quoteVolume: volume * price, takerBuyVolume: volume * next(), trades: 10 + Math.floor(100 * next()) })
  }
  return bars
}

const MARKET = new Map<string, PairSeries>(
  SYMBOLS.map((symbol, index) => {
    const m5 = walk(7 + index * 31, [60_000, 2_500, 150, 0.6][index])
    return [symbol, { m5, h1: coarseBars(m5, '1h', Number.POSITIVE_INFINITY) }]
  })
)
const PANEL: Panel = buildPanel(MARKET, { stepSec: 900, fromSec: T0 + 26 * 86_400, toSec: T0 + DAYS * 86_400 })
const ROWS = rowsFor(PANEL, 'hour1')
const SPLIT = finalSplit(PANEL, ROWS, 'hour1')
const FITTED: FittedHorizon = fitHorizon(PANEL, SPLIT.train, SPLIT.valid, 'hour1', 5)
const rowOf = (row: number): Float64Array => Float64Array.from(PANEL.x.subarray(row * PANEL.cols, (row + 1) * PANEL.cols))

describe('the panel', () => {
  it('is every pair at every quarter-hour it can be read, read as the live forecast reads it', () => {
    expect(PANEL.rows).toBeGreaterThan(2500)
    expect([...PANEL.time].every((t) => t % 900 === 0)).toBe(true)
    // A row is the row featuresAt reads at its moment (to single precision), and its outcome the path's.
    for (const row of [0, 777, PANEL.rows - 50]) {
      const t = PANEL.time[row]
      const symbol = PANEL.symbols[PANEL.pair[row]]
      const quick = new Map<string, PairQuick>()
      for (const [pair, series] of MARKET) {
        const read = quickAt(series, t)
        if (read !== null) quick.set(pair, read)
      }
      const direct = featuresAt({ symbol, series: MARKET.get(symbol)!, btcH1: MARKET.get('BTCUSDT')!.h1, cross: crossSectionAt(quick)!, tSec: t })!
      expect([...rowOf(row)]).toEqual([...Float32Array.from(direct)])
      const m5 = MARKET.get(symbol)!.m5
      const at = m5.findIndex((bar) => bar.time === t - FORECAST_BAR_SECONDS)
      const outcome = outcomeAt(m5, at, HORIZON_BARS.hour1)
      if (outcome === null) expect(PANEL.y.hour1[row]).toBeNaN()
      else expect(PANEL.y.hour1[row]).toBeCloseTo(outcome.r, 6)
    }
    // The last rows have no day's outcome yet.
    expect(PANEL.y.hours24[PANEL.rows - 1]).toBeNaN()
  })

  it('measures a move against its usual size', () => {
    const row = ROWS[100]
    expect(normalizedTarget(PANEL, row, 'hour1')).toBeCloseTo(PANEL.y.hour1[row] / usualMove(PANEL.rv24h[row], 12), 6)
  })
})

describe('the models', () => {
  it('give every model five quantiles, in order, for any row', () => {
    for (const row of [ROWS[0], ROWS[500], ROWS[ROWS.length - 1]]) {
      const out = predictHorizon(FITTED, rowOf(row))
      expect(Object.keys(out).sort()).toEqual([...FORECAST_MODELS].sort())
      for (const model of FORECAST_MODELS) {
        expect(out[model], model).toHaveLength(QUANTILE_LEVELS.length)
        expect(out[model].every((value, index) => Number.isFinite(value) && (index === 0 || value >= out[model][index - 1])), model).toBe(true)
      }
    }
  })

  it('make persistence the quantiles of the training moves, whatever the row', () => {
    const z = Float64Array.from(SPLIT.train, (row) => normalizedTarget(PANEL, row, 'hour1')).sort()
    const expected = QUANTILE_LEVELS.map((tau) => quantileOfSorted(z, tau))
    expect(predictHorizon(FITTED, rowOf(ROWS[3])).persistence).toEqual(expected)
    expect(predictHorizon(FITTED, rowOf(ROWS[900])).persistence).toEqual(expected)
  })

  it('widen the volatility model where the last hour moved more than the day', () => {
    const ratio = FEATURE_NAMES.indexOf('rv_ratio')
    const rows = [...ROWS].sort((a, b) => PANEL.x[a * PANEL.cols + ratio] - PANEL.x[b * PANEL.cols + ratio])
    const width = (row: number): number => {
      const q = predictHorizon(FITTED, rowOf(row)).volatility
      return q[4] - q[0]
    }
    const tenth = Math.floor(rows.length / 10)
    const calm = rows.slice(0, tenth).reduce((sum, row) => sum + width(row), 0) / tenth
    const wild = rows.slice(-tenth).reduce((sum, row) => sum + width(row), 0) / tenth
    expect(wild).toBeGreaterThan(calm * 1.2)
    expect(volatilityInputs(rowOf(ROWS[0]))).toHaveLength(8 + 14)
  })

  it("put a model's crossed quantiles back in order", () => {
    const crossed: FittedHorizon = { ...FITTED, quantileGbt: { levels: FITTED.quantileGbt.levels.map((model, index) => ({ ...model, base: [1, 0.5, 0, -0.5, -1][index], trees: [] })) } }
    expect(predictHorizon(crossed, rowOf(ROWS[0]))['quantile-gbt']).toEqual([-1, -0.5, 0, 0.5, 1])
  })

  it('hold a size within its ceiling however wild the row', () => {
    const wild = rowOf(ROWS[0])
    wild[FEATURE_NAMES.indexOf('rv_ratio')] = 1e30
    wild[FEATURE_NAMES.indexOf('range_exp')] = 1e30
    const q = predictHorizon(FITTED, wild).volatility
    const widest = Math.max(...FITTED.volatility.residual.map(Math.abs))
    expect(q.every((value) => Number.isFinite(value) && Math.abs(value) <= 20 * widest + 1e-9)).toBe(true)
  })

  it('are no better than persistence at which way the move goes, where nothing says it', () => {
    // A random walk has no direction to learn: the boosted centre stops at a tree or a few.
    expect(FITTED.gbt.center.trees.length).toBeLessThan(40)
    expect(FITTED.gbt.center.grown).toBeLessThan(200)
  })
})

describe('a model file', () => {
  it('is the same bytes each time, and reads back to the same forecasts to seven digits', () => {
    const text = serializeFitted(FITTED)
    expect(serializeFitted(FITTED)).toBe(text)
    const back = parseFitted(text)
    expect(back).not.toBeNull()
    expect(back!.horizon).toBe('hour1')
    for (const row of [ROWS[10], ROWS[1000]]) {
      const before = predictHorizon(FITTED, rowOf(row))
      const after = predictHorizon(back!, rowOf(row))
      for (const model of FORECAST_MODELS) after[model].forEach((value, index) => expect(Math.abs(value - before[model][index]), model).toBeLessThan(1e-4 * (1 + Math.abs(before[model][index]))))
    }
    // Read back, it writes the same bytes: what runs is what is on file.
    expect(serializeFitted(back!)).toBe(text)
    expect(text.length).toBeLessThan(2_000_000)
  })

  it('is refused from another version, or with a tree that could loop or read a figure there is not', () => {
    const text = serializeFitted(FITTED)
    expect(parseFitted(text.replace(MODEL_FILE_VERSION, 'forecast-models-file-v0'))).toBeNull()
    expect(parseFitted('{}')).toBeNull()
    expect(parseFitted('not json')).toBeNull()
    const raw = JSON.parse(text)
    const loop = structuredClone(raw)
    const tree = loop.gbt.size.trees.find((entry: { f: number[] }) => entry.f[0] >= 0)
    tree.l[0] = 0
    expect(parseFitted(JSON.stringify(loop))).toBeNull()
    const far = structuredClone(raw)
    const other = far.gbt.size.trees.find((entry: { f: number[] }) => entry.f[0] >= 0)
    other.f[0] = 999
    expect(parseFitted(JSON.stringify(far))).toBeNull()
    const short = structuredClone(raw)
    short.persistence.residual = [0, 1]
    expect(parseFitted(JSON.stringify(short))).toBeNull()
    const fewer = structuredClone(raw)
    fewer.quantileGbt.levels.pop()
    expect(parseFitted(JSON.stringify(fewer))).toBeNull()
  })
})

// THE DIRECTION MODELS (V7.1 Stage 2; shared/forecast/models.ts): which way, by classifiers of their own,
// on a market that says nothing about it and on one that does.
describe('the direction models', () => {
  it('give each a chance of up inside (0, 1) for any row, kept on file and read back, each on its own figures', () => {
    for (const row of [ROWS[0], ROWS[500], ROWS[ROWS.length - 1]]) {
      const out = predictDirection(FITTED, rowOf(row))
      expect(Object.keys(out).sort()).toEqual([...DIRECTION_MODELS].sort())
      for (const model of DIRECTION_MODELS) expect(out[model] > 0 && out[model] < 1, model).toBe(true)
    }
    expect(FITTED.direction.gbt.loss.kind).toBe('logloss')
    expect(FITTED.direction.gbt.features).toBe(PANEL.cols)
    expect(FITTED.direction.gbtTech.features).toBe(TECH_FEATURES)
    expect(FITTED.direction.gbtPrice.features).toBe(PRICE_FEATURES)
    expect(FITTED.direction.logistic.columns).toHaveLength(PANEL.cols)
    const text = serializeFitted(FITTED)
    const back = parseFitted(text)!
    const before = predictDirection(FITTED, rowOf(ROWS[7]))
    const after = predictDirection(back, rowOf(ROWS[7]))
    for (const model of DIRECTION_MODELS) expect(Math.abs(after[model] - before[model]), model).toBeLessThan(1e-4)
    // A file without them -- a v1 file -- is refused, and the run fitted again.
    const raw = JSON.parse(text)
    delete raw.direction
    expect(parseFitted(JSON.stringify(raw))).toBeNull()
    const wrongLoss = JSON.parse(text)
    wrongLoss.direction.gbt.loss = { kind: 'l2' }
    expect(parseFitted(JSON.stringify(wrongLoss))).toBeNull()
  })

  it('read how far the path goes each way at each level, the highs rising and the lows falling, kept on file (V7.1 Stage 3)', () => {
    for (const row of [ROWS[0], ROWS[500], ROWS[ROWS.length - 1]]) {
      const out = predictExcursion(FITTED, rowOf(row))
      expect(out.high).toHaveLength(EXCURSION_LEVELS.length)
      expect(out.low).toHaveLength(EXCURSION_LEVELS.length)
      expect(out.high.every((value, index) => value >= 0 && (index === 0 || value >= out.high[index - 1]))).toBe(true)
      expect(out.low.every((value, index) => value <= 0 && (index === 0 || value <= out.low[index - 1]))).toBe(true)
    }
    // Over the training rows, each level holds about its share of the paths: the median high under half.
    const share = (pick: (row: number) => boolean): number => [...SPLIT.train].filter(pick).length / SPLIT.train.length
    const highHeld = share((row) => normalizedExcursion(PANEL, row, 'hour1').best <= predictExcursion(FITTED, rowOf(row)).high[1])
    const lowHeld = share((row) => normalizedExcursion(PANEL, row, 'hour1').worst >= predictExcursion(FITTED, rowOf(row)).low[1])
    expect(highHeld).toBeGreaterThan(0.7)
    expect(highHeld).toBeLessThan(0.9)
    expect(lowHeld).toBeGreaterThan(0.7)
    expect(lowHeld).toBeLessThan(0.9)
    expect(FITTED.excursion.high.map((model) => model.loss)).toEqual(EXCURSION_LEVELS.map((tau) => ({ kind: 'pinball', tau })))
    expect(FITTED.excursion.low.map((model) => model.loss)).toEqual(EXCURSION_LEVELS.map((tau) => ({ kind: 'pinball', tau: 1 - tau })))
    const back = parseFitted(serializeFitted(FITTED))!
    const before = predictExcursion(FITTED, rowOf(ROWS[7]))
    const after = predictExcursion(back, rowOf(ROWS[7]))
    before.high.forEach((value, index) => expect(Math.abs(after.high[index] - value)).toBeLessThan(1e-4 * (1 + Math.abs(value))))
    const raw = JSON.parse(serializeFitted(FITTED))
    delete raw.excursion
    expect(parseFitted(JSON.stringify(raw))).toBeNull()
    const mirrored = JSON.parse(serializeFitted(FITTED))
    mirrored.excursion.low[0].loss = { kind: 'pinball', tau: 0.5 }
    mirrored.excursion.low[1].loss = { kind: 'pinball', tau: 0.8 }
    expect(parseFitted(JSON.stringify(mirrored))).toBeNull()
  })

  it('learn which way where the row says it -- a drift by the hour of the day -- and know nothing where nothing does', () => {
    // A market like MARKET's, with a drift that is up in the first half of the UTC day and down in the second.
    const drifting = (seed: number, base: number): ForecastBar[] => {
      let state = seed >>> 0
      const next = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 2 ** 32
      }
      const gauss = (): number => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next())
      const bars: ForecastBar[] = []
      let price = base
      let logSigma = Math.log(0.002)
      for (let index = 0; index < DAYS * 288; index++) {
        logSigma += 0.02 * (Math.log(0.002) - logSigma) + 0.08 * gauss()
        const sigma = Math.exp(logSigma)
        const time = T0 + index * FORECAST_BAR_SECONDS
        const drift = (time % 86_400 < 43_200 ? 0.2 : -0.2) * sigma
        const open = price
        price = price * Math.exp(drift + sigma * gauss())
        const volume = 100 * (1 + 50 * sigma) * (0.5 + next())
        bars.push({ time, open, high: Math.max(open, price) * (1 + sigma * next()), low: Math.min(open, price) * (1 - sigma * next()), close: price, volume, quoteVolume: volume * price, takerBuyVolume: volume * next(), trades: 10 + Math.floor(100 * next()) })
      }
      return bars
    }
    const market = new Map<string, PairSeries>(
      SYMBOLS.map((symbol, index) => {
        const m5 = drifting(101 + index * 17, [60_000, 2_500, 150, 0.6][index])
        return [symbol, { m5, h1: coarseBars(m5, '1h', Number.POSITIVE_INFINITY) }]
      })
    )
    const panel = buildPanel(market, { stepSec: 900, fromSec: T0 + 26 * 86_400, toSec: T0 + DAYS * 86_400 })
    const rows = rowsFor(panel, 'hour1')
    const cut = T0 + 31 * 86_400
    const split = finalSplit(panel, rows.filter((row) => panel.time[row] < cut - 3600), 'hour1')
    const fitted = fitHorizon(panel, split.train, split.valid, 'hour1', 9)
    const held = rows.filter((row) => panel.time[row] >= cut)
    expect(held.length).toBeGreaterThan(800)
    const judge = (model: FittedHorizon, test: Uint32Array, source: Panel): Record<(typeof DIRECTION_MODELS)[number], { calls: number; precision: number; logLoss: number; entropy: number }> => {
      const out = {} as Record<(typeof DIRECTION_MODELS)[number], { calls: number; precision: number; logLoss: number; entropy: number }>
      const ups = Array.from(test, (row) => (normalizedTarget(source, row, 'hour1') > 0 ? 1 : 0))
      const share = ups.reduce((sum, value) => sum + value, 0) / ups.length
      const entropy = -(share * Math.log(share) + (1 - share) * Math.log(1 - share))
      for (const name of DIRECTION_MODELS) {
        let calls = 0
        let right = 0
        let logLoss = 0
        test.forEach((row, at) => {
          const p = predictDirection(model, Float64Array.from(source.x.subarray(row * source.cols, (row + 1) * source.cols)))[name]
          logLoss -= ups[at] * Math.log(p) + (1 - ups[at]) * Math.log(1 - p)
          if (p >= 0.58 || p <= 0.42) {
            calls++
            if (p >= 0.58 === (ups[at] === 1)) right++
          }
        })
        out[name] = { calls, precision: calls === 0 ? Number.NaN : right / calls, logLoss: logLoss / test.length, entropy }
      }
      return out
    }
    const drifted = judge(fitted, held, panel)
    for (const name of DIRECTION_MODELS) {
      expect(drifted[name].calls, name).toBeGreaterThan(100)
      expect(drifted[name].precision, name).toBeGreaterThan(0.6)
      // The trees on every figure read the clock, and their raw chances beat the share on rows they never
      // saw. The others read the way right from the moves alone, but on two thousand rows their raw
      // chances are overconfident: what a raw reading means is the walk forward's map to settle
      // (shared/forecast/runCalibration.ts), never the raw reading itself.
      if (name === 'dir-gbt') expect(drifted[name].logLoss, name).toBeLessThan(drifted[name].entropy - 0.03)
    }
    // On the market that says nothing, nothing is known: fitted on the days before the cut alone, no model
    // beats the share on the days after it by more than the noise of a thousand overlapping rows allows.
    const flatSplit = finalSplit(PANEL, ROWS.filter((row) => PANEL.time[row] < cut - 3600), 'hour1')
    const flatFitted = fitHorizon(PANEL, flatSplit.train, flatSplit.valid, 'hour1', 9)
    const flat = judge(flatFitted, ROWS.filter((row) => PANEL.time[row] >= cut), PANEL)
    for (const name of DIRECTION_MODELS) expect(flat[name].logLoss, name).toBeGreaterThan(flat[name].entropy - 0.025)
  })
})
