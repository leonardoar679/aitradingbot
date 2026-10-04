import { isAiModelSlug } from './aiSignal'

// HOW HARD A MODEL IS ASKED TO THINK, AS PART OF WHO IS ASKED.
//
// The first real calls cost about $0.003 and took 9 to 13 seconds each, and nearly all of both was
// the model's reasoning: some 900 of its 1,100 output tokens, for an answer of a couple of
// hundred. A reasoning model can be asked to think less. Whether it then answers as well is not
// something to assume either way, so the setting is not a knob on a model -- it is a second
// competitor.
//
// `openai/gpt-5-mini@low` is that model asked at low reasoning effort. It is enabled, made the
// default, benchmarked, routed to and pinned on a bot exactly like a model, because everywhere a
// model is named it is named by this id: the cache keys an answer under it, the ledger records it,
// and a benchmark sets it beside the same model at its own default and scores the two on the same
// questions. Only two things take it apart: the request, which asks OpenRouter for the model and
// passes the effort as a parameter, and the price list, which has one entry for both.
//
// An id with no mark is a model at its provider's default, and is sent exactly as it always was:
// no reasoning parameter at all. So nothing asked before this existed is asked differently now,
// and nothing already cached is orphaned.

export const AI_EFFORT_MARK = '@'

/** The efforts on offer, least reduction first. Both ask for LESS thought than a model's default:
 * the point is cost and time. `minimal` is not taken by every reasoning model; one that refuses
 * it says so on the first call, which costs nothing. */
export const AI_EFFORTS = ['low', 'minimal'] as const
export type AiEffort = (typeof AI_EFFORTS)[number]

export function isAiEffort(value: unknown): value is AiEffort {
  return AI_EFFORTS.includes(value as AiEffort)
}

/** `openai/gpt-5-mini@low`: that model, asked at that effort. */
export function effortIdFor(model: string, effort: AiEffort): string {
  return `${model}${AI_EFFORT_MARK}${effort}`
}

/** The model OpenRouter is asked for, and the effort it is asked at (null: its own default).
 *
 * An id whose mark is followed by anything but a known effort is NOT split: it comes back whole,
 * as a slug that isAiModelSlug then refuses, rather than being quietly read as the plain model. */
export function splitAiModelId(id: string): { slug: string; effort: AiEffort | null } {
  const at = id.lastIndexOf(AI_EFFORT_MARK)
  if (at < 0) return { slug: id, effort: null }
  const effort = id.slice(at + 1)
  return isAiEffort(effort) ? { slug: id.slice(0, at), effort } : { slug: id, effort: null }
}

/** The price-list entry an id is charged under: the model, whatever effort it is asked at. */
export function aiModelSlugOf(id: string): string {
  return splitAiModelId(id).slug
}

export function aiEffortOf(id: string): AiEffort | null {
  return splitAiModelId(id).effort
}

/** A model id as this app stores and passes it: an OpenRouter id, optionally at an effort. */
export function isAiModelId(id: string): boolean {
  return isAiModelSlug(aiModelSlugOf(id))
}

/** A model id as it is said in a sentence. */
export function describeAiModelId(id: string): string {
  const { slug, effort } = splitAiModelId(id)
  return effort === null ? slug : `${slug} at ${effort} effort`
}
