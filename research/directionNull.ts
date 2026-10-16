// THE DIRECTION CHECKLIST UNDER A NULL: HOW OFTEN NOISE IS "PROMOTED" (16 October 2026; the V7.2 draft's
// Stage 2 null test, here as a reader of the record alone, before any engine change).
//
// The checklist that promotes a direction model (shared/forecast/promotion.ts directionChecklist) asks for
// 5,000 outcomes, a Brier skill above zero and -- where both it and the distribution's P(up) made 30 calls --
// calls no less often right than the distribution's. On run-20261016-0640 it promoted models with skills of
// +0.02% to +0.24%. This asks how often it would promote a model whose readings have NOTHING to do with the
// outcomes: the forecasts stay where they are and the outcomes are shifted by a random whole number of days
// -- each pair's outcome taken from the same pair that many days later, around the span's end, so each hour's
// cross-section (the market's common move) stays intact -- SHIFTS times; each shifted record is scored as
// the app scores it (each week's readings mapped by the weeks before alone, against their base rate) and
// judged by the checklist as it stands and by the lines the draft proposes (a skill of at least 1%, at least
// 200 calls, calls right more than half the time, a skill above zero in both halves of the weeks). The
// share of shifts a source passes is the checklist's false-pass rate; the real record's verdict stands beside it.
//
//   npx esbuild research/directionNull.ts --bundle --platform=node --format=esm --outfile=research/.directionNull.mjs
//   PROFILE=<a scratch profile with a walk forward> [RUN=<run>] [SHIFTS=200] node research/.directionNull.mjs
//
// It reads the profile's forecastModels/<run>/oos-*.bin; it writes nothing and asks nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRECTION_LINES, calibratedPUp, fitPUp } from '../shared/forecast/direction'
import { ENSEMBLE_LINES } from '../shared/forecast/ensemble'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import { rngOf } from '../shared/forecast/ml/bins'
import { DIRECTION_MODELS } from '../shared/forecast/models'
import { decodeOos } from '../shared/forecast/oosRecord'
import { DIRECTION_PROMOTION_LINES, directionChecklist } from '../shared/forecast/promotion'
import { rowsOf, scoreOutOfSample, type DirectionScore } from '../shared/forecast/runCalibration'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const MODELS = join(PROFILE, 'forecastModels')
const RUN = process.env.RUN ?? (JSON.parse(readFileSync(join(MODELS, 'current.json'), 'utf-8')) as { foldsRunId?: string; runId: string }).foldsRunId ?? ''
if (RUN === '') throw new Error('no walk forward in current.json; name one with RUN')
const SHIFTS = Number(process.env.SHIFTS ?? 200)
const SEED = 20261016
/** The lines the V7.2 draft proposes, fixed here before the null was run. */
const PROPOSED = { minOutcomes: 5000, minSkill: 0.01, minCalls: 200, precisionAbove: 0.5 } as const

/** One reading of one pair at one hour: where it was forecast, and the week it belongs to. */
interface Reading {
  pair: number
  hourIndex: number
  week: number
  raw: number
  /** Whether the row is one of the weeks scored (a test row), or an earlier row the map is fitted on. */
  scored: boolean
}

interface Verdict {
  score: DirectionScore
  halves: [number, number]
}

/** The score of readings against outcomes, as runCalibration.ts scores them: each scored week's readings
 * mapped by the readings of the weeks before it alone, against those weeks' base rate. */
function scoreReadings(readings: readonly Reading[], weeks: readonly number[], outcomeOf: (reading: Reading) => number | undefined): Verdict | null {
  let n = 0
  let brier = 0
  let reference = 0
  let up = 0
  let calls = 0
  let right = 0
  const byWeek = new Map<number, { brier: number; reference: number; n: number }>()
  for (const week of weeks) {
    const earlier: { raw: number; up: boolean }[] = []
    for (const reading of readings) {
      if (reading.week >= week) continue
      const z = outcomeOf(reading)
      if (z !== undefined) earlier.push({ raw: reading.raw, up: z > 0 })
    }
    if (earlier.length < ENSEMBLE_LINES.minCellRows) continue
    const map = fitPUp(earlier)
    const base = earlier.filter((point) => point.up).length / earlier.length
    for (const reading of readings) {
      if (reading.week !== week || !reading.scored) continue
      const z = outcomeOf(reading)
      if (z === undefined) continue
      const pUp = calibratedPUp(map, reading.raw)
      const wentUp = z > 0 ? 1 : 0
      n++
      brier += (pUp - wentUp) ** 2
      reference += (base - wentUp) ** 2
      up += wentUp
      const bull = pUp >= DIRECTION_LINES.bullish
      const bear = pUp <= 1 - DIRECTION_LINES.bullish
      if ((bull || bear) && z !== 0) {
        calls++
        if (bull === z > 0) right++
      }
      const mine = byWeek.get(week) ?? { brier: 0, reference: 0, n: 0 }
      mine.brier += (pUp - wentUp) ** 2
      mine.reference += (base - wentUp) ** 2
      mine.n++
      byWeek.set(week, mine)
    }
  }
  if (n === 0) return null
  const skillOf = (sum: { brier: number; reference: number; n: number }): number => 1 - sum.brier / Math.min(0.25 * sum.n, sum.reference)
  const scoredWeeks = [...byWeek.keys()].sort((a, b) => a - b)
  const half = Math.ceil(scoredWeeks.length / 2)
  const sumOf = (mine: readonly number[]): { brier: number; reference: number; n: number } => mine.reduce((acc, week) => {
    const w = byWeek.get(week)!
    return { brier: acc.brier + w.brier, reference: acc.reference + w.reference, n: acc.n + w.n }
  }, { brier: 0, reference: 0, n: 0 })
  const first = sumOf(scoredWeeks.slice(0, half))
  const second = sumOf(scoredWeeks.slice(half))
  return {
    score: { n, brier: brier / n, directionSkill: skillOf({ brier, reference, n }), upShare: up / n, calls, precision: calls > 0 ? right / calls : Number.NaN, curve: [] },
    halves: [first.n > 0 ? skillOf(first) : Number.NaN, second.n > 0 ? skillOf(second) : Number.NaN]
  }
}

function proposedPass(verdict: Verdict | null): boolean {
  if (verdict === null) return false
  const { score, halves } = verdict
  return score.n >= PROPOSED.minOutcomes && score.directionSkill >= PROPOSED.minSkill && score.calls >= PROPOSED.minCalls && score.precision > PROPOSED.precisionAbove && halves[0] > 0 && halves[1] > 0
}

const pct = (value: number, digits = 2): string => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(100 * value).toFixed(digits)}%` : '-')
const share = (value: number): string => `${(100 * value).toFixed(0)}%`

console.log(`walk forward ${RUN} of ${PROFILE}: ${SHIFTS} day shifts of the outcomes, seed ${SEED}; the checklist as it stands (${DIRECTION_PROMOTION_LINES.minOutcomes} outcomes, skill > 0, ${DIRECTION_PROMOTION_LINES.minCalls} calls each to compare) and the proposed lines (skill >= ${PROPOSED.minSkill * 100}%, >= ${PROPOSED.minCalls} calls, right > ${PROPOSED.precisionAbove * 100}%, skill > 0 in both halves)`)
for (const horizon of HORIZONS as Horizon[]) {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(MODELS, RUN, `oos-${horizon}.bin`))
  } catch {
    continue
  }
  const record = decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  if (record === null || record.directionModels === undefined) {
    console.log(`\n${horizon}: no direction readings on record`)
    continue
  }
  const rows = rowsOf(record)
  const shown = scoreOutOfSample(rows, 'v2', new Set(record.models))
  const hours = [...new Set(Array.from(record.time))].sort((a, b) => a - b)
  const hourIndex = new Map<number, number>(hours.map((hour, index) => [hour, index]))
  const spanDays = Math.max(1, Math.floor((hours[hours.length - 1] - hours[0]) / 86400))
  // Every outcome on record, by pair and hour: where a shifted outcome is read from.
  const outcomes = new Map<string, number>()
  for (const row of rows) if (row.at !== undefined) outcomes.set(`${record.pair[row.at]}:${hourIndex.get(record.time[row.at])}`, row.z)
  const scoredWeeks = [...new Set(shown.filter((entry) => entry.pUp !== null).map((entry) => entry.week))].sort((a, b) => a - b)
  const scoredSet = new Set(scoredWeeks)
  // The distribution's readings: the raw P(up) of the forecast shown, on every scored row (its map is fitted on
  // the scored rows of the weeks before, as the app fits it).
  const distribution: Reading[] = shown.filter((entry) => entry.at !== undefined).map((entry) => ({ pair: record.pair[entry.at!], hourIndex: hourIndex.get(record.time[entry.at!])!, week: entry.week, raw: entry.raw, scored: scoredSet.has(entry.week) }))
  const sources: { name: string; readings: Reading[] }[] = [{ name: 'the distribution', readings: distribution }]
  for (const model of DIRECTION_MODELS) {
    const readings: Reading[] = []
    for (const row of rows) {
      const raw = row.direction?.[model]
      if (raw === undefined || row.at === undefined) continue
      readings.push({ pair: record.pair[row.at], hourIndex: hourIndex.get(record.time[row.at])!, week: row.fold, raw, scored: scoredSet.has(row.fold) })
    }
    if (readings.length > 0) sources.push({ name: model, readings })
  }
  const realOutcome = (reading: Reading): number | undefined => outcomes.get(`${reading.pair}:${reading.hourIndex}`)
  const real = new Map<string, Verdict | null>(sources.map((source) => [source.name, scoreReadings(source.readings, scoredWeeks, realOutcome)]))
  const baseline = real.get('the distribution')?.score ?? null
  console.log(`\n${horizon}: ${hours.length} hours over ${spanDays} days; ${scoredWeeks.length} weeks scored`)
  console.log('  source                 real skill   as it stands  proposed | under the null: passes as it stands  passes proposed  skill 95th pct  max')
  const rng = rngOf(SEED)
  const shifts = Array.from({ length: SHIFTS }, () => 1 + Math.floor(rng() * spanDays))
  for (const source of sources) {
    const mine = real.get(source.name) ?? null
    const realOld = directionChecklist(mine?.score ?? null, source.name === 'the distribution' ? null : baseline).promoted
    const realNew = proposedPass(mine)
    let oldPasses = 0
    let newPasses = 0
    const nullSkills: number[] = []
    for (const k of shifts) {
      const shifted = (reading: Reading): number | undefined => outcomes.get(`${reading.pair}:${(reading.hourIndex + 24 * k) % hours.length}`)
      const verdict = scoreReadings(source.readings, scoredWeeks, shifted)
      // The distribution under the same shift is the baseline the checklist sets a model against.
      const shiftedBaseline = source.name === 'the distribution' ? null : (scoreReadings(distribution, scoredWeeks, shifted)?.score ?? null)
      if (directionChecklist(verdict?.score ?? null, shiftedBaseline).promoted) oldPasses++
      if (proposedPass(verdict)) newPasses++
      if (verdict !== null) nullSkills.push(verdict.score.directionSkill)
    }
    nullSkills.sort((a, b) => a - b)
    const p95 = nullSkills.length === 0 ? Number.NaN : nullSkills[Math.min(nullSkills.length - 1, Math.floor(0.95 * nullSkills.length))]
    const max = nullSkills.length === 0 ? Number.NaN : nullSkills[nullSkills.length - 1]
    console.log(`  ${source.name.padEnd(22)} ${pct(mine?.score.directionSkill ?? Number.NaN).padStart(9)}   ${(realOld ? 'promoted' : 'no').padEnd(12)}  ${(realNew ? 'pass' : 'no').padEnd(8)} | ${share(oldPasses / SHIFTS).padStart(31)}  ${share(newPasses / SHIFTS).padStart(15)}  ${pct(p95).padStart(14)}  ${pct(max)}`)
  }
}
