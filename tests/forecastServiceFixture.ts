import { FORECAST_BAR_SECONDS, type ForecastBar } from '../shared/forecast/bars'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import type { GbtModel } from '../shared/forecast/ml/gbt'
import { QUANTILE_LEVELS } from '../shared/forecast/ml/quantile'
import type { FlatTree } from '../shared/forecast/ml/tree'
import { MODELS_VERSION, type FittedHorizon } from '../shared/forecast/models'
import { buildRunCalibration, type RunCalibration } from '../shared/forecast/runCalibration'
import { promoted, recordOf } from './forecastRecords'

// THE FORECAST SERVICE'S FIXTURES (tests/forecastService.test.ts; since V7.2 Stage 5 also the replay fidelity
// test): four pairs of random-walk bars from a seeded generator, models whose every leaf is a constant, and a
// calibration built from seeded out-of-sample records. Deterministic: the same figures on every run, which is
// what lets a record made by the service be replayed by the pure pass and compared to four decimals.

export const T0 = Date.parse('2026-08-01T00:00:00Z') / 1000
export const DAYS = 34
export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']

export function walk(seed: number, base: number): ForecastBar[] {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const gauss = (): number => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next())
  const bars: ForecastBar[] = []
  let price = base
  for (let index = 0; index < DAYS * 288; index++) {
    const open = price
    price = price * Math.exp(0.002 * gauss())
    const volume = 100 * (0.5 + next())
    bars.push({ time: T0 + index * FORECAST_BAR_SECONDS, open, high: Math.max(open, price) * 1.0005, low: Math.min(open, price) * 0.9995, close: price, volume, quoteVolume: volume * price, takerBuyVolume: volume * next(), trades: 50 })
  }
  return bars
}

const leaf = (value: number): FlatTree => ({ feature: [-1], threshold: [0], bin: [0], left: [-1], right: [-1], value: [value], cover: [0], gain: [0] })
export const constantGbt = (base: number, loss: GbtModel['loss'] = { kind: 'l2' }): GbtModel => ({ kind: 'gbt', loss, base, features: 63, grown: 1, trees: [leaf(0)] })
const ridge = { kind: 'ridge' as const, mean: [0], scale: [1], coef: [0], intercept: 0, columns: [0] }
export const RESIDUAL = [-1.28, -0.67, 0, 0.67, 1.28]
export function tinyFitted(horizon: Horizon): FittedHorizon {
  return {
    version: MODELS_VERSION,
    horizon,
    persistence: { residual: RESIDUAL },
    volatility: { size: ridge, residual: RESIDUAL },
    technical: { center: ridge, residual: RESIDUAL },
    forest: { center: { kind: 'forest', features: 63, trees: [leaf(0)] }, residual: RESIDUAL },
    gbt: { center: constantGbt(0), size: constantGbt(0), residual: RESIDUAL },
    quantileGbt: { levels: QUANTILE_LEVELS.map((tau, index) => constantGbt(RESIDUAL[index], { kind: 'pinball', tau })) },
    gbtPrice: { center: constantGbt(0), size: constantGbt(0), residual: RESIDUAL },
    // The direction models (V7.1 Stage 2), each an even chance here.
    direction: { logistic: { ...ridge, kind: 'logistic', iterations: 1 }, gbt: constantGbt(0, { kind: 'logloss' }), gbtTech: constantGbt(0, { kind: 'logloss' }), gbtPrice: constantGbt(0, { kind: 'logloss' }) },
    // The excursion models (V7.1 Stage 3): the highs one usual move up at every level, the lows one down.
    excursion: { high: [0.5, 0.8, 0.9].map((tau) => constantGbt(1, { kind: 'pinball', tau })), low: [0.5, 0.8, 0.9].map((tau) => constantGbt(-1, { kind: 'pinball', tau: 1 - tau })) }
  }
}

export const CALIBRATION: RunCalibration = buildRunCalibration(
  new Map(HORIZONS.map((horizon, index) => [horizon, recordOf({ rows: 6000, seed: 50 + index, horizon })])),
  HORIZONS.flatMap((horizon) => promoted(horizon, ['persistence', 'gbt'])),
  'run-folds'
)
export const MARKET = new Map(SYMBOLS.map((symbol, index) => [symbol, walk(11 + index * 17, [60_000, 2_500, 150, 0.6][index])]))
/** A close on the hour, thirty days in. */
export const HOUR = T0 + 30 * 86_400
