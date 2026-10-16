import { FEATURE_NAMES, HORIZON_BARS, PRICE_FEATURES, type Horizon } from './features'
import { binMatrix, fitCuts, type Binned, type Matrix } from './ml/bins'
import { fitForest, predictForest, type ForestModel } from './ml/forest'
import { fitGbt, predictGbt, sigmoid, type GbtModel, type GbtParams } from './ml/gbt'
import { fitLogistic, predictLogistic, type LogisticModel } from './ml/logistic'
import { QUANTILE_LEVELS, quantileOfSorted, rearrange } from './ml/quantile'
import { fitRidge, predictRidge, type RidgeModel } from './ml/ridge'
import type { Panel } from './panel'
import { usualMove } from './targets'

// THE SIX MODELS (the V6 document, §13; V6 Stage 5, 13 October 2026), and the price-only one the
// document's §49 sets against them.
//
// Every model forecasts a move in units of the pair's usual move for its horizon -- z = r / usual,
// the day's realized volatility scaled by the square root of time -- so that a quiet large coin and a
// wild small one are learned together, and gives five quantiles of it (P10 to P90). Times the usual
// move, they are the forecast in log return.
//
// - persistence: no forecast of the move at all: the quantiles of z over the training rows. A random
//   walk with fat tails; the line every other model has to beat.
// - volatility: how big the move will be, not which way -- a ridge regression of log |z| on the
//   volatility's own readings (the hour against the day, the range, the volume, the regime, the hour
//   of the day), HAR-style; the quantiles of z over its predicted size.
// - technical: a ridge regression of z on every figure, for the centre, with the volatility's size.
// - random-forest: a random forest of z, for the centre, with the volatility's size.
// - gbt: gradient-boosted trees for the centre and, on log |residual|, for the size.
// - quantile-gbt: boosted trees at each quantile's own pinball loss.
// - gbt-price: gbt on the PRICE figures alone (§49's "price only").
// For the four with a centre and a size, the quantiles are centre + size x the quantiles of the
// standardized residuals over the training rows, so a fat tail the training saw is kept.
//
// THE DIRECTION MODELS (V7.1 Stage 2, 16 October 2026) forecast WHICH WAY, not how far: the chance that
// the move is up, from the same row, by classifiers of their own rather than from the sign of a range's
// median (which on V6's walk forward was a coin toss, so the forecast never called a way):
// - dir-logistic: a logistic regression on every figure -- the plain baseline the trees must beat;
// - dir-gbt: boosted trees on the log loss, on every figure;
// - dir-gbt-tech: the same on the PRICE and TECH figures, before the market's (§49's experiments);
// - dir-gbt-price: the same on the PRICE figures alone.
// Each learns from the rows whose move cleared a materiality floor either way; what each reading means
// is settled on the walk forward (shared/forecast/runCalibration.ts), never here.

// THE EXCURSION MODELS (V7.1 Stage 3, 16 October 2026) forecast how far the path goes on the way, not where
// it ends: boosted trees at each level's own pinball loss on the path's highest high and lowest low over
// the horizon, in usual moves (shared/forecast/targets.ts) -- the levels the high stays under and the low
// stays above half the time, eight times in ten and nine. What each level means out of sample is settled
// on the walk forward (shared/forecast/firstTouch.ts, excursionCalibrationOf), never here.

/** models-v4 (V7.1 Stage 11): every model fitted on the features-v2 rows, which carry the market's last
 * fifteen minutes (shared/forecast/features.ts); a file from before is refused and the run fitted again.
 * models-v3 (V7.1 Stage 3) brought the direction and excursion models. */
export const MODELS_VERSION = 'models-v4'

/** The shares of outcomes the excursion levels are meant to hold: the high stays under the level, the low
 * above it, this often. */
export const EXCURSION_LEVELS = [0.5, 0.8, 0.9] as const

export const FORECAST_MODELS = ['persistence', 'volatility', 'technical', 'random-forest', 'gbt', 'quantile-gbt', 'gbt-price'] as const
export type ForecastModelId = (typeof FORECAST_MODELS)[number]

export const DIRECTION_MODELS = ['dir-logistic', 'dir-gbt', 'dir-gbt-tech', 'dir-gbt-price'] as const
export type DirectionModelId = (typeof DIRECTION_MODELS)[number]

/** The PRICE and TECH figures: the first this many, before Bitcoin's, ether's and the market's. */
export const TECH_FEATURES = FEATURE_NAMES.indexOf('btc_r_1h')

/** The figures each direction model reads: the first this many of the row. */
export const DIRECTION_FEATURES: Record<DirectionModelId, number> = {
  'dir-logistic': FEATURE_NAMES.length,
  'dir-gbt': FEATURE_NAMES.length,
  'dir-gbt-tech': TECH_FEATURES,
  'dir-gbt-price': PRICE_FEATURES
}

const GBT_BASE: Omit<GbtParams, 'trees' | 'learningRate' | 'seed'> = {
  maxDepth: 4,
  minLeafRows: 100,
  minLeafHessian: 1,
  lambda: 1,
  minGain: 0,
  featureFraction: 0.8,
  featureSampling: 'tree',
  subsample: 0.5,
  patience: 20
}

/** The budgets every fit is made at: pinned, on the effective configuration as engine constants. */
export const TRAINING = {
  center: { trees: 200, learningRate: 0.05 },
  scale: { trees: 150, learningRate: 0.05 },
  quantile: { trees: 150, learningRate: 0.1 },
  forest: { trees: 40, maxDepth: 8, minLeafRows: 50, minLeafHessian: 0, minGain: 0, featureFraction: 0.33, sampleFraction: 0.25 },
  ridgeLambda: 10,
  /** The direction models (V7.1 Stage 2): the boosting's budget on the log loss, the logistic
   * regression's penalty, and the floor a move must clear, in usual moves, to teach a way. */
  direction: { trees: 150, learningRate: 0.05, logisticLambda: 10, floor: 0.1 },
  /** The excursion models (V7.1 Stage 3): the boosting's budget at each level's pinball loss. */
  excursion: { trees: 150, learningRate: 0.1 },
  /** A size is held within these multiples of the usual move. */
  scaleFloor: 0.05,
  scaleCeiling: 20,
  /** Added under a log of a size, so a move of zero does not read as minus infinity. */
  logFloor: 1e-3
} as const

const FEATURE = (name: (typeof FEATURE_NAMES)[number]): number => FEATURE_NAMES.indexOf(name)
const RV_RATIO = FEATURE('rv_ratio')
const RV_4H = FEATURE('rv_4h')
const RV_24H = FEATURE('rv_24h')
const RANGE_EXP = FEATURE('range_exp')
const VOL_RATIO = FEATURE('vol_ratio_1h')
const ATR_15M = FEATURE('atr_15m')
const ATR_1H = FEATURE('atr_1h')
const BB_WIDTH = FEATURE('bb_width_1h')
const Z_15M = FEATURE('z_15m')
const Z_1H = FEATURE('z_1h')
const ONE_HOTS = FEATURE_NAMES.map((name, index) => (name.startsWith('regime_') || name.startsWith('class_') || name === 'hour_sin' || name === 'hour_cos' ? index : -1)).filter((index) => index >= 0)

/** What the volatility model reads of a row: logs of the volatility's own readings, the recent move's
 * size, and the regime, the class and the hour as they are. */
export function volatilityInputs(x: ArrayLike<number>, offset = 0): number[] {
  const at = (index: number): number => x[offset + index]
  const usual4h = usualMove(at(RV_24H), 48)
  return [
    Math.log(Math.max(at(RV_RATIO), TRAINING.logFloor)),
    Math.log(Math.max(at(RV_4H) / Math.max(usual4h, 1e-12), TRAINING.logFloor)),
    Math.log(at(RANGE_EXP) + 0.01),
    Math.log(at(VOL_RATIO) + 0.01),
    at(ATR_15M) / Math.max(at(ATR_1H), 1e-6),
    at(BB_WIDTH),
    Math.abs(at(Z_15M)),
    Math.abs(at(Z_1H)),
    ...ONE_HOTS.map((index) => at(index))
  ]
}

/** The direction models of a horizon (V7.1 Stage 2), each a chance of up from the row. */
export interface DirectionFits {
  logistic: LogisticModel
  gbt: GbtModel
  gbtTech: GbtModel
  gbtPrice: GbtModel
}

/** The excursion models of a horizon (V7.1 Stage 3): boosted trees at each of EXCURSION_LEVELS, on the
 * path's highest high and on its lowest low, in usual moves. */
export interface ExcursionFits {
  high: GbtModel[]
  low: GbtModel[]
}

export interface FittedHorizon {
  version: string
  horizon: Horizon
  persistence: { residual: number[] }
  volatility: { size: RidgeModel; residual: number[] }
  technical: { center: RidgeModel; residual: number[] }
  forest: { center: ForestModel; residual: number[] }
  gbt: { center: GbtModel; size: GbtModel; residual: number[] }
  quantileGbt: { levels: GbtModel[] }
  gbtPrice: { center: GbtModel; size: GbtModel; residual: number[] }
  direction: DirectionFits
  excursion: ExcursionFits
}

/** A row's move at a horizon in units of its usual move; NaN where it has no outcome. */
export function normalizedTarget(panel: Panel, row: number, horizon: Horizon): number {
  const usual = usualMove(panel.rv24h[row], HORIZON_BARS[horizon])
  return usual > 0 ? panel.y[horizon][row] / usual : Number.NaN
}

/** A row's path at a horizon in units of its usual move: its highest high (zero or more) and its lowest
 * low (zero or less); NaN where it has no outcome. */
export function normalizedExcursion(panel: Panel, row: number, horizon: Horizon): { best: number; worst: number } {
  const usual = usualMove(panel.rv24h[row], HORIZON_BARS[horizon])
  if (!(usual > 0)) return { best: Number.NaN, worst: Number.NaN }
  return { best: panel.best[horizon][row] / usual, worst: panel.worst[horizon][row] / usual }
}

const sizeOf = (logSize: number): number => Math.min(TRAINING.scaleCeiling, Math.max(TRAINING.scaleFloor, Math.exp(logSize)))

function quantilesOf(values: Float64Array): number[] {
  const sorted = Float64Array.from(values).sort()
  return QUANTILE_LEVELS.map((tau) => quantileOfSorted(sorted, tau))
}

/** The panel's rows `rows`, columns `cols` (all when absent), as a matrix of their own. */
function gather(panel: Panel, rows: Uint32Array, cols: number = panel.cols): Matrix {
  const data = new Float64Array(rows.length * cols)
  for (let k = 0; k < rows.length; k++) {
    const base = rows[k] * panel.cols
    for (let col = 0; col < cols; col++) data[k * cols + col] = panel.x[base + col]
  }
  return { rows: rows.length, cols, data }
}

function volatilityMatrix(matrix: Matrix): Matrix {
  const width = volatilityInputs(matrix.data, 0).length
  const data = new Float64Array(matrix.rows * width)
  for (let row = 0; row < matrix.rows; row++) data.set(volatilityInputs(matrix.data, row * matrix.cols), row * width)
  return { rows: matrix.rows, cols: width, data }
}

/** Fits every model at a horizon on the rows `train`, stopping the boosting on `valid` (rows whose
 * outcomes are known; each set's outcomes must be there). */
export function fitHorizon(panel: Panel, train: Uint32Array, valid: Uint32Array, horizon: Horizon, seed: number): FittedHorizon {
  const z = Float64Array.from(train, (row) => normalizedTarget(panel, row, horizon))
  const zValid = Float64Array.from(valid, (row) => normalizedTarget(panel, row, horizon))
  const matrix = gather(panel, train)
  const validMatrix = gather(panel, valid)
  const cuts = fitCuts(matrix, undefined, undefined, seed)
  const binned = binMatrix(matrix, cuts)
  const binnedValid = binMatrix(validMatrix, cuts)

  // The volatility's size, shared by the two centres that have none of their own.
  const volInputs = volatilityMatrix(matrix)
  const size = fitRidge(volInputs, Float64Array.from(z, (value) => Math.log(Math.abs(value) + TRAINING.logFloor)), TRAINING.ridgeLambda)
  const volSize = Float64Array.from({ length: matrix.rows }, (_, row) => sizeOf(predictRidge(size, volInputs.data, row * volInputs.cols)))
  const residualOf = (center: (row: number) => number, scale: (row: number) => number): number[] => quantilesOf(Float64Array.from(z, (value, row) => (value - center(row)) / scale(row)))

  const technical = fitRidge(matrix, z, TRAINING.ridgeLambda)
  const forest = fitForest(binned, z, { ...TRAINING.forest, seed: seed + 1 })
  const boosted = (data: Binned, dataValid: Binned, salt: number): { center: GbtModel; size: GbtModel; residual: number[] } => {
    const center = fitGbt(data, z, dataValid, zValid, { kind: 'l2' }, { ...GBT_BASE, ...TRAINING.center, seed: seed + salt })
    const centers = Float64Array.from({ length: matrix.rows }, (_, row) => predictGbt(center, matrix.data, row * matrix.cols))
    const centersValid = Float64Array.from({ length: validMatrix.rows }, (_, row) => predictGbt(center, validMatrix.data, row * validMatrix.cols))
    const logResidual = Float64Array.from(z, (value, row) => Math.log(Math.abs(value - centers[row]) + TRAINING.logFloor))
    const logResidualValid = Float64Array.from(zValid, (value, row) => Math.log(Math.abs(value - centersValid[row]) + TRAINING.logFloor))
    const sizeModel = fitGbt(data, logResidual, dataValid, logResidualValid, { kind: 'l2' }, { ...GBT_BASE, ...TRAINING.scale, seed: seed + salt + 1 })
    const residual = residualOf(
      (row) => centers[row],
      (row) => sizeOf(predictGbt(sizeModel, matrix.data, row * matrix.cols))
    )
    return { center, size: sizeModel, residual }
  }
  const priceCuts = cuts.slice(0, PRICE_FEATURES)
  const priceMatrix = gather(panel, train, PRICE_FEATURES)
  const priceValid = gather(panel, valid, PRICE_FEATURES)
  // The direction models (V7.1 Stage 2): which way, from the rows whose move cleared the floor either way.
  const way = (rows: Uint32Array, values: Float64Array): { rows: Uint32Array; y: Float64Array } => {
    const kept: number[] = []
    for (let k = 0; k < rows.length; k++) if (Math.abs(values[k]) > TRAINING.direction.floor) kept.push(k)
    return { rows: Uint32Array.from(kept, (k) => rows[k]), y: Float64Array.from(kept, (k) => (values[k] > 0 ? 1 : 0)) }
  }
  const wayTrain = way(train, z)
  const wayValid = way(valid, zValid)
  const dirParams = { ...GBT_BASE, trees: TRAINING.direction.trees, learningRate: TRAINING.direction.learningRate }
  const wayMatrix = gather(panel, wayTrain.rows)
  const wayBinned = (features: number, own: Float64Array[]): { train: Binned; valid: Binned } => ({
    train: binMatrix(gather(panel, wayTrain.rows, features), own),
    valid: binMatrix(gather(panel, wayValid.rows, features), own)
  })
  const full = wayBinned(panel.cols, cuts)
  const tech = wayBinned(TECH_FEATURES, cuts.slice(0, TECH_FEATURES))
  const price = wayBinned(PRICE_FEATURES, priceCuts)
  const direction: DirectionFits = {
    logistic: fitLogistic(wayMatrix, wayTrain.y, TRAINING.direction.logisticLambda),
    gbt: fitGbt(full.train, wayTrain.y, full.valid, wayValid.y, { kind: 'logloss' }, { ...dirParams, seed: seed + 20 }),
    gbtTech: fitGbt(tech.train, wayTrain.y, tech.valid, wayValid.y, { kind: 'logloss' }, { ...dirParams, seed: seed + 21 }),
    gbtPrice: fitGbt(price.train, wayTrain.y, price.valid, wayValid.y, { kind: 'logloss' }, { ...dirParams, seed: seed + 22 })
  }
  // The excursion models (V7.1 Stage 3): the path's highest high and lowest low, each at its own levels --
  // the low's levels mirrored, so that each is the one the low stays above that often.
  const best = Float64Array.from(train, (row) => normalizedExcursion(panel, row, horizon).best)
  const worst = Float64Array.from(train, (row) => normalizedExcursion(panel, row, horizon).worst)
  const bestValid = Float64Array.from(valid, (row) => normalizedExcursion(panel, row, horizon).best)
  const worstValid = Float64Array.from(valid, (row) => normalizedExcursion(panel, row, horizon).worst)
  const exParams = { ...GBT_BASE, ...TRAINING.excursion }
  const excursion: ExcursionFits = {
    high: EXCURSION_LEVELS.map((level, index) => fitGbt(binned, best, binnedValid, bestValid, { kind: 'pinball', tau: level }, { ...exParams, seed: seed + 30 + index })),
    low: EXCURSION_LEVELS.map((level, index) => fitGbt(binned, worst, binnedValid, worstValid, { kind: 'pinball', tau: 1 - level }, { ...exParams, seed: seed + 40 + index }))
  }
  return {
    version: MODELS_VERSION,
    horizon,
    direction,
    excursion,
    persistence: { residual: quantilesOf(z) },
    volatility: { size, residual: residualOf(() => 0, (row) => volSize[row]) },
    technical: {
      center: technical,
      residual: residualOf(
        (row) => predictRidge(technical, matrix.data, row * matrix.cols),
        (row) => volSize[row]
      )
    },
    forest: {
      center: forest,
      residual: residualOf(
        (row) => predictForest(forest, matrix.data, row * matrix.cols),
        (row) => volSize[row]
      )
    },
    gbt: boosted(binned, binnedValid, 2),
    quantileGbt: {
      levels: QUANTILE_LEVELS.map((tau, index) => fitGbt(binned, z, binnedValid, zValid, { kind: 'pinball', tau }, { ...GBT_BASE, ...TRAINING.quantile, seed: seed + 10 + index }))
    },
    gbtPrice: boosted(binMatrix(priceMatrix, priceCuts), binMatrix(priceValid, priceCuts), 4)
  }
}

/** Each direction model's raw chance of up for one row of figures (V7.1 Stage 2), each inside (0, 1).
 * What a reading means is the calibration's to say (shared/forecast/runCalibration.ts). */
export function predictDirection(fitted: FittedHorizon, x: ArrayLike<number>, offset = 0): Record<DirectionModelId, number> {
  const inside = (chance: number): number => Math.min(1 - 1e-6, Math.max(1e-6, chance))
  return {
    'dir-logistic': inside(predictLogistic(fitted.direction.logistic, x, offset)),
    'dir-gbt': inside(sigmoid(predictGbt(fitted.direction.gbt, x, offset))),
    'dir-gbt-tech': inside(sigmoid(predictGbt(fitted.direction.gbtTech, x, offset))),
    'dir-gbt-price': inside(sigmoid(predictGbt(fitted.direction.gbtPrice, x, offset)))
  }
}

/** The excursion models' levels for one row of figures (V7.1 Stage 3), in usual moves: the highs the path
 * stays under, zero or more and rising with the level; the lows it stays above, zero or less and falling. */
export function predictExcursion(fitted: FittedHorizon, x: ArrayLike<number>, offset = 0): { high: number[]; low: number[] } {
  const high = fitted.excursion.high.map((model) => Math.max(0, predictGbt(model, x, offset))).sort((a, b) => a - b)
  const low = fitted.excursion.low.map((model) => Math.min(0, predictGbt(model, x, offset))).sort((a, b) => b - a)
  return { high, low }
}

/** Every model's five quantiles of z for one row of figures, each in order. */
export function predictHorizon(fitted: FittedHorizon, x: ArrayLike<number>, offset = 0): Record<ForecastModelId, number[]> {
  const volSize = sizeOf(predictRidge(fitted.volatility.size, volatilityInputs(x, offset)))
  const around = (center: number, size: number, residual: number[]): number[] => rearrange(residual.map((q) => center + size * q))
  return {
    persistence: [...fitted.persistence.residual],
    volatility: around(0, volSize, fitted.volatility.residual),
    technical: around(predictRidge(fitted.technical.center, x, offset), volSize, fitted.technical.residual),
    'random-forest': around(predictForest(fitted.forest.center, x, offset), volSize, fitted.forest.residual),
    gbt: around(predictGbt(fitted.gbt.center, x, offset), sizeOf(predictGbt(fitted.gbt.size, x, offset)), fitted.gbt.residual),
    'quantile-gbt': rearrange(fitted.quantileGbt.levels.map((model) => predictGbt(model, x, offset))),
    'gbt-price': around(predictGbt(fitted.gbtPrice.center, x, offset), sizeOf(predictGbt(fitted.gbtPrice.size, x, offset)), fitted.gbtPrice.residual)
  }
}
