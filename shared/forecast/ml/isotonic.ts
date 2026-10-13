// ISOTONIC REGRESSION (the V6 document, §59; V6 Stage 4, 13 October 2026): a probability the models
// read off their quantiles, made to mean what it says. Given what each forecast's raw P(up) was and
// whether the price did go up, pool-adjacent-violators finds the non-decreasing step line closest to
// the outcomes; a new raw P(up) is read off it. So "65%" is shown only where 65% of such forecasts went
// up -- never a model's own say-so.

export interface IsotonicModel {
  /** Each block's mean raw value, ascending. */
  x: number[]
  /** Each block's outcome rate, non-decreasing. */
  y: number[]
  /** How many outcomes each block holds. */
  n: number[]
}

/** Fits the step line to (raw value, outcome) pairs, the outcome 1 or 0, each weighing one. */
export function fitIsotonic(points: readonly { x: number; y: number }[]): IsotonicModel {
  const sorted = [...points].filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).sort((a, b) => a.x - b.x)
  const blocks: { sx: number; sy: number; n: number }[] = []
  for (const point of sorted) {
    blocks.push({ sx: point.x, sy: point.y, n: 1 })
    // Pool backwards while a block's rate is under the one before it.
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]
      const before = blocks[blocks.length - 2]
      if (before.sy / before.n <= last.sy / last.n) break
      blocks.splice(blocks.length - 2, 2, { sx: before.sx + last.sx, sy: before.sy + last.sy, n: before.n + last.n })
    }
  }
  return { x: blocks.map((block) => block.sx / block.n), y: blocks.map((block) => block.sy / block.n), n: blocks.map((block) => block.n) }
}

/** The calibrated value at a raw one: straight between the blocks' centres, flat beyond the ends.
 * NaN from a model fitted to nothing. */
export function predictIsotonic(model: IsotonicModel, x: number): number {
  const count = model.x.length
  if (count === 0) return Number.NaN
  if (x <= model.x[0]) return model.y[0]
  if (x >= model.x[count - 1]) return model.y[count - 1]
  let low = 0
  let high = count - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (model.x[middle] <= x) low = middle
    else high = middle
  }
  const span = model.x[high] - model.x[low]
  return span > 0 ? model.y[low] + ((model.y[high] - model.y[low]) * (x - model.x[low])) / span : model.y[high]
}
