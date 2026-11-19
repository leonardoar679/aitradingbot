// THE LONG WALK FORWARD (V7.2-R Stage 6, 22 October 2026; the V7.2 draft's Stage 8). The live forecast is fitted on its
// last ninety days and tested on its last four weeks; this reads a year of bars from the archive
// (research/fetch-forecast-archive.mjs) and tests the same fits on eight 28-day folds, February to September 2026,
// two ways on identical tested months: EXPANDING, fitted on every row before the fold (up to most of a year), and
// ROLLING, fitted on the ninety days before it alone (the live fit's window). Each fit is the worker's own (fitHorizon,
// the worker's seeds, the rows purged and embargoed as foldRows purges them), on the hourly grid; each mode's record is
// kept in the record's format (forecast-oos) so that runCalibration scores its shown forecast out of sample -- weights
// and calibration from the folds before -- as the live calibration is scored. Then:
//   V72R-S6-LONGWF   per horizon, the paired difference of the shown forecast's pinball loss, expanding less rolling,
//                    with its 90% interval by hour blocks (challenger.ts pairedHorizonOf), and each mode's coverage;
//   V72R-S6-DIRYEAR  per horizon, the honest direction skill of the distribution's P(up) and of each direction model's,
//                    with intervals, the distribution's skill month by month, each model's verdict by the direction bar;
//   V72R-S6-COVERAGE per horizon, the 80% range's coverage pooled and month by month;
//   V72R-S6-CADENCE  (exploratory) a fit on the ninety days before a day and one on the ninety days before the next,
//                    the same seeds, scored on the week after, paired by hour: what a day of new rows changes.
//
//   npx esbuild research/longWalkForward.ts --bundle --platform=node --format=esm --outfile=research/.longWalkForward.mjs
//   ARCHIVE=<scratch>/archive-profile [OUT=<folder>] [HORIZONS=hour1,hours4] node --max-old-space-size=8192 research/.longWalkForward.mjs
//
// Hours of one core: run it beside nothing it would slow. It reads the archive and writes only into OUT.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { preEventAt } from '../shared/calendar/macro'
import { barFromLine, coarseBars, mergeBars, type ForecastBar } from '../shared/forecast/bars'
import { pairedHorizonOf } from '../shared/forecast/challenger'
import { HORIZONS, PAIR_CLASSES, type Horizon, type PairClass, type PairSeries } from '../shared/forecast/features'
import { MARKET_SHOCK_STATES, STATE_UNKNOWN, btcTimelineOf, marketShockByTime, shockMomentsOf } from '../shared/forecast/marketShock'
import { DIRECTION_MODELS, FORECAST_MODELS, fitHorizon, normalizedTarget, predictDirection, predictExcursion, predictHorizon, type DirectionModelId, type ForecastModelId } from '../shared/forecast/models'
import { QUANTILE_LEVELS } from '../shared/forecast/ml/quantile'
import { OOS_VERSION, decodeOos, encodeOos, oosQuantiles, type OosRecord } from '../shared/forecast/oosRecord'
import { buildPanel, type Panel } from '../shared/forecast/panel'
import { buildRunCalibration, honestScore, rowsOf, scoreOutOfSample, type RunCalibration, type ScoredRow } from '../shared/forecast/runCalibration'
import { btc15ByTime } from '../shared/forecast/shock'
import { promotionsOf, type Promotion } from '../shared/forecast/training'
import { BLOCK_HOURS, bootstrapOverHours, hourOf } from '../shared/forecast/uncertainty'
import { finalSplit, knownBefore, planFolds, rowsFor, scoreRows, type Fold, type ModelScore } from '../shared/forecast/walkForward'

const ARCHIVE = process.env.ARCHIVE ?? ''
if (ARCHIVE === '') throw new Error('ARCHIVE is the folder research/fetch-forecast-archive.mjs wrote into')
const OUT = process.env.OUT ?? join(ARCHIVE, 'longWalkForward')
const ONLY = process.env.HORIZONS === undefined ? HORIZONS : (process.env.HORIZONS.split(',') as Horizon[])
/** REUSE=1 reads a horizon's record back where a run before wrote it (OUT/long-<mode>/oos-<horizon>.bin) instead of fitting
 * it again: the record holds every model's levels and the outcome of each tested row, so its scores, calibration and
 * figures are read from it as the comparison of blocks reads its own (research/blockAblation.ts). A run stopped part way
 * (22 October 2026: the two-hour limit on a background command) is finished horizon by horizon. */
const REUSE = process.env.REUSE === '1'
/** The figures' file: the whole run's, or, with HORIZONS, those horizons' own, so that runs of different horizons do not
 * write over one another. */
const RESULT = process.env.HORIZONS === undefined ? 'long-walk-forward.json' : `long-walk-forward-${ONLY.join('-')}.json`
/** The worker's seed (electron/forecast/trainWorker.ts SEED), so that each fit is the one the app would make. */
const SEED = 20261013
/** Eight tested folds of 28 days, each with at least ninety days of rows before it; FOLDS another count of the same folds
 * (V8 Stage 11: thirteen over the second year, October 2024 to September 2025, for V8-R2's confirmation). */
const LONG_FOLDS = { folds: Number(process.env.FOLDS ?? 8), foldDays: 28, minTrainDays: 90 }
const ROLLING_DAYS = 90
const WARMUP_DAYS = 26
type Mode = 'expanding' | 'rolling'
/** ROLLING_ONLY=1 fits the rolling mode alone -- the live fit's window, V10-LEAN's held-out records (19 November 2026) --
 * keeps its promotions beside its records (long-rolling/promotions.json), and leaves out the comparison with the
 * expanding mode and the cadence, which need both. */
const ROLLING_ONLY = process.env.ROLLING_ONLY === '1'
const MODES: readonly Mode[] = ROLLING_ONLY ? ['rolling'] : ['expanding', 'rolling']

const clock = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
const started = Date.now()
const elapsed = (): string => `${((Date.now() - started) / 60_000).toFixed(1)} min`

// The archive's bars as the worker reads a profile's (trainWorker.ts loadMarket).
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
const btc = market.get('BTCUSDT')
if (btc === undefined || btc.m5.length === 0) throw new Error('no Bitcoin bars in the archive')
const lastBar = Math.max(...[...market.values()].map((series) => series.m5[series.m5.length - 1].time + 300))
console.log(`the archive: ${market.size} pairs, Bitcoin from ${clock(btc.m5[0].time)} to ${clock(lastBar)} (${elapsed()})`)

const panel: Panel = buildPanel(market, { stepSec: 3600, fromSec: btc.m5[0].time + WARMUP_DAYS * 86_400, toSec: lastBar })
const first = panel.time[0]
const last = panel.time[panel.rows - 1]
const plan: Fold[] = planFolds(first, last, LONG_FOLDS)
console.log(`the panel: ${panel.rows} rows of ${panel.symbols.length} pairs on the hour, ${clock(first)} to ${clock(last)}; ${plan.length} folds: ${plan.map((fold) => `${fold.index} ${clock(fold.from).slice(0, 10)}`).join(', ')} (${elapsed()})`)
const btc15 = btc15ByTime(panel)
const states = marketShockByTime(panel, shockMomentsOf(btcTimelineOf(btc, first - 5 * 3600, last)), preEventAt)

/** A fold's rows in a mode: fitted on the rows whose outcome was known an embargo before the fold (every one before
 * it, or the ninety days' alone), split as the final fit's are; tested on the fold's own. */
function foldRowsIn(rows: Uint32Array, horizon: Horizon, fold: Fold, mode: Mode, until = fold.from): { train: Uint32Array; valid: Uint32Array } {
  const from = mode === 'rolling' ? until - ROLLING_DAYS * 86_400 : Number.NEGATIVE_INFINITY
  const before = knownBefore(panel, rows.filter((row) => panel.time[row] < until && panel.time[row] >= from), horizon, until)
  return finalSplit(panel, before, horizon)
}

interface Tested {
  row: number
  fold: number
  quantiles: Record<ForecastModelId, number[]>
  direction: Record<DirectionModelId, number>
  excursion: { high: number[]; low: number[] }
}

/** A mode's tested rows at a horizon as the record keeps them (trainWorker.ts folds). */
function recordOf(horizon: Horizon, tested: readonly Tested[]): OosRecord {
  const z = tested.map((entry) => normalizedTarget(panel, entry.row, horizon))
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
    z: Float32Array.from(z),
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

const row64 = new Float64Array(panel.cols)
const readRow = (row: number): Float64Array => {
  for (let col = 0; col < panel.cols; col++) row64[col] = panel.x[row * panel.cols + col]
  return row64
}

mkdirSync(OUT, { recursive: true })
const records: Record<Mode, Map<Horizon, OosRecord>> = { expanding: new Map(), rolling: new Map() }
const scores: Record<Mode, { horizon: Horizon; scores: { model: ForecastModelId; overall: ModelScore; byClass: Partial<Record<PairClass, ModelScore>> }[] }[]> = { expanding: [], rolling: [] }
const fitMinutes: Record<Mode, number[]> = { expanding: [], rolling: [] }
/** A saved record's scores, each model's over its tested rows as the fit's are (blockAblation.ts promotionsFrom). */
function scoresOfRecord(record: OosRecord): { model: ForecastModelId; overall: ModelScore; byClass: Partial<Record<PairClass, ModelScore>> }[] {
  const z = Array.from(record.z)
  return FORECAST_MODELS.filter((model) => record.models.includes(model)).map((model) => {
    const quantiles = Array.from({ length: record.rows }, (_, row) => oosQuantiles(record, row, model))
    const byClass: Partial<Record<PairClass, ModelScore>> = {}
    for (const [index, cls] of PAIR_CLASSES.entries()) {
      const mine = [...Array(record.rows).keys()].filter((row) => record.cls[row] === index)
      if (mine.length > 0) byClass[cls] = scoreRows(mine.map((row) => quantiles[row]), mine.map((row) => z[row]))
    }
    return { model, overall: scoreRows(quantiles, z), byClass }
  })
}

for (const horizon of ONLY) {
  const hIndex = HORIZONS.indexOf(horizon)
  const rows = rowsFor(panel, horizon)
  for (const mode of MODES) {
    const saved = join(OUT, `long-${mode}`, `oos-${horizon}.bin`)
    if (REUSE && existsSync(saved)) {
      const bytes = readFileSync(saved)
      const record = decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      if (record === null || record.horizon !== horizon) throw new Error(`${saved} could not be read back`)
      records[mode].set(horizon, record)
      scores[mode].push({ horizon, scores: scoresOfRecord(record) })
      process.stderr.write(`  ${horizon} ${mode}: read back, ${record.rows} rows (${elapsed()})\n`)
      continue
    }
    const tested: Tested[] = []
    for (const fold of plan) {
      const { train, valid } = foldRowsIn(rows, horizon, fold, mode)
      if (train.length === 0) continue
      const at = Date.now()
      const fitted = fitHorizon(panel, train, valid, horizon, SEED + hIndex * 100 + fold.index + 1)
      fitMinutes[mode].push((Date.now() - at) / 60_000)
      for (const row of rows) {
        const t = panel.time[row]
        if (t < fold.from || t >= fold.to) continue
        const x = readRow(row)
        tested.push({ row, fold: fold.index, quantiles: predictHorizon(fitted, x), direction: predictDirection(fitted, x), excursion: predictExcursion(fitted, x) })
      }
      process.stderr.write(`  ${horizon} ${mode} fold ${fold.index + 1} of ${plan.length}: ${train.length} rows fitted, ${tested.length} tested so far (${elapsed()})\n`)
    }
    const record = recordOf(horizon, tested)
    records[mode].set(horizon, record)
    mkdirSync(join(OUT, `long-${mode}`), { recursive: true })
    writeFileSync(join(OUT, `long-${mode}`, `oos-${horizon}.bin`), encodeOos(record))
    const z = tested.map((entry) => normalizedTarget(panel, entry.row, horizon))
    scores[mode].push({
      horizon,
      scores: FORECAST_MODELS.map((model) => {
        const byClass: Partial<Record<PairClass, ModelScore>> = {}
        for (const [index, cls] of PAIR_CLASSES.entries()) {
          const mine = tested.map((entry, at) => ({ entry, at })).filter(({ entry }) => panel.cls[entry.row] === index)
          if (mine.length > 0) byClass[cls] = scoreRows(mine.map(({ entry }) => entry.quantiles[model]), mine.map(({ at }) => z[at]))
        }
        return { model, overall: scoreRows(tested.map((entry) => entry.quantiles[model]), z), byClass }
      })
    })
  }
}

// Each mode's calibration from its record, and its shown forecast scored out of sample as the calibration scores it.
const promotions: Record<Mode, Promotion[]> = { expanding: promotionsOf(scores.expanding), rolling: promotionsOf(scores.rolling) }
for (const mode of MODES) writeFileSync(join(OUT, `long-${mode}`, 'promotions.json'), JSON.stringify({ runId: `long-${mode}`, promotions: promotions[mode] }, null, 1))
if (ROLLING_ONLY) {
  writeFileSync(join(OUT, RESULT), JSON.stringify({ folds: plan, rollingDays: ROLLING_DAYS, rollingOnly: true, fitMinutes }, null, 1))
  console.log(`the rolling mode's records and promotions are in ${join(OUT, 'long-rolling')} (${elapsed()})`)
  process.exit(0)
}
const calibrations: Record<Mode, RunCalibration> = { expanding: buildRunCalibration(records.expanding, promotions.expanding, 'long-expanding'), rolling: buildRunCalibration(records.rolling, promotions.rolling, 'long-rolling') }
const shown = (mode: Mode, horizon: Horizon): ScoredRow[] => {
  const record = records[mode].get(horizon)!
  return scoreOutOfSample(rowsOf(record), 'v2', new Set(promotions[mode].filter((entry) => entry.horizon === horizon && entry.promoted).map((entry) => entry.model)))
}
const monthOf = (t: number): string => new Date(t * 1000).toISOString().slice(0, 7)
const p = (value: number | null | undefined, digits = 1): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(digits)}%`)

const result: Record<string, unknown> = { folds: plan, rollingDays: ROLLING_DAYS, horizons: {} as Record<string, unknown>, fitMinutes }
console.log(`\nthe long walk forward, ${plan.length} folds of 28 days, expanding against rolling (${ROLLING_DAYS} days):`)
for (const horizon of ONLY) {
  const a = shown('rolling', horizon)
  const b = shown('expanding', horizon)
  const paired = pairedHorizonOf(a, b, horizon)
  const honest = (mode: Mode) => calibrations[mode].horizons[horizon]?.variants.v2.honest.pooled ?? null
  const months = [...new Set(b.map((entry) => monthOf(entry.t!)))].sort()
  const byMonth = months.map((month) => {
    const mine = b.filter((entry) => monthOf(entry.t!) === month)
    const score = honestScore(mine, horizon)
    return { month, n: mine.length, coverage80: score?.coverage80 ?? null, directionSkill: score?.directionSkill ?? null }
  })
  const report = calibrations.expanding.horizons[horizon]?.direction ?? null
  const models = report === null ? [] : DIRECTION_MODELS.map((model) => ({ model, score: report.models[model] ?? null }))
  const he = honest('expanding')
  const hr = honest('rolling')
  console.log(`  ${horizon}:`)
  const base = hr?.pinball ?? Number.NaN
  console.log(`    pinball expanding less rolling: ${paired === null ? '-' : `${paired.pinball.difference.toFixed(5)} [${paired.pinball.low.toFixed(5)}, ${paired.pinball.high.toFixed(5)}] on rolling's ${base.toFixed(5)} (${((paired.pinball.difference / base) * 100).toFixed(2)}%), ${paired.hours} hours; better beyond noise and 1%: ${paired.pinball.better}, worse: ${paired.pinball.worse}`}`)
  console.log(`    coverage of the 80% range: expanding ${p(he?.coverage80)} ${he?.ci?.coverage80 ? `[${p(he.ci.coverage80.low)}, ${p(he.ci.coverage80.high)}]` : ''}, rolling ${p(hr?.coverage80)}; the 50%: ${p(he?.coverage50)}, ${p(hr?.coverage50)}; skill over persistence ${p(he?.skill, 2)}, ${p(hr?.skill, 2)}`)
  console.log(`    the distribution's direction skill (expanding): ${p(he?.directionSkill, 2)} ${he?.ci?.directionSkill ? `[${p(he.ci.directionSkill.low, 2)}, ${p(he.ci.directionSkill.high, 2)}]` : ''}`)
  console.log(`    by month (expanding): ${byMonth.map((entry) => `${entry.month.slice(2)} 80% ${p(entry.coverage80, 0)} dir ${p(entry.directionSkill, 1)}`).join('; ')}`)
  for (const entry of models) {
    const score = entry.score
    if (score === null) continue
    console.log(`    ${entry.model.padEnd(16)} skill ${p(score.honest.pooled?.directionSkill, 2)} ${score.honest.pooled?.ci?.directionSkill ? `[${p(score.honest.pooled.ci.directionSkill.low, 2)}, ${p(score.honest.pooled.ci.directionSkill.high, 2)}]` : ''}  promoted ${score.promoted}  tradeable ${score.tradeable}`)
  }
  ;(result.horizons as Record<string, unknown>)[horizon] = { paired, honest: { expanding: he, rolling: hr }, byMonth, models: models.map((entry) => ({ model: entry.model, promoted: entry.score?.promoted ?? null, tradeable: entry.score?.tradeable ?? null, honest: entry.score?.honest.pooled ?? null })) }
}

// THE CADENCE: a rolling fit on the ninety days before a day and one on the ninety days before the next, the same
// seeds, each scored on the same week after the second -- the per-row pinball of the gbt's levels -- paired by hour.
const PINBALL_MODEL: ForecastModelId = 'gbt'
const pinballOf = (quantiles: readonly number[], z: number): number => QUANTILE_LEVELS.reduce((sum, tau, k) => sum + (z >= quantiles[k] ? tau * (z - quantiles[k]) : (1 - tau) * (quantiles[k] - z)), 0) / QUANTILE_LEVELS.length
const cadence: Record<string, unknown>[] = []
console.log('\nthe cadence (exploratory): a day of new rows, the same seeds, scored on the week after:')
for (const fold of plan.slice(-3)) {
  const day = fold.from
  for (const horizon of ONLY) {
    const hIndex = HORIZONS.indexOf(horizon)
    const rows = rowsFor(panel, horizon)
    const seed = SEED + hIndex * 100 + fold.index + 1
    const fits = [day, day + 86_400].map((until) => {
      const { train, valid } = foldRowsIn(rows, horizon, fold, 'rolling', until)
      return fitHorizon(panel, train, valid, horizon, seed)
    })
    const week = rows.filter((row) => panel.time[row] >= day + 86_400 && panel.time[row] < day + 8 * 86_400)
    const samples = [...week].map((row) => {
      const x = readRow(row)
      const z = normalizedTarget(panel, row, horizon)
      return { hour: hourOf(panel.time[row]), sample: [pinballOf(predictHorizon(fits[1], x)[PINBALL_MODEL], z) - pinballOf(predictHorizon(fits[0], x)[PINBALL_MODEL], z), pinballOf(predictHorizon(fits[0], x)[PINBALL_MODEL], z), 1] }
    })
    const made = bootstrapOverHours(samples, [(sums): number => sums[0] / sums[2], (sums): number => sums[1] / sums[2]], BLOCK_HOURS[horizon])
    const diff = made?.figures[0] ?? null
    const base = made?.figures[1] ?? null
    cadence.push({ day: clock(day).slice(0, 10), horizon, rows: week.length, difference: diff, pinball: base?.value ?? null })
    console.log(`  ${clock(day).slice(0, 10)} ${horizon.padEnd(9)} the day after less the day: ${diff === null ? '-' : `${diff.value.toFixed(5)} [${diff.low.toFixed(5)}, ${diff.high.toFixed(5)}] on ${base!.value.toFixed(5)}`} (${week.length} rows) (${elapsed()})`)
  }
}
result.cadence = cadence
writeFileSync(join(OUT, RESULT), JSON.stringify(result, null, 1))
console.log(`\nwrote ${join(OUT, RESULT)} in ${elapsed()}; fits took ${fitMinutes.expanding.reduce((a, b) => a + b, 0).toFixed(0)} min expanding, ${fitMinutes.rolling.reduce((a, b) => a + b, 0).toFixed(0)} min rolling`)
