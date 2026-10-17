import { app } from 'electron'
import { mkdir, readFile, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { parseRunCalibration } from '../../shared/forecast/calibrationFile'
import { challengeRefusals, challengeSummary, compareRuns, type ChallengeVerdict } from '../../shared/forecast/challenger'
import { HORIZONS, type Horizon } from '../../shared/forecast/features'
import { parseFitted } from '../../shared/forecast/modelFile'
import type { DirectionModelId, FittedHorizon } from '../../shared/forecast/models'
import { tradeableVerdictsOf, type RunCalibration } from '../../shared/forecast/runCalibration'
import type { TrainingState } from '../../shared/forecast/status'
import { degradationOf, degradedForecastNotice } from '../../shared/forecast/promotion'
import { MIN_READY_PAIRS, fitDueAtStart, healForecastSettings, nextNightlyAt, promotionsOf, runIdAt, runsToSweep, type Promotion } from '../../shared/forecast/training'
import type { CalibrateResult, FitResult, FoldsResult } from '../forecast/trainWorker'
import { writeJsonAtomic } from './atomicWrite'
import { getForecastDataStatus, onForecastBars } from './forecastDataService'
import { askWorker } from './forecastWorkerService'
import { tell as tellNotice } from './noticeService'
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
// worked, how long it took and what it found. The run in use, the one before it and the newest
// challenger are kept; older ones are deleted. A walk forward's calibration that is missing or of
// another version is made again from its record on file, without fitting anything.
//
// CHAMPION AND CHALLENGER (V7.1 Stage 13; shared/forecast/challenger.ts): with a run in use, a refit's
// models wait on disk until its walk forward is set beside the champion's -- its honest figures no worse
// beyond the lines at any horizon -- and only then does current.json move, the champion kept as the run
// before to roll back to (rollbackForecastRun, a person's click on the Lab). A refit that loses is
// written to the training log with the comparison and kept on file; the champion stays as it was. The
// first fit, with nothing to beat, goes in use at once as it always has.
//
// IT FITS ON PUBLIC MARKET DATA AND NOTHING ELSE. No key, no model of anyone else's, no order.

interface RunInUse {
  runId: string
  fittedAt: number
  foldsRunId: string | null
  promotions: Promotion[]
}

interface CurrentFile extends RunInUse {
  /** The run in use before this one (V7.1 Stage 13), to roll back to; null where none. */
  previous?: RunInUse | null
}

const state: TrainingState = { status: 'waiting', current: null, calibratedRunId: null, progress: null, lastError: null, nextRefitAt: null, promotions: [], previousRunId: null, challenge: null }
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

/** Each model in use whose last week went wrong, told: once a day on its thread (§105). In use is
 * promoted at that horizon by the same walk forward: a model that never beat persistence weighs
 * nothing and is shown as not promoted, not as degraded (on the real record of 13 October most models
 * at 4 and 24 hours, which would have been told every night). Persistence, always in use, too: it
 * cannot lose to itself but can hold the wrong share or be off. It stays computed and on record;
 * nothing is switched off. */
function tellDegraded(horizons: FoldsResult['horizons'], promotions: readonly Promotion[]): string[] {
  const inUse = new Set(promotions.filter((promotion) => promotion.promoted).map((promotion) => `${promotion.model}:${promotion.horizon}`))
  const degraded: string[] = []
  for (const entry of horizons) {
    const floor = entry.lastWeek?.find((row) => row.model === 'persistence')?.score
    if (floor === undefined) continue
    for (const row of entry.lastWeek) {
      if (!inUse.has(`${row.model}:${entry.horizon}`)) continue
      const verdict = degradationOf(row.score, floor, null)
      if (!verdict.degraded) continue
      degraded.push(`${row.model}:${entry.horizon}`)
      try {
        tellNotice((i18n) => {
          const notice = degradedForecastNotice(row.model, entry.horizon, verdict.codes, i18n)
          return { title: notice.title, body: notice.body, extra: notice.extra }
        })
      } catch (error) {
        console.error('A degraded model could not be told:', error)
      }
    }
  }
  return degraded
}

/** Each promoted direction model whose last week found it degraded (V7.1 Stage 2; its skill below zero
 * on enough outcomes), told once a day on its thread as a range model is; nothing is switched off. */
function tellDegradedDirection(made: RunCalibration): string[] {
  const degraded: string[] = []
  for (const horizon of HORIZONS) {
    const report = made.horizons[horizon]?.direction
    if (report === undefined) continue
    for (const [model, entry] of Object.entries(report.models)) {
      if (entry === undefined || !entry.promoted || !entry.degraded) continue
      degraded.push(`${model}:${horizon}`)
      try {
        tellNotice((i18n) => {
          const notice = degradedForecastNotice(model as DirectionModelId, horizon, [{ code: 'direction', skill: entry.lastWeekSkill ?? 0 }], i18n)
          return { title: notice.title, body: notice.body, extra: notice.extra }
        })
      } catch (error) {
        console.error('A degraded direction model could not be told:', error)
      }
    }
  }
  return degraded
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
    const read = (entry: Partial<RunInUse> | null | undefined): RunInUse | null =>
      typeof entry?.runId !== 'string' || typeof entry.fittedAt !== 'number' ? null : { runId: entry.runId, fittedAt: entry.fittedAt, foldsRunId: typeof entry.foldsRunId === 'string' ? entry.foldsRunId : null, promotions: Array.isArray(entry.promotions) ? entry.promotions : [] }
    const current = read(raw)
    return current === null ? null : { ...current, previous: read(raw.previous) }
  } catch {
    return null
  }
}

const inUseOf = (file: RunInUse): RunInUse => ({ runId: file.runId, fittedAt: file.fittedAt, foldsRunId: file.foldsRunId, promotions: file.promotions })

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
      const kept = await readCurrent()
      // Champion and challenger (V7.1 Stage 13): with a run in use and its calibration, the fit's models wait
      // on disk for the walk forward's verdict; without one to beat, they go in use at once, as the first
      // fit always has.
      const champion = kept !== null && calibration !== null && models.size > 0 ? { file: kept, calibration } : null
      let current: CurrentFile = { runId, fittedAt: nowSec, foldsRunId: kept?.foldsRunId ?? null, promotions: kept?.promotions ?? [], previous: kept?.previous ?? null }
      if (champion === null) {
        const loaded = await loadRun(runId)
        if (loaded === null) throw new Error(`the models of ${runId} could not be read back`)
        models = loaded
        await writeCurrent(current)
        state.current = { runId, fittedAt: nowSec, foldsRunId: current.foldsRunId }
        state.promotions = current.promotions
      }
      await record({ kind: 'fit', why, runId, ok: true, ms: fit.ms, rows: fit.rows, span: fit.span, symbols: fit.symbols.length, horizons: fit.horizons, challenger: champion !== null })
      tell()

      state.status = 'testing'
      tell()
      // The run in use's tradeable verdicts go with the walk forward (V7.2 Stage 2): a direction model is a
      // P(up) source only where two walk forwards in a row found it tradeable. And the champion's walk forward
      // is named (V7.2 Stage 3), for the worker to pair the two on the hours both tested.
      const foldsAnswer = await askWorker(
        { task: 'folds', dataDir, outDir: modelsDir(), runId, nowSec, ...(champion === null ? {} : { heldBefore: tradeableVerdictsOf(champion.calibration), championRunId: champion.file.foldsRunId ?? champion.file.runId }) },
        (progress) => {
          state.progress = progress
          tell()
        }
      )
      if (!foldsAnswer.ok) throw new Error(foldsAnswer.error)
      const folds = foldsAnswer.result as FoldsResult
      const promotions = promotionsOf(folds.horizons)
      const made = await loadCalibration(runId)
      if (made === null) throw new Error(`the calibration of ${runId} could not be read back`)
      const degraded = [...tellDegraded(folds.horizons, promotions), ...tellDegradedDirection(made)]
      const horizons = folds.horizons.map((entry) => ({ horizon: entry.horizon, tested: entry.tested, kept: entry.kept, scores: entry.scores }))
      let verdict: ChallengeVerdict | null = null
      if (champion !== null) {
        // Beyond noise (V7.2 Stage 3): the paired figures where the worker could pair the two, the tolerances
        // alone where it could not.
        verdict = compareRuns(champion.calibration, made, folds.paired ?? null, folds.newerDays ?? null)
        state.challenge = { at: nowSec, runId, championRunId: champion.file.runId, adopted: verdict.adopted, verdict }
        if (!verdict.adopted) {
          // The challenger loses, or is within noise: on the log with the comparison, on file for the Lab, in use nowhere.
          await record({ kind: 'rejected', why, runId, ok: true, ms: folds.ms, championRunId: champion.file.runId, verdictWhy: verdict.why, summary: challengeSummary(verdict), refusals: challengeRefusals(verdict), challenge: verdict, folds: folds.folds, horizons, promotions, calibration: folds.calibration, degraded })
          await sweepRuns([champion.file.runId, ...(champion.file.previous === null || champion.file.previous === undefined ? [] : [champion.file.previous.runId])])
          state.status = 'ready'
          return
        }
        const loaded = await loadRun(runId)
        if (loaded === null) throw new Error(`the models of ${runId} could not be read back`)
        models = loaded
        current = { runId, fittedAt: nowSec, foldsRunId: runId, promotions, previous: inUseOf(champion.file) }
        state.previousRunId = champion.file.runId
      } else {
        current = { ...current, foldsRunId: runId, promotions }
      }
      await writeCurrent(current)
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
        horizons,
        promotions,
        calibration: folds.calibration,
        degraded,
        ...(verdict === null ? {} : { championRunId: champion!.file.runId, verdictWhy: verdict.why, summary: challengeSummary(verdict), challenge: verdict })
      })
      await sweepRuns([runId, ...(current.previous === null || current.previous === undefined ? [] : [current.previous.runId])])
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
        state.previousRunId = current.previous?.runId ?? null
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

/** The run before the one in use put back in use (V7.1 Stage 13): its models read from their files, its
 * walk forward's calibration from its own, current.json moved with the run rolled back from kept as the one
 * before, so a person can come back; on the training log as a rollback. Nothing else is touched. Refused
 * while a fit runs, without a run before, or where the files cannot be read back. */
export async function rollbackForecastRun(): Promise<{ ok: boolean; error: string | null }> {
  if (running !== null) return { ok: false, error: 'a fit is running; roll back when it is done' }
  const current = await readCurrent()
  const previous = current?.previous ?? null
  if (current === null || previous === null) return { ok: false, error: 'no run before this one is on file' }
  const loaded = await loadRun(previous.runId)
  if (loaded === null) return { ok: false, error: `the models of ${previous.runId} could not be read back` }
  let made: RunCalibration | null = null
  if (previous.foldsRunId !== null) {
    made = await loadCalibration(previous.foldsRunId)
    if (made === null) return { ok: false, error: `the calibration of ${previous.foldsRunId} could not be read back` }
  }
  models = loaded
  calibration = made
  state.calibratedRunId = made === null ? null : previous.foldsRunId
  const next: CurrentFile = { ...inUseOf(previous), previous: inUseOf(current) }
  await writeCurrent(next)
  state.current = { runId: next.runId, fittedAt: next.fittedAt, foldsRunId: next.foldsRunId }
  state.promotions = next.promotions
  state.previousRunId = current.runId
  state.lastError = null
  await record({ kind: 'rollback', ok: true, from: current.runId, to: previous.runId })
  tell()
  return { ok: true, error: null }
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
    Object.assign(state, { status: 'waiting', current: null, calibratedRunId: null, progress: null, lastError: null, nextRefitAt: null, promotions: [], previousRunId: null, challenge: null })
    models = new Map()
    calibration = null
    started = false
    running = null
    if (timer !== null) clearTimeout(timer)
    timer = null
    listeners.clear()
  }
}
