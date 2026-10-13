// FIGURES TO BINS (the V6 document, §13; V6 Stage 4, 13 October 2026). A tree here splits a figure
// at one of at most MAX_BINS - 1 cut points, read from the figure's own spread in the training rows:
// histograms of a few dozen bins are what make a tree on hundreds of thousands of rows a matter of
// seconds rather than hours, at a cost in precision no forecast notices.
//
// A row's bin for a figure is the first cut point at or above its value, or one past the last: so
// "bin <= b" is "value <= cuts[b]", and a split found on bins is the same split on the raw figure.

export const MAX_BINS = 64

/** Rows held as one flat array, row by row. */
export interface Matrix {
  rows: number
  cols: number
  /** rows x cols, row-major. */
  data: Float64Array
}

export interface Binned {
  rows: number
  cols: number
  /** rows x cols bin indices, row-major. */
  bins: Uint8Array
  /** Each figure's cut points, ascending. */
  cuts: Float64Array[]
}

/** A seeded generator (xorshift32), so that a fit is the same every time it is run on the same rows. */
export function rngOf(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

/** Each figure's cut points: the quantiles of its values over (a sample of) the rows, each once. */
export function fitCuts(matrix: Matrix, maxBins: number = MAX_BINS, sampleRows = 100_000, seed = 1): Float64Array[] {
  const random = rngOf(seed)
  const take = Math.min(matrix.rows, sampleRows)
  const picked = new Uint32Array(take)
  if (take === matrix.rows) for (let index = 0; index < take; index++) picked[index] = index
  else for (let index = 0; index < take; index++) picked[index] = Math.floor(random() * matrix.rows)
  const cuts: Float64Array[] = []
  const column = new Float64Array(take)
  for (let col = 0; col < matrix.cols; col++) {
    for (let index = 0; index < take; index++) column[index] = matrix.data[picked[index] * matrix.cols + col]
    const sorted = Float64Array.from(column).sort()
    const out: number[] = []
    for (let k = 1; k < maxBins; k++) {
      const value = sorted[Math.min(take - 1, Math.floor((k * take) / maxBins))]
      if (out.length === 0 || value > out[out.length - 1]) out.push(value)
    }
    // The largest value is not a cut: nothing would be on its right.
    while (out.length > 0 && out[out.length - 1] >= sorted[take - 1]) out.pop()
    cuts.push(Float64Array.from(out))
  }
  return cuts
}

/** A value's bin: the first cut at or above it, or one past the last cut. */
export function binOf(cuts: Float64Array, value: number): number {
  let low = 0
  let high = cuts.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (cuts[middle] < value) low = middle + 1
    else high = middle
  }
  return low
}

/** Every row's bins, by the cut points given (the training rows' own, for the rows a model is checked on). */
export function binMatrix(matrix: Matrix, cuts: Float64Array[]): Binned {
  const bins = new Uint8Array(matrix.rows * matrix.cols)
  for (let row = 0; row < matrix.rows; row++) {
    const base = row * matrix.cols
    for (let col = 0; col < matrix.cols; col++) bins[base + col] = binOf(cuts[col], matrix.data[base + col])
  }
  return { rows: matrix.rows, cols: matrix.cols, bins, cuts }
}
