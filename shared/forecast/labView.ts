import type { Horizon } from './features'
import type { LeaderRow, LiveLab } from './lab'
import type { ClassRecord } from './opportunityClass'
import type { LabFile } from './labFile'
import type { ReplayRow } from './labWalkForward'
import type { ShockRule } from './shock'
import type { WorkerProgress } from './status'

// WHAT THE FORECAST LAB PAGE IS SHOWN (V6 Stage 11, 13 October 2026), as the main process's
// forecastLabService.ts reads it.

export interface ForecastLabStatus {
  state: 'waiting' | 'making' | 'ready' | 'failed'
  runId: string | null
  progress: WorkerProgress | null
  lastError: string | null
}

export interface ForecastLabView {
  version: string
  status: ForecastLabStatus
  /** The walk forward's Lab, made once a run. */
  lab: LabFile | null
  leaderboard: LeaderRow[]
  /** The live record of the last `liveDays`. */
  live: LiveLab
  liveDays: number
  /** Every opportunity class the replay or the trader's live paper holds, judged (V6 Stage 12). */
  classes: ClassRecord[]
  refit: { on: boolean; nextAt: number | null; trainingStatus: string; lastFitAt: number | null }
  /** The rule on Bitcoin's sharp moves of the calibration in use, by horizon (V6.1); empty before one. */
  shock: Partial<Record<Horizon, ShockRule>>
}

export interface ForecastReplay {
  pair: string
  /** Unix seconds: the tested hour. */
  t: number
  horizons: Partial<Record<Horizon, ReplayRow>>
  /** Five-minute bars from three hours before it to a day after. */
  path: { time: number; open: number; high: number; low: number; close: number }[]
  /** The coin's stories published from four hours before it to a day after, with the analyst's
   * reading where one is on file. */
  stories: { id: string; publishedAt: number; kind: string; reading: string | null }[]
}
