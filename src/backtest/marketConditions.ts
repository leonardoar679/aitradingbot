import type { Candle } from '../../shared/ipc'

// A pre-flight reading of the market, for the question "should I run this strategy this month?"
//
// WHAT THIS IS AND IS NOT. It is a READOUT, not a gate. Nothing in the engine or in any strategy
// consults it; it computes a number, states what that number has historically meant, and leaves the
// decision to a person. That is deliberate, and the reason is in research/ADX.md: the rule below
// passed a strict pre-registered out-of-sample test on six symbols and two market eras, and one
// earlier cut of four symbols still contradicts it. A result with a live exception belongs in front
// of an operator, not wired silently into a position size.
//
// THE MEASUREMENT. Wilder's ADX(14) on DAILY bars, read on the last close before a month begins.
// Low ADX means the market has not already made its move. research/season.ts found -- and
// research/ADX.md then confirmed on symbols it had never seen -- that these strategies do markedly
// better in months that open from a quiet base than in months that open mid-trend. Over 453
// symbol-months of held-out data the mean month roughly doubles for Trend Regime.
//
// WHY IT IS NOT A DIRECTION FORECAST, WHICH MATTERS FOR HOW IT IS PHRASED. research/beta.ts shows
// these strategies are 0.80-0.89 correlated with simply holding the coin and lose money in nearly
// every falling month. ADX does not predict whether the market will rise. Consistent with that, the
// WIN RATE under this rule goes slightly DOWN, not up -- the months it selects are not more often
// profitable, their outcomes are simply larger when the market does move. Any wording that implies
// "safer" or "more likely to win" would be a misreading, so the copy below says payoff, never odds.

/** Wilder's own smoothing, alpha = 1/period rather than an EMA's 2/(n+1). Substituting an EMA is a
 * common and silent error: it produces a plausible curve with every value shifted, which would move
 * readings across the 20 boundary this whole readout turns on. */
function wilderAdx(candles: Candle[], period: number): number {
  const need = 2 * period + 1
  if (candles.length < need + 1) return NaN

  let smoothedTr = 0
  let smoothedPlus = 0
  let smoothedMinus = 0
  const dxValues: number[] = []

  for (let i = candles.length - need; i < candles.length; i++) {
    const prev = candles[i - 1]
    const cur = candles[i]
    const upMove = cur.high - prev.high
    const downMove = prev.low - cur.low
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0
    const trueRange = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close))

    smoothedTr = smoothedTr - smoothedTr / period + trueRange
    smoothedPlus = smoothedPlus - smoothedPlus / period + plusDm
    smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm

    if (smoothedTr > 0) {
      const plusDi = (100 * smoothedPlus) / smoothedTr
      const minusDi = (100 * smoothedMinus) / smoothedTr
      const sum = plusDi + minusDi
      if (sum > 0) dxValues.push((100 * Math.abs(plusDi - minusDi)) / sum)
    }
  }

  if (dxValues.length < period) return NaN
  const last = dxValues.slice(-period)
  return last.reduce((a, b) => a + b, 0) / last.length
}

export const ADX_PERIOD = 14
/** Wilder's own boundary for "no trend worth following". Not fitted here -- see research/ADX.md for
 * why only this threshold was tested and 25 deliberately was not. */
export const ADX_QUIET = 20
/** Wilder's upper boundary. Used only to label the middle ground honestly; nothing was measured
 * separately for it, so the readout says so rather than inventing an expectation. */
export const ADX_TRENDING = 25

export type MarketPosture = 'quiet' | 'middling' | 'trending' | 'unknown'

/** Mean return of one independent $10,000 month, measured on the six symbols that took no part in
 * finding this rule (DOGE, TRX, ETC, XLM, VET, EOS) across 2019-2026 -- 453 symbol-months. The
 * out-of-sample figure is used rather than the fuller 14-symbol one, because the fuller one includes
 * the data the rule was discovered on and would flatter it. */
export interface StrategyExpectation {
  strategyId: string
  /** Mean month with no filter at all. */
  baselineMeanPct: number
  /** Mean month among those opening with ADX(14) <= 20. */
  quietMeanPct: number
}

export const MEASURED_EXPECTATIONS: StrategyExpectation[] = [
  { strategyId: 'trend-regime-ensemble', baselineMeanPct: 5.97, quietMeanPct: 10.83 },
  { strategyId: 'short-term-channel', baselineMeanPct: 4.88, quietMeanPct: 5.4 },
  { strategyId: 'short-term-channel-regime', baselineMeanPct: 5.17, quietMeanPct: 7.37 }
]

export interface MarketConditions {
  adx: number
  posture: MarketPosture
  /** One line describing what the reading has meant historically. Never a prediction of direction. */
  summary: string
  expectation: StrategyExpectation | null
}

/** Reads daily candles and reports the posture. Returns 'unknown' rather than guessing when there
 * are too few bars: ADX(14) needs 29 of them, and a number computed from fewer would still print. */
export function readMarketConditions(dailyCandles: Candle[], strategyId: string): MarketConditions {
  const adx = wilderAdx(dailyCandles, ADX_PERIOD)
  const expectation = MEASURED_EXPECTATIONS.find((e) => e.strategyId === strategyId) ?? null

  if (!Number.isFinite(adx)) {
    // Two different causes, and telling them apart matters: too little history is a data
    // problem the user can fix by widening the range, while a market with literally no
    // directional movement leaves ADX mathematically undefined and is a real reading.
    const tooShort = dailyCandles.length < 2 * ADX_PERIOD + 2
    return {
      adx: NaN,
      posture: 'unknown',
      summary: tooShort
        ? 'Not enough daily history to read ADX(14) — it needs ' + (2 * ADX_PERIOD + 2) + ' daily candles.'
        : 'No directional movement at all over the period, which leaves ADX undefined. A market this flat is not one these strategies have anything to act on.',
      expectation
    }
  }

  const posture: MarketPosture = adx <= ADX_QUIET ? 'quiet' : adx > ADX_TRENDING ? 'trending' : 'middling'
  const summary =
    posture === 'quiet'
      ? 'The market is not in an established trend. Historically the setup these strategies pay best from — a breakout from a quiet base runs further than one bought mid-trend.'
      : posture === 'trending'
        ? 'A trend is already well underway. Historically the weaker setup: entries here are late in a move, and the average month is worse.'
        : 'Between Wilder’s two boundaries. Nothing was measured separately for this band, so treat it as no signal either way.'

  return { adx, posture, summary, expectation }
}
