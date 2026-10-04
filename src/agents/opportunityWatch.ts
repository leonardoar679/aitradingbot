import type { AiConfig } from '../../shared/aiCost'
import type { AiCallFilter, AiCallPage } from '../../shared/aiLedger'
import {
  describeOpportunitySide,
  isActionableOpportunity,
  opportunitySide,
  type AiOpportunityAskRequest,
  type AiOpportunityPeek,
  type AiOpportunityPeekRequest
} from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import type { AiSignalDecision } from '../../shared/aiSignal'
import { utcMidnight, watchEventIdsToday, watchNotice, watchSkipReason, type AiWatchConfig } from '../../shared/aiWatch'
import { describeEventType, type MarketEvent } from '../../shared/marketEvent'
import { askModels, fetchEventQuestion, type AskModelsResult, type CandleFetch } from './opportunities'

// The watch at work (shared/aiWatch.ts has its rules): given the events the scanner holds, take
// up the ones the watch should ask about, put each to its models, and say so on the desktop when
// one of them calls a trade.
//
// THIS IS THE ONE PLACE A MODEL IS ASKED WITH NOBODY PRESSING ANYTHING. So it decides nothing by
// itself: which events, which models and how many a day are the setting a person switched on, read
// from the main process on every pass, and the main process checks each call against the same
// setting again before it is made (electron/services/aiWatchService.ts).
//
// IT ASKS AND NOTIFIES. It opens no form, creates no executor and touches no account. Everything
// it has to work with is injected, and none of it can do those things.

export interface WatchDeps {
  getConfig: () => Promise<Pick<AiConfig, 'watch'>>
  listCalls: (filter: AiCallFilter) => Promise<AiCallPage>
  fetchCandles: CandleFetch
  ask: (request: AiOpportunityAskRequest) => Promise<AiSignalDecision>
  notify: (title: string, body: string) => void
  nowSec: () => number
}

export interface WatchActivity {
  /** The pairs whose events are being asked about right now. */
  asking: string[]
  /** What came of the last event the watch took up. */
  last: { at: number; symbol: string; text: string; ok: boolean } | null
  /** Goes up each time an event's asking finishes. A reader showing answers reloads on it. */
  answered: number
}

export interface WatchPassResult {
  /** Events this pass took up, strongest first. */
  asked: string[]
  /** Events it looked at and left, each with why. */
  skipped: { id: string; reason: string }[]
}

/** How many of today's rows are read to count the day's events. */
const LEDGER_ROWS_READ = 5000

/** Events this session has finished with: asked about, or left for a reason that will not change. */
const handled = new Set<string>()
/** Events being asked about now. Their rows are not all in the ledger yet. */
const inFlight = new Map<string, string>()
let activity: WatchActivity = { asking: [], last: null, answered: 0 }
const listeners = new Set<(activity: WatchActivity) => void>()

function publish(next: Partial<WatchActivity>): void {
  activity = { ...activity, ...next, asking: [...inFlight.values()] }
  for (const listener of listeners) listener(activity)
}

export function getWatchActivity(): WatchActivity {
  return activity
}

export function subscribeWatchActivity(listener: (activity: WatchActivity) => void): () => void {
  listeners.add(listener)
  return (): void => {
    listeners.delete(listener)
  }
}

/** One line on what the models said, for the Watch card. */
function summarize(event: MarketEvent, results: AskModelsResult['results'], heldBack: number): { text: string; ok: boolean } {
  const parts = results.map((result) => {
    if (result.decision === null) return `${describeDecider(result.model)} did not answer (${result.problem ?? 'no reason given'})`
    if (result.decision.rejected) return `${describeDecider(result.model)}'s answer was refused`
    return `${describeDecider(result.model)} ${describeOpportunitySide(opportunitySide(result.decision))} at ${Math.round(result.decision.confidence * 100)}%`
  })
  const held = heldBack > 0 ? ` Not passed on to the other ${heldBack === 1 ? 'model' : `${heldBack} models`}.` : ''
  return {
    text: `${event.symbol} ${describeEventType(event.type).toLowerCase()}: ${parts.join('; ')}.${held}`,
    ok: results.every((result) => result.decision !== null)
  }
}

/** Puts one event to the watch's models. Never throws: what went wrong is the result. */
async function askAbout(event: MarketEvent, watch: AiWatchConfig, deps: WatchDeps): Promise<{ text: string; ok: boolean; retry: boolean }> {
  let market: Omit<AiOpportunityAskRequest, 'model' | 'source'>
  try {
    market = { exchange: event.exchange, symbol: event.symbol, ...(await fetchEventQuestion(event, deps.fetchCandles)) }
  } catch (failure) {
    // Nothing was asked, so nothing was spent and the event is not used up: the next pass may
    // take it again while it is still fresh.
    const message = failure instanceof Error ? failure.message : String(failure)
    return { text: `${event.symbol}: its candles could not be read (${message}).`, ok: false, retry: true }
  }

  let noticed = false
  const ask = async (model: string): Promise<AiSignalDecision> => {
    const decision = await deps.ask({ ...market, model, source: 'watch' })
    // One notice an event, raised by the first call to trade that arrives.
    const notice = noticed ? null : watchNotice(event, decision)
    if (notice !== null) {
      noticed = true
      try {
        deps.notify(notice.title, notice.body)
      } catch {
        // A desktop that cannot show it is not a reason to lose an answer that was paid for.
      }
    }
    return decision
  }

  const gated = watch.firstModelGates && watch.models.length > 1
  const first = await askModels(gated ? watch.models.slice(0, 1) : watch.models, ask)
  if (!gated) return { ...summarize(event, first.results, 0), retry: false }
  // Most events are no trade. The first model says so alone, and the others are asked only about
  // what it would act on.
  if (!isActionableOpportunity(first.results[0].decision)) {
    return { ...summarize(event, first.results, watch.models.length - 1), retry: false }
  }
  const rest = await askModels(watch.models.slice(1), ask)
  return { ...summarize(event, [...first.results, ...rest.results], 0), retry: false }
}

/** One look at the scanner's events. Resolves when every event it took up has been answered.
 *
 * Safe to call again before it resolves -- a pass a minute is the scanner's pace, and a slow
 * model takes longer than that: an event is taken up by exactly one pass. */
export async function watchPass(events: MarketEvent[], deps: WatchDeps): Promise<WatchPassResult> {
  const result: WatchPassResult = { asked: [], skipped: [] }
  if (!events.some((event) => !handled.has(event.id))) return result

  const { watch } = await deps.getConfig()
  // Off: nothing is marked. An event waiting here when the watch is switched on is taken up only
  // if it is still fresh, like any other.
  if (!watch.enabled) return result

  const nowSec = deps.nowSec()
  const page = await deps.listCalls({ source: 'watch', sinceSec: utcMidnight(nowSec), limit: LEDGER_ROWS_READ })
  const takenToday = watchEventIdsToday(page.rows, nowSec)
  for (const eventId of inFlight.keys()) takenToday.add(eventId)

  // The strongest of a minute first, so that it is the one that gets the day's last place.
  const candidates = events
    .filter((event) => !handled.has(event.id))
    .sort((a, b) => (a.live?.rank ?? Infinity) - (b.live?.rank ?? Infinity) || b.time - a.time || a.id.localeCompare(b.id))

  const asking: Promise<void>[] = []
  for (const event of candidates) {
    // Another pass may have taken it while this one was reading the setting and the ledger.
    if (handled.has(event.id)) continue
    handled.add(event.id)
    const reason = watchSkipReason(event, watch, { nowSec, takenToday })
    if (reason !== null) {
      result.skipped.push({ id: event.id, reason })
      continue
    }
    takenToday.add(event.id)
    inFlight.set(event.id, event.symbol)
    result.asked.push(event.id)
    asking.push(
      askAbout(event, watch, deps)
        // Whatever went wrong, the event stops counting as one being asked about.
        .catch((failure: unknown) => ({ text: `${event.symbol}: ${failure instanceof Error ? failure.message : String(failure)}`, ok: false, retry: false }))
        .then((outcome) => {
          inFlight.delete(event.id)
          if (outcome.retry) handled.delete(event.id)
          publish({ last: { at: deps.nowSec(), symbol: event.symbol, text: outcome.text, ok: outcome.ok }, answered: activity.answered + 1 })
        })
    )
  }
  if (asking.length > 0) publish({})
  await Promise.all(asking)
  return result
}

/** How many of the newest events are tried for a question to price a call on. */
const PRICING_EVENTS_TRIED = 3

/** What one call to each of `models` is expected to cost, for the confirmation that switches the
 * watch on. Priced on a recent event's question: every event's question is the same size, so any
 * one will do, and the newest few are tried because one whose candles can no longer be read says
 * nothing about the price. Null with no event to price from. Free: candles, the cache, the ledger
 * and a price list. */
export async function priceWatchCall(
  events: MarketEvent[],
  models: string[],
  deps: { fetchCandles: CandleFetch; peek: (request: AiOpportunityPeekRequest) => Promise<AiOpportunityPeek> }
): Promise<AiOpportunityPeek | null> {
  const usable = events.filter((event) => event.direction !== 'none').slice(0, PRICING_EVENTS_TRIED)
  let failure: unknown = null
  for (const event of usable) {
    try {
      const question = await fetchEventQuestion(event, deps.fetchCandles)
      return await deps.peek({ exchange: event.exchange, symbol: event.symbol, ...question, models })
    } catch (error) {
      failure = error
    }
  }
  if (failure !== null) throw failure
  return null
}

/** Test seam: forgets what this session has seen. */
export function resetWatch(): void {
  handled.clear()
  inFlight.clear()
  activity = { asking: [], last: null, answered: 0 }
}
