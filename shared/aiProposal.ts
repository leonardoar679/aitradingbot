import { INTERVAL_SECONDS, type Exchange, type ExecutorSide, type Interval, type PositionExecutorParams, type SymbolInfo } from './ipc'
import { GPT_FLAT, GPT_MIN_CONFIDENCE, gptActionFor, type AiSignalDecision } from './aiSignal'
import { isActionableOpportunity, opportunitySide, opportunityWindow } from './aiOpportunity'
import { describeDecider } from './aiPanel'
import { FEE_RATE, SLIPPAGE_RATE } from './fees'
import { describeEventType, type MarketEvent, type MarketEventType } from './marketEvent'
import type { TradePlan } from './forecast/tradePlan'

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
// Since 13 October 2026 (the V6 document, §107-108; V6 Stage 12) the price forecast's TRADE decision
// fills in the same form, by the same rules, from its trade plan (shared/forecast/tradePlan.ts): TRADE
// THIS. Its model is FORECAST_PROPOSAL_MODEL.
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
  /** Set on a proposal made from a recommendation on an event: the range the model said to enter
   * in. A paper position that still follows the recommendation enters by it. */
  entryRange?: { min: number; max: number }
  /** Set with it: when its entry stops being good, in Unix seconds. A signal's proposal has
   * none; it lasts as long as its candle. */
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

/** What stands between a recommendation on an event and a position made from it.
 *
 * ONE RULE, SAID TWICE. The order form a person opens and the paper trade the watch opens by
 * itself (shared/aiWatchPaper.ts) refuse the same recommendations for the same reasons; each then
 * says so in its own words. */
export type OpportunityObstacle =
  | { code: 'unreached' | 'refused' | 'no_trade' | 'low_confidence' | 'through_stop' | 'at_target' }
  | { code: 'expired'; expiresAt: number }

/** Why a recommendation cannot be traded as it stands, or null when it can.
 *
 * The rule a benchmark's trades follow -- a side, at the confidence this app acts on -- and two
 * that only matter at the moment of trading: its entry is still good, and the price has not
 * already gone through its stop or reached its target. `lastPrice` is the price now, when the
 * caller has one. */
export function opportunityObstacle(eventTime: number, decision: AiSignalDecision, nowSec: number, lastPrice: number | null = null): OpportunityObstacle | null {
  if (decision.error !== null) return { code: 'unreached' }
  if (decision.rejected) return { code: 'refused' }
  const side = opportunitySide(decision)
  const validity = opportunityWindow(eventTime, decision.detail)
  if (side === null || validity === null || !decision.detail) return { code: 'no_trade' }
  if (!isActionableOpportunity(decision)) return { code: 'low_confidence' }
  if (nowSec >= validity.expiresAt) return { code: 'expired', expiresAt: validity.expiresAt }
  const { stopLoss, takeProfit } = decision.detail
  if (lastPrice !== null && stopLoss !== null && takeProfit !== null) {
    const long = side === 'long'
    if (long ? lastPrice <= stopLoss : lastPrice >= stopLoss) return { code: 'through_stop' }
    if (long ? lastPrice >= takeProfit : lastPrice <= takeProfit) return { code: 'at_target' }
  }
  return null
}

/** Why no order form is offered for a recommendation on an event, or null when one is. */
export function opportunityProposalProblem(eventTime: number, decision: AiSignalDecision, nowSec: number, lastPrice: number | null = null): string | null {
  const obstacle = opportunityObstacle(eventTime, decision, nowSec, lastPrice)
  if (obstacle === null) return null
  switch (obstacle.code) {
    case 'unreached':
      return 'The model was not reached, so there is no call to act on.'
    case 'refused':
      return 'The answer was refused, so there is no call to act on.'
    case 'no_trade':
      return 'A call not to trade opens nothing.'
    case 'low_confidence':
      return `This app acts on a call at ${Math.round(GPT_MIN_CONFIDENCE * 100)}% confidence or more, so no order form is offered for this one.`
    case 'expired':
      return `Its entry expired at ${utcClock(obstacle.expiresAt)} UTC, so no order form is offered for it. Ask again for a current one.`
    case 'through_stop':
      return 'The price has already gone through its stop, so no order form is offered for it.'
    case 'at_target':
      return 'The price has already reached its target, so no order form is offered for it.'
  }
}

/** The order form a recommendation on an event opens, or null when none is offered.
 *
 * WHERE IT ENTERS. With the price inside the range the model named, the form's entry is left at
 * market. With the price outside it, the form shows the nearer edge of the range. The stop and
 * target are the model's own prices, turned into distances from that entry, because that is what
 * the form takes.
 *
 * THE FORM'S TWO KINDS OF ENTRY ARE NOT QUITE THE RECOMMENDATION'S, which is "enter when the price
 * trades in this range". A market entry takes the next minute's open wherever the price has gone
 * by then, and an entry price is a limit, which is filled at once when the market is already on
 * its far side: a buy "waiting" at the bottom of a range the price has fallen out of. So the
 * proposal also carries the range itself, and a PAPER position that still follows the
 * recommendation enters by it (PositionExecutorParams.entryRange) -- the rule the recommendation
 * is scored by (shared/aiOpportunityOutcome.ts). A live position cannot, and is the form's own:
 * it is only ever entered at market. */
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

  const above = current > detail.entry.max
  const below = current < detail.entry.min
  const entryPrice = above ? detail.entry.max : below ? detail.entry.min : null
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
    entryRange: { min: detail.entry.min, max: detail.entry.max },
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

/** Binance's smallest order on a USDT pair is worth 5, as the paper trades are held to: a suggestion
 * under it is none. */
const MIN_SUGGESTED_QUOTE = 5

export interface SuggestedLiveAmount {
  amountQuote: number
  /** What the stop would lose, about: the share of the base, to a hundredth, after the conditions'
   * factor. */
  riskQuote: number
  /** What the share was taken of. */
  basis: 'allocation' | 'daily cap'
  /** Held down: to the max order size, or to what is left of the day's cap (since 8 October 2026). */
  capped: boolean
  heldBy: 'max order size' | 'daily cap' | null
  /** The conditions' factor on the risk (shared/dynamicRisk.ts): 1 where none applied. */
  factor: number
}

/** What a real order filled in from a call is suggested to stake (the V4 document, §35-36): the risk
 * setting's share of the managed allocation -- or of the day's cap, without one -- lost at the
 * call's stop after a round trip's fees and slippage, never over the max order size nor over what
 * is left of the day's cap, and reduced by the conditions' factor where one applies (the V5
 * document, §47; shared/dynamicRisk.ts). A suggestion for the form, which a person may change
 * before placing; the model never sizes. Null without a usable stop, a base to take the share of
 * (an allocation of nothing is one), a size worth placing, or at a factor of none. */
export function suggestedLiveAmount(input: {
  riskPct: number
  allocationQuote: number | null
  dailyCapQuote: number
  maxOrderQuote: number
  stopLossPct: number | null
  /** Slippage on each fill, as a rate; the usual rate where absent. */
  slippageRate?: number | null
  /** What real orders have spent of the day's cap already; nothing where absent. */
  dailyUsedQuote?: number | null
  /** The conditions' factor on the risk; the whole where absent. */
  factor?: number | null
}): SuggestedLiveAmount | null {
  const base = input.allocationQuote ?? input.dailyCapQuote
  if (!(base > 0) || !(input.riskPct > 0) || input.stopLossPct === null || !(input.stopLossPct > 0) || !(input.maxOrderQuote > 0)) return null
  const factor = input.factor !== undefined && input.factor !== null && Number.isFinite(input.factor) && input.factor >= 0 && input.factor <= 1 ? input.factor : 1
  if (factor === 0) return null
  const slippage = input.slippageRate !== undefined && input.slippageRate !== null && Number.isFinite(input.slippageRate) && input.slippageRate >= 0 && input.slippageRate < 1 ? input.slippageRate : SLIPPAGE_RATE
  const riskQuote = ((base * input.riskPct) / 100) * factor
  const raw = riskQuote / (input.stopLossPct / 100 + 2 * FEE_RATE + 2 * slippage)
  const used = input.dailyUsedQuote !== undefined && input.dailyUsedQuote !== null && Number.isFinite(input.dailyUsedQuote) && input.dailyUsedQuote > 0 ? input.dailyUsedQuote : 0
  const remaining = Math.max(0, input.dailyCapQuote - used)
  const ceiling = Math.min(input.maxOrderQuote, remaining)
  const amountQuote = Math.floor(Math.min(raw, ceiling) * 100) / 100
  if (amountQuote < MIN_SUGGESTED_QUOTE) return null
  const heldBy = raw > ceiling ? (remaining < input.maxOrderQuote ? 'daily cap' : 'max order size') : null
  return { amountQuote, riskQuote: Math.round(riskQuote * 100) / 100, basis: input.allocationQuote !== null ? 'allocation' : 'daily cap', capped: heldBy !== null, heldBy, factor }
}

/** The suggestion in words, for the form. `reasons` are the conditions' (shared/dynamicRisk.ts)
 * where the factor is under the whole. */
export function describeSuggestedLiveAmount(suggested: SuggestedLiveAmount, input: { riskPct: number; stopLossPct: number; quoteAsset: string; reasons?: readonly string[] }): string {
  const held = suggested.heldBy === 'max order size' ? ' Held to the max order size.' : suggested.heldBy === 'daily cap' ? " Held to what is left of the day's cap." : ''
  const reduced = suggested.factor < 1 ? ` The risk is ${Math.round(suggested.factor * 100)}% of the setting for the conditions${input.reasons !== undefined && input.reasons.length > 0 ? `: ${input.reasons.join('; ')}` : ''}.` : ''
  return `Amount ${plainNumber(suggested.amountQuote)} ${input.quoteAsset}: ${input.riskPct}% of your ${suggested.basis}${suggested.factor < 1 ? ` at ${Math.round(suggested.factor * 100)}%` : ''} (${plainNumber(suggested.riskQuote)} ${input.quoteAsset}) lost at the ${input.stopLossPct}% stop, after fees and slippage.${held}${reduced} Sized by your risk setting on Risk & Safety, not by the model; change it as you like.`
}

/** When a position made from a proposal gives up waiting to enter, in Unix seconds, or null when
 * it never does.
 *
 * A recommendation's entry is good for so many minutes, and a position that filled an hour after
 * them would be trading a call nobody made. So a PAPER position created from a form that still
 * follows the recommendation carries that expiry (PositionExecutorParams.entryExpiresAt). A
 * signal's proposal has none. And never for a live one: nothing in this app cancels a resting
 * real order on a clock, and a field saying otherwise would be a promise it does not keep. */
export function aiProposalEntryExpiry(proposal: AiOrderProposal, mode: 'paper' | 'live'): number | null {
  return mode === 'paper' && proposal.expiresAt !== undefined ? proposal.expiresAt : null
}

/** The range a position made from a proposal enters by, or null when it enters as its form says.
 *
 * A PAPER position, from a form whose entry is still the one the recommendation filled in:
 * `formEntryPrice` is what the form holds when it is submitted. An entry price the user typed is
 * their own order, and waits as a limit like any other. Never for a live one: an exchange has no
 * order that means "when the price trades in this range", so a live order is what the form shows
 * and nothing else. */
export function aiProposalEntryRange(proposal: AiOrderProposal, mode: 'paper' | 'live', formEntryPrice: number | null): { min: number; max: number } | null {
  if (mode !== 'paper' || proposal.entryRange === undefined) return null
  return formEntryPrice === (proposal.entryPrice ?? null) ? proposal.entryRange : null
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
  const range = proposal.entryRange !== undefined ? `, ${plainNumber(proposal.entryRange.min)} to ${plainNumber(proposal.entryRange.max)}` : ''
  const entry =
    proposal.entryPrice === null || proposal.entryPrice === undefined
      ? `It enters at market: the price is inside the range the model named${range}.`
      : `It waits for a price of ${plainNumber(proposal.entryPrice)}, the nearer edge of the range the model named${range}.`
  // What the entry above does on paper, which is not quite what either kind of entry is.
  const paper =
    proposal.entryRange === undefined
      ? null
      : 'On paper, with the entry left as it is, the position enters in the first minute the price trades inside that range, from whichever side: a price that has left it is not chased, and is not bought at once from its far side.'
  const levels =
    proposal.stopLossPct !== null && proposal.takeProfitPct !== null
      ? `The model's stop is ${proposal.stopLossPct}% ${against} that entry and its target ${proposal.takeProfitPct}% ${toward} it.`
      : "One of the model's levels is not a usable distance from that entry, so the form's usual one is shown in its place."
  return [
    `Filled in from an AI recommendation: ${who} said ${short ? 'SELL' : 'BUY'} ${proposal.pair.symbol} at ${Math.round(proposal.confidence * 100)}% confidence, on the ${event} raised at ${utcClock(proposal.candleTime)} UTC.`,
    `${entry} ${levels} The time limit is the ${durationLabel(proposal.timeLimitSec)} it said to hold for.`,
    ...(paper === null ? [] : [paper]),
    `Its entry is good until ${utcClock(proposal.expiresAt ?? proposal.candleTime)} UTC. After that this form will not submit it as it stands, and a paper position still waiting to enter then is abandoned.`,
    short
      ? 'A short is paper only: this app places no short or leveraged order, so Live Trading cannot be ticked for it. The amount is yours to set, and nothing is placed until you submit this form.'
      : 'The amount is yours to set: a model is never asked for one. Nothing is placed until you submit this form, and real money still needs Live Trading ticked below and its phrase typed.'
  ]
}

/** Who a form filled in from the price forecast says it is from (V6 Stage 12). */
export const FORECAST_PROPOSAL_MODEL = 'price-forecast'

const round2 = (value: number): number => Math.round(value * 100) / 100

/** The Position form a TRADE decision's plan fills in (TRADE THIS): its side, the entry zone, the stop
 * and target from the live price, the horizon as the time limit, and the plan's validity, the next
 * five-minute close. Like every proposal, no amount, no mode, no leverage: paper until a person ticks
 * Live Trading and types its phrase, and a sell is paper only. */
export function forecastProposal(input: { plan: TradePlan; confidence: number; barTime: number }): AiOrderProposal {
  const { plan } = input
  return {
    exchange: 'binance',
    pair: { symbol: plan.pair, baseAsset: plan.pair.replace(/USDT$/, ''), quoteAsset: 'USDT' },
    model: FORECAST_PROPOSAL_MODEL,
    candleTime: input.barTime,
    interval: '1m',
    confidence: input.confidence,
    referencePrice: plan.entryPrice,
    stopLossPct: round2(plan.stopPct),
    takeProfitPct: round2(plan.targetPct),
    timeLimitSec: plan.holdSec,
    side: plan.side === 'BUY' ? 'buy' : 'sell',
    entryPrice: null,
    entryRange: { min: plan.entryMin, max: plan.entryMax },
    expiresAt: plan.validUntil
  }
}

/** The same, for a form filled in from the price forecast's plan. */
function describeForecastProposal(proposal: AiOrderProposal): string[] {
  const short = proposal.side === 'sell'
  const [against, toward] = short ? ['above', 'below'] : ['below', 'above']
  const zone = proposal.entryRange === undefined ? '' : ` ${plainNumber(proposal.entryRange.min)} to ${plainNumber(proposal.entryRange.max)}`
  return [
    `Filled in from the price forecast: ${short ? 'SELL' : 'BUY'} ${proposal.pair.symbol}, its forecast read at the ${utcClock(proposal.candleTime)} UTC close, ${Math.round(proposal.confidence * 100)}% the way it calls.`,
    `It enters at market inside the zone${zone}, around the live price of ${plainNumber(proposal.referencePrice)}. Its stop is ${proposal.stopLossPct}% ${against} the entry, at the forecast's bad case or one and a half five-minute ranges, whichever is farther, and its target ${proposal.takeProfitPct}% ${toward} it, at the level the risk mode takes. The time limit is the forecast's horizon, ${durationLabel(proposal.timeLimitSec)}.`,
    'On paper, with the entry left as it is, the position enters in the first minute the price trades inside that zone: a price that has left it is not chased.',
    `Its plan is good until ${utcClock(proposal.expiresAt ?? proposal.candleTime)} UTC, the next five-minute close. After that this form will not submit it as it stands, and a paper position still waiting to enter then is abandoned.`,
    short
      ? 'A short is paper only: this app places no short or leveraged order, so Live Trading cannot be ticked for it. The amount is yours to set, and nothing is placed until you submit this form.'
      : 'The amount is yours to set: the forecast is never asked for one. Nothing is placed until you submit this form, and real money still needs Live Trading ticked below and its phrase typed.'
  ]
}

/** What the form says about where its values came from, above the fields themselves. */
export function describeAiProposal(proposal: AiOrderProposal): string[] {
  if (proposal.model === FORECAST_PROPOSAL_MODEL) return describeForecastProposal(proposal)
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
