import type { AiConfig } from './aiCost'
import type { AiCallRecord } from './aiLedger'
import type { CauseLabel, MoveExplanation } from './moveExplanation'
import type { NewsEventType, ReadStory } from './newsFeed'

// THE AI ADDITIONS (the V3 engine plan's Stage 7): small questions put to a model beside the watch's.
// The news analyst reads each story of high impact once; the conclusion to "Why did it move?" weighs
// the evidence the fixed rules found, and must cite what it rests on.
//
// SWITCHED ON BY THE USER, INSIDE THE BUDGET ALREADY THERE. On 6 October 2026 the user chose "On,
// within the $5 day": each addition is on unless switched off under Settings › AI, and each has a
// daily limit of its own, so that none can starve the watch. Every call passes the gates every other
// call passes -- the daily budget immediately before it, the pace, the validator after it, and a
// ledger row either way (the main process's aiAdditionsService.ts).
//
// AN ADDITION THAT ASKS BY ITSELF RUNS ONLY WHILE THE WATCH IS ON. The watch is the switch that lets
// a model be asked with nobody pressing anything; the additions are held to it.
//
// NONE OF THEM PLACES, SIZES OR ARMS ANYTHING. A reading is shown, and weighs in the news part of the
// signal score; an answer the validator refuses is kept, as every refused answer is, and is used
// nowhere.

export const AI_ADDITION_KINDS = ['news', 'why'] as const
export type AiAdditionKind = (typeof AI_ADDITION_KINDS)[number]

/** Calls a day each may make, at most: the plan's limits, chosen with the user's $5 day. */
export const AI_ADDITION_DAILY_LIMITS: Record<AiAdditionKind, number> = { news: 40, why: 20 }

/** Each addition's question and answer, versioned as every prompt here is: part of the cache key and
 * of every ledger row, and pinned by a hash (tests/aiAdditions.test.ts). */
export const AI_ADDITION_PROMPT_VERSIONS: Record<AiAdditionKind, string> = { news: 'news-analyst-v1', why: 'why-conclusion-v1' }
export const AI_ADDITION_SCHEMA_VERSIONS: Record<AiAdditionKind, string> = { news: 'news-reading-v1', why: 'why-conclusion-v1' }

export const AI_ADDITION_INFO: Record<AiAdditionKind, { name: string; what: string; automatic: boolean }> = {
  news: {
    name: 'News analyst',
    what: "Reads each story of high impact once, as it arrives: which coin it concerns, which way it points, how much and for how long, and whether it is already in the price. Shown on Discovery's news, and weighed in the news part of the signal score.",
    automatic: true
  },
  why: {
    name: '"Why did it move?" conclusion',
    what: 'Weighs the evidence the fixed rules found for a move -- the stories that name the coin, Bitcoin, the volume -- and concludes, citing each item it rests on, or it is dropped. On a click in the Why window, at the price shown; and by itself for a coin a story of high impact names.',
    automatic: true
  }
}

/** On or off, each. Only `false` switches one off: on 6 October 2026 the user chose them on. */
export type AiAdditionsConfig = Record<AiAdditionKind, boolean>
export const DEFAULT_AI_ADDITIONS: AiAdditionsConfig = { news: true, why: true }

/** What came of asking an addition: an answer, from the cache or paid for; an answer refused and
 * kept; nothing asked, and why; or a call that got no answer. */
export type AiAdditionOutcome<T> =
  | { status: 'answered'; answer: T; cached: boolean; model: string }
  | { status: 'refused'; reason: string; cached: boolean; model: string }
  /** Not asked: switched off, the watch off, the limit or the budget reached, or no key. */
  | { status: 'skipped'; reason: string }
  /** Asked, and no answer came: counted, and not cached. */
  | { status: 'failed'; reason: string }

/** What Settings › AI shows of the additions (the main process's aiAdditionsService.ts). */
export interface AiAdditionsStatus {
  /** The model they ask. */
  model: string
  watchOn: boolean
  additions: AiAdditionsConfig
  limits: Record<AiAdditionKind, number>
  /** Calls each has made today. */
  today: Record<AiAdditionKind, number>
  /** What one more call is expected to cost: from its own calls, the price list, or not known. */
  perCall: Record<AiAdditionKind, { usd: number | null; basis: 'history' | 'pricing' | 'unknown' }>
}

/** A stored setting, read as one. */
export function healAiAdditions(value: unknown): AiAdditionsConfig {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  const out = { ...DEFAULT_AI_ADDITIONS }
  for (const kind of AI_ADDITION_KINDS) out[kind] = raw[kind] !== false
  return out
}

/** The model the additions ask: the one the watch's paper trades follow, else the first the watch
 * asks, else the default -- the watch's own model, which the user chose and priced. */
export function additionsModelOf(config: Pick<AiConfig, 'defaultModel' | 'watch' | 'watchPaper'>): string {
  return config.watchPaper.model ?? config.watch.models[0] ?? config.defaultModel
}

const DAY = 86_400

/** Calls an addition has made since UTC midnight: every row under its prompt, answered or not -- a
 * failing call is counted too, so that nothing can retry its way past the limit. */
export function additionCallsToday(rows: readonly Pick<AiCallRecord, 'at' | 'promptVersion'>[], kind: AiAdditionKind, nowSec: number): number {
  const midnight = Math.floor(nowSec / DAY) * DAY
  return rows.filter((row) => row.promptVersion === AI_ADDITION_PROMPT_VERSIONS[kind] && row.at >= midnight).length
}

/** Why an addition may not ask now, or null when it may. */
export function additionProblem(input: { kind: AiAdditionKind; additions: AiAdditionsConfig; watchOn: boolean; automatic: boolean; callsToday: number }): string | null {
  const { name } = AI_ADDITION_INFO[input.kind]
  if (!input.additions[input.kind]) return `The ${name.toLowerCase()} is switched off under Settings › AI.`
  if (input.automatic && !input.watchOn) return `The ${name.toLowerCase()} asks by itself only while the watch is on.`
  const limit = AI_ADDITION_DAILY_LIMITS[input.kind]
  if (input.callsToday >= limit) return `The ${name.toLowerCase()} has made its ${limit} calls today.`
  return null
}

// ---------------------------------------------------------------------------------------------
// The news analyst.

export const NEWS_READING_RELATIONSHIPS = ['DIRECT', 'INDIRECT', 'NONE'] as const
export const NEWS_READING_DIRECTIONS = ['up', 'down', 'none'] as const
export const NEWS_READING_HORIZONS = ['15m', '1h', '4h', '1d'] as const
export const NEWS_READING_MAX_REASONS = 300
/** Of a story's summary, at most this much is put to the analyst. */
export const NEWS_QUESTION_SUMMARY_CHARS = 600

export interface NewsReading {
  /** The coin the story concerns most, as Binance names it; null for none. */
  ticker: string | null
  relationship: (typeof NEWS_READING_RELATIONSHIPS)[number]
  direction: (typeof NEWS_READING_DIRECTIONS)[number]
  /** 0 to 100, whole. */
  impact: number
  horizon: (typeof NEWS_READING_HORIZONS)[number]
  /** 0 to 1: how consistent the story is with this reading. Not a probability. */
  confidence: number
  /** It had moved the price its way before it was read. */
  pricedIn: boolean
  reasons: string
}

/** What the analyst is shown: the story as it was read, and what the fixed rules made of it. */
export interface NewsQuestion {
  story: {
    id: string
    source: string
    title: string
    summary: string
    publishedAt: number
    kind: NewsEventType
    coins: { ticker: string; relationship: 'DIRECT' | 'INDIRECT' }[]
  }
}

export function newsQuestionOf(story: Pick<ReadStory, 'id' | 'sourceName' | 'title' | 'summary' | 'publishedAt' | 'eventType' | 'assets'>): NewsQuestion {
  return {
    story: {
      id: story.id,
      source: story.sourceName,
      title: story.title,
      summary: story.summary.slice(0, NEWS_QUESTION_SUMMARY_CHARS),
      publishedAt: story.publishedAt,
      kind: story.eventType,
      coins: story.assets.map((asset) => ({ ticker: asset.ticker, relationship: asset.relationship }))
    }
  }
}

const isOneOf = <T>(allowed: readonly T[], value: unknown): value is T => allowed.includes(value as T)

/** An analyst's answer, checked: every field in its shape and range, a coin named only with a
 * relationship to it, and none named with none. */
export function validateNewsReading(value: unknown): { ok: true; reading: NewsReading } | { ok: false; reason: string } {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null) as Record<string, unknown> | null
  if (raw === null) return { ok: false, reason: 'The answer was not an object.' }
  const ticker = raw.ticker
  if (ticker !== null && !(typeof ticker === 'string' && /^[A-Z0-9]{2,12}$/.test(ticker))) return { ok: false, reason: 'ticker is not a coin as Binance names it, or null.' }
  if (!isOneOf(NEWS_READING_RELATIONSHIPS, raw.relationship)) return { ok: false, reason: `relationship is not one of ${NEWS_READING_RELATIONSHIPS.join(', ')}.` }
  if ((ticker === null) !== (raw.relationship === 'NONE')) return { ok: false, reason: 'A coin is named with a relationship to it, and none with NONE.' }
  if (!isOneOf(NEWS_READING_DIRECTIONS, raw.direction)) return { ok: false, reason: `direction is not one of ${NEWS_READING_DIRECTIONS.join(', ')}.` }
  if (typeof raw.impact !== 'number' || !Number.isInteger(raw.impact) || raw.impact < 0 || raw.impact > 100) return { ok: false, reason: 'impact is not a whole number from 0 to 100.' }
  if (!isOneOf(NEWS_READING_HORIZONS, raw.horizon)) return { ok: false, reason: `horizon is not one of ${NEWS_READING_HORIZONS.join(', ')}.` }
  if (typeof raw.confidence !== 'number' || !(raw.confidence >= 0 && raw.confidence <= 1)) return { ok: false, reason: 'confidence is not from 0 to 1.' }
  if (typeof raw.pricedIn !== 'boolean') return { ok: false, reason: 'pricedIn is not true or false.' }
  if (typeof raw.reasons !== 'string' || raw.reasons.length > NEWS_READING_MAX_REASONS) return { ok: false, reason: `reasons is not text of at most ${NEWS_READING_MAX_REASONS} characters.` }
  return {
    ok: true,
    reading: {
      ticker: ticker as string | null,
      relationship: raw.relationship,
      direction: raw.direction,
      impact: raw.impact,
      horizon: raw.horizon,
      confidence: raw.confidence,
      pricedIn: raw.pricedIn,
      reasons: raw.reasons
    }
  }
}

/** The analyst's readings on file, by story id: the answered rows of its prompt, each checked again
 * on the way out. A refused answer reads as none. */
export function newsReadingsOf(rows: readonly Pick<AiCallRecord, 'promptVersion' | 'status' | 'subjectId' | 'additionAnswer'>[]): Record<string, NewsReading> {
  const out: Record<string, NewsReading> = {}
  for (const row of rows) {
    if (row.promptVersion !== AI_ADDITION_PROMPT_VERSIONS.news || row.status !== 'ok' || row.subjectId === undefined) continue
    const verdict = validateNewsReading(row.additionAnswer)
    if (verdict.ok) out[row.subjectId] = verdict.reading
  }
  return out
}

/** A reading in a line, for the news list. */
export function describeNewsReading(reading: NewsReading): string {
  const coin = reading.ticker === null ? 'no coin' : `${reading.ticker} (${reading.relationship === 'DIRECT' ? 'the subject' : 'mentioned'})`
  const way = reading.direction === 'none' ? 'no direction' : reading.direction
  return `${coin}, ${way}, impact ${reading.impact} over ${reading.horizon}, ${Math.round(reading.confidence * 100)}%${reading.pricedIn ? ', already priced in' : ''}`
}

// ---------------------------------------------------------------------------------------------
// The conclusion to "Why did it move?".

export const WHY_MAX_CONCLUSION = 400
export const WHY_MAX_CITES = 6

/** One item of evidence the fixed rules found: a story that names the coin, Bitcoin's share of the
 * move, or the volume. Its id is what a conclusion cites it by. */
export interface WhyEvidence {
  id: string
  kind: 'news' | 'market' | 'volume'
  text: string
}

/** What the conclusion is asked: the move as measured, the fixed rules' label, and the evidence. */
export interface WhyQuestion {
  pair: string
  windowMinutes: number
  movePct: number
  volumeRatio: number | null
  btcMovePct: number | null
  label: CauseLabel
  evidence: WhyEvidence[]
}

export interface WhyConclusion {
  conclusion: string
  /** The ids of the evidence it rests on: at least one, each one listed. */
  cites: string[]
  confidence: number
}

const round2 = (value: number | null): number | null => (value === null ? null : Math.round(value * 100) / 100)

/** The question for an explanation, or null when there is nothing to conclude: a move that could not
 * be read, one under half a percent, or one the rules found no evidence for. A conclusion with
 * nothing to cite would be a cause invented. */
export function whyQuestionOf(explanation: Pick<MoveExplanation, 'symbol' | 'windowMinutes' | 'movePct' | 'volumeRatio' | 'btcMovePct' | 'label' | 'causes'>, notablePct: number): WhyQuestion | null {
  if (explanation.movePct === null || Math.abs(explanation.movePct) < notablePct || explanation.causes.length === 0) return null
  return {
    pair: explanation.symbol,
    windowMinutes: explanation.windowMinutes,
    movePct: round2(explanation.movePct) as number,
    volumeRatio: round2(explanation.volumeRatio),
    btcMovePct: round2(explanation.btcMovePct),
    label: explanation.label,
    evidence: explanation.causes.map((cause, index) => ({
      id: cause.kind === 'news' && cause.storyId !== undefined ? `story:${cause.storyId}` : cause.kind === 'news' ? `news:${index}` : cause.kind,
      kind: cause.kind,
      text: cause.text
    }))
  }
}

/** A conclusion, checked: text of a sensible length, and every citation one of the listed items. One
 * that cites nothing, or anything not listed, is dropped. */
export function validateWhyConclusion(value: unknown, question: Pick<WhyQuestion, 'evidence'>): { ok: true; conclusion: WhyConclusion } | { ok: false; reason: string } {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null) as Record<string, unknown> | null
  if (raw === null) return { ok: false, reason: 'The answer was not an object.' }
  if (typeof raw.conclusion !== 'string' || raw.conclusion.trim() === '' || raw.conclusion.length > WHY_MAX_CONCLUSION) {
    return { ok: false, reason: `conclusion is not text of 1 to ${WHY_MAX_CONCLUSION} characters.` }
  }
  if (!Array.isArray(raw.cites) || raw.cites.length === 0 || raw.cites.length > WHY_MAX_CITES) return { ok: false, reason: `cites does not list 1 to ${WHY_MAX_CITES} items.` }
  const listed = new Set(question.evidence.map((item) => item.id))
  const unknown = raw.cites.find((cite) => typeof cite !== 'string' || !listed.has(cite))
  if (unknown !== undefined) return { ok: false, reason: `It cites ${JSON.stringify(unknown)}, which is not one of the evidence listed.` }
  if (typeof raw.confidence !== 'number' || !(raw.confidence >= 0 && raw.confidence <= 1)) return { ok: false, reason: 'confidence is not from 0 to 1.' }
  return { ok: true, conclusion: { conclusion: raw.conclusion.trim(), cites: [...new Set(raw.cites as string[])], confidence: raw.confidence } }
}

/** A conclusion on file, as the Why window shows it: what it said, when, and the question it answered. */
export interface WhyOnFile {
  at: number
  model: string
  conclusion: WhyConclusion
}

/** The newest conclusion on file for a pair, from the ledger rows of its prompt; null for none. */
export function latestWhyOf(rows: readonly Pick<AiCallRecord, 'promptVersion' | 'status' | 'symbol' | 'at' | 'model' | 'additionAnswer'>[], symbol: string): WhyOnFile | null {
  let newest: WhyOnFile | null = null
  for (const row of rows) {
    if (row.promptVersion !== AI_ADDITION_PROMPT_VERSIONS.why || row.status !== 'ok' || row.symbol !== symbol) continue
    const answer = row.additionAnswer as Partial<WhyConclusion> | undefined
    if (answer === undefined || typeof answer.conclusion !== 'string' || !Array.isArray(answer.cites) || typeof answer.confidence !== 'number') continue
    if (newest === null || row.at > newest.at) newest = { at: row.at, model: row.model, conclusion: { conclusion: answer.conclusion, cites: answer.cites.filter((cite): cite is string => typeof cite === 'string'), confidence: answer.confidence } }
  }
  return newest
}

/** "Why did it move?" with the conclusion (the main process's concludeMove). */
export interface MoveConclusion {
  /** The fixed rules' explanation, from the minutes and stories read in the main process. */
  explanation: MoveExplanation
  /** What the conclusion was asked; null when there was nothing to conclude. */
  question: WhyQuestion | null
  /** Null when nothing was asked. */
  outcome: AiAdditionOutcome<WhyConclusion> | null
}
