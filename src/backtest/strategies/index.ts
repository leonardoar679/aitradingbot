import type { StrategyDefinition } from './types'
import { emaCrossAtrStop } from './emaCrossAtrStop'
import { rsiReversion } from './rsiReversion'
import { bollingerBreakout } from './bollingerBreakout'

export type { StrategyDefinition, StrategySignals } from './types'

export const STRATEGIES: StrategyDefinition[] = [emaCrossAtrStop, rsiReversion, bollingerBreakout]

export const DEFAULT_STRATEGY_ID = emaCrossAtrStop.id

/** Falls back to the default strategy for an unknown/missing id, so saved data from before
 * strategies became selectable (or a future removed id) never breaks a bot/routine/backtest. */
export function getStrategy(id: string): StrategyDefinition {
  return STRATEGIES.find((s) => s.id === id) ?? emaCrossAtrStop
}
