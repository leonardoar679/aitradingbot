import { opportunitySide, opportunityWindow, type OpportunitySide } from './aiOpportunity'
import type { AiSignalDecision } from './aiSignal'
import { FEE_RATE, SLIPPAGE_RATE } from './fees'
import type { Candle } from './ipc'
import type { MarketEvent } from './marketEvent'

// What a recommendation would have earned.
//
// A recommendation names an entry range, a stop, a target and two clocks. This walks the
// 1-minute candles after it and says what a person following it to the letter would have got:
// whether the entry was ever there to take, where it filled, which level ended it, and what was
// left after fees and slippage.
//
// NOTHING HERE IS STORED. Like every outcome in this app it is a function of a call and the
// candles after it, worked out when it is looked at.
//
// WHERE THE CANDLES CANNOT SAY, THE ANSWER IS THE WORSE ONE. A 1-minute bar says how far the
// price went, not in what order. So:
//   - a bar that touches both the stop and the target is a stop, the assumption the backtest
//     engine makes too;
//   - a position entered part-way through a bar is stopped by that bar's adverse extreme even if
//     the extreme came first, and is not credited with a target that bar reached;
//   - a bar that opens beyond the stop fills at its open, not at a stop it never traded at, and a
//     bar that opens beyond the target is still only paid the target;
//   - every entry pays slippage, even the ones a resting limit order would have had for nothing.
// An edge that depends on any of those going the other way is not one to trust.
//
// LATENCY IS CHARGED IN WHOLE MINUTES. An answer can only be acted on from the first bar that
// opens after it arrived, so a model that takes twenty seconds enters a bar later than the event
// and a model that takes ninety enters two later. That is the only place speed shows.

const BAR_SECONDS = 60

/** In a replay, how long after an event's minute closes its question could first have been put:
 * the scanner's settle time and a pass. A live answer has its own arrival time on its ledger row
 * and does not need this. */
export const REPLAY_ASK_DELAY_SEC = 10

export interface OpportunityCall {
  /** The event's time: the open of the 1-minute bar the call executes on. */
  time: number
  side: OpportunitySide
  entryMin: number
  entryMax: number
  stopLoss: number
  takeProfit: number
  /** After this the entry is abandoned. */
  expiresAt: number
  /** How long the position is held if neither level is reached. */
  holdSeconds: number
  /** When the answer was in hand. Nothing is entered on a bar that opened before it. */
  answeredAt: number
}

export type OpportunityExit = 'take_profit' | 'stop_loss' | 'time'
/** `waiting`: no entry yet, and either the range is still valid or the candles do not reach
 * its expiry, so nothing can be said. `expired`: the candles run past its expiry and it never
 * filled. `open`: entered, and neither a level nor the clock has ended it yet. `closed`: done. */
export type OpportunityStatus = 'waiting' | 'expired' | 'open' | 'closed'

export interface OpportunityOutcome {
  status: OpportunityStatus
  /** Open time of the bar the entry filled in. */
  entryTime: number | null
  /** The price paid, slippage included. */
  entryPrice: number | null
  exit: OpportunityExit | null
  exitTime: number | null
  exitPrice: number | null
  /** After fees on both fills and slippage on every market fill. Null until closed. */
  netPct: number | null
  /** The same in R: the net over what being stopped out at the call's own stop would have lost, from
   * the price it entered at, with the same fees and slippage. -1 R is that loss, and a stop gapped
   * through loses more. It is what makes calls with near and far stops comparable. Null until
   * closed. */
  r: number | null
  /** How far the price went for the position and against it while it was held, in percent of the
   * entry, before costs. Null until there is an entry. */
  bestPct: number | null
  worstPct: number | null
  heldMinutes: number | null
}

export interface OpportunityCosts {
  feeRate: number
  slippageRate: number
}

export const DEFAULT_OPPORTUNITY_COSTS: OpportunityCosts = { feeRate: FEE_RATE, slippageRate: SLIPPAGE_RATE }

const DEEP_DAILY_VOLUME = 50_000_000
const THIN_DAILY_VOLUME = 5_000_000

/** What a market fill gives up on a pair this liquid, as a fraction. A stated assumption, not a
 * measurement: a historical spread is not in a candle. The app's usual rate on a pair trading
 * fifty million a day or more, two and a half times it down to five million, five times it below
 * that. An unknown volume is charged the middle rate. */
export function slippageRateFor(dailyQuoteVolume: number | null): number {
  if (dailyQuoteVolume === null || !Number.isFinite(dailyQuoteVolume)) return SLIPPAGE_RATE * 2.5
  if (dailyQuoteVolume >= DEEP_DAILY_VOLUME) return SLIPPAGE_RATE
  return dailyQuoteVolume >= THIN_DAILY_VOLUME ? SLIPPAGE_RATE * 2.5 : SLIPPAGE_RATE * 5
}

export type LiquidityTier = 'deep' | 'middle' | 'thin' | 'unknown'

/** How much a pair trades, by the lines its slippage is charged by: fifty million a day and five
 * million a day. For cutting results by, as fixed as the slippage it decides. */
export function liquidityTierOf(dailyQuoteVolume: number | null | undefined): LiquidityTier {
  if (dailyQuoteVolume === null || dailyQuoteVolume === undefined || !Number.isFinite(dailyQuoteVolume)) return 'unknown'
  if (dailyQuoteVolume >= DEEP_DAILY_VOLUME) return 'deep'
  return dailyQuoteVolume >= THIN_DAILY_VOLUME ? 'middle' : 'thin'
}

export function describeLiquidityTier(tier: LiquidityTier): string {
  if (tier === 'deep') return '$50M a day or more'
  if (tier === 'middle') return '$5M to $50M a day'
  return tier === 'thin' ? 'under $5M a day' : 'not known'
}

/** What a market fill gives up on an event's pair: the rate its traded value puts it at -- and,
 * for an event raised live, half the spread the scanner saw on its book at that moment, when that
 * is more. Crossing a spread costs half of it each way, and a measurement outranks an assumption.
 * `dailyQuoteVolume` is for an event found in history, which has no book: what its own candles
 * say the pair traded. */
export function slippageRateForEvent(event: Pick<MarketEvent, 'live'>, dailyQuoteVolume?: number | null): number {
  const assumed = slippageRateFor(dailyQuoteVolume ?? event.live?.quoteVolume24h ?? null)
  const spreadPct = event.live?.spreadPct ?? null
  const measured = spreadPct !== null && Number.isFinite(spreadPct) && spreadPct > 0 ? spreadPct / 100 / 2 : 0
  return Math.max(assumed, measured)
}

/** A pair's traded value a day, from the candles a question was built on: what they hold, scaled
 * to a day. Null without any. */
export function dailyQuoteVolumeOf(bars: Candle[], barSeconds = BAR_SECONDS): number | null {
  if (bars.length === 0) return null
  let total = 0
  for (const bar of bars) total += bar.volume * bar.close
  return (total / (bars.length * barSeconds)) * 86_400
}

/** The call a recommendation makes, or null when it makes none: no trade, refused, not reached. */
export function opportunityCallOf(eventTime: number, decision: AiSignalDecision | null | undefined, answeredAt: number): OpportunityCall | null {
  const side = opportunitySide(decision)
  const detail = decision?.detail
  const validity = opportunityWindow(eventTime, detail)
  if (side === null || !detail?.entry || validity === null || detail.stopLoss === null || detail.takeProfit === null) return null
  return {
    time: eventTime,
    side,
    entryMin: detail.entry.min,
    entryMax: detail.entry.max,
    stopLoss: detail.stopLoss,
    takeProfit: detail.takeProfit,
    expiresAt: validity.expiresAt,
    holdSeconds: validity.holdSeconds,
    answeredAt
  }
}

/** When a replayed answer is taken to have arrived: the event, the delay before its question
 * could be put, and however long this model took to answer it when it was asked. */
export function replayAnsweredAt(eventTime: number, latencyMs: number | null | undefined): number {
  return eventTime + REPLAY_ASK_DELAY_SEC + Math.max(0, latencyMs ?? 0) / 1000
}

const NO_ENTRY = { entryTime: null, entryPrice: null, exit: null, exitTime: null, exitPrice: null, netPct: null, r: null, bestPct: null, worstPct: null, heldMinutes: null }

/** Scores one call. `bars` are 1-minute candles, oldest first; bars before the event and bars
 * still forming at `nowSec` are ignored. */
export function scoreOpportunity(call: OpportunityCall, bars: Candle[], nowSec: number, costs: OpportunityCosts = DEFAULT_OPPORTUNITY_COSTS): OpportunityOutcome {
  const long = call.side === 'long'
  const sign = long ? 1 : -1
  /** A market fill: worse than the level, whichever way the order goes. `buying` is true for a
   * long's entry and a short's exit. */
  const marketFill = (price: number, buying: boolean): number => price * (buying ? 1 + costs.slippageRate : 1 - costs.slippageRate)

  let index = 0
  while (index < bars.length && (bars[index].time < call.time || bars[index].time < call.answeredAt)) index++

  // --- the entry ---------------------------------------------------------------------------
  let entryIndex = -1
  let entryRaw = 0
  let enteredAtOpen = false
  for (; index < bars.length; index++) {
    const bar = bars[index]
    if (bar.time + BAR_SECONDS > nowSec) break
    if (bar.time >= call.expiresAt) break
    if (bar.low > call.entryMax || bar.high < call.entryMin) continue
    entryIndex = index
    enteredAtOpen = bar.open >= call.entryMin && bar.open <= call.entryMax
    entryRaw = enteredAtOpen ? bar.open : bar.open > call.entryMax ? call.entryMax : call.entryMin
    break
  }
  if (entryIndex < 0) {
    // EXPIRED IS A FINDING, AND NEEDS THE CANDLES TO MAKE IT. The clock passing the expiry is not
    // enough: if the candles stop short of it -- a fetch that failed, a market that has no bars
    // there -- the price may have traded in the range in a minute nobody has read. Only candles
    // that run to the expiry can say it never did.
    let lastClose = -Infinity
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].time + BAR_SECONDS <= nowSec) {
        lastClose = bars[i].time + BAR_SECONDS
        break
      }
    }
    return { status: lastClose >= call.expiresAt ? 'expired' : 'waiting', ...NO_ENTRY }
  }

  const entryTime = bars[entryIndex].time
  const entryPrice = marketFill(entryRaw, long)
  const holdEnd = entryTime + call.holdSeconds
  let best = 0
  let worst = 0
  const excursion = (price: number): number => sign * (price / entryPrice - 1) * 100
  /** The net of an exit at `exitPrice`. Fees on both fills, each on its own notional, as
   * shared/fees.ts charges a round trip. */
  const netAt = (exitPrice: number): number => {
    const feePct = costs.feeRate * (1 + exitPrice / entryPrice) * 100
    return sign * (exitPrice / entryPrice - 1) * 100 - feePct
  }
  // What its own stop would have lost from this entry: a market fill at the stop, like any stop-out.
  const atStop = netAt(marketFill(call.stopLoss, !long))
  const closed = (exit: OpportunityExit, exitTime: number, exitPrice: number): OpportunityOutcome => {
    const netPct = netAt(exitPrice)
    return {
      status: 'closed',
      entryTime,
      entryPrice,
      exit,
      exitTime,
      exitPrice,
      netPct,
      r: atStop < 0 ? netPct / -atStop : null,
      bestPct: best,
      worstPct: worst,
      heldMinutes: Math.round((exitTime + BAR_SECONDS - entryTime) / BAR_SECONDS)
    }
  }

  for (let j = entryIndex; j < bars.length; j++) {
    const bar = bars[j]
    if (bar.time + BAR_SECONDS > nowSec) break
    const first = j === entryIndex
    const adverse = long ? bar.low : bar.high
    const favourable = long ? bar.high : bar.low
    const stopped = long ? adverse <= call.stopLoss : adverse >= call.stopLoss
    if (stopped) {
      // A later bar that OPENS beyond the stop fills there, not at a level it never traded at.
      const gapped = !first && (long ? bar.open < call.stopLoss : bar.open > call.stopLoss)
      const level = gapped ? bar.open : call.stopLoss
      worst = Math.min(worst, excursion(level))
      return closed('stop_loss', bar.time, marketFill(level, !long))
    }
    // The bar the entry filled in only counts toward the target if the entry was its open:
    // otherwise the high may have come before the fill.
    const reached = (!first || enteredAtOpen) && (long ? favourable >= call.takeProfit : favourable <= call.takeProfit)
    if (reached) {
      best = Math.max(best, excursion(call.takeProfit))
      worst = Math.min(worst, excursion(adverse))
      return closed('take_profit', bar.time, call.takeProfit)
    }
    if (!first || enteredAtOpen) best = Math.max(best, excursion(favourable))
    worst = Math.min(worst, excursion(adverse))
    if (bar.time + BAR_SECONDS >= holdEnd) return closed('time', bar.time, marketFill(bar.close, !long))
  }

  return { status: 'open', entryTime, entryPrice, exit: null, exitTime: null, exitPrice: null, netPct: null, r: null, bestPct: best, worstPct: worst, heldMinutes: null }
}

export function describeOpportunityExit(exit: OpportunityExit): string {
  if (exit === 'take_profit') return 'target reached'
  if (exit === 'stop_loss') return 'stopped out'
  return 'time ran out'
}
