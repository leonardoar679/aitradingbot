import type { Candle, Interval } from '../../../shared/ipc'

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
  /** The candle size this strategy was measured to work best on.
   *
   * DECLARED PER STRATEGY because the app had three different hardcoded answers to this question
   * and none of them agreed: the Backtest page opened on 15m, a bot's paper dry run polled 4h
   * ("the same 4h interval every backtest strategy is validated on"), and Routines used
   * DEFAULT_INTERVAL. A bot could therefore be created from a backtest run on one bar size and
   * then paper-traded on another, which makes the backtest that justified it not a backtest of
   * the thing that is running.
   *
   * These values are measured, not preferred. research/ivfair.ts compares intervals on a window
   * pinned by TRADEABLE time -- every interval starts trading at the same instant and each
   * carries its own warmup from before it -- because slicing from the same DATE silently gives
   * the coarser interval a longer tradeable window and a different buy & hold anchor.
   *
   * On 2021-06 to 2026-08, BTCUSDT, the same strategy at every bar size:
   *
   *     interval   Trend Regime  sharpe  fees      Short-Term Channel  sharpe  fees
   *       3m          +417.3%     1.13  $3,294          +120.5%          0.65  $5,067
   *       5m          +398.2%     1.11  $3,040          +124.5%          0.66  $5,096
   *       15m         +398.0%     1.12  $2,614          +129.6%          0.68  $4,877
   *       1h          +408.2%     1.14  $2,312          +101.7%          0.60  $4,249
   *       4h          +344.7%     1.06  $1,934           +86.1%          0.55  $3,582
   *       1d          +211.5%     0.82  $1,117           -15.0%          0.05  $1,388
   *
   * WHY FINER IS NOT BETTER, which is the whole answer to "should this run on 3m". Both trend
   * strategies define their lookbacks in DAYS, so shrinking the bar does not change what the
   * strategy means -- a 20-day average is 20 days at every interval. It changes only two things:
   * the rule is checked more often, and it crosses its own hysteresis band more often. The first
   * is worth something small; the second costs 0.24% every time.
   *
   * 3m holds the highest single cell above and is the one to distrust: Trend Regime's whole 3m-to-1h
   * range is +398% to +417% across 43-63 trades on one symbol with Sharpe flat at 1.11-1.14, so the
   * spread is noise, and 3m pays 42% more in fees for it. Short-Term Channel is unambiguous -- 15m
   * beats 3m and 5m on return AND drawdown while paying less. SOLUSDT agrees independently: Trend
   * Regime +585.9% at 5m against +603.1% at 15m, Short-Term Channel +1,677.7% against +2,216.2%. */
  preferredInterval: Interval
  /** True when signals must be generated asynchronously and supplied to the execution engine. */
  requiresExternalSignals?: boolean
  generateSignals(candles: Candle[]): StrategySignals
}
