import type { AiStrategyReading } from '../../../shared/aiConfirm'
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
   * spread is noise, and 3m pays 42% more in fees for it.
   *
   * At 5m the answer is settled -- three symbols, six comparisons against 15m, and finer wins none:
   * Trend Regime +398.2% vs +398.0% (BTC, a dead heat), +585.9% vs +603.1% (SOL), +251.0% vs
   * +325.6% (ETH), with Short-Term Channel behind at 5m on all three.
   *
   * At 3m NOTHING is settled on either strategy, and two attempts to say otherwise here were both
   * wrong. 3m exists for three symbols only and does not converge. Trend Regime at 3m vs 15m:
   * +417.3% vs +398.0% (BTC), +171.5% vs +325.6% (ETH), +749.9% vs +603.1% (SOL) -- 3m wins two of
   * three, and the losses run 154 points one way and 147 the other. Short-Term Channel splits one
   * of three. A sign that flips per symbol at that size is variance.
   *
   * THE FEE MECHANISM IS REAL BUT DOES NOT DECIDE IT. Going 15m to 3m, Short-Term Channel's trade
   * count moves +6%, +6%, +4% -- it enters on channel breaks, which happen at a rate set by price
   * rather than by how often the rule runs. Trend Regime's moves +29%, +78%, +45%, being a
   * hysteresis strategy that catches more marginal crossings when sampled finer, at 0.24% each.
   * The inference that 3m must therefore hurt Trend Regime is refuted by SOL, where 3m pays 96%
   * more in fees (,991 vs ,594) and still returns 147 points more with better Sharpe AND
   * drawdown. "Finer is worse" holds firmly from 1d to 15m and stops being predictive below 15m.
   *
   * 1m IS THE DECISIVE TEST OF THAT MECHANISM, and it passes. 1m is fifteen times finer than 15m,
   * so if the bar size changes a strategy only through how often the rule is checked, the two
   * shapes must separate here or the story is wrong. Trades per month, 15m to 1m: Trend Regime
   * +140%, +142%, +107% -- a hysteresis rule catching more marginal crossings. Short-Term Channel
   * +9%, +5%, +4% -- a breakout firing at a rate price sets, essentially unmoved by sampling
   * fifteen times more often.
   *
   * The returns follow the fee bill. Over 36 independent $10,000 months (research/monthiv.ts),
   * Trend Regime's total profit is monotonic in favour of COARSER bars on BTC ($10,384 at 1m to
   * $12,822 at 15m) and ETH ($11,776 to $14,344), and monotonic the other way on SOL ($26,422 to
   * $24,512). Short-Term Channel takes MORE profitable months at 1m than 15m on all three -- 19,
   * 18, 21 against 18, 17, 20 -- and more total profit on BTC and ETH.
   *
   * AND 1m IS ACTUALLY SELECTABLE, which is what separates it from everything above about 3m and
   * 5m. Interval in shared/ipc.ts is '1m' | '15m' | '1h' | '4h' | '1d' | '1w'; 3m and 5m are not
   * members, cannot be assigned to preferredInterval, and korbit.ts and kraken.ts declare
   * non-partial Record<Interval, ...> maps with no aggregation path, so supporting them is a
   * change to the type, the INTERVALS list, INTERVAL_SECONDS and every exchange adapter. 1m is
   * native on all eight exchanges and needs none of that. The 3m and 5m findings are academic;
   * this one is not.
   *
   * ASKED ON EIGHT SYMBOLS AND REJECTED, under a rule fixed before the deciding five were visible
   * (research/INTERVAL-1M.md). 1m had to win total profit on 6 of 8 and not worsen the median
   * worst month. It won on 5 -- BTC, ETH, BNB, LTC, XRP -- and lost on SOL, ADA and LINK, with
   * ADA $15,976 -> $13,273 and LINK $6,481 -> $5,092. Median worst month was marginally better at
   * 1m (-17.01% against -17.60%), so risk passed and profit missed by one symbol. A split result
   * leaves the default alone, which was fixed in advance precisely so that '5 of 8 and better
   * risk' could not be accepted after the fact. preferredInterval stays 15m.
   *
   * THE THREE-SYMBOL VERSION DID NOT REPLICATE, which is the third time this file has recorded
   * that outcome for a three-symbol result. The two strategies carrying the 80-day regime are
   * worse still at 1m: the gated channel wins on 4 of 8 with a WORSE median worst month
   * (-16.82% against -14.55%), and Trend Regime wins on only 2 of 8, also with worse median risk.
   * Trend Regime's trades per month roughly double (1.2-2.6 at 15m, 3.6-5.1 at 1m), which is the
   * hysteresis mechanism above confirmed on eight symbols rather than predicted from three.
   *
   * A SECOND CONSTRAINT EXISTED AND HAS SINCE BEEN REMOVED, but it did not decide this. When the
   * question was asked, src/bots/useDryRun.ts re-fetched the whole warm-up window on every
   * 60-second poll -- 12 paged requests per bot per minute at 1m for Short-Term Channel's 8
   * days, and 116 for either 80-day strategy. src/bots/candleCache.ts now fetches only the tail
   * after the first poll, so steady-state cost no longer scales with the look-back.
   *
   * That changes nothing above. 1m was rejected on RETURNS -- 5 of 8 against a bar of 6 -- and
   * would still be rejected if the fetch were free. The constraint is recorded because it was
   * real at the time and because it is the reason a backtest result is not on its own a licence
   * to change a default: the app has to be able to run the thing.
   *
   * CONFIRMED ON EIGHT SYMBOLS (2021-06 to 2026-08, the window all eight cover), because the three-
   * symbol table above is the same sample size that nearly shipped the volatility gate. Short-Term
   * Channel at 15m beats 1h on seven of eight symbols and on worst case (-64.0% against -85.7%);
   * the eight-symbol MEDIAN prefers 1h only because XRP, the single symbol 1h wins, sits where it
   * moves the middle of the sort. Trend Regime is genuinely closer -- 15m and 1h split four-all
   * head to head and four-all on Sharpe, so 1h is an aggregate call (better median on two windows,
   * better median drawdown, lower fees) rather than a sweep, and a per-symbol override is more
   * defensible here than on Short-Term Channel.
   *
   * TREND REGIME HAS SINCE MOVED 1h -> 4h, and the sentence directly above is why it needed to be
   * re-asked: "an aggregate call rather than a sweep" is an honest way of saying the evidence was
   * thin. research/INTERVAL.md re-ran it as 65 independent months over 2021-04 to 2026-08 -- the
   * window 3m data also covers, so every interval scores the IDENTICAL months -- across eight
   * symbols split four/four. 4h wins BOTH halves on mean, mean/sd, total profit, summed losses and
   * fees, losing only the single worst month on the held-out four by 0.8 points. 1d is worse than
   * 4h on both halves, so 4h is an interior peak rather than a monotonic drift toward slower bars.
   *
   * THE OTHER TWO STAY AT 15m, and 3m would beat them if it existed here. 3m wins both halves for
   * Short-Term Channel and for the gated version, and is not a member of Interval: adding it means
   * changing this type, INTERVALS, INTERVAL_SECONDS and every exchange adapter, since korbit.ts and
   * kraken.ts declare non-partial Record<Interval, ...> maps with no aggregation path. The gain is
   * 0.191 -> 0.203 mean/sd on selection and 0.074 -> 0.079 on the held-out four, which is a thin
   * return on that much plumbing. Recorded as measured-and-declined rather than left for someone to
   * re-derive. The fee objection first written here, "18% more fees", was WRONG: it pooled all three
   * strategies, and Trend Regime -- which is moving to 4h, not 3m -- is the one whose fee bill rises
   * fastest on a finer bar. Across only the two strategies that would move, 3m costs 5.2% more.
   * The plumbing is the reason to decline; the fees are not.
   *
   * ONE THING MOVES WITH THIS FIELD. src/backtest/marketConditions.ts states what a market posture
   * has historically meant for each strategy, and those figures are measured at a bar size. Changing
   * preferredInterval without re-measuring leaves the Market Conditions card quoting one interval's
   * result beside another interval's backtest, which nothing on screen would reveal.
   * tests/marketConditions.test.ts pins MEASURED_EXPECTATIONS[].interval to this field so that
   * cannot happen quietly; research/expect.ts is what re-measures it. */
  preferredInterval: Interval
  /** True when signals must be generated asynchronously and supplied to the execution engine. */
  requiresExternalSignals?: boolean
  generateSignals(candles: Candle[]): StrategySignals
  /** What this strategy itself measured on `candles[index]`, a bar it signalled an entry on, for a
   * model asked to review that entry (shared/aiConfirm.ts). Optional: a strategy without it is
   * reviewed on its name and rule alone, beside the market snapshot every review carries.
   *
   * EVERY VALUE MUST BE A FUNCTION OF A FIXED SPAN ENDING AT THE BAR, and rounded. The readings
   * are hashed into the review's cache key, so a value that depends on how much history the caller
   * fetched -- an EMA, a Wilder ATR, anything that carries memory of its own start -- would give
   * the same entry a different key from a backtest than from a bot, and the same review would be
   * paid for once per caller. A simple average over the last N days, or a highest high over them,
   * is the same number whatever came before; those are the readings to offer. */
  entryReadings?(candles: Candle[], index: number): AiStrategyReading[]
}
