import { PAIR_CLASSES, type Horizon } from '../shared/forecast/features'
import { QUANTILE_LEVELS } from '../shared/forecast/ml/quantile'
import { FORECAST_MODELS, type DirectionModelId, type ForecastModelId } from '../shared/forecast/models'
import { OOS_VERSION, type OosRecord } from '../shared/forecast/oosRecord'
import type { Promotion } from '../shared/forecast/training'

// Synthetic walk-forward records for the tests of the forecast's calibration and prediction: four
// weeks of hourly rows whose right answers are known. Deterministic: the same arguments always give
// the same record.

/** The standard normal's quantiles at the five levels. */
export const N = [-1.2815515655446004, -0.6744897501960817, 0, 0.6744897501960817, 1.2815515655446004]
export const scaled = (sigma: number, mu = 0): number[] => N.map((q) => mu + sigma * q)

export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
export function gaussOf(random: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random())
}

/** A walk forward's record of four weeks: each row's move is sigma x a normal draw (plus a drift the
 * row knows, with `drift`); persistence knows neither, gbt knows the scale (and the drift), the rest
 * are persistence again. With `direction`, the record holds each direction model's raw chance of up
 * (V7.1 Stage 2): a model given a `knows` share reads the move's way right that often and is noise
 * the rest of the time; one given 0 is noise throughout. */
export function recordOf(options: { rows: number; seed: number; drift?: number; horizon?: Horizon; tooNarrow?: number; direction?: Partial<Record<DirectionModelId, number>>; symbols?: string[] }): OosRecord {
  const random = rng(options.seed)
  const gauss = gaussOf(random)
  const rows = options.rows
  // The pairs, round robin over the rows: one by default, several where a test splits them in halves.
  const symbols = options.symbols ?? ['BTCUSDT']
  const sigmas = Float64Array.from({ length: rows }, () => 0.5 + 1.5 * random())
  const mus = Float64Array.from({ length: rows }, () => (options.drift ?? 0) * (random() < 0.5 ? -1 : 1))
  const z = Float32Array.from({ length: rows }, (_, row) => mus[row] + sigmas[row] * gauss())
  const directionModels = options.direction === undefined ? undefined : (Object.keys(options.direction) as DirectionModelId[])
  const direction =
    directionModels === undefined
      ? undefined
      : Float32Array.from({ length: rows * directionModels.length }, (_, at) => {
          const knows = options.direction![directionModels[at % directionModels.length]] ?? 0
          const row = Math.floor(at / directionModels.length)
          // A reading that leans the move's way, by a margin that knows draws; a coin's otherwise.
          const lean = random() < knows ? (z[row] > 0 ? 1 : -1) : random() < 0.5 ? 1 : -1
          return 0.5 + lean * (0.05 + 0.3 * random())
        })
  // Persistence: the quantiles of every move together, which are about those of 1.2 x a normal.
  const sorted = Float64Array.from(z).sort()
  const floor = QUANTILE_LEVELS.map((tau) => sorted[Math.floor(tau * (rows - 1))])
  const quantiles = new Float32Array(rows * FORECAST_MODELS.length * 5)
  for (let row = 0; row < rows; row++) {
    for (const [index, model] of FORECAST_MODELS.entries()) {
      const q = model === 'gbt' ? scaled(sigmas[row] * (options.tooNarrow ?? 1), mus[row]) : floor
      quantiles.set(q, (row * FORECAST_MODELS.length + index) * 5)
    }
  }
  return {
    version: OOS_VERSION,
    horizon: options.horizon ?? 'hour1',
    symbols,
    models: FORECAST_MODELS,
    rows,
    time: Uint32Array.from({ length: rows }, (_, row) => row * 3600),
    pair: Uint16Array.from({ length: rows }, (_, row) => row % symbols.length),
    cls: Uint8Array.from({ length: rows }, (_, row) => row % PAIR_CLASSES.length),
    regime: new Uint8Array(rows).fill(5),
    fold: Uint8Array.from({ length: rows }, (_, row) => Math.floor((row * 4) / rows)),
    z,
    rv24h: new Float32Array(rows).fill(0.03),
    y: Float32Array.from(z, (value) => value * 0.03 * Math.sqrt(12 / 288)),
    best: new Float32Array(rows),
    worst: new Float32Array(rows),
    quantiles,
    ...(directionModels === undefined || direction === undefined ? {} : { directionModels, direction })
  }
}

export const promoted = (horizon: Horizon, models: ForecastModelId[]): Promotion[] => models.map((model) => ({ horizon, model, promoted: true, lines: [] }))
