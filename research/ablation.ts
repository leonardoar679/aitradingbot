// WHAT A BLOCK OF FIGURES ADDED (V7.2 Stage 4, 17 October 2026): the walk forward fitted twice on identical
// folds and seeds -- once with every block of figures, once with one block's columns held at their training
// mean (shared/forecast/ablation.ts) -- and the two forecasts paired row by row on the tested weeks: the pinball
// loss of the forecast shown (V2, every model weighed as the record's are), the 80% and 50% coverage, and each
// direction model's honest skill, calls and precision, each difference with its hour-clustered 90% interval
// (the paired bootstrap of V7.2 Stage 1) and the sign per tested week; and a CONTROL, the block's columns
// permuted across the tested weeks' rows, which must read near zero for the harness to mean anything. Two
// full fits must differ by zero at every row (the registered line V72-S4-ABLATION): the harness is
// deterministic by seed. One horizon at a time; a fit of one horizon's four folds takes minutes.
//
//   npx esbuild research/ablation.ts --bundle --platform=node --format=esm --outfile=research/.ablation.mjs
//   PROFILE=<a scratch profile with bars> [HORIZON=hour1] [BLOCK=clock] [CONTROL=1] [SELF=1] node research/.ablation.mjs
//
// It reads the profile's forecastData/*.jsonl; it writes forecastModels/ablation-<horizon>-<block>.json there
// (the figures, for the Lab's "What a block added" table) and nothing else; it asks nothing.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCK_COLUMNS, FEATURE_BLOCKS, maskBlocks, permuteBlock, type FeatureBlock } from '../shared/forecast/ablation'
import { barFromLine, coarseBars, mergeBars, type ForecastBar } from '../shared/forecast/bars'
import { CHALLENGER_LINES, pairedHorizonOf } from '../shared/forecast/challenger'
import { DIRECTION_LINES, calibratedPUp, fitPUp } from '../shared/forecast/direction'
import { ENSEMBLE_LINES } from '../shared/forecast/ensemble'
import { HORIZONS, PAIR_CLASSES, type Horizon, type PairSeries } from '../shared/forecast/features'
import { rngOf } from '../shared/forecast/ml/bins'
import { DIRECTION_MODELS, FORECAST_MODELS, fitHorizon, normalizedTarget, predictDirection, predictHorizon, type DirectionModelId } from '../shared/forecast/models'
import { buildPanel, type Panel } from '../shared/forecast/panel'
import { scoreOutOfSample, type Row, type ScoredRow } from '../shared/forecast/runCalibration'
import { MARKET_REGIMES } from '../shared/forecast/features'
import { foldRows, planFolds, rowsFor } from '../shared/forecast/walkForward'
import { usualMove } from '../shared/forecast/targets'
import { HORIZON_BARS } from '../shared/forecast/features'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const HORIZON = (process.env.HORIZON ?? 'hour1') as Horizon
if (!HORIZONS.includes(HORIZON)) throw new Error(`HORIZON must be one of ${HORIZONS.join(', ')}`)
const BLOCK = (process.env.BLOCK ?? 'clock') as FeatureBlock
if (!FEATURE_BLOCKS.includes(BLOCK)) throw new Error(`BLOCK must be one of ${FEATURE_BLOCKS.join(', ')}`)
const CONTROL = process.env.CONTROL !== '0'
const SELF = process.env.SELF !== '0'
const SEED = 20261013
/** The days of bars the first row needs, as the worker's panel keeps them (electron/forecast/trainWorker.ts). */
const WARMUP_DAYS = 26
const NOW = Number(process.env.NOW ?? Math.floor(Date.now() / 1000))

function loadMarket(dataDir: string): Map<string, PairSeries> {
  const byPair = new Map<string, ForecastBar[]>()
  for (const name of readdirSync(dataDir).sort()) {
    const symbol = /^([A-Z0-9]+)-\d{4}-\d{2}\.jsonl$/.exec(name)?.[1]
    if (symbol === undefined) continue
    const read: ForecastBar[] = []
    for (const line of readFileSync(join(dataDir, name), 'utf-8').split('\n')) {
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
  const market = new Map<string, PairSeries>()
  for (const [symbol, m5] of byPair) market.set(symbol, { m5, h1: coarseBars(m5, '1h', Number.POSITIVE_INFINITY) })
  return market
}

/** One tested row's forecast: every model's quantiles, every direction model's raw chance, the row. */
interface Tested {
  row: number
  fold: number
  quantiles: Record<string, number[]>
  direction: Record<DirectionModelId, number>
}

/** The walk forward of one horizon on a panel (masked or not): the tested rows with their forecasts, as the
 * worker makes them, the same folds and seeds. */
function walkForward(panel: Panel, horizon: Horizon, label: string): Tested[] {
  const first = panel.time[0] ?? 0
  const last = panel.time[panel.rows - 1] ?? 0
  const plan = planFolds(first, last)
  const rows = rowsFor(panel, horizon)
  const hIndex = HORIZONS.indexOf(horizon)
  const tested: Tested[] = []
  for (const fold of plan) {
    const started = Date.now()
    const { train, valid, test } = foldRows(panel, rows, horizon, fold)
    if (train.length === 0) continue
    const fitted = fitHorizon(panel, train, valid, horizon, SEED + hIndex * 100 + fold.index + 1)
    const row64 = new Float64Array(panel.cols)
    for (const row of test) {
      for (let col = 0; col < panel.cols; col++) row64[col] = panel.x[row * panel.cols + col]
      tested.push({ row, fold: fold.index, quantiles: predictHorizon(fitted, row64), direction: predictDirection(fitted, row64) })
    }
    console.log(`  ${label}: week ${fold.index + 1} of ${plan.length} fitted on ${train.length} rows, ${test.length} tested, ${((Date.now() - started) / 1000).toFixed(0)} s`)
  }
  return tested
}

/** The tested rows as the calibration's rows (hourly, as the record keeps them), scored out of sample. */
function scored(panel: Panel, tested: readonly Tested[], horizon: Horizon): { shown: ScoredRow[]; rows: Row[] } {
  const bars = HORIZON_BARS[horizon]
  const rows: Row[] = []
  for (const [at, entry] of tested.entries()) {
    if (panel.time[entry.row] % 3600 !== 0) continue
    const z = normalizedTarget(panel, entry.row, horizon)
    const usual = usualMove(panel.rv24h[entry.row], bars)
    if (!Number.isFinite(z) || !(usual > 0)) continue
    const direction: Partial<Record<DirectionModelId, number>> = {}
    for (const model of DIRECTION_MODELS) direction[model] = entry.direction[model]
    rows.push({ at, t: panel.time[entry.row], pair: panel.symbols[panel.pair[entry.row]], quantiles: entry.quantiles, z, cls: PAIR_CLASSES[panel.cls[entry.row]], regime: MARKET_REGIMES[panel.regime[entry.row]], fold: entry.fold, usual, direction })
  }
  return { shown: scoreOutOfSample(rows, 'v2', new Set(FORECAST_MODELS)), rows }
}

/** A direction model's honest figures on the scored weeks: skill, calls and precision, as runCalibration.ts reads them. */
function directionFigures(rows: readonly Row[], shown: readonly ScoredRow[], model: DirectionModelId): { n: number; skill: number; calls: number; precision: number } | null {
  const weeks = [...new Set(shown.filter((entry) => entry.pUp !== null).map((entry) => entry.week))].sort((a, b) => a - b)
  let n = 0
  let brier = 0
  let reference = 0
  let calls = 0
  let right = 0
  for (const week of weeks) {
    const earlier = rows.filter((row) => row.fold < week && row.direction?.[model] !== undefined)
    if (earlier.length < ENSEMBLE_LINES.minCellRows) continue
    const map = fitPUp(earlier.map((row) => ({ raw: row.direction![model]!, up: row.z > 0 })))
    const base = earlier.filter((row) => row.z > 0).length / earlier.length
    for (const row of rows) {
      const raw = row.direction?.[model]
      if (row.fold !== week || raw === undefined) continue
      const pUp = calibratedPUp(map, raw)
      const wentUp = row.z > 0 ? 1 : 0
      n++
      brier += (pUp - wentUp) ** 2
      reference += (base - wentUp) ** 2
      const bull = pUp >= DIRECTION_LINES.bullish
      const bear = pUp <= 1 - DIRECTION_LINES.bullish
      if ((bull || bear) && row.z !== 0) {
        calls++
        if (bull === row.z > 0) right++
      }
    }
  }
  return n === 0 ? null : { n, skill: 1 - brier / Math.min(0.25 * n, reference), calls, precision: calls > 0 ? right / calls : Number.NaN }
}

const signed = (value: number, digits = 2, scale = 100): string => `${value >= 0 ? '+' : ''}${(value * scale).toFixed(digits)}`
const figure = (made: { difference: number; low: number; high: number }, digits = 2, scale = 100): string => `${signed(made.difference, digits, scale)} [${signed(made.low, digits, scale)}, ${signed(made.high, digits, scale)}]`

const started = Date.now()
const market = loadMarket(join(PROFILE, 'forecastData'))
const btc = market.get('BTCUSDT')
if (btc === undefined || btc.m5.length === 0) throw new Error('no Bitcoin bars on file')
const panel = buildPanel(market, { stepSec: 900, fromSec: btc.m5[0].time + WARMUP_DAYS * 86_400, toSec: NOW })
console.log(`${PROFILE}: ${panel.rows} rows of ${panel.cols} figures over ${panel.symbols.length} pairs; the ${BLOCK} block is columns ${BLOCK_COLUMNS[BLOCK][0]}-${BLOCK_COLUMNS[BLOCK][BLOCK_COLUMNS[BLOCK].length - 1]} (${BLOCK_COLUMNS[BLOCK].length}); ${HORIZON}`)

console.log('the full fit:')
const full = walkForward(panel, HORIZON, 'every block')
if (SELF) {
  console.log('the full fit again (determinism):')
  const again = walkForward(panel, HORIZON, 'every block again')
  let differing = 0
  for (const [at, entry] of full.entries()) {
    const other = again[at]
    if (other === undefined || other.row !== entry.row) {
      differing++
      continue
    }
    for (const model of FORECAST_MODELS) for (let k = 0; k < 5; k++) if (entry.quantiles[model][k] !== other.quantiles[model][k]) differing++
  }
  console.log(`  two full fits differ at ${differing} figures of ${full.length} rows (the line: zero)`)
}
// The block held at its training mean: the mask uses the first fold's training rows, the same for every fold.
const firstFold = planFolds(panel.time[0] ?? 0, panel.time[panel.rows - 1] ?? 0)[0]
const trainRows = firstFold === undefined ? new Uint32Array() : foldRows(panel, rowsFor(panel, HORIZON), HORIZON, firstFold).train
const keep = FEATURE_BLOCKS.filter((block) => block !== BLOCK)
console.log(`without the ${BLOCK} block (held at the mean of ${trainRows.length} training rows):`)
const without = walkForward(maskBlocks(panel, keep, trainRows), HORIZON, `without ${BLOCK}`)

const a = scored(panel, full, HORIZON)
const b = scored(panel, without, HORIZON)
const paired = pairedHorizonOf(b.shown, a.shown, HORIZON, { ...CHALLENGER_LINES, level: 0.9 })
console.log(`\n${HORIZON}, the ${BLOCK} block's worth (every block, against the block held at its mean; each figure is what the block SAVED or ADDED, a positive one meaning the block helped):`)
if (paired === null) console.log('  nothing to pair')
else {
  console.log(`  ${paired.hours} shared hours in ${paired.blocks} blocks`)
  console.log(`  pinball (x1):                 ${figure({ difference: -paired.pinball.difference, low: -paired.pinball.high, high: -paired.pinball.low }, 4, 1)}  ${paired.pinball.better ? '(the block hurt beyond noise and the floor)' : paired.pinball.worse ? '(the block helped beyond noise and the floor)' : '(within noise or under the floor)'}`)
  console.log(`  80% distance from 80% (pts):  ${figure({ difference: -paired.coverageDistance.difference, low: -paired.coverageDistance.high, high: -paired.coverageDistance.low })}`)
  if (paired.directionSkill !== null) console.log(`  direction skill added (pts):  ${figure(paired.directionSkill)}`)
}
console.log('  direction models, every block against without the block (honest skill / calls / right):')
for (const model of DIRECTION_MODELS) {
  const withBlock = directionFigures(a.rows, a.shown, model)
  const without2 = directionFigures(b.rows, b.shown, model)
  if (withBlock === null || without2 === null) continue
  console.log(`    ${model.padEnd(14)} ${signed(withBlock.skill)}% / ${withBlock.calls} / ${(100 * withBlock.precision).toFixed(1)}%   against   ${signed(without2.skill)}% / ${without2.calls} / ${(100 * without2.precision).toFixed(1)}%`)
}

let control: ReturnType<typeof pairedHorizonOf> = null
if (CONTROL) {
  // The control: the block's columns permuted across the tested rows, the fit otherwise the same.
  const plan = planFolds(panel.time[0] ?? 0, panel.time[panel.rows - 1] ?? 0)
  const testedRows = Uint32Array.from(Array.from(rowsFor(panel, HORIZON)).filter((row) => plan.some((fold) => panel.time[row] >= fold.from && panel.time[row] < fold.to)))
  console.log(`the control (the ${BLOCK} block permuted across the ${testedRows.length} tested rows):`)
  const permuted = walkForward(permuteBlock(panel, BLOCK, testedRows, rngOf(SEED)), HORIZON, `${BLOCK} permuted`)
  const c = scored(panel, permuted, HORIZON)
  control = pairedHorizonOf(c.shown, a.shown, HORIZON, { ...CHALLENGER_LINES, level: 0.9 })
  if (control !== null) console.log(`  pinball, every block against the permuted block (x1): ${figure({ difference: -control.pinball.difference, low: -control.pinball.high, high: -control.pinball.low }, 4, 1)} (the line: under 0.2% of the loss in absolute value)`)
}

const out = { version: 'ablation-v1', horizon: HORIZON, block: BLOCK, madeAt: NOW, rows: full.length, paired, control, seconds: Math.round((Date.now() - started) / 1000) }
mkdirSync(join(PROFILE, 'forecastModels'), { recursive: true })
writeFileSync(join(PROFILE, 'forecastModels', `ablation-${HORIZON}-${BLOCK}.json`), JSON.stringify(out, null, 2))
console.log(`written forecastModels/ablation-${HORIZON}-${BLOCK}.json in ${out.seconds} s`)
