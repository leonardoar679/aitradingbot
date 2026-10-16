// WHAT THE FIGURES ARE WORTH: AN INTERVAL, AN EFFECTIVE SAMPLE AND A DETECTABLE SKILL ON THE WALK
// FORWARD'S FIGURES (16 October 2026; the first thing the V7.2 draft asks for -- here as a reader of the
// record alone, before any engine change).
//
// The record keeps one row an hour for every pair, and the 31 pairs move together: 15,000 outcomes are far
// fewer independent observations than they look. Every figure the engine reports is a point without an
// interval. This resamples HOURS, not rows -- every pair's row of an hour together, in circular blocks as
// long as the horizon, so outcomes that overlap are resampled together -- a thousand times, seeded, and
// prints for every horizon: the 80% and 50% coverage and the pinball skill over persistence of the forecast
// shown (V2, scored on the weeks before each week alone, as the app scores it), and for the distribution's
// P(up) and each direction model its Brier skill over the better of an even chance and the weeks-before base
// rate, its calls at the forecast's lines and the share right -- each with its 95% interval; the effective
// sample size of the 80% coverage (N times the naive variance over the bootstrap's); and the smallest
// direction skill this record could tell from zero (2.8 bootstrap standard deviations: 5% two-sided, 80%
// power). The same arithmetic as the app's for every point (runCalibration.ts); only the intervals are new.
//
//   npx esbuild research/uncertainty.ts --bundle --platform=node --format=esm --outfile=research/.uncertainty.mjs
//   PROFILE=<a scratch profile with a walk forward> [RUN=<run>] [DRAWS=1000] node research/.uncertainty.mjs
//
// It reads the profile's forecastModels/<run>/oos-*.bin; it writes nothing and asks nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRECTION_LINES, calibratedPUp, fitPUp } from '../shared/forecast/direction'
import { ENSEMBLE_LINES } from '../shared/forecast/ensemble'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import { rngOf } from '../shared/forecast/ml/bins'
import { meanPinball } from '../shared/forecast/ml/quantile'
import { DIRECTION_MODELS, type DirectionModelId } from '../shared/forecast/models'
import { decodeOos, type OosRecord } from '../shared/forecast/oosRecord'
import { rowsOf, scoreOutOfSample, type Row, type ScoredRow } from '../shared/forecast/runCalibration'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const MODELS = join(PROFILE, 'forecastModels')
const RUN = process.env.RUN ?? (JSON.parse(readFileSync(join(MODELS, 'current.json'), 'utf-8')) as { foldsRunId?: string; runId: string }).foldsRunId ?? ''
if (RUN === '') throw new Error('no walk forward in current.json; name one with RUN')
const DRAWS = Number(process.env.DRAWS ?? 1000)
const SEED = 20261016
/** Blocks as long as the horizon, in hours: outcomes that overlap are resampled together. */
const BLOCK_HOURS: Record<Horizon, number> = { minutes5: 1, minutes15: 1, hour1: 1, hours4: 4, hours24: 24 }
/** 5% two-sided and 80% power: 1.96 + 0.84 standard deviations. */
const DETECTABLE_SDS = 2.8

interface RangeSample {
  inside80: number
  inside50: number
  pinball: number
  floor: number
}

interface DirectionSample {
  brier: number
  reference: number
  call: number
  right: number
}

/** Rows grouped by the hour they were forecast at: the unit resampled. */
function byHour<T>(entries: readonly { hour: number; sample: T }[]): { hours: number[]; groups: Map<number, T[]> } {
  const groups = new Map<number, T[]>()
  for (const entry of entries) {
    const mine = groups.get(entry.hour)
    if (mine === undefined) groups.set(entry.hour, [entry.sample])
    else mine.push(entry.sample)
  }
  return { hours: [...groups.keys()].sort((a, b) => a - b), groups }
}

/** A circular block bootstrap over the hours: as many hours as there are, in blocks of consecutive hours
 * (in the record's order), each block starting anywhere. */
function drawHours(hours: readonly number[], block: number, rng: () => number): number[] {
  const m = hours.length
  const out: number[] = []
  while (out.length < m) {
    const start = Math.floor(rng() * m)
    for (let j = 0; j < block && out.length < m; j++) out.push(hours[(start + j) % m])
  }
  return out
}

function quantile(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) return Number.NaN
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(share * sorted.length)))]
}

function sd(values: readonly number[]): number {
  const clean = values.filter((value) => Number.isFinite(value))
  if (clean.length < 2) return Number.NaN
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length
  return Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / (clean.length - 1))
}

interface Interval {
  value: number
  low: number
  high: number
  sd: number
}

function intervalOf(point: number, draws: readonly number[]): Interval {
  const sorted = draws.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  return { value: point, low: quantile(sorted, 0.025), high: quantile(sorted, 0.975), sd: sd(sorted) }
}

/** The range figures with their intervals, and the effective sample of the 80% coverage. */
function rangeFigures(entries: readonly { hour: number; sample: RangeSample }[], block: number): { n: number; hours: number; coverage80: Interval; coverage50: Interval; skill: Interval; nEff: number } {
  const { hours, groups } = byHour(entries)
  const total = (chosen: readonly number[]): { n: number; inside80: number; inside50: number; pinball: number; floor: number } => {
    let n = 0
    let inside80 = 0
    let inside50 = 0
    let pinball = 0
    let floor = 0
    for (const hour of chosen) {
      for (const sample of groups.get(hour) ?? []) {
        n++
        inside80 += sample.inside80
        inside50 += sample.inside50
        pinball += sample.pinball
        floor += sample.floor
      }
    }
    return { n, inside80, inside50, pinball, floor }
  }
  const point = total(hours)
  const rng = rngOf(SEED)
  const c80: number[] = []
  const c50: number[] = []
  const skill: number[] = []
  for (let draw = 0; draw < DRAWS; draw++) {
    const sum = total(drawHours(hours, block, rng))
    c80.push(sum.inside80 / sum.n)
    c50.push(sum.inside50 / sum.n)
    skill.push(1 - sum.pinball / sum.floor)
  }
  const p = point.inside80 / point.n
  const bootVariance = sd(c80) ** 2
  return {
    n: point.n,
    hours: hours.length,
    coverage80: intervalOf(p, c80),
    coverage50: intervalOf(point.inside50 / point.n, c50),
    skill: intervalOf(1 - point.pinball / point.floor, skill),
    nEff: bootVariance > 0 ? (p * (1 - p)) / bootVariance : Number.NaN
  }
}

/** A P(up) source's figures with their intervals, and the smallest skill the sample could tell from zero. */
function directionFigures(entries: readonly { hour: number; sample: DirectionSample }[], block: number): { n: number; skill: Interval; calls: number; precision: Interval; detectable: number } {
  const { hours, groups } = byHour(entries)
  const total = (chosen: readonly number[]): { n: number; brier: number; reference: number; calls: number; right: number } => {
    let n = 0
    let brier = 0
    let reference = 0
    let calls = 0
    let right = 0
    for (const hour of chosen) {
      for (const sample of groups.get(hour) ?? []) {
        n++
        brier += sample.brier
        reference += sample.reference
        calls += sample.call
        right += sample.right
      }
    }
    return { n, brier, reference, calls, right }
  }
  const skillOf = (sum: { n: number; brier: number; reference: number }): number => 1 - sum.brier / Math.min(0.25 * sum.n, sum.reference)
  const point = total(hours)
  const rng = rngOf(SEED)
  const skills: number[] = []
  const precisions: number[] = []
  for (let draw = 0; draw < DRAWS; draw++) {
    const sum = total(drawHours(hours, block, rng))
    skills.push(skillOf(sum))
    precisions.push(sum.calls > 0 ? sum.right / sum.calls : Number.NaN)
  }
  const skill = intervalOf(skillOf(point), skills)
  return { n: point.n, skill, calls: point.calls, precision: intervalOf(point.calls > 0 ? point.right / point.calls : Number.NaN, precisions), detectable: DETECTABLE_SDS * skill.sd }
}

function directionSample(pUp: number, base: number, z: number): DirectionSample {
  const wentUp = z > 0 ? 1 : 0
  const bull = pUp >= DIRECTION_LINES.bullish
  const bear = pUp <= 1 - DIRECTION_LINES.bullish
  const call = (bull || bear) && z !== 0 ? 1 : 0
  return { brier: (pUp - wentUp) ** 2, reference: (base - wentUp) ** 2, call, right: call === 1 && bull === z > 0 ? 1 : 0 }
}

/** A direction model's readings scored out of sample on the weeks given, as runCalibration.ts scores them:
 * each week's readings mapped by the readings of the weeks before it alone, against those weeks' base rate. */
function modelEntries(record: OosRecord, rows: readonly Row[], model: DirectionModelId, weeks: readonly number[]): { hour: number; sample: DirectionSample }[] {
  const out: { hour: number; sample: DirectionSample }[] = []
  for (const week of weeks) {
    const earlier = rows.filter((row) => row.fold < week && row.direction?.[model] !== undefined)
    if (earlier.length < ENSEMBLE_LINES.minCellRows) continue
    const map = fitPUp(earlier.map((row) => ({ raw: row.direction![model]!, up: row.z > 0 })))
    const base = earlier.filter((row) => row.z > 0).length / earlier.length
    for (const row of rows) {
      const raw = row.direction?.[model]
      if (row.fold !== week || raw === undefined || row.at === undefined) continue
      out.push({ hour: record.time[row.at], sample: directionSample(calibratedPUp(map, raw), base, row.z) })
    }
  }
  return out
}

const pct = (value: number, digits = 1): string => (Number.isFinite(value) ? `${(100 * value).toFixed(digits)}%` : '-')
const signed = (value: number, digits = 2): string => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(100 * value).toFixed(digits)}%` : '-')
const interval = (made: Interval, digits = 1, sign = false): string => `${sign ? signed(made.value, digits) : pct(made.value, digits)} [${sign ? signed(made.low, digits) : pct(made.low, digits)}, ${sign ? signed(made.high, digits) : pct(made.high, digits)}]`
const thousands = (value: number): string => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '-')

console.log(`walk forward ${RUN} of ${PROFILE}: ${DRAWS} draws of a circular block bootstrap over the hours (blocks as long as the horizon), seed ${SEED}`)
for (const horizon of HORIZONS as Horizon[]) {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(MODELS, RUN, `oos-${horizon}.bin`))
  } catch {
    continue
  }
  const record = decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  if (record === null) {
    console.log(`${horizon}: the record could not be read`)
    continue
  }
  const rows = rowsOf(record)
  const promoted = new Set(record.models)
  const shown: ScoredRow[] = scoreOutOfSample(rows, 'v2', promoted)
  const block = BLOCK_HOURS[horizon]
  // The five levels are P10, P25, P50, P75, P90: the 80% range is the outer pair, the 50% range the inner.
  const levels = shown.filter((entry) => entry.at !== undefined).map((entry) => ({
    hour: record.time[entry.at!],
    sample: { inside80: entry.z >= entry.quantiles[0] && entry.z <= entry.quantiles[4] ? 1 : 0, inside50: entry.z >= entry.quantiles[1] && entry.z <= entry.quantiles[3] ? 1 : 0, pinball: meanPinball(entry.z, entry.quantiles), floor: meanPinball(entry.z, entry.floor) }
  }))
  const figures = rangeFigures(levels, block)
  console.log(`\n${horizon}: ${thousands(figures.n)} outcomes in ${thousands(figures.hours)} hours; blocks of ${block} hour${block === 1 ? '' : 's'}; effective sample of the 80% coverage ${thousands(figures.nEff)}`)
  console.log(`  80% range held        ${interval(figures.coverage80)}`)
  console.log(`  50% range held        ${interval(figures.coverage50)}`)
  console.log(`  pinball skill         ${interval(figures.skill, 2, true)} over persistence`)
  if (record.directionModels === undefined) {
    console.log('  direction: a record from before the direction models')
    continue
  }
  const baseline = shown.filter((entry) => entry.pUp !== null && entry.base !== null && entry.at !== undefined).map((entry) => ({ hour: record.time[entry.at!], sample: directionSample(entry.pUp!, entry.base!, entry.z) }))
  const weeks = [...new Set(shown.filter((entry) => entry.pUp !== null).map((entry) => entry.week))].sort((a, b) => a - b)
  const sources: { name: string; entries: { hour: number; sample: DirectionSample }[] }[] = [{ name: 'the distribution', entries: baseline }]
  for (const model of DIRECTION_MODELS) {
    if (!rows.some((row) => row.direction?.[model] !== undefined)) continue
    sources.push({ name: model, entries: modelEntries(record, rows, model, weeks) })
  }
  console.log('  P(up) source           outcomes  Brier skill [95%]            detectable   calls  right [95%]')
  for (const source of sources) {
    if (source.entries.length === 0) continue
    const made = directionFigures(source.entries, block)
    console.log(`  ${source.name.padEnd(22)} ${thousands(made.n).padStart(8)}  ${interval(made.skill, 2, true).padEnd(28)} ${signed(made.detectable).padStart(8)}   ${String(made.calls).padStart(5)}  ${made.calls > 0 ? interval(made.precision) : '-'}`)
  }
}
