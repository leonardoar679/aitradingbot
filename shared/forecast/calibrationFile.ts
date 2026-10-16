import { CALIBRATION_LINES, type CalibrationCell } from './calibration'
import type { MemberWeight } from './ensemble'
import { HORIZONS, PAIR_CLASSES, type Horizon, type PairClass } from './features'
import type { IsotonicModel } from './ml/isotonic'
import { QUANTILE_LEVELS } from './ml/quantile'
import { canonicalJson } from './ml/serialize'
import { FIRST_TOUCH, TOUCH_WINDOWS, type ExcursionCalibration, type FirstTouchTable, type TouchCurve } from './firstTouch'
import { DIRECTION_MODELS, EXCURSION_LEVELS, FORECAST_MODELS, type DirectionModelId, type ForecastModelId } from './models'
import type { CheckLine } from './promotion'
import { MARKET_REGIMES } from './features'
import type { MarketRegime } from '../marketResearch'
import { RUN_CALIBRATION_VERSION, VARIANTS, type CurveBin, type DirectionCalibration, type DirectionReport, type DirectionScore, type HonestScore, type HorizonCalibration, type RunCalibration, type VariantCalibration } from './runCalibration'
import type { ShockRefusal, ShockRule, ShockScore } from './shock'
import { MARKET_SHOCK_STATES, type MarketShockRules, type MarketShockState, type ShockWidening } from './marketShock'

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

const SHOCK_REFUSALS: readonly ShockRefusal[] = ['no_record', 'too_few', 'coverage', 'pinball']

function readShockScore(value: unknown): ShockScore | null | undefined {
  if (value === null) return null
  if (!isObject(value) || !finite(value.in80) || !finite(value.in50) || !finite(value.pinball)) return undefined
  return { in80: value.in80, in50: value.in50, pinball: value.pinball }
}

/** A horizon's rule on Bitcoin's sharp moves (V6.1): undefined where none was written, null where one was
 * and is not whole -- adopted exactly where nothing refused it, its factors at least 1. */
function readShock(value: unknown): ShockRule | null | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || typeof value.version !== 'string' || !finite(value.line) || !finite(value.k80) || !finite(value.k50) || !finite(value.moments) || !finite(value.rows)) return null
  if (value.k80 < 1 || value.k50 < 1 || typeof value.adopted !== 'boolean') return null
  const refusal = value.refusal === null ? null : SHOCK_REFUSALS.find((entry) => entry === value.refusal)
  const before = readShockScore(value.before)
  const after = readShockScore(value.after)
  if (refusal === undefined || before === undefined || after === undefined || value.adopted !== (refusal === null)) return null
  return { version: value.version, line: value.line, k80: value.k80, k50: value.k50, moments: value.moments, rows: value.rows, before, after, adopted: value.adopted, refusal }
}

const WIDENINGS: readonly ShockWidening[] = ['none', 'line', 'states']

/** A horizon's rules by market state and its choice (V7.1 Stage 11): undefined where none was written, null
 * where one was and is not whole -- every state a known one with a whole rule, the choice a known one. */
function readMarketShock(value: unknown): MarketShockRules | null | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || typeof value.version !== 'string' || !isObject(value.byState) || !WIDENINGS.includes(value.chosen as ShockWidening)) return null
  const byState: MarketShockRules['byState'] = {}
  for (const [key, entry] of Object.entries(value.byState)) {
    const rule = readShock(entry)
    if (!(MARKET_SHOCK_STATES as readonly string[]).includes(key) || rule === null || rule === undefined) return null
    byState[key as MarketShockState] = rule
  }
  let compared: MarketShockRules['compared'] = null
  if (value.compared !== null) {
    if (!isObject(value.compared) || !finite(value.compared.rows)) return null
    const before = readShockScore(value.compared.before)
    const line = readShockScore(value.compared.line)
    const states = readShockScore(value.compared.states)
    if (!before || !line || !states) return null
    compared = { rows: value.compared.rows, before, line, states }
  }
  return { version: value.version, byState, compared, chosen: value.chosen as ShockWidening }
}

function readCurve(value: unknown): CurveBin[] | null {
  if (!Array.isArray(value)) return null
  const curve: CurveBin[] = []
  for (const bin of value) {
    if (!isObject(bin) || !finite(bin.predicted) || !finite(bin.observed) || !finite(bin.n)) return null
    curve.push({ predicted: bin.predicted, observed: bin.observed, n: bin.n })
  }
  return curve
}

function readDirectionScore(value: unknown): DirectionScore | null | undefined {
  if (value === null) return null
  if (!isObject(value)) return undefined
  const keys = ['n', 'brier', 'directionSkill', 'upShare', 'calls', 'precision'] as const
  const figures: Partial<Record<(typeof keys)[number], number>> = {}
  for (const key of keys) {
    const figure = measured(value[key])
    if (figure === undefined) return undefined
    figures[key] = figure
  }
  const curve = readCurve(value.curve)
  if (curve === null) return undefined
  return { ...(figures as Record<(typeof keys)[number], number>), curve }
}

const CHECK_IDS: readonly CheckLine['id'][] = ['outcomes', 'coverage', 'pinball', 'trades', 'skill', 'calls']

function readLines(value: unknown): CheckLine[] | null {
  if (!Array.isArray(value)) return null
  const out: CheckLine[] = []
  for (const line of value) {
    if (!isObject(line) || !CHECK_IDS.includes(line.id as CheckLine['id']) || (line.ok !== null && typeof line.ok !== 'boolean') || typeof line.text !== 'string') return null
    out.push({ id: line.id as CheckLine['id'], ok: line.ok as boolean | null, text: line.text })
  }
  return out
}

function readDirectionCalibration(value: unknown): DirectionCalibration | null {
  if (!isObject(value) || !isObject(value.honest) || typeof value.promoted !== 'boolean' || typeof value.degraded !== 'boolean') return null
  const map = readIsotonic(value.map)
  const pooled = readDirectionScore(value.honest.pooled)
  const byClassScores = byClass(value.honest.byClass, readDirectionScore)
  const weeks = value.honest.weeks
  const lastWeekSkill = value.lastWeekSkill === null ? null : finite(value.lastWeekSkill) ? value.lastWeekSkill : undefined
  const lines = readLines(value.lines)
  if (map === null || pooled === undefined || byClassScores === null || !finiteList(weeks) || lastWeekSkill === undefined || lines === null) return null
  return { map, honest: { pooled, byClass: byClassScores as Partial<Record<PairClass, DirectionScore>>, weeks }, lastWeekSkill, degraded: value.degraded, promoted: value.promoted, lines }
}

/** A horizon's direction report (V7.1 Stage 2): undefined where none was written, null where one was and
 * is not whole. */
function readDirectionReport(value: unknown): DirectionReport | null | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || !isObject(value.baseline) || !isObject(value.models)) return null
  const pooled = readDirectionScore(value.baseline.pooled)
  const baselineByClass = byClass(value.baseline.byClass, readDirectionScore)
  if (pooled === undefined || baselineByClass === null) return null
  const models: DirectionReport['models'] = {}
  for (const [key, entry] of Object.entries(value.models)) {
    const read = readDirectionCalibration(entry)
    if (!(DIRECTION_MODELS as readonly string[]).includes(key) || read === null) return null
    models[key as DirectionModelId] = read
  }
  return { baseline: { pooled, byClass: baselineByClass as Partial<Record<PairClass, DirectionScore>> }, models }
}

/** A list of one figure a level, measured or not (null read as NaN); null for anything else. */
function readLevels(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== EXCURSION_LEVELS.length) return null
  const out: number[] = []
  for (const entry of value) {
    const figure = measured(entry)
    if (figure === undefined) return null
    out.push(figure)
  }
  return out
}

/** A horizon's excursion calibration (V7.1 Stage 3): undefined where none was written, null where one
 * was and is not whole -- its factors finite and inside their bounds. */
function readExcursion(value: unknown): ExcursionCalibration | null | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || typeof value.version !== 'string' || !isObject(value.honest) || !finite(value.honest.n)) return null
  const high = readLevels(value.high)
  const low = readLevels(value.low)
  const honestHigh = readLevels(value.honest.high)
  const honestLow = readLevels(value.honest.low)
  const rawHigh = readLevels(value.honest.rawHigh)
  const rawLow = readLevels(value.honest.rawLow)
  if (high === null || low === null || honestHigh === null || honestLow === null || rawHigh === null || rawLow === null) return null
  if (![...high, ...low].every((factor) => Number.isFinite(factor) && factor > 0)) return null
  return { version: value.version, high, low, honest: { high: honestHigh, low: honestLow, rawHigh, rawLow, n: value.honest.n } }
}

function readTouchCurve(value: unknown): TouchCurve | null {
  if (!isObject(value) || !Array.isArray(value.within) || value.within.length !== FIRST_TOUCH.levels.length || !Array.isArray(value.medianBars) || value.medianBars.length !== FIRST_TOUCH.levels.length) return null
  const within: number[][] = []
  for (const row of value.within) {
    if (!Array.isArray(row) || row.length !== TOUCH_WINDOWS.length) return null
    const figures: number[] = []
    for (const entry of row) {
      const figure = measured(entry)
      if (figure === undefined) return null
      figures.push(figure)
    }
    within.push(figures)
  }
  const medianBars: (number | null)[] = []
  for (const entry of value.medianBars) {
    if (entry !== null && !finite(entry)) return null
    medianBars.push(entry as number | null)
  }
  return { within, medianBars }
}

/** The run's first-touch table (V7.1 Stage 3): undefined where none was written, null where one was and
 * is not whole. */
function readTouch(value: unknown): FirstTouchTable | null | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || typeof value.version !== 'string' || !finite(value.n) || !isObject(value.byRegime)) return null
  const up = readTouchCurve(value.up)
  const down = readTouchCurve(value.down)
  if (up === null || down === null) return null
  const byRegime: FirstTouchTable['byRegime'] = {}
  for (const [key, entry] of Object.entries(value.byRegime)) {
    if (!(MARKET_REGIMES as readonly string[]).includes(key) || !isObject(entry) || !finite(entry.n)) return null
    const ownUp = readTouchCurve(entry.up)
    const ownDown = readTouchCurve(entry.down)
    if (ownUp === null || ownDown === null) return null
    byRegime[key as MarketRegime] = { n: entry.n, up: ownUp, down: ownDown }
  }
  return { version: value.version, n: value.n, up, down, byRegime }
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
    const shock = readShock(entry.shock)
    const marketShock = readMarketShock(entry.marketShock)
    const direction = readDirectionReport(entry.direction)
    const excursion = readExcursion(entry.excursion)
    if (shock === null || marketShock === null || direction === null || excursion === null) return null
    horizons[key as Horizon] = {
      horizon: key as Horizon,
      rows: entry.rows,
      variants,
      ...(shock === undefined ? {} : { shock }),
      ...(marketShock === undefined ? {} : { marketShock }),
      ...(direction === undefined ? {} : { direction }),
      ...(excursion === undefined ? {} : { excursion })
    }
  }
  const touch = readTouch(raw.touch)
  if (touch === null) return null
  return { version: RUN_CALIBRATION_VERSION, runId: raw.runId, horizons, ...(touch === undefined ? {} : { touch }) }
}
