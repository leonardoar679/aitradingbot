// WHAT THE FIGURES ARE WORTH: AN INTERVAL, AN EFFECTIVE SAMPLE AND A DETECTABLE SKILL ON THE WALK
// FORWARD'S FIGURES (16 October 2026, the first thing the V7.2 draft asked for; since V7.2 Stage 1, 17
// October, a printer of the app's own figures).
//
// The record keeps one row an hour for every pair, and the 31 pairs move together: 15,000 outcomes are far
// fewer independent observations than they look, and until Stage 1 every figure the engine reported was a
// point without an interval. Now every honest score and direction score carries its intervals
// (shared/forecast/uncertainty.ts, read through runCalibration.ts's honestScore and directionScore): the
// HOURS resampled, not the rows -- every pair's row of an hour together, in circular blocks as long as the
// horizon, so outcomes that overlap are resampled together -- a thousand times, seeded, the interval widened
// for the overlap and for few blocks as the module says. This prints, for every horizon, the 80% and 50%
// coverage and the pinball skill over persistence of the forecast shown (V2, scored on the weeks before each
// week alone, as the app scores it), and for the distribution's P(up) and each direction model its Brier
// skill over the better of an even chance and the weeks-before base rate, its calls at the forecast's lines
// and the share right -- each with its 95% interval; the effective sample behind the 80% coverage; the blocks
// a resample drew; and the smallest direction skill this record could tell from zero (2.8 bootstrap standard
// deviations: 5% two-sided, 80% power). The same arithmetic as the Lab's, on the same record.
//
//   npx esbuild research/uncertainty.ts --bundle --platform=node --format=esm --outfile=research/.uncertainty.mjs
//   PROFILE=<a scratch profile with a walk forward> [RUN=<run>] node research/.uncertainty.mjs
//
// It reads the profile's forecastModels/<run>/oos-*.bin; it writes nothing and asks nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import { DIRECTION_MODELS } from '../shared/forecast/models'
import { decodeOos } from '../shared/forecast/oosRecord'
import { directionReportOf, honestScore, rowsOf, scoreOutOfSample, type DirectionScore, type ScoredRow } from '../shared/forecast/runCalibration'
import { UNCERTAINTY_LINES, blockHoursOf, type Interval } from '../shared/forecast/uncertainty'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const MODELS = join(PROFILE, 'forecastModels')
const RUN = process.env.RUN ?? (JSON.parse(readFileSync(join(MODELS, 'current.json'), 'utf-8')) as { foldsRunId?: string; runId: string }).foldsRunId ?? ''
if (RUN === '') throw new Error('no walk forward in current.json; name one with RUN')

const pct = (value: number | null | undefined, digits = 1): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${(100 * value).toFixed(digits)}%`)
const signed = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${(100 * value).toFixed(digits)}%`)
const interval = (value: number | null | undefined, made: Interval | null | undefined, digits = 1, sign = false): string => {
  const say = sign ? signed : pct
  return made === null || made === undefined ? say(value, digits) : `${say(value, digits)} [${say(made.low, digits)}, ${say(made.high, digits)}]`
}
const thousands = (value: number | null | undefined): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : Math.round(value).toLocaleString('en-US'))

console.log(`walk forward ${RUN} of ${PROFILE}: ${UNCERTAINTY_LINES.draws} draws of a circular block bootstrap over the hours (blocks as long as the horizon), seed ${UNCERTAINTY_LINES.seed}, the app's own intervals`)
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
  const honest = honestScore(shown, horizon)
  if (honest === null) {
    console.log(`${horizon}: no tested row`)
    continue
  }
  const block = blockHoursOf(horizon)
  console.log(`\n${horizon}: ${thousands(honest.n)} outcomes; ${thousands(honest.blocks)} blocks of ${block} hour${block === 1 ? '' : 's'}; effective sample of the 80% coverage ${thousands(honest.nEff)}`)
  console.log(`  80% range held        ${interval(honest.coverage80, honest.ci?.coverage80)}`)
  console.log(`  50% range held        ${interval(honest.coverage50, honest.ci?.coverage50)}`)
  console.log(`  pinball skill         ${interval(honest.skill, honest.ci?.skill, 2, true)} over persistence`)
  const report = directionReportOf(rows, shown, horizon)
  if (report === null) {
    console.log('  direction: a record from before the direction models')
    continue
  }
  console.log('  P(up) source           outcomes  Brier skill [95%]            detectable   calls  right [95%]')
  const line = (name: string, score: DirectionScore | null): void => {
    if (score === null) return
    console.log(`  ${name.padEnd(22)} ${thousands(score.n).padStart(8)}  ${interval(score.directionSkill, score.ci?.directionSkill, 2, true).padEnd(28)} ${signed(score.detectable).padStart(8)}   ${String(score.calls).padStart(5)}  ${score.calls > 0 ? interval(score.precision, score.ci?.precision) : '-'}`)
  }
  line('the distribution', report.baseline.pooled)
  for (const model of DIRECTION_MODELS) line(model, report.models[model]?.honest.pooled ?? null)
}
