// THE DIRECTION CHECKLIST UNDER A NULL: HOW OFTEN NOISE IS "PROMOTED" (16 October 2026; since V7.2 Stage 2,
// 17 October, on the app's own checklist and scorer), AND THE EXPLORATORY READINGS OF THE RECORD.
//
// A checklist that promotes a direction model should promote noise almost never. This asks how often it
// would promote a model whose readings have NOTHING to do with the outcomes: the forecasts stay where they
// are and the outcomes are shifted by a random whole number of days -- each pair's outcome taken from the
// same pair that many days later, around the span's end, so each hour's cross-section (the market's common
// move) stays intact -- SHIFTS times; each shifted record is scored as the app scores it
// (shared/forecast/runCalibration.ts directionScore: each week's readings mapped by the weeks before alone,
// against their base rate, with the intervals of V7.2 Stage 1 at NULL_DRAWS draws) and judged by the
// checklist as it stands (shared/forecast/promotion.ts directionChecklist, V7.2 Stage 2: a skill of at least
// 1%, 200 calls whose precision's lower bound clears an even chance, a skill above zero in both halves of
// the weeks and of the pairs, and -- for TRADEABLE -- the calls' edge after the round trip above zero beyond
// noise) and by V7.1's lines kept here as the reference (5,000 outcomes, a skill above zero, calls no less
// often right than the distribution's where both made thirty). The share of shifts a source passes is the
// checklist's false-pass rate; the real record's verdict stands beside it, with the outcomes a true 1%
// skill would need to clear the record's interval. The class floor is not read under the null (no class
// scores are made for it), which makes the null a little kinder than the app.
//
// THE EXPLORATORY READINGS (the V7.2 draft's P2.2-P2.3, record-only, no engine change): four readings of the
// forecast shown, each mapped by the weeks before and judged by the same checklist, in cells by market
// state, by regime and by pair class -- the distribution's skew (P90 + P10 - 2 P50 over P90 - P10), its
// median in half-widths, the excursion asymmetry (high - |low| over high + |low| at the 80% level) and, at
// four hours and a day, the shorter horizons' agreement with the median's way -- and the per-hour Spearman
// rank correlation of the shown medians with the realized moves across the pairs. Every row here is
// exploratory: a cell that passes is a null until it repeats on the next walk forward.
//
//   npx esbuild research/directionNull.ts --bundle --platform=node --format=esm --outfile=research/.directionNull.mjs
//   PROFILE=<a scratch profile with a walk forward> [RUN=<run>] [SHIFTS=200] [NULL_DRAWS=200] node research/.directionNull.mjs
//
// It reads the profile's forecastModels/<run>/oos-*.bin; it writes nothing and asks nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MarketRegime } from '../shared/marketResearch'
import { calibratedPUp, fitPUp } from '../shared/forecast/direction'
import { ENSEMBLE_LINES } from '../shared/forecast/ensemble'
import { HORIZONS, type Horizon, type PairClass } from '../shared/forecast/features'
import { MARKET_SHOCK_STATES, type MarketShockState } from '../shared/forecast/marketShock'
import { rngOf } from '../shared/forecast/ml/bins'
import { QUANTILE_LEVELS } from '../shared/forecast/ml/quantile'
import { DIRECTION_MODELS, EXCURSION_LEVELS } from '../shared/forecast/models'
import { decodeOos, oosState, type OosRecord } from '../shared/forecast/oosRecord'
import { DIRECTION_PROMOTION_LINES, directionChecklist } from '../shared/forecast/promotion'
import { directionScore, rowsOf, scoreOutOfSample, type DirectionScore, type ScoredRow } from '../shared/forecast/runCalibration'
import { UNCERTAINTY_LINES, bootstrapOverHours, hourOf, type UncertaintyLines } from '../shared/forecast/uncertainty'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const MODELS = join(PROFILE, 'forecastModels')
const RUN = process.env.RUN ?? (JSON.parse(readFileSync(join(MODELS, 'current.json'), 'utf-8')) as { foldsRunId?: string; runId: string }).foldsRunId ?? ''
if (RUN === '') throw new Error('no walk forward in current.json; name one with RUN')
const SHIFTS = Number(process.env.SHIFTS ?? 200)
const SEED = 20261016
/** The intervals under the null and in the exploratory cells, at fewer draws than the app's thousand. */
const QUICK: UncertaintyLines = { ...UNCERTAINTY_LINES, draws: Number(process.env.NULL_DRAWS ?? 200) }
/** V7.1's lines, kept as the reference the new checklist is set against. */
const V71 = { minOutcomes: 5000, minCalls: 30 } as const

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P50 = QUANTILE_LEVELS.indexOf(0.5)
const P90 = QUANTILE_LEVELS.indexOf(0.9)
const E80 = EXCURSION_LEVELS.indexOf(0.8)

/** One reading of one pair at one hour: where it was forecast, the week it belongs to, and its cells. */
interface Reading {
  pair: string
  hourIndex: number
  t: number
  week: number
  raw: number
  /** Whether the row is one of the weeks scored (a test row), or an earlier row the map is fitted on. */
  scored: boolean
  cls: PairClass
  regime: MarketRegime
  state: MarketShockState | null
}

interface Outcome {
  z: number
  movePct: number
}

/** The score of readings against outcomes, as the app scores them: each scored week's readings mapped by the
 * readings of the weeks before it alone, against those weeks' base rate; and the checklist's verdicts. */
function judge(readings: readonly Reading[], weeks: readonly number[], outcomeOf: (reading: Reading) => Outcome | undefined, horizon: Horizon, lines: UncertaintyLines, withClasses: boolean): { score: DirectionScore; promoted: boolean; tradeable: boolean } | null {
  const entries: { cls: PairClass; week: number; pUp: number; base: number; z: number; t: number; pair: string; movePct: number }[] = []
  for (const week of weeks) {
    const earlier: { raw: number; up: boolean }[] = []
    for (const reading of readings) {
      if (reading.week >= week) continue
      const outcome = outcomeOf(reading)
      if (outcome !== undefined) earlier.push({ raw: reading.raw, up: outcome.z > 0 })
    }
    if (earlier.length < ENSEMBLE_LINES.minCellRows) continue
    const map = fitPUp(earlier)
    const base = earlier.filter((point) => point.up).length / earlier.length
    for (const reading of readings) {
      if (reading.week !== week || !reading.scored) continue
      const outcome = outcomeOf(reading)
      if (outcome === undefined) continue
      entries.push({ cls: reading.cls, week, pUp: calibratedPUp(map, reading.raw), base, z: outcome.z, t: reading.t, pair: reading.pair, movePct: outcome.movePct })
    }
  }
  const score = directionScore(entries, horizon, lines)
  if (score === null) return null
  const byClass: Partial<Record<PairClass, DirectionScore>> = {}
  if (withClasses) {
    for (const cls of new Set(entries.map((entry) => entry.cls))) {
      const mine = directionScore(entries.filter((entry) => entry.cls === cls), horizon, lines)
      if (mine !== null) byClass[cls] = mine
    }
  }
  const verdict = directionChecklist(score, byClass)
  return { score, promoted: verdict.promoted, tradeable: verdict.tradeable }
}

/** V7.1's checklist, as it stood until 17 October 2026. */
function v71Promoted(score: DirectionScore | null, baseline: DirectionScore | null): boolean {
  if (score === null) return false
  if (score.n < V71.minOutcomes || !(score.directionSkill > 0)) return false
  const enoughCalls = score.calls >= V71.minCalls && baseline !== null && baseline.calls >= V71.minCalls
  return !enoughCalls || score.precision >= baseline.precision
}

const pct = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${(100 * value).toFixed(digits)}%`)
const share = (value: number): string => `${(100 * value).toFixed(0)}%`
const thousands = (value: number): string => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '-')
const pctOf = (logMove: number): number => (Math.exp(logMove) - 1) * 100

/** Spearman's rank correlation of two lists; NaN under three pairs or a constant list. */
function spearman(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  if (n < 3) return Number.NaN
  const rank = (values: readonly number[]): number[] => {
    const order = values.map((value, at) => ({ value, at })).sort((x, y) => x.value - y.value)
    const out = new Array<number>(n)
    for (let i = 0; i < n; ) {
      let j = i
      while (j + 1 < n && order[j + 1].value === order[i].value) j++
      const mean = (i + j) / 2
      for (let k = i; k <= j; k++) out[order[k].at] = mean
      i = j + 1
    }
    return out
  }
  const ra = rank(a)
  const rb = rank(b)
  const ma = ra.reduce((sum, value) => sum + value, 0) / n
  const mb = rb.reduce((sum, value) => sum + value, 0) / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb)
    va += (ra[i] - ma) ** 2
    vb += (rb[i] - mb) ** 2
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : Number.NaN
}

function recordOf(horizon: Horizon): OosRecord | null {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(MODELS, RUN, `oos-${horizon}.bin`))
  } catch {
    return null
  }
  return decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/** Every horizon's shown medians by pair and hour, for the shorter horizons' agreement. */
const medianSigns = new Map<Horizon, Map<string, number>>()
const records = new Map<Horizon, { record: OosRecord; shown: ScoredRow[] }>()
for (const horizon of HORIZONS as Horizon[]) {
  const record = recordOf(horizon)
  if (record === null) continue
  const rows = rowsOf(record)
  const shown = scoreOutOfSample(rows, 'v2', new Set(record.models))
  records.set(horizon, { record, shown })
  const signs = new Map<string, number>()
  for (const entry of shown) if (entry.at !== undefined) signs.set(`${record.symbols[record.pair[entry.at]]}:${record.time[entry.at]}`, Math.sign(entry.quantiles[P50]))
  medianSigns.set(horizon, signs)
}

console.log(`walk forward ${RUN} of ${PROFILE}: ${SHIFTS} day shifts of the outcomes, seed ${SEED}, intervals at ${QUICK.draws} draws under the null; the checklist as it stands (skill >= ${DIRECTION_PROMOTION_LINES.minSkill * 100}%, >= ${DIRECTION_PROMOTION_LINES.minCalls} calls, precision's lower bound > ${DIRECTION_PROMOTION_LINES.precisionLowerBound * 100}%, both halves of the weeks and of the pairs > 0; tradeable: the calls' edge after the round trip > 0 with its lower bound) and V7.1's (${V71.minOutcomes} outcomes, skill > 0, ${V71.minCalls} calls each to compare)`)
for (const horizon of HORIZONS as Horizon[]) {
  const held = records.get(horizon)
  if (held === undefined) continue
  const { record, shown } = held
  if (record.directionModels === undefined) {
    console.log(`\n${horizon}: no direction readings on record`)
    continue
  }
  const rows = rowsOf(record)
  const hours = [...new Set(Array.from(record.time))].sort((a, b) => a - b)
  const hourIndex = new Map<number, number>(hours.map((hour, index) => [hour, index]))
  const spanDays = Math.max(1, Math.floor((hours[hours.length - 1] - hours[0]) / 86400))
  // Every outcome on record, by pair and hour: where a shifted outcome is read from.
  const outcomes = new Map<string, Outcome>()
  for (const row of rows) if (row.at !== undefined) outcomes.set(`${record.pair[row.at]}:${hourIndex.get(record.time[row.at])}`, { z: row.z, movePct: pctOf(row.z * row.usual) })
  const scoredWeeks = [...new Set(shown.filter((entry) => entry.pUp !== null).map((entry) => entry.week))].sort((a, b) => a - b)
  const scoredSet = new Set(scoredWeeks)
  const rowAt = new Map(rows.map((row) => [row.at!, row]))
  const quick = (at: number, week: number, raw: number): Reading => {
    const row = rowAt.get(at)!
    return { pair: record.symbols[record.pair[at]], hourIndex: hourIndex.get(record.time[at])!, t: record.time[at], week, raw, scored: scoredSet.has(week), cls: row.cls, regime: row.regime, state: oosState(record, at) ?? null }
  }
  const pairIndex = new Map(record.symbols.map((symbol, index) => [symbol, index]))
  // The distribution's readings: the raw P(up) of the forecast shown, on every scored row.
  const distribution: Reading[] = shown.filter((entry) => entry.at !== undefined).map((entry) => quick(entry.at!, entry.week, entry.raw))
  const sources: { name: string; readings: Reading[] }[] = [{ name: 'the distribution', readings: distribution }]
  for (const model of DIRECTION_MODELS) {
    const readings: Reading[] = []
    for (const row of rows) {
      const raw = row.direction?.[model]
      if (raw === undefined || row.at === undefined) continue
      readings.push(quick(row.at, row.fold, raw))
    }
    if (readings.length > 0) sources.push({ name: model, readings })
  }
  const realOutcome = (reading: Reading): Outcome | undefined => outcomes.get(`${pairIndex.get(reading.pair)}:${reading.hourIndex}`)
  const real = new Map(sources.map((source) => [source.name, judge(source.readings, scoredWeeks, realOutcome, horizon, UNCERTAINTY_LINES, true)]))
  const baseline = real.get('the distribution')?.score ?? null
  console.log(`\n${horizon}: ${hours.length} hours over ${spanDays} days; ${scoredWeeks.length} weeks scored`)
  console.log('  source                 real skill [95%]            outcomes for 1%   V7.1      as it stands           | under the null: V7.1 passes  promoted  tradeable  skill 95th pct  max')
  const rng = rngOf(SEED)
  const shifts = Array.from({ length: SHIFTS }, () => 1 + Math.floor(rng() * spanDays))
  for (const source of sources) {
    const mine = real.get(source.name) ?? null
    const realOld = v71Promoted(mine?.score ?? null, source.name === 'the distribution' ? null : baseline)
    let oldPasses = 0
    let promotedPasses = 0
    let tradeablePasses = 0
    const nullSkills: number[] = []
    for (const k of shifts) {
      const shifted = (reading: Reading): Outcome | undefined => outcomes.get(`${pairIndex.get(reading.pair)}:${(reading.hourIndex + 24 * k) % hours.length}`)
      const verdict = judge(source.readings, scoredWeeks, shifted, horizon, QUICK, false)
      const shiftedBaseline = source.name === 'the distribution' ? null : (judge(distribution, scoredWeeks, shifted, horizon, QUICK, false)?.score ?? null)
      if (v71Promoted(verdict?.score ?? null, shiftedBaseline)) oldPasses++
      if (verdict?.promoted) promotedPasses++
      if (verdict?.tradeable) tradeablePasses++
      if (verdict !== null) nullSkills.push(verdict.score.directionSkill)
    }
    nullSkills.sort((a, b) => a - b)
    const p95 = nullSkills.length === 0 ? Number.NaN : nullSkills[Math.min(nullSkills.length - 1, Math.floor(0.95 * nullSkills.length))]
    const max = nullSkills.length === 0 ? Number.NaN : nullSkills[nullSkills.length - 1]
    const score = mine?.score
    const skillText = score === undefined ? '-' : `${pct(score.directionSkill)}${score.ci?.directionSkill ? ` [${pct(score.ci.directionSkill.low)}, ${pct(score.ci.directionSkill.high)}]` : ''}`
    // The outcomes a true 1% skill would need to clear the interval: the spread falls with the root of the sample.
    const needed = score === undefined || score.detectable === undefined || !Number.isFinite(score.detectable) ? Number.NaN : score.n * (score.detectable / DIRECTION_PROMOTION_LINES.minSkill) ** 2
    const verdictText = mine === null ? '-' : mine.tradeable ? 'tradeable' : mine.promoted ? 'promoted' : 'no'
    console.log(`  ${source.name.padEnd(22)} ${skillText.padEnd(28)} ${thousands(needed).padStart(15)}   ${(realOld ? 'promoted' : 'no').padEnd(9)} ${verdictText.padEnd(22)} | ${share(oldPasses / SHIFTS).padStart(27)}  ${share(promotedPasses / SHIFTS).padStart(8)}  ${share(tradeablePasses / SHIFTS).padStart(9)}  ${pct(p95).padStart(14)}  ${pct(max)}`)
  }

  // THE EXPLORATORY READINGS, each mapped by the weeks before and judged by the checklist in cells.
  const exploratory: { name: string; readings: Reading[] }[] = []
  const skew: Reading[] = []
  const halfWidths: Reading[] = []
  const asymmetry: Reading[] = []
  const agreement: Reading[] = []
  for (const entry of shown) {
    if (entry.at === undefined) continue
    const q = entry.quantiles
    const width = q[P90] - q[P10]
    if (width > 0) {
      skew.push(quick(entry.at, entry.week, (q[P90] + q[P10] - 2 * q[P50]) / width))
      halfWidths.push(quick(entry.at, entry.week, q[P50] / (width / 2)))
    }
    const row = rowAt.get(entry.at)
    const excursion = row?.excursion
    if (excursion !== undefined && E80 >= 0 && excursion.high[E80] !== undefined && excursion.low[E80] !== undefined) {
      const high = Math.abs(excursion.high[E80])
      const low = Math.abs(excursion.low[E80])
      if (high + low > 0) asymmetry.push(quick(entry.at, entry.week, (high - low) / (high + low)))
    }
    if (horizon === 'hours4' || horizon === 'hours24') {
      const key = `${record.symbols[record.pair[entry.at]]}:${record.time[entry.at]}`
      const mine = Math.sign(q[P50])
      let agreeing = 0
      let seen = 0
      for (const shorter of ['minutes5', 'minutes15', 'hour1'] as Horizon[]) {
        const sign = medianSigns.get(shorter)?.get(key)
        if (sign === undefined) continue
        seen++
        agreeing += sign * mine
      }
      if (seen > 0 && mine !== 0) agreement.push(quick(entry.at, entry.week, (mine * agreeing) / seen))
    }
  }
  exploratory.push({ name: 'skew', readings: skew }, { name: 'median in half-widths', readings: halfWidths })
  if (asymmetry.length > 0) exploratory.push({ name: 'excursion asymmetry', readings: asymmetry })
  if (agreement.length > 0) exploratory.push({ name: "shorter horizons' agreement", readings: agreement })
  console.log('  exploratory (record-only; a pass is a null until it repeats on the next walk forward):')
  console.log('  reading                      cells  promoted  tradeable  pooled skill [95%]            best cell')
  let cells = 0
  let passes = 0
  for (const source of exploratory) {
    const groups: { name: string; readings: Reading[] }[] = [{ name: 'pooled', readings: source.readings }]
    for (const state of MARKET_SHOCK_STATES) groups.push({ name: `state ${state}`, readings: source.readings.filter((reading) => reading.state === state) })
    for (const regime of new Set(source.readings.map((reading) => reading.regime))) groups.push({ name: `regime ${regime}`, readings: source.readings.filter((reading) => reading.regime === regime) })
    for (const cls of new Set(source.readings.map((reading) => reading.cls))) groups.push({ name: `class ${cls}`, readings: source.readings.filter((reading) => reading.cls === cls) })
    let promotedCells = 0
    let tradeableCells = 0
    let judged = 0
    let best: { name: string; skill: number; low: number | null } | null = null
    let pooledText = '-'
    for (const group of groups) {
      if (group.readings.length === 0) continue
      const verdict = judge(group.readings, scoredWeeks, realOutcome, horizon, QUICK, false)
      if (verdict === null) continue
      judged++
      if (verdict.promoted) promotedCells++
      if (verdict.tradeable) tradeableCells++
      const low = verdict.score.ci?.directionSkill?.low ?? null
      if (group.name === 'pooled') pooledText = `${pct(verdict.score.directionSkill)}${verdict.score.ci?.directionSkill ? ` [${pct(verdict.score.ci.directionSkill.low)}, ${pct(verdict.score.ci.directionSkill.high)}]` : ''}`
      if (best === null || verdict.score.directionSkill > best.skill) best = { name: group.name, skill: verdict.score.directionSkill, low }
    }
    cells += judged
    passes += promotedCells
    console.log(`  ${source.name.padEnd(28)} ${String(judged).padStart(5)}  ${String(promotedCells).padStart(8)}  ${String(tradeableCells).padStart(9)}  ${pooledText.padEnd(28)}  ${best === null ? '-' : `${best.name} ${pct(best.skill)}${best.low === null ? '' : ` (low ${pct(best.low)})`}`}`)
  }
  console.log(`  ${cells} exploratory cells judged, ${passes} promoted; the checklist's false-pass rate under the null is in the table above (the direction models' rows): about that share of ${cells} cells would pass as noise, and a pass here is weighed against it and against the cells tried`)

  // The per-hour Spearman rank correlation of the shown medians with the realized moves across the pairs.
  const byHour = new Map<number, { medians: number[]; moves: number[] }>()
  for (const entry of shown) {
    if (entry.at === undefined) continue
    const t = record.time[entry.at]
    const mine = byHour.get(t) ?? { medians: [], moves: [] }
    mine.medians.push(entry.quantiles[P50])
    mine.moves.push(entry.z)
    byHour.set(t, mine)
  }
  const rhos = [...byHour.entries()].map(([t, mine]) => ({ hour: hourOf(t), rho: spearman(mine.medians, mine.moves), pairs: mine.medians.length })).filter((entry) => Number.isFinite(entry.rho))
  const made = bootstrapOverHours(rhos.map((entry) => ({ hour: entry.hour, sample: [entry.rho] })), [(sums, n): number => sums[0] / n], UNCERTAINTY_LINES.blockHours[horizon])
  const mean = rhos.reduce((sum, entry) => sum + entry.rho, 0) / Math.max(1, rhos.length)
  const share95 = rhos.filter((entry) => entry.rho > 0).length / Math.max(1, rhos.length)
  console.log(`  Spearman of the shown medians with the realized moves across the pairs, per hour: mean ${mean.toFixed(3)}${made === null ? '' : ` [${made.figures[0].low.toFixed(3)}, ${made.figures[0].high.toFixed(3)}]`} over ${rhos.length} hours (about ${Math.round(rhos.reduce((sum, entry) => sum + entry.pairs, 0) / Math.max(1, rhos.length))} pairs an hour; an hour's own standard error is about 0.18); positive in ${share(share95)} of the hours`)
}
