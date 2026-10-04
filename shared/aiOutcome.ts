import { AI_ROUND_TRIP_COST_PCT } from './aiContext'
import type { AiCallRecord } from './aiLedger'
import type { Candle } from './ipc'

// Was the call right?
//
// A paid seven-day backtest of GPT Intraday closes eight or nine trades, which cannot separate a
// model with an edge from one flipping a coin (research/gptneed.ts). The same week contains 672
// decisions. Scoring each decision against the candles that followed it -- rather than scoring
// the handful of trades the position machine happened to take -- is what makes a model
// measurable at a price someone would pay.
//
// NOTHING HERE IS STORED. An outcome is a pure function of a call and the candles after it, so it
// is recomputed whenever it is looked at, like every other simulated figure in this app. A stored
// outcome is a second copy of the market that can drift from the first.
//
// THE REFERENCE PRICE IS THE CLOSE OF THE EXECUTION CANDLE, not the price the model was shown.
// That is what runBacktest fills an entry at, so a call is scored from the price the strategy
// would actually have got -- one full bar after the model last saw the market.

/** Bars after the execution candle at which the move is measured: 15m, 1h, 4h and 1d on
 * 15-minute candles. */
export const OUTCOME_HORIZON_BARS = [1, 4, 16, 96] as const

/** The horizon a call is judged at. Sixteen bars is the four hours research/gptneed.ts used when
 * it measured the accuracy this strategy needs, so a hit rate here reads against that bar. */
export const OUTCOME_PRIMARY_BARS = 16

/** Below this many scored calls a hit rate is not printed. Thirty is not a guarantee of anything;
 * it is the point below which the number would be read as information and is mostly noise. */
export const MIN_SCORED_CALLS = 30
const MIN_BUCKET_CALLS = 10

export type AiBarrierOutcome = 'take_profit' | 'stop_loss' | 'neither' | 'pending' | 'no_levels'

export interface AiOutcome {
  /** Null when the execution candle is not in the candles supplied. */
  referencePrice: number | null
  /** One entry per OUTCOME_HORIZON_BARS. `returnPct` is null until that many bars have closed. */
  forward: { bars: number; returnPct: number | null }[]
  /** Best and worst move against the reference price inside the primary horizon, by highs and
   * lows. Null until the whole horizon has closed. */
  bestPct: number | null
  worstPct: number | null
  /** Which of the model's own levels the market touched first, within the horizon the model
   * named. A bar touching both counts as the stop, the same assumption the engine makes. */
  barrier: AiBarrierOutcome
  /** Whether the call was right at the primary horizon: a buy must clear the round-trip cost, a
   * sell must precede a fall. Null for a hold, which makes no claim, and while still pending. */
  correct: boolean | null
}

export interface ScorableCall {
  candleTime: number
  recommendation: 'buy' | 'sell' | 'hold' | null
  stopLoss: number | null
  takeProfit: number | null
  horizonBars: number | null
}

const UNKNOWN: AiOutcome = {
  referencePrice: null,
  forward: OUTCOME_HORIZON_BARS.map((bars) => ({ bars, returnPct: null })),
  bestPct: null,
  worstPct: null,
  barrier: 'no_levels',
  correct: null
}

function pct(price: number, reference: number): number {
  return (price / reference - 1) * 100
}

function barrierOutcome(call: ScorableCall, candles: Candle[], index: number): AiBarrierOutcome {
  if (call.recommendation !== 'buy' || (call.stopLoss === null && call.takeProfit === null)) return 'no_levels'
  const horizon = call.horizonBars ?? OUTCOME_PRIMARY_BARS
  for (let offset = 1; offset <= horizon; offset++) {
    const candle = candles[index + offset]
    if (candle === undefined) return 'pending'
    if (call.stopLoss !== null && candle.low <= call.stopLoss) return 'stop_loss'
    if (call.takeProfit !== null && candle.high >= call.takeProfit) return 'take_profit'
  }
  return 'neither'
}

/** Scores one call. `candles` must be COMPLETED bars only, oldest first -- a still-forming final
 * bar has a close that is not yet a fact, and a return measured to it would change on the next
 * poll. `index` is the position of the call's execution candle, or -1 when it is not present. */
export function scoreCall(call: ScorableCall, candles: Candle[], index: number): AiOutcome {
  const executed = candles[index]
  if (executed === undefined || !(executed.close > 0)) return UNKNOWN
  const reference = executed.close

  const forward = OUTCOME_HORIZON_BARS.map((bars) => {
    const later = candles[index + bars]
    return { bars, returnPct: later === undefined ? null : pct(later.close, reference) }
  })

  let bestPct: number | null = null
  let worstPct: number | null = null
  if (candles[index + OUTCOME_PRIMARY_BARS] !== undefined) {
    let high = -Infinity
    let low = Infinity
    for (let offset = 1; offset <= OUTCOME_PRIMARY_BARS; offset++) {
      const candle = candles[index + offset]
      if (candle.high > high) high = candle.high
      if (candle.low < low) low = candle.low
    }
    bestPct = pct(high, reference)
    worstPct = pct(low, reference)
  }

  const primary = forward.find((entry) => entry.bars === OUTCOME_PRIMARY_BARS)?.returnPct ?? null
  let correct: boolean | null = null
  if (primary !== null) {
    if (call.recommendation === 'buy') correct = primary > AI_ROUND_TRIP_COST_PCT
    else if (call.recommendation === 'sell') correct = primary < 0
  }

  return { referencePrice: reference, forward, bestPct, worstPct, barrier: barrierOutcome(call, candles, index), correct }
}

/** Scores every usable row of a ledger page against one market's candles. Rows from another
 * market, and rows whose execution candle is missing, come back unscored rather than dropped. */
export function scoreCalls(rows: AiCallRecord[], candles: Candle[]): Map<string, AiOutcome> {
  const indexByTime = new Map<number, number>()
  candles.forEach((candle, index) => indexByTime.set(candle.time, index))
  const outcomes = new Map<string, AiOutcome>()
  for (const row of rows) {
    outcomes.set(
      row.id,
      scoreCall(
        {
          candleTime: row.candleTime,
          recommendation: row.status === 'ok' ? row.recommendation : null,
          stopLoss: row.detail?.stopLoss ?? null,
          takeProfit: row.detail?.takeProfit ?? null,
          horizonBars: row.detail?.horizonBars ?? null
        },
        candles,
        indexByTime.get(row.candleTime) ?? -1
      )
    )
  }
  return outcomes
}

export interface AiCalibrationBucket {
  /** Confidence from `from` up to but not including `to`; the last bucket includes 1. */
  from: number
  to: number
  scored: number
  /** Null under ten scored calls in the bucket. */
  hitRatePct: number | null
}

export interface AiModelScore {
  model: string
  /** Usable answers, holds included. */
  decisions: number
  /** Buys and sells: the calls that claimed something. */
  acted: number
  /** How often the model does anything but hold. research/gptneed.ts found this matters as much
   * as accuracy: at a 25% act rate even an 80%-accurate signal loses to the fee. */
  actRatePct: number | null
  /** Acted calls whose primary horizon has closed. */
  scored: number
  hits: number
  /** Null under MIN_SCORED_CALLS. */
  hitRatePct: number | null
  /** Mean primary-horizon move after a buy, before costs. Null under MIN_SCORED_CALLS buys. */
  meanBuyReturnPct: number | null
  calibration: AiCalibrationBucket[]
}

const BUCKET_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1]

function bucketIndex(confidence: number): number {
  for (let i = BUCKET_EDGES.length - 2; i >= 0; i--) {
    if (confidence >= BUCKET_EDGES[i]) return i
  }
  return 0
}

/** What a call has to carry to be tallied: a ledger row does, and so does a benchmark's answer
 * (shared/aiBenchmark.ts), which is scored by this same function so that "right" means one thing. */
export type ScoredCallRow = Pick<AiCallRecord, 'id' | 'model' | 'status' | 'recommendation' | 'confidence'>

/** Per-model accuracy and calibration.
 *
 * CONFIDENCE IS NOT A PROBABILITY OF PROFIT, and the calibration table is what shows whether it is
 * anything at all. A model whose 0.9 calls are right no more often than its 0.6 calls is reporting
 * a number that carries no information, however precise it looks. */
export function summarizeOutcomes(rows: ScoredCallRow[], outcomes: Map<string, AiOutcome>): AiModelScore[] {
  interface Tally {
    decisions: number
    acted: number
    scored: number
    hits: number
    buyReturns: number[]
    buckets: { scored: number; hits: number }[]
  }
  const byModel = new Map<string, Tally>()

  for (const row of rows) {
    if (row.status !== 'ok' || row.recommendation === null || row.confidence === null) continue
    let tally = byModel.get(row.model)
    if (!tally) {
      tally = {
        decisions: 0,
        acted: 0,
        scored: 0,
        hits: 0,
        buyReturns: [],
        buckets: BUCKET_EDGES.slice(0, -1).map(() => ({ scored: 0, hits: 0 }))
      }
      byModel.set(row.model, tally)
    }
    tally.decisions++
    if (row.recommendation === 'hold') continue
    tally.acted++

    const outcome = outcomes.get(row.id)
    if (!outcome || outcome.correct === null) continue
    tally.scored++
    const bucket = tally.buckets[bucketIndex(row.confidence)]
    bucket.scored++
    if (outcome.correct) {
      tally.hits++
      bucket.hits++
    }
    const primary = outcome.forward.find((entry) => entry.bars === OUTCOME_PRIMARY_BARS)?.returnPct
    if (row.recommendation === 'buy' && primary !== null && primary !== undefined) tally.buyReturns.push(primary)
  }

  return [...byModel.entries()]
    .map(([model, tally]) => ({
      model,
      decisions: tally.decisions,
      acted: tally.acted,
      actRatePct: tally.decisions > 0 ? (tally.acted / tally.decisions) * 100 : null,
      scored: tally.scored,
      hits: tally.hits,
      hitRatePct: tally.scored >= MIN_SCORED_CALLS ? (tally.hits / tally.scored) * 100 : null,
      meanBuyReturnPct:
        tally.buyReturns.length >= MIN_SCORED_CALLS
          ? tally.buyReturns.reduce((a, b) => a + b, 0) / tally.buyReturns.length
          : null,
      calibration: tally.buckets.map((bucket, i) => ({
        from: BUCKET_EDGES[i],
        to: BUCKET_EDGES[i + 1],
        scored: bucket.scored,
        hitRatePct: bucket.scored >= MIN_BUCKET_CALLS ? (bucket.hits / bucket.scored) * 100 : null
      }))
    }))
    .sort((a, b) => b.scored - a.scored || a.model.localeCompare(b.model))
}
