import type { Promotion } from './training'

// WHAT THE PRICE FORECAST STANDS AT (the V6 document; V6 Stages 5-7, 13 October 2026): its training
// (the main process's forecastTrainingService.ts) and its live engine (forecastService.ts), as the
// main process keeps them and the window is shown them.

/** A step of the worker's work: what it is doing and how far it is. */
export interface WorkerProgress {
  step: string
  done: number
  total: number
}

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

export interface EngineState {
  status: 'waiting' | 'running'
  /** What it waits for: the models, their calibration, or the bars of the close. */
  waitingFor: 'models' | 'calibration' | 'bars' | null
  /** Unix seconds: the close of the last pass; how long it took. */
  lastPassAt: number | null
  lastPassMs: number | null
  /** Pairs forecast at the last pass. */
  predictions: number
  /** Since the app started: forecasts recorded, outcomes written (and of them missing), forecasts made
   * again between closes. */
  recorded: number
  outcomes: number
  missing: number
  refreshes: number
  /** Horizons of recorded forecasts still owed an outcome. */
  pending: number
  lastError: string | null
  /** The market's shock state as last read (V7.1 Stage 11; shared/forecast/marketShock.ts): at the last
   * close, or from Bitcoin's live minutes since; null before a pass. Absent on a state from before. */
  market?: { state: string; btc15: number; btc1h: number; breadth15: number; volAcc15: number; readAt: number } | null
}
