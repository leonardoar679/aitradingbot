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

// SINCE V10 STAGE 1 (19 November 2026; V10-LEAN held): THE CENTRE STAYS AT NO MOVE. The forecast's ranges are the band
// calibration's below (centre 'zero'), symmetric about no move, their adaptive step reading only how often each range is
// missed, once a horizon's length of outcomes; the level calibration above is kept for the lines' 'level' and for a
// calibration fitted before. A way away from no move comes only from a source whose own test passed.
export const CALIBRATION_VERSION = 'calibration-v2'

export const CALIBRATION_LINES = {
  /** Where the shown ranges are centred (V10-LEAN): at no move; 'level' was V6 to V9's per-level calibration. */
  centre: 'zero' as CalibrationCentre,
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

/** The value at level `tau` of values kept at the grid's levels; 0 where there are none. */
function gridAt(values: readonly number[] | undefined, tau: number): number {
  if (values === undefined || values.length === 0 || !values.every(Number.isFinite)) return 0
  const position = Math.min(GRID.length - 1, Math.max(0, tau * (GRID.length + 1) - 1))
  const low = Math.floor(position)
  const high = Math.min(GRID.length - 1, low + 1)
  return values[low] + (values[high] - values[low]) * (position - low)
}

/** The error at level `tau` of a quantile level's errors, read off the grid. */
export function shiftAt(cell: CalibrationCell, level: number, tau: number): number {
  return gridAt(cell.grid[level], tau)
}

// A CALIBRATION THAT DOES NOT MOVE THE CENTRE (V10 Stage 1, 19 November 2026; registered as V10-LEAN). Moving the
// median by the test weeks' median error, and stepping every level once a quarter hour at every horizon, made the
// forecast lean: in the seven-day run of 9-16 November every coin's 24-hour median sat below no move all week, -1.79%
// where the models' own centre was +0.04%, a way nobody measured -- right while Bitcoin fell 14%, wrong on the day it
// rose. A BAND calibration keeps the centre where it is told -- at no move ('zero') or the models' own middle
// ('models') -- and fits only the ranges' widths: the sizes of the errors around that centre, in the forecast's own
// half-width, at the 50% and 80% ranges. Its adaptive step reads how often each range is missed, by a step scaled to
// the horizon (once a horizon's length of outcomes). Measured first; the forecast keeps 'level' until V10-LEAN says
// otherwise.

export type CalibrationCentre = 'level' | 'zero' | 'models'
export type BandCentre = Exclude<CalibrationCentre, 'level'>

/** The sizes of the errors around a centre, in half-widths, at the grid's levels, ascending. */
export interface BandCell {
  n: number
  grid: number[]
}

/** The two ranges a band calibration reads, by their nominal miss: the 50% range's and the 80% range's. */
export const BAND_MISSES = [0.5, 0.2] as const

/** Where a band calibration centres a forecast: at no move, or at its models' own middle. */
export const bandCentreOf = (quantiles: readonly number[], centre: BandCentre): number => (centre === 'zero' ? 0 : quantiles[2])

/** A band cell from rows of quantiles and the outcomes after them, all in units of the usual move. */
export function buildBandCell(rows: readonly { quantiles: readonly number[]; z: number }[], centre: BandCentre): BandCell {
  const usable = rows.filter((row) => Number.isFinite(row.z) && row.quantiles.every(Number.isFinite) && halfWidth(row.quantiles) > 0)
  const sizes = Float64Array.from(usable, (row) => Math.abs(row.z - bandCentreOf(row.quantiles, centre)) / halfWidth(row.quantiles)).sort()
  return { n: usable.length, grid: GRID.map((tau) => quantileOfSorted(sizes, tau)) }
}

/** Quantiles by a band cell: the centre, and each range's half the size within which its share of the errors fell
 * (one less its miss, or the miss the adaptive step reads it at), in the forecast's own half-width -- symmetric about
 * the centre. */
export function calibrateBand(quantiles: readonly number[], cell: BandCell, centre: BandCentre, misses: readonly number[] = BAND_MISSES): number[] {
  const scale = halfWidth(quantiles)
  const middle = bandCentreOf(quantiles, centre)
  const inner = scale * gridAt(cell.grid, 1 - misses[0])
  const outer = scale * gridAt(cell.grid, 1 - misses[1])
  return rearrange([middle - outer, middle - inner, middle, middle + inner, middle + outer])
}

/** One adaptive step of a band calibration (Gibbs and Candès's step on the miss): each range's miss moved by its
 * nominal miss less the share of a moment's outcomes that fell outside it. */
export function aciBandUpdate(misses: readonly number[], outside: readonly number[], gamma: number): number[] {
  return misses.map((miss, range) => {
    const share = outside[range]
    if (!Number.isFinite(share)) return miss
    const next = miss + gamma * (BAND_MISSES[range] - share)
    return Math.min(CALIBRATION_LINES.aciHigh, Math.max(CALIBRATION_LINES.aciLow, next))
  })
}

/** The adaptive step a moment at a horizon: the step once a horizon's length of outcomes -- the whole step at a quarter
 * hour and under, a 96th of it at a day, whose outcomes due at each quarter hour all but repeat one another. */
export function aciGammaFor(horizonSec: number, gamma: number = CALIBRATION_LINES.aciGamma, momentSec = 900): number {
  return gamma * Math.min(1, momentSec / horizonSec)
}

/** Whether the lines calibrate by the band (V10-LEAN), with the band's centre. */
export const bandCentre = (): BandCentre | null => (CALIBRATION_LINES.centre === 'level' ? null : CALIBRATION_LINES.centre)

/** A forecast's shown levels: by the band about the lines' centre where the lines say so and the calibration has a band
 * cell, else each level by its own error. `reading` is where the adaptive step reads them: the band's two misses, or the
 * five levels; a reading of the other kind (one kept before a change of the lines) is left for the nominal one. */
export function calibrateShown(quantiles: readonly number[], cell: CalibrationCell, band: BandCell | undefined, reading?: readonly number[]): number[] {
  const centre = bandCentre()
  if (centre !== null && band !== undefined) return calibrateBand(quantiles, band, centre, reading !== undefined && reading.length === BAND_MISSES.length ? reading : BAND_MISSES)
  return calibrate(quantiles, cell, reading !== undefined && reading.length === QUANTILE_LEVELS.length ? reading : QUANTILE_LEVELS)
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
