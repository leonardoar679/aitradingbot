import { CALIBRATION_LINES, type CalibrationCell } from './calibration'
import type { MemberWeight } from './ensemble'
import { HORIZONS, PAIR_CLASSES, type Horizon, type PairClass } from './features'
import type { IsotonicModel } from './ml/isotonic'
import { QUANTILE_LEVELS } from './ml/quantile'
import { canonicalJson } from './ml/serialize'
import { FORECAST_MODELS, type ForecastModelId } from './models'
import { RUN_CALIBRATION_VERSION, VARIANTS, type CurveBin, type HonestScore, type HorizonCalibration, type RunCalibration, type VariantCalibration } from './runCalibration'

// A RUN'S CALIBRATION ON FILE (V6 Stage 6, 13 October 2026): forecastModels/<run>/calibration.json,
// one line of canonical JSON, every number at seven significant digits and a figure that could not be
// measured (a direction over no moves) written as null. Read back it is checked shape by shape --
// every weight a model's, every cell five levels of ninety-nine errors -- and refused whole otherwise,
// so that the live forecast never runs on half a calibration.

export const CALIBRATION_FILE_VERSION = 'forecast-calibration-file-v1'

function rounded(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : Number(value.toPrecision(7))) : null
  if (Array.isArray(value)) return value.map(rounded)
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rounded(entry)]))
  return value
}

export function serializeRunCalibration(calibration: RunCalibration): string {
  return canonicalJson({ file: CALIBRATION_FILE_VERSION, ...(rounded(calibration) as object) })
}

type Raw = Record<string, unknown>
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const finiteList = (value: unknown, length?: number): value is number[] => Array.isArray(value) && value.every(finite) && (length === undefined || value.length === length)
/** A figure that may not have been measured: null read as NaN. */
const measured = (value: unknown): number | undefined => (value === null ? Number.NaN : finite(value) ? value : undefined)

function readWeights(value: unknown): MemberWeight[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: MemberWeight[] = []
  for (const entry of value) {
    if (!isObject(entry) || !(FORECAST_MODELS as readonly string[]).includes(entry.model as string) || !finite(entry.weight) || entry.weight < 0) return null
    out.push({ model: entry.model as ForecastModelId, weight: entry.weight })
  }
  return out
}

function readCell(value: unknown): CalibrationCell | null {
  if (!isObject(value) || !finite(value.n) || !Array.isArray(value.grid) || value.grid.length !== QUANTILE_LEVELS.length) return null
  if (!value.grid.every((level) => finiteList(level, CALIBRATION_LINES.gridLevels))) return null
  return { n: value.n, grid: value.grid as number[][] }
}

function readIsotonic(value: unknown): IsotonicModel | null {
  if (!isObject(value) || !finiteList(value.x) || !finiteList(value.y, value.x.length) || !finiteList(value.n, value.x.length)) return null
  return { x: value.x, y: value.y as number[], n: value.n as number[] }
}

function readScore(value: unknown): HonestScore | null | undefined {
  if (value === null) return null
  if (!isObject(value) || !Array.isArray(value.curve)) return undefined
  const keys = ['n', 'nDirection', 'coverage80', 'coverage50', 'pinball', 'persistencePinball', 'skill', 'brier', 'directionSkill', 'upShare', 'direction'] as const
  const figures: Partial<Record<(typeof keys)[number], number>> = {}
  for (const key of keys) {
    const figure = measured(value[key])
    if (figure === undefined) return undefined
    figures[key] = figure
  }
  const curve: CurveBin[] = []
  for (const bin of value.curve) {
    if (!isObject(bin) || !finite(bin.predicted) || !finite(bin.observed) || !finite(bin.n)) return undefined
    curve.push({ predicted: bin.predicted, observed: bin.observed, n: bin.n })
  }
  return { ...(figures as Record<(typeof keys)[number], number>), curve }
}

/** A map by pair class, every value read by `read`; null when any key or value is not one. */
function byClass<T>(value: unknown, read: (entry: unknown) => T | null | undefined): Partial<Record<PairClass, T>> | null {
  if (!isObject(value)) return null
  const out: Partial<Record<PairClass, T>> = {}
  for (const [key, entry] of Object.entries(value)) {
    const read1 = read(entry)
    if (!(PAIR_CLASSES as readonly string[]).includes(key) || read1 === null || read1 === undefined) return null
    out[key as PairClass] = read1
  }
  return out
}

function readVariant(value: unknown): VariantCalibration | null {
  if (!isObject(value) || !isObject(value.weights) || !isObject(value.cells) || !isObject(value.usualWidth80Pct) || !isObject(value.honest)) return null
  const pooledWeights = readWeights(value.weights.pooled)
  const weightsByClass = byClass(value.weights.byClass, readWeights)
  const pooledCell = readCell(value.cells.pooled)
  const cellsByClass = byClass(value.cells.byClass, readCell)
  const pUp = readIsotonic(value.pUp)
  const pooledWidth = measured(value.usualWidth80Pct.pooled)
  const widthByClass = byClass(value.usualWidth80Pct.byClass, (entry) => measured(entry))
  const pooledScore = readScore(value.honest.pooled)
  const scoresByClass = byClass(value.honest.byClass, readScore)
  const weeks = value.honest.weeks
  if (pooledWeights === null || weightsByClass === null || pooledCell === null || cellsByClass === null || pUp === null) return null
  if (pooledWidth === undefined || widthByClass === null || pooledScore === undefined || scoresByClass === null || !finiteList(weeks)) return null
  return {
    weights: { pooled: pooledWeights, byClass: weightsByClass },
    cells: { pooled: pooledCell, byClass: cellsByClass },
    pUp,
    usualWidth80Pct: { pooled: pooledWidth, byClass: widthByClass },
    honest: { pooled: pooledScore, byClass: scoresByClass as Partial<Record<PairClass, HonestScore>>, weeks }
  }
}

/** A run's calibration read back; null for a file that is not one, from another version, or damaged
 * anywhere. */
export function parseRunCalibration(text: string): RunCalibration | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw.file !== CALIBRATION_FILE_VERSION || raw.version !== RUN_CALIBRATION_VERSION || typeof raw.runId !== 'string' || !isObject(raw.horizons)) return null
  const horizons: Partial<Record<Horizon, HorizonCalibration>> = {}
  for (const [key, entry] of Object.entries(raw.horizons)) {
    if (!HORIZONS.includes(key as Horizon) || !isObject(entry) || entry.horizon !== key || !finite(entry.rows) || !isObject(entry.variants)) return null
    const variants = {} as HorizonCalibration['variants']
    for (const variant of VARIANTS) {
      const read = readVariant(entry.variants[variant])
      if (read === null) return null
      variants[variant] = read
    }
    horizons[key as Horizon] = { horizon: key as Horizon, rows: entry.rows, variants }
  }
  return { version: RUN_CALIBRATION_VERSION, runId: raw.runId, horizons }
}
