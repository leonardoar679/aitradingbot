import { app } from 'electron'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { HORIZONS } from '../../shared/forecast/features'
import { foldModelName } from '../../shared/forecast/modelFile'
import { parseReplayFile, type ReplayFile } from '../../shared/forecast/replay'
import type { Promotion } from '../../shared/forecast/training'
import type { Fold } from '../../shared/forecast/walkForward'
import type { ForecastReplayState } from '../../shared/ipc'
import { getForecastTrainingState, onForecastTraining } from './forecastTrainingService'
import { askWorker } from './forecastWorkerService'

// THE REPLAY OUT OF SAMPLE, IN THE APP (V7.2-R Stage 5, 22 October 2026; shared/forecast/replay.ts). Once a walk
// forward has ended, the newest one on file whose weeks' models were kept -- in use or not: a challenger refused for
// its final models still tested its weeks honestly -- is replayed in the forecast's worker (electron/forecast/
// trainWorker.ts, task 'replay'), after whatever the worker was asked before: its weeks after the first forecast
// again at every five-minute close with each week's own models and a calibration from the weeks before it alone, and
// the paper strategies played on the bars after them. What it says is kept in forecastModels/replay.json beside its
// filled trades (replay-trades.jsonl), the newest replay's alone; the Forecast Lab shows it and the research export
// carries it. A run replayed once is not replayed again; one that failed is tried again with the next walk forward.
//
// IT READS THE APP'S OWN BARS AND MODELS, AND NOTHING ELSE. No key, no model of anyone else's, no order: the
// strategies it plays are arithmetic on bars.

let state: ForecastReplayState = { status: 'waiting', runId: null, progress: null, lastError: null, file: null }
let making: Promise<void> | null = null
let started = false

function modelsDir(): string {
  return join(app.getPath('userData'), 'forecastModels')
}

/** A walk forward's weeks and the members it promoted, from the training log's line for it. */
async function walkForwardOf(runId: string): Promise<{ folds: Fold[]; promotions: Promotion[] } | null> {
  const names = (await readdir(modelsDir()).catch(() => [] as string[])).filter((name) => /^training-\d{4}-\d{2}\.jsonl$/.test(name)).sort().reverse()
  for (const name of names) {
    const text = await readFile(join(modelsDir(), name), 'utf-8').catch(() => '')
    for (const line of text.split('\n').reverse()) {
      if (!line.includes(runId)) continue
      try {
        const read = JSON.parse(line) as { runId?: unknown; folds?: unknown; promotions?: unknown }
        if (read.runId === runId && Array.isArray(read.folds) && Array.isArray(read.promotions)) return { folds: read.folds as Fold[], promotions: read.promotions as Promotion[] }
      } catch {
        // A torn line: skipped.
      }
    }
  }
  return null
}

/** The newest walk forward on file that kept every week's models after the first, with its weeks and promotions. */
export async function replayableRun(): Promise<{ runId: string; folds: Fold[]; promotions: Promotion[] } | null> {
  const runs = (await readdir(modelsDir()).catch(() => [] as string[])).filter((name) => /^run-\d{8}-\d{4}$/.test(name)).sort().reverse()
  for (const runId of runs) {
    const files = new Set(await readdir(join(modelsDir(), runId)).catch(() => [] as string[]))
    if (![...files].some((file) => file.startsWith('fold-'))) continue
    const walk = await walkForwardOf(runId)
    if (walk === null) continue
    const weeks = walk.folds.filter((fold) => fold.index >= 1)
    if (weeks.length === 0 || !weeks.every((fold) => HORIZONS.every((horizon) => files.has(foldModelName(fold.index, horizon))))) continue
    return { runId, ...walk }
  }
  return null
}

async function readKept(): Promise<ReplayFile | null> {
  const text = await readFile(join(modelsDir(), 'replay.json'), 'utf-8').catch(() => null)
  return text === null ? null : parseReplayFile(text)
}

async function make(target: { runId: string; folds: Fold[]; promotions: Promotion[] }): Promise<void> {
  state = { ...state, status: 'replaying', runId: target.runId, progress: null, lastError: null }
  try {
    const answer = await askWorker(
      { task: 'replay', dataDir: join(app.getPath('userData'), 'forecastData'), outDir: modelsDir(), runId: target.runId, folds: target.folds, promotions: target.promotions, nowSec: Math.floor(Date.now() / 1000) },
      (progress) => {
        state = { ...state, progress }
      }
    )
    if (!answer.ok) throw new Error(answer.error)
    const file = await readKept()
    if (file === null || file.runId !== target.runId) throw new Error(`the replay of ${target.runId} could not be read back`)
    state = { status: 'ready', runId: target.runId, progress: null, lastError: null, file }
  } catch (error) {
    state = { ...state, status: 'failed', runId: target.runId, progress: null, lastError: error instanceof Error ? error.message : String(error) }
    console.error('The replay out of sample failed:', error)
  }
}

/** The newest replayable walk forward's replay: read from its file, or made once the training is idle. */
async function ensure(): Promise<void> {
  if (making !== null) return
  const training = getForecastTrainingState()
  if (training.status === 'fitting' || training.status === 'testing') return
  const target = await replayableRun()
  if (target === null) {
    if (state.file === null) state = { status: 'waiting', runId: null, progress: null, lastError: null, file: null }
    return
  }
  if (state.file?.runId === target.runId) return
  if (state.status === 'failed' && state.runId === target.runId) return
  const kept = await readKept()
  if (kept !== null && kept.runId === target.runId) {
    state = { status: 'ready', runId: target.runId, progress: null, lastError: null, file: kept }
    return
  }
  if (kept !== null && state.file === null) state = { ...state, file: kept }
  making = make(target).finally(() => {
    making = null
  })
}

export function getForecastReplayState(): ForecastReplayState {
  return state
}

/** Starts the replay's watch: at launch, and after each change of the training's state. Called once, from main. */
export function startForecastReplay(): void {
  if (started) return
  started = true
  onForecastTraining(() => void ensure().catch((error) => console.error('The replay out of sample could not start:', error)))
  void ensure().catch((error) => console.error('The replay out of sample could not start:', error))
}

export const forecastReplayForTest = {
  ensure,
  /** The replay under way, if one is: a test waits for it. */
  making: (): Promise<void> | null => making,
  reset: (): void => {
    state = { status: 'waiting', runId: null, progress: null, lastError: null, file: null }
    making = null
    started = false
  }
}
