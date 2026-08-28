import type { Candle } from '../../../shared/ipc'
import type { StrategyDefinition, StrategySignals } from './types'
import { inferBarSeconds } from './trendRegimeEnsemble'

// Short-term trend, long-only, spot. Rides multi-day breakouts and sits in cash between them,
// turning over roughly every other week rather than every other month.
//
// This exists because the FIRST short-term study reached the wrong conclusion, and the reason is
// worth keeping. That study measured mean forward return at a FIXED horizon after a condition
// (1h and 4h after dips, volume spikes, volatility quartiles, each hour of the day) and found
// nothing that cleared the 0.240% round trip -- recorded in research/SHORT-TERM.md. The test was
// structurally blind to the thing being looked for. A trend follower does not earn a positive
// mean at a fixed horizon; it earns from an ASYMMETRIC EXIT over a VARIABLE holding period, being
// wrong often and small and right occasionally and large. Every strategy here wins under half the
// time. Measuring fixed-horizon means can only ever find mean reversion, so "nothing works
// short-term" was a statement about the instrument, not about the market.
//
// WHERE THE TIMESCALE FLOOR ACTUALLY IS. Re-measured properly (research/tscan.ts): sweep a trend
// follower's lookback and see where net-after-fees crosses zero. BTCUSDT 15m, two training years,
// moving-average trend with no hysteresis band:
//
//     lookback     net%   trades
//      0.25 day  -99.98%    3858   <- fees alone
//       1 day    -96.96%    1793
//       3 days   -78.54%     972
//       8 days   -32.45%     556
//      20 days   +61.00%     279
//
// With a 1.5% band the same sweep is positive from a QUARTER-DAY lookback (+32.9%, 127 trades),
// because the band cuts the trade count by 5x. So the binding constraint was never the trend
// horizon -- it is the trade count, and hysteresis buys back most of the horizon. That is the
// whole reason this strategy can be short-term at all.
//
// WHY A CHANNEL AND NOT A MOVING AVERAGE. Donchian breakout was the strongest and most consistent
// family in the scan, positive in all 32 symbol x timeframe x lookback cells from 2 to 20 days,
// and steadier across timeframes than the MA band (BTC 3d/1.5d: +62% on 15m, +102% on 1h, +95%
// on 4h). A channel is defined by the price itself, so it needs no smoothing constant.
//
// WHY THE POSITION IN THE CHANNEL AND NOT THE BREAKOUT. Voting across Donchian channels the way
// trendRegimeEnsemble votes across moving averages LOOKS like the obvious way to avoid picking a
// lookback, and is vacuous. The channels are nested -- highest(8d) >= highest(5d) >= highest(3d)
// -- so "close breaks k of the four highs" is exactly "close breaks the k-th slowest high". The
// vote re-picks a single lookback under another name. Where price sits WITHIN each channel is not
// nested, so averaging that across lookbacks is a genuinely different signal from any one of
// them, and it degrades gracefully instead of flipping on one tick through one level.
//
// WHY THESE LOOKBACKS AND THRESHOLDS. They are not fitted. [2,3,5,8] days is trendRegimeEnsemble's
// own [20,30,50,80] shape moved one decade down the timescale, and it lands mid-plateau rather
// than on a peak: across 36 parameter combinations x 8 symbol/timeframe blocks, ALL 288 cells
// were profitable on the training window, so there was no sharp optimum to find. The best
// worst-case cell was [2,4,8] at 0.98/0.15 and was deliberately NOT taken -- 0.98/0.15 is a tight
// corner of the grid, and the argmax of a sweep is the point with the least statistical support.
//
// The two thresholds are asymmetric on purpose, and the asymmetry is the same hysteresis idea as
// the slow strategy: enter only near the top of every channel at once, leave only once well down
// them. Entering and exiting on one line means crossing it repeatedly and paying both ways.
//
// THE FREQUENCY/RETURN TRADE-OFF IS MONOTONE, which is the honest answer to "trade more often".
// Worst-case net across the eight symbol/timeframe blocks, by how often a configuration trades:
//
//      56 trades/yr   +37.5%
//      43 trades/yr   +45.0%
//      33 trades/yr   +57.7%
//      24 trades/yr   +76.0%   <- this configuration
//      15 trades/yr   +80.8%
//
// More trades is strictly worse after costs over this data. This sits where the curve has
// flattened but the strategy still turns over about twice a month, which is what makes it
// short-term without paying for the privilege.
//
// WHY THE STOP IS A DISASTER STOP. Same finding as trendRegimeEnsemble: the channel exit IS the
// risk control, and a working stop on top of it sells into the noise inside trends it should
// hold, then pays to re-enter. It cannot be null -- the engine refuses to open a position without
// a stop price (`signals.stopPrices[i] !== null` in engine.ts), so a stopless trend follower is
// not expressible here, and a null silently produces zero trades rather than an error.
//
// ---------------------------------------------------------------------------------------------
// WHAT IT ACTUALLY DID. Scored once, after the file above was written (research/stfinal.ts).
//
// The strongest evidence is the 2017-2023 window, which is TRUE out-of-sample in the strict
// sense: the 15m files this was tuned on begin in 2023-08, so no parameter here could have seen
// any of it. Six years, against buy & hold on the same window:
//
//                       net%     b&h%   trades   maxDD%   b&h maxDD%
//     BTCUSDT 1h     +1293.9   +251.6      117    -35.6        -83.9
//     BTCUSDT 4h      +944.7   +259.8      107    -40.4        -83.9
//     ETHUSDT 1h     +2447.7   +447.1      125    -50.5        -94.3
//     ETHUSDT 4h     +1930.9   +446.6      116    -46.7        -94.1
//
// Four to five times buy & hold on roughly half its drawdown, and split by regime it is positive
// in three of four eras -- including both bear markets, which is the point of a trend follower:
//
//     BTCUSDT 1h            strategy     b&h
//       2017-08>2019-01       +46.5%   -50.0%   bear
//       2019-01>2020-03      +107.8%  +130.4%   chop
//       2020-03>2021-12      +335.6%  +566.3%   bull
//       2021-12>2023-08       +5.13%   -54.8%   bear
//
// WHERE IT IS WORSE THAN WHAT ALREADY SHIPS, stated plainly, because this is the reason it is an
// additional choice and not a replacement. trendRegimeEnsemble is the better performer and should
// be the default. Run head to head on identical windows across nine symbols of full history, the
// slow strategy wins 7 of 9 at 4h and 5 of 9 at 1d, and usually by a wide margin (+7,287% against
// +1,346% on BTCUSDT 4h). A slow trend follower holds a bull run for months while this one is
// shaken out of it by its own 5-day channel and pays to re-enter.
//
// This one wins on a minority: SOLUSDT and XRPUSDT at both timeframes, plus LTCUSDT and LINKUSDT
// at 1d. Its two systematic advantages are narrower than raw return:
//
//   DEEP BEARS. Year by year on BTCUSDT 4h, 2018 returned -1.0% against the slow strategy's
//   -35.1% and buy & hold's -72.4%; 2022 was a tie (-27% vs -29%). The slow strategy wins each of
//   the other seven years, so this is a real specialisation rather than a general edge.
//
//   WARM-UP. 8 days against 80, so it produces real trades on the Backtest page's default 90-day
//   range and reaches a verdict on a new symbol in a week instead of a quarter.
//
// Running BOTH does not beat picking the better one: two half-capital sleeves land between the
// two on return in all four series tested, though the blend's drawdown on BTCUSDT 4h (-38.4%) is
// lower than either alone.
//
// THE HELD-OUT YEAR WAS NEGATIVE, and that is not hidden here. 2025-08 to 2026-08:
//
//                   strategy      b&h
//     BTCUSDT 15m     -12.1%   -29.3%
//     ETHUSDT 15m     -12.8%   -45.4%
//     SOLUSDT 15m     -19.4%   -47.8%
//
// It lost roughly half of what holding lost, in a year when crypto fell hard, which is a
// long-only trend follower doing its job -- but it is a loss, not a profit, and a year like that
// is a normal outcome for this strategy rather than a malfunction. Month by month over the full
// three years on BTCUSDT 15m it is up in 18, down in 18 and flat in 1 for +69.5% net, with the
// best single month contributing 56% of all gains across the top three. Expect long flat and
// losing stretches punctuated by a few months that make the year.
const LOOKBACK_DAYS = [2, 3, 5, 8]
const ENTER_AT = 0.95
const EXIT_AT = 0.25
/** Half the entry price. Far enough away that only a gap, not noise, can reach it. */
const DISASTER_STOP_FRACTION = 0.5

const DAY_SECONDS = 86_400

function periodsAt(barSeconds: number): number[] {
  const perDay = DAY_SECONDS / barSeconds
  return LOOKBACK_DAYS.map((d) => Math.max(2, Math.round(d * perDay)))
}

/** Lookbacks are in DAYS, not bars, so the strategy means the same thing on every timeframe.
 * A bar-defined lookback silently becomes a different strategy when the candle size changes:
 * 200 bars is two days of 15m and five weeks of 4h.
 *
 * Zero or NaN in gives zero out, never NaN or Infinity: callers multiply this by a bar size to
 * build a fetch start timestamp, and a NaN there produces a range that silently returns no
 * candles -- the exact failure mode that made this strategy family need a declared warmup at
 * all. */
function warmupBarsAt(barSeconds: number): number {
  if (!(barSeconds > 0)) return 0
  return Math.max(...periodsAt(barSeconds)) + 1
}

/** Highest high over the trailing `period` bars, ending at each index. */
export function rollingHighest(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity
    for (let j = i - period + 1; j <= i; j++) if (values[j] > m) m = values[j]
    out[i] = m
  }
  return out
}

/** Lowest low over the trailing `period` bars, ending at each index. */
export function rollingLowest(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity
    for (let j = i - period + 1; j <= i; j++) if (values[j] < m) m = values[j]
    out[i] = m
  }
  return out
}

/** Mean position of `close` within the trailing channels, 0 = at the lows, 1 = at the highs.
 *
 * Reads the channels as of the PREVIOUS bar, so a breakout is measured against a range the bar
 * itself did not help set -- otherwise a new high is trivially at position 1.0 by construction
 * and the signal fires on every up bar. A degenerate flat channel scores 0.5 rather than
 * dividing by zero. */
export function channelPosition(candles: Candle[], periods: number[]): number[] {
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const his = periods.map((p) => rollingHighest(highs, p))
  const los = periods.map((p) => rollingLowest(lows, p))
  const out = new Array<number>(candles.length).fill(NaN)
  for (let i = 1; i < candles.length; i++) {
    let sum = 0
    let counted = 0
    for (let k = 0; k < periods.length; k++) {
      const hi = his[k][i - 1]
      const lo = los[k][i - 1]
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue
      const span = hi - lo
      sum += span > 0 ? Math.min(1, Math.max(0, (candles[i].close - lo) / span)) : 0.5
      counted++
    }
    if (counted === periods.length) out[i] = sum / counted
  }
  return out
}

export const shortTermChannel: StrategyDefinition = {
  id: 'short-term-channel',
  name: 'Short-Term Channel Breakout',
  description:
    'Long-only short-term trend. Buys when price sits near the top of its 2/3/5/8-day ranges at ' +
    'once and sells when it falls back through them. Turns over about twice a month; the wide ' +
    'entry/exit gap is what keeps the fee bill survivable at this speed.',
  warmupBarsFor: (barSeconds) => warmupBarsAt(barSeconds),
  generateSignals(candles: Candle[]): StrategySignals {
    const n = candles.length
    const entries = new Array<boolean>(n).fill(false)
    const exits = new Array<boolean>(n).fill(false)
    const stopPrices = new Array<number | null>(n).fill(null)

    const barSeconds = inferBarSeconds(candles)
    // No usable bar spacing means no usable lookback, and guessing one would put the channels on
    // an arbitrary scale. A fully-warm no-signal result leaves the engine in cash, which is the
    // honest answer to "this data cannot be read".
    if (barSeconds <= 0) return { entries, exits, stopPrices, warmupBars: n }

    const periods = periodsAt(barSeconds)
    const warmupBars = warmupBarsAt(barSeconds)
    const pos = channelPosition(candles, periods)

    for (let i = warmupBars; i < n; i++) {
      const p = pos[i]
      if (!Number.isFinite(p)) continue
      if (p >= ENTER_AT) {
        entries[i] = true
        stopPrices[i] = candles[i].close * DISASTER_STOP_FRACTION
      }
      if (p <= EXIT_AT) exits[i] = true
    }

    return { entries, exits, stopPrices, warmupBars }
  }
}
