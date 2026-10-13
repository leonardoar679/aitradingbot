// QUANTILES (the V6 document, §8, §14 and §26; V6 Stage 4, 13 October 2026): the five levels a
// forecast is made at, the loss a quantile is scored by, how several models' quantiles are combined,
// and the distribution read back from them.

/** P10, P25, P50, P75, P90. */
export const QUANTILE_LEVELS = [0.1, 0.25, 0.5, 0.75, 0.9] as const

/** The pinball loss of a quantile `q` at level `tau` for an outcome `y`: what a quantile is scored by,
 * and is least, on average, at the true quantile. */
export function pinball(y: number, q: number, tau: number): number {
  return y >= q ? tau * (y - q) : (1 - tau) * (q - y)
}

/** The mean pinball loss over the levels, for one outcome. */
export function meanPinball(y: number, quantiles: readonly number[], levels: readonly number[] = QUANTILE_LEVELS): number {
  let total = 0
  for (let index = 0; index < levels.length; index++) total += pinball(y, quantiles[index], levels[index])
  return total / levels.length
}

/** The `tau` quantile of values sorted ascending, by linear interpolation between order statistics. */
export function quantileOfSorted(sorted: ArrayLike<number>, tau: number): number {
  if (sorted.length === 0) return Number.NaN
  const position = tau * (sorted.length - 1)
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

/** Quantiles put in order where models crossed them (a lower level above a higher): the monotone
 * rearrangement, which for a handful of levels is a sort. */
export function rearrange(quantiles: readonly number[]): number[] {
  return [...quantiles].sort((a, b) => a - b)
}

/** Several sets of quantiles combined level by level, weighted (Vincentization): the combined
 * distribution's quantile at each level is the weighted mean of the parts' at that level. */
export function vincentize(parts: readonly { quantiles: readonly number[]; weight: number }[]): number[] {
  const levels = parts[0]?.quantiles.length ?? 0
  const out = new Array<number>(levels).fill(0)
  let total = 0
  for (const part of parts) {
    if (!(part.weight > 0)) continue
    total += part.weight
    for (let index = 0; index < levels; index++) out[index] += part.weight * part.quantiles[index]
  }
  return total > 0 ? out.map((value) => value / total) : out.map(() => Number.NaN)
}

/** P(Y <= x) from quantiles at their levels: straight between them, and beyond the outer two along
 * the slope of the segment beside them, held within 0 and 1. */
export function cdfAt(quantiles: readonly number[], levels: readonly number[], x: number): number {
  const n = quantiles.length
  const segment = (a: number): number => {
    const dq = quantiles[a + 1] - quantiles[a]
    if (!(dq > 0)) return x < quantiles[a] ? levels[a] : levels[a + 1]
    return levels[a] + ((levels[a + 1] - levels[a]) * (x - quantiles[a])) / dq
  }
  if (x <= quantiles[0]) return Math.max(0, n > 1 ? segment(0) : levels[0])
  if (x >= quantiles[n - 1]) return Math.min(1, n > 1 ? segment(n - 2) : levels[0])
  for (let a = 0; a < n - 1; a++) if (x <= quantiles[a + 1]) return segment(a)
  return levels[n - 1]
}
