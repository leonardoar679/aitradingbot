import {
  GPT_FLAT,
  GPT_MAX_DECISIONS,
  gptActionFor,
  type AiCallSource,
  type AiSignalDecision,
  type AiSignalEstimate
} from './aiSignal'
import { INTERVAL_SECONDS, type Candle, type Exchange, type Interval } from './ipc'

// A second opinion on an entry a strategy has already decided to take.
//
// GPT Intraday asks a model what to do on a schedule -- up to 96 calls a day -- and
// research/gptneed.ts measured that it needs 72-75% of them right to clear the fee (67-72% when it
// is asked less often: research/gptcadence.ts). This is the other way round. The
// strategy decides exactly as it always has -- its rules, its stop, its exits -- and a model is
// asked only at the moment it signals an entry: confirm it, or veto it. Trend Regime signals an
// entry once or twice a month, so that is a few calls a month, starting from a rule whose edge
// was measured before any model was involved.
//
// THE MODEL CAN ONLY REMOVE A TRADE. It cannot open a position the strategy did not signal, close
// one, move a stop or size anything: the only thing read from its answer is whether it said "buy"
// with enough confidence, and anything else leaves the account where it was. A veto takes out the
// whole trade the strategy would have made from that bar, so each trade is asked about once (see
// src/backtest/aiConfirmation.ts for why it is the trade and not the bar). Paper only, like every
// other AI path in this app.

/** The prompt an entry review is asked under. Bumped with any edit to AI_CONFIRM_SYSTEM_PROMPT or
 * to the shape of AiStrategyBlock, for the reason GPT_PROMPT_VERSION is: it is part of the cache
 * key and is written on every ledger row. */
export const AI_CONFIRM_PROMPT_VERSION = 'confirm-v1'

/** A run reviews at most this many entries. The same ceiling a signal tape has, rather than a
 * second number: one run never asks more than this many questions, whichever kind they are. */
export const AI_CONFIRM_MAX_DECISIONS = GPT_MAX_DECISIONS

/** How long after a bar's close it is treated as final.
 *
 * A review reads the bar the strategy signalled on, so asking while that bar is still forming
 * would ask about a close that moves, and ask again -- and pay again -- on every poll until it
 * stopped moving. The margin covers a local clock a few seconds ahead of the exchange's. */
export const AI_CONFIRM_SETTLE_SECONDS = 5

export function isBarSettled(candleTime: number, interval: Interval, nowSec: number): boolean {
  return candleTime + INTERVAL_SECONDS[interval] + AI_CONFIRM_SETTLE_SECONDS <= nowSec
}

/** One thing the strategy itself measured on the bar it signalled on. */
export interface AiStrategyReading {
  label: string
  value: number | string
}

/** What a model reviewing an entry is told about the strategy that signalled it. */
export interface AiStrategyBlock {
  id: string
  name: string
  /** The strategy's rule, in words. */
  rule: string
  /** How far below the entry the strategy's own stop sits, in percent of the entry price. Null
   * when it cannot be read. */
  stopDistancePct: number | null
  readings: AiStrategyReading[]
}

export interface AiEntryConfirmRequest {
  exchange: Exchange
  symbol: string
  interval: Interval
  /** Exactly the completed bars the review is made from, oldest first, ENDING WITH the bar the
   * strategy signalled on. Nothing after that bar is sent, so nothing after it can be read. */
  window: Candle[]
  strategy: AiStrategyBlock
  /** Absent means the configured default. A bot passes the model it was enabled with. */
  model?: string
  source?: AiCallSource
}

/** What asking would cost, and the answer when there is nothing left to pay for. */
export interface AiEntryPeek {
  /** The cached answer, or null when asking would be a new, billed call. */
  decision: AiSignalDecision | null
  model: string
  perCallCostUsd: number | null
  costBasis: AiSignalEstimate['costBasis']
  budgetRemainingUsd: number
}

const STRATEGY_ID = /^[a-z0-9][a-z0-9-]*$/
const MAX_ID_CHARS = 60
const MAX_NAME_CHARS = 80
const MAX_RULE_CHARS = 400
const MAX_READINGS = 12
const MAX_READING_CHARS = 80

/** Checks a strategy block and rebuilds it, field by field.
 *
 * The block is written by the renderer and goes into a prompt the user is billed for, so it is
 * bounded here rather than trusted: an unbounded string is an unbounded bill. It is REBUILT rather
 * than passed through because the block is hashed into the cache key -- a stray extra field, or
 * the same fields in another order, would file the same question under a different key and pay
 * for it twice. A malformed block is refused, never trimmed: a rule cut off mid-sentence is a
 * different question from the one the caller meant to ask. */
export function parseStrategyBlock(value: unknown): AiStrategyBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('An entry review needs the strategy that signalled the entry')
  }
  const record = value as Record<string, unknown>
  const text = (field: string, max: number): string => {
    const raw = record[field]
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > max) {
      throw new Error(`The strategy's ${field} is missing or longer than ${max} characters`)
    }
    return raw
  }

  const id = text('id', MAX_ID_CHARS)
  if (!STRATEGY_ID.test(id)) throw new Error('The strategy id is not a valid id')
  const name = text('name', MAX_NAME_CHARS)
  const rule = text('rule', MAX_RULE_CHARS)

  const stop = record.stopDistancePct
  if (stop !== null && !(typeof stop === 'number' && Number.isFinite(stop) && stop >= 0 && stop <= 100)) {
    throw new Error("The strategy's stop distance is not a percentage")
  }

  if (!Array.isArray(record.readings) || record.readings.length > MAX_READINGS) {
    throw new Error(`The strategy's readings must be a list of at most ${MAX_READINGS}`)
  }
  const readings = record.readings.map((entry: unknown): AiStrategyReading => {
    const reading = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const { label, value: read } = reading
    if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_READING_CHARS) {
      throw new Error("One of the strategy's readings has no usable label")
    }
    const usable =
      (typeof read === 'number' && Number.isFinite(read)) || (typeof read === 'string' && read.length <= MAX_READING_CHARS)
    if (!usable) throw new Error(`The strategy's reading "${label}" is not a number or a short text`)
    return { label, value: read as number | string }
  })

  return { id, name, rule, stopDistancePct: stop, readings }
}

/** Whether an answer lets the entry through.
 *
 * FAILS CLOSED, and by the same rule GPT Intraday enters on rather than a second one: a "buy" at
 * or above the confidence gate, from an answer that was actually given and actually usable. A
 * hold, a sell, a hesitant buy, an answer the validator refused and a call that never reached a
 * model all leave the account flat. */
export function isEntryConfirmed(decision: AiSignalDecision | null | undefined): boolean {
  return gptActionFor(decision ?? undefined, GPT_FLAT) === 'enter'
}
