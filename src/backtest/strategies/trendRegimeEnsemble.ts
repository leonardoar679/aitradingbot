import type { Candle } from '../../../shared/ipc'
import type { StrategyDefinition, StrategySignals } from './types'
import { computeAtr } from './emaCrossAtrStop'

// Long-only trend regime, spot. Holds while a slow uptrend is agreed on by four different
// lookbacks, sits in cash otherwise.
//
// This strategy was built after measuring why the other three lose money on intraday data, and
// every choice below answers one of those measurements rather than a preference:
//
//   1. FEES DOMINATE, and they set the trade budget. A round trip costs 0.2% (shared/fees.ts),
//      while the average 15m candle moves 0.16% -- the fee is 1.2x a typical bar. Measured over
//      3 years of BTCUSDT 15m: 500 round trips burn 63% of the account, 2,000 burn 98%. That is
//      not a tuning problem, it is arithmetic, and it is the whole explanation for Bollinger
//      Breakout's -98%: it took 2,059 trades and paid $12,550 of fees on $10,000. So the design
//      constraint that comes before any signal is FEW TRADES. This one takes about 20 per symbol
//      per two years.
//
//   2. THERE IS NO MEAN REVERSION TO TRADE at this timeframe. Return autocorrelation on BTCUSDT
//      15m is -0.009 at lag 1 and under 0.006 at every lag out to a day -- indistinguishable from
//      noise, and far too small to clear the fee. That is why RSI Mean-Reversion has no edge here
//      and is not fixable by retuning it (see rsiReversion.ts, which records the same conclusion).
//
//   3. THERE IS TREND PERSISTENCE, but only at one scale. Forward 24h return on BTCUSDT 15m,
//      split by whether price is above or below a moving average:
//
//        lookback     above      below     spread
//          1 day    +0.128%    +0.132%    -0.004%   <- nothing
//         20 days   +0.201%    +0.041%    +0.159%
//         50 days   +0.222%    +0.003%    +0.219%   <- the effect
//        200 days   +0.035%    +0.043%    -0.008%   <- nothing
//
//      The edge lives in the 20-50 day band and vanishes at both ends, which is why a fast
//      EMA(20/50) cross on 15m bars finds only noise, and why the 200-period regime filter that
//      helps emaCrossAtrStop on 4h candles does nothing on 15m ones -- 200 bars of 15m is two
//      days, the row where the spread is -0.004%.
//
// WHY A VOTE RATHER THAN A CHOSEN LOOKBACK. Sweeping single lookbacks produced a non-monotonic
// surface -- 50d scored +171%, 60d +99%, 80d +154% on the same window -- and a parameter picked
// off a surface like that is fitted to the sample, not measured from it. Asking four lookbacks
// and counting votes removes the choice instead of tuning it. Dropping any one of the four moves
// the result by a few points (115-162% against 132% for all four) rather than reorganising it.
//
// WHY THE THRESHOLDS ARE UNANIMITY AND ONE-QUARTER. They are the two natural values, not fitted
// decimals: enter only when every lookback agrees, leave once at most one still does. The gap
// between them is deliberate hysteresis -- entering and leaving on the same line means crossing
// it repeatedly and paying the fee each time. Measured: closing that gap (enter and exit both at
// half the votes) drops the result from +150% to +24% and multiplies the fee bill by five.
//
// WHY THE STOP IS DELIBERATELY TOO WIDE TO USE. The regime exit IS the risk control here, and a
// working stop on top of it makes things worse: at ATR x3 the strategy returns +123% with 40
// trades, at ATR x8-25 it returns +142-153% with 21, and the wide version's drawdown is no worse
// (-26% either way). A tight stop was selling into the noise inside trends it should have held,
// then paying to get back in. What is left is a disaster stop, kept because the engine requires a
// stop price at entry and because a gap large enough to reach it is not noise.
//
// WHAT IT DOES NOT DO. It does not beat buy & hold in a straight bull market -- on 2023-2025
// BTCUSDT it returned +148% against +214% -- and it is not supposed to. It is holding cash for
// part of that window, and the case for it is drawdown and what happens when the trend ends.
// Month by month over three years of BTCUSDT it is up in 14, down in 13 and flat in cash in 10.
// The losing months are the price of the flat ones: the same rule that sat out November 2025
// (-17.5% for buy & hold) is the one that gives back a few percent in a month that chops.
//
// HOW FAR IT HAS ACTUALLY BEEN TESTED, since the numbers above are all from the window the
// parameters were chosen on and are therefore the least trustworthy ones here. On 2017-08 ->
// 2023-08 daily -- entirely before tuning began, and on six symbols never looked at while tuning
// -- it is profitable on 8 of 8 and beats buy & hold on 6 of 8, through the 2018 bear, the March
// 2020 crash, the 2021 bull and the 2022 bear. On that same window BTCUSDT returns +1,468% at 1h,
// +2,247% at 4h and +1,575% at 1d, so it is not sensitive to timeframe either. Year by year on
// BTCUSDT it is profitable in 7 of 10 calendar years and beat buy & hold in every losing one.
//
// WHERE IT FAILS, stated as plainly: XRPUSDT (+5% against +18%) and LINKUSDT (+90% against
// +955%). Both chop rather than trend, and a trend rule on a choppy asset pays the fee again and
// again for nothing. There is no filter here that detects that in advance, and adding one tuned
// on the assets already known to fail would be fitting to the answer sheet.
//
// TWO THINGS THAT LOOK LIKE IMPROVEMENTS AND ARE NOT, both measured:
//
//   Leverage. On BTCUSDT daily over the last 3 years, 5x returns +804% and survives. Over the
//   full 9 years the same 5x is liquidated on its FIRST trade and ends at -100%. CAGR divided by
//   max drawdown is flat near 1.5 from 1x to 3x, so leverage buys no risk-adjusted return at all
//   -- only a bigger number attached to a position nobody holds through a -92% drawdown.
//
//   Diversification. Blending this strategy equal-weight across BTC+ETH+BNB moves max drawdown
//   only from -50.6% to -45.6%, because crypto majors fall on the same days. It is not enough of
//   a reduction to buy back the leverage above.

/** Lookbacks in DAYS, not bars, so the strategy means the same thing on every timeframe.
 *
 * This is the difference between a strategy and a strategy-plus-a-timeframe-assumption. Written
 * as bar counts, "1920 bars" is 20 days of 15m candles but 4 days of 3m ones -- the same numbers
 * would silently land on the 1-day row of the table above, where the measured edge is zero.
 *
 * A FASTER SET WAS TRIED AND REJECTED, and the episode is recorded here because the evidence for
 * it looked strong and was wrong.
 *
 * The complaint was real: this set re-enters late. It spent July 2026 in cash while BTC rose
 * 7.2%, and gives back most of the first leg of a recovery. 10/15/25/40 addresses exactly that,
 * and on the tuning window it looked clearly better -- higher return on the average of three
 * symbols (+223% against +182%), BTC max drawdown improved from -26.5% to -19.2%, and it won 7 of
 * 9 six-month walk-forward sub-windows across BTC/ETH/SOL.
 *
 * On the held-out year it was WORSE: an average of -4.5% against this set's +0.1%, losing on 3 of
 * the 5 series. A change selected on two years of tuning data, and validated by walk-forward
 * inside that same data, failed the only test that had never been consulted.
 *
 * Neither result is big enough to call the two sets genuinely different -- the holdout carries
 * 10-25 trades per series, and a slippage sweep separates them on one symbol out of three. That
 * is the point. When the evidence cannot tell two variants apart, the tiebreak is provenance, and
 * only one of them has parameters that were fixed before anybody looked at the holdout. The
 * faster set's case also drew on a monthly table that included holdout months, so its "problem to
 * fix" was itself partly read off the answer sheet.
 *
 * Do not re-adopt the faster set on the strength of a training-window sweep. That has been done. */
const LOOKBACK_DAYS = [20, 30, 50, 80]

/** Every lookback must agree to open. */
const ENTER_VOTE_FRACTION = 1
/** At most one may still agree, or the position closes. */
const EXIT_VOTE_FRACTION = 0.25

const ATR_PERIOD = 14
/** A disaster stop, not a working one -- see the header. */
const ATR_STOP_MULTIPLIER = 10

const SECONDS_PER_DAY = 86_400

/** Seconds per bar, taken as the median gap rather than the mean or `candles[1] - candles[0]`.
 *
 * Real candle history has gaps -- an exchange outage, a symbol halted, a range stitched together
 * from paginated requests. One 3-day hole would drag a mean far enough to misread 15m data as
 * hourly, and reading the first gap alone bets everything on two rows being adjacent. The median
 * ignores both. Returns 0 for history too short to measure, which callers treat as unusable. */
export function inferBarSeconds(candles: Candle[]): number {
  if (candles.length < 2) return 0
  const gaps: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const gap = candles[i].time - candles[i - 1].time
    if (gap > 0) gaps.push(gap)
  }
  if (gaps.length === 0) return 0
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

/** Rolling simple moving average. O(n) via a running sum; entries before the window fills are
 * NaN, which every comparison below is false against -- so a not-yet-warm lookback abstains from
 * the vote rather than voting either way. */
export function rollingSma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  if (period <= 0) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

function generateSignals(candles: Candle[]): StrategySignals {
  const n = candles.length
  const entries = new Array<boolean>(n).fill(false)
  const exits = new Array<boolean>(n).fill(false)
  const stopPrices = new Array<number | null>(n).fill(null)

  const barSeconds = inferBarSeconds(candles)
  // No usable bar spacing means no usable lookback, and guessing one would put the moving
  // averages on an arbitrary scale. Returning a fully-warm no-signal result leaves the engine
  // holding cash, which is the honest answer to "we cannot read this data".
  if (barSeconds <= 0) return { entries, exits, stopPrices, warmupBars: n }

  const barsPerDay = SECONDS_PER_DAY / barSeconds
  const periods = LOOKBACK_DAYS.map((d) => Math.max(2, Math.round(d * barsPerDay)))
  const warmupBars = Math.max(...periods)

  const closes = candles.map((c) => c.close)
  const averages = periods.map((p) => rollingSma(closes, p))
  const atr = computeAtr(candles, ATR_PERIOD)

  for (let i = warmupBars; i < n; i++) {
    let votes = 0
    for (const ma of averages) if (closes[i] > ma[i]) votes++
    const agreement = votes / periods.length

    if (agreement >= ENTER_VOTE_FRACTION) {
      entries[i] = true
      const stop = closes[i] - atr[i] * ATR_STOP_MULTIPLIER
      // A stop at or below zero is not a stop, and the engine treats null as "no entry" -- which
      // is the right outcome for a bar whose ATR is unreadable, rather than entering with a stop
      // price that can never be hit.
      stopPrices[i] = Number.isFinite(stop) && stop > 0 ? stop : null
    }
    if (agreement <= EXIT_VOTE_FRACTION) exits[i] = true
  }

  return { entries, exits, stopPrices, warmupBars }
}

export const trendRegimeEnsemble: StrategyDefinition = {
  id: 'trend-regime-ensemble',
  name: 'Trend Regime Ensemble',
  description:
    'Holds while 20/30/50/80-day moving averages unanimously agree price is in an uptrend, exits once at most one still does. Few trades by design — intraday fees are what beat the other strategies.',
  generateSignals
}
