import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { coarseBars, type CoarseWidth, type ForecastBar } from '../../shared/forecast/bars'
import { HORIZONS, PAIR_CLASSES, type Horizon } from '../../shared/forecast/features'
import { FORECAST_RECORD_DAYS, isMissing, parseOutcomeLine, parsePassLine, parsePredictionLine, recordMonth, type OutcomeLine, type PassLine, type PredictionLine } from '../../shared/forecast/forecastRecord'
import { LAB_LINES, LAB_VERSION, leaderboardOf, liveLab, type LeaderRow, type LiveLab } from '../../shared/forecast/lab'
import { parseLab, parseReplay, type LabFile } from '../../shared/forecast/labFile'
import type { ReplayRow } from '../../shared/forecast/labWalkForward'
import type { MemberWeight } from '../../shared/forecast/ensemble'
import type { ForecastModelId } from '../../shared/forecast/models'
import type { DirectionView, ForecastLabStatus, ForecastLabView, ForecastReplay } from '../../shared/forecast/labView'
import { directionSourceOf } from '../../shared/forecast/runCalibration'
import { healForecastSettings } from '../../shared/forecast/training'
import type { ModelScore } from '../../shared/forecast/walkForward'
import { classTable, type ClassRecord, type ClassVerdict } from '../../shared/forecast/opportunityClass'
import { EVENT_IMPACT } from '../../shared/calendar/eventImpact'
import { MACRO_CALENDAR_READ_AT, nextReleases } from '../../shared/calendar/macro'
import type { Candle, ExecutorConfig, ForecastHistory, PositionExecutorParams } from '../../shared/ipc'
import { readForecastBars } from './forecastDataService'
import { forecastNewsReadings } from './forecastService'
import { currentForecastCalibration, getForecastTrainingState, onForecastTraining } from './forecastTrainingService'
import { askWorker } from './forecastWorkerService'
import { appendJsonLine } from './jsonlStore'
import { newsHistory } from './newsFeedService'
import { getSettings } from './settingsService'

// THE FORECAST LAB, FROM THE MAIN PROCESS'S SIDE (the V6 document, §27-28, §42-43, §49-50, §90-105; V6
// Stage 11, 13 October 2026). Once a walk forward's calibration is in use, the worker makes its Lab
// (electron/forecast/trainWorker.ts, task 'lab') -- the record scored, called, replayed as trades and
// set beside the bars and the stories around it -- into forecastModels/<run>/lab.json, once a run; a
// run whose Lab is on file at its version is not made again. What the window is shown beside it is
// read when asked: the live record of the last week (forecasts/), the leaderboard from the walk
// forward's own training record, and, for one pair and hour, the replay.
//
// IT READS PUBLIC MARKET DATA, THE APP'S OWN RECORDS AND THE NEWS ON FILE, AND NOTHING ELSE. No key, no
// model of anyone else's, no order.


let lab: LabFile | null = null
let status: ForecastLabStatus = { state: 'waiting', runId: null, progress: null, lastError: null }
let making: Promise<void> | null = null
const replays = new Map<string, ReplayRow[]>()
/** Every opportunity class judged, by key, read again a minute at most after it was last read. */
let classes: { at: number; records: ClassRecord[]; byKey: Map<string, ClassRecord> } = { at: 0, records: [], byKey: new Map() }
const CLASSES_MS = 60_000
/** A pair's bars read from its files, kept a minute: a comparison reads each pair at two widths. */
const onFile = new Map<string, { at: number; bars: Promise<ForecastBar[]> }>()
const ON_FILE_MS = 60_000

function barsOf(pair: string): Promise<ForecastBar[]> {
  const now = Date.now()
  const held = onFile.get(pair)
  if (held !== undefined && now - held.at < ON_FILE_MS) return held.bars
  const bars = readForecastBars(pair).catch(() => [] as ForecastBar[])
  onFile.set(pair, { at: now, bars })
  return bars
}

function modelsDir(): string {
  return join(app.getPath('userData'), 'forecastModels')
}

function recordsDir(): string {
  return join(app.getPath('userData'), 'forecasts')
}

async function readLab(runId: string): Promise<LabFile | null> {
  const text = await readFile(join(modelsDir(), runId, 'lab.json'), 'utf-8').catch(() => null)
  const read = text === null ? null : parseLab(text)
  return read !== null && read.runId === runId ? read : null
}

async function make(runId: string): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  status = { state: 'making', runId, progress: null, lastError: null }
  const started = Date.now()
  try {
    const marks = await newsHistory(nowSec - 40 * 86_400, nowSec)
    const answer = await askWorker(
      {
        task: 'lab',
        dataDir: join(app.getPath('userData'), 'forecastData'),
        outDir: modelsDir(),
        runId,
        promotions: getForecastTrainingState().promotions,
        stories: marks.map((mark) => ({ publishedAt: mark.publishedAt, tickers: mark.tickers, eventType: mark.eventType })),
        nowSec
      },
      (progress) => {
        status = { ...status, progress }
      }
    )
    if (!answer.ok) throw new Error(answer.error)
    const read = await readLab(runId)
    if (read === null) throw new Error(`the Lab of ${runId} could not be read back`)
    lab = read
    replays.clear()
    status = { state: 'ready', runId, progress: null, lastError: null }
    await readClasses().catch(() => undefined)
    await appendJsonLine(join(modelsDir(), `training-${recordMonth(nowSec)}.jsonl`), { at: nowSec, kind: 'lab', runId, ok: true, ms: Date.now() - started }).catch(() => undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status = { state: 'failed', runId, progress: null, lastError: message }
    await appendJsonLine(join(modelsDir(), `training-${recordMonth(nowSec)}.jsonl`), { at: nowSec, kind: 'lab', runId, ok: false, error: message }).catch(() => undefined)
  }
}

/** The Lab of the walk forward in use: read from its file, or made once the training is idle. */
async function ensure(): Promise<void> {
  const training = getForecastTrainingState()
  const runId = training.calibratedRunId
  if (runId === null || making !== null) return
  if (lab !== null && lab.runId === runId) return
  if (status.state === 'failed' && status.runId === runId) return
  const read = await readLab(runId)
  if (read !== null) {
    lab = read
    replays.clear()
    status = { state: 'ready', runId, progress: null, lastError: null }
    await readClasses().catch(() => undefined)
    return
  }
  // A walk forward or a fit under way comes first; the worker answers one request at a time.
  if (training.status === 'fitting' || training.status === 'testing') return
  making = make(runId).finally(() => {
    making = null
  })
}

export function startForecastLab(): void {
  onForecastTraining(() => void ensure().catch((error) => console.error('The forecast Lab could not be made:', error)))
  void ensure()
    .then(() => readClasses())
    .catch((error) => console.error('The forecast Lab could not be made:', error))
  const timer = setInterval(() => void readClasses().catch(() => undefined), CLASSES_MS)
  timer.unref?.()
}

/** The forecast trader's closed paper trades, by class, net in percent of what each staked. */
function livePaper(executors: readonly ExecutorConfig[]): { classKey: string; netPct: number }[] {
  const out: { classKey: string; netPct: number }[] = []
  for (const executor of executors) {
    const mark = executor.forecast
    if (executor.mode !== 'paper' || mark?.result === undefined || mark.result.exit === 'entry_expired') continue
    const stake = (executor.params as PositionExecutorParams).amountQuote
    if (!(stake > 0)) continue
    out.push({ classKey: mark.classKey, netPct: (mark.result.pnlQuote / stake) * 100 })
  }
  return out
}

/** Every class judged now (shared/forecast/opportunityClass.ts): the Lab's replay as the rules stand, and
 * the trader's own paper. */
async function readClasses(): Promise<ClassRecord[]> {
  const history = lab === null ? [] : HORIZONS.flatMap((horizon) => (lab?.horizons[horizon]?.trades.rules ?? []).filter((trade) => trade.classKey !== undefined).map((trade) => ({ classKey: trade.classKey as string, netPct: trade.netPct })))
  const settings = await getSettings().catch(() => ({ executors: [] as ExecutorConfig[] }))
  const records = classTable(history, livePaper(settings.executors ?? []))
  classes = { at: Date.now(), records, byKey: new Map(records.map((record) => [record.key, record])) }
  return records
}

/** How a class stands, as last read: NOT ENOUGH where neither record holds it. What the engine's
 * decisions are judged by (electron/main.ts hands it in). */
export function forecastClassVerdict(key: string): ClassVerdict {
  return classes.byKey.get(key)?.verdict ?? 'NOT_ENOUGH'
}

/** The record's lines of a kind from `fromSec` on, every pair. */
async function readRecord(kind: 'predictions' | 'outcomes' | 'passes', fromSec: number): Promise<unknown[]> {
  const nowSec = Math.floor(Date.now() / 1000)
  const months = [...new Set([recordMonth(Math.max(fromSec, nowSec - FORECAST_RECORD_DAYS * 86_400)), recordMonth(nowSec)])].sort()
  const out: unknown[] = []
  for (const month of months) {
    const text = await readFile(join(recordsDir(), `${kind}-${month}.jsonl`), 'utf-8').catch(() => '')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A torn line: skipped.
      }
    }
  }
  return out
}

/** The forecasts on record made at closes in a span, every pair, and every outcome of them on file (V6
 * Stage 15): what a run's report judges. */
export async function forecastRecordSpan(fromSec: unknown, toSec: unknown): Promise<ForecastHistory> {
  if (typeof fromSec !== 'number' || typeof toSec !== 'number' || !Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec) return { predictions: [], outcomes: [] }
  const predictions = (await readRecord('predictions', fromSec)).map(parsePredictionLine).filter((line): line is PredictionLine => line !== null && line.t >= fromSec && line.t <= toSec)
  const ids = new Set(predictions.map((line) => line.id))
  const outcomes = (await readRecord('outcomes', fromSec)).map(parseOutcomeLine).filter((line): line is NonNullable<ReturnType<typeof parseOutcomeLine>> => line !== null && ids.has(line.id))
  // The pairs each close's pass held bars for (since V6 Stage 16): what the history gate wants forecast.
  const passes = (await readRecord('passes', fromSec)).map(parsePassLine).filter((line): line is PassLine => line !== null && line.t >= fromSec && line.t <= toSec)
  return { predictions, outcomes, passes }
}

async function readLive(nowSec: number): Promise<LiveLab> {
  const fromSec = nowSec - LAB_LINES.liveDays * 86_400
  // The week is cut on the forecasts: an outcome is read with the forecast it judged, or not at all.
  const predictions = (await readRecord('predictions', fromSec)).map(parsePredictionLine).filter((line): line is PredictionLine => line !== null && line.t >= fromSec)
  const outcomes = (await readRecord('outcomes', fromSec)).map(parseOutcomeLine).filter((line): line is OutcomeLine => line !== null && !isMissing(line))
  return liveLab(predictions, outcomes)
}

interface FoldsLine {
  kind: 'folds'
  runId: string
  ok: boolean
  horizons: { horizon: Horizon; scores: { model: ForecastModelId; overall: ModelScore }[] }[]
  degraded?: string[]
}

/** The walk forward's own training record: its scores by model, and the models it found degraded. */
async function foldsOf(runId: string): Promise<FoldsLine | null> {
  const nowSec = Math.floor(Date.now() / 1000)
  const months: string[] = []
  for (let back = 0; back < 3; back++) months.push(recordMonth(nowSec - back * 28 * 86_400))
  for (const month of [...new Set(months)]) {
    const text = await readFile(join(modelsDir(), `training-${month}.jsonl`), 'utf-8').catch(() => '')
    const lines = text.split('\n').filter((line) => line.includes('"kind":"folds"') && line.includes(`"runId":"${runId}"`))
    for (const line of lines.reverse()) {
      try {
        const raw = JSON.parse(line) as FoldsLine
        if (raw.ok === true && Array.isArray(raw.horizons)) return raw
      } catch {
        // A torn line: skipped.
      }
    }
  }
  return null
}

async function leaderboard(): Promise<LeaderRow[]> {
  const training = getForecastTrainingState()
  const runId = training.current?.foldsRunId ?? training.calibratedRunId
  if (runId === null) return []
  const folds = await foldsOf(runId)
  if (folds === null) return []
  const calibration = currentForecastCalibration()
  const weights: Partial<Record<Horizon, readonly MemberWeight[]>> = {}
  for (const horizon of HORIZONS) {
    const pooled = calibration?.horizons[horizon]?.variants.v2.weights.pooled
    if (pooled !== undefined) weights[horizon] = pooled
  }
  return leaderboardOf(folds.horizons, training.promotions, weights, folds.degraded ?? [])
}

/** Everything the Lab page shows, read now. */
export async function getForecastLab(): Promise<ForecastLabView> {
  await ensure().catch(() => undefined)
  const nowSec = Math.floor(Date.now() / 1000)
  const training = getForecastTrainingState()
  const settings = healForecastSettings((await getSettings().catch(() => ({ forecast: undefined }))).forecast)
  return {
    version: LAB_VERSION,
    status,
    lab,
    leaderboard: await leaderboard(),
    live: await readLive(nowSec),
    liveDays: LAB_LINES.liveDays,
    classes: Date.now() - classes.at < CLASSES_MS ? classes.records : await readClasses(),
    refit: {
      on: settings.refitNightly,
      nextAt: training.nextRefitAt,
      trainingStatus: training.status,
      lastFitAt: training.current?.fittedAt ?? null,
      champion: training.current === null ? null : { runId: training.current.runId, foldsRunId: training.current.foldsRunId },
      previousRunId: training.previousRunId ?? null,
      challenge: training.challenge ?? null
    },
    shock: shockRulesInUse(),
    marketShock: marketShockRulesInUse(),
    direction: directionInUse(),
    // The macro calendar (V7.1 Stage 12): the next releases, and what past ones did.
    calendar: { readAt: MACRO_CALENDAR_READ_AT, next: nextReleases(nowSec, NEXT_RELEASES), impact: EVENT_IMPACT }
  }
}

/** How many of the calendar's coming releases the page lists. */
const NEXT_RELEASES = 6

/** The calibration in use's rules by market shock state, by horizon (V7.1 Stage 11). */
function marketShockRulesInUse(): ForecastLabView['marketShock'] {
  const calibration = currentForecastCalibration()
  const out: ForecastLabView['marketShock'] = {}
  for (const horizon of HORIZONS) {
    const rules = calibration?.horizons[horizon]?.marketShock
    if (rules !== undefined) out[horizon] = rules
  }
  return out
}

/** The calibration in use's direction models, by horizon (V7.1 Stage 2), and which source each pair class
 * reads its P(up) from. */
function directionInUse(): ForecastLabView['direction'] {
  const calibration = currentForecastCalibration()
  const out: ForecastLabView['direction'] = {}
  for (const horizon of HORIZONS) {
    const entry = calibration?.horizons[horizon]
    if (entry?.direction === undefined) continue
    const view: DirectionView = { report: entry.direction, inUse: {} }
    for (const cls of PAIR_CLASSES) {
      const { source } = directionSourceOf(entry, cls)
      ;(view.inUse[source] ??= []).push(cls)
    }
    out[horizon] = view
  }
  return out
}

/** The calibration in use's rule on Bitcoin's sharp moves, by horizon (V6.1). */
function shockRulesInUse(): ForecastLabView['shock'] {
  const calibration = currentForecastCalibration()
  const out: ForecastLabView['shock'] = {}
  for (const horizon of HORIZONS) {
    const rule = calibration?.horizons[horizon]?.shock
    if (rule !== undefined) out[horizon] = rule
  }
  return out
}

async function replayRows(horizon: Horizon): Promise<ReplayRow[]> {
  if (lab === null) return []
  const key = `${lab.runId}:${horizon}`
  const cached = replays.get(key)
  if (cached !== undefined) return cached
  const text = await readFile(join(modelsDir(), lab.runId, `lab-replay-${horizon}.json`), 'utf-8').catch(() => null)
  const rows = text === null ? [] : (parseReplay(text)?.rows ?? [])
  replays.set(key, rows)
  return rows
}

/** One pair's tested hour as the walk forward forecast it, and what came. Null where it was not tested. */
export async function forecastReplay(pair: unknown, t: unknown): Promise<ForecastReplay | null> {
  if (typeof pair !== 'string' || typeof t !== 'number' || !Number.isFinite(t) || lab === null) return null
  const hour = Math.floor(t / 3600) * 3600
  const horizons: ForecastReplay['horizons'] = {}
  for (const horizon of HORIZONS) {
    const row = (await replayRows(horizon)).find((entry) => entry.pair === pair && entry.t === hour)
    if (row !== undefined) horizons[horizon] = row
  }
  if (Object.keys(horizons).length === 0) return null
  // The bars on file: the tested weeks are older than the days the live forecast holds.
  const path = (await barsOf(pair)).filter((bar) => bar.time >= hour - 3 * 3600 && bar.time < hour + 86_400).map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close }))
  const ticker = pair.replace(/USDT$/, '')
  const readings = forecastNewsReadings()
  const stories = (await newsHistory(hour - 4 * 3600, hour + 86_400))
    .filter((mark) => mark.tickers.includes(ticker))
    .map((mark) => {
      const reading = readings[mark.id]
      return { id: mark.id, publishedAt: mark.publishedAt, kind: mark.eventType, reading: reading === undefined ? null : `${reading.direction}, impact ${reading.impact}${reading.pricedIn ? ', priced in' : ''}` }
    })
  return { pair, t: hour, horizons, path, stories }
}

const WIDTHS: readonly CoarseWidth[] = ['15m', '1h', '4h']

/** A pair's bars on file at a width, as candles, for the strategies the Lab sets beside the forecast. */
export async function forecastBars(pair: unknown, width: unknown, fromSec: unknown, toSec: unknown): Promise<Candle[]> {
  if (typeof pair !== 'string' || !/^[A-Z0-9]{2,20}$/.test(pair) || !WIDTHS.includes(width as CoarseWidth) || typeof fromSec !== 'number' || typeof toSec !== 'number' || !(toSec > fromSec)) return []
  const bars = await barsOf(pair)
  if (bars.length === 0) return []
  return coarseBars(bars, width as CoarseWidth, toSec)
    .filter((bar) => bar.time >= fromSec)
    .map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }))
}

/** Test seams. */
export const forecastLabForTest = {
  ensure,
  reset(): void {
    lab = null
    status = { state: 'waiting', runId: null, progress: null, lastError: null }
    making = null
    replays.clear()
    onFile.clear()
    classes = { at: 0, records: [], byKey: new Map() }
  },
  readClasses,
  making: (): Promise<void> | null => making
}
