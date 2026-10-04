import { INTERVAL_SECONDS, type Exchange, type ExecutorSide, type Interval, type PositionExecutorParams, type SymbolInfo } from './ipc'
import { GPT_FLAT, GPT_MIN_CONFIDENCE, gptActionFor, type AiSignalDecision } from './aiSignal'
import { isActionableOpportunity, opportunitySide, opportunityWindow } from './aiOpportunity'
import { describeDecider } from './aiPanel'
import { describeEventType, type MarketEvent, type MarketEventType } from './marketEvent'

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
//   LEVERAGE. A proposal is unlevered, always.
//
// A SIDE OTHER THAN BUY IS PAPER ONLY. A signal's proposal is a spot long, the only thing a signal
// can open. A recommendation on an event (shared/aiOpportunity.ts) may be a short -- the user
// chose, on 2026-10-03, to let a model call one -- and its form opens with the side set to sell.
// That form can be submitted on paper and cannot be switched to Live: the order form refuses Live
// for any Position that is not a buy, because on a spot account a live "sell" would sell coins
// the user holds, which is not what a short call means. tests/aiProposal.test.ts pins it.
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
  /** `sell` on a recommendation to short, which is paper only. Absent means buy. */
  side?: ExecutorSide
  /** The price the entry waits for. Null or absent means enter at market. */
  entryPrice?: number | null
  /** Set on a proposal made from a recommendation on an event: when its entry stops being good,
   * in Unix seconds. A signal's proposal has none; it lasts as long as its candle. */
  expiresAt?: number
  /** Set with it: the kind of event the recommendation was about. */
  eventType?: MarketEventType
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
export function aiProposalProblem(decision: AiSignalDecision, interval: Interval, nowSec: number, opensPosition = true): string | null {
  if (decision.error !== null) return 'The model was not reached, so there is no call to act on.'
  if (decision.rejected) return 'The answer was refused, so there is no call to act on.'
  if (decision.recommendation !== 'buy') return 'Only a call to buy opens a position.'
  if (gptActionFor(decision, GPT_FLAT) !== 'enter') {
    return `This app acts on a buy at ${Math.round(GPT_MIN_CONFIDENCE * 100)}% confidence or more, so no order form is offered for this one.`
  }
  // A bot that was already long was asked whether to keep holding, and a buy from it opens
  // nothing. Analyze always asks with nothing held, so this only ever applies to a bot's call.
  if (!opensPosition) return 'A position was already held when this call was made, so there is nothing for it to open.'
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
  /** False when whoever asked was already holding a position: a running bot that is long. */
  opensPosition?: boolean
}): AiOrderProposal | null {
  const { decision, referencePrice } = input
  if (aiProposalProblem(decision, input.interval, input.nowSec, input.opensPosition ?? true) !== null) return null
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

/** Whether a proposal made from a recommendation can no longer be submitted as it stands. A
 * signal's proposal never expires this way: an old one is warned about, not refused. */
export function isAiProposalExpired(proposal: AiOrderProposal, nowSec: number): boolean {
  return proposal.expiresAt !== undefined && nowSec >= proposal.expiresAt
}

/** Why no order form is offered for a recommendation on an event, or null when one is.
 *
 * The rule a benchmark's trades follow -- a side, at the confidence this app acts on -- and two
 * that only matter to a person: its entry is still good, and the price has not already gone
 * through its stop or reached its target. `lastPrice` is the price now, when the caller has one. */
export function opportunityProposalProblem(eventTime: number, decision: AiSignalDecision, nowSec: number, lastPrice: number | null = null): string | null {
  if (decision.error !== null) return 'The model was not reached, so there is no call to act on.'
  if (decision.rejected) return 'The answer was refused, so there is no call to act on.'
  const side = opportunitySide(decision)
  const validity = opportunityWindow(eventTime, decision.detail)
  if (side === null || validity === null || !decision.detail) return 'A call not to trade opens nothing.'
  if (!isActionableOpportunity(decision)) {
    return `This app acts on a call at ${Math.round(GPT_MIN_CONFIDENCE * 100)}% confidence or more, so no order form is offered for this one.`
  }
  if (nowSec >= validity.expiresAt) return `Its entry expired at ${utcClock(validity.expiresAt)} UTC, so no order form is offered for it. Ask again for a current one.`
  const { stopLoss, takeProfit } = decision.detail
  if (lastPrice !== null && stopLoss !== null && takeProfit !== null) {
    const long = side === 'long'
    if (long ? lastPrice <= stopLoss : lastPrice >= stopLoss) return 'The price has already gone through its stop, so no order form is offered for it.'
    if (long ? lastPrice >= takeProfit : lastPrice <= takeProfit) return 'The price has already reached its target, so no order form is offered for it.'
  }
  return null
}

/** The order form a recommendation on an event opens, or null when none is offered.
 *
 * WHERE IT ENTERS. With the price inside the range the model named, at market. With the price
 * outside it, the form waits for the nearer edge of the range -- the same rule the recommendation
 * is scored by (shared/aiOpportunityOutcome.ts). The stop and target are the model's own prices,
 * turned into distances from that entry, because that is what the form takes. */
export function buildOpportunityProposal(input: {
  event: Pick<MarketEvent, 'exchange' | 'symbol' | 'baseAsset' | 'quoteAsset' | 'time' | 'type' | 'price'>
  decision: AiSignalDecision
  nowSec: number
  /** The price now. Absent means the event's own price, which is the last one the model saw. */
  lastPrice?: number | null
}): AiOrderProposal | null {
  const { event, decision } = input
  const current = input.lastPrice ?? event.price
  if (opportunityProposalProblem(event.time, decision, input.nowSec, current) !== null) return null
  const side = opportunitySide(decision)
  const detail = decision.detail
  const validity = opportunityWindow(event.time, detail)
  if (side === null || !detail?.entry || validity === null || detail.stopLoss === null || detail.takeProfit === null) return null
  if (!Number.isFinite(current) || !(current > 0)) return null

  const inside = current >= detail.entry.min && current <= detail.entry.max
  const entryPrice = inside ? null : current > detail.entry.max ? detail.entry.max : detail.entry.min
  const reference = entryPrice ?? current
  const long = side === 'long'
  return {
    exchange: event.exchange,
    pair: { symbol: event.symbol, baseAsset: event.baseAsset, quoteAsset: event.quoteAsset },
    model: decision.model,
    candleTime: event.time,
    interval: '1m',
    confidence: decision.confidence,
    referencePrice: reference,
    stopLossPct: levelPct(reference, long ? reference - detail.stopLoss : detail.stopLoss - reference),
    takeProfitPct: levelPct(reference, long ? detail.takeProfit - reference : reference - detail.takeProfit),
    timeLimitSec: validity.holdSeconds,
    side: long ? 'buy' : 'sell',
    entryPrice,
    expiresAt: validity.expiresAt,
    eventType: event.type
  }
}

/** The Position form a proposal opens with: the form's own defaults, with the call laid over them.
 *
 * The amount is the form's, untouched. Where the model named no usable stop or target the form's
 * usual one stays, because a real position with no stop is a worse default than a stop the model
 * did not choose -- and describeAiProposal says which is which. */
export function aiProposalPositionParams(proposal: AiOrderProposal, defaults: PositionExecutorParams): PositionExecutorParams {
  return {
    side: proposal.side ?? 'buy',
    entryPrice: proposal.entryPrice ?? null,
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

/** The same, for a form filled in from a recommendation on an event. */
function describeOpportunityProposal(proposal: AiOrderProposal): string[] {
  const who = describeDecider(proposal.model)
  const short = proposal.side === 'sell'
  const [against, toward] = short ? ['above', 'below'] : ['below', 'above']
  const event = proposal.eventType !== undefined ? describeEventType(proposal.eventType).toLowerCase() : 'event'
  const entry =
    proposal.entryPrice === null || proposal.entryPrice === undefined
      ? `It enters at market: the price is inside the range the model named.`
      : `It waits for a price of ${plainNumber(proposal.entryPrice)}, the nearer edge of the range the model named.`
  const levels =
    proposal.stopLossPct !== null && proposal.takeProfitPct !== null
      ? `The model's stop is ${proposal.stopLossPct}% ${against} that entry and its target ${proposal.takeProfitPct}% ${toward} it.`
      : "One of the model's levels is not a usable distance from that entry, so the form's usual one is shown in its place."
  return [
    `Filled in from an AI recommendation: ${who} said ${short ? 'SELL' : 'BUY'} ${proposal.pair.symbol} at ${Math.round(proposal.confidence * 100)}% confidence, on the ${event} raised at ${utcClock(proposal.candleTime)} UTC.`,
    `${entry} ${levels} The time limit is the ${durationLabel(proposal.timeLimitSec)} it said to hold for.`,
    `Its entry is good until ${utcClock(proposal.expiresAt ?? proposal.candleTime)} UTC. After that this form will not submit it as it stands.`,
    short
      ? 'A short is paper only: this app places no short or leveraged order, so Live Trading cannot be ticked for it. The amount is yours to set, and nothing is placed until you submit this form.'
      : 'The amount is yours to set: a model is never asked for one. Nothing is placed until you submit this form, and real money still needs Live Trading ticked below and its phrase typed.'
  ]
}

/** What the form says about where its values came from, above the fields themselves. */
export function describeAiProposal(proposal: AiOrderProposal): string[] {
  if (proposal.expiresAt !== undefined) return describeOpportunityProposal(proposal)
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

/** What the desktop is told when a running bot makes a call an order form is on offer for.
 *
 * The offer lasts as long as the call's candle, fifteen minutes, and a bot makes its call when
 * nobody is looking. So the notice says what was called, until when, and what to do -- and that
 * nothing has been placed, because a notification about a BUY reads otherwise. `key` is the same
 * for every sighting of one call, so it is raised once however many pollers see it. */
export function aiCallNotice(botName: string, proposal: AiOrderProposal): { key: string; title: string; body: string } {
  const until = utcClock(proposal.candleTime + INTERVAL_SECONDS[proposal.interval])
  return {
    key: `${proposal.exchange}:${proposal.pair.symbol}:${proposal.model}:${proposal.candleTime}`,
    title: `${botName}: BUY ${proposal.pair.symbol}`,
    body:
      `${describeDecider(proposal.model)} at ${Math.round(proposal.confidence * 100)}% confidence. Nothing has been placed. ` +
      `An order form is on offer until ${until} UTC: open Bots and press Prepare an order from this call.`
  }
}

/** What an executor's card says about a call its form was filled in from. */
export function describeAiProposalOrigin(origin: AiProposalOrigin): string {
  return `Filled in from a call by ${describeDecider(origin.model)} (${Math.round(origin.confidence * 100)}% confidence, ${utcClock(origin.candleTime)} UTC candle). Placed by you.`
}
