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
import { utcMidnight, watchEventIdsToday, watchNotice, watchPausedModels, watchSkipReason, type AiWatchConfig } from '../../shared/aiWatch'
import { describeEventType, type MarketEvent } from '../../shared/marketEvent'
import { askModels, fetchEventQuestion, type AskModelsResult, type CandleFetch } from './opportunities'
import { recordPaperRefusal } from './paperRefusals'

// The watch at work (shared/aiWatch.ts has its rules): given the events the scanner holds, take
// up the ones the watch should ask about, put each to its models, and say so on the desktop when
// one of them calls a trade.
//
// THIS IS THE ONE PLACE A MODEL IS ASKED WITH NOBODY PRESSING ANYTHING. So it decides nothing by
// itself: which events, which models and how many a day are the setting a person switched on, read
// from the main process on every pass, and the main process checks each call against the same
// setting again before it is made (electron/services/aiWatchService.ts).
//
// IT ASKS AND NOTIFIES. It opens no form and touches no account. Everything it has to work with
// is injected. One of those things, when the user has switched it on, opens a PAPER position on a
// call the watch would act on (`paperTrade`; ./watchPaperTrade.ts is the file that writes it). This
// file hands it the event and the answer and is told what came of it; it cannot make an executor
// itself, and nothing it is given can make a real one.

export interface WatchDeps {
  getConfig: () => Promise<Pick<AiConfig, 'watch'>>
  listCalls: (filter: AiCallFilter) => Promise<AiCallPage>
  fetchCandles: CandleFetch
  ask: (request: AiOpportunityAskRequest) => Promise<AiSignalDecision>
  notify: (title: string, body: string) => void
  nowSec: () => number
  /** Opens a paper trade on an answer, when that is switched on. Resolves to what came of it, or
   * to null when there is nothing to say. Absent, the watch only asks and notifies. */
  paperTrade?: (event: MarketEvent, decision: AiSignalDecision) => Promise<{ opened: boolean; text: string } | null>
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
  /** Events it took up and could not ask about, because their candles could not be read: nothing
   * was asked or spent, and each may be taken up again while it is fresh. */
  retry: string[]
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

/** Puts one event to the watch's models. Never throws: what went wrong is the result. `resting`
 * is the models left out because they keep failing today. */
async function askAbout(event: MarketEvent, watch: AiWatchConfig, deps: WatchDeps, resting: string[] = []): Promise<{ text: string; ok: boolean; retry: boolean }> {
  let market: Omit<AiOpportunityAskRequest, 'model' | 'source'>
  try {
    market = { exchange: event.exchange, symbol: event.symbol, ...(await fetchEventQuestion(event, deps.fetchCandles)) }
    // An event an announcement raised is asked about with the announcement in it. The id is all
    // that is sent: the main process looks the article up in what it read itself.
    if (event.news !== undefined) market = { ...market, newsId: event.news.articleId }
  } catch (failure) {
    // Nothing was asked, so nothing was spent and the event is not used up: the next pass may
    // take it again while it is still fresh.
    const message = failure instanceof Error ? failure.message : String(failure)
    return { text: `${event.symbol}: its candles could not be read (${message}).`, ok: false, retry: true }
  }

  let noticed = false
  const paper: string[] = []
  const ask = async (model: string): Promise<AiSignalDecision> => {
    const decision = await deps.ask({ ...market, model, source: 'watch' })
    // A call the watch would act on may open a paper trade, when that is switched on. Whatever
    // comes of it, the answer was paid for and is returned.
    let opened = false
    if (deps.paperTrade !== undefined && isActionableOpportunity(decision)) {
      try {
        const outcome = await deps.paperTrade(event, decision)
        if (outcome !== null) {
          paper.push(outcome.text)
          opened = outcome.opened
          // For the session report: what was refused, and why.
          if (!outcome.opened) recordPaperRefusal({ at: Math.floor(Date.now() / 1000), source: 'watch', symbol: event.symbol, text: outcome.text })
        }
      } catch (failure) {
        const text = `No paper trade: ${failure instanceof Error ? failure.message : String(failure)}`
        paper.push(text)
        recordPaperRefusal({ at: Math.floor(Date.now() / 1000), source: 'watch', symbol: event.symbol, text })
      }
    }
    // One plain notice an event, raised by the first call to trade that arrives. An answer that
    // opened a paper trade has raised a notice of its own, which says more, so it raises no plain
    // one and none follows it. A paper trade opened on a later answer is still told: that is
    // something done, not one more opinion.
    const notice = noticed || opened ? null : watchNotice(event, decision)
    if (opened) noticed = true
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

  /** What the models said, then what was done about it, then who was not asked. */
  const told = (results: AskModelsResult['results'], heldBack: number): { text: string; ok: boolean; retry: boolean } => {
    const said = summarize(event, results, heldBack)
    // Who was left out, in a few words: the card says why on a line of its own.
    const rested = resting.length === 0 ? '' : ` Not asked: ${resting.map((model) => describeDecider(model)).join(', ')}, rested until midnight UTC.`
    return { text: `${said.text}${paper.map((line) => ` ${line}`).join('')}${rested}`, ok: said.ok, retry: false }
  }

  const gated = watch.firstModelGates && watch.models.length > 1
  const first = await askModels(gated ? watch.models.slice(0, 1) : watch.models, ask)
  if (!gated) return told(first.results, 0)
  // Most events are no trade. The first model says so alone, and the others are asked only about
  // what it would act on.
  if (!isActionableOpportunity(first.results[0].decision)) return told(first.results, watch.models.length - 1)
  const rest = await askModels(watch.models.slice(1), ask)
  return told([...first.results, ...rest.results], 0)
}

/** One look at the scanner's events. Resolves when every event it took up has been answered.
 *
 * Safe to call again before it resolves -- a pass a minute is the scanner's pace, and a slow
 * model takes longer than that: an event is taken up by exactly one pass. */
export async function watchPass(events: MarketEvent[], deps: WatchDeps): Promise<WatchPassResult> {
  const result: WatchPassResult = { asked: [], skipped: [], retry: [] }
  if (!events.some((event) => !handled.has(event.id))) return result

  const { watch } = await deps.getConfig()
  // Off: nothing is marked. An event waiting here when the watch is switched on is taken up only
  // if it is still fresh, like any other.
  if (!watch.enabled) return result

  const nowSec = deps.nowSec()
  const page = await deps.listCalls({ source: 'watch', sinceSec: utcMidnight(nowSec), limit: LEDGER_ROWS_READ })
  const takenToday = watchEventIdsToday(page.rows, nowSec)
  for (const eventId of inFlight.keys()) takenToday.add(eventId)
  // A model that keeps failing or being refused today is left out, and the others are still
  // asked. The main process holds the same line where the call is made.
  const paused = watchPausedModels(page.rows, nowSec)
  const resting = watch.models.filter((model) => paused.has(model))
  const asked: AiWatchConfig = resting.length === 0 ? watch : { ...watch, models: watch.models.filter((model) => !paused.has(model)) }

  // The strongest of a minute first, so that it is the one that gets the day's last place.
  const candidates = events
    .filter((event) => !handled.has(event.id))
    .sort((a, b) => (a.live?.rank ?? Infinity) - (b.live?.rank ?? Infinity) || b.time - a.time || a.id.localeCompare(b.id))

  const asking: Promise<void>[] = []
  for (const event of candidates) {
    // Another pass may have taken it while this one was reading the setting and the ledger.
    if (handled.has(event.id)) continue
    handled.add(event.id)
    const reason = watchSkipReason(event, watch, { nowSec, takenToday, paused })
    if (reason !== null) {
      result.skipped.push({ id: event.id, reason })
      continue
    }
    takenToday.add(event.id)
    inFlight.set(event.id, event.symbol)
    result.asked.push(event.id)
    asking.push(
      askAbout(event, asked, deps, resting)
        // Whatever went wrong, the event stops counting as one being asked about.
        .catch((failure: unknown) => ({ text: `${event.symbol}: ${failure instanceof Error ? failure.message : String(failure)}`, ok: false, retry: false }))
        .then((outcome) => {
          inFlight.delete(event.id)
          if (outcome.retry) {
            handled.delete(event.id)
            result.retry.push(event.id)
          }
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
