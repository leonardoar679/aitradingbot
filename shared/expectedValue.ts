import type { AiCallRecord } from './aiLedger'
import { FEE_RATE, SLIPPAGE_RATE } from './fees'
import type { ExecutorConfig, PositionExecutorParams } from './ipc'
import { MARKET_EVENT_TYPES, describeEventType, type MarketEventType } from './marketEvent'

// THE EXPECTED VALUE OF A CALL (the V4 document, §37-38): what a trade on it is worth before it is
// made, as a number anyone can check. At a win rate p, a target `target`% away and a stop `stop`%
// away, EV = p * target - (1 - p) * stop, less what a round trip costs: the fees on both fills,
// half the spread, and slippage on both fills. In percent of the entry, and in R (over the stop).
//
// WHERE THE WIN RATE COMES FROM, said once:
// - CALIBRATED: the app's own closed paper trades of the watch over the last ninety days, on this
//   model, this kind of event and this side, when there are thirty or more; else the model's over
//   all its events and sides, when there are thirty of those. A rate measured on the app's own
//   record, with fees and slippage already in it.
// - THE MODEL'S CONFIDENCE otherwise: what it said of its own call. Shown as that, and never a
//   reason to refuse: a fresh install opens paper trades as before.
//
// WHAT IT DOES. It is shown on Opportunities and on the trade's timeline. It refuses a paper trade
// of the watch's only at a CALIBRATED rate under the margin a round trip costs: a model that has
// lost enough of its own trades is not given more. Nothing here places, sizes or arms anything.

export const EV_LINES = {
  /** Outcomes are read back this far. */
  days: 90,
  /** A calibrated rate needs this many closed trades. */
  sample: 30,
  /** What a round trip costs, in percent: the fees and the slippage on both fills. A paper trade is
   * refused at a calibrated rate when its expected value is under this. */
  marginPct: Math.round((2 * FEE_RATE + 2 * SLIPPAGE_RATE) * 100 * 1000) / 1000
} as const

/** One closed paper trade of the watch's: who called it, on what kind of event, which side, and
 * whether it made money after fees. */
export interface WatchOutcome {
  model: string
  eventType: string | null
  side: 'buy' | 'sell'
  win: boolean
  closedAt: number
}

/** The app's own closed paper trades of the watch, joined to the ledger for the event's kind: by
 * the row the mark names, else by the event and the model. A trade dropped before it entered is
 * not an outcome. */
export function watchOutcomes(executors: readonly ExecutorConfig[], rows: readonly Pick<AiCallRecord, 'id' | 'eventId' | 'model' | 'eventType'>[]): WatchOutcome[] {
  const out: WatchOutcome[] = []
  for (const executor of executors) {
    const mark = executor.watch
    if (mark === undefined || mark.result === undefined || mark.result.exit === 'btc_moved') continue
    if (executor.mode !== 'paper' || executor.type !== 'position') continue
    const row = (mark.callId === undefined ? undefined : rows.find((entry) => entry.id === mark.callId)) ?? rows.find((entry) => entry.eventId === mark.eventId && entry.model === mark.model)
    out.push({
      model: mark.model,
      eventType: row?.eventType ?? null,
      side: (executor.params as PositionExecutorParams).side,
      win: mark.result.pnlQuote > 0,
      closedAt: mark.result.closedAt
    })
  }
  return out
}

export interface CalibratedRate {
  /** 0 to 1. */
  rate: number
  sample: number
  scope: 'event type' | 'all events'
}

/** The calibrated win rate for a model on a kind of event and a side, or null when the record is too
 * short for one. */
export function calibratedWinRate(outcomes: readonly WatchOutcome[], key: { model: string; eventType: string | null; side: 'buy' | 'sell' }, nowSec: number): CalibratedRate | null {
  const recent = outcomes.filter((outcome) => outcome.model === key.model && outcome.closedAt >= nowSec - EV_LINES.days * 86_400 && outcome.closedAt <= nowSec)
  const rate = (set: readonly WatchOutcome[], scope: CalibratedRate['scope']): CalibratedRate | null =>
    set.length >= EV_LINES.sample ? { rate: set.filter((outcome) => outcome.win).length / set.length, sample: set.length, scope } : null
  return rate(
    recent.filter((outcome) => outcome.eventType === key.eventType && outcome.side === key.side),
    'event type'
  ) ?? rate(recent, 'all events')
}

export interface ExpectedValue {
  /** In percent of the entry, after costs. */
  pct: number
  /** Over the stop; null without one. */
  r: number | null
  /** What a round trip costs here, in percent: fees, half the spread, slippage. */
  costsPct: number
}

/** The expected value at a win rate, for a stop and a target as distances from the entry in
 * percent; null without both. */
export function expectedValue(input: { winRate: number; stopPct: number | null; targetPct: number | null; spreadPct?: number | null; slippageRate?: number | null }): ExpectedValue | null {
  const { stopPct, targetPct } = input
  if (stopPct === null || !(stopPct > 0) || targetPct === null || !(targetPct > 0) || !(input.winRate >= 0 && input.winRate <= 1)) return null
  const spread = input.spreadPct !== null && input.spreadPct !== undefined && Number.isFinite(input.spreadPct) && input.spreadPct > 0 ? input.spreadPct : 0
  const slippage = input.slippageRate !== null && input.slippageRate !== undefined && Number.isFinite(input.slippageRate) && input.slippageRate >= 0 && input.slippageRate < 1 ? input.slippageRate : SLIPPAGE_RATE
  const costsPct = 2 * FEE_RATE * 100 + spread / 2 + 2 * slippage * 100
  const pct = input.winRate * targetPct - (1 - input.winRate) * stopPct - costsPct
  return { pct, r: pct / stopPct, costsPct }
}

/** A trade's expected value with where its win rate came from: what is shown, and what is written
 * on the trade's mark when it is opened. */
export interface TradeEv {
  pct: number
  r: number | null
  basis: 'calibrated' | 'confidence'
  /** 0 to 1. */
  winRate: number
  /** Closed trades the rate was measured on; 0 at the model's confidence. */
  sample: number
  scope: CalibratedRate['scope'] | null
}

export function tradeExpectedValue(input: {
  confidence: number
  calibrated: CalibratedRate | null
  stopPct: number | null
  targetPct: number | null
  spreadPct?: number | null
  slippageRate?: number | null
}): TradeEv | null {
  const winRate = input.calibrated !== null ? input.calibrated.rate : input.confidence
  const ev = expectedValue({ winRate, stopPct: input.stopPct, targetPct: input.targetPct, spreadPct: input.spreadPct, slippageRate: input.slippageRate })
  if (ev === null) return null
  return {
    pct: Math.round(ev.pct * 100) / 100,
    r: ev.r === null ? null : Math.round(ev.r * 100) / 100,
    basis: input.calibrated !== null ? 'calibrated' : 'confidence',
    winRate: Math.round(winRate * 1000) / 1000,
    sample: input.calibrated?.sample ?? 0,
    scope: input.calibrated?.scope ?? null
  }
}

const signed = (value: number, digits: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`

function eventWords(eventType: string | null): string {
  if (eventType !== null && (MARKET_EVENT_TYPES as readonly string[]).includes(eventType)) return `${describeEventType(eventType as MarketEventType).toLowerCase()} events`
  return 'events of this kind'
}

/** "EV +0.40% (+0.27 R) at a 55% calibrated win rate on 41 breakout events". */
export function describeExpectedValue(ev: Pick<TradeEv, 'pct' | 'r' | 'basis' | 'winRate' | 'sample' | 'scope'>, eventType: string | null): string {
  const figures = `EV ${signed(ev.pct, 2)}%${ev.r === null ? '' : ` (${signed(ev.r, 2)} R)`}`
  if (ev.basis === 'confidence') return `${figures} at the model's own ${Math.round(ev.winRate * 100)}% confidence; no calibrated win rate yet.`
  const on = ev.scope === 'all events' ? `${ev.sample} of its trades, all events` : `${ev.sample} ${eventWords(eventType)}`
  return `${figures} at a ${Math.round(ev.winRate * 100)}% calibrated win rate on ${on}.`
}

/** Why a paper trade of the watch's is not opened on its expected value, or null: only at a
 * calibrated rate, and only under the margin a round trip costs. */
export function expectedValueBlock(ev: TradeEv | null): string | null {
  if (ev === null || ev.basis !== 'calibrated' || ev.pct >= EV_LINES.marginPct) return null
  const on = ev.scope === 'all events' ? `${ev.sample} of its trades` : `${ev.sample} trades of this kind`
  return `Its expected value is ${signed(ev.pct, 2)}% at the calibrated win rate (${Math.round(ev.winRate * 100)}% on ${on}), under the ${EV_LINES.marginPct}% a round trip costs.`
}
