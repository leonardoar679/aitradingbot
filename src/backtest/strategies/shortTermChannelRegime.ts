import type { Candle } from '../../../shared/ipc'
import type { StrategyDefinition, StrategySignals } from './types'
import { shortTermChannel } from './shortTermChannel'
import { inferBarSeconds, regimeAgreement, trendRegimeEnsemble } from './trendRegimeEnsemble'

// Short-Term Channel Breakout, but only allowed to open a position while the slow trend agrees.
//
// WHY THIS EXISTS. Over 36 independent $10,000 months (research/monthiv.ts), Short-Term Channel
// loses money in precisely the months Trend Regime declines to trade at all: mean -4.7%, -3.1% and
// -9.3% on BTC/ETH/SOL across those months, against +3.8%, +5.4% and +8.4% in the months Trend
// Regime is active. Trend Regime goes flat in 7 to 11 months of 36, disproportionately when
// holding would have cost 15-22%, and Short-Term Channel walks into those same months blind.
//
// The first idea was the opposite one -- run both strategies so the channel covers the months the
// regime sits out. The numbers above kill it: the two are POSITIVELY correlated, so pairing them
// concentrates the bad months rather than diversifying them.
//
// WHAT IT CHANGES, AND WHAT IT DELIBERATELY DOES NOT. Entries are suppressed unless all four of
// Trend Regime's lookbacks agree. Exits, stops and the channel rules themselves are untouched:
// gating exits as well was measured and was worse on every symbol but one, because an exit blocked
// by a falling regime is an exit blocked exactly when it is needed.
//
// FOUR-OF-FOUR IS NOT A TUNED NUMBER. It is trendRegimeEnsemble's own ENTER_VOTE_FRACTION, read
// through the shared regimeAgreement() rather than reimplemented. Thresholds of 2/4 and 3/4 score
// better on subsets -- 2/4 wins on BTC and SOL -- but the ranking between them is non-monotonic
// across symbols, which is noise, and choosing one would add a free parameter fitted on the same
// data used to justify it. 4/4 adds none.
//
// MEASURED ON EIGHT SYMBOLS UNDER A PRE-REGISTERED RULE (research/enhance.ts): discovery on
// BTC/ETH/SOL/ADA, then confirmation on BNB/LINK/LTC/XRP, which had no part in selecting it. Total
// profit over 36 months improves on 4 of 4 discovery and 3 of 4 confirmation symbols; the worst
// single month improves on 6, ties on 1, and worsens only on ADA. It was the only survivor of
// seventeen variants -- give-back exits and re-entry cooldowns were rejected at discovery.
//
// WHAT IT IS ACTUALLY BUYING, WHICH IS NOT PROFIT (research/shape.ts). The total-profit result
// above is the weaker half of the evidence and should not be read as "this earns more". Net across
// 288 symbol-months the gate is worth $11,436, and the best FIVE months carry 86% of that; by count
// it is 108 helped against 104 hurt with a median effect of exactly $0. What does hold is a rule
// about the distribution: sorting every month by what the ungated strategy did and cutting into
// fifths, the gate's effect falls monotonically from +5.8% in the worst fifth to -3.6% in the best,
// helping 80 against 18 in the bottom two fifths and 11 against 61 in the top two. It TRADES UPSIDE
// FOR DOWNSIDE at a predictable rate. Expect the smaller drawdown to repeat; do not count on the
// extra dollars, which depended on 2023-2026 having a fatter bad tail than good.
//
// THE COST IS WARM-UP, AND IT IS REAL. Short-Term Channel needs 8 days of history; this needs the
// regime's 80. On the Backtest page's default 90-day range that leaves ten tradeable days and
// roughly one trade where the ungated strategy shows twenty -- which is the exact failure mode
// types.ts warns about, a strategy that reads as broken when it is only still warming up. It fits
// inside the default range, but barely, exactly as Trend Regime does.

/** The slower of the two warm-ups, always. The gate reads an 80-day average, and rollingSma is NaN
 * until its window fills; `close > NaN` is false, so every unwarmed lookback votes NO and a
 * 4-of-4 reading is impossible before the slowest one is full. Declaring Short-Term Channel's own
 * 8 days here would not produce a fast start -- it would produce thousands of bars gated off by
 * arithmetic rather than by the market, reported as a flat period the strategy chose. */
function warmupBarsAt(barSeconds: number): number {
  return Math.max(shortTermChannel.warmupBarsFor(barSeconds), trendRegimeEnsemble.warmupBarsFor(barSeconds))
}

function generateSignals(candles: Candle[]): StrategySignals {
  const base = shortTermChannel.generateSignals(candles)
  const barSeconds = inferBarSeconds(candles)
  // Unreadable bar spacing means the lookbacks have no scale, so the gate cannot be evaluated.
  // Refusing every entry while reporting fully warm leaves the engine in cash, which is the honest
  // answer to "we cannot read this data" -- and matches what trendRegimeEnsemble does here.
  if (barSeconds <= 0) {
    return {
      entries: new Array<boolean>(candles.length).fill(false),
      exits: base.exits,
      stopPrices: base.stopPrices,
      warmupBars: candles.length
    }
  }

  const warmupBars = warmupBarsAt(barSeconds)
  const agreement = regimeAgreement(candles, barSeconds)
  return {
    entries: base.entries.map((entry, i) => entry && agreement[i] >= 1),
    // Exits pass through ungated on purpose: see the note above on why gating them is worse.
    exits: base.exits,
    stopPrices: base.stopPrices,
    warmupBars
  }
}

export const shortTermChannelRegime: StrategyDefinition = {
  id: 'short-term-channel-regime',
  name: 'Short-Term Channel + Trend Regime',
  description:
    'Short-term channel breakouts, taken only while all four trend lookbacks agree the market is above trend. Fewer trades, smaller worst month.',
  // 15m, and now measured rather than inherited: research/monthiv.ts ran this at 1m/3m/5m/15m over
  // 36 independent months on BTC/ETH/SOL. No interval wins consistently -- BTC is best at 15m, ETH
  // at 1m, SOL at 3m -- and the spread is small enough that picking per symbol would be fitting
  // noise. What the sweep did show is worth stating: the gate makes the strategy notably LESS
  // interval-sensitive than either parent. BTC total profit spans $10,038-$10,536 across all four
  // bar sizes, a 5% spread, against 14% ungated and 24% for Trend Regime. So 15m is kept for
  // continuity with the strategy it gates, and the choice matters less here than anywhere else.
  preferredInterval: shortTermChannel.preferredInterval,
  warmupBarsFor: warmupBarsAt,
  generateSignals
}
