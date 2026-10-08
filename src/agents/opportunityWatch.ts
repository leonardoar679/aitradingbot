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
import { AI_WATCH_FRESH_SECONDS, WATCH_NOT_CONFIRMED_REASON, utcMidnight, watchEventIdsToday, watchNotice, watchPausedModels, watchSkipReason, type AiWatchConfig } from '../../shared/aiWatch'
import { describeEventType, type EventLife, type MarketEvent } from '../../shared/marketEvent'
import { voteOf } from '../../shared/opportunityVote'
import { actionableRefusal, breakerNotice, confirmNotice, disagreementNotice, marketEventNotice, tradeBlockedNotice, type NoticeExtra } from '../../shared/notices'
import { askModels, fetchEventQuestion, type AskModelsResult, type CandleFetch } from './opportunities'
import { recordPaperRefusal, type PaperRefusal } from './paperRefusals'

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
  /** A desktop notice, with its kind and thread (shared/notices.ts). */
  notify: (title: string, body: string, extra?: NoticeExtra) => void
  nowSec: () => number
  /** Opens a paper trade on an answer, when that is switched on. Resolves to what came of it, or
   * to null when there is nothing to say. Absent, the watch only asks and notifies. `byVote`
   * (since 8 October 2026): the answer is the one the models' vote chose, whichever model gave it. */
  paperTrade?: (event: MarketEvent, decision: AiSignalDecision, byVote?: boolean) => Promise<{ opened: boolean; text: string } | null>
  /** Writes a refusal to the records on file (shared/records.ts), beside the session's own list.
   * A record; nothing reads it to decide anything. Absent, the session's list is all there is. */
  recordRefusal?: (refusal: PaperRefusal) => void
}

/** A paper trade refused: the sentence its writer gave, with the ids that join it to the trade's
 * timeline, kept for the session and written to the file. */
function refused(deps: WatchDeps, event: MarketEvent, decision: AiSignalDecision, text: string): void {
  const nowMs = Date.now()
  const side = opportunitySide(decision)
  const refusal: PaperRefusal = {
    id: `${event.id}:${decision.model}:${nowMs}`,
    at: Math.floor(nowMs / 1000),
    source: 'watch',
    symbol: event.symbol,
    text,
    eventId: event.id,
    model: decision.model,
    ...(decision.callId !== undefined ? { callId: decision.callId } : {}),
    ...(side === 'long' ? { side: 'buy' as const } : side === 'short' ? { side: 'sell' as const } : {})
  }
  recordPaperRefusal(refusal)
  deps.recordRefusal?.(refusal)
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
    // A market-wide move is asked about by its id: the main process reads its members from its
    // own record of the move, and the question is Bitcoin's pair with them as breadth.
    if (event.type === 'market_move') market = { ...market, marketMoveId: event.id }
  } catch (failure) {
    // Nothing was asked, so nothing was spent and the event is not used up: the next pass may
    // take it again while it is still fresh.
    const message = failure instanceof Error ? failure.message : String(failure)
    return { text: `${event.symbol}: its candles could not be read (${message}).`, ok: false, retry: true }
  }

  /** A notice of the document's kinds, told without failing the pass that raised it. */
  const told = (notice: { title: string; body: string; extra: NoticeExtra }): void => {
    try {
      deps.notify(notice.title, notice.body, notice.extra)
    } catch {
      // A desktop that cannot show it is not a reason to lose an answer that was paid for.
    }
  }

  let noticed = false
  const paper: string[] = []
  // THE VOTE (shared/opportunityVote.ts; the V5 document, §39): with two or more models asked and
  // a paper trader to hand the answer to, the paper trade follows what the answers add up to, once
  // they are all in, and the plain notice waits for that; with one model, or with no paper
  // trader, each answer is acted on and told as it arrives, as it always was.
  const byVote = watch.models.length >= 2 && deps.paperTrade !== undefined
  /** The first answer that would have traded, under a vote: the plain notice is its, after the vote. */
  let firstActionable: AiSignalDecision | null = null

  /** Hands an answer to the paper trader, when there is one, and says what came of it: true when a
   * trade was opened. A refusal is written down, and told when a person can act on it. */
  const tradeOn = async (decision: AiSignalDecision): Promise<boolean> => {
    if (deps.paperTrade === undefined) return false
    try {
      const outcome = await deps.paperTrade(event, decision, byVote)
      if (outcome === null) return false
      paper.push(outcome.text)
      // CONFIRM (shared/aiWatch.ts): a paper BUY opened is also told as ready to confirm as a
      // real order, which a person fills in from Opportunities and places. Nothing here does.
      if (outcome.opened && watch.confirmLive && opportunitySide(decision) === 'long') {
        told(confirmNotice(event, { who: describeDecider(decision.model), confidence: decision.confidence }))
      }
      // For the session report: what was refused, and why. A refusal a person can act on -- the
      // paper account, the money-out cap, a pause -- is told; the market's reasons, which repeat
      // every minute, are the Watch card's.
      if (!outcome.opened) refused(deps, event, decision, outcome.text)
      if (!outcome.opened && actionableRefusal(outcome.text)) told(tradeBlockedNotice(event.symbol, outcome.text))
      return outcome.opened
    } catch (failure) {
      const text = `No paper trade: ${failure instanceof Error ? failure.message : String(failure)}`
      paper.push(text)
      refused(deps, event, decision, text)
      return false
    }
  }

  /** One plain notice an event, raised by the first call to trade that arrives. An answer that
   * opened a paper trade has raised a notice of its own, which says more, so it raises no plain
   * one and none follows it. A paper trade opened on a later answer is still told: that is
   * something done, not one more opinion. */
  const plainNotice = (decision: AiSignalDecision, opened: boolean): void => {
    const notice = noticed || opened ? null : watchNotice(event, decision)
    if (opened) noticed = true
    if (notice !== null) {
      noticed = true
      try {
        deps.notify(notice.title, notice.body, { kind: 'TRADE_OPPORTUNITY', thread: event.id })
      } catch {
        // A desktop that cannot show it is not a reason to lose an answer that was paid for.
      }
    }
  }

  const ask = async (model: string): Promise<AiSignalDecision> => {
    const decision = await deps.ask({ ...market, model, source: 'watch' })
    // A call the watch would act on may open a paper trade, when that is switched on -- at once
    // with one model, after the vote with more. Whatever comes of it, the answer was paid for and
    // is returned.
    if (byVote) {
      if (isActionableOpportunity(decision) && firstActionable === null) firstActionable = decision
      return decision
    }
    const opened = isActionableOpportunity(decision) ? await tradeOn(decision) : false
    plainNotice(decision, opened)
    return decision
  }

  /** The answers added up (voteOf): the trade the vote opens, or the refusal it is, written down
   * against the first answer that would have traded. */
  const voted = async (results: AskModelsResult['results']): Promise<string> => {
    const decisions = results.map((result) => result.decision)
    const vote = voteOf(decisions)
    let opened = false
    if (vote.chosen !== null) opened = await tradeOn(vote.chosen)
    else if (vote.refusal !== null) {
      const first = decisions.find((decision): decision is AiSignalDecision => isActionableOpportunity(decision) && decision !== null)
      const text = `No paper trade: ${vote.refusal}`
      paper.push(text)
      if (first !== undefined) refused(deps, event, first, text)
    }
    // The plain notice, held back for the vote: the first call to trade's, unless a trade opened.
    if (firstActionable !== null) plainNotice(firstActionable, opened)
    return vote.text
  }

  /** What the models said, the vote where there was one, then what was done about it, then who was
   * not asked. Models on opposite sides are told (MODEL_DISAGREEMENT); a model rested for the day
   * is told once a day. */
  const outcome = async (results: AskModelsResult['results'], heldBack: number): Promise<{ text: string; ok: boolean; retry: boolean }> => {
    const said = summarize(event, results, heldBack)
    const sides = results.flatMap((result) => {
      const side = result.decision === null ? null : opportunitySide(result.decision)
      return side === 'long' || side === 'short' ? [{ model: describeDecider(result.model), side }] : []
    })
    if (sides.some((entry) => entry.side === 'long') && sides.some((entry) => entry.side === 'short')) told(disagreementNotice(event, sides))
    const vote = byVote && results.length >= 2 ? ` Vote: ${await voted(results)}.` : ''
    for (const model of resting) {
      told(breakerNotice('model', `${describeDecider(model)} failed or was refused three times running today, and the watch does not ask it again until midnight UTC. The other models are still asked.`, `model:${model}`))
    }
    // Who was left out, in a few words: the card says why on a line of its own.
    const rested = resting.length === 0 ? '' : ` Not asked: ${resting.map((model) => describeDecider(model)).join(', ')}, rested until midnight UTC.`
    return { text: `${said.text}${vote}${paper.map((line) => ` ${line}`).join('')}${rested}`, ok: said.ok, retry: false }
  }

  const gated = watch.firstModelGates && watch.models.length > 1
  const first = await askModels(gated ? watch.models.slice(0, 1) : watch.models, ask)
  if (!gated) return outcome(first.results, 0)
  // Most events are no trade. The first model says so alone, and the others are asked only about
  // what it would act on.
  if (!isActionableOpportunity(first.results[0].decision)) return outcome(first.results, watch.models.length - 1)
  const rest = await askModels(watch.models.slice(1), ask)
  return outcome([...first.results, ...rest.results], 0)
}

/** An urgent event raised live in the last few minutes that the watch could have asked about and
 * did not, because of its own state -- off, no model, every model rested, the day's events spent --
 * is told as a MARKET_EVENT, once per pair per thread. An event skipped for its own sake (below the
 * band, not among the strongest, part of a move, stale) is not: that is the watch choosing. */
/** A notice as the arguments `notify` takes. */
function noticeArgs(notice: { title: string; body: string; extra: NoticeExtra }): [string, string, NoticeExtra] {
  return [notice.title, notice.body, notice.extra]
}

export function unaskedMarketEvent(event: MarketEvent, reason: string, nowSec: number): boolean {
  if (event.live === null || event.live.marketMove !== undefined || event.band !== 'urgent' || event.direction === 'none') return false
  if (nowSec - event.time > AI_WATCH_FRESH_SECONDS) return false
  return /^The watch is off\.|no model to ask|failed or been refused|has asked about its \d+ events for today/.test(reason)
}

/** One look at the scanner's events. Resolves when every event it took up has been answered.
 *
 * Safe to call again before it resolves -- a pass a minute is the scanner's pace, and a slow
 * model takes longer than that: an event is taken up by exactly one pass. */
export async function watchPass(events: MarketEvent[], deps: WatchDeps, lives: Readonly<Record<string, EventLife>> = {}): Promise<WatchPassResult> {
  const result: WatchPassResult = { asked: [], skipped: [], retry: [] }
  if (!events.some((event) => !handled.has(event.id))) return result

  const { watch } = await deps.getConfig()
  // Off: nothing is marked. An event waiting here when the watch is switched on is taken up only
  // if it is still fresh, like any other. An urgent one is told as a market event, once per pair.
  if (!watch.enabled) {
    const nowSec = deps.nowSec()
    for (const event of events) {
      if (!handled.has(event.id) && unaskedMarketEvent(event, 'The watch is off.', nowSec)) {
        try {
          deps.notify(...noticeArgs(marketEventNotice(event, 'the watch is off.')))
        } catch {
          // A desktop that cannot show it is not a reason to fail the pass.
        }
      }
    }
    return result
  }

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
    const reason = watchSkipReason(event, watch, { nowSec, takenToday, paused, lives })
    if (reason !== null) {
      result.skipped.push({ id: event.id, reason })
      // Waiting for the event to be confirmed (askAt): not finished with, looked at again next pass
      // while it is still fresh.
      if (reason === WATCH_NOT_CONFIRMED_REASON) {
        handled.delete(event.id)
        result.retry.push(event.id)
        continue
      }
      if (unaskedMarketEvent(event, reason, nowSec)) {
        try {
          deps.notify(...noticeArgs(marketEventNotice(event, reason.charAt(0).toLowerCase() + reason.slice(1))))
        } catch {
          // A desktop that cannot show it is not a reason to fail the pass.
        }
      }
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
