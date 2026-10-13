import { rngOf, type Binned } from './bins'
import { growTree, predictTree, predictTreeBinned, treeContributions, type FlatTree, type TreeParams } from './tree'

// GRADIENT-BOOSTED TREES (the V6 document, §13; V6 Stage 4, 13 October 2026).
//
// Trees fitted one after another to what the ones before still get wrong, each shrunk by the
// learning rate. Two losses:
// - L2, for a median-like centre and for a scale (fitted to log |residual|): g = f - y, h = 1;
// - PINBALL at a quantile tau, for a quantile directly: g = (1 - tau) where f > y, else -tau, and h =
//   1 to grow the tree; each leaf's value is then set to the tau-quantile of the residuals of its
//   rows (leaf renewal), because a pinball loss has no curvature for a Newton step to use.
// Each tree sees a sample of the rows, and the fit stops when the loss on the held-back rows has not
// improved for `patience` trees, keeping the trees up to its best.

export type GbtLoss = { kind: 'l2' } | { kind: 'pinball'; tau: number }

export interface GbtParams extends TreeParams {
  trees: number
  learningRate: number
  /** The share of the rows each tree is grown on. */
  subsample: number
  /** Trees without an improvement on the held-back rows before the fit stops. */
  patience: number
  seed: number
}

export interface GbtModel {
  kind: 'gbt'
  loss: GbtLoss
  base: number
  trees: FlatTree[]
  features: number
  /** Trees grown before the fit stopped: those kept, and the patience's worth after the best. */
  grown: number
}

/** A row's gradient of the loss at the prediction `f`. */
export function gradientOf(loss: GbtLoss, y: number, f: number): number {
  if (loss.kind === 'l2') return f - y
  return f > y ? 1 - loss.tau : -loss.tau
}

export function lossOf(loss: GbtLoss, y: number, f: number): number {
  if (loss.kind === 'l2') return 0.5 * (f - y) ** 2
  return y >= f ? loss.tau * (y - f) : (1 - loss.tau) * (f - y)
}

function quantileOf(values: Float64Array | number[], tau: number): number {
  const sorted = Float64Array.from(values).sort()
  if (sorted.length === 0) return 0
  const position = tau * (sorted.length - 1)
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

/** Fits the trees on `train`, stopping on `valid` (both binned on the training rows' cuts). */
export function fitGbt(train: Binned, y: Float64Array, valid: Binned, yValid: Float64Array, loss: GbtLoss, params: GbtParams): GbtModel {
  const random = rngOf(params.seed)
  const base = loss.kind === 'l2' ? y.reduce((sum, value) => sum + value, 0) / Math.max(1, y.length) : quantileOf(y, loss.tau)
  const pred = new Float64Array(train.rows).fill(base)
  const predValid = new Float64Array(valid.rows).fill(base)
  const g = new Float64Array(train.rows)
  const h = new Float64Array(train.rows).fill(1)
  const trees: FlatTree[] = []
  const validLoss = (): number => {
    let total = 0
    for (let row = 0; row < valid.rows; row++) total += lossOf(loss, yValid[row], predValid[row])
    return valid.rows === 0 ? 0 : total / valid.rows
  }
  let best = validLoss()
  let bestTrees = 0
  const take = Math.max(1, Math.round(train.rows * params.subsample))
  for (let t = 0; t < params.trees; t++) {
    for (let row = 0; row < train.rows; row++) g[row] = gradientOf(loss, y[row], pred[row])
    // The rows this tree is grown on, without repeats.
    const rows = new Uint32Array(take)
    if (take === train.rows) for (let index = 0; index < take; index++) rows[index] = index
    else {
      const all = Uint32Array.from({ length: train.rows }, (_, index) => index)
      for (let index = 0; index < take; index++) {
        const swap = index + Math.floor(random() * (train.rows - index))
        const held = all[index]
        all[index] = all[swap]
        all[swap] = held
        rows[index] = all[index]
      }
    }
    const grown = growTree(train, g, h, rows, params, random)
    const tree = grown.tree
    if (loss.kind === 'pinball') {
      for (const leaf of grown.leaves) {
        const residuals: number[] = []
        for (let at = leaf.start; at < leaf.end; at++) residuals.push(y[grown.rows[at]] - pred[grown.rows[at]])
        tree.value[leaf.node] = residuals.length === 0 ? 0 : quantileOf(residuals, loss.tau)
      }
    }
    for (let node = 0; node < tree.value.length; node++) tree.value[node] *= params.learningRate
    for (let row = 0; row < train.rows; row++) pred[row] += predictTreeBinned(tree, train.bins, row * train.cols)
    for (let row = 0; row < valid.rows; row++) predValid[row] += predictTreeBinned(tree, valid.bins, row * valid.cols)
    trees.push(tree)
    // Without rows held back there is nothing to stop on: every tree is kept.
    if (valid.rows === 0) {
      bestTrees = trees.length
      continue
    }
    const now = validLoss()
    if (now < best - 1e-12) {
      best = now
      bestTrees = trees.length
    } else if (trees.length - bestTrees >= params.patience) break
  }
  return { kind: 'gbt', loss, base, trees: trees.slice(0, Math.max(1, bestTrees)), features: train.cols, grown: trees.length }
}

/** The model's prediction for one row of raw figures. */
export function predictGbt(model: GbtModel, x: ArrayLike<number>, offset = 0): number {
  let total = model.base
  for (const tree of model.trees) total += predictTree(tree, x, offset)
  return total
}

/** How each figure moved one row's prediction from the base, summed over the trees: the base plus
 * the contributions is the prediction. */
export function gbtContributions(model: GbtModel, x: ArrayLike<number>, offset = 0): { base: number; contributions: Float64Array } {
  const contributions = new Float64Array(model.features)
  let base = model.base
  for (const tree of model.trees) base += treeContributions(tree, x, contributions, offset)
  return { base, contributions }
}
