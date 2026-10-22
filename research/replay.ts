// THE REPLAY OUT OF SAMPLE, from a profile (V7.2-R Stage 5, 22 October 2026; shared/forecast/replay.ts). A walk
// forward's tested weeks after the first, each forecast at every five-minute close with that week's own models and a
// calibration made from the weeks before it alone, through the forecast's pure pass; the two strategies that need no
// way (shared/forecast/rangeStrategies.ts) and the laboratory's four played on the bars after each quarter-hour's
// forecasts; each line written in the record's own formats, stamped with its sample, and each strategy's figures with
// their intervals and the registered lines' verdicts (V72R-S5-BAND, V72R-S5-GRID, V72R-S5-LAB).
//
//   npx esbuild research/replay.ts --bundle --platform=node --format=esm --outfile=research/.replay.mjs
//   PROFILE=<profile> [RUN=<walk forward>] [OUT=<folder>] [BLIND=1] [IN_SAMPLE=1] [AFTER_FIT=0] [QUANT=0] node research/.replay.mjs
//
// RUN defaults to the newest walk forward on file that kept its weeks' models. BLIND=1 prints the counts, the time and
// the files' hashes and no figure of what any strategy made: how the replay was checked before its lines were
// registered. IN_SAMPLE=1 replays the run's final models over the same weeks instead -- in sample, every P&L refused.
// AFTER_FIT=0 leaves out the stretch after the run was fitted (out of sample for its final models and calibration). It
// reads the profile and writes only into OUT (default: <profile>-replay-<run> beside the profile).
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { preEventAt } from '../shared/calendar/macro'
import type { Candle } from '../shared/ipc'
import { barFromLine, coarseBars, mergeBars, type ForecastBar } from '../shared/forecast/bars'
import { parseRunCalibration } from '../shared/forecast/calibrationFile'
import { HORIZONS, type Horizon, type PairSeries } from '../shared/forecast/features'
import { FOLD_MODEL_PATTERN, foldModelName, parseFitted } from '../shared/forecast/modelFile'
import type { FittedHorizon } from '../shared/forecast/models'
import { decodeOos, type OosRecord } from '../shared/forecast/oosRecord'
import { REPLAY_LINES, forwardCalibrations, runReplay, type CellFigures, type ReplaySegment, type ReplaySink } from '../shared/forecast/replay'
import type { Promotion } from '../shared/forecast/training'
import type { Fold } from '../shared/forecast/walkForward'
import { quantSideAt } from '../src/agents/quantState'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the profile to replay')
const MODELS = join(PROFILE, 'forecastModels')
const BLIND = process.env.BLIND === '1'
const IN_SAMPLE = process.env.IN_SAMPLE === '1'
const AFTER_FIT = process.env.AFTER_FIT !== '0'
const QUANT = process.env.QUANT !== '0'

const clock = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
const pct = (value: number | null | undefined, digits = 3): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`)

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

/** The walk forwards on file that kept their weeks' models, newest first. */
function runsWithWeeks(): string[] {
  return readdirSync(MODELS)
    .filter((name) => /^run-\d{8}-\d{4}$/.test(name) && readdirSync(join(MODELS, name)).some((file) => FOLD_MODEL_PATTERN.test(file)))
    .sort()
    .reverse()
}

/** The training log's line for a run's walk forward: its weeks and the members it promoted. */
function walkForwardLine(runId: string): { folds: Fold[]; promotions: Promotion[]; kind: string; at: string } {
  const names = readdirSync(MODELS).filter((name) => /^training-\d{4}-\d{2}\.jsonl$/.test(name)).sort()
  for (const name of names.reverse()) {
    for (const line of readFileSync(join(MODELS, name), 'utf-8').split('\n').reverse()) {
      if (!line.includes(runId)) continue
      try {
        const read = JSON.parse(line) as { runId?: string; kind?: string; at?: string; folds?: Fold[]; promotions?: Promotion[] }
        if (read.runId === runId && Array.isArray(read.folds) && Array.isArray(read.promotions)) return { folds: read.folds, promotions: read.promotions, kind: read.kind ?? '?', at: read.at ?? '?' }
      } catch {
        // A torn line: skipped.
      }
    }
  }
  throw new Error(`the training log holds no walk forward of ${runId} with its weeks and promotions`)
}

const RUN = process.env.RUN ?? runsWithWeeks()[0]
if (RUN === undefined) throw new Error(`no walk forward in ${MODELS} kept its weeks' models (V7.2 Stage 5 on)`)
const OUT = process.env.OUT ?? join(dirname(PROFILE), `${basename(PROFILE)}-replay-${RUN}${IN_SAMPLE ? '-in' : ''}`)
const walk = walkForwardLine(RUN)
console.log(`the walk forward ${RUN} (${walk.kind}, ${walk.at}): ${walk.folds.length} weeks, ${walk.folds.map((fold) => `${fold.index}: ${clock(fold.from)} .. ${clock(fold.to)}`).join('; ')}`)

const records = new Map<Horizon, OosRecord>()
for (const horizon of HORIZONS) {
  const file = join(MODELS, RUN, `oos-${horizon}.bin`)
  if (!existsSync(file)) continue
  const bytes = readFileSync(file)
  const record = decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  if (record !== null && record.horizon === horizon) records.set(horizon, record)
}
console.log(`its record: ${[...records.entries()].map(([horizon, record]) => `${horizon} ${record.rows} rows`).join(', ')}`)

const readModels = (name: (horizon: Horizon) => string): Map<Horizon, FittedHorizon> | null => {
  const out = new Map<Horizon, FittedHorizon>()
  for (const horizon of HORIZONS) {
    const file = join(MODELS, RUN, name(horizon))
    if (!existsSync(file)) return null
    const fitted = parseFitted(readFileSync(file, 'utf-8'))
    if (fitted === null) return null
    out.set(horizon, fitted)
  }
  return out
}

const segments: ReplaySegment[] = []
const weeks = walk.folds.map((fold) => fold.index).filter((index) => index >= 1)
if (IN_SAMPLE) {
  const finals = readModels((horizon) => `${horizon}.json`)
  const calibration = parseRunCalibration(readFileSync(join(MODELS, RUN, 'calibration.json'), 'utf-8'))
  if (finals === null || calibration === null) throw new Error(`the final models or the calibration of ${RUN} cannot be read`)
  for (const fold of walk.folds.filter((entry) => entry.index >= 1)) segments.push({ sample: 'in', label: `week ${fold.index + 1} of ${walk.folds.length}, the final models (in sample)`, from: fold.from, to: fold.to, models: finals, calibration, runId: RUN })
} else {
  const calibrations = forwardCalibrations(records, walk.promotions, RUN, weeks)
  for (const fold of walk.folds) {
    if (fold.index < 1) continue
    const models = readModels((horizon) => foldModelName(fold.index, horizon))
    const calibration = calibrations.get(fold.index)
    if (models === null || calibration === undefined) {
      console.log(`  week ${fold.index + 1}: ${models === null ? 'its models are not all on file' : 'no calibration from the weeks before'} -- not replayed`)
      continue
    }
    segments.push({ sample: 'out', label: `week ${fold.index + 1} of ${walk.folds.length}`, from: fold.from, to: fold.to, models, calibration, runId: `${RUN}/fold-${fold.index}` })
  }
}

const bars = loadBars()
const lastBar = Math.max(...[...bars.values()].map((series) => (series.length === 0 ? 0 : series[series.length - 1].time + 300)))
const fitEnd = Math.max(...walk.folds.map((fold) => fold.to))
if (!IN_SAMPLE && AFTER_FIT && lastBar - fitEnd >= 86_400) {
  const finals = readModels((horizon) => `${horizon}.json`)
  const calibration = parseRunCalibration(readFileSync(join(MODELS, RUN, 'calibration.json'), 'utf-8'))
  if (finals !== null && calibration !== null) segments.push({ sample: 'out', label: 'after the fit, the final models', from: fitEnd, to: lastBar - REPLAY_LINES.settleTailSec, models: finals, calibration, runId: RUN })
}
console.log(`${bars.size} pairs of bars on file to ${clock(lastBar)}; segments: ${segments.map((segment) => `${segment.label} [${segment.sample}] ${clock(segment.from)} .. ${clock(segment.to)}`).join('; ')}`)
if (segments.length === 0) throw new Error('nothing to replay')

// Trend Regime 4h's side, from the four-hour bars the five-minute ones make: the hybrid's reading. Its slowest
// average is eighty days long, so it reads nothing until eighty days of bars are on file before the moment.
const quantSide = QUANT
  ? (_pair: string, series: PairSeries, nowSec: number): 'long' | 'short' | null => {
      const candles: Candle[] = coarseBars(series.m5, '4h', nowSec).map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }))
      const side = quantSideAt('trend4h', candles, nowSec)
      return side === 'long' || side === 'short' ? side : null
    }
  : undefined

// The lines, written as made into files of the record's own names.
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const files = new Map<string, number>()
const write = (name: string, value: unknown): void => {
  let fd = files.get(name)
  if (fd === undefined) {
    fd = openSync(join(OUT, name), 'w')
    files.set(name, fd)
  }
  writeSync(fd, `${JSON.stringify(value)}\n`)
}
const month = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 7)
const sink: ReplaySink = {
  prediction: (line) => write(`predictions-${month(line.t)}.jsonl`, line),
  outcome: (line) => write(`outcomes-${month(line.t)}.jsonl`, line),
  pass: (line) => write(`passes-${month(line.t)}.jsonl`, line),
  trade: (trade) => write('trades.jsonl', trade)
}

const started = Date.now()
let told = 0
const summary = runReplay(
  {
    bars,
    segments,
    preEvent: preEventAt,
    ...(quantSide === undefined ? {} : { quantSide }),
    onClose: (closedAt, done, total) => {
      if (done - told >= 288 || done === total) {
        told = done
        process.stderr.write(`  ${clock(closedAt)}: ${done} of ${total} closes, ${((Date.now() - started) / 1000).toFixed(0)} s\n`)
      }
    }
  },
  sink
)
const seconds = (Date.now() - started) / 1000
write('summary.json', summary)
for (const fd of files.values()) closeSync(fd)

// What the files hold, for two replays to be set side by side.
const hashes = [...files.keys()].sort().map((name) => {
  const bytes = readFileSync(join(OUT, name))
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
})
const whole = createHash('sha256')
for (const entry of hashes) whole.update(`${entry.name} ${entry.sha256}\n`)
console.log(`\nreplayed ${summary.closes} closes in ${seconds.toFixed(0)} s (${(summary.closes / seconds).toFixed(1)} a second): ${summary.forecasts} forecasts, ${summary.outcomes} outcomes, into ${OUT}`)
for (const entry of hashes) console.log(`  ${entry.name.padEnd(28)} ${String(entry.bytes).padStart(11)} bytes  ${entry.sha256.slice(0, 16)}`)
console.log(`the replay's fingerprint: ${whole.digest('hex').slice(0, 16)}`)
console.log(`assumed: ${summary.assumptions.join('; ')}`)

const row = (cell: CellFigures): string => {
  const head = `${cell.cell.padEnd(14)} [${cell.sample}] ${String(cell.orders).padStart(6)} orders ${String(cell.trades).padStart(6)} trades`
  if (BLIND) return `${head}  (figures withheld: BLIND)`
  if (cell.sample === 'in') return `${head}  in sample: no P&L is read`
  const net = cell.net === null ? '-' : `${pct(cell.net.value)} [${pct(cell.net.low)}, ${pct(cell.net.high)}]`
  const base = cell.baseline === null ? '-' : `${pct(cell.baseline.value)} [${pct(cell.baseline.low)}, ${pct(cell.baseline.high)}]`
  return `${head}  net/trade ${net}  win ${cell.winRate === null ? '-' : (cell.winRate * 100).toFixed(1) + '%'}  PF ${cell.profitFactor === null ? '-' : cell.profitFactor.toFixed(2)}  cost ${pct(cell.meanCostPct)}  sum ${pct(cell.netSumPct, 1)}  dd ${pct(cell.maxDrawdownPct, 1)}  best 5% hours ${cell.bestHoursShare === null ? '-' : (cell.bestHoursShare * 100).toFixed(0) + '%'}  held long ${base}  -> ${cell.verdict.toUpperCase()}\n      exits ${JSON.stringify(cell.byExit)}  by state ${Object.entries(cell.byState).map(([state, figures]) => `${state} ${figures.trades} ${pct(figures.meanNetPct)}`).join(', ')}`
}
console.log('\nthe strategies (a trade\'s net after costs, in percent of its stake, with its 95% interval):')
for (const cell of summary.cells) console.log(`  ${row(cell)}`)
if (!BLIND) {
  console.log(`\nthe registered lines (at least ${REPLAY_LINES.minTrades} trades, the interval of the net a trade above zero):`)
  for (const cell of summary.cells.filter((entry) => entry.sample === 'out')) console.log(`  ${cell.cell.padEnd(14)} ${cell.verdict}`)
}
