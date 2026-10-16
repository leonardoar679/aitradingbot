import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { parentPort } from 'worker_threads'
import { barFromLine, coarseBars, mergeBars, type ForecastBar } from '../../shared/forecast/bars'
import { HORIZONS, PAIR_CLASSES, type Horizon, type PairClass, type PairSeries } from '../../shared/forecast/features'
import { binMatrix, fitCuts, rngOf, type Matrix } from '../../shared/forecast/ml/bins'
import { fitGbt, lossOf, predictGbt } from '../../shared/forecast/ml/gbt'
import { DIRECTION_MODELS, FORECAST_MODELS, fitHorizon, normalizedTarget, predictDirection, predictExcursion, predictHorizon, type DirectionModelId, type FittedHorizon, type ForecastModelId } from '../../shared/forecast/models'
import { firstTouchTable, type FirstTouchTable } from '../../shared/forecast/firstTouch'
import { serializeRunCalibration } from '../../shared/forecast/calibrationFile'
import { serializeFitted } from '../../shared/forecast/modelFile'
import { LAB_VERSION, type TraderRule } from '../../shared/forecast/lab'
import { serializeLab, serializeReplay, type LabFile } from '../../shared/forecast/labFile'
import { walkForwardLab, type StoryMarkInput } from '../../shared/forecast/labWalkForward'
import { decodeOos, encodeOos, OOS_VERSION, type OosRecord } from '../../shared/forecast/oosRecord'
import { buildPanel, type Panel } from '../../shared/forecast/panel'
import { buildRunCalibration, type RunCalibration } from '../../shared/forecast/runCalibration'
import { btc15ByTime } from '../../shared/forecast/shock'
import { promotionsOf, type Promotion } from '../../shared/forecast/training'
import { finalSplit, foldRows, lastFoldScores, planFolds, rowsFor, scoreRows, type Fold, type ModelScore } from '../../shared/forecast/walkForward'

// THE FORECAST'S TRAINING, OFF THE MAIN THREAD (the V6 document, §13 and §51-53; V6 Stages 4-5, 13
// October 2026). Fitting trees on hundreds of thousands of rows takes minutes of one core; done in the
// main process it would hold up every socket, timer and window message for as long. So it runs here,
// in a worker thread of its own, built as its own file beside the main process's
// (electron.vite.config.ts), and talks to it in messages: a request with an id, progress, and a reply.
//
// Two tasks, each reading the forecast's bars from their files (forecastData/) itself:
// - FIT: every model at every horizon on every row, the boosting stopped on the last week; the models
//   written to forecastModels/<run>/<horizon>.json. These are what the live forecast reads.
// - FOLDS: the walk forward -- each of the last weeks forecast by models fitted only on the rows before
//   it (shared/forecast/walkForward.ts) -- every model scored on outcomes it never saw, by class, and
//   the hourly forecasts kept in forecastModels/<run>/oos-<horizon>.bin for the calibration and the Lab;
//   then the calibration made from them (shared/forecast/runCalibration.ts), in calibration.json.
// - CALIBRATE: the calibration made again from the hourly forecasts on file, for a run walked forward
//   before the calibration's version changed.
// - LAB (V6 Stage 11): what the Forecast Lab shows of a walk forward -- its forecasts scored, called,
//   replayed as trades and set beside the bars around them (shared/forecast/labWalkForward.ts) -- in
//   forecastModels/<run>/lab.json, and each horizon's forecasts for the replay in lab-replay-<horizon>.json.
//
// IT TRAINS ON PUBLIC MARKET DATA AND NOTHING ELSE. No key, no model of anyone else's, no order, no
// network: it reads the bars on file and writes the models it fitted beside them.

/** Days of history the first rows need: the longest window's hours (shared/forecast/features.ts). */
const WARMUP_DAYS = 26
const SEED = 20261013

export type WorkerRequest =
  | { id: number; task: 'selftest'; rows: number; cols: number; seed: number }
  | { id: number; task: 'fit'; dataDir: string; outDir: string; runId: string; nowSec: number }
  | { id: number; task: 'folds'; dataDir: string; outDir: string; runId: string; nowSec: number }
  | { id: number; task: 'calibrate'; outDir: string; runId: string; promotions: Promotion[] }
  | { id: number; task: 'lab'; dataDir: string; outDir: string; runId: string; promotions: Promotion[]; stories: StoryMarkInput[]; nowSec: number }

export interface FitResult {
  task: 'fit'
  runId: string
  symbols: string[]
  rows: number
  span: { from: number; to: number }
  horizons: { horizon: Horizon; train: number; valid: number; trees: Record<string, number> }[]
  ms: number
}

export interface FoldsResult {
  task: 'folds'
  runId: string
  folds: Fold[]
  horizons: {
    horizon: Horizon
    tested: number
    kept: number
    scores: { model: ForecastModelId; overall: ModelScore; byClass: Partial<Record<PairClass, ModelScore>> }[]
    /** Each model's score on the last week tested alone: what a degraded model is judged by (§105). */
    lastWeek: { model: ForecastModelId; score: ModelScore }[]
  }[]
  calibration: CalibrationSummary[]
  ms: number
}

/** What a calibration made of each horizon: the ensemble's honest score, every class together. */
export interface CalibrationSummary {
  horizon: Horizon
  rows: number
  weeks: number[]
  coverage80: number | null
  coverage50: number | null
  skill: number | null
  brier: number | null
  direction: number | null
  weights: { model: ForecastModelId; weight: number }[]
}

export interface CalibrateResult {
  task: 'calibrate'
  runId: string
  calibration: CalibrationSummary[]
  ms: number
}

export interface LabResult {
  task: 'lab'
  runId: string
  horizons: { horizon: Horizon; rows: number; trades: Record<TraderRule, number> }[]
  ms: number
}

export interface SelftestResult {
  task: 'selftest'
  trees: number
  validLoss: number
  baselineLoss: number
  ms: number
}

export type WorkerReply =
  | { id: number; ok: true; result: SelftestResult | FitResult | FoldsResult | CalibrateResult | LabResult }
  | { id: number; ok: false; error: string }
  | { id: number; progress: { step: string; done: number; total: number } }

function progress(id: number, step: string, done: number, total: number): void {
  parentPort?.postMessage({ id, progress: { step, done, total } } satisfies WorkerReply)
}

/** Every pair's bars on file, oldest first, with the hours built from them. */
async function loadMarket(dataDir: string): Promise<Map<string, PairSeries>> {
  const names = await readdir(dataDir).catch(() => [] as string[])
  const byPair = new Map<string, ForecastBar[]>()
  for (const name of names.sort()) {
    const symbol = /^([A-Z0-9]+)-\d{4}-\d{2}\.jsonl$/.exec(name)?.[1]
    if (symbol === undefined) continue
    const text = await readFile(join(dataDir, name), 'utf-8').catch(() => '')
    const read: ForecastBar[] = []
    for (const line of text.split('\n')) {
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

/** The rows on the quarter-hour grid, from when the first rows can be read to the moment given, and the
 * market they were read from. */
async function panelOf(dataDir: string, nowSec: number): Promise<{ panel: Panel; market: Map<string, PairSeries> }> {
  const market = await loadMarket(dataDir)
  const btc = market.get('BTCUSDT')
  if (btc === undefined || btc.m5.length === 0) throw new Error('no Bitcoin bars on file to train on')
  return { panel: buildPanel(market, { stepSec: 900, fromSec: btc.m5[0].time + WARMUP_DAYS * 86_400, toSec: nowSec }), market }
}

function treeCounts(fitted: FittedHorizon): Record<string, number> {
  return {
    forest: fitted.forest.center.trees.length,
    gbtCenter: fitted.gbt.center.trees.length,
    gbtSize: fitted.gbt.size.trees.length,
    quantileGbt: fitted.quantileGbt.levels.reduce((sum, model) => sum + model.trees.length, 0),
    priceCenter: fitted.gbtPrice.center.trees.length,
    priceSize: fitted.gbtPrice.size.trees.length
  }
}

async function fit(request: Extract<WorkerRequest, { task: 'fit' }>): Promise<FitResult> {
  const started = Date.now()
  progress(request.id, 'reading the bars', 0, HORIZONS.length + 1)
  const { panel } = await panelOf(request.dataDir, request.nowSec)
  const dir = join(request.outDir, request.runId)
  await mkdir(dir, { recursive: true })
  const horizons: FitResult['horizons'] = []
  for (const [index, horizon] of HORIZONS.entries()) {
    progress(request.id, `fitting ${horizon}`, index + 1, HORIZONS.length + 1)
    const rows = rowsFor(panel, horizon)
    const { train, valid } = finalSplit(panel, rows, horizon)
    if (train.length === 0) throw new Error(`no rows to fit ${horizon} on`)
    const fitted = fitHorizon(panel, train, valid, horizon, SEED + index * 100)
    await writeFile(join(dir, `${horizon}.json`), serializeFitted(fitted), 'utf-8')
    horizons.push({ horizon, train: train.length, valid: valid.length, trees: treeCounts(fitted) })
  }
  return { task: 'fit', runId: request.runId, symbols: panel.symbols, rows: panel.rows, span: { from: panel.time[0] ?? 0, to: panel.time[panel.rows - 1] ?? 0 }, horizons, ms: Date.now() - started }
}

async function folds(request: Extract<WorkerRequest, { task: 'folds' }>): Promise<FoldsResult> {
  const started = Date.now()
  const { panel, market } = await panelOf(request.dataDir, request.nowSec)
  const dir = join(request.outDir, request.runId)
  await mkdir(dir, { recursive: true })
  const first = panel.time[0] ?? 0
  const last = panel.time[panel.rows - 1] ?? 0
  const plan = planFolds(first, last)
  const horizons: FoldsResult['horizons'] = []
  const records = new Map<Horizon, OosRecord>()
  // Bitcoin's last fifteen minutes at each moment, kept with every row (V6.1): what the calibration's rule
  // on Bitcoin's sharp moves is fitted on (shared/forecast/shock.ts).
  const btc15 = btc15ByTime(panel)
  let step = 0
  for (const [hIndex, horizon] of HORIZONS.entries()) {
    const rows = rowsFor(panel, horizon)
    const tested: { row: number; fold: number; quantiles: Record<ForecastModelId, number[]>; direction: Record<DirectionModelId, number>; excursion: { high: number[]; low: number[] } }[] = []
    for (const fold of plan) {
      progress(request.id, `testing ${horizon} on week ${fold.index + 1} of ${plan.length}`, step++, HORIZONS.length * plan.length)
      // Fitted on the rows whose outcomes were known before the week, the boosting stopped on the week
      // before it, purged the same way.
      const { train, valid, test } = foldRows(panel, rows, horizon, fold)
      if (train.length === 0) continue
      const fitted = fitHorizon(panel, train, valid, horizon, SEED + hIndex * 100 + fold.index + 1)
      const row64 = new Float64Array(panel.cols)
      for (const row of test) {
        for (let col = 0; col < panel.cols; col++) row64[col] = panel.x[row * panel.cols + col]
        tested.push({ row, fold: fold.index, quantiles: predictHorizon(fitted, row64), direction: predictDirection(fitted, row64), excursion: predictExcursion(fitted, row64) })
      }
    }
    const z = tested.map((entry) => normalizedTarget(panel, entry.row, horizon))
    const scores = FORECAST_MODELS.map((model) => {
      const byClass: Partial<Record<PairClass, ModelScore>> = {}
      for (const [index, cls] of PAIR_CLASSES.entries()) {
        const mine = tested.map((entry, at) => ({ entry, at })).filter(({ entry }) => panel.cls[entry.row] === index)
        if (mine.length > 0) byClass[cls] = scoreRows(mine.map(({ entry }) => entry.quantiles[model]), mine.map(({ at }) => z[at]))
      }
      return { model, overall: scoreRows(tested.map((entry) => entry.quantiles[model]), z), byClass }
    })
    const lastWeek = lastFoldScores(tested, z, FORECAST_MODELS)
    // The record keeps an hour a row.
    const kept = tested.map((entry, at) => ({ entry, at })).filter(({ entry }) => panel.time[entry.row] % 3600 === 0)
    const record: OosRecord = {
      version: OOS_VERSION,
      horizon,
      symbols: panel.symbols,
      models: FORECAST_MODELS,
      rows: kept.length,
      time: Uint32Array.from(kept, ({ entry }) => panel.time[entry.row]),
      pair: Uint16Array.from(kept, ({ entry }) => panel.pair[entry.row]),
      cls: Uint8Array.from(kept, ({ entry }) => panel.cls[entry.row]),
      regime: Uint8Array.from(kept, ({ entry }) => panel.regime[entry.row]),
      fold: Uint8Array.from(kept, ({ entry }) => entry.fold),
      z: Float32Array.from(kept, ({ at }) => z[at]),
      rv24h: Float32Array.from(kept, ({ entry }) => panel.rv24h[entry.row]),
      y: Float32Array.from(kept, ({ entry }) => panel.y[horizon][entry.row]),
      best: Float32Array.from(kept, ({ entry }) => panel.best[horizon][entry.row]),
      worst: Float32Array.from(kept, ({ entry }) => panel.worst[horizon][entry.row]),
      quantiles: Float32Array.from(kept.flatMap(({ entry }) => FORECAST_MODELS.flatMap((model) => entry.quantiles[model]))),
      btc15: Float32Array.from(kept, ({ entry }) => btc15.get(panel.time[entry.row]) ?? Number.NaN),
      // Each direction model's raw chance of up at the row (V7.1 Stage 2), for the calibration to judge.
      directionModels: DIRECTION_MODELS,
      direction: Float32Array.from(kept.flatMap(({ entry }) => DIRECTION_MODELS.map((model) => entry.direction[model]))),
      // The excursion models' levels at the row (V7.1 Stage 3): the highs, then the lows.
      excursion: Float32Array.from(kept.flatMap(({ entry }) => [...entry.excursion.high, ...entry.excursion.low]))
    }
    await writeFile(join(dir, `oos-${horizon}.bin`), encodeOos(record))
    records.set(horizon, record)
    horizons.push({ horizon, tested: tested.length, kept: kept.length, scores, lastWeek })
  }
  progress(request.id, 'calibrating', step, HORIZONS.length * plan.length)
  // When a target is reached (V7.1 Stage 3): the first-touch table from the bars about every row of the grid.
  const touch = firstTouchTable(market, panel)
  const calibration = await writeCalibration(dir, records, promotionsOf(horizons), request.runId, touch)
  return { task: 'folds', runId: request.runId, folds: plan, horizons, calibration, ms: Date.now() - started }
}

/** The calibration from a walk forward's records, written beside them; what it made of each horizon. With
 * the first-touch table where the walk forward read its bars; a calibration made again from the record
 * alone has none. */
async function writeCalibration(dir: string, records: ReadonlyMap<Horizon, OosRecord>, promotions: readonly Promotion[], runId: string, touch?: FirstTouchTable): Promise<CalibrationSummary[]> {
  const calibration = buildRunCalibration(records, promotions, runId, touch)
  await writeFile(join(dir, 'calibration.json'), serializeRunCalibration(calibration), 'utf-8')
  return summaryOf(calibration)
}

function summaryOf(calibration: RunCalibration): CalibrationSummary[] {
  return HORIZONS.flatMap((horizon) => {
    const entry = calibration.horizons[horizon]
    if (entry === undefined) return []
    const honest = entry.variants.v2.honest.pooled
    const figure = (value: number | undefined): number | null => (value !== undefined && Number.isFinite(value) ? value : null)
    return [
      {
        horizon,
        rows: entry.rows,
        weeks: entry.variants.v2.honest.weeks,
        coverage80: figure(honest?.coverage80),
        coverage50: figure(honest?.coverage50),
        skill: figure(honest?.skill),
        brier: figure(honest?.brier),
        direction: figure(honest?.direction),
        weights: entry.variants.v2.weights.pooled
      }
    ]
  })
}

/** The calibration made again from the hourly forecasts a walk forward left on file. */
async function calibrate(request: Extract<WorkerRequest, { task: 'calibrate' }>): Promise<CalibrateResult> {
  const started = Date.now()
  const dir = join(request.outDir, request.runId)
  const records = new Map<Horizon, OosRecord>()
  for (const horizon of HORIZONS) {
    const bytes = await readFile(join(dir, `oos-${horizon}.bin`)).catch(() => null)
    const record = bytes === null ? null : decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    if (record !== null && record.horizon === horizon) records.set(horizon, record)
  }
  if (records.size === 0) throw new Error(`no out-of-sample record of ${request.runId} to calibrate on`)
  const calibration = await writeCalibration(dir, records, request.promotions, request.runId)
  return { task: 'calibrate', runId: request.runId, calibration, ms: Date.now() - started }
}

/** The Lab of a walk forward's record: read, scored and written beside it. */
async function lab(request: Extract<WorkerRequest, { task: 'lab' }>): Promise<LabResult> {
  const started = Date.now()
  const dir = join(request.outDir, request.runId)
  progress(request.id, 'reading the bars', 0, HORIZONS.length + 1)
  const market = await loadMarket(request.dataDir)
  const bars = new Map([...market].map(([symbol, series]) => [symbol, series.m5]))
  const file: LabFile = { version: LAB_VERSION, runId: request.runId, madeAt: request.nowSec, span: null, pairs: [], horizons: {} }
  const pairs = new Set<string>()
  const results: LabResult['horizons'] = []
  for (const [index, horizon] of HORIZONS.entries()) {
    progress(request.id, `the Lab at ${horizon}`, index + 1, HORIZONS.length + 1)
    const bytes = await readFile(join(dir, `oos-${horizon}.bin`)).catch(() => null)
    const record = bytes === null ? null : decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    if (record === null || record.horizon !== horizon) continue
    const made = walkForwardLab(record, request.promotions, bars, request.stories)
    file.horizons[horizon] = made.lab
    for (const row of made.replay) {
      pairs.add(row.pair)
      file.span = file.span === null ? { from: row.t, to: row.t } : { from: Math.min(file.span.from, row.t), to: Math.max(file.span.to, row.t) }
    }
    await writeFile(join(dir, `lab-replay-${horizon}.json`), serializeReplay(horizon, made.replay), 'utf-8')
    results.push({ horizon, rows: made.lab.rows, trades: { rules: made.lab.trader.rules.trades, medians: made.lab.trader.medians.trades } })
  }
  if (results.length === 0) throw new Error(`no out-of-sample record of ${request.runId} for the Lab`)
  file.pairs = [...pairs].sort()
  await writeFile(join(dir, 'lab.json'), serializeLab(file), 'utf-8')
  return { task: 'lab', runId: request.runId, horizons: results, ms: Date.now() - started }
}

/** A fit on a made-up problem, to show that the worker runs, and how fast: y = sin(x0) + noise growing
 * with x1, the L2 boosting's loss on held-back rows against predicting the mean. */
function selftest(rows: number, cols: number, seed: number): SelftestResult {
  const started = Date.now()
  const random = rngOf(seed)
  const make = (count: number): { matrix: Matrix; y: Float64Array } => {
    const data = new Float64Array(count * cols)
    const y = new Float64Array(count)
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < cols; col++) data[row * cols + col] = random() * 4 - 2
      y[row] = Math.sin(2 * data[row * cols]) + (random() - 0.5) * (0.2 + 0.5 * Math.abs(data[row * cols + 1]))
    }
    return { matrix: { rows: count, cols, data }, y }
  }
  const train = make(rows)
  const valid = make(Math.max(1, Math.floor(rows / 4)))
  const cuts = fitCuts(train.matrix)
  const model = fitGbt(binMatrix(train.matrix, cuts), train.y, binMatrix(valid.matrix, cuts), valid.y, { kind: 'l2' }, {
    trees: 100,
    learningRate: 0.1,
    maxDepth: 4,
    minLeafRows: 20,
    minLeafHessian: 1,
    lambda: 1,
    minGain: 0,
    featureFraction: 1,
    featureSampling: 'tree',
    subsample: 0.8,
    patience: 10,
    seed
  })
  const mean = train.y.reduce((sum, value) => sum + value, 0) / train.y.length
  let loss = 0
  let baseline = 0
  for (let row = 0; row < valid.matrix.rows; row++) {
    loss += lossOf({ kind: 'l2' }, valid.y[row], predictGbt(model, valid.matrix.data, row * valid.matrix.cols))
    baseline += lossOf({ kind: 'l2' }, valid.y[row], mean)
  }
  return { task: 'selftest', trees: model.trees.length, validLoss: loss / valid.matrix.rows, baselineLoss: baseline / valid.matrix.rows, ms: Date.now() - started }
}

parentPort?.on('message', (request: WorkerRequest) => {
  const reply = (result: SelftestResult | FitResult | FoldsResult | CalibrateResult | LabResult): void => void parentPort?.postMessage({ id: request.id, ok: true, result } satisfies WorkerReply)
  const fail = (error: unknown): void => void parentPort?.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerReply)
  try {
    if (request.task === 'selftest') reply(selftest(request.rows, Math.max(2, request.cols), request.seed))
    else if (request.task === 'fit') fit(request).then(reply, fail)
    else if (request.task === 'folds') folds(request).then(reply, fail)
    else if (request.task === 'calibrate') calibrate(request).then(reply, fail)
    else if (request.task === 'lab') lab(request).then(reply, fail)
    else fail(new Error('unknown task'))
  } catch (error) {
    fail(error)
  }
})
