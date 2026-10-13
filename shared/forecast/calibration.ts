import { halfWidth } from './ensemble'
import { QUANTILE_LEVELS, quantileOfSorted, rearrange } from './ml/quantile'

// CALIBRATION (the V6 document, §26 and §56-57; V6 Stage 6, 13 October 2026): a forecast's P10 is
// below the outcome one time in ten because it was measured to be, not because a model said so.
//
// LEVEL BY LEVEL, IN THE FORECAST'S OWN UNIT. On outcomes the models were not fitted to (the walk
// forward's record), each level's error is read in units of the forecast's own half-width -- (outcome
// - P10) / half of P10-P90 -- so that a row the models made wide is moved further than a narrow one.
// Each level is then moved by the error that fell at its level: the P10 by the error a tenth of the
// outcomes fell below, the median by the median error (which also takes out a bias), and so on
// (split conformal at each level). With at least 2,000 outcomes a cell (shared/forecast/ensemble.ts),
// the finite-sample correction -- the ceil((n+1)tau)-th of n rather than the tau-quantile -- is under
// a twentieth of a point and is left out. A cell is a horizon and a pair class (Mondrian), or the
// horizon over every class where the class has too few outcomes of its own.
//
// AND IT FOLLOWS A MARKET THAT CHANGES (adaptive conformal inference, Gibbs and Candès, 2021). Each
// level is read at a level of its own that moves with the outcomes as they come: when more than a
// tenth of the outcomes due at a moment fell below the P10, the P10 is read lower next time, and the
// other way about, so that the share below comes back to a tenth whatever the market did to the
// models. One step a moment, of the share of the pairs due at it -- not a step a pair, which on a day
// every coin fell together would move it thirty-seven times for one surprise.

export const CALIBRATION_VERSION = 'calibration-v1'

export const CALIBRATION_LINES = {
  /** The errors are kept at the levels 0.01, 0.02, ... 0.99. */
  gridLevels: 99,
  /** How far one moment's outcomes move a level, and the levels it may be read between. */
  aciGamma: 0.005,
  aciLow: 0.01,
  aciHigh: 0.99
} as const

export interface CalibrationCell {
  /** How many outcomes the cell was measured on. */
  n: number
  /** Per quantile level, the errors (in half-widths) at the grid's levels, ascending. */
  grid: number[][]
}

const GRID = Array.from({ length: CALIBRATION_LINES.gridLevels }, (_, index) => (index + 1) / (CALIBRATION_LINES.gridLevels + 1))

/** A cell from rows of quantiles and the outcomes after them, all in units of the usual move. */
export function buildCell(rows: readonly { quantiles: readonly number[]; z: number }[]): CalibrationCell {
  const usable = rows.filter((row) => Number.isFinite(row.z) && row.quantiles.every(Number.isFinite))
  const grid = QUANTILE_LEVELS.map((_, level) => {
    const errors = Float64Array.from(usable, (row) => (row.z - row.quantiles[level]) / halfWidth(row.quantiles)).sort()
    return GRID.map((tau) => quantileOfSorted(errors, tau))
  })
  return { n: usable.length, grid }
}

/** The error at level `tau` of a quantile level's errors, read off the grid. */
export function shiftAt(cell: CalibrationCell, level: number, tau: number): number {
  const values = cell.grid[level]
  if (values === undefined || values.length === 0 || !values.every(Number.isFinite)) return 0
  const position = Math.min(GRID.length - 1, Math.max(0, tau * (GRID.length + 1) - 1))
  const low = Math.floor(position)
  const high = Math.min(GRID.length - 1, low + 1)
  return values[low] + (values[high] - values[low]) * (position - low)
}

/** Quantiles calibrated by a cell: each level moved by the error at its level (or at the level the
 * adaptive step reads it at), in its own half-width, and put back in order. */
export function calibrate(quantiles: readonly number[], cell: CalibrationCell, taus: readonly number[] = QUANTILE_LEVELS): number[] {
  const scale = halfWidth(quantiles)
  return rearrange(quantiles.map((q, level) => q + scale * shiftAt(cell, level, taus[level])))
}

/** One adaptive step for a moment: each level's reading moved by the share of that moment's outcomes
 * that fell at or below its calibrated quantile, against the share that should have. */
export function aciUpdate(taus: readonly number[], shareBelow: readonly number[], gamma: number = CALIBRATION_LINES.aciGamma): number[] {
  return taus.map((tau, level) => {
    const share = shareBelow[level]
    if (!Number.isFinite(share)) return tau
    const next = tau + gamma * (QUANTILE_LEVELS[level] - share)
    return Math.min(CALIBRATION_LINES.aciHigh, Math.max(CALIBRATION_LINES.aciLow, next))
  })
}
