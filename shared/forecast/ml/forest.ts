import { rngOf, type Binned } from './bins'
import { growTree, predictTree, type FlatTree, type TreeParams } from './tree'

// A RANDOM FOREST (the V6 document, §12-13; V6 Stage 4, 13 October 2026): many deep trees, each grown
// on a bootstrap sample of the rows and choosing among a fraction of the figures at every split, their
// predictions averaged. The same histogram tree as the boosting's, fitted to the targets themselves:
// g = -y and h = 1 with no L2, so a leaf's value is the mean of its rows' targets.

export interface ForestParams extends Omit<TreeParams, 'featureSampling' | 'lambda'> {
  trees: number
  /** The bootstrap sample's size, as a share of the rows. */
  sampleFraction: number
  seed: number
}

export interface ForestModel {
  kind: 'forest'
  trees: FlatTree[]
  features: number
}

export function fitForest(train: Binned, y: Float64Array, params: ForestParams): ForestModel {
  const random = rngOf(params.seed)
  const g = Float64Array.from(y, (value) => -value)
  const h = new Float64Array(train.rows).fill(1)
  const take = Math.max(1, Math.round(train.rows * params.sampleFraction))
  const trees: FlatTree[] = []
  for (let t = 0; t < params.trees; t++) {
    const rows = new Uint32Array(take)
    for (let index = 0; index < take; index++) rows[index] = Math.floor(random() * train.rows)
    trees.push(growTree(train, g, h, rows, { ...params, lambda: 0, featureSampling: 'node' }, random).tree)
  }
  return { kind: 'forest', trees, features: train.cols }
}

export function predictForest(model: ForestModel, x: ArrayLike<number>, offset = 0): number {
  let total = 0
  for (const tree of model.trees) total += predictTree(tree, x, offset)
  return model.trees.length === 0 ? 0 : total / model.trees.length
}
