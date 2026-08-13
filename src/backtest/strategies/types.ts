import type { Candle } from '../../../shared/ipc'

export interface StrategySignals {
  /** Same length as candles. true = enter long on this candle. */
  entries: boolean[]
  /** Same length as candles. true = exit signal (non-stop) on this candle. */
  exits: boolean[]
  /** Stop price to set AT the entry candle — only read when entries[i] is true. */
  stopPrices: (number | null)[]
  /** Leading candle count forced flat while this strategy's indicators are still warming up. */
  warmupBars: number
}

export interface StrategyDefinition {
  id: string
  name: string
  description: string
  generateSignals(candles: Candle[]): StrategySignals
}
