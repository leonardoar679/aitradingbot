import { formatUsd } from './aiCost'
import type { AiCallRecord } from './aiLedger'
import { AI_OPPORTUNITY_MAX_MODELS, describeOpportunitySide, isActionableOpportunity, opportunitySide, opportunityWindow } from './aiOpportunity'
import { describeDecider, isPanelId } from './aiPanel'
import { AI_PROVIDER_LABEL, type AiSignalDecision, type AiSignalEstimate } from './aiSignal'
import { EVENT_MAX_RANKED, describeEventType, isAtLeast, type MarketEvent } from './marketEvent'

// THE WATCH: events put to models without a click.
//
// Everything else that asks a model in this app waits for a person: a button with its price on
// it, or a confirmation before a run. The watch is the one thing that asks while nobody is
// looking -- when the scanner raises an event, it puts it to the chosen models at once, because a
// recommendation with a fifteen-minute entry is worth nothing an hour later.
//
// SO ITS LIMITS ARE ITS OWN, AND THEY ARE COUNTED, NOT ESTIMATED:
//   - it is off until switched on, and switching it on states the most it can cost in a day;
//   - what it asks cannot change while it is on: a different list of models, or a higher limit, is
//     a different price, and is agreed to by switching it on again;
//   - it asks about at most so many events a day, counted from the call ledger rather than kept
//     in a variable a restart would forget;
//   - it takes up only events raised live, in the last few minutes, among the strongest of their
//     minute -- never what was on file when the app started;
//   - a model that fails or is refused three times running is not asked again that day;
//   - the daily AI budget is checked in the main process before every call, as for any other.
// The renderer's scheduler applies these (watchSkipReason), and the main process applies them
// again where the money is spent (watchCallProblem), so a scheduler gone wrong cannot ask for
// more than was agreed to.
//
// IT RECOMMENDS. IT PLACES NOTHING REAL. What the watch produces is the same card a click
// produces, and a desktop notice that says nothing has been placed. Anything real is still a form
// a person opens and submits (shared/aiProposal.ts). Since 2026-10-04 it may also open a PAPER
// position on a call it would act on, when that is switched on: shared/aiWatchPaper.ts.

export const AI_WATCH_EVENT_LIMITS = [5, 10, 20, 40] as const
export const AI_WATCH_DEFAULT_EVENT_LIMIT = 10
/** An event older than this is not taken up: the entry it would recommend has largely gone, and
 * an app started in the afternoon must not buy opinions on the morning's events. */
export const AI_WATCH_FRESH_SECONDS = 180

/** A model whose last this-many calls for the watch today all failed or were refused is not asked
 * again until the next UTC day. A refused answer was billed, and a provider that is down fails
 * every call it is sent: either way, asking on only buys more of the same. */
export const AI_WATCH_BREAKER_CALLS = 3

export type AiWatchBand = 'candidate' | 'urgent'

export interface AiWatchConfig {
  enabled: boolean
  /** The models each event is put to, in the order they are asked. */
  models: string[]
  /** Events asked about in one UTC day, at most. */
  maxEventsPerDay: number
  /** The lowest band asked about. */
  minBand: AiWatchBand
  /** Ask the first model alone, and the others only when it calls a trade. Most events are no
   * trade, so most then cost one call instead of one a model. */
  firstModelGates: boolean
  /** CONFIRM (the V4 document, §45; chosen 8 October 2026, off by default). With paper trades on, a
   * paper BUY the watch opens is also told as ready to confirm, and Opportunities' row offers to
   * fill in a real order from the call, sized by the risk setting. A person types the phrase and
   * places it; the watch places nothing, with this on or off. Not a term of the watch's price. */
  confirmLive: boolean
}

export const DEFAULT_AI_WATCH: AiWatchConfig = {
  enabled: false,
  models: [],
  maxEventsPerDay: AI_WATCH_DEFAULT_EVENT_LIMIT,
  minBand: 'urgent',
  firstModelGates: false,
  confirmLive: false
}

export function isAiWatchEventLimit(value: unknown): value is (typeof AI_WATCH_EVENT_LIMITS)[number] {
  return (AI_WATCH_EVENT_LIMITS as readonly unknown[]).includes(value)
}

/** A stored watch, healed. Anything unreadable becomes the default.
 *
 * A WATCH THAT IS NOT EXACTLY WHAT WAS SWITCHED ON IS OFF. If a stored model is no longer one the
 * user allows, the list is repaired -- and the watch is switched off with it, rather than left
 * running in a shape nobody agreed to the price of. `enabledModels` is what may be asked at all. */
export function healAiWatch(value: unknown, enabledModels: string[]): AiWatchConfig {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof AiWatchConfig, unknown>>
  const stored = Array.isArray(raw.models) ? raw.models : []
  const models = [...new Set(stored.filter((model): model is string => typeof model === 'string' && enabledModels.includes(model) && !isPanelId(model)))].slice(
    0,
    AI_OPPORTUNITY_MAX_MODELS
  )
  const intact = models.length === stored.length && models.length > 0
  const limitOk = isAiWatchEventLimit(raw.maxEventsPerDay)
  const bandOk = raw.minBand === 'candidate' || raw.minBand === 'urgent'
  return {
    enabled: raw.enabled === true && intact && limitOk && bandOk && typeof raw.firstModelGates === 'boolean',
    models,
    maxEventsPerDay: isAiWatchEventLimit(raw.maxEventsPerDay) ? raw.maxEventsPerDay : AI_WATCH_DEFAULT_EVENT_LIMIT,
    minBand: raw.minBand === 'candidate' ? 'candidate' : 'urgent',
    firstModelGates: raw.firstModelGates === true,
    // Off unless switched on; a file written before it existed keeps its watch as it was.
    confirmLive: raw.confirmLive === true
  }
}

/** Why a watch cannot be saved, or null when it can. What arrives here came over IPC, so its
 * shape is checked and not assumed. */
export function aiWatchProblem(watch: AiWatchConfig, enabledModels: string[]): string | null {
  if (typeof watch.enabled !== 'boolean') return 'The watch is either on or off'
  if (typeof watch.firstModelGates !== 'boolean') return 'Asking the first model alone is either on or off'
  if (typeof watch.confirmLive !== 'boolean') return 'Ready-to-confirm notices are either on or off'
  if (!Array.isArray(watch.models) || !watch.models.every((model) => typeof model === 'string')) return 'The watch asks a list of models'
  if (watch.models.length > AI_OPPORTUNITY_MAX_MODELS) return `The watch asks at most ${AI_OPPORTUNITY_MAX_MODELS} models`
  if (new Set(watch.models).size !== watch.models.length) return 'The watch was given the same model twice'
  for (const model of watch.models) {
    if (isPanelId(model)) return 'A panel of agents has no question to put to an event, so the watch cannot ask one'
    if (!enabledModels.includes(model)) return `${model} is not enabled. Enable it under Settings › AI before the watch asks it.`
  }
  if (!isAiWatchEventLimit(watch.maxEventsPerDay)) return `The watch asks about ${AI_WATCH_EVENT_LIMITS.join(', ')} events a day`
  if (watch.minBand !== 'candidate' && watch.minBand !== 'urgent') return 'The watch asks about events at candidate or at urgent'
  if (watch.enabled && watch.models.length === 0) return 'Tick at least one model for the watch to ask'
  return null
}

/** Whether two watches ask the same thing at the same price: the same models in the same order,
 * the same limit, band and gate. */
export function sameWatchTerms(a: AiWatchConfig, b: AiWatchConfig): boolean {
  return (
    a.maxEventsPerDay === b.maxEventsPerDay &&
    a.minBand === b.minBand &&
    a.firstModelGates === b.firstModelGates &&
    a.models.length === b.models.length &&
    a.models.every((model, index) => model === b.models[index])
  )
}

export function utcMidnight(nowSec: number): number {
  return Math.floor(nowSec / 86_400) * 86_400
}

/** The events the watch has taken up today, from the ledger: every event with a call the watch
 * made since the last UTC midnight. A call that never reached a model still counts -- the event
 * was taken up -- so a provider that is down cannot make the watch try every event of the day. */
export function watchEventIdsToday(calls: Pick<AiCallRecord, 'at' | 'source' | 'eventId'>[], nowSec: number): Set<string> {
  const midnight = utcMidnight(nowSec)
  const taken = new Set<string>()
  for (const call of calls) {
    if (call.source === 'watch' && call.eventId !== undefined && call.at >= midnight) taken.add(call.eventId)
  }
  return taken
}

/** The models the watch has stopped asking for the rest of the UTC day: each one's last
 * AI_WATCH_BREAKER_CALLS calls for the watch today all failed or were refused. Counted from the
 * ledger, like the day's events, so a restart does not forget it and midnight UTC clears it. */
export function watchPausedModels(calls: Pick<AiCallRecord, 'at' | 'source' | 'model' | 'status'>[], nowSec: number): Set<string> {
  const midnight = utcMidnight(nowSec)
  const latest = new Map<string, AiCallRecord['status'][]>()
  for (const call of calls.filter((row) => row.source === 'watch' && row.at >= midnight).sort((a, b) => b.at - a.at)) {
    const statuses = latest.get(call.model) ?? []
    if (statuses.length < AI_WATCH_BREAKER_CALLS) statuses.push(call.status)
    latest.set(call.model, statuses)
  }
  const paused = new Set<string>()
  for (const [model, statuses] of latest) {
    if (statuses.length >= AI_WATCH_BREAKER_CALLS && statuses.every((status) => status !== 'ok')) paused.add(model)
  }
  return paused
}

export function describeWatchPause(model: string): string {
  return `${describeDecider(model)} failed or was refused on its last ${AI_WATCH_BREAKER_CALLS} calls for the watch today, so the watch is not asking it again until midnight UTC.`
}

/** Why the watch does not take up an event, or null when it does. `takenToday` is the events it
 * has already taken up today, the ones with a call in the air included; `paused` is the models it
 * has stopped asking today. */
export function watchSkipReason(
  event: MarketEvent,
  watch: AiWatchConfig,
  state: { nowSec: number; takenToday: ReadonlySet<string>; paused?: ReadonlySet<string> }
): string | null {
  if (!watch.enabled) return 'The watch is off.'
  if (watch.models.length === 0) return 'The watch has no model to ask.'
  if (state.paused !== undefined && watch.models.every((model) => state.paused?.has(model))) {
    return watch.models.length === 1 ? describeWatchPause(watch.models[0]) : 'Every model the watch asks has failed or been refused three times running today.'
  }
  if (event.live === null) return 'It was found by scanning history, not raised live.'
  // Part of a market-wide move (shared/marketEvent.ts marketMoveOf): the move is the event asked about.
  if (event.live.marketMove !== undefined) return 'It is part of a market-wide move, which the watch asks about as one event.'
  if (event.direction === 'none') return 'It has no direction to act on.'
  // An announcement's event is raised by the news, not the move: the band is what the candles
  // alone showed at that minute, and is not what the watch asks about it for.
  if (event.news === undefined && !isAtLeast(event.band, watch.minBand)) return `It is below the ${watch.minBand} band the watch asks about.`
  if (event.live.rank > EVENT_MAX_RANKED) return `It was not among the strongest ${EVENT_MAX_RANKED} of its minute.`
  if (state.nowSec - event.time > AI_WATCH_FRESH_SECONDS) return `It is more than ${AI_WATCH_FRESH_SECONDS / 60} minutes old.`
  if (!state.takenToday.has(event.id) && state.takenToday.size >= watch.maxEventsPerDay) return `The watch has asked about its ${watch.maxEventsPerDay} events for today.`
  return null
}

/** Why the main process will not make a call the watch asks for, or null when it will.
 *
 * The same line as watchSkipReason, held where the money is spent. An event the watch has already
 * taken up may be put to the rest of its models -- that is the first model passing it on -- so
 * the most a day can cost is each of its models once, for each of its events: what switching it
 * on stated. */
export function watchCallProblem(input: {
  watch: AiWatchConfig
  model: string
  eventId: string
  eventTime: number
  nowSec: number
  /** Events the watch has taken up today: in the ledger, or with a call in the air. */
  takenToday: ReadonlySet<string>
  /** Models the watch has stopped asking today (watchPausedModels). */
  paused?: ReadonlySet<string>
}): string | null {
  const { watch } = input
  if (!watch.enabled) return 'The watch is off, so nothing is asked on its behalf.'
  if (!watch.models.includes(input.model)) return `${input.model} is not one of the models the watch asks.`
  if (input.paused?.has(input.model)) return describeWatchPause(input.model)
  if (input.takenToday.has(input.eventId)) return null
  if (input.nowSec - input.eventTime > AI_WATCH_FRESH_SECONDS) return `The watch takes up only an event raised in the last ${AI_WATCH_FRESH_SECONDS / 60} minutes.`
  if (input.takenToday.size >= watch.maxEventsPerDay) return `The watch has asked about its ${watch.maxEventsPerDay} events for today.`
  return null
}

export interface AiWatchCostModel {
  model: string
  perCallCostUsd: number | null
  costBasis: AiSignalEstimate['costBasis']
}

/** What switching the watch on can cost, said before it is switched on.
 *
 * THE MOST, NOT THE LIKELY. A confirmation that said "about ten cents" and then spent forty would
 * be worse than none. The figure is every model asked about every event the limit allows; with
 * the first model gating the others the least is said too, because that is the point of it.
 * `models` is the watch's own list, in its order. */
export function describeAiWatchCost(input: {
  watch: AiWatchConfig
  models: AiWatchCostModel[]
  budgetRemainingUsd: number
  dailyCapUsd: number
  scannerOn: boolean
}): string {
  const { watch } = input
  const count = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`
  const priced = input.models.every((model) => model.perCallCostUsd !== null)
  const perEvent = input.models.reduce((sum, model) => sum + (model.perCallCostUsd ?? 0), 0)
  const most = perEvent * watch.maxEventsPerDay
  const firstOnly = (input.models[0]?.perCallCostUsd ?? 0) * watch.maxEventsPerDay
  const gated = watch.firstModelGates && input.models.length > 1
  const lines = input.models.map((model) => {
    if (model.perCallCostUsd === null) return `  ${describeDecider(model.model)}: cost not known (no call history here and no published price)`
    const basis = model.costBasis === 'history' ? 'going by its recent calls here' : 'going by its price list, an estimate'
    return `  ${describeDecider(model.model)}: about ${formatUsd(model.perCallCostUsd)} a call ${basis}`
  })
  const sum = !priced
    ? 'What that can cost in a day is not known, because a model in it has no known price.'
    : gated
      ? `At most about ${formatUsd(most)} a day, if every event is passed on; about ${formatUsd(firstOnly)} if none is.`
      : `At most about ${formatUsd(most)} a day.`
  const budget =
    priced && most > input.dailyCapUsd
      ? `That is more than the daily AI budget of ${formatUsd(input.dailyCapUsd)}: the watch stops when the budget is used up, and so does everything else that asks a model that day.`
      : `The daily AI budget of ${formatUsd(input.dailyCapUsd)} still applies, and ${formatUsd(input.budgetRemainingUsd)} of today's is left.`
  return [
    `Switch the watch on? While it is on, each ${watch.minBand === 'urgent' ? 'urgent ' : ''}event the scanner puts forward is put to ${count(input.models.length, 'model', 'models')} through ${AI_PROVIDER_LABEL} without a click, for as long as the app is open.`,
    '',
    `At most ${count(watch.maxEventsPerDay, 'event', 'events')} a day:`,
    ...lines,
    ...(gated ? [`${describeDecider(input.models[0].model)} is asked first, and the ${input.models.length === 2 ? 'other' : 'others'} only when it calls a trade.`] : []),
    sum,
    '',
    budget,
    ...(input.scannerOn ? [] : ['The scanner is off, so the watch has nothing to ask about until it is switched on under Settings › Market.']),
    'It recommends and notifies. It places nothing real, and it stays on across restarts until you switch it off.',
    '',
    'Switch it on?'
  ].join('\n')
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** What the desktop is told when the watch gets a call this app would act on. Null for anything
 * else. `key` is the same for every answer about one event, so one event raises one notice
 * however many models call it. The notice says nothing has been placed, because a notification
 * that reads "BUY" reads otherwise. */
export function watchNotice(event: MarketEvent, decision: AiSignalDecision): { key: string; title: string; body: string } | null {
  if (!isActionableOpportunity(decision)) return null
  const validity = opportunityWindow(event.time, decision.detail)
  if (validity === null) return null
  const side = opportunitySide(decision)
  return {
    key: event.id,
    title: `${event.symbol}: ${describeOpportunitySide(side)}`,
    body:
      `${describeDecider(decision.model)} at ${Math.round(decision.confidence * 100)}% confidence, on the ${describeEventType(event.type).toLowerCase()} at ${utcClock(event.time)} UTC. Nothing has been placed` +
      `${side === 'short' ? ', and a short can only be paper traded' : ''}. ` +
      `Its entry is good until ${utcClock(validity.expiresAt)} UTC: open Opportunities.`
  }
}
