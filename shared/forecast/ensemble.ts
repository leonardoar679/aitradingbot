import { QUANTILE_LEVELS, meanPinball, vincentize } from './ml/quantile'
import { FORECAST_MODELS, type ForecastModelId } from './models'

// THE ENSEMBLE (the V6 document, §14 and §57; V6 Stage 6, 13 October 2026): the models' quantiles
// combined into one forecast, and each model's part in it kept.
//
// WHO WEIGHS, AND HOW MUCH. Only a model the walk forward promoted (shared/forecast/promotion.ts)
// weighs, and by how much its pinball loss was under persistence's on the same outcomes: a model that
// beat the floor by twice as much weighs twice as much. Where none beat it, persistence alone is the
// forecast. The losses are read per pair class where the class has enough outcomes of its own, over
// the whole horizon where it does not.
//
// HOW. Level by level (Vincentization): the forecast's P10 is the weighted mean of the models' P10s.
// That keeps the models' common shape but loses how far apart their centres are, which a mixture of
// them would show as width; it is put back -- the spread between the models' medians added to the
// interval as a mixture's variance would add it -- so that where the models disagree the range is
// wider (§57).

export const ENSEMBLE_VERSION = 'ensemble-v1'

export const ENSEMBLE_LINES = {
  /** A class's own weights and calibration from at least this many outcomes; the horizon's below it. */
  minCellRows: 2000,
  /** The least half-width of an 80% interval, in units of the usual move. */
  scaleFloor: 0.05
} as const

/** Half the width of a normal distribution's 80% interval, in standard deviations. */
const Z80 = 1.2815515655446004

export interface MemberWeight {
  model: ForecastModelId
  weight: number
}

/** Each promoted model's weight from its loss and persistence's on the same outcomes; persistence
 * alone where no promoted model beat it. Weights sum to one. */
export function weightsFromLosses(losses: Partial<Record<ForecastModelId, number>>, promoted: ReadonlySet<ForecastModelId>): MemberWeight[] {
  const floor = losses.persistence
  const out: MemberWeight[] = []
  if (floor !== undefined && Number.isFinite(floor)) {
    for (const model of FORECAST_MODELS) {
      if (model === 'persistence' || !promoted.has(model)) continue
      const loss = losses[model]
      if (loss === undefined || !Number.isFinite(loss) || loss >= floor) continue
      out.push({ model, weight: floor - loss })
    }
  }
  const total = out.reduce((sum, member) => sum + member.weight, 0)
  if (!(total > 0)) return [{ model: 'persistence', weight: 1 }]
  return out.map((member) => ({ model: member.model, weight: member.weight / total }))
}

/** Each model's mean pinball loss over outcomes, from rows of its quantiles. */
export function lossesOf(rows: readonly { quantiles: Partial<Record<ForecastModelId, readonly number[]>>; z: number }[]): Partial<Record<ForecastModelId, number>> {
  const out: Partial<Record<ForecastModelId, number>> = {}
  for (const model of FORECAST_MODELS) {
    let total = 0
    let n = 0
    for (const row of rows) {
      const q = row.quantiles[model]
      if (q === undefined || !Number.isFinite(row.z)) continue
      total += meanPinball(row.z, q)
      n++
    }
    if (n > 0) out[model] = total / n
  }
  return out
}

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P50 = QUANTILE_LEVELS.indexOf(0.5)
const P90 = QUANTILE_LEVELS.indexOf(0.9)

/** Half the width of P10-P90, held above the floor: the unit a forecast's errors are measured in. */
export function halfWidth(quantiles: readonly number[]): number {
  return Math.max(ENSEMBLE_LINES.scaleFloor, (quantiles[P90] - quantiles[P10]) / 2)
}

/** The standard deviation a normal distribution with these quantiles' 80% range would have. */
export function sigmaOf(quantiles: readonly number[]): number {
  return halfWidth(quantiles) / Z80
}

/** Quantiles widened about their median as a spread `extra` (one standard deviation, in their units)
 * added to them would widen a distribution: its variance added to theirs. */
export function widenAround(quantiles: readonly number[], extra: number): number[] {
  if (!(extra > 0)) return [...quantiles]
  const sigma = halfWidth(quantiles) / Z80
  const stretch = Math.sqrt(1 + (extra / sigma) ** 2)
  return quantiles.map((q) => quantiles[P50] + (q - quantiles[P50]) * stretch)
}

export interface Combined {
  /** The five quantiles, in units of the usual move. */
  quantiles: number[]
  /** The weighted spread of the models' medians, in the same units. */
  disagreement: number
  /** What each weighing model brought: its weight and its median. */
  members: { model: ForecastModelId; weight: number; median: number }[]
}

/** The models' quantiles for one row combined by their weights, the spread between their centres
 * put back. */
export function combine(quantiles: Partial<Record<ForecastModelId, readonly number[]>>, weights: readonly MemberWeight[]): Combined {
  const parts = weights.filter((member) => member.weight > 0 && quantiles[member.model] !== undefined)
  const total = parts.reduce((sum, member) => sum + member.weight, 0)
  const members = parts.map((member) => ({ model: member.model, weight: member.weight / total, median: quantiles[member.model]![P50] }))
  const level = vincentize(parts.map((member) => ({ quantiles: quantiles[member.model]!, weight: member.weight })))
  const center = members.reduce((sum, member) => sum + member.weight * member.median, 0)
  const disagreement = Math.sqrt(members.reduce((sum, member) => sum + member.weight * (member.median - center) ** 2, 0))
  // A mixture's variance is the parts' variance and the variance of their centres together.
  return { quantiles: widenAround(level, disagreement), disagreement, members }
}
