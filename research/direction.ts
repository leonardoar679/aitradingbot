// WHICH WAY: THE DIRECTION EXPERIMENTS ON A WALK FORWARD (V7.1 Stage 2, 16 October 2026).
//
// V6's forecast read its P(up) off its range's distribution, and on three walk forwards that never beat
// the base rate on weeks it was not fitted on, so no way was ever called (research/FORECAST.md). V7.1 adds
// four classifiers of which way (shared/forecast/models.ts, DIRECTION_MODELS), each read for every tested
// hour of the walk forward and kept in its record (shared/forecast/oosRecord.ts, forecast-oos-v3). This
// reads a profile's record and prints, horizon by horizon, the table the Forecast Lab shows: the
// distribution's P(up) and each model, mapped by the weeks before each week alone and scored on the same
// weeks -- outcomes, Brier skill over the better of an even chance and the weeks-before base rate, calls at
// the forecast's lines and the share right -- each model's checklist, and which source each pair class
// would read its P(up) from (shared/forecast/runCalibration.ts). The same arithmetic as the app's, on the
// same record: the app's calibration.json is not read, so the two can be set against each other. Since V7.2
// Stage 1 (17 October 2026) each skill and each share right carries its 95% interval in brackets, and each
// source the smallest skill its sample could tell from zero (shared/forecast/uncertainty.ts).
//
//   npx esbuild research/direction.ts --bundle --platform=node --format=esm --outfile=research/.direction.mjs
//   PROFILE=<a scratch profile with a walk forward> node research/.direction.mjs
//
// It reads the profile's forecastModels/<run>/oos-*.bin; it writes nothing and asks nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HORIZONS, PAIR_CLASSES, type Horizon } from '../shared/forecast/features'
import { DIRECTION_MODELS } from '../shared/forecast/models'
import { decodeOos } from '../shared/forecast/oosRecord'
import { directionReportOf, directionSourceOf, rowsOf, scoreOutOfSample, type DirectionScore, type HorizonCalibration } from '../shared/forecast/runCalibration'
import { buildRunCalibration } from '../shared/forecast/runCalibration'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const MODELS = join(PROFILE, 'forecastModels')
const RUN = process.env.RUN ?? (JSON.parse(readFileSync(join(MODELS, 'current.json'), 'utf-8')) as { foldsRunId?: string; runId: string }).foldsRunId ?? ''
if (RUN === '') throw new Error('no walk forward in current.json; name one with RUN')

const pct = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined || !Number.isFinite(value) ? '   -  ' : `${(100 * value).toFixed(digits)}%`.padStart(7))
const interval = (made: { low: number; high: number } | null | undefined, digits = 2): string => (made === null || made === undefined ? '' : ` [${(100 * made.low).toFixed(digits)}, ${(100 * made.high).toFixed(digits)}]`)
const cells = (score: DirectionScore | null): string =>
  score === null
    ? `${'-'.padStart(7)} ${'-'.padEnd(26)} ${'-'.padStart(9)} ${'-'.padStart(6)} ${'-'.padEnd(24)}`
    : `${String(score.n).padStart(7)} ${(pct(score.directionSkill).trim() + interval(score.ci?.directionSkill)).padEnd(26)} ${pct(score.detectable ?? null)} ${String(score.calls).padStart(6)} ${(pct(score.precision, 1).trim() + interval(score.ci?.precision, 1)).padEnd(24)}`

console.log(`walk forward ${RUN} of ${PROFILE}`)
console.log('horizon    source                 outcomes skill [95%]                detectable calls  right [95%]              verdict                      P(up) of')
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
  if (record.directionModels === undefined) {
    console.log(`${horizon}: a record from before the direction models (${record.version}); refit to get one`)
    continue
  }
  const rows = rowsOf(record)
  // The distribution's P(up) as the calibration scores it: every model promoted, as the Lab's leaderboard
  // would have it, so the baseline is the ensemble's own reading.
  const promoted = new Set(record.models)
  const shown = scoreOutOfSample(rows, 'v2', promoted)
  const report = directionReportOf(rows, shown, horizon)
  if (report === null) continue
  // The source each class would read from, judged as the app judges it: through a calibration built the
  // same way, so that the choice is the app's own function on the same figures.
  const calibration = buildRunCalibration(new Map([[horizon, record]]), [...record.models].map((model) => ({ horizon, model, promoted: true, lines: [] })), RUN)
  const entry = calibration.horizons[horizon] as HorizonCalibration | undefined
  const inUse = new Map<string, string[]>()
  if (entry !== undefined) for (const cls of PAIR_CLASSES) {
    const { source } = directionSourceOf(entry, cls)
    inUse.set(source, [...(inUse.get(source) ?? []), cls])
  }
  const classesOf = (source: string): string => {
    const classes = inUse.get(source) ?? []
    return classes.length === 0 ? '-' : classes.length === PAIR_CLASSES.length ? 'every class' : classes.join(',')
  }
  console.log(`${horizon.padEnd(10)} ${'the distribution'.padEnd(22)} ${cells(report.baseline.pooled)}  ${'the floor'.padEnd(28)} ${classesOf('distribution')}`)
  for (const model of DIRECTION_MODELS) {
    const made = report.models[model]
    if (made === undefined) continue
    const failed = made.lines.filter((line) => line.ok === false).map((line) => line.id)
    const verdict = made.promoted ? 'promoted' : `not promoted: ${failed.join(',') || 'not measured'}`
    console.log(`${''.padEnd(10)} ${model.padEnd(22)} ${cells(made.honest.pooled)}  ${verdict.padEnd(28)} ${classesOf(model)}`)
  }
  console.log(`${''.padEnd(10)} ${'the base rate'.padEnd(22)} ${cells(null)}  ${''.padEnd(28)} ${classesOf('base')}`)
}
