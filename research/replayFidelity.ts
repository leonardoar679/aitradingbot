// REPLAY FIDELITY (V7.2 Stage 5, 18 October 2026): a profile's record -- every forecast the live app made
// and recorded, grid and refresh -- replayed through the pure pass (shared/forecast/pass.ts) from the
// profile's own bars, the run's model files and its calibration, with no live book, no news and no class
// verdicts, and compared at every quarter-hour close on V2's own levels to four decimals
// (shared/forecast/fidelity.ts). The registered line V72-S5-FIDELITY: at least 99% of the grid forecasts
// replay; every remainder listed with its reason.
//
//   npx esbuild research/replayFidelity.ts --bundle --platform=node --format=esm --outfile=research/.replayFidelity.mjs
//   PROFILE=<a scratch profile with a record> [RUN=<models run>] [FOLDS=<walk forward>] [FROM=<sec>] [TO=<sec>] node research/.replayFidelity.mjs
//
// The run and the walk forward default to the ones the record's forecasts name. A calibration file of another
// version is made again from the walk forward's record with the promotions current.json holds for it, and
// said so: V2's weights and maps are the same arithmetic, so the levels should still agree. Models of another
// version cannot be read, and the check stops there. It reads the profile and writes nothing.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { preEventAt } from '../shared/calendar/macro'
import { parseAciTable, type AciTable } from '../shared/forecast/aciTable'
import { barFromLine, mergeBars, type ForecastBar } from '../shared/forecast/bars'
import { parseRunCalibration } from '../shared/forecast/calibrationFile'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import { FIDELITY_LINES, replayFidelity, type Remainder } from '../shared/forecast/fidelity'
import { isMissing, parseOutcomeLine, parsePassLine, parsePredictionLine, type PredictionLine } from '../shared/forecast/forecastRecord'
import { parseFitted } from '../shared/forecast/modelFile'
import type { FittedHorizon } from '../shared/forecast/models'
import { decodeOos, type OosRecord } from '../shared/forecast/oosRecord'
import { buildRunCalibration, type RunCalibration } from '../shared/forecast/runCalibration'
import type { Promotion } from '../shared/forecast/training'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const MODELS = join(PROFILE, 'forecastModels')
const RECORDS = join(PROFILE, 'forecasts')
const FROM = process.env.FROM === undefined || process.env.FROM === '' ? undefined : Number(process.env.FROM)
/** The profile's own adaptive levels, as last written: the replay ends at the moment that last moved them unless
 * TO says otherwise, so that the two tables can be set side by side. */
let liveAci: AciTable | null = null
try {
  liveAci = parseAciTable(JSON.parse(readFileSync(join(PROFILE, 'forecasts', 'aci.json'), 'utf-8')))
} catch {
  liveAci = null
}
const TO = process.env.TO === undefined || process.env.TO === '' ? (liveAci === null || liveAci.updatedAt === 0 ? undefined : liveAci.updatedAt) : Number(process.env.TO)

const pct = (value: number, digits = 2): string => `${(100 * value).toFixed(digits)}%`
const clock = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')

/** The record's lines of a kind, every month file, in file order. */
function readRecord<T>(kind: 'predictions' | 'passes' | 'outcomes', parse: (value: unknown) => T | null): T[] {
  const out: T[] = []
  const names = readdirSync(RECORDS)
    .filter((name) => new RegExp(`^${kind}-\\d{4}-\\d{2}\\.jsonl$`).test(name))
    .sort()
  for (const name of names) {
    for (const line of readFileSync(join(RECORDS, name), 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const read = parse(JSON.parse(line))
        if (read !== null) out.push(read)
      } catch {
        // A torn line: skipped.
      }
    }
  }
  return out
}

/** The bars on file, by pair. */
function loadBars(): Map<string, ForecastBar[]> {
  const dir = join(PROFILE, 'forecastData')
  const byPair = new Map<string, ForecastBar[]>()
  for (const name of readdirSync(dir).sort()) {
    const symbol = /^([A-Z0-9]+)-\d{4}-\d{2}\.jsonl$/.exec(name)?.[1]
    if (symbol === undefined) continue
    const read: ForecastBar[] = []
    for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const bar = barFromLine(JSON.parse(line))
        if (bar !== null) read.push(bar)
      } catch {
        // A torn line: skipped.
      }
    }
    byPair.set(symbol, mergeBars(byPair.get(symbol) ?? [], read))
  }
  return byPair
}

const all = readRecord('predictions', parsePredictionLine)
const passes = readRecord('passes', parsePassLine)
if (all.length === 0) throw new Error(`no forecasts on record in ${RECORDS}`)

// The run and the walk forward the record names most: a record of one run names one pair of them.
const named = new Map<string, number>()
for (const line of all) named.set(`${line.run}|${line.foldsRun}`, (named.get(`${line.run}|${line.foldsRun}`) ?? 0) + 1)
const [commonest] = [...named.entries()].sort((a, b) => b[1] - a[1])[0]
const RUN = process.env.RUN ?? commonest.split('|')[0]
const FOLDS = process.env.FOLDS ?? commonest.split('|')[1]
const predictions: PredictionLine[] = all.filter((line) => line.run === RUN && line.foldsRun === FOLDS).sort((a, b) => a.t - b.t)
console.log(`the record: ${all.length} forecasts (${named.size} run pairs: ${[...named.entries()].map(([key, count]) => `${key.replace('|', ' on ')} x${count}`).join(', ')}); replaying ${predictions.length} of ${RUN} on ${FOLDS}, ${passes.length} passes`)

const models = new Map<Horizon, FittedHorizon>()
for (const horizon of HORIZONS) {
  const text = readFileSync(join(MODELS, RUN, `${horizon}.json`), 'utf-8')
  const fitted = parseFitted(text)
  if (fitted === null) throw new Error(`the models of ${RUN} at ${horizon} are of another version or damaged: the engine cannot replay them`)
  models.set(horizon, fitted)
}

let calibration: RunCalibration | null = parseRunCalibration(readFileSync(join(MODELS, FOLDS, 'calibration.json'), 'utf-8'))
let calibrationNote = 'read from its file'
if (calibration === null) {
  const current = JSON.parse(readFileSync(join(MODELS, 'current.json'), 'utf-8')) as { runId: string; foldsRunId: string | null; promotions: Promotion[]; previous?: { foldsRunId: string | null; promotions: Promotion[] } | null }
  const promotions = current.foldsRunId === FOLDS ? current.promotions : current.previous?.foldsRunId === FOLDS ? current.previous.promotions : null
  if (promotions === null) throw new Error(`the calibration of ${FOLDS} is of another version and current.json holds no promotions for it`)
  const records = new Map<Horizon, OosRecord>()
  for (const horizon of HORIZONS) {
    const bytes = readFileSync(join(MODELS, FOLDS, `oos-${horizon}.bin`))
    const record = decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    if (record !== null && record.horizon === horizon) records.set(horizon, record)
  }
  if (records.size === 0) throw new Error(`no out-of-sample record of ${FOLDS} to make its calibration again from`)
  calibration = buildRunCalibration(records, promotions, FOLDS)
  calibrationNote = 'MADE AGAIN from the walk forward\'s record with current.json\'s promotions (the file is of another version)'
}
console.log(`the calibration of ${FOLDS}: ${calibrationNote}`)

// THE CLOSES THE LIVE RUN SETTLED EACH OUTCOME AT: since V7.2 Stage 5 an outcome line says it (OutcomeLine.at),
// and the replay settles an outcome whose bars came late at the same later close, so that the adaptive levels
// take the steps the live run's took. A record from before carries no moment, and the replay settles every
// outcome when due; the order of the outcomes file cannot tell the two apart (a batch of newer forecasts alone
// reads the same whether the close before it was passed or skipped), so nothing is inferred from it.
const outcomes = readRecord('outcomes', parseOutcomeLine)
const withMoment = outcomes.filter((line) => !isMissing(line) && line.at !== undefined)
const late = withMoment.filter((line) => !isMissing(line) && line.at! > line.due)
console.log(`the outcomes on record: ${outcomes.length}, ${withMoment.length} saying the close they were settled at, ${late.length} of them settled after their due moment (their bars came late)${withMoment.length === 0 ? ' -- a record from before V7.2 Stage 5: every outcome replays when due' : ''}`)

const bars = loadBars()
console.log(`${bars.size} pairs of bars on file`)
const started = Date.now()
let lastTold = 0
const report = replayFidelity({
  bars,
  models,
  calibration,
  runId: RUN,
  predictions,
  passes,
  from: FROM,
  to: TO,
  preEvent: preEventAt,
  outcomes,
  onClose: (closedAt, done, total) => {
    if (done - lastTold >= 36 || done === total) {
      lastTold = done
      process.stderr.write(`  ${clock(closedAt)}: ${done} of ${total} closes, ${((Date.now() - started) / 1000).toFixed(0)} s\n`)
    }
  }
})

console.log(`\nreplayed ${report.closes} five-minute closes from ${clock(report.from)} to ${clock(report.to)} in ${((Date.now() - started) / 1000).toFixed(0)} s`)
console.log(`${report.matched} of ${report.lines} grid horizon lines replay to ${FIDELITY_LINES.decimals} decimals on V2's own levels: ${pct(report.share)} (the line asks ${pct(FIDELITY_LINES.share, 0)})`)
for (const horizon of HORIZONS) {
  const mine = report.byHorizon[horizon]
  if (mine === undefined) continue
  console.log(`  ${horizon.padEnd(10)} ${String(mine.matched).padStart(6)} of ${String(mine.lines).padStart(6)}  ${pct(mine.matched / mine.lines).padStart(8)}   P(up) to three decimals ${pct(mine.pUpMatched / mine.lines)}`)
}
if (report.states !== null) console.log(`the market's state agrees on ${report.states.matched} of ${report.states.lines} lines (${pct(report.states.matched / report.states.lines)})`)
else console.log("the record carries no market state (made before V7.1 Stage 11)")
console.log(`remainders by reason: ${JSON.stringify(report.byReason)}`)
const byPair = new Map<string, number>()
for (const entry of report.remainders) byPair.set(entry.pair, (byPair.get(entry.pair) ?? 0) + 1)
if (byPair.size > 0) console.log(`remainders by pair: ${[...byPair.entries()].sort((a, b) => b[1] - a[1]).map(([pair, count]) => `${pair} ${count}`).join(', ')}`)
// Each remainder's levels as recorded and as replayed, with the ratio of the two at each level: a ratio the same
// at every level is the usual move (the day's volatility) differing; ratios that differ by level are the levels'
// own, the models' or the adaptive step's.
const show = (entry: Remainder): string => {
  const ratios = entry.replayed === null ? '' : `  ratios ${entry.replayed.map((value, k) => (entry.recorded[k] === 0 ? '-' : (value / entry.recorded[k]).toFixed(5))).join(' ')}`
  return `  ${entry.pair.padEnd(10)} ${clock(entry.t)} ${entry.horizon.padEnd(9)} ${entry.reason.padEnd(13)} ${entry.maxDiff === null ? '' : `largest difference ${entry.maxDiff.toFixed(4)} points`}\n    recorded ${entry.recorded.map((value) => value.toFixed(4)).join(' ')}\n    replayed ${entry.replayed === null ? '-' : entry.replayed.map((value) => value.toFixed(4)).join(' ')}${ratios}`
}
for (const entry of report.remainders.slice(0, 12)) console.log(show(entry))
if (report.remainders.length > 12) console.log(`  ... and ${report.remainders.length - 12} more`)
// How the differences are spread over time: remainders by the hour of the record.
const byHour = new Map<string, number>()
for (const entry of report.remainders) byHour.set(clock(entry.t).slice(0, 13), (byHour.get(clock(entry.t).slice(0, 13)) ?? 0) + 1)
console.log(`remainders by hour: ${[...byHour.entries()].map(([hour, count]) => `${hour.slice(5)}h ${count}`).join(', ')}`)
// The adaptive levels at the end of the replay against the profile's own table, cell by cell: where the two
// differ is where the steps were not the same.
if (liveAci !== null && report.aci !== null && liveAci.calibrationRun === report.aci.calibrationRun) {
  const keys = new Set([...Object.keys(liveAci.levels), ...Object.keys(report.aci.levels)])
  const differing: { key: string; deltas: number[] }[] = []
  for (const key of [...keys].sort()) {
    const live = liveAci.levels[key as keyof typeof liveAci.levels] ?? [0.1, 0.25, 0.5, 0.75, 0.9]
    const mine = report.aci.levels[key as keyof typeof report.aci.levels] ?? [0.1, 0.25, 0.5, 0.75, 0.9]
    const deltas = live.map((tau, k) => mine[k] - tau)
    if (deltas.some((delta) => Math.abs(delta) > 1e-9)) differing.push({ key, deltas })
  }
  console.log(`\nthe adaptive levels at ${clock(report.to)} (the profile's table last moved at ${clock(liveAci.updatedAt)}): ${keys.size} cells, ${differing.length} differing`)
  for (const entry of differing.slice(0, 24)) console.log(`  ${entry.key.padEnd(26)} replay - live: ${entry.deltas.map((delta) => (delta >= 0 ? '+' : '') + delta.toFixed(5)).join('  ')}`)
  if (differing.length > 24) console.log(`  ... and ${differing.length - 24} more`)
} else if (liveAci !== null) console.log(`\nthe profile's adaptive levels belong to ${liveAci.calibrationRun}, not to the run replayed`)

console.log(`\nthe registered line V72-S5-FIDELITY ${report.passed ? 'HELD' : 'FAILED'}: ${pct(report.share)} of ${report.lines} lines replay (${pct(FIDELITY_LINES.share, 0)} asked)`)
