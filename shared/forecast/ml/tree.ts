import { MAX_BINS, type Binned } from './bins'

// ONE REGRESSION TREE, GROWN ON HISTOGRAMS (the V6 document, §13; V6 Stage 4, 13 October 2026).
//
// The tree every model here is made of: gradient boosting fits one to the gradients of its loss, a
// random forest fits one to the targets themselves. It is grown a level at a time on second-order
// statistics -- each row's gradient g and hessian h -- and a node's best split is the bin boundary
// that most raises G_L^2/(H_L+lambda) + G_R^2/(H_R+lambda) - G^2/(H+lambda), its value -G/(H+lambda).
// With g = prediction - target and h = 1 that is an ordinary least-squares tree; with lambda = 0 a
// leaf's value is the mean of its rows' targets.
//
// FAST BY TWO HABITS. A node's histogram (per figure, per bin: the sums of g, h and a count) is
// built for the smaller child alone, and the larger's is its parent's less it (the subtraction
// trick). And rows are kept in one index array, partitioned in place node by node.
//
// SEEDED. Rows and figures are sampled from a generator handed in, so a fit is the same each time.

export interface TreeParams {
  maxDepth: number
  /** Rows a leaf must hold. */
  minLeafRows: number
  /** The hessian a leaf must hold. */
  minLeafHessian: number
  /** L2 on a leaf's value. */
  lambda: number
  /** The least gain a split must bring. */
  minGain: number
  /** The share of the figures a split may consider; 1 for all. */
  featureFraction: number
  /** Sampled once for the tree, or again at every node (the random forest's way). */
  featureSampling: 'tree' | 'node'
}

export interface FlatTree {
  /** The figure a node splits on; -1 at a leaf. */
  feature: number[]
  /** Left when the figure is at or below it. */
  threshold: number[]
  /** The same split as a bin: left when the row's bin is at or below it. */
  bin: number[]
  left: number[]
  right: number[]
  /** A leaf's prediction; at an inner node, the value it would have had as a leaf (for attributions). */
  value: number[]
  /** The hessian under the node. */
  cover: number[]
  /** What the node's split gained; 0 at a leaf. */
  gain: number[]
}

/** A grown tree, and for each leaf the stretch of the row index array its rows ended in. */
export interface GrownTree {
  tree: FlatTree
  rows: Uint32Array
  leaves: { node: number; start: number; end: number }[]
}

const STATS = 3

interface Pending {
  node: number
  start: number
  end: number
  g: number
  h: number
  /** Per figure, per bin: g, h, count. */
  hist: Float64Array
}

function histogramOf(binned: Binned, g: Float64Array, h: Float64Array, rows: Uint32Array, start: number, end: number, features: Int32Array): Float64Array {
  const cols = binned.cols
  const hist = new Float64Array(cols * MAX_BINS * STATS)
  const bins = binned.bins
  for (let at = start; at < end; at++) {
    const row = rows[at]
    const base = row * cols
    const gr = g[row]
    const hr = h[row]
    for (let k = 0; k < features.length; k++) {
      const col = features[k]
      const slot = (col * MAX_BINS + bins[base + col]) * STATS
      hist[slot] += gr
      hist[slot + 1] += hr
      hist[slot + 2] += 1
    }
  }
  return hist
}

/** `count` of the figures, without repeats, in their own order. */
function sampleFeatures(cols: number, fraction: number, random: () => number): Int32Array {
  if (fraction >= 1) return Int32Array.from({ length: cols }, (_, index) => index)
  const count = Math.max(1, Math.round(cols * fraction))
  const all = Array.from({ length: cols }, (_, index) => index)
  for (let index = cols - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[all[index], all[swap]] = [all[swap], all[index]]
  }
  return Int32Array.from(all.slice(0, count).sort((a, b) => a - b))
}

const leafValue = (g: number, h: number, lambda: number): number => (h + lambda > 0 ? -g / (h + lambda) : 0)
const score = (g: number, h: number, lambda: number): number => (h + lambda > 0 ? (g * g) / (h + lambda) : 0)

/** Grows a tree on the rows `rows` (indices into the binned rows; they may repeat, for a bootstrap). */
export function growTree(binned: Binned, g: Float64Array, h: Float64Array, rowsIn: Uint32Array, params: TreeParams, random: () => number): GrownTree {
  const rows = Uint32Array.from(rowsIn)
  const tree: FlatTree = { feature: [], threshold: [], bin: [], left: [], right: [], value: [], cover: [], gain: [] }
  const addNode = (gSum: number, hSum: number): number => {
    tree.feature.push(-1)
    tree.threshold.push(0)
    tree.bin.push(0)
    tree.left.push(-1)
    tree.right.push(-1)
    tree.value.push(leafValue(gSum, hSum, params.lambda))
    tree.cover.push(hSum)
    tree.gain.push(0)
    return tree.feature.length - 1
  }
  const allFeatures = sampleFeatures(binned.cols, 1, random)
  const treeFeatures = params.featureSampling === 'tree' ? sampleFeatures(binned.cols, params.featureFraction, random) : allFeatures
  let gTotal = 0
  let hTotal = 0
  for (let at = 0; at < rows.length; at++) {
    gTotal += g[rows[at]]
    hTotal += h[rows[at]]
  }
  const root = addNode(gTotal, hTotal)
  let level: Pending[] = [{ node: root, start: 0, end: rows.length, g: gTotal, h: hTotal, hist: histogramOf(binned, g, h, rows, 0, rows.length, treeFeatures) }]
  const leaves: GrownTree['leaves'] = []
  for (let depth = 0; depth < params.maxDepth && level.length > 0; depth++) {
    const next: Pending[] = []
    for (const pending of level) {
      const considered = params.featureSampling === 'node' ? sampleFeatures(binned.cols, params.featureFraction, random) : treeFeatures
      const parentScore = score(pending.g, pending.h, params.lambda)
      let best = { gain: params.minGain, col: -1, bin: -1, gl: 0, hl: 0, cl: 0 }
      const count = pending.end - pending.start
      for (let k = 0; k < considered.length; k++) {
        const col = considered[k]
        const cuts = binned.cuts[col].length
        let gl = 0
        let hl = 0
        let cl = 0
        for (let b = 0; b < cuts; b++) {
          const slot = (col * MAX_BINS + b) * STATS
          gl += pending.hist[slot]
          hl += pending.hist[slot + 1]
          cl += pending.hist[slot + 2]
          const cr = count - cl
          const hr = pending.h - hl
          if (cl < params.minLeafRows || hl < params.minLeafHessian) continue
          if (cr < params.minLeafRows || hr < params.minLeafHessian) break
          const gain = score(gl, hl, params.lambda) + score(pending.g - gl, hr, params.lambda) - parentScore
          if (gain > best.gain) best = { gain, col, bin: b, gl, hl, cl }
        }
      }
      if (best.col < 0) {
        leaves.push({ node: pending.node, start: pending.start, end: pending.end })
        continue
      }
      // Rows at or below the bin to the front of the node's stretch.
      const cols = binned.cols
      let front = pending.start
      for (let at = pending.start; at < pending.end; at++) {
        const row = rows[at]
        if (binned.bins[row * cols + best.col] <= best.bin) {
          rows[at] = rows[front]
          rows[front] = row
          front++
        }
      }
      const left = addNode(best.gl, best.hl)
      const right = addNode(pending.g - best.gl, pending.h - best.hl)
      tree.feature[pending.node] = best.col
      tree.bin[pending.node] = best.bin
      tree.threshold[pending.node] = binned.cuts[best.col][best.bin]
      tree.left[pending.node] = left
      tree.right[pending.node] = right
      tree.gain[pending.node] = best.gain
      const leftRows = front - pending.start
      const rightRows = pending.end - front
      const smallLeft = leftRows <= rightRows
      const small = smallLeft
        ? histogramOf(binned, g, h, rows, pending.start, front, treeFeatures)
        : histogramOf(binned, g, h, rows, front, pending.end, treeFeatures)
      const large = pending.hist
      for (let index = 0; index < large.length; index++) large[index] -= small[index]
      next.push(
        { node: left, start: pending.start, end: front, g: best.gl, h: best.hl, hist: smallLeft ? small : large },
        { node: right, start: front, end: pending.end, g: pending.g - best.gl, h: pending.h - best.hl, hist: smallLeft ? large : small }
      )
    }
    level = next
  }
  for (const pending of level) leaves.push({ node: pending.node, start: pending.start, end: pending.end })
  return { tree, rows, leaves }
}

/** A tree's prediction for one row of raw figures. */
export function predictTree(tree: FlatTree, x: ArrayLike<number>, offset = 0): number {
  let node = 0
  while (tree.feature[node] >= 0) node = x[offset + tree.feature[node]] <= tree.threshold[node] ? tree.left[node] : tree.right[node]
  return tree.value[node]
}

/** A tree's prediction for one binned row: the same split, read on the bins it was found on. */
export function predictTreeBinned(tree: FlatTree, bins: Uint8Array, offset: number): number {
  let node = 0
  while (tree.feature[node] >= 0) node = bins[offset + tree.feature[node]] <= tree.bin[node] ? tree.left[node] : tree.right[node]
  return tree.value[node]
}

/** How each figure moved one row's prediction down the path it took (Saabas): the change of value at
 * each split, added to its figure. The root's value plus the contributions is the prediction. */
export function treeContributions(tree: FlatTree, x: ArrayLike<number>, out: Float64Array, offset = 0): number {
  let node = 0
  while (tree.feature[node] >= 0) {
    const child = x[offset + tree.feature[node]] <= tree.threshold[node] ? tree.left[node] : tree.right[node]
    out[tree.feature[node]] += tree.value[child] - tree.value[node]
    node = child
  }
  return tree.value[0]
}
