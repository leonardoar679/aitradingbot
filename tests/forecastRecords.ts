import { PAIR_CLASSES, type Horizon } from '../shared/forecast/features'
import { QUANTILE_LEVELS } from '../shared/forecast/ml/quantile'
import { FORECAST_MODELS, type ForecastModelId } from '../shared/forecast/models'
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
 * are persistence again. */
export function recordOf(options: { rows: number; seed: number; drift?: number; horizon?: Horizon; tooNarrow?: number }): OosRecord {
  const random = rng(options.seed)
  const gauss = gaussOf(random)
  const rows = options.rows
  const sigmas = Float64Array.from({ length: rows }, () => 0.5 + 1.5 * random())
  const mus = Float64Array.from({ length: rows }, () => (options.drift ?? 0) * (random() < 0.5 ? -1 : 1))
  const z = Float32Array.from({ length: rows }, (_, row) => mus[row] + sigmas[row] * gauss())
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
    symbols: ['BTCUSDT'],
    models: FORECAST_MODELS,
    rows,
    time: Uint32Array.from({ length: rows }, (_, row) => row * 3600),
    pair: new Uint16Array(rows),
    cls: Uint8Array.from({ length: rows }, (_, row) => row % PAIR_CLASSES.length),
    regime: new Uint8Array(rows).fill(5),
    fold: Uint8Array.from({ length: rows }, (_, row) => Math.floor((row * 4) / rows)),
    z,
    rv24h: new Float32Array(rows).fill(0.03),
    y: Float32Array.from(z, (value) => value * 0.03 * Math.sqrt(12 / 288)),
    best: new Float32Array(rows),
    worst: new Float32Array(rows),
    quantiles
  }
}

export const promoted = (horizon: Horizon, models: ForecastModelId[]): Promotion[] => models.map((model) => ({ horizon, model, promoted: true, lines: [] }))
