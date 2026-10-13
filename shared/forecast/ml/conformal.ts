// CONFORMAL CALIBRATION (the V6 document, §26, §56-57; V6 Stage 4, 13 October 2026).
//
// An interval a model says holds 80% of outcomes is measured on outcomes it was not fitted to: each
// one's conformity score is how far outside the interval it fell (negative inside it). Widening the
// interval at both ends by the ceil((n+1)(1-alpha))-th smallest of n such scores makes it hold at
// least 1 - alpha of outcomes like them (split conformal; conformalized quantile regression when the
// interval's ends are quantile models' -- Romano, Patterson and Candès, 2019). A negative adjustment
// narrows an interval that was too wide.
//
// AND IT FOLLOWS A MARKET THAT CHANGES. Adaptive conformal inference (Gibbs and Candès, 2021) moves the
// miscoverage the adjustment is read at after every outcome: up by gamma * alpha when the outcome fell
// inside, down by gamma * (1 - alpha) when it fell outside, so that over time the share outside comes
// back to alpha whatever the market did to the models.

/** How far outside [lo, hi] an outcome fell; negative when inside. */
export function conformityScore(lo: number, hi: number, y: number): number {
  return Math.max(lo - y, y - hi)
}

/** The widening for miscoverage `alpha` from the scores of outcomes held out: the
 * ceil((n+1)(1-alpha))-th smallest. Null when there are too few for it (k beyond n). */
export function conformalAdjustment(scores: readonly number[], alpha: number): number | null {
  const n = scores.length
  if (n === 0) return null
  const k = Math.ceil((n + 1) * (1 - alpha))
  if (k > n) return null
  const sorted = [...scores].sort((a, b) => a - b)
  return sorted[Math.max(0, k - 1)]
}

/** One step of adaptive conformal inference: the miscoverage to read the next adjustment at, after an
 * outcome that fell outside (`missed`) or inside, held within (0, 1). */
export function aciStep(alphaNow: number, alphaTarget: number, missed: boolean, gamma: number): number {
  const next = alphaNow + gamma * (alphaTarget - (missed ? 1 : 0))
  return Math.min(0.999, Math.max(0.001, next))
}
