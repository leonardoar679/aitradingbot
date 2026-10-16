import { describe, expect, it } from 'vitest'
import { MAX_BINS, binMatrix, binOf, fitCuts, rngOf, type Matrix } from '../shared/forecast/ml/bins'
import { aciStep, conformalAdjustment, conformityScore } from '../shared/forecast/ml/conformal'
import { fitForest, predictForest } from '../shared/forecast/ml/forest'
import { fitGbt, gbtContributions, gradientOf, hessianOf, logit, lossOf, predictGbt, sigmoid, type GbtParams } from '../shared/forecast/ml/gbt'
import { fitIsotonic, predictIsotonic } from '../shared/forecast/ml/isotonic'
import { LOGISTIC_FIT, fitLogistic, logisticLogit, predictLogistic } from '../shared/forecast/ml/logistic'
import { QUANTILE_LEVELS, cdfAt, meanPinball, pinball, quantileOfSorted, rearrange, vincentize } from '../shared/forecast/ml/quantile'
import { fitRidge, predictRidge, ridgeContributions, solveSpd } from '../shared/forecast/ml/ridge'
import { canonicalJson, parseModel, serializeModel } from '../shared/forecast/ml/serialize'
import { growTree, predictTree, predictTreeBinned } from '../shared/forecast/ml/tree'

// THE FORECAST'S MACHINE LEARNING (shared/forecast/ml/; the V6 document, §12-14, §26 and §59), checked
// on problems whose answers are known: a step a tree must find, a curve the boosting must follow,
// quantiles that must hold their share of outcomes, a forest that must beat one tree, a line ridge
// must recover, and intervals conformal calibration must make hold what they say.

/** Rows from a seeded generator: `cols` figures uniform on [-2, 2], and y from them. */
function rowsOf(count: number, cols: number, seed: number, target: (x: Float64Array, offset: number, random: () => number) => number): { matrix: Matrix; y: Float64Array } {
  const random = rngOf(seed)
  const data = new Float64Array(count * cols)
  const y = new Float64Array(count)
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < cols; col++) data[row * cols + col] = random() * 4 - 2
    y[row] = target(data, row * cols, random)
  }
  return { matrix: { rows: count, cols, data }, y }
}

const gauss = (random: () => number): number => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random())

const GBT: GbtParams = {
  trees: 200,
  learningRate: 0.1,
  maxDepth: 4,
  minLeafRows: 20,
  minLeafHessian: 1,
  lambda: 1,
  minGain: 0,
  featureFraction: 1,
  featureSampling: 'tree',
  subsample: 0.8,
  patience: 20,
  seed: 3
}

describe('bins', () => {
  it('cut a figure at its quantiles, each once, never at its largest value', () => {
    const data = Float64Array.from({ length: 1000 }, (_, index) => index)
    const cuts = fitCuts({ rows: 1000, cols: 1, data })[0]
    expect(cuts.length).toBe(MAX_BINS - 1)
    expect([...cuts].every((cut, index) => index === 0 || cut > cuts[index - 1])).toBe(true)
    expect(cuts[cuts.length - 1]).toBeLessThan(999)
    // A figure that is 0 or 1 is cut once, at 0; one that never changes, never.
    const flags = fitCuts({ rows: 4, cols: 2, data: Float64Array.from([0, 5, 1, 5, 0, 5, 1, 5]) })
    expect([...flags[0]]).toEqual([0])
    expect([...flags[1]]).toEqual([])
  })

  it('put a value in the first bin whose cut is at or above it', () => {
    const cuts = Float64Array.from([1, 2, 3])
    expect([0.5, 1, 1.5, 3, 3.5].map((value) => binOf(cuts, value))).toEqual([0, 0, 1, 2, 3])
  })
})

describe('a tree', () => {
  it('finds a step, and reads the same on raw figures as on their bins', () => {
    const { matrix, y } = rowsOf(4000, 3, 1, (x, at) => (x[at] > 0.3 ? 2 : -1))
    const binned = binMatrix(matrix, fitCuts(matrix))
    const g = Float64Array.from(y, (value) => -value)
    const h = new Float64Array(y.length).fill(1)
    const rows = Uint32Array.from({ length: y.length }, (_, index) => index)
    const { tree } = growTree(binned, g, h, rows, { maxDepth: 1, minLeafRows: 1, minLeafHessian: 0, lambda: 0, minGain: 0, featureFraction: 1, featureSampling: 'tree' }, rngOf(1))
    expect(tree.feature[0]).toBe(0)
    expect(Math.abs(tree.threshold[0] - 0.3)).toBeLessThan(0.1)
    expect(tree.value[tree.left[0]]).toBeCloseTo(-1, 1)
    expect(tree.value[tree.right[0]]).toBeCloseTo(2, 1)
    for (let row = 0; row < 500; row++) expect(predictTreeBinned(tree, binned.bins, row * 3)).toBe(predictTree(tree, matrix.data, row * 3))
  })

  const leastSquares = { minLeafHessian: 0, lambda: 0, minGain: 0, featureFraction: 1, featureSampling: 'tree' as const }

  it('gives each leaf the mean of the rows that end in it, at every depth (the subtraction trick)', () => {
    const { matrix, y } = rowsOf(3000, 4, 2, (x, at, random) => Math.sin(2 * x[at]) + x[at + 1] * x[at + 2] + 0.3 * gauss(random))
    const binned = binMatrix(matrix, fitCuts(matrix))
    const g = Float64Array.from(y, (value) => -value)
    const h = new Float64Array(y.length).fill(1)
    const rows = Uint32Array.from({ length: y.length }, (_, index) => index)
    const { tree } = growTree(binned, g, h, rows, { ...leastSquares, maxDepth: 4, minLeafRows: 30 }, rngOf(2))
    const sums = new Map<number, { sum: number; n: number }>()
    for (let row = 0; row < y.length; row++) {
      let node = 0
      while (tree.feature[node] >= 0) node = matrix.data[row * 4 + tree.feature[node]] <= tree.threshold[node] ? tree.left[node] : tree.right[node]
      const held = sums.get(node) ?? { sum: 0, n: 0 }
      sums.set(node, { sum: held.sum + y[row], n: held.n + 1 })
    }
    expect(sums.size).toBeGreaterThan(8)
    for (const [node, { sum, n }] of sums) {
      expect(tree.value[node]).toBeCloseTo(sum / n, 9)
      expect(n).toBeGreaterThanOrEqual(30)
    }
  })

  it('splits nothing that cannot gain, and leaves no leaf under its least rows', () => {
    const flat = rowsOf(1000, 3, 3, () => 1)
    const binned = binMatrix(flat.matrix, fitCuts(flat.matrix))
    const rows = Uint32Array.from({ length: 1000 }, (_, index) => index)
    const one = growTree(binned, Float64Array.from(flat.y, (value) => -value), new Float64Array(1000).fill(1), rows, { ...leastSquares, maxDepth: 3, minLeafRows: 1 }, rngOf(3))
    expect(one.tree.feature).toEqual([-1])
    const step = rowsOf(1000, 3, 4, (x, at) => x[at])
    const stepBinned = binMatrix(step.matrix, fitCuts(step.matrix))
    const big = growTree(stepBinned, Float64Array.from(step.y, (value) => -value), new Float64Array(1000).fill(1), rows, { ...leastSquares, maxDepth: 3, minLeafRows: 400 }, rngOf(4))
    expect(big.leaves.length).toBe(2)
    expect(big.leaves.every((leaf) => leaf.end - leaf.start >= 400)).toBe(true)
  })
})

describe('gradient boosting', () => {
  const noisySine = (x: Float64Array, at: number, random: () => number): number => Math.sin(2 * x[at]) + 0.3 * gauss(random)

  it('follows a curve through its noise, and stops when the held-back rows stop improving', () => {
    const train = rowsOf(4000, 4, 11, noisySine)
    const valid = rowsOf(1500, 4, 12, noisySine)
    const cuts = fitCuts(train.matrix)
    const model = fitGbt(binMatrix(train.matrix, cuts), train.y, binMatrix(valid.matrix, cuts), valid.y, { kind: 'l2' }, GBT)
    let mse = 0
    let variance = 0
    const mean = valid.y.reduce((sum, value) => sum + value, 0) / valid.y.length
    for (let row = 0; row < valid.matrix.rows; row++) {
      mse += (predictGbt(model, valid.matrix.data, row * 4) - valid.y[row]) ** 2
      variance += (valid.y[row] - mean) ** 2
    }
    // The noise alone is 0.09 of a total variance near 0.6: most of what can be explained is.
    expect(mse / valid.matrix.rows).toBeLessThan(0.13)
    expect(mse / variance).toBeLessThan(0.25)
    // It stopped before the last tree allowed, a patience's worth after its best, and the last tree it
    // kept still improved the held-back loss.
    expect(model.grown).toBeLessThan(GBT.trees)
    expect(model.grown - model.trees.length).toBe(GBT.patience)
    const heldLoss = (trees: typeof model.trees): number => {
      let total = 0
      for (let row = 0; row < valid.matrix.rows; row++) total += lossOf({ kind: 'l2' }, valid.y[row], predictGbt({ ...model, trees }, valid.matrix.data, row * 4))
      return total
    }
    expect(heldLoss(model.trees)).toBeLessThan(heldLoss(model.trees.slice(0, -1)))
    // It starts from the mean.
    expect(model.base).toBeCloseTo(train.y.reduce((sum, value) => sum + value, 0) / train.y.length, 12)
  })

  it('steps each tree by the learning rate, from the base', () => {
    // A step of 4 at x0 = 0 and a mean of 2: one tree of +-2, shrunk by a quarter to +-0.5.
    const step = rowsOf(2000, 2, 14, (x, at) => (x[at] > 0 ? 4 : 0))
    const cuts = fitCuts(step.matrix)
    const binned = binMatrix(step.matrix, cuts)
    const model = fitGbt(binned, step.y, binMatrix({ rows: 0, cols: 2, data: new Float64Array(0) }, cuts), new Float64Array(0), { kind: 'l2' }, { ...GBT, trees: 1, maxDepth: 1, lambda: 0, learningRate: 0.25 })
    const mean = step.y.reduce((sum, value) => sum + value, 0) / step.y.length
    expect(predictGbt(model, Float64Array.from([1, 0])) - model.base).toBeCloseTo(0.25 * (4 - mean), 1)
    expect(predictGbt(model, Float64Array.from([-1, 0])) - model.base).toBeCloseTo(0.25 * (0 - mean), 1)
  })

  it("moves at a pinball loss by the level's own gradient, and sets a leaf at its rows' quantile", () => {
    expect(gradientOf({ kind: 'pinball', tau: 0.9 }, 0, 1)).toBeCloseTo(0.1)
    expect(gradientOf({ kind: 'pinball', tau: 0.9 }, 1, 0)).toBeCloseTo(-0.9)
    expect(gradientOf({ kind: 'pinball', tau: 0.25 }, 0, 1)).toBeCloseTo(0.75)
    expect(gradientOf({ kind: 'l2' }, 1, 3)).toBe(2)
    // Two groups forty apart: one renewed tree at the full rate puts each at its own 90th percentile,
    // far from where the whole sample's starts.
    const groups = rowsOf(4000, 1, 15, (x, at, random) => (x[at] > 0 ? 20 : -20) + gauss(random))
    const cuts = fitCuts(groups.matrix)
    const empty = binMatrix({ rows: 0, cols: 1, data: new Float64Array(0) }, cuts)
    const model = fitGbt(binMatrix(groups.matrix, cuts), groups.y, empty, new Float64Array(0), { kind: 'pinball', tau: 0.9 }, { ...GBT, trees: 1, maxDepth: 1, learningRate: 1 })
    expect(predictGbt(model, Float64Array.from([-1]))).toBeCloseTo(-20 + 1.2816, 0)
    expect(predictGbt(model, Float64Array.from([1]))).toBeCloseTo(20 + 1.2816, 0)
  })

  it('keeps every tree when nothing is held back to stop on', () => {
    const train = rowsOf(800, 2, 13, noisySine)
    const cuts = fitCuts(train.matrix)
    const empty = binMatrix({ rows: 0, cols: 2, data: new Float64Array(0) }, cuts)
    const model = fitGbt(binMatrix(train.matrix, cuts), train.y, empty, new Float64Array(0), { kind: 'l2' }, { ...GBT, trees: 30 })
    expect(model.trees).toHaveLength(30)
  })

  it('at a pinball loss, holds its share of new outcomes below each quantile, the spread growing with the noise', () => {
    // The noise grows with |x1|: a quantile must widen where it does.
    const target = (x: Float64Array, at: number, random: () => number): number => x[at] + (0.2 + Math.abs(x[at + 1])) * gauss(random)
    const train = rowsOf(6000, 3, 21, target)
    const valid = rowsOf(1500, 3, 22, target)
    const test = rowsOf(3000, 3, 23, target)
    const cuts = fitCuts(train.matrix)
    const trainBinned = binMatrix(train.matrix, cuts)
    const validBinned = binMatrix(valid.matrix, cuts)
    for (const tau of [0.1, 0.9]) {
      const model = fitGbt(trainBinned, train.y, validBinned, valid.y, { kind: 'pinball', tau }, { ...GBT, learningRate: 0.05, trees: 300 })
      // It starts from the tau quantile of the targets.
      expect(model.base).toBeCloseTo(quantileOfSorted([...train.y].sort((a, b) => a - b), tau), 12)
      let below = 0
      for (let row = 0; row < test.matrix.rows; row++) if (test.y[row] <= predictGbt(model, test.matrix.data, row * 3)) below++
      expect(Math.abs(below / test.matrix.rows - tau), `tau ${tau}`).toBeLessThan(0.04)
      if (tau === 0.9) {
        // Wider where |x1| is large: the quantile above x0 at x1 = 1.8 against at x1 = 0.
        const wide = predictGbt(model, Float64Array.from([0, 1.8, 0])) - 0
        const narrow = predictGbt(model, Float64Array.from([0, 0, 0])) - 0
        expect(wide).toBeGreaterThan(narrow + 0.8)
      }
    }
  })

  it('tells how each figure moved a row from its base, adding up to the prediction', () => {
    const train = rowsOf(2000, 3, 31, noisySine)
    const cuts = fitCuts(train.matrix)
    const model = fitGbt(binMatrix(train.matrix, cuts), train.y, binMatrix(train.matrix, cuts), train.y, { kind: 'l2' }, { ...GBT, trees: 40 })
    for (let row = 0; row < 50; row++) {
      const { base, contributions } = gbtContributions(model, train.matrix.data, row * 3)
      expect(base + contributions.reduce((sum, value) => sum + value, 0)).toBeCloseTo(predictGbt(model, train.matrix.data, row * 3), 10)
      // The curve is in x0: it carries most of the movement.
      if (row === 0) expect(Math.abs(contributions[0])).toBeGreaterThanOrEqual(Math.abs(contributions[2]))
    }
    expect(lossOf({ kind: 'pinball', tau: 0.9 }, 1, 0)).toBeCloseTo(0.9)
    expect(lossOf({ kind: 'pinball', tau: 0.9 }, 0, 1)).toBeCloseTo(0.1)
  })
})

describe('a random forest', () => {
  it('beats one deep tree on rows it was not grown on', () => {
    const target = (x: Float64Array, at: number, random: () => number): number => Math.sin(2 * x[at]) + 0.5 * x[at + 1] * x[at + 2] + 0.4 * gauss(random)
    const train = rowsOf(3000, 5, 41, target)
    const test = rowsOf(1500, 5, 42, target)
    const cuts = fitCuts(train.matrix)
    const binned = binMatrix(train.matrix, cuts)
    const params = { maxDepth: 10, minLeafRows: 3, minLeafHessian: 0, minGain: 0, featureFraction: 0.6, sampleFraction: 1, seed: 5 }
    const one = fitForest(binned, train.y, { ...params, trees: 1 })
    const forest = fitForest(binned, train.y, { ...params, trees: 60 })
    const mse = (predict: (row: number) => number): number => {
      let total = 0
      for (let row = 0; row < test.matrix.rows; row++) total += (predict(row) - test.y[row]) ** 2
      return total / test.matrix.rows
    }
    expect(mse((row) => predictForest(forest, test.matrix.data, row * 5))).toBeLessThan(0.8 * mse((row) => predictForest(one, test.matrix.data, row * 5)))
    // Each tree its own bootstrap sample: their roots, the means of their samples, differ.
    expect(new Set(forest.trees.map((tree) => tree.value[0])).size).toBe(forest.trees.length)
  })
})

describe('ridge', () => {
  it('recovers a line, its weights shrinking with the penalty, and the closed form agrees', () => {
    const { matrix, y } = rowsOf(3000, 3, 51, (x, at, random) => 3 + 2 * x[at] - x[at + 1] + 0.01 * gauss(random))
    const fitted = fitRidge(matrix, y, 1e-6)
    expect(predictRidge(fitted, Float64Array.from([0, 0, 0]))).toBeCloseTo(3, 2)
    expect(predictRidge(fitted, Float64Array.from([1, 0, 0])) - predictRidge(fitted, Float64Array.from([0, 0, 0]))).toBeCloseTo(2, 2)
    expect(predictRidge(fitted, Float64Array.from([0, 1, 0])) - predictRidge(fitted, Float64Array.from([0, 0, 0]))).toBeCloseTo(-1, 2)
    const shrunk = fitRidge(matrix, y, 1e5)
    expect(Math.abs(shrunk.coef[0])).toBeLessThan(Math.abs(fitted.coef[0]) * 0.5)
    // The intercept and the contributions are the prediction.
    const x = Float64Array.from([0.7, -1.2, 0.4])
    expect(fitted.intercept + ridgeContributions(fitted, x, 3).reduce((sum, value) => sum + value, 0)).toBeCloseTo(predictRidge(fitted, x), 10)
    // The Cholesky solve on a small known system: [[4, 2], [2, 3]] x = [2, 1].
    expect([...solveSpd(Float64Array.from([4, 2, 2, 3]), Float64Array.from([2, 1]), 2)].map((value) => Number(value.toFixed(10)))).toEqual([0.5, 0])
    // Only the columns asked for are read.
    expect(fitRidge(matrix, y, 1e-6, [0]).coef).toHaveLength(1)
  })
})

describe('quantiles', () => {
  it('are scored by a pinball loss that is least at the true quantile', () => {
    const random = rngOf(61)
    const sample = Array.from({ length: 4000 }, () => gauss(random)).sort((a, b) => a - b)
    for (const tau of QUANTILE_LEVELS) {
      const q = quantileOfSorted(sample, tau)
      const mean = (at: number): number => sample.reduce((sum, value) => sum + pinball(value, at, tau), 0) / sample.length
      expect(mean(q)).toBeLessThan(mean(q + 0.1))
      expect(mean(q)).toBeLessThan(mean(q - 0.1))
    }
    expect(meanPinball(0, [-1, -0.5, 0, 0.5, 1])).toBeCloseTo((0.1 + 0.125 + 0 + 0.125 + 0.1) / 5)
  })

  it('combine level by level, weighted, and are put in order where they cross', () => {
    expect(vincentize([{ quantiles: [1, 2, 3], weight: 1 }, { quantiles: [3, 4, 5], weight: 3 }])).toEqual([2.5, 3.5, 4.5])
    expect(vincentize([{ quantiles: [1, 2], weight: 0 }])).toEqual([Number.NaN, Number.NaN])
    expect(rearrange([0.3, 0.1, 0.2])).toEqual([0.1, 0.2, 0.3])
  })

  it('give back the distribution: the levels at the quantiles, straight between, held within 0 and 1 beyond', () => {
    const quantiles = [-2, -1, 0, 1, 2]
    QUANTILE_LEVELS.forEach((tau, index) => expect(cdfAt(quantiles, QUANTILE_LEVELS, quantiles[index])).toBeCloseTo(tau))
    expect(cdfAt(quantiles, QUANTILE_LEVELS, 0.5)).toBeCloseTo(0.625)
    expect(cdfAt(quantiles, QUANTILE_LEVELS, -2.5)).toBeCloseTo(0.025)
    expect(cdfAt(quantiles, QUANTILE_LEVELS, -9)).toBe(0)
    expect(cdfAt(quantiles, QUANTILE_LEVELS, 9)).toBe(1)
    // Two quantiles the same: no division by zero.
    expect(cdfAt([0, 0, 0, 1, 2], QUANTILE_LEVELS, 0)).toBeGreaterThanOrEqual(0.1)
  })
})

describe('isotonic regression', () => {
  it('pools the violators into a non-decreasing line through the outcomes', () => {
    const model = fitIsotonic([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
      { x: 3, y: 1 }
    ])
    expect(model.y).toEqual([0, 0.5, 1])
    expect(model.n).toEqual([1, 2, 1])
    expect(model.y.every((value, index) => index === 0 || value >= model.y[index - 1])).toBe(true)
    expect(predictIsotonic(model, -5)).toBe(0)
    expect(predictIsotonic(model, 1.5)).toBeCloseTo(0.5)
    expect(predictIsotonic(model, 9)).toBe(1)
    expect(predictIsotonic(fitIsotonic([]), 0)).toBeNaN()
  })
})

describe('conformal calibration', () => {
  it('reads the widening at the ceil((n+1)(1-alpha))-th score, and none with too few', () => {
    const scores = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(conformalAdjustment(scores, 0.1)).toBe(91)
    expect(conformalAdjustment([1, 2, 3, 4, 5], 0.1)).toBeNull()
    expect(conformalAdjustment([], 0.1)).toBeNull()
    expect(conformityScore(0, 1, 0.5)).toBeCloseTo(-0.5)
    expect(conformityScore(0, 1, 1.4)).toBeCloseTo(0.4)
  })

  it('makes an interval that held too little hold its share of new outcomes', () => {
    const random = rngOf(71)
    // A claimed 80% interval of +-0.5 on outcomes whose spread is 1: it holds about 38%.
    const draw = (): number => gauss(random)
    const calibration = Array.from({ length: 2000 }, () => conformityScore(-0.5, 0.5, draw()))
    const widen = conformalAdjustment(calibration, 0.2)!
    const fresh = Array.from({ length: 4000 }, draw)
    const inside = fresh.filter((y) => y >= -0.5 - widen && y <= 0.5 + widen).length / fresh.length
    expect(Math.abs(inside - 0.8)).toBeLessThan(0.025)
  })

  it('moves the miscoverage up after an outcome inside and down after one outside, held within (0, 1)', () => {
    expect(aciStep(0.2, 0.2, false, 0.01)).toBeCloseTo(0.202)
    expect(aciStep(0.2, 0.2, true, 0.01)).toBeCloseTo(0.192)
    expect(aciStep(0.001, 0.2, true, 1)).toBe(0.001)
    // Followed for long enough on outcomes that miss a fixed 30% of the time, it settles where 20% miss
    // only if the interval moves with it; here it reports the drift: the miscoverage goes down.
    let alpha = 0.2
    const random = rngOf(81)
    for (let k = 0; k < 2000; k++) alpha = aciStep(alpha, 0.2, random() < 0.3, 0.005)
    expect(alpha).toBeLessThan(0.1)
  })
})

describe('a model on file', () => {
  it('is the same bytes for the same fit, and predicts the same read back', () => {
    const train = rowsOf(1500, 3, 91, (x, at, random) => x[at] + 0.2 * gauss(random))
    const cuts = fitCuts(train.matrix)
    const fit = (): string => serializeModel(fitGbt(binMatrix(train.matrix, cuts), train.y, binMatrix(train.matrix, cuts), train.y, { kind: 'pinball', tau: 0.75 }, { ...GBT, trees: 25 }))
    const once = fit()
    expect(fit()).toBe(once)
    const back = parseModel(once)
    expect(back?.kind).toBe('gbt')
    const original = fitGbt(binMatrix(train.matrix, cuts), train.y, binMatrix(train.matrix, cuts), train.y, { kind: 'pinball', tau: 0.75 }, { ...GBT, trees: 25 })
    if (back?.kind === 'gbt') for (let row = 0; row < 20; row++) expect(predictGbt(back, train.matrix.data, row * 3)).toBe(predictGbt(original, train.matrix.data, row * 3))
    const ridge = fitRidge(train.matrix, train.y, 1)
    expect(parseModel(serializeModel(ridge))).toEqual(ridge)
    const forest = fitForest(binMatrix(train.matrix, cuts), train.y, { trees: 3, maxDepth: 4, minLeafRows: 5, minLeafHessian: 0, minGain: 0, featureFraction: 1, sampleFraction: 0.5, seed: 1 })
    expect(parseModel(serializeModel(forest))).toEqual(forest)
  })

  it('is written with its keys in order, however the object was built', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}')
  })

  it('is refused when it is not one', () => {
    expect(parseModel('not json')).toBeNull()
    // A model whole but for its loss's level.
    const one = '{"bin":[0],"cover":[1],"feature":[-1],"gain":[0],"left":[-1],"right":[-1],"threshold":[0],"value":[0]}'
    expect(parseModel(`{"kind":"gbt","loss":{"kind":"pinball","tau":0.5},"base":0,"features":1,"grown":1,"trees":[${one}]}`)).not.toBeNull()
    expect(parseModel(`{"kind":"gbt","loss":{"kind":"pinball","tau":2},"base":0,"features":1,"grown":1,"trees":[${one}]}`)).toBeNull()
    expect(parseModel(`{"kind":"gbt","loss":{"kind":"pinball","tau":0.5},"base":0,"features":1,"trees":[${one}]}`)).toBeNull()
    expect(parseModel('{"kind":"ridge","mean":[0],"scale":[1],"coef":[],"columns":[0],"intercept":0}')).toBeNull()
    expect(parseModel('{"kind":"forest","features":1,"trees":[{"feature":[]}]}')).toBeNull()
    expect(parseModel('{"kind":"other"}')).toBeNull()
    expect(() => serializeModel({ kind: 'ridge', mean: [Number.NaN], scale: [1], coef: [1], columns: [0], intercept: 0 })).toThrow()
  })

  it('reads a boosted model on the log loss and a logistic regression back, and refuses either half-made (V7.1 Stage 1)', () => {
    const one = '{"bin":[0],"cover":[1],"feature":[-1],"gain":[0],"left":[-1],"right":[-1],"threshold":[0],"value":[0]}'
    expect(parseModel(`{"kind":"gbt","loss":{"kind":"logloss"},"base":0,"features":1,"grown":1,"trees":[${one}]}`)).not.toBeNull()
    expect(parseModel(`{"kind":"gbt","loss":{"kind":"probit"},"base":0,"features":1,"grown":1,"trees":[${one}]}`)).toBeNull()
    const logistic = '{"kind":"logistic","mean":[0,1],"scale":[1,2],"coef":[0.5,-0.5],"columns":[0,1],"intercept":0.1,"iterations":3}'
    expect(parseModel(logistic)).toEqual(JSON.parse(logistic))
    expect(parseModel('{"kind":"logistic","mean":[0,1],"scale":[1,2],"coef":[0.5],"columns":[0,1],"intercept":0.1,"iterations":3}')).toBeNull()
    expect(parseModel('{"kind":"logistic","mean":[0],"scale":[1],"coef":[0.5],"columns":[0],"intercept":0.1}')).toBeNull()
  })
})

// THE CLASSIFIERS (V7.1 Stage 1, 16 October 2026): the chance of a 0-or-1 outcome, by boosted trees on
// the log loss and by a logistic regression, each checked on rows whose chance is known.
describe('the log loss', () => {
  /** The chance of a one from two figures, and rows drawn from it. */
  const chanceOf = (x: ArrayLike<number>, at: number): number => sigmoid(2 * x[at] - x[at + 1])
  const bernoulli = (x: Float64Array, at: number, random: () => number): number => (random() < chanceOf(x, at) ? 1 : 0)

  /** The mean log loss of chances `p` against outcomes `y`. */
  const meanLogLoss = (p: readonly number[], y: ArrayLike<number>): number => p.reduce((sum, value, row) => sum + lossOf({ kind: 'logloss' }, y[row], logit(value)), 0) / p.length

  /** Chances against the share that came, by tenth of the chances sorted. */
  const calibrationGaps = (p: readonly number[], y: ArrayLike<number>): number[] => {
    const order = p.map((value, row) => ({ value, y: y[row] })).sort((a, b) => a.value - b.value)
    const gaps: number[] = []
    for (let tenth = 0; tenth < 10; tenth++) {
      const slice = order.slice(Math.floor((tenth * order.length) / 10), Math.floor(((tenth + 1) * order.length) / 10))
      const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
      gaps.push(Math.abs(mean(slice.map((entry) => entry.value)) - mean(slice.map((entry) => entry.y))))
    }
    return gaps
  }

  it('has the gradient, the curvature and the loss of a chance, and a base at the logit of the share', () => {
    expect(sigmoid(0)).toBe(0.5)
    expect(sigmoid(logit(0.3))).toBeCloseTo(0.3, 12)
    expect(logit(0)).toBeLessThan(-13)
    expect(logit(1)).toBeGreaterThan(13)
    expect(gradientOf({ kind: 'logloss' }, 1, 0)).toBeCloseTo(-0.5, 12)
    expect(gradientOf({ kind: 'logloss' }, 0, 0)).toBeCloseTo(0.5, 12)
    expect(hessianOf({ kind: 'logloss' }, 0)).toBeCloseTo(0.25, 12)
    expect(hessianOf({ kind: 'logloss' }, 4)).toBeLessThan(0.02)
    expect(hessianOf({ kind: 'l2' }, 4)).toBe(1)
    expect(hessianOf({ kind: 'pinball', tau: 0.1 }, 4)).toBe(1)
    expect(lossOf({ kind: 'logloss' }, 1, 0)).toBeCloseTo(Math.log(2), 12)
    expect(lossOf({ kind: 'logloss' }, 0, 0)).toBeCloseTo(Math.log(2), 12)
    expect(lossOf({ kind: 'logloss' }, 1, 40)).toBeLessThan(1e-5)
    // A sure wrong answer costs a finite amount: the chance is held inside (0, 1).
    expect(Number.isFinite(lossOf({ kind: 'logloss' }, 0, 40))).toBe(true)
  })

  it('boosts trees to a chance that beats the share, is calibrated by tenths, and is the same by its seed', () => {
    const train = rowsOf(6000, 3, 21, bernoulli)
    const valid = rowsOf(3000, 3, 22, bernoulli)
    const cuts = fitCuts(train.matrix)
    const binnedTrain = binMatrix(train.matrix, cuts)
    const binnedValid = binMatrix(valid.matrix, cuts)
    const model = fitGbt(binnedTrain, train.y, binnedValid, valid.y, { kind: 'logloss' }, GBT)
    const share = train.y.reduce((sum, value) => sum + value, 0) / train.y.length
    expect(model.loss.kind).toBe('logloss')
    expect(model.base).toBeCloseTo(logit(share), 12)
    expect(model.grown).toBeLessThan(GBT.trees)
    const chances = Array.from({ length: valid.matrix.rows }, (_, row) => sigmoid(predictGbt(model, valid.matrix.data, row * 3)))
    const truth = Array.from({ length: valid.matrix.rows }, (_, row) => chanceOf(valid.matrix.data, row * 3))
    const fitted = meanLogLoss(chances, valid.y)
    const base = meanLogLoss(chances.map(() => share), valid.y)
    const best = meanLogLoss(truth, valid.y)
    // Well under the share's loss, and within a tenth of what the true chance scores.
    expect(fitted).toBeLessThan(base - 0.1)
    expect(fitted).toBeLessThan(best + 0.05)
    expect(Math.max(...calibrationGaps(chances, valid.y))).toBeLessThan(0.1)
    // Every chance is a chance, and a row the figures favour reads higher.
    expect(chances.every((p) => p > 0 && p < 1)).toBe(true)
    expect(sigmoid(predictGbt(model, Float64Array.from([1.5, -1.5, 0])))).toBeGreaterThan(0.9)
    expect(sigmoid(predictGbt(model, Float64Array.from([-1.5, 1.5, 0])))).toBeLessThan(0.1)
    const again = fitGbt(binnedTrain, train.y, binnedValid, valid.y, { kind: 'logloss' }, GBT)
    expect(canonicalJson(again)).toBe(canonicalJson(model))
    expect(parseModel(serializeModel(model))).toEqual(JSON.parse(serializeModel(model)))
  })
})

describe('logistic regression', () => {
  const chanceOf = (x: ArrayLike<number>, at: number): number => sigmoid(1.5 * x[at] - 1.0 * x[at + 1] + 0.3)
  const bernoulli = (x: Float64Array, at: number, random: () => number): number => (random() < chanceOf(x, at) ? 1 : 0)
  /** The figures are uniform on [-2, 2]: their spread, which the standardized weights carry. */
  const SPREAD = 4 / Math.sqrt(12)

  it('recovers the line a chance was drawn from, in standardized units, and converges', () => {
    const { matrix, y } = rowsOf(8000, 3, 31, bernoulli)
    const model = fitLogistic(matrix, y, 1e-3)
    expect(model.kind).toBe('logistic')
    expect(model.iterations).toBeLessThan(LOGISTIC_FIT.iterations)
    expect(model.coef[0]).toBeCloseTo(1.5 * SPREAD, 0)
    expect(model.coef[1]).toBeCloseTo(-1.0 * SPREAD, 0)
    expect(Math.abs(model.coef[2])).toBeLessThan(0.15)
    expect(model.intercept).toBeCloseTo(0.3, 0)
    expect(predictLogistic(model, Float64Array.from([1.5, -1.5, 0]))).toBeGreaterThan(0.95)
    expect(predictLogistic(model, Float64Array.from([-1.5, 1.5, 0]))).toBeLessThan(0.05)
    expect(predictLogistic(model, Float64Array.from([0, 0, 0]))).toBeCloseTo(sigmoid(logisticLogit(model, Float64Array.from([0, 0, 0]))), 12)
  })

  it('gives a figure that does not vary no weight, reads chosen columns only, and goes to file and back', () => {
    const { matrix, y } = rowsOf(3000, 3, 32, bernoulli)
    for (let row = 0; row < matrix.rows; row++) matrix.data[row * 3 + 2] = 7
    const model = fitLogistic(matrix, y, 1)
    expect(model.scale[2]).toBe(0)
    expect(model.coef[2]).toBeCloseTo(0, 12)
    const first = fitLogistic(matrix, y, 1, [0])
    expect(first.columns).toEqual([0])
    expect(first.coef.length).toBe(1)
    expect(first.coef[0]).toBeGreaterThan(0.5)
    expect(parseModel(serializeModel(model))).toEqual(JSON.parse(serializeModel(model)))
    expect(serializeModel(fitLogistic(matrix, y, 1))).toBe(serializeModel(model))
  })

  it('is calibrated by tenths on rows it never saw, and a stronger penalty pulls its weights in', () => {
    const train = rowsOf(6000, 3, 33, bernoulli)
    const valid = rowsOf(3000, 3, 34, bernoulli)
    const model = fitLogistic(train.matrix, train.y, 1e-3)
    const chances = Array.from({ length: valid.matrix.rows }, (_, row) => predictLogistic(model, valid.matrix.data, row * 3))
    const order = chances.map((value, row) => ({ value, y: valid.y[row] })).sort((a, b) => a.value - b.value)
    for (let tenth = 0; tenth < 10; tenth++) {
      const slice = order.slice(Math.floor((tenth * order.length) / 10), Math.floor(((tenth + 1) * order.length) / 10))
      const predicted = slice.reduce((sum, entry) => sum + entry.value, 0) / slice.length
      const came = slice.reduce((sum, entry) => sum + entry.y, 0) / slice.length
      expect(Math.abs(predicted - came)).toBeLessThan(0.1)
    }
    const shrunk = fitLogistic(train.matrix, train.y, 5000)
    expect(Math.abs(shrunk.coef[0])).toBeLessThan(Math.abs(model.coef[0]))
    expect(Math.abs(shrunk.coef[1])).toBeLessThan(Math.abs(model.coef[1]))
  })
})
