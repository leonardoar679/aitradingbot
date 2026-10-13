import type { Matrix } from './bins'

// RIDGE REGRESSION (the V6 document, §13's technical model and the volatility model's HAR-style fit;
// V6 Stage 4, 13 October 2026): a straight line through standardized figures, with an L2 penalty that
// keeps the weights of figures that say the same thing small. Closed form, solved by a Cholesky
// factorization of (Z'Z + lambda I): sixty-odd figures make it instant.

export interface RidgeModel {
  kind: 'ridge'
  mean: number[]
  scale: number[]
  coef: number[]
  intercept: number
  /** The figures it reads, by index into the row; all when absent. */
  columns: number[]
}

/** Solves A x = b for a symmetric positive-definite A (n x n, row-major), in place of nothing. */
export function solveSpd(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const l = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j]
      for (let k = 0; k < j; k++) sum -= l[i * n + k] * l[j * n + k]
      if (i === j) {
        if (!(sum > 0)) throw new Error('the system is not positive definite')
        l[i * n + i] = Math.sqrt(sum)
      } else l[i * n + j] = sum / l[j * n + j]
    }
  }
  const z = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = b[i]
    for (let k = 0; k < i; k++) sum -= l[i * n + k] * z[k]
    z[i] = sum / l[i * n + i]
  }
  const x = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) {
    let sum = z[i]
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * x[k]
    x[i] = sum / l[i * n + i]
  }
  return x
}

/** Fits on the rows' `columns` (all when absent). A column that does not vary gets no weight. */
export function fitRidge(matrix: Matrix, y: Float64Array, lambda: number, columns: number[] = Array.from({ length: matrix.cols }, (_, index) => index)): RidgeModel {
  const d = columns.length
  const n = matrix.rows
  const mean = new Array<number>(d).fill(0)
  const scale = new Array<number>(d).fill(0)
  for (let row = 0; row < n; row++) for (let k = 0; k < d; k++) mean[k] += matrix.data[row * matrix.cols + columns[k]]
  for (let k = 0; k < d; k++) mean[k] /= Math.max(1, n)
  for (let row = 0; row < n; row++) for (let k = 0; k < d; k++) scale[k] += (matrix.data[row * matrix.cols + columns[k]] - mean[k]) ** 2
  for (let k = 0; k < d; k++) scale[k] = Math.sqrt(scale[k] / Math.max(1, n))
  const yMean = y.reduce((sum, value) => sum + value, 0) / Math.max(1, n)
  const a = new Float64Array(d * d)
  const b = new Float64Array(d)
  const z = new Float64Array(d)
  for (let row = 0; row < n; row++) {
    for (let k = 0; k < d; k++) z[k] = scale[k] > 0 ? (matrix.data[row * matrix.cols + columns[k]] - mean[k]) / scale[k] : 0
    const target = y[row] - yMean
    for (let i = 0; i < d; i++) {
      b[i] += z[i] * target
      for (let j = 0; j <= i; j++) a[i * d + j] += z[i] * z[j]
    }
  }
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < i; j++) a[j * d + i] = a[i * d + j]
    a[i * d + i] += lambda
  }
  const coef = Array.from(solveSpd(a, b, d))
  return { kind: 'ridge', mean, scale, coef, intercept: yMean, columns }
}

export function predictRidge(model: RidgeModel, x: ArrayLike<number>, offset = 0): number {
  let total = model.intercept
  for (let k = 0; k < model.columns.length; k++) {
    if (model.scale[k] > 0) total += (model.coef[k] * (x[offset + model.columns[k]] - model.mean[k])) / model.scale[k]
  }
  return total
}

/** What each figure added to one row's prediction (exact for a line): the intercept plus these is it. */
export function ridgeContributions(model: RidgeModel, x: ArrayLike<number>, features: number, offset = 0): Float64Array {
  const out = new Float64Array(features)
  for (let k = 0; k < model.columns.length; k++) {
    if (model.scale[k] > 0) out[model.columns[k]] = (model.coef[k] * (x[offset + model.columns[k]] - model.mean[k])) / model.scale[k]
  }
  return out
}
