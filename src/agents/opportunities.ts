import { MARKET_BARS_15M, MARKET_BARS_1M, MARKET_REFERENCE_SYMBOLS, type EventReference, type ReferenceCandles } from '../../shared/aiEventMarket'
import type { AiCallRecord } from '../../shared/aiLedger'
import {
  DEFAULT_OPPORTUNITY_COSTS,
  opportunityCallOf,
  scoreOpportunity,
  slippageRateForEvent,
  type OpportunityOutcome
} from '../../shared/aiOpportunityOutcome'
import { isActionableOpportunity, opportunitySide, opportunityWindow, type OpportunitySide } from '../../shared/aiOpportunity'
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
  /** Bitcoin's and ether's candles up to the same minute, for the question with the market around
   * the event (opportunity-v2). Absent on the question about the pair alone. */
  reference?: EventReference
}

/** One market's candles up to an event: `minutes` 1-minute bars ending at the minute the event
 * was read, and `quarters` 15-minute bars that had closed by then.
 *
 * AN EXCHANGE'S RANGE CAN INCLUDE THE BAR THAT OPENS EXACTLY AT ITS END, which here would be the
 * bar the call executes on -- the first candle of the future. So both series are cut after they
 * arrive rather than trusted to stop where they were asked to. */
async function candlesUpTo(
  event: Pick<MarketEvent, 'exchange' | 'time'>,
  symbol: string,
  minutes: number,
  quarters: number,
  fetchCandles: CandleFetch
): Promise<ReferenceCandles> {
  const boundary = Math.floor(event.time / QUARTER_HOUR) * QUARTER_HOUR
  const [oneMinute, fifteenMinute] = await Promise.all([
    fetchCandles(event.exchange, symbol, '1m', event.time - minutes * EVENT_BAR_SECONDS, event.time),
    fetchCandles(event.exchange, symbol, '15m', boundary - quarters * QUARTER_HOUR, boundary)
  ])
  return {
    candles1m: oneMinute.filter((candle) => candle.time < event.time),
    candles15m: fifteenMinute.filter((candle) => candle.time + QUARTER_HOUR <= event.time)
  }
}

/** The candles an event's question is built from: the twelve hours of minutes that end at the
 * minute it was read, and the seven days of quarter hours that had closed by then -- and, with
 * `market`, Bitcoin's and ether's four hours of minutes and day of quarter hours up to the same
 * minute, which the question with the market around the event is built from as well. Public
 * candles: four requests more an event, and nothing that costs. */
export async function fetchEventQuestion(
  event: Pick<MarketEvent, 'exchange' | 'symbol' | 'time'>,
  fetchCandles: CandleFetch,
  options: { market?: boolean } = {}
): Promise<EventQuestionCandles> {
  const own = candlesUpTo(event, event.symbol, EVENT_LOOKBACK_BARS, GPT_LOOKBACK_BARS, fetchCandles)
  if (options.market !== true) return own
  const [pair, btc, eth] = await Promise.all([
    own,
    candlesUpTo(event, MARKET_REFERENCE_SYMBOLS.btc, MARKET_BARS_1M, MARKET_BARS_15M, fetchCandles),
    candlesUpTo(event, MARKET_REFERENCE_SYMBOLS.eth, MARKET_BARS_1M, MARKET_BARS_15M, fetchCandles)
  ])
  return { ...pair, reference: { btc, eth } }
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

/** Where an event stands.
 *
 * `waiting`: no model has answered it. `asked`: answered, with no call this app would act on.
 * `valid`: a call to act on whose entry can still be taken. `open`: one has entered and is held.
 * `expired`: every call to act on ran out its entry unfilled. `closed`: its trades are done. */
export type FeedItemStatus = 'waiting' | 'asked' | 'valid' | 'open' | 'expired' | 'closed'

/** An event's status, from its answers and the candles since. Null where the candles that would
 * say have not been read: a guess is not a status.
 *
 * The most alive thing on the card names it: a position held outranks an entry still on offer,
 * which outranks trades that are over, which outrank entries that never filled. */
export function feedItemStatus(item: EventFeedItem, bars: Candle[] | undefined, nowSec: number): FeedItemStatus | null {
  if (item.answers.length === 0) return 'waiting'
  const acted = item.answers.filter((answer) => isActionableOpportunity(answer.decision))
  if (acted.length === 0) return 'asked'
  if (bars === undefined) return null
  const scored = acted.map((answer) => ({
    validity: opportunityWindow(item.event.time, answer.decision.detail),
    outcome: scoreAnswer(item, answer, bars, nowSec)
  }))
  if (scored.some((entry) => entry.outcome?.status === 'open')) return 'open'
  if (scored.some((entry) => entry.outcome?.status === 'waiting' && entry.validity !== null && nowSec < entry.validity.expiresAt)) return 'valid'
  if (scored.some((entry) => entry.outcome?.status === 'closed')) return 'closed'
  if (scored.some((entry) => entry.outcome?.status === 'expired')) return 'expired'
  // Past its expiry with candles that stop short of it: nothing can be said yet.
  return null
}

export function describeFeedItemStatus(status: FeedItemStatus): string {
  const label: Record<FeedItemStatus, string> = {
    waiting: 'Not asked',
    asked: 'No trade',
    valid: 'Entry on offer',
    open: 'In a trade',
    expired: 'Expired',
    closed: 'Closed'
  }
  return label[status]
}

export interface RightNowRow {
  item: EventFeedItem
  /** Every model's call on the event, in the order they answered. */
  calls: { model: string; side: OpportunitySide | null; confidence: number; refused: boolean; acted: boolean }[]
  /** The entry still on offer: that of the surest call to act on whose entry has not run out. */
  model: string
  side: OpportunitySide
  entryMin: number
  entryMax: number
  expiresAt: number
}

/** What can still be acted on right now: each event with a call this app would act on whose entry
 * is still valid and has not filled, the strongest candidate first.
 *
 * An entry that has already filled is not here -- it is a position, on its card -- and neither
 * is one whose candles say it expired. Without candles for an event the clock alone decides. */
export function rightNowRows(feed: EventFeedItem[], bars: ReadonlyMap<string, Candle[]>, nowSec: number): RightNowRow[] {
  const rows: RightNowRow[] = []
  for (const item of feed) {
    const held = bars.get(item.event.id)
    let best: { answer: EventAnswer; expiresAt: number } | null = null
    for (const answer of item.answers) {
      if (!isActionableOpportunity(answer.decision)) continue
      const validity = opportunityWindow(item.event.time, answer.decision.detail)
      if (validity === null || nowSec >= validity.expiresAt) continue
      if (held !== undefined && scoreAnswer(item, answer, held, nowSec)?.status !== 'waiting') continue
      if (best === null || answer.decision.confidence > best.answer.decision.confidence) best = { answer, expiresAt: validity.expiresAt }
    }
    const side = best === null ? null : opportunitySide(best.answer.decision)
    const entry = best?.answer.decision.detail?.entry
    if (best === null || side === null || !entry) continue
    rows.push({
      item,
      calls: item.answers.map((answer) => ({
        model: answer.model,
        side: opportunitySide(answer.decision),
        confidence: answer.decision.confidence,
        refused: Boolean(answer.decision.rejected),
        acted: isActionableOpportunity(answer.decision)
      })),
      model: best.answer.model,
      side,
      entryMin: entry.min,
      entryMax: entry.max,
      expiresAt: best.expiresAt
    })
  }
  const strength = (row: RightNowRow): number => row.item.event.live?.candidateScore ?? row.item.event.score
  return rows.sort((a, b) => strength(b) - strength(a) || b.item.event.time - a.item.event.time || a.item.event.id.localeCompare(b.item.event.id))
}
