// NEW INFORMATION FOR THE WAY, JUDGED AS BLOCKS (V7.2-R Stage 7, 22 October 2026; shared/forecast/blocksV3.ts). The
// long walk forward's expanding mode fitted again on identical folds, seeds and rows with a block of figures appended to
// every row -- CROSS and FLOW together, or POSITIONING from the futures archive -- and again with the block's columns
// shuffled across the rows (the permuted control), each compared with the walk forward on the forecast's own figures
// (research/longWalkForward.ts, its long-expanding record): the shown forecast's pinball, paired by hour; its coverage;
// each direction model's verdict by the direction bar with and without the block. Registered before it was run:
// V72R-S7-CROSSFLOW, V72R-S7-POSITIONING.
//
//   npx esbuild research/blockAblation.ts --bundle --platform=node --format=esm --outfile=research/.blockAblation.mjs
//   ARCHIVE=<archive-profile> BLOCKS=cross,flow|positioning [PERMUTE=1] [COMPARE=1] [OUT=<folder>] node --max-old-space-size=8192 research/.blockAblation.mjs
//
// COMPARE=1 reads the block's record already written and compares it alone. It reads the archive and writes only into OUT.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { preEventAt } from '../shared/calendar/macro'
import { barFromLine, coarseBars, mergeBars, type ForecastBar } from '../shared/forecast/bars'
import { BLOCKS_V3, BLOCK_NAMES, permuteColumns, widenPanel, type BlockV3, type PairPositioning } from '../shared/forecast/blocksV3'
import { pairedHorizonOf } from '../shared/forecast/challenger'
import { HORIZONS, PAIR_CLASSES, type Horizon, type PairClass, type PairSeries } from '../shared/forecast/features'
import { MARKET_SHOCK_STATES, STATE_UNKNOWN, btcTimelineOf, marketShockByTime, shockMomentsOf } from '../shared/forecast/marketShock'
import { DIRECTION_MODELS, FORECAST_MODELS, fitHorizon, normalizedTarget, predictDirection, predictExcursion, predictHorizon, type DirectionModelId, type ForecastModelId } from '../shared/forecast/models'
import { OOS_VERSION, decodeOos, encodeOos, oosQuantiles, type OosRecord } from '../shared/forecast/oosRecord'
import { buildPanel, type Panel } from '../shared/forecast/panel'
import { buildRunCalibration, rowsOf, scoreOutOfSample, type RunCalibration, type ScoredRow } from '../shared/forecast/runCalibration'
import { btc15ByTime } from '../shared/forecast/shock'
import { promotionsOf, type Promotion } from '../shared/forecast/training'
import { finalSplit, knownBefore, planFolds, rowsFor, scoreRows, type Fold, type ModelScore } from '../shared/forecast/walkForward'

const ARCHIVE = process.env.ARCHIVE ?? ''
if (ARCHIVE === '') throw new Error('ARCHIVE is the folder research/fetch-forecast-archive.mjs wrote into')
const BLOCKS = (process.env.BLOCKS ?? '').split(',').filter((name) => name !== '') as BlockV3[]
if (BLOCKS.length === 0 || !BLOCKS.every((block) => (BLOCKS_V3 as readonly string[]).includes(block))) throw new Error(`BLOCKS is a list of ${BLOCKS_V3.join(', ')}`)
const PERMUTE = process.env.PERMUTE === '1'
const COMPARE = process.env.COMPARE === '1'
const OUT = process.env.OUT ?? join(ARCHIVE, 'longWalkForward')
const NAME = `block-${BLOCKS.join('-')}${PERMUTE ? '-permuted' : ''}`
/** HORIZONS fits those horizons alone (22 October 2026: a run stopped by the two-hour limit on a background command is
 * finished horizon by horizon; each horizon's record is its own file, and COMPARE=1 reads them all). */
const FIT = process.env.HORIZONS === undefined ? HORIZONS : (process.env.HORIZONS.split(',') as Horizon[])
// The long walk forward's own lines (research/longWalkForward.ts): its seed, folds and window.
const SEED = 20261013
const LONG_FOLDS = { folds: 8, foldDays: 28, minTrainDays: 90 }
const WARMUP_DAYS = 26
const clock = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
const started = Date.now()
const elapsed = (): string => `${((Date.now() - started) / 60_000).toFixed(1)} min`

const dir = join(ARCHIVE, 'forecastArchive')
const byPair = new Map<string, ForecastBar[]>()
for (const name of readdirSync(dir).sort()) {
  const symbol = /^([A-Z0-9]+)-\d{4}-\d{2}\.jsonl$/.exec(name)?.[1]
  if (symbol === undefined) continue
  const read: ForecastBar[] = []
  for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
    if (line.trim() === '') continue
    const bar = barFromLine(JSON.parse(line))
    if (bar !== null) read.push(bar)
  }
  byPair.set(symbol, mergeBars(byPair.get(symbol) ?? [], read))
}
const market = new Map<string, PairSeries>()
for (const [symbol, m5] of byPair) market.set(symbol, { m5, h1: coarseBars(m5, '1h', Number.POSITIVE_INFINITY) })
const btc = market.get('BTCUSDT')!
const lastBar = Math.max(...[...market.values()].map((series) => series.m5[series.m5.length - 1].time + 300))
const narrow: Panel = buildPanel(market, { stepSec: 3600, fromSec: btc.m5[0].time + WARMUP_DAYS * 86_400, toSec: lastBar })
const first = narrow.time[0]
const last = narrow.time[narrow.rows - 1]
const plan: Fold[] = planFolds(first, last, LONG_FOLDS)
console.log(`${NAME}: the panel ${narrow.rows} rows of ${narrow.symbols.length} pairs, ${clock(first)} to ${clock(last)}, ${plan.length} folds (${elapsed()})`)

// The futures archive (research/fetch-positioning.mjs), each pair under its perpetual's name where it differs.
const positioning = new Map<string, PairPositioning>()
if (BLOCKS.includes('positioning')) {
  const folder = join(ARCHIVE, 'positioning')
  for (const symbol of narrow.symbols) {
    for (const perp of [symbol, `1000${symbol}`]) {
      const metrics = join(folder, `${perp}-metrics.json`)
      if (!existsSync(metrics)) continue
      const read = (kind: string): (number | null)[][] => {
        const file = join(folder, `${perp}-${kind}.json`)
        return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as (number | null)[][]).sort((a, b) => (a[0] as number) - (b[0] as number)) : []
      }
      positioning.set(symbol, { metrics: read('metrics'), premium: read('premium-5m'), funding: read('funding') })
      break
    }
  }
  console.log(`positioning read for ${positioning.size} pairs: ${[...positioning.keys()].join(' ')}`)
}

const wide0 = widenPanel(narrow, market, BLOCKS, positioning)
const panel = PERMUTE ? permuteColumns(wide0, narrow.cols, SEED) : wide0
console.log(`widened by ${BLOCKS.join(' and ')}: ${panel.cols - narrow.cols} columns (${BLOCKS.flatMap((block) => BLOCK_NAMES[block]).join(', ')})${PERMUTE ? ', shuffled across the rows' : ''} (${elapsed()})`)
const btc15 = btc15ByTime(narrow)
const states = marketShockByTime(narrow, shockMomentsOf(btcTimelineOf(btc, first - 5 * 3600, last)), preEventAt)
const row64 = new Float64Array(panel.cols)
const readRow = (row: number): Float64Array => {
  for (let col = 0; col < panel.cols; col++) row64[col] = panel.x[row * panel.cols + col]
  return row64
}

function recordOf(horizon: Horizon, tested: readonly { row: number; fold: number; quantiles: Record<ForecastModelId, number[]>; direction: Record<DirectionModelId, number>; excursion: { high: number[]; low: number[] } }[]): OosRecord {
  return {
    version: OOS_VERSION,
    horizon,
    symbols: panel.symbols,
    models: FORECAST_MODELS,
    rows: tested.length,
    time: Uint32Array.from(tested, (entry) => panel.time[entry.row]),
    pair: Uint16Array.from(tested, (entry) => panel.pair[entry.row]),
    cls: Uint8Array.from(tested, (entry) => panel.cls[entry.row]),
    regime: Uint8Array.from(tested, (entry) => panel.regime[entry.row]),
    fold: Uint8Array.from(tested, (entry) => entry.fold),
    z: Float32Array.from(tested, (entry) => normalizedTarget(panel, entry.row, horizon)),
    rv24h: Float32Array.from(tested, (entry) => panel.rv24h[entry.row]),
    y: Float32Array.from(tested, (entry) => panel.y[horizon][entry.row]),
    best: Float32Array.from(tested, (entry) => panel.best[horizon][entry.row]),
    worst: Float32Array.from(tested, (entry) => panel.worst[horizon][entry.row]),
    quantiles: Float32Array.from(tested.flatMap((entry) => FORECAST_MODELS.flatMap((model) => entry.quantiles[model]))),
    btc15: Float32Array.from(tested, (entry) => btc15.get(panel.time[entry.row]) ?? Number.NaN),
    directionModels: DIRECTION_MODELS,
    direction: Float32Array.from(tested.flatMap((entry) => DIRECTION_MODELS.map((model) => entry.direction[model]))),
    excursion: Float32Array.from(tested.flatMap((entry) => [...entry.excursion.high, ...entry.excursion.low])),
    state: Uint8Array.from(tested, (entry) => {
      const state = states.get(panel.time[entry.row])
      return state === undefined ? STATE_UNKNOWN : MARKET_SHOCK_STATES.indexOf(state)
    })
  }
}

const read = (folder: string, horizon: Horizon): OosRecord | null => {
  const file = join(OUT, folder, `oos-${horizon}.bin`)
  if (!existsSync(file)) return null
  const bytes = readFileSync(file)
  return decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

mkdirSync(join(OUT, NAME), { recursive: true })
if (!COMPARE) {
  for (const horizon of FIT) {
    const hIndex = HORIZONS.indexOf(horizon)
    const rows = rowsFor(panel, horizon)
    const tested: Parameters<typeof recordOf>[1][number][] = []
    for (const fold of plan) {
      const before = knownBefore(panel, rows.filter((row) => panel.time[row] < fold.from), horizon, fold.from)
      const { train, valid } = finalSplit(panel, before, horizon)
      if (train.length === 0) continue
      const fitted = fitHorizon(panel, train, valid, horizon, SEED + hIndex * 100 + fold.index + 1)
      for (const row of rows) {
        const t = panel.time[row]
        if (t < fold.from || t >= fold.to) continue
        const x = readRow(row)
        tested.push({ row, fold: fold.index, quantiles: predictHorizon(fitted, x), direction: predictDirection(fitted, x), excursion: predictExcursion(fitted, x) })
      }
      process.stderr.write(`  ${horizon} fold ${fold.index + 1} of ${plan.length}: ${train.length} rows fitted (${elapsed()})\n`)
    }
    writeFileSync(join(OUT, NAME, `oos-${horizon}.bin`), encodeOos(recordOf(horizon, tested)))
  }
}

/** A record's promotions, from each model's score over its tested rows (the worker's promotionsOf). */
function promotionsFrom(records: ReadonlyMap<Horizon, OosRecord>): Promotion[] {
  return promotionsOf(
    [...records].map(([horizon, record]) => ({
      horizon,
      scores: record.models.map((model) => {
        const quantiles = Array.from({ length: record.rows }, (_, row) => oosQuantiles(record, row, model))
        const z = Array.from(record.z)
        const byClass: Partial<Record<PairClass, ModelScore>> = {}
        for (const [index, cls] of PAIR_CLASSES.entries()) {
          const mine = [...Array(record.rows).keys()].filter((row) => record.cls[row] === index)
          if (mine.length > 0) byClass[cls] = scoreRows(mine.map((row) => quantiles[row]), mine.map((row) => z[row]))
        }
        return { model, overall: scoreRows(quantiles, z), byClass }
      })
    }))
  )
}

const baseline = new Map<Horizon, OosRecord>()
const block = new Map<Horizon, OosRecord>()
for (const horizon of HORIZONS) {
  const a = read('long-expanding', horizon)
  const b = read(NAME, horizon)
  if (a !== null) baseline.set(horizon, a)
  if (b !== null) block.set(horizon, b)
}
if (baseline.size === 0) {
  console.log(`\nno baseline yet (${join(OUT, 'long-expanding')}): run research/longWalkForward.ts, then this again with COMPARE=1`)
  process.exit(0)
}
const promoted = { baseline: promotionsFrom(baseline), block: promotionsFrom(block) }
const calibrations: Record<'baseline' | 'block', RunCalibration> = { baseline: buildRunCalibration(baseline, promoted.baseline, 'long-expanding'), block: buildRunCalibration(block, promoted.block, NAME) }
const shown = (which: 'baseline' | 'block', horizon: Horizon): ScoredRow[] => {
  const record = (which === 'baseline' ? baseline : block).get(horizon)!
  return scoreOutOfSample(rowsOf(record), 'v2', new Set(promoted[which].filter((entry) => entry.horizon === horizon && entry.promoted).map((entry) => entry.model)))
}
const p = (value: number | null | undefined, digits = 1): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(digits)}%`)
const result: Record<string, unknown> = { name: NAME, blocks: BLOCKS, permuted: PERMUTE, horizons: {} }
console.log(`\n${NAME} against the walk forward on the forecast's own figures, the same folds and seeds:`)
for (const horizon of HORIZONS) {
  if (!baseline.has(horizon) || !block.has(horizon)) continue
  const paired = pairedHorizonOf(shown('baseline', horizon), shown('block', horizon), horizon)
  const honest = (which: 'baseline' | 'block') => calibrations[which].horizons[horizon]?.variants.v2.honest.pooled ?? null
  const verdicts = (which: 'baseline' | 'block') =>
    DIRECTION_MODELS.map((model) => {
      const made = calibrations[which].horizons[horizon]?.direction?.models[model]
      return { model, promoted: made?.promoted ?? false, tradeable: made?.tradeable ?? false, skill: made?.honest.pooled?.directionSkill ?? null, ci: made?.honest.pooled?.ci?.directionSkill ?? null }
    })
  const base = honest('baseline')
  const mine = honest('block')
  console.log(`  ${horizon}: pinball with less without ${paired === null ? '-' : `${paired.pinball.difference.toFixed(5)} [${paired.pinball.low.toFixed(5)}, ${paired.pinball.high.toFixed(5)}] on ${base?.pinball.toFixed(5)} (${(((paired.pinball.difference ?? 0) / (base?.pinball ?? Number.NaN)) * 100).toFixed(2)}%), better ${paired.pinball.better}, worse ${paired.pinball.worse}`}`)
  console.log(`    coverage 80% ${p(mine?.coverage80)} (without ${p(base?.coverage80)}); the distribution's direction skill ${p(mine?.directionSkill, 2)} (without ${p(base?.directionSkill, 2)})`)
  for (const [k, entry] of verdicts('block').entries()) {
    const before = verdicts('baseline')[k]
    console.log(`    ${entry.model.padEnd(16)} skill ${p(entry.skill, 2)} ${entry.ci === null ? '' : `[${p(entry.ci.low, 2)}, ${p(entry.ci.high, 2)}]`} promoted ${entry.promoted} tradeable ${entry.tradeable} (without: ${p(before.skill, 2)}, ${before.promoted}, ${before.tradeable})`)
  }
  ;(result.horizons as Record<string, unknown>)[horizon] = { paired, honest: { baseline: base, block: mine }, verdicts: { baseline: verdicts('baseline'), block: verdicts('block') } }
}
writeFileSync(join(OUT, NAME, 'ablation.json'), JSON.stringify(result, null, 1))
console.log(`\nwrote ${join(OUT, NAME, 'ablation.json')} (${elapsed()})`)
