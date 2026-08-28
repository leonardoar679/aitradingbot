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
  /** History this strategy needs before it can trade at all, in bars of `barSeconds`.
   *
   * DECLARED rather than read off generateSignals, because every caller that fetches candles has
   * the problem the other way round: it must size the fetch BEFORE it has any candles to run the
   * strategy over. Callers used a shared constant instead -- 220 bars in the bot dry run, a
   * 90-day window in routines and on the Backtest page -- which was quietly a statement that no
   * strategy would ever need more than a couple of hundred bars.
   *
   * Trend Regime Ensemble needs 80 days, which is 480 bars of 4h and 7,680 of 15m, and adding it
   * broke that assumption in the worst way available: not an error, but a backtest over the
   * default 90-day range spending 80 of those days warming up, reporting "0 trades", and reading
   * exactly like a strategy that does not work.
   *
   * Takes the bar size because the two shapes of strategy scale oppositely. An indicator defined
   * in bars -- EMA(200) -- needs 200 bars whatever they are; one defined in days needs more bars
   * the finer the candles get. A single number could not describe both. */
  warmupBarsFor(barSeconds: number): number
  generateSignals(candles: Candle[]): StrategySignals
}
