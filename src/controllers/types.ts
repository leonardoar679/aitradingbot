export type { ControllerConfig, ControllerRiskControls } from '../../shared/ipc'

/** Session-only, same reasoning as RoutineReport — a P&L snapshot every 5 minutes, persisted for
 * the app's lifetime, would grow settings.json unboundedly over long sessions. */
export interface ControllerSnapshot {
  id: string
  controllerId: string
  takenAt: number
  aggregatePnlQuote: number
  executorCount: number
}

export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000
