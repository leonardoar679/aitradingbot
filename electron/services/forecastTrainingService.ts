import { app } from 'electron'
import { mkdir, readFile, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { parseRunCalibration } from '../../shared/forecast/calibrationFile'
import { HORIZONS, type Horizon } from '../../shared/forecast/features'
import { parseFitted } from '../../shared/forecast/modelFile'
import type { FittedHorizon } from '../../shared/forecast/models'
import type { RunCalibration } from '../../shared/forecast/runCalibration'
import { MIN_READY_PAIRS, fitDueAtStart, healForecastSettings, nextNightlyAt, promotionsOf, runIdAt, runsToSweep, type Promotion } from '../../shared/forecast/training'
import type { CalibrateResult, FitResult, FoldsResult } from '../forecast/trainWorker'
import { writeJsonAtomic } from './atomicWrite'
import { getForecastDataStatus, onForecastBars } from './forecastDataService'
import { askWorker, type WorkerProgress } from './forecastWorkerService'
import { appendJsonLine } from './jsonlStore'
import { getSettings } from './settingsService'

// THE FORECAST'S FITS, KEPT AND RUN (the V6 document, §13, §51 and §104; V6 Stage 5, 13 October 2026;
// the rules are shared/forecast/training.ts).
//
// It waits for the forecast's bars (forecastDataService.ts) to be there for enough pairs, asks the
// worker for a FIT -- every model at every horizon on every row -- and then for the WALK FORWARD,
// which scores each model on weeks it was not fitted on and decides which weigh. Every night at half
// past midnight UTC it does both again on the newest ninety days, unless the refit is switched off.
//
// ON FILE (forecastModels/): a folder a run, with its five horizons' models (<horizon>.json), its
// out-of-sample record (oos-<horizon>.bin) and the calibration made from it (calibration.json, V6
// Stage 6); current.json, naming the run in use and the walk forward whose verdicts and calibration
// hold; and training-YYYY-MM.jsonl, a line for every fit, walk forward and calibration, whether it
// worked, how long it took and what it found. The run in use and the one before it are kept; older
// ones are deleted. A walk forward's calibration that is missing or of another version is made again
// from its record on file, without fitting anything.
//
// IT FITS ON PUBLIC MARKET DATA AND NOTHING ELSE. No key, no model of anyone else's, no order.

export type TrainingStatus = 'waiting' | 'fitting' | 'testing' | 'ready' | 'failed'

export interface TrainingState {
  status: TrainingStatus
  /** The run in use, when it was fitted, and the walk forward whose verdicts hold. */
  current: { runId: string; fittedAt: number; foldsRunId: string | null } | null
  /** The walk forward whose calibration is in use; null before there is one. */
  calibratedRunId: string | null
  progress: WorkerProgress | null
  lastError: string | null
  /** Seconds: the next nightly refit, when it is on. */
  nextRefitAt: number | null
  promotions: Promotion[]
}

interface CurrentFile {
  runId: string
  fittedAt: number
  foldsRunId: string | null
  promotions: Promotion[]
}

const state: TrainingState = { status: 'waiting', current: null, calibratedRunId: null, progress: null, lastError: null, nextRefitAt: null, promotions: [] }
let models: Map<Horizon, FittedHorizon> = new Map()
let calibration: RunCalibration | null = null
let started = false
let running: Promise<void> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function modelsDir(): string {
  return join(app.getPath('userData'), 'forecastModels')
}

function tell(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('A forecast-training listener failed:', error)
    }
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const monthOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 7)

async function record(line: Record<string, unknown>): Promise<void> {
  const at = Math.floor(Date.now() / 1000)
  await appendJsonLine(join(modelsDir(), `training-${monthOf(at)}.jsonl`), { at, ...line }).catch((error) => console.error('A training record could not be written:', error))
}

/** A run's five horizons' models from their files; null when any is missing or damaged. */
async function loadRun(runId: string): Promise<Map<Horizon, FittedHorizon> | null> {
  const out = new Map<Horizon, FittedHorizon>()
  for (const horizon of HORIZONS) {
    const text = await readFile(join(modelsDir(), runId, `${horizon}.json`), 'utf-8').catch(() => null)
    const fitted = text === null ? null : parseFitted(text)
    if (fitted === null || fitted.horizon !== horizon) return null
    out.set(horizon, fitted)
  }
  return out
}

/** A walk forward's calibration from its file; null when it is missing, damaged or of another version. */
async function loadCalibration(runId: string): Promise<RunCalibration | null> {
  const text = await readFile(join(modelsDir(), runId, 'calibration.json'), 'utf-8').catch(() => null)
  const read = text === null ? null : parseRunCalibration(text)
  return read !== null && read.runId === runId ? read : null
}

/** Puts a walk forward's calibration in use: from its file, or made again from its record. */
async function useCalibration(runId: string, promotions: Promotion[]): Promise<void> {
  let read = await loadCalibration(runId)
  if (read === null) {
    const answer = await askWorker({ task: 'calibrate', outDir: modelsDir(), runId, promotions })
    if (!answer.ok) throw new Error(answer.error)
    const made = answer.result as CalibrateResult
    await record({ kind: 'calibrate', runId, ok: true, ms: made.ms, calibration: made.calibration })
    read = await loadCalibration(runId)
    if (read === null) throw new Error(`the calibration of ${runId} could not be read back`)
  }
  calibration = read
  state.calibratedRunId = runId
}

async function writeCurrent(file: CurrentFile): Promise<void> {
  await mkdir(modelsDir(), { recursive: true })
  await writeJsonAtomic(join(modelsDir(), 'current.json'), file)
}

async function readCurrent(): Promise<CurrentFile | null> {
  const text = await readFile(join(modelsDir(), 'current.json'), 'utf-8').catch(() => null)
  if (text === null) return null
  try {
    const raw = JSON.parse(text) as Partial<CurrentFile>
    if (typeof raw.runId !== 'string' || typeof raw.fittedAt !== 'number') return null
    return { runId: raw.runId, fittedAt: raw.fittedAt, foldsRunId: typeof raw.foldsRunId === 'string' ? raw.foldsRunId : null, promotions: Array.isArray(raw.promotions) ? raw.promotions : [] }
  } catch {
    return null
  }
}

async function sweepRuns(inUse: string[]): Promise<void> {
  const names = await readdir(modelsDir()).catch(() => [] as string[])
  for (const runId of runsToSweep(names, inUse)) await rm(join(modelsDir(), runId), { recursive: true, force: true }).catch(() => undefined)
}

/** A fit, then its walk forward: the models put in use as soon as the fit is read back, the verdicts
 * when the walk forward ends. One at a time. */
function runTraining(why: 'first' | 'nightly' | 'stale'): Promise<void> {
  if (running !== null) return running
  running = (async (): Promise<void> => {
    const nowSec = Math.floor(Date.now() / 1000)
    const runId = runIdAt(nowSec)
    const dataDir = join(app.getPath('userData'), 'forecastData')
    state.status = 'fitting'
    state.lastError = null
    tell()
    try {
      const fitAnswer = await askWorker({ task: 'fit', dataDir, outDir: modelsDir(), runId, nowSec }, (progress) => {
        state.progress = progress
        tell()
      })
      if (!fitAnswer.ok) throw new Error(fitAnswer.error)
      const fit = fitAnswer.result as FitResult
      const loaded = await loadRun(runId)
      if (loaded === null) throw new Error(`the models of ${runId} could not be read back`)
      models = loaded
      const kept = await readCurrent()
      const current: CurrentFile = { runId, fittedAt: nowSec, foldsRunId: kept?.foldsRunId ?? null, promotions: kept?.promotions ?? [] }
      await writeCurrent(current)
      state.current = { runId, fittedAt: nowSec, foldsRunId: current.foldsRunId }
      state.promotions = current.promotions
      await record({ kind: 'fit', why, runId, ok: true, ms: fit.ms, rows: fit.rows, span: fit.span, symbols: fit.symbols.length, horizons: fit.horizons })
      tell()

      state.status = 'testing'
      tell()
      const foldsAnswer = await askWorker({ task: 'folds', dataDir, outDir: modelsDir(), runId, nowSec }, (progress) => {
        state.progress = progress
        tell()
      })
      if (!foldsAnswer.ok) throw new Error(foldsAnswer.error)
      const folds = foldsAnswer.result as FoldsResult
      const promotions = promotionsOf(folds.horizons)
      const made = await loadCalibration(runId)
      if (made === null) throw new Error(`the calibration of ${runId} could not be read back`)
      await writeCurrent({ ...current, foldsRunId: runId, promotions })
      state.current = { runId, fittedAt: nowSec, foldsRunId: runId }
      state.promotions = promotions
      calibration = made
      state.calibratedRunId = runId
      await record({
        kind: 'folds',
        why,
        runId,
        ok: true,
        ms: folds.ms,
        folds: folds.folds,
        horizons: folds.horizons.map((entry) => ({ horizon: entry.horizon, tested: entry.tested, kept: entry.kept, scores: entry.scores })),
        promotions,
        calibration: folds.calibration
      })
      await sweepRuns([runId])
      state.status = 'ready'
    } catch (error) {
      state.status = models.size > 0 ? 'ready' : 'failed'
      state.lastError = describe(error)
      await record({ kind: 'error', why, runId, ok: false, error: state.lastError })
      console.error('The forecast training failed:', error)
    } finally {
      state.progress = null
      running = null
      tell()
    }
  })()
  return running
}

/** The nightly refit, when it is on. */
async function nightlyRefit(): Promise<void> {
  const settings = healForecastSettings((await getSettings()).forecast)
  if (settings.refitNightly) await runTraining('nightly')
}

function scheduleNightly(): void {
  if (timer !== null) clearTimeout(timer)
  const nowSec = Math.floor(Date.now() / 1000)
  const at = nextNightlyAt(nowSec)
  state.nextRefitAt = at
  timer = setTimeout(
    () => {
      void nightlyRefit()
        .catch((error) => console.error('The nightly refit could not start:', error))
        .finally(scheduleNightly)
    },
    Math.max(1000, (at - nowSec) * 1000)
  )
}

/** Starts the forecast's training at launch: the run in use read back, a fit when one is due once the
 * bars are there, and the nightly refit. Called once, from electron/main.ts. */
export function startForecastTraining(): void {
  if (started) return
  started = true
  void (async (): Promise<void> => {
    const current = await readCurrent()
    if (current !== null) {
      const loaded = await loadRun(current.runId)
      if (loaded !== null) {
        models = loaded
        state.current = { runId: current.runId, fittedAt: current.fittedAt, foldsRunId: current.foldsRunId }
        state.promotions = current.promotions
        state.status = 'ready'
        tell()
        // The walk forward's calibration with its verdicts; a run whose models could not be read back
        // is fitted again, and walked forward again, below.
        const foldsRunId = current.foldsRunId
        if (foldsRunId !== null) {
          await useCalibration(foldsRunId, current.promotions).catch(async (error) => {
            state.lastError = describe(error)
            await record({ kind: 'error', why: 'calibrate', runId: foldsRunId, ok: false, error: state.lastError })
          })
          tell()
        }
      }
    }
    const settings = healForecastSettings((await getSettings()).forecast)
    const due = fitDueAtStart(state.current === null ? null : state.current.fittedAt, Math.floor(Date.now() / 1000), settings)
    scheduleNightly()
    if (!due) return
    // The first fit waits for the bars: told after each data pass.
    const tryStart = (): void => {
      if (running !== null) return
      const data = getForecastDataStatus()
      if (data.ready < Math.min(MIN_READY_PAIRS, Math.max(1, data.pairs))) return
      unsubscribe()
      void runTraining(state.current === null ? 'first' : 'stale')
    }
    const unsubscribe = onForecastBars(tryStart)
    tryStart()
  })().catch((error) => console.error('The forecast training could not start:', error))
}

/** What the training stands at. */
export function getForecastTrainingState(): TrainingState {
  return { ...state, promotions: [...state.promotions] }
}

/** The models in use, by horizon; empty before the first fit is read back. */
export function currentForecastModels(): ReadonlyMap<Horizon, FittedHorizon> {
  return models
}

/** The calibration in use: the newest walk forward's; null before the first is done. */
export function currentForecastCalibration(): RunCalibration | null {
  return calibration
}

/** Told when the models, the verdicts or the status change. */
export function onForecastTraining(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seams. */
export const forecastTrainingForTest = {
  run: runTraining,
  nightly: nightlyRefit,
  reset(): void {
    Object.assign(state, { status: 'waiting', current: null, calibratedRunId: null, progress: null, lastError: null, nextRefitAt: null, promotions: [] })
    models = new Map()
    calibration = null
    started = false
    running = null
    if (timer !== null) clearTimeout(timer)
    timer = null
    listeners.clear()
  }
}
