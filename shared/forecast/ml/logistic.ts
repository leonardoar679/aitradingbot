import type { Matrix } from './bins'
import { sigmoid } from './gbt'
import { solveSpd } from './ridge'

// LOGISTIC REGRESSION (V7.1 Stage 1, 16 October 2026): the chance of a 0-or-1 outcome as a straight
// line through standardized figures, squashed by the sigmoid, with an L2 penalty on the weights as the
// ridge has. Fitted by iteratively reweighted least squares (Newton's method on the log loss): each
// step solves (Z' W Z + lambda I) d = Z' (y - p) by the ridge's Cholesky, and stops when the step is
// small or after ITERATIONS. A column that does not vary gets no weight. The direction models' plain
// baseline: what the boosted trees must beat to be worth their trees.

export interface LogisticModel {
  kind: 'logistic'
  mean: number[]
  scale: number[]
  coef: number[]
  intercept: number
  /** The figures it reads, by index into the row; all when absent. */
  columns: number[]
  /** Newton steps taken before the fit stopped. */
  iterations: number
}

export const LOGISTIC_FIT = { iterations: 25, tolerance: 1e-6 } as const

/** Fits on the rows' `columns` (all when absent), y in {0, 1}. */
export function fitLogistic(matrix: Matrix, y: Float64Array, lambda: number, columns: number[] = Array.from({ length: matrix.cols }, (_, index) => index)): LogisticModel {
  const d = columns.length
  const n = matrix.rows
  const mean = new Array<number>(d).fill(0)
  const scale = new Array<number>(d).fill(0)
  for (let row = 0; row < n; row++) for (let k = 0; k < d; k++) mean[k] += matrix.data[row * matrix.cols + columns[k]]
  for (let k = 0; k < d; k++) mean[k] /= Math.max(1, n)
  for (let row = 0; row < n; row++) for (let k = 0; k < d; k++) scale[k] += (matrix.data[row * matrix.cols + columns[k]] - mean[k]) ** 2
  for (let k = 0; k < d; k++) scale[k] = Math.sqrt(scale[k] / Math.max(1, n))
  // Standardized rows, once: n x d.
  const z = new Float64Array(n * d)
  for (let row = 0; row < n; row++) for (let k = 0; k < d; k++) z[row * d + k] = scale[k] > 0 ? (matrix.data[row * matrix.cols + columns[k]] - mean[k]) / scale[k] : 0
  const share = y.reduce((sum, value) => sum + value, 0) / Math.max(1, n)
  // The intercept is the (d + 1)th weight, unpenalized.
  const w = new Float64Array(d + 1)
  w[d] = Math.log(Math.min(1 - 1e-6, Math.max(1e-6, share)) / (1 - Math.min(1 - 1e-6, Math.max(1e-6, share))))
  const m = d + 1
  const a = new Float64Array(m * m)
  const b = new Float64Array(m)
  let iterations = 0
  for (; iterations < LOGISTIC_FIT.iterations; iterations++) {
    a.fill(0)
    b.fill(0)
    for (let row = 0; row < n; row++) {
      let f = w[d]
      for (let k = 0; k < d; k++) f += w[k] * z[row * d + k]
      const p = sigmoid(f)
      const weight = Math.max(p * (1 - p), 1e-9)
      const residual = y[row] - p
      for (let i = 0; i < m; i++) {
        const zi = i === d ? 1 : z[row * d + i]
        b[i] += zi * residual
        for (let j = 0; j <= i; j++) a[i * m + j] += weight * zi * (j === d ? 1 : z[row * d + j])
      }
    }
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < i; j++) a[j * m + i] = a[i * m + j]
      if (i < d) {
        a[i * m + i] += lambda
        b[i] -= lambda * w[i]
      }
    }
    const step = solveSpd(a, b, m)
    let largest = 0
    for (let i = 0; i < m; i++) {
      w[i] += step[i]
      largest = Math.max(largest, Math.abs(step[i]))
    }
    if (largest < LOGISTIC_FIT.tolerance) {
      iterations++
      break
    }
  }
  return { kind: 'logistic', mean, scale, coef: Array.from(w.subarray(0, d)), intercept: w[d], columns, iterations }
}

/** The logit for one row of raw figures. */
export function logisticLogit(model: LogisticModel, x: ArrayLike<number>, offset = 0): number {
  let total = model.intercept
  for (let k = 0; k < model.columns.length; k++) {
    if (model.scale[k] > 0) total += (model.coef[k] * (x[offset + model.columns[k]] - model.mean[k])) / model.scale[k]
  }
  return total
}

/** The chance for one row of raw figures. */
export function predictLogistic(model: LogisticModel, x: ArrayLike<number>, offset = 0): number {
  return sigmoid(logisticLogit(model, x, offset))
}
