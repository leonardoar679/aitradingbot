import type { BacktestResult } from '../backtest/engine'

export type { RoutineConfig } from '../../shared/ipc'

/** Session-only — not persisted. Storing full equity curves in the settings JSON file on every
 * scheduled run would grow it unboundedly; this resets when the app closes, same tradeoff as
 * Trade's session orders. */
export interface RoutineReport {
  id: string
  routineId: string
  ranAt: number
  symbolLabel: string
  result: BacktestResult
}

export const SCHEDULE_PRESETS: { label: string; seconds: number }[] = [
  { label: 'Every 5 minutes', seconds: 5 * 60 },
  { label: 'Every 15 minutes', seconds: 15 * 60 },
  { label: 'Every hour', seconds: 60 * 60 },
  { label: 'Every 6 hours', seconds: 6 * 60 * 60 }
]
