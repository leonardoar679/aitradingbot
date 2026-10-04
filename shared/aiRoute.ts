import { isAiModelId } from './aiEffort'
import { describeDecider, isPanelId } from './aiPanel'
import {
  GPT_MIN_CONFIDENCE,
  gptActionFor,
  type AiRecommendation,
  type AiSignalDecision,
  type GptPosition
} from './aiSignal'

// Two models for one decision.
//
// A cheap model can be asked every fifteen minutes for a few dollars a month. A frontier model
// asked the same way costs several times that, and nearly all of it buys the answer "hold". A
// route asks the first model every time and passes a decision on to a second model only when a
// rule says it is worth a second answer. The second model's answer is then the decision.
//
// THE QUESTION DOES NOT CHANGE, AND NEITHER DOES WHERE ITS ANSWER IS KEPT. The second model is sent
// the context the first one was, under the same prompt, so its answer is filed under the key any
// other call to that model about that candle uses. Three things follow from that:
//
//   A route never pays for an answer a benchmark, a backtest or the Analyze tab already bought,
//   and they never pay for one a route bought.
//
//   A routed decision is a pure function of two ordinary answers, so the Benchmark tab can say
//   what a route between two models WOULD have done from answers it already holds, asking nothing.
//   That is how a route should be chosen: measured first, switched on second.
//
//   The second model is not told what the first one said. It is a second opinion, not a review of
//   the first, and its answer is the same one it would give anybody.
//
// ONLY AN ANSWER CAN BE PASSED ON. A call that never reached the first model is a failure, not a
// decision. It stays one -- uncached, counted, asked again next time -- rather than being handed to
// the second model, whose answer would then be replaced by the first's as soon as that one could
// be reached again.

/** When a decision is passed on to the second model.
 *
 *   `acting`: the first model's answer would change the account -- open a position while flat or
 *   close one while long, at or above the confidence a bot acts on. Nothing is then traded on the
 *   first model's word alone: it screens, the second decides.
 *
 *   `unsure`: the first model answered below that confidence, or gave an answer the validator
 *   refused. What it is sure of stands, a confident entry included; the second takes the rest.
 *
 * Both read the one confidence gate the position machine already has, rather than a second number
 * that could drift from it. */
export const AI_ESCALATE_WHEN = ['acting', 'unsure'] as const
export type AiEscalateWhen = (typeof AI_ESCALATE_WHEN)[number]

export function isAiEscalateWhen(value: unknown): value is AiEscalateWhen {
  return AI_ESCALATE_WHEN.includes(value as AiEscalateWhen)
}

/** The second step of a route, and when a decision is passed on to it. The first model is
 * whichever one the run names, or the configured default. The second is a model, or a panel of
 * agents on one (shared/aiPanel.ts): either way it is put the same snapshot and its answer is the
 * decision, so nothing in this file needs to know which. */
export interface AiRoute {
  model: string
  when: AiEscalateWhen
}

/** What the first model had said, kept on a decision that was passed on. */
export interface AiFirstOpinion {
  model: string
  recommendation: AiRecommendation
  confidence: number
  /** Why the validator refused the first model's answer; null when it was usable. */
  rejected: string | null
}

/** Checks a route and rebuilds it, field by field. Null for no route at all.
 *
 * The route is written by the renderer, stored on bots and in a config file, and decides how many
 * paid calls a decision can make, so it is checked wherever it arrives rather than trusted.
 * Malformed is refused, never guessed at: a route whose rule cannot be read must not quietly run
 * as "always ask both". */
export function parseAiRoute(value: unknown): AiRoute | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A route names a second model and when it is asked')
  }
  const record = value as Record<string, unknown>
  if (typeof record.model !== 'string' || !isAiModelId(record.model)) {
    throw new Error("A route's second model is not a valid model id")
  }
  if (!isAiEscalateWhen(record.when)) {
    throw new Error('A route passes a decision on when the first model wants to trade, or when it is unsure')
  }
  return { model: record.model, when: record.when }
}

/** Whether the first model's answer is passed on to the second.
 *
 * `position` is the one carried into the bar, the same one the position machine reads: "wants to
 * trade" means a buy while flat or a sell while long, and a buy on top of a position that is
 * already open is not one. */
export function escalates(first: AiSignalDecision, position: GptPosition, when: AiEscalateWhen): boolean {
  if (first.error !== null) return false
  if (when === 'acting') return gptActionFor(first, position) !== 'none'
  return Boolean(first.rejected) || first.confidence < GPT_MIN_CONFIDENCE
}

export function firstOpinionOf(decision: AiSignalDecision): AiFirstOpinion {
  return {
    model: decision.model,
    recommendation: decision.recommendation,
    confidence: decision.confidence,
    rejected: decision.rejected ?? null
  }
}

/** The decision a route reaches once the second model has been asked: the second model's answer,
 * carrying what the first had said.
 *
 * It cost nothing only if NEITHER answer was paid for by this run, so `cached` is true only when
 * both are. An error on the second call comes through as the error it is. */
export function routedDecision(first: AiSignalDecision, second: AiSignalDecision): AiSignalDecision {
  return { ...second, cached: first.cached && second.cached, first: firstOpinionOf(first) }
}

/** What follows "when it" in a sentence: `wants to open or close a position`. */
export function describeEscalation(when: AiEscalateWhen): string {
  return when === 'acting'
    ? 'wants to open or close a position'
    : `answers with less than ${Math.round(GPT_MIN_CONFIDENCE * 100)}% confidence`
}

/** `openai/gpt-5-mini, then anthropic/claude-sonnet-4.5 when it wants to open or close a position`. */
export function describeAiRoute(firstModel: string, route: AiRoute): string {
  return `${firstModel}, then ${describeDecider(route.model)} when it ${describeEscalation(route.when)}`
}

/** A route in two or three words, for a label that has no room for the models' names. */
export function describeRouteKind(route: AiRoute): string {
  return isPanelId(route.model) ? 'model and panel' : 'two models'
}

export function sameAiRoute(a: AiRoute | null | undefined, b: AiRoute | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.model === b.model && a.when === b.when
}
