import { buildCell, calibrate, type CalibrationCell } from './calibration'
import { DIRECTION_LINES, calibratedPUp, fitPUp, rawPUp } from './direction'
import { ENSEMBLE_LINES, combine, lossesOf, weightsFromLosses, type MemberWeight } from './ensemble'
import type { MarketRegime } from '../marketResearch'
import { HORIZONS, HORIZON_BARS, MARKET_REGIMES, PAIR_CLASSES, type Horizon, type PairClass } from './features'
import type { IsotonicModel } from './ml/isotonic'
import { QUANTILE_LEVELS, meanPinball } from './ml/quantile'
import { excursionCalibrationOf, type ExcursionCalibration, type ExcursionRow, type FirstTouchTable } from './firstTouch'
import { DIRECTION_MODELS, type DirectionModelId, type ForecastModelId } from './models'
import { oosDirection, oosExcursion, oosQuantiles, oosState, type OosRecord } from './oosRecord'
import { DEGRADATION_LINES, directionChecklist, type CheckLine } from './promotion'
import { marketShockRulesOf, type MarketShockRow, type MarketShockRules } from './marketShock'
import { noShockRecord, shockRuleOf, type ShockRule } from './shock'
import { usualMove } from './targets'
import type { Promotion } from './training'
import { SHARE, blockHoursOf, bootstrapOverHours, detectableSkill, effectiveSampleSize, hourOf, intervalOf, shareVariance, type HourSample, type Interval, type Statistic } from './uncertainty'

// A RUN'S CALIBRATION (the V6 document, §14, §25-26, §49 and §56-61; V6 Stage 6, 13 October 2026),
// made from its walk forward's record of what every model forecast for every hour of the weeks it
// was tested on (shared/forecast/oosRecord.ts).
//
// FOR THE LIVE FORECAST, for each horizon: the ensemble's weights, the calibration cells and each
// class's usual width, from every week; and the map from raw P(up) to the share that went up, from
// the readings made out of sample (shared/forecast/direction.ts says why).
//
// AN HONEST SCORE of all of it, each figure on outcomes the part it scores never saw: each week after
// the first forecast with weights and a calibration made only from the weeks before it -- its
// coverage and its pinball loss against calibrated persistence's -- and, from the week after that,
// its P(up) mapped by what the earlier out-of-sample readings did, scored against the better of two
// forecasts that know nothing of the row: an even chance, and the share that went up in the weeks
// before (its direction skill). The better of the two, because on the real record the weeks' drift
// turned: carrying it forward scored worse than an even chance, and a P(up) that only beat that would
// have shown a skill it did not have. That is what the Lab and the reliability show.
//
// TWO VARIANTS (§49), each calibrated on its own record: V1, price only -- gbt on the price figures --
// and V2, the ensemble of every market model. The news (V3) and the AI (V4) adjust V2 live (V6 Stage
// 8) and are calibrated on the live record as it grows. Persistence is calibrated the same way, as the
// floor the honest skill is measured against.
//
// AND THE RULE ON BITCOIN'S SHARP MOVES (V6.1, shared/forecast/shock.ts): fitted on the forecast shown (V2)
// as it was scored out of sample, and adopted per horizon only where it held cross-fitted.
//
// AND THE DIRECTION MODELS (V7.1 Stage 2, 16 October 2026; shared/forecast/models.ts): each model's raw
// chance of up, read for every tested hour, is given the same honest treatment as the distribution's P(up)
// -- mapped by what the readings of the weeks before did, scored against the better of an even chance and
// the weeks-before base rate, on the same weeks the distribution's is scored on -- and promoted only by the
// checklist (shared/forecast/promotion.ts). A cell's P(UP) SOURCE is then the skilled reading with the
// highest honest skill, the distribution's or a promoted model's, and the base rate where none is skilled:
// the call's lines (shared/forecast/direction.ts) are unchanged, only where P(up) comes from may be.

// AND THE PATH (V7.1 Stage 3; shared/forecast/firstTouch.ts): each horizon's excursion levels scaled by
// what the tested paths did, and the first-touch table from the walk forward's bars -- when a target is
// reached, read at a target's distance.
//
// AND THE MARKET'S SHOCK STATES (V7.1 Stage 11; shared/forecast/marketShock.ts): where the record keeps
// each row's state, a widening fitted per state the way V6.1's was, and the horizon's choice between V6.1's
// one rule and the states' rules by the pinball loss on every row either would touch. A record from before
// the states holds none: the line's rule decides, as before.

//
// AND WHAT THE FIGURES ARE WORTH (V7.2 Stage 1, 17 October 2026; shared/forecast/uncertainty.ts): every
// honest score and direction score carries its figures' 95% intervals, resampled by the hour the rows were
// forecast at in blocks as long as the horizon, the effective sample behind it and the blocks a resample
// drew; a direction score the smallest skill its sample could tell from zero. The points are unchanged.

/** run-calibration-v6 (V7.2 Stage 1): every score carries its intervals. An older file is made again from
 * its record at the next start (without what the record does not hold). */
export const RUN_CALIBRATION_VERSION = 'run-calibration-v6'

/** Where a horizon's P(up) comes from: the base rate, the distribution's mapped reading, a direction
 * model's, or the news's own (shared/forecast/newsEffect.ts). */
export type PUpSource = 'base' | 'distribution' | 'news' | DirectionModelId

/** How a chance of up did on outcomes it never saw: its Brier skill over the better of an even chance
 * and the weeks-before base rate, and its calls at the forecast's lines. */
export interface DirectionScore {
  n: number
  brier: number
  directionSkill: number
  upShare: number
  /** Calls at the forecast's lines (P(up) at or past the bullish line, or at or under its mirror), and
   * of those that moved, the share called right. */
  calls: number
  precision: number
  curve: CurveBin[]
  /** The 95% intervals of the skill and the precision (V7.2 Stage 1), the effective sample behind the Brier
   * score, the blocks a resample drew, and the smallest skill this sample could tell from zero; absent where
   * the entries carry no hour, or fewer than two. */
  ci?: DirectionInterval
  nEff?: number
  blocks?: number
  detectable?: number
}

export interface DirectionInterval {
  directionSkill: Interval | null
  precision: Interval | null
}

export interface DirectionCalibration {
  /** The map from the model's raw chance to the share that went up, fitted on every scored reading. */
  map: IsotonicModel
  honest: { pooled: DirectionScore | null; byClass: Partial<Record<PairClass, DirectionScore>>; weeks: number[] }
  /** Its skill on the last week scored alone, and whether that week found it degraded. */
  lastWeekSkill: number | null
  degraded: boolean
  promoted: boolean
  lines: CheckLine[]
}

export interface DirectionReport {
  /** The distribution's P(up) scored the same way: what every model is set against. */
  baseline: { pooled: DirectionScore | null; byClass: Partial<Record<PairClass, DirectionScore>> }
  models: Partial<Record<DirectionModelId, DirectionCalibration>>
}
export const VARIANTS = ['v1', 'v2'] as const
export type VariantId = (typeof VARIANTS)[number]
/** The four of §49: V3 (+news) and V4 (+news +AI) are made live from V2 (shared/forecast/newsEffect.ts). */
export type ForecastVariant = VariantId | 'v3' | 'v4'

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P25 = QUANTILE_LEVELS.indexOf(0.25)
const P75 = QUANTILE_LEVELS.indexOf(0.75)
const P90 = QUANTILE_LEVELS.indexOf(0.9)

export interface CurveBin {
  /** The mean P(up) forecast in the bin, the share that went up, and how many. */
  predicted: number
  observed: number
  n: number
}

export interface HonestScore {
  /** Outcomes scored for the range, and of them those scored for P(up). */
  n: number
  nDirection: number
  coverage80: number
  coverage50: number
  /** The calibrated forecast's mean pinball loss, and calibrated persistence's on the same outcomes. */
  pinball: number
  persistencePinball: number
  /** 1 - pinball / persistencePinball: above zero, it knew more than the usual move's size. */
  skill: number
  /** The mean squared error of P(up), and 1 less it over the better of an even chance's and the
   * weeks-before base rate's: above zero, P(up) knew more than either. */
  brier: number
  directionSkill: number
  /** The share that went up, and of the moves whose way P(up) called (over 50% for up, under for
   * down; exactly 50% calls none) the share called right. */
  upShare: number
  direction: number
  curve: CurveBin[]
  /** The 95% intervals of the coverage, the skill and the direction skill (V7.2 Stage 1), the effective
   * sample behind the 80% coverage, and the blocks a resample drew; absent where the rows carry no hour, or
   * fewer than two. */
  ci?: HonestInterval
  nEff?: number
  blocks?: number
}

export interface HonestInterval {
  coverage80: Interval | null
  coverage50: Interval | null
  skill: Interval | null
  directionSkill: Interval | null
}

export interface VariantCalibration {
  weights: { pooled: MemberWeight[]; byClass: Partial<Record<PairClass, MemberWeight[]>> }
  cells: { pooled: CalibrationCell; byClass: Partial<Record<PairClass, CalibrationCell>> }
  pUp: IsotonicModel
  /** The median width of the calibrated 80% range, in percent. */
  usualWidth80Pct: { pooled: number; byClass: Partial<Record<PairClass, number>> }
  honest: { pooled: HonestScore | null; byClass: Partial<Record<PairClass, HonestScore>>; weeks: number[] }
}

export interface HorizonCalibration {
  horizon: Horizon
  rows: number
  variants: Record<VariantId, VariantCalibration>
  /** The rule on Bitcoin's sharp moves (V6.1); absent on a calibration made before it. */
  shock?: ShockRule
  /** The rules by market shock state and the horizon's choice among the widenings (V7.1 Stage 11); absent
   * on a record holding no states, where the line's rule decides. */
  marketShock?: MarketShockRules
  /** The direction models' verdicts (V7.1 Stage 2); absent on a record holding no readings of theirs. */
  direction?: DirectionReport
  /** The excursion levels' calibration (V7.1 Stage 3); absent on a record holding no readings of theirs,
   * or too few. */
  excursion?: ExcursionCalibration
}

export interface RunCalibration {
  version: string
  runId: string
  horizons: Partial<Record<Horizon, HorizonCalibration>>
  /** The first-touch table from the walk forward's bars (V7.1 Stage 3); absent on a calibration made
   * again from the record alone. */
  touch?: FirstTouchTable
}

/** One hour of one pair from the walk forward's record. */
export interface Row {
  /** Its index in the record it was read from (V6 Stage 11: the Lab reads its time, pair and path). */
  at?: number
  /** Unix seconds: the hour it was forecast at, the unit the intervals resample (V7.2 Stage 1). */
  t?: number
  quantiles: Partial<Record<ForecastModelId, number[]>>
  z: number
  cls: PairClass
  regime: MarketRegime
  fold: number
  usual: number
  /** Each direction model's raw chance of up at the row (V7.1 Stage 2), where the record holds it. */
  direction?: Partial<Record<DirectionModelId, number>>
  /** The path's highest high and lowest low in usual moves, and the excursion models' levels for it
   * (V7.1 Stage 3), where the record holds them. */
  excursion?: ExcursionRow
}

export function rowsOf(record: OosRecord): Row[] {
  const out: Row[] = []
  const bars = HORIZON_BARS[record.horizon]
  for (let row = 0; row < record.rows; row++) {
    const z = record.z[row]
    const usual = usualMove(record.rv24h[row], bars)
    if (!Number.isFinite(z) || !(usual > 0)) continue
    const quantiles: Partial<Record<ForecastModelId, number[]>> = {}
    for (const model of record.models) quantiles[model] = oosQuantiles(record, row, model)
    const entry: Row = { at: row, t: record.time[row], quantiles, z, cls: PAIR_CLASSES[record.cls[row]], regime: MARKET_REGIMES[record.regime[row]], fold: record.fold[row], usual }
    if (record.directionModels !== undefined) {
      const direction: Partial<Record<DirectionModelId, number>> = {}
      for (const model of record.directionModels) {
        const reading = oosDirection(record, row, model)
        if (reading !== undefined) direction[model] = reading
      }
      entry.direction = direction
    }
    const excursion = oosExcursion(record, row)
    if (excursion !== undefined && Number.isFinite(record.best[row]) && Number.isFinite(record.worst[row])) {
      entry.excursion = { best: record.best[row] / usual, worst: record.worst[row] / usual, high: excursion.high, low: excursion.low, week: record.fold[row] }
    }
    out.push(entry)
  }
  return out
}

type Members = VariantId | 'persistence'

interface Fitted {
  weights: VariantCalibration['weights']
  cells: VariantCalibration['cells']
  usualWidth80Pct: VariantCalibration['usualWidth80Pct']
}

function byClassOf<T extends { cls: PairClass }>(rows: readonly T[]): Map<PairClass, T[]> {
  const out = new Map<PairClass, T[]>()
  for (const row of rows) {
    const mine = out.get(row.cls)
    if (mine === undefined) out.set(row.cls, [row])
    else mine.push(row)
  }
  return out
}

function weightsFor(members: Members, rows: readonly Row[], promoted: ReadonlySet<ForecastModelId>): MemberWeight[] {
  if (members === 'persistence') return [{ model: 'persistence', weight: 1 }]
  if (members === 'v1') return [{ model: 'gbt-price', weight: 1 }]
  return weightsFromLosses(lossesOf(rows), promoted)
}

const widthPct = (quantiles: readonly number[], usual: number): number => (Math.exp(quantiles[P90] * usual) - Math.exp(quantiles[P10] * usual)) * 100

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Weights, cells and the usual widths from rows of the record. */
function fit(rows: readonly Row[], members: Members, promoted: ReadonlySet<ForecastModelId>): Fitted {
  const classes = byClassOf(rows)
  const pooledWeights = weightsFor(members, rows, promoted)
  const weightsByClass: Partial<Record<PairClass, MemberWeight[]>> = {}
  for (const [cls, mine] of classes) if (mine.length >= ENSEMBLE_LINES.minCellRows) weightsByClass[cls] = weightsFor(members, mine, promoted)
  const combined = rows.map((row) => ({ cls: row.cls, row, quantiles: combine(row.quantiles, weightsByClass[row.cls] ?? pooledWeights).quantiles }))
  const pooledCell = buildCell(combined.map((entry) => ({ quantiles: entry.quantiles, z: entry.row.z })))
  const cellsByClass: Partial<Record<PairClass, CalibrationCell>> = {}
  for (const [cls, mine] of byClassOf(combined)) {
    if (mine.length >= ENSEMBLE_LINES.minCellRows) cellsByClass[cls] = buildCell(mine.map((entry) => ({ quantiles: entry.quantiles, z: entry.row.z })))
  }
  const widths = combined.map((entry) => ({ cls: entry.cls, width: widthPct(calibrate(entry.quantiles, cellsByClass[entry.cls] ?? pooledCell), entry.row.usual) }))
  const widthByClass: Partial<Record<PairClass, number>> = {}
  for (const [cls, mine] of byClassOf(widths)) widthByClass[cls] = median(mine.map((entry) => entry.width))
  return {
    weights: { pooled: pooledWeights, byClass: weightsByClass },
    cells: { pooled: pooledCell, byClass: cellsByClass },
    usualWidth80Pct: { pooled: median(widths.map((entry) => entry.width)), byClass: widthByClass }
  }
}

/** One row's calibrated quantiles by a fitted calibration. */
function apply(fitted: Fitted, row: Row): number[] {
  const combined = combine(row.quantiles, fitted.weights.byClass[row.cls] ?? fitted.weights.pooled)
  return calibrate(combined.quantiles, fitted.cells.byClass[row.cls] ?? fitted.cells.pooled)
}

/** A row forecast out of sample: its calibrated quantiles and raw P(up), persistence's beside them,
 * and, once a map could be fitted before its week, its P(up) and the base rate of the weeks before. */
export interface ScoredRow {
  /** The record row it came from, where known, and the hour it was forecast at. */
  at?: number
  t?: number
  cls: PairClass
  regime: MarketRegime
  week: number
  quantiles: readonly number[]
  floor: readonly number[]
  z: number
  raw: number
  pUp: number | null
  base: number | null
}

/** The honest score of rows forecast out of sample; with its intervals where every row carries its hour and
 * a horizon says how long a block is (V7.2 Stage 1). */
export function honestScore(entries: readonly ScoredRow[], horizon?: Horizon): HonestScore | null {
  const n = entries.length
  if (n === 0) return null
  let inside80 = 0
  let inside50 = 0
  let pinball = 0
  let floor = 0
  let nDirection = 0
  let brier = 0
  let even = 0
  let reference = 0
  let up = 0
  let calls = 0
  let called = 0
  const bins = Array.from({ length: 10 }, () => ({ predicted: 0, observed: 0, n: 0 }))
  const samples: HourSample[] = []
  for (const entry of entries) {
    const q = entry.quantiles
    const in80 = entry.z >= q[P10] && entry.z <= q[P90] ? 1 : 0
    const in50 = entry.z >= q[P25] && entry.z <= q[P75] ? 1 : 0
    const loss = meanPinball(entry.z, q)
    const floorLoss = meanPinball(entry.z, entry.floor)
    inside80 += in80
    inside50 += in50
    pinball += loss
    floor += floorLoss
    if (entry.pUp === null || entry.base === null) {
      if (entry.t !== undefined) samples.push({ hour: hourOf(entry.t), sample: [in80, in50, loss, floorLoss, 0, 0, 0] })
      continue
    }
    const wentUp = entry.z > 0 ? 1 : 0
    const squared = (entry.pUp - wentUp) ** 2
    const referenceSquared = (entry.base - wentUp) ** 2
    nDirection++
    brier += squared
    even += 0.25
    reference += referenceSquared
    up += wentUp
    if (entry.z !== 0 && entry.pUp !== 0.5) {
      calls++
      if (entry.pUp > 0.5 === entry.z > 0) called++
    }
    const bin = bins[Math.min(9, Math.max(0, Math.floor(entry.pUp * 10)))]
    bin.predicted += entry.pUp
    bin.observed += wentUp
    bin.n++
    if (entry.t !== undefined) samples.push({ hour: hourOf(entry.t), sample: [in80, in50, loss, floorLoss, 1, squared, referenceSquared] })
  }
  const per = (value: number, over: number): number => (over > 0 ? value / over : Number.NaN)
  const score: HonestScore = {
    n,
    nDirection,
    coverage80: inside80 / n,
    coverage50: inside50 / n,
    pinball: pinball / n,
    persistencePinball: floor / n,
    skill: floor > 0 ? 1 - pinball / floor : Number.NaN,
    brier: per(brier, nDirection),
    directionSkill: nDirection > 0 ? 1 - brier / Math.min(even, reference) : Number.NaN,
    upShare: per(up, nDirection),
    direction: per(called, calls),
    curve: bins.filter((bin) => bin.n > 0).map((bin) => ({ predicted: bin.predicted / bin.n, observed: bin.observed / bin.n, n: bin.n }))
  }
  if (horizon !== undefined && samples.length === n) Object.assign(score, honestWorth(samples, horizon))
  return score
}

/** The honest figures as statistics of their rows' sums -- inside the 80% range, inside the 50%, the pinball
 * loss, the floor's, the rows with a P(up), their Brier squares and the base rate's: the shares inside, the
 * skill over the floor, and the direction skill over the better of an even chance and the base rate. */
const HONEST_STATISTICS: readonly Statistic[] = [
  (sums, n): number => sums[0] / n,
  (sums, n): number => sums[1] / n,
  (sums): number => (sums[3] > 0 ? 1 - sums[2] / sums[3] : Number.NaN),
  (sums): number => (sums[4] > 0 ? 1 - sums[5] / Math.min(0.25 * sums[4], sums[6]) : Number.NaN)
]

/** A score's intervals, resampled by hour in blocks as long as the horizon, and the effective sample behind
 * its 80% coverage; nothing with fewer hours than an interval needs. */
function honestWorth(samples: readonly HourSample[], horizon: Horizon): Pick<HonestScore, 'ci' | 'nEff' | 'blocks'> {
  const made = bootstrapOverHours(samples, HONEST_STATISTICS, blockHoursOf(horizon))
  if (made === null) return {}
  const [coverage80, coverage50, skill, directionSkill] = made.figures
  return {
    ci: { coverage80: intervalOf(coverage80, SHARE), coverage50: intervalOf(coverage50, SHARE), skill: intervalOf(skill), directionSkill: intervalOf(directionSkill) },
    nEff: effectiveSampleSize(shareVariance(coverage80.value), coverage80.sd),
    blocks: made.blocks
  }
}

/** Every week after the first forecast with what the weeks before it alone gave; and, from the week
 * after that, each row's P(up) mapped by what the out-of-sample readings before its week did. */
export function scoreOutOfSample(rows: readonly Row[], members: VariantId, promoted: ReadonlySet<ForecastModelId>): ScoredRow[] {
  const weeks = [...new Set(rows.map((row) => row.fold))].sort((a, b) => a - b)
  const scored: ScoredRow[] = []
  for (const week of weeks.slice(1)) {
    const before = rows.filter((row) => row.fold < week)
    if (before.length < ENSEMBLE_LINES.minCellRows) continue
    const fitted = fit(before, members, promoted)
    const floor = fit(before, 'persistence', promoted)
    for (const row of rows) {
      if (row.fold !== week) continue
      const quantiles = apply(fitted, row)
      scored.push({ at: row.at, ...(row.t === undefined ? {} : { t: row.t }), cls: row.cls, regime: row.regime, week, quantiles, floor: apply(floor, row), z: row.z, raw: rawPUp(quantiles), pUp: null, base: null })
    }
  }
  const scoredWeeks = [...new Set(scored.map((entry) => entry.week))].sort((a, b) => a - b)
  for (const week of scoredWeeks.slice(1)) {
    const map = fitPUp(scored.filter((entry) => entry.week < week).map((entry) => ({ raw: entry.raw, up: entry.z > 0 })))
    const earlier = rows.filter((row) => row.fold < week)
    const base = earlier.filter((row) => row.z > 0).length / earlier.length
    for (const entry of scored) {
      if (entry.week !== week) continue
      entry.pUp = calibratedPUp(map, entry.raw)
      entry.base = base
    }
  }
  return scored
}

function variantOf(rows: readonly Row[], members: VariantId, promoted: ReadonlySet<ForecastModelId>, horizon?: Horizon): { calibration: VariantCalibration; scored: ScoredRow[] } {
  const scored = scoreOutOfSample(rows, members, promoted)
  const byClass: Partial<Record<PairClass, HonestScore>> = {}
  for (const [cls, mine] of byClassOf(scored)) {
    const score = honestScore(mine, horizon)
    if (score !== null) byClass[cls] = score
  }
  const calibration = {
    ...fit(rows, members, promoted),
    pUp: fitPUp(scored.map((entry) => ({ raw: entry.raw, up: entry.z > 0 }))),
    honest: { pooled: honestScore(scored, horizon), byClass, weeks: [...new Set(scored.map((entry) => entry.week))].sort((a, b) => a - b) }
  }
  return { calibration, scored }
}

/** One chance of up scored out of sample: its cell, its week, the mapped chance, the base rate of the
 * weeks before, and what came. */
interface DirectionEntry {
  cls: PairClass
  week: number
  pUp: number
  base: number
  z: number
  /** The hour it was forecast at, where known: the unit the intervals resample. */
  t?: number
}

/** The direction score of entries scored out of sample; null without any. With its intervals and the skill
 * its sample could tell from zero where every entry carries its hour and a horizon is given (V7.2 Stage 1). */
export function directionScore(entries: readonly DirectionEntry[], horizon?: Horizon): DirectionScore | null {
  if (entries.length === 0) return null
  let brier = 0
  let squares = 0
  let even = 0
  let reference = 0
  let up = 0
  let calls = 0
  let called = 0
  const bins = Array.from({ length: 10 }, () => ({ predicted: 0, observed: 0, n: 0 }))
  const samples: HourSample[] = []
  for (const entry of entries) {
    const wentUp = entry.z > 0 ? 1 : 0
    const squared = (entry.pUp - wentUp) ** 2
    const referenceSquared = (entry.base - wentUp) ** 2
    brier += squared
    squares += squared ** 2
    even += 0.25
    reference += referenceSquared
    up += wentUp
    const bull = entry.pUp >= DIRECTION_LINES.bullish
    const bear = entry.pUp <= 1 - DIRECTION_LINES.bullish
    let call = 0
    let right = 0
    if ((bull || bear) && entry.z !== 0) {
      call = 1
      if (bull === entry.z > 0) right = 1
    }
    calls += call
    called += right
    const bin = bins[Math.min(9, Math.max(0, Math.floor(entry.pUp * 10)))]
    bin.predicted += entry.pUp
    bin.observed += wentUp
    bin.n++
    if (entry.t !== undefined) samples.push({ hour: hourOf(entry.t), sample: [squared, referenceSquared, call, right] })
  }
  const n = entries.length
  const score: DirectionScore = {
    n,
    brier: brier / n,
    directionSkill: 1 - brier / Math.min(even, reference),
    upShare: up / n,
    calls,
    precision: calls > 0 ? called / calls : Number.NaN,
    curve: bins.filter((bin) => bin.n > 0).map((bin) => ({ predicted: bin.predicted / bin.n, observed: bin.observed / bin.n, n: bin.n }))
  }
  if (horizon !== undefined && samples.length === n) Object.assign(score, directionWorth(samples, squares / n - (brier / n) ** 2, horizon))
  return score
}

/** The direction figures as statistics of their entries' sums -- the Brier squares, the base rate's, the
 * calls and those right: the skill over the better of an even chance and the base rate, the precision, and
 * the mean Brier score (whose spread gives the effective sample). */
const DIRECTION_STATISTICS: readonly Statistic[] = [
  (sums, n): number => 1 - sums[0] / Math.min(0.25 * n, sums[1]),
  (sums): number => (sums[2] > 0 ? sums[3] / sums[2] : Number.NaN),
  (sums, n): number => sums[0] / n
]

/** A direction score's intervals, resampled by hour in blocks as long as the horizon, the effective sample
 * behind its Brier score and the smallest skill it could tell from zero; nothing with fewer hours than an
 * interval needs. */
function directionWorth(samples: readonly HourSample[], brierVariance: number, horizon: Horizon): Pick<DirectionScore, 'ci' | 'nEff' | 'blocks' | 'detectable'> {
  const made = bootstrapOverHours(samples, DIRECTION_STATISTICS, blockHoursOf(horizon))
  if (made === null) return {}
  const [skill, precision, meanBrier] = made.figures
  return { ci: { directionSkill: intervalOf(skill), precision: intervalOf(precision, SHARE) }, nEff: effectiveSampleSize(brierVariance, meanBrier.sd), blocks: made.blocks, detectable: detectableSkill(skill.sd) }
}

/** The distribution's P(up) as the honest score read it, as direction entries: the baseline. */
function baselineEntries(shown: readonly ScoredRow[]): DirectionEntry[] {
  const out: DirectionEntry[] = []
  for (const entry of shown) if (entry.pUp !== null && entry.base !== null) out.push({ cls: entry.cls, week: entry.week, pUp: entry.pUp, base: entry.base, z: entry.z, ...(entry.t === undefined ? {} : { t: entry.t }) })
  return out
}

/** A direction model's readings scored out of sample on the weeks given: each week's readings mapped by
 * the readings of the weeks before it (their own map), against the base rate of those weeks. */
function directionEntriesOf(rows: readonly Row[], model: DirectionModelId, weeks: readonly number[]): DirectionEntry[] {
  const out: DirectionEntry[] = []
  for (const week of weeks) {
    const earlier = rows.filter((row) => row.fold < week && row.direction?.[model] !== undefined)
    if (earlier.length < ENSEMBLE_LINES.minCellRows) continue
    const map = fitPUp(earlier.map((row) => ({ raw: row.direction![model]!, up: row.z > 0 })))
    const base = earlier.filter((row) => row.z > 0).length / earlier.length
    for (const row of rows) {
      const raw = row.direction?.[model]
      if (row.fold !== week || raw === undefined) continue
      out.push({ cls: row.cls, week, pUp: calibratedPUp(map, raw), base, z: row.z, ...(row.t === undefined ? {} : { t: row.t }) })
    }
  }
  return out
}

function scoresByClass(entries: readonly DirectionEntry[], horizon?: Horizon): Partial<Record<PairClass, DirectionScore>> {
  const out: Partial<Record<PairClass, DirectionScore>> = {}
  for (const [cls, mine] of byClassOf(entries)) {
    const score = directionScore(mine, horizon)
    if (score !== null) out[cls] = score
  }
  return out
}

/** The direction models' verdicts from a horizon's rows, set against the distribution's P(up) on the same
 * weeks; null where the record holds no readings of theirs. With the horizon, every score carries its
 * intervals (V7.2 Stage 1). */
export function directionReportOf(rows: readonly Row[], shown: readonly ScoredRow[], horizon?: Horizon): DirectionReport | null {
  if (!rows.some((row) => row.direction !== undefined)) return null
  const baseline = baselineEntries(shown)
  const weeks = [...new Set(baseline.map((entry) => entry.week))].sort((a, b) => a - b)
  const report: DirectionReport = { baseline: { pooled: directionScore(baseline, horizon), byClass: scoresByClass(baseline, horizon) }, models: {} }
  for (const model of DIRECTION_MODELS) {
    if (!rows.some((row) => row.direction?.[model] !== undefined)) continue
    const entries = directionEntriesOf(rows, model, weeks)
    const pooled = directionScore(entries, horizon)
    const lastWeek = entries.length === 0 ? null : directionScore(entries.filter((entry) => entry.week === entries[entries.length - 1].week))
    const verdict = directionChecklist(pooled, report.baseline.pooled)
    report.models[model] = {
      map: fitPUp(rows.filter((row) => row.direction?.[model] !== undefined).map((row) => ({ raw: row.direction![model]!, up: row.z > 0 }))),
      honest: { pooled, byClass: scoresByClass(entries, horizon), weeks: [...new Set(entries.map((entry) => entry.week))].sort((a, b) => a - b) },
      lastWeekSkill: lastWeek === null ? null : lastWeek.directionSkill,
      degraded: lastWeek !== null && lastWeek.n >= DEGRADATION_LINES.minOutcomes && lastWeek.directionSkill < 0,
      promoted: verdict.promoted,
      lines: verdict.lines
    }
  }
  return report
}

/** A run's calibration from its walk forward's records and the verdicts on them; with the first-touch
 * table where the walk forward read one from its bars (V7.1 Stage 3). */
export function buildRunCalibration(records: ReadonlyMap<Horizon, OosRecord>, promotions: readonly Promotion[], runId: string, touch?: FirstTouchTable): RunCalibration {
  const horizons: Partial<Record<Horizon, HorizonCalibration>> = {}
  for (const horizon of HORIZONS) {
    const record = records.get(horizon)
    if (record === undefined) continue
    const rows = rowsOf(record)
    if (rows.length < ENSEMBLE_LINES.minCellRows) continue
    const promoted = new Set(promotions.filter((entry) => entry.horizon === horizon && entry.promoted).map((entry) => entry.model))
    const variants = {} as Record<VariantId, VariantCalibration>
    let shown: ScoredRow[] = []
    for (const variant of VARIANTS) {
      const made = variantOf(rows, variant, promoted, horizon)
      variants[variant] = made.calibration
      if (variant === 'v2') shown = made.scored
    }
    const btc15 = record.btc15
    const shockRows = btc15 === undefined ? [] : shown.map((entry) => ({ z: entry.z, q: entry.quantiles, week: entry.week, t: record.time[entry.at!], btc15: btc15[entry.at!], at: entry.at! }))
    const shock = btc15 === undefined ? noShockRecord() : shockRuleOf(shockRows)
    // The rules by market state (V7.1 Stage 11), from the rows whose state the record read.
    const stateRows: MarketShockRow[] = []
    for (const row of shockRows) {
      const state = oosState(record, row.at)
      if (state !== undefined) stateRows.push({ ...row, state })
    }
    const marketShock = record.state === undefined || stateRows.length === 0 ? undefined : marketShockRulesOf(stateRows, shock)
    const direction = directionReportOf(rows, shown, horizon)
    const excursion = excursionCalibrationOf(rows.filter((row) => row.excursion !== undefined).map((row) => row.excursion!))
    horizons[horizon] = { horizon, rows: rows.length, variants, shock, ...(marketShock === undefined ? {} : { marketShock }), ...(direction === null ? {} : { direction }), ...(excursion === null ? {} : { excursion }) }
  }
  return { version: RUN_CALIBRATION_VERSION, runId, horizons, ...(touch === undefined ? {} : { touch }) }
}

/** Where a pair of a class reads its P(up) from at a horizon (V7.1 Stage 2): the skilled reading with the
 * highest honest skill -- the distribution's, or a promoted direction model's for the class where it has
 * a score of its own, the horizon's otherwise -- and the base rate where none is skilled. With the
 * distribution's skill either way, for the forecast to show what was measured. */
export function directionSourceOf(entry: HorizonCalibration, cls: PairClass): { source: PUpSource; skill: number | null; map: IsotonicModel | null } {
  const v2 = cellOf(entry.variants.v2, cls)
  const distribution = v2.honest?.directionSkill ?? null
  let best: { source: PUpSource; skill: number | null; map: IsotonicModel | null } = { source: 'base', skill: distribution, map: null }
  if (distribution !== null && distribution >= DIRECTION_LINES.minDirectionSkill) best = { source: 'distribution', skill: distribution, map: null }
  for (const model of DIRECTION_MODELS) {
    const made = entry.direction?.models[model]
    if (made === undefined || !made.promoted) continue
    const score = (v2.ownClass ? made.honest.byClass[cls] : undefined) ?? made.honest.pooled
    if (score === null || score === undefined || !(score.directionSkill >= DIRECTION_LINES.minDirectionSkill)) continue
    if (best.source === 'base' || best.skill === null || score.directionSkill > best.skill) best = { source: model, skill: score.directionSkill, map: made.map }
  }
  return best
}

/** What a pair of a class reads of a variant's calibration: its class's own where it had enough
 * outcomes, the horizon's otherwise. */
export function cellOf(variant: VariantCalibration, cls: PairClass): { weights: MemberWeight[]; cell: CalibrationCell; usualWidth80Pct: number; honest: HonestScore | null; ownClass: boolean } {
  const ownClass = variant.cells.byClass[cls] !== undefined
  return {
    weights: variant.weights.byClass[cls] ?? variant.weights.pooled,
    cell: variant.cells.byClass[cls] ?? variant.cells.pooled,
    usualWidth80Pct: variant.usualWidth80Pct.byClass[cls] ?? variant.usualWidth80Pct.pooled,
    honest: (ownClass ? variant.honest.byClass[cls] : undefined) ?? variant.honest.pooled,
    ownClass
  }
}
