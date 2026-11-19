import { BAND_MISSES, CALIBRATION_LINES, aciBandUpdate, aciGammaFor, aciUpdate, bandCentre } from './calibration'
import { HORIZONS, type Horizon, type PairClass } from './features'
import { horizonSeconds } from './walkForward'
import { QUANTILE_LEVELS } from './ml/quantile'
import type { ForecastVariant } from './runCalibration'

// THE ADAPTIVE LEVELS, KEPT (the V6 document, §57; V6 Stage 7, 13 October 2026): for every horizon,
// variant and calibration cell, the five levels its calibrated quantiles are read at
// (shared/forecast/calibration.ts), each moved once a moment by the share of that moment's outcomes
// that fell at or below it. They belong to one walk forward's calibration: a new one starts them
// again at P10, P25, P50, P75 and P90. Since V10 Stage 1 (V10-LEAN) a cell of the band calibration keeps two readings
// instead, the misses its 50% and 80% ranges are read at, each moved by how often its range was missed, once a horizon's
// length of outcomes (calibration.ts aciGammaFor).

export type CellKey = `${Horizon}/${ForecastVariant}/${PairClass | 'pooled'}`

export interface AciTable {
  /** The walk forward whose calibration the levels move. */
  calibrationRun: string
  levels: Partial<Record<CellKey, number[]>>
  /** Unix seconds: the last moment that moved them. */
  updatedAt: number
}

export const cellKey = (horizon: Horizon, variant: ForecastVariant, cell: PairClass | 'pooled'): CellKey => `${horizon}/${variant}/${cell}`

export function emptyAciTable(calibrationRun: string): AciTable {
  return { calibrationRun, levels: {}, updatedAt: 0 }
}

/** The levels a cell is read at: where the adaptive step has moved them, or the nominal ones. */
export function levelsOf(table: AciTable | null, key: CellKey): readonly number[] {
  return table?.levels[key] ?? QUANTILE_LEVELS
}

/** The table after one moment's outcomes: each cell with outcomes moved once, by its share below
 * each level. */
export function stepAciTable(table: AciTable, outcomes: readonly { key: CellKey; below: readonly boolean[] }[], momentSec: number, gamma: number = CALIBRATION_LINES.aciGamma): AciTable {
  const band = bandCentre() !== null
  const byCell = new Map<CellKey, (readonly boolean[])[]>()
  for (const outcome of outcomes) {
    const mine = byCell.get(outcome.key)
    if (mine === undefined) byCell.set(outcome.key, [outcome.below])
    else mine.push(outcome.below)
  }
  const levels = { ...table.levels }
  for (const [key, rows] of byCell) {
    if (band) {
      // Outside the 50% range: at or under P25 or over P75; outside the 80%: at or under P10 or over P90.
      const outside = [rows.filter((below) => below[1] || !below[3]).length / rows.length, rows.filter((below) => below[0] || !below[4]).length / rows.length]
      const horizon = key.slice(0, key.indexOf('/')) as Horizon
      const held = levels[key]
      levels[key] = aciBandUpdate(held !== undefined && held.length === BAND_MISSES.length ? held : BAND_MISSES, outside, HORIZONS.includes(horizon) ? aciGammaFor(horizonSeconds(horizon), gamma) : gamma)
    } else {
      const held = levels[key]
      const share = QUANTILE_LEVELS.map((_, level) => rows.filter((below) => below[level]).length / rows.length)
      levels[key] = aciUpdate(held !== undefined && held.length === QUANTILE_LEVELS.length ? held : QUANTILE_LEVELS, share, gamma)
    }
  }
  return { calibrationRun: table.calibrationRun, levels, updatedAt: byCell.size > 0 ? momentSec : table.updatedAt }
}

/** A table read back; null for anything that is not one. */
export function parseAciTable(value: unknown): AciTable | null {
  const raw = value as Partial<AciTable> | null
  if (typeof raw !== 'object' || raw === null || typeof raw.calibrationRun !== 'string' || typeof raw.updatedAt !== 'number' || typeof raw.levels !== 'object' || raw.levels === null) return null
  const levels: AciTable['levels'] = {}
  for (const [key, entry] of Object.entries(raw.levels)) {
    if (!/^[a-z0-9]+\/v[1-4]\/[a-z-]+$/.test(key)) return null
    if (!Array.isArray(entry) || (entry.length !== QUANTILE_LEVELS.length && entry.length !== BAND_MISSES.length) || !entry.every((tau) => typeof tau === 'number' && tau >= CALIBRATION_LINES.aciLow && tau <= CALIBRATION_LINES.aciHigh)) return null
    levels[key as CellKey] = entry
  }
  return { calibrationRun: raw.calibrationRun, levels, updatedAt: raw.updatedAt }
}
