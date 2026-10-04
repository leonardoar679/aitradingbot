import { INTERVAL_SECONDS, type Exchange, type Interval, type PositionExecutorParams, type SymbolInfo } from './ipc'
import { GPT_FLAT, GPT_MIN_CONFIDENCE, gptActionFor, type AiSignalDecision } from './aiSignal'
import { describeDecider } from './aiPanel'

// FROM A CALL TO AN ORDER, BY HAND.
//
// A model's answer never places an order (tests/aiNoLivePath.test.ts). What it can do, since the
// user chose this over leaving AI on paper and over a bot that trades by itself, is FILL IN A FORM:
// a call to buy becomes a Position executor form with the market, the model's own stop and target,
// and its horizon as the time limit. A person reads the form, sets the amount, and submits it --
// on paper, or with real money through every gate a hand-made executor passes.
//
// Three things a proposal never carries, each on purpose:
//
//   AN AMOUNT. The model is never asked for one and is told so. What a call is worth risking is
//   the user's decision and the risk limits', not something to arrive pre-typed.
//
//   A MODE. The form opens on paper, as it does for any new executor. Real money stays a box the
//   person ticks and a phrase they type, for this order, every time.
//
//   LEVERAGE, OR A SIDE OTHER THAN BUY. A proposal is a spot long, the only thing a call can open.
//
// Nothing here imports an order path or is imported by one. It is arithmetic on a decision.

/** A stop or target nearer than this, or further than MAX, is not carried into the form: a level
 * a rounding error from the price, or half the price away, is not one to hand a person as a
 * sensible default. The field is left to the form's own. */
const MIN_LEVEL_PCT = 0.05
const MAX_LEVEL_PCT = 50

export interface AiOrderProposal {
  exchange: Exchange
  pair: SymbolInfo
  /** Who made the call: a model, or a panel of agents on one. */
  model: string
  /** The candle the call was made for. Once it has closed the call is no longer current. */
  candleTime: number
  interval: Interval
  confidence: number
  /** The close the model was shown, which its stop and target were set against. */
  referencePrice: number
  /** The model's own levels as distances from that price, in percent. Null when it named none, or
   * named one that is not usable as a default. */
  stopLossPct: number | null
  takeProfitPct: number | null
  /** The horizon the model said its call plays out over. */
  timeLimitSec: number
}

/** What a created executor keeps of the call its form was filled in from. A record of where the
 * idea came from; nothing reads it in order to act. */
export interface AiProposalOrigin {
  model: string
  candleTime: number
  confidence: number
}

export function isAiCallStale(candleTime: number, interval: Interval, nowSec: number): boolean {
  return nowSec >= candleTime + INTERVAL_SECONDS[interval]
}

/** Why no order form is offered for this decision, or null when one is.
 *
 * The same rule the paper strategy enters on -- a buy, answered, accepted, at the confidence this
 * app acts on -- and one more that only matters to a person: the candle the call was made for is
 * still open. A proposal for a market the model would not be acted on in a backtest would make
 * the form more permissive than the record it is judged by. */
export function aiProposalProblem(decision: AiSignalDecision, interval: Interval, nowSec: number): string | null {
  if (decision.error !== null) return 'The model was not reached, so there is no call to act on.'
  if (decision.rejected) return 'The answer was refused, so there is no call to act on.'
  if (decision.recommendation !== 'buy') return 'Only a call to buy opens a position.'
  if (gptActionFor(decision, GPT_FLAT) !== 'enter') {
    return `This app acts on a buy at ${Math.round(GPT_MIN_CONFIDENCE * 100)}% confidence or more, so no order form is offered for this one.`
  }
  if (isAiCallStale(decision.candleTime, interval, nowSec)) {
    return 'The candle this call was made for has closed, so no order form is offered for it. Ask again for the current one.'
  }
  return null
}

function levelPct(referencePrice: number, distance: number): number | null {
  const pct = (distance / referencePrice) * 100
  if (!(pct >= MIN_LEVEL_PCT && pct <= MAX_LEVEL_PCT)) return null
  return Math.round(pct * 100) / 100
}

export function buildAiProposal(input: {
  decision: AiSignalDecision
  exchange: Exchange
  pair: SymbolInfo
  interval: Interval
  /** The close the model was shown. Its levels are prices; the form takes distances. */
  referencePrice: number
  nowSec: number
}): AiOrderProposal | null {
  const { decision, referencePrice } = input
  if (aiProposalProblem(decision, input.interval, input.nowSec) !== null) return null
  const detail = decision.detail ?? null
  // No detail means an answer from before decisions carried a horizon, and no price means the
  // levels cannot be turned into distances. Neither is a call a form can be honestly built from.
  if (detail === null || !Number.isFinite(referencePrice) || !(referencePrice > 0)) return null
  return {
    exchange: input.exchange,
    pair: { symbol: input.pair.symbol, baseAsset: input.pair.baseAsset, quoteAsset: input.pair.quoteAsset },
    model: decision.model,
    candleTime: decision.candleTime,
    interval: input.interval,
    confidence: decision.confidence,
    referencePrice,
    stopLossPct: detail.stopLoss === null ? null : levelPct(referencePrice, referencePrice - detail.stopLoss),
    takeProfitPct: detail.takeProfit === null ? null : levelPct(referencePrice, detail.takeProfit - referencePrice),
    timeLimitSec: detail.horizonBars * INTERVAL_SECONDS[input.interval]
  }
}

/** The Position form a proposal opens with: the form's own defaults, with the call laid over them.
 *
 * The amount is the form's, untouched. Where the model named no usable stop or target the form's
 * usual one stays, because a real position with no stop is a worse default than a stop the model
 * did not choose -- and describeAiProposal says which is which. */
export function aiProposalPositionParams(proposal: AiOrderProposal, defaults: PositionExecutorParams): PositionExecutorParams {
  return {
    side: 'buy',
    entryPrice: null,
    amountQuote: defaults.amountQuote,
    takeProfitPct: proposal.takeProfitPct ?? defaults.takeProfitPct,
    stopLossPct: proposal.stopLossPct ?? defaults.stopLossPct,
    timeLimitSec: proposal.timeLimitSec,
    trailingStop: null
  }
}

export function aiProposalName(proposal: AiOrderProposal): string {
  return `AI call ${proposal.pair.symbol}`
}

export function aiProposalOrigin(proposal: AiOrderProposal): AiProposalOrigin {
  return { model: proposal.model, candleTime: proposal.candleTime, confidence: proposal.confidence }
}

/** `01:15`, in UTC, which is how every candle time in this app is said. */
function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

function plainNumber(value: number): string {
  return Number(value.toPrecision(8)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function durationLabel(sec: number): string {
  if (sec % 86_400 === 0) return sec === 86_400 ? '1 day' : `${sec / 86_400} days`
  if (sec % 3600 === 0) return sec === 3600 ? '1 hour' : `${sec / 3600} hours`
  return `${Math.round(sec / 60)} minutes`
}

/** What the form says about where its values came from, above the fields themselves. */
export function describeAiProposal(proposal: AiOrderProposal): string[] {
  const who = describeDecider(proposal.model)
  const levels =
    proposal.stopLossPct !== null && proposal.takeProfitPct !== null
      ? `Its stop and target were set against a price of ${plainNumber(proposal.referencePrice)}: ${proposal.stopLossPct}% below and ${proposal.takeProfitPct}% above. Here they apply to your own fill.`
      : proposal.stopLossPct !== null
        ? `Its stop was set against a price of ${plainNumber(proposal.referencePrice)}: ${proposal.stopLossPct}% below. It named no usable target, so the form's usual one is shown.`
        : proposal.takeProfitPct !== null
          ? `Its target was set against a price of ${plainNumber(proposal.referencePrice)}: ${proposal.takeProfitPct}% above. It named no usable stop, so the form's usual one is shown.`
          : "It named no usable stop or target, so the form's usual ones are shown."
  return [
    `Filled in from an AI call: ${who} said BUY ${proposal.pair.symbol} at ${Math.round(proposal.confidence * 100)}% confidence, for the ${proposal.interval} candle that opened ${utcClock(proposal.candleTime)} UTC.`,
    `${levels} The time limit is the ${durationLabel(proposal.timeLimitSec)} it said the call plays out over.`,
    'The amount is yours to set: a model is never asked for one. Nothing is placed until you submit this form, and real money still needs Live Trading ticked below and its phrase typed.'
  ]
}

/** What an executor's card says about a call its form was filled in from. */
export function describeAiProposalOrigin(origin: AiProposalOrigin): string {
  return `Filled in from a call by ${describeDecider(origin.model)} (${Math.round(origin.confidence * 100)}% confidence, ${utcClock(origin.candleTime)} UTC candle). Placed by you.`
}
