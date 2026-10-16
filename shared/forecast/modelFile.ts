import { HORIZONS, type Horizon } from './features'
import type { ForestModel } from './ml/forest'
import type { GbtLoss, GbtModel } from './ml/gbt'
import type { LogisticModel } from './ml/logistic'
import { QUANTILE_LEVELS } from './ml/quantile'
import type { RidgeModel } from './ml/ridge'
import { canonicalJson } from './ml/serialize'
import type { FlatTree } from './ml/tree'
import { MODELS_VERSION, type DirectionFits, type FittedHorizon } from './models'

// A HORIZON'S MODELS ON FILE (V6 Stage 5, 13 October 2026): forecastModels/<run>/<horizon>.json, one
// line of canonical JSON. What inference needs and nothing else -- a tree's splits, children, values
// and gains, not the bins or the hessians it was grown on -- with every number at seven significant
// digits, which no forecast can tell from the full ones and which makes a file a third the size. The
// live forecast always reads a model from its file, so what it runs is what is on record.

export const MODEL_FILE_VERSION = 'forecast-models-file-v1'

interface CompactTree {
  f: number[]
  t: number[]
  l: number[]
  r: number[]
  v: number[]
  g: number[]
}

const round = (value: number): number => (value === 0 ? 0 : Number(value.toPrecision(7)))
const roundAll = (values: readonly number[]): number[] => values.map(round)

function compactTree(tree: FlatTree): CompactTree {
  return { f: [...tree.feature], t: roundAll(tree.threshold), l: [...tree.left], r: [...tree.right], v: roundAll(tree.value), g: roundAll(tree.gain) }
}

function inflateTree(tree: CompactTree): FlatTree {
  const zeros = tree.f.map(() => 0)
  return { feature: tree.f, threshold: tree.t, bin: zeros, left: tree.l, right: tree.r, value: tree.v, cover: zeros, gain: tree.g }
}

const compactGbt = (model: GbtModel): unknown => ({ kind: 'gbt', loss: model.loss, base: round(model.base), features: model.features, grown: model.grown, trees: model.trees.map(compactTree) })
const compactForest = (model: ForestModel): unknown => ({ kind: 'forest', features: model.features, trees: model.trees.map(compactTree) })
const compactRidge = (model: RidgeModel): unknown => ({ kind: 'ridge', mean: roundAll(model.mean), scale: roundAll(model.scale), coef: roundAll(model.coef), intercept: round(model.intercept), columns: model.columns })
const compactLogistic = (model: LogisticModel): unknown => ({ kind: 'logistic', mean: roundAll(model.mean), scale: roundAll(model.scale), coef: roundAll(model.coef), intercept: round(model.intercept), columns: model.columns, iterations: model.iterations })

export function serializeFitted(fitted: FittedHorizon): string {
  return canonicalJson({
    file: MODEL_FILE_VERSION,
    version: fitted.version,
    horizon: fitted.horizon,
    direction: { logistic: compactLogistic(fitted.direction.logistic), gbt: compactGbt(fitted.direction.gbt), gbtTech: compactGbt(fitted.direction.gbtTech), gbtPrice: compactGbt(fitted.direction.gbtPrice) },
    persistence: { residual: roundAll(fitted.persistence.residual) },
    volatility: { size: compactRidge(fitted.volatility.size), residual: roundAll(fitted.volatility.residual) },
    technical: { center: compactRidge(fitted.technical.center), residual: roundAll(fitted.technical.residual) },
    forest: { center: compactForest(fitted.forest.center), residual: roundAll(fitted.forest.residual) },
    gbt: { center: compactGbt(fitted.gbt.center), size: compactGbt(fitted.gbt.size), residual: roundAll(fitted.gbt.residual) },
    quantileGbt: { levels: fitted.quantileGbt.levels.map(compactGbt) },
    gbtPrice: { center: compactGbt(fitted.gbtPrice.center), size: compactGbt(fitted.gbtPrice.size), residual: roundAll(fitted.gbtPrice.residual) }
  })
}

const numbers = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) && (length === undefined || value.length === length)

function readTree(value: unknown, features: number): FlatTree | null {
  const tree = value as Partial<Record<keyof CompactTree, unknown>> | null
  if (typeof tree !== 'object' || tree === null || !numbers(tree.f)) return null
  const n = tree.f.length
  if (n === 0 || !numbers(tree.t, n) || !numbers(tree.l, n) || !numbers(tree.r, n) || !numbers(tree.v, n) || !numbers(tree.g, n)) return null
  const f = tree.f as number[]
  const l = tree.l as number[]
  const r = tree.r as number[]
  // Every split on a figure there is, and every child a node after its parent: a tree that cannot loop.
  for (let node = 0; node < n; node++) {
    if (f[node] < 0) continue
    if (f[node] >= features || l[node] <= node || r[node] <= node || l[node] >= n || r[node] >= n) return null
  }
  return inflateTree(tree as CompactTree)
}

function readGbt(value: unknown): GbtModel | null {
  const model = value as Record<string, unknown> | null
  if (typeof model !== 'object' || model === null || model.kind !== 'gbt' || typeof model.base !== 'number' || typeof model.features !== 'number' || typeof model.grown !== 'number') return null
  const loss = model.loss as Partial<GbtLoss> & { tau?: unknown }
  const lossOk = typeof loss === 'object' && loss !== null && (loss.kind === 'l2' || loss.kind === 'logloss' || (loss.kind === 'pinball' && typeof loss.tau === 'number' && loss.tau > 0 && loss.tau < 1))
  if (!lossOk || !Array.isArray(model.trees)) return null
  const trees = model.trees.map((tree) => readTree(tree, model.features as number))
  if (trees.some((tree) => tree === null)) return null
  return { kind: 'gbt', loss: loss as GbtLoss, base: model.base, features: model.features, grown: model.grown, trees: trees as FlatTree[] }
}

function readLogistic(value: unknown): LogisticModel | null {
  const model = value as Record<string, unknown> | null
  if (typeof model !== 'object' || model === null || model.kind !== 'logistic' || !numbers(model.columns) || typeof model.intercept !== 'number' || typeof model.iterations !== 'number') return null
  const d = (model.columns as number[]).length
  if (!numbers(model.mean, d) || !numbers(model.scale, d) || !numbers(model.coef, d)) return null
  return { kind: 'logistic', mean: model.mean, scale: model.scale, coef: model.coef, intercept: model.intercept, columns: model.columns as number[], iterations: model.iterations }
}

/** A horizon's direction models (V7.1 Stage 2): the boosted ones on the log loss, the logistic whole. */
function readDirection(value: unknown): DirectionFits | null {
  const part = value as Record<string, unknown> | null
  if (typeof part !== 'object' || part === null) return null
  const logistic = readLogistic(part.logistic)
  const gbt = readGbt(part.gbt)
  const gbtTech = readGbt(part.gbtTech)
  const gbtPrice = readGbt(part.gbtPrice)
  if (logistic === null || gbt === null || gbtTech === null || gbtPrice === null) return null
  if (gbt.loss.kind !== 'logloss' || gbtTech.loss.kind !== 'logloss' || gbtPrice.loss.kind !== 'logloss') return null
  return { logistic, gbt, gbtTech, gbtPrice }
}

function readForest(value: unknown): ForestModel | null {
  const model = value as Record<string, unknown> | null
  if (typeof model !== 'object' || model === null || model.kind !== 'forest' || typeof model.features !== 'number' || !Array.isArray(model.trees)) return null
  const trees = model.trees.map((tree) => readTree(tree, model.features as number))
  if (trees.length === 0 || trees.some((tree) => tree === null)) return null
  return { kind: 'forest', features: model.features, trees: trees as FlatTree[] }
}

function readRidge(value: unknown): RidgeModel | null {
  const model = value as Record<string, unknown> | null
  if (typeof model !== 'object' || model === null || model.kind !== 'ridge' || !numbers(model.columns) || typeof model.intercept !== 'number') return null
  const d = (model.columns as number[]).length
  if (!numbers(model.mean, d) || !numbers(model.scale, d) || !numbers(model.coef, d)) return null
  return { kind: 'ridge', mean: model.mean, scale: model.scale, coef: model.coef, intercept: model.intercept, columns: model.columns as number[] }
}

/** A horizon's models read back; null for a file that is not one, from another models version, or
 * damaged anywhere. */
export function parseFitted(text: string): FittedHorizon | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || raw.file !== MODEL_FILE_VERSION || raw.version !== MODELS_VERSION || !HORIZONS.includes(raw.horizon as Horizon)) return null
  const part = (key: string): Record<string, unknown> => (typeof raw[key] === 'object' && raw[key] !== null ? (raw[key] as Record<string, unknown>) : {})
  const residual = (key: string): number[] | null => (numbers(part(key).residual, QUANTILE_LEVELS.length) ? (part(key).residual as number[]) : null)
  const volatility = readRidge(part('volatility').size)
  const technical = readRidge(part('technical').center)
  const forest = readForest(part('forest').center)
  const gbtCenter = readGbt(part('gbt').center)
  const gbtSize = readGbt(part('gbt').size)
  const priceCenter = readGbt(part('gbtPrice').center)
  const priceSize = readGbt(part('gbtPrice').size)
  const levelsRaw = part('quantileGbt').levels
  const levels = Array.isArray(levelsRaw) ? levelsRaw.map(readGbt) : []
  const residuals = ['persistence', 'volatility', 'technical', 'forest', 'gbt', 'gbtPrice'].map(residual)
  const direction = readDirection(raw.direction)
  if (volatility === null || technical === null || forest === null || gbtCenter === null || gbtSize === null || priceCenter === null || priceSize === null || direction === null) return null
  if (levels.length !== QUANTILE_LEVELS.length || levels.some((model) => model === null) || residuals.some((value) => value === null)) return null
  const [persistence, vol, tech, forestResidual, gbtResidual, priceResidual] = residuals as number[][]
  return {
    version: MODELS_VERSION,
    horizon: raw.horizon as Horizon,
    direction,
    persistence: { residual: persistence },
    volatility: { size: volatility, residual: vol },
    technical: { center: technical, residual: tech },
    forest: { center: forest, residual: forestResidual },
    gbt: { center: gbtCenter, size: gbtSize, residual: gbtResidual },
    quantileGbt: { levels: levels as GbtModel[] },
    gbtPrice: { center: priceCenter, size: priceSize, residual: priceResidual }
  }
}
