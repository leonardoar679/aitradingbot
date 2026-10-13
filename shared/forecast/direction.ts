import { fitIsotonic, predictIsotonic, type IsotonicModel } from './ml/isotonic'
import { QUANTILE_LEVELS, cdfAt } from './ml/quantile'

// WHICH WAY, AND HOW SURE (the V6 document, §25, §30 and §59-61; V6 Stage 6, 13 October 2026).
//
// P(UP) is read off the calibrated forecast -- the share of its distribution above zero -- and then
// made to mean what it says: isotonic regression maps each raw reading to the share of such forecasts
// that did go up (§59), fitted on readings made out of sample (each week's with the calibration of the
// weeks before it), every step of the map holding at least 200 outcomes. It is never a model's say-so.
//
// Measured on the real walk forward (13 October 2026) a map fitted on the very forecasts it maps did
// not survive a week: at 24 hours the forecasts read 67% for 7,524 outcomes of which 49% went up --
// a month's drift learned as direction. So a horizon's P(up) also has to have beaten what knows
// nothing -- an even chance, and the share that went up in the weeks before, whichever scored better --
// on weeks it was not fitted on, by at least 1% of its Brier score, its DIRECTION SKILL, before it may
// call a way at all. That 1% was set after the first real walk forward, which put every cell between
// -1.9% and +0.7%: with two weeks of a class's outcomes a skill under it is within the noise.
//
// THE CALL, by fixed lines set before any result was seen:
// - BULLISH: P(up) at least 58%, the median above zero, and a direction skill of at least 1%;
//   BEARISH mirrored;
// - STRONG (§60): P(up) at least 65% (35% for a bear), a median of at least 1% either way -- four
//   times the 0.24% a round trip costs --, a prediction quality of at least 75 (V6 Stage 9; none is a
//   STRONG for no one), and the risk acceptable: the bad case (P10 for a bull, P90 for a bear) no
//   further from zero than the median;
// - UNCERTAIN (§30, §61): an 80% range more than three times as wide as the pair class's usual one at
//   the horizon -- the models do not know enough, whatever the median says; it is NEUTRAL, marked so;
// - NEUTRAL otherwise.

export const DIRECTION_LINES = {
  bullish: 0.58,
  strong: 0.65,
  strongMedianPct: 1,
  strongQuality: 75,
  uncertainWidth: 3,
  minDirectionSkill: 0.01,
  /** The fewest outcomes a step of the P(up) map holds. */
  pUpMinBlock: 200
} as const

export type Direction = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

/** The share of a forecast's distribution (quantiles of the move) above zero. */
export function rawPUp(quantiles: readonly number[]): number {
  return 1 - cdfAt(quantiles, QUANTILE_LEVELS, 0)
}

/** The map from raw P(up) to the share that did go up, fitted on outcomes, each step holding at
 * least DIRECTION_LINES.pUpMinBlock of them. */
export function fitPUp(points: readonly { raw: number; up: boolean }[]): IsotonicModel {
  return mergeSmallSteps(fitIsotonic(points.map((point) => ({ x: point.raw, y: point.up ? 1 : 0 }))), DIRECTION_LINES.pUpMinBlock)
}

/** A step line whose steps under `least` outcomes are joined to the neighbour nearest their rate,
 * the smallest first, until none is left under it or one step is: still non-decreasing, as two
 * neighbouring steps of a non-decreasing line joined lie between their neighbours. */
export function mergeSmallSteps(model: IsotonicModel, least: number): IsotonicModel {
  const steps = model.x.map((x, index) => ({ sx: x * model.n[index], sy: model.y[index] * model.n[index], n: model.n[index] }))
  const rate = (index: number): number => steps[index].sy / steps[index].n
  while (steps.length > 1) {
    let smallest = 0
    for (let index = 1; index < steps.length; index++) if (steps[index].n < steps[smallest].n) smallest = index
    if (steps[smallest].n >= least) break
    const last = steps.length - 1
    const other =
      smallest === 0 ? 1 : smallest === last ? last - 1 : Math.abs(rate(smallest - 1) - rate(smallest)) <= Math.abs(rate(smallest + 1) - rate(smallest)) ? smallest - 1 : smallest + 1
    const [a, b] = other < smallest ? [other, smallest] : [smallest, other]
    steps.splice(a, 2, { sx: steps[a].sx + steps[b].sx, sy: steps[a].sy + steps[b].sy, n: steps[a].n + steps[b].n })
  }
  return { x: steps.map((step) => step.sx / step.n), y: steps.map((step) => step.sy / step.n), n: steps.map((step) => step.n) }
}

/** A raw P(up) made to mean what it says; the raw one where nothing was fitted. */
export function calibratedPUp(model: IsotonicModel, raw: number): number {
  const value = predictIsotonic(model, raw)
  return Number.isFinite(value) ? value : raw
}

export interface CallInput {
  pUp: number
  /** The calibrated median, P10 and P90 of the move, in percent. */
  medianPct: number
  p10Pct: number
  p90Pct: number
  /** The width of P10-P90 in percent, and the pair class's usual width at the horizon. */
  width80Pct: number
  usualWidth80Pct: number
  /** The prediction quality (V6 Stage 9), or null before there is one. */
  quality: number | null
  /** How much P(up) beat the base rate on weeks it was not fitted on (a Brier skill score); null
   * where it could not be measured. */
  directionSkill: number | null
}

export interface Call {
  direction: Direction
  strong: boolean
  uncertain: boolean
}

export function classify(input: CallInput): Call {
  const uncertain = input.usualWidth80Pct > 0 && input.width80Pct > DIRECTION_LINES.uncertainWidth * input.usualWidth80Pct
  if (uncertain) return { direction: 'NEUTRAL', strong: false, uncertain }
  if (input.directionSkill === null || !(input.directionSkill >= DIRECTION_LINES.minDirectionSkill)) return { direction: 'NEUTRAL', strong: false, uncertain }
  const sure = input.quality !== null && input.quality >= DIRECTION_LINES.strongQuality
  if (input.pUp >= DIRECTION_LINES.bullish && input.medianPct > 0) {
    const strong = sure && input.pUp >= DIRECTION_LINES.strong && input.medianPct >= DIRECTION_LINES.strongMedianPct && input.p10Pct >= -input.medianPct
    return { direction: 'BULLISH', strong, uncertain }
  }
  if (input.pUp <= 1 - DIRECTION_LINES.bullish && input.medianPct < 0) {
    const strong = sure && input.pUp <= 1 - DIRECTION_LINES.strong && input.medianPct <= -DIRECTION_LINES.strongMedianPct && input.p90Pct <= -input.medianPct
    return { direction: 'BEARISH', strong, uncertain }
  }
  return { direction: 'NEUTRAL', strong: false, uncertain }
}

/** How sure the call is: the calibrated chance of the way it calls, in percent; for NEUTRAL, of the
 * way it leans. */
export function confidenceOf(pUp: number, direction: Direction): number {
  const p = direction === 'BULLISH' ? pUp : direction === 'BEARISH' ? 1 - pUp : Math.max(pUp, 1 - pUp)
  return Math.round(100 * p)
}
