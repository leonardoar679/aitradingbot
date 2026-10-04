import type { AiCallRecord } from '../../shared/aiLedger'
import {
  DEFAULT_OPPORTUNITY_COSTS,
  opportunityCallOf,
  scoreOpportunity,
  slippageRateForEvent,
  type OpportunityOutcome
} from '../../shared/aiOpportunityOutcome'
import { opportunityWindow } from '../../shared/aiOpportunity'
import { GPT_LOOKBACK_BARS, type AiSignalDecision } from '../../shared/aiSignal'
import type { Candle, Exchange } from '../../shared/ipc'
import { EVENT_BAR_SECONDS, EVENT_LOOKBACK_BARS, type MarketEvent } from '../../shared/marketEvent'

// The renderer side of an opportunity (shared/aiOpportunity.ts): fetching the candles a question
// is built from, joining the scanner's events to the answers the ledger holds for them, and
// working out what each recommendation has done since.
//
// NOTHING HERE ASKS A MODEL. Asking is one call on the bridge, made by the tab when a person
// presses the button and has agreed to its price; this file is everything around it.

const QUARTER_HOUR = 900

/** A fetch of [startSec, endSec] of one interval, as the renderer's market API provides it.
 * Injected so this module can be exercised without an Electron bridge. */
export type CandleFetch = (exchange: Exchange, symbol: string, interval: '1m' | '15m', startSec: number, endSec: number) => Promise<Candle[]>

export interface EventQuestionCandles {
  candles15m: Candle[]
  candles1m: Candle[]
}

/** The candles an event's question is built from: the twelve hours of minutes that end at the
 * minute it was read, and the seven days of quarter hours that had closed by then.
 *
 * AN EXCHANGE'S RANGE CAN INCLUDE THE BAR THAT OPENS EXACTLY AT ITS END, which here would be the
 * bar the call executes on -- the first candle of the future. So both series are cut after they
 * arrive rather than trusted to stop where they were asked to. */
export async function fetchEventQuestion(event: Pick<MarketEvent, 'exchange' | 'symbol' | 'time'>, fetchCandles: CandleFetch): Promise<EventQuestionCandles> {
  const boundary = Math.floor(event.time / QUARTER_HOUR) * QUARTER_HOUR
  const [minutes, quarters] = await Promise.all([
    fetchCandles(event.exchange, event.symbol, '1m', event.time - EVENT_LOOKBACK_BARS * EVENT_BAR_SECONDS, event.time),
    fetchCandles(event.exchange, event.symbol, '15m', boundary - GPT_LOOKBACK_BARS * QUARTER_HOUR, boundary)
  ])
  return {
    candles1m: minutes.filter((candle) => candle.time < event.time),
    candles15m: quarters.filter((candle) => candle.time + QUARTER_HOUR <= event.time)
  }
}

export interface EventAnswer {
  model: string
  decision: AiSignalDecision
  /** When the answer was in hand, in Unix seconds: the moment an entry could first be taken. */
  answeredAt: number
}

export interface EventFeedItem {
  event: MarketEvent
  /** One per model that has answered, in the order they answered. */
  answers: EventAnswer[]
}

/** A ledger row read back as the decision it recorded. A refused answer comes back refused, and
 * is no trade. */
export function decisionOfCall(row: AiCallRecord): AiSignalDecision {
  return {
    candleTime: row.candleTime,
    recommendation: row.recommendation ?? 'hold',
    confidence: row.confidence ?? 0,
    rationale: row.rationale ?? '',
    model: row.model,
    cached: true,
    error: null,
    rejected: row.status === 'rejected' ? (row.error ?? 'The answer was refused.') : null,
    detail: row.detail,
    usage: row.usage
  }
}

/** Each event with the answers held for it.
 *
 * FROM THE LEDGER, NOT FROM THE CACHE. A ledger row carries what a cached answer does not: when
 * it arrived. A recommendation is scored from the first minute after that, so the feed needs the
 * row. A call that never reached a model left a row too, with nothing to show, and is left out:
 * it is asked again next time. */
export function assembleFeed(events: MarketEvent[], calls: AiCallRecord[]): EventFeedItem[] {
  const byEvent = new Map<string, EventAnswer[]>()
  // Oldest first, so the first answer a model gave for an event is the one kept.
  for (const row of [...calls].sort((a, b) => a.at - b.at)) {
    if (row.eventId === undefined || row.status === 'failed') continue
    const answers = byEvent.get(row.eventId) ?? []
    if (answers.some((answer) => answer.model === row.model)) continue
    answers.push({ model: row.model, decision: decisionOfCall(row), answeredAt: row.at })
    byEvent.set(row.eventId, answers)
  }
  return events.map((event) => ({ event, answers: byEvent.get(event.id) ?? [] }))
}

/** How far past an event its recommendations can still be changing: the longest of their entry
 * windows and holds, and a minute to spare. Zero when none of them is a trade. */
export function feedItemHorizonSeconds(item: EventFeedItem): number {
  let longest = 0
  for (const answer of item.answers) {
    const validity = opportunityWindow(item.event.time, answer.decision.detail)
    if (validity === null) continue
    longest = Math.max(longest, validity.expiresAt - item.event.time + validity.holdSeconds + EVENT_BAR_SECONDS)
  }
  return longest
}

/** What one answer's recommendation has done, from the minute candles since the event. Null for
 * an answer that recommends no trade. Fees are the app's; slippage is by how liquid the pair was
 * when the scanner raised it, and by the spread it saw. */
export function scoreAnswer(item: EventFeedItem, answer: EventAnswer, bars: Candle[], nowSec: number): OpportunityOutcome | null {
  const call = opportunityCallOf(item.event.time, answer.decision, answer.answeredAt)
  if (call === null) return null
  return scoreOpportunity(call, bars, nowSec, {
    feeRate: DEFAULT_OPPORTUNITY_COSTS.feeRate,
    slippageRate: slippageRateForEvent(item.event)
  })
}

/** Candles already fetched for an event whose recommendations can no longer change, kept so a
 * tab that refreshes every minute stops asking about a trade once it has closed. */
const settledBars = new Map<string, Candle[]>()

/** The minute candles after each event that has a trade to score, by event id.
 *
 * One request an event, and none for an event with no trade on it. An event whose candles could
 * not be fetched comes back with none, and its trades read as still waiting. */
export async function loadFeedBars(items: EventFeedItem[], nowSec: number, fetchCandles: CandleFetch): Promise<Map<string, Candle[]>> {
  const bars = new Map<string, Candle[]>()
  await Promise.all(
    items.map(async (item) => {
      const horizon = feedItemHorizonSeconds(item)
      if (horizon === 0) return
      const held = settledBars.get(item.event.id)
      if (held) {
        bars.set(item.event.id, held)
        return
      }
      const end = item.event.time + horizon
      try {
        const fetched = await fetchCandles(item.event.exchange, item.event.symbol, '1m', item.event.time, Math.min(nowSec, end))
        bars.set(item.event.id, fetched)
        if (nowSec >= end + EVENT_BAR_SECONDS) settledBars.set(item.event.id, fetched)
      } catch {
        bars.set(item.event.id, [])
      }
    })
  )
  return bars
}

/** Test seam. */
export function clearSettledFeedBars(): void {
  settledBars.clear()
}

export interface AskModelsResult {
  /** One per model that was asked, in the order given: its decision, or why there is none. */
  results: { model: string; decision: AiSignalDecision | null; problem: string | null }[]
  /** What these calls cost. An answer joined from another asker's call in the air cost nothing here. */
  costUsd: number
}

/** Puts one question to several models at once. None waits on another, and none is shown
 * another's answer: each call is its own request, made with the same candles.
 *
 * A model that could not be reached comes back with `problem` and no decision; so does one the
 * main process refused to ask (the budget reached, the key rejected). The others still answer. */
export async function askModels(models: string[], ask: (model: string) => Promise<AiSignalDecision>): Promise<AskModelsResult> {
  const settled = await Promise.allSettled(models.map((model) => ask(model)))
  let costUsd = 0
  const results = settled.map((outcome, index) => {
    const model = models[index]
    if (outcome.status === 'rejected') {
      const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      return { model, decision: null, problem: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
    }
    const decision = outcome.value
    if (decision.error !== null) return { model, decision: null, problem: decision.error }
    if (!decision.cached) costUsd += decision.usage?.costUsd ?? 0
    return { model, decision, problem: null }
  })
  return { results, costUsd }
}
