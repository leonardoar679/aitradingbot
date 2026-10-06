import type { AiConfig } from './aiCost'
import type { AiCallRecord } from './aiLedger'
import type { AiSignalDecision } from './aiSignal'
import type { MarketEvent } from './marketEvent'
import type { CauseLabel, MoveExplanation } from './moveExplanation'
import type { NewsEventType, ReadStory } from './newsFeed'

// THE AI ADDITIONS (the V3 engine plan's Stage 7): small questions put to a model beside the watch's.
// The news analyst reads each story of high impact once; the conclusion to "Why did it move?" weighs
// the evidence the fixed rules found, and must cite what it rests on; the reviewer takes a second
// look before one of the watch's paper trades, when something about it stands out, and REJECT means
// no trade.
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

export const AI_ADDITION_KINDS = ['news', 'why', 'review'] as const
export type AiAdditionKind = (typeof AI_ADDITION_KINDS)[number]

/** Calls a day each may make, at most: the plan's limits, chosen with the user's $5 day. */
export const AI_ADDITION_DAILY_LIMITS: Record<AiAdditionKind, number> = { news: 40, why: 20, review: 20 }

/** Each addition's question and answer, versioned as every prompt here is: part of the cache key and
 * of every ledger row, and pinned by a hash (tests/aiAdditions.test.ts). */
export const AI_ADDITION_PROMPT_VERSIONS: Record<AiAdditionKind, string> = { news: 'news-analyst-v1', why: 'why-conclusion-v1', review: 'reviewer-v1' }
export const AI_ADDITION_SCHEMA_VERSIONS: Record<AiAdditionKind, string> = { news: 'news-reading-v1', why: 'why-conclusion-v1', review: 'review-verdict-v1' }

export const AI_ADDITION_INFO: Record<AiAdditionKind, { name: string; what: string; automatic: boolean }> = {
  news: {
    name: 'News analyst',
    what: "Reads each story of high impact once, as it arrives: which coin it concerns, which way it points, how much and for how long, and whether it is already in the price. Shown on Discovery's news, and weighed in the news part of the signal score.",
    automatic: true
  },
  why: {
    name: '"Why did it move?" conclusion',
    what: 'Weighs the evidence the fixed rules found for a move (the stories that name the coin, Bitcoin, the volume) and concludes, citing each item it rests on, or it is dropped. On a click in the Why window, at the price shown; and by itself for a coin a story of high impact names.',
    automatic: true
  },
  review: {
    name: 'Reviewer',
    what: "A second look before one of the watch's paper trades, only when the models disagree, the move is unusually large, major news hit the coin or the pair is thin. REJECT means no trade; a review that cannot be had leaves the trade as it was.",
    automatic: true
  }
}

/** On or off, each. Only `false` switches one off: on 6 October 2026 the user chose them on. */
export type AiAdditionsConfig = Record<AiAdditionKind, boolean>
export const DEFAULT_AI_ADDITIONS: AiAdditionsConfig = { news: true, why: true, review: true }

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

// ---------------------------------------------------------------------------------------------
// The reviewer.

/** When a trade stands out enough for a second look. Fixed lines, written down before any result. */
export const REVIEW_LINES = {
  /** A fifteen-minute move this large, either way... */
  largeMovePct: 5,
  /** ...or this many of the pair's usual moves, is unusually large. */
  largeMoveSigmas: 8,
  /** A story of this impact or more on the coin, in the hours before, is major news. */
  majorNewsImpact: 70,
  majorNewsSeconds: 3 * 3600,
  /** A pair trading less than this a day, or quoted wider than this, is thin. */
  thinQuoteVolume: 5_000_000,
  wideSpreadPct: 0.05
} as const

export const REVIEW_TRIGGERS = ['models_disagree', 'large_move', 'major_news', 'thin_pair'] as const
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number]
export const REVIEW_VERDICTS = ['APPROVE', 'REJECT'] as const
export const REVIEW_MAX_REASON = 300

export function describeReviewTrigger(trigger: ReviewTrigger): string {
  const words: Record<ReviewTrigger, string> = {
    models_disagree: 'the models disagree',
    large_move: 'the move is unusually large',
    major_news: 'major news hit the coin',
    thin_pair: 'the pair is thin'
  }
  return words[trigger]
}

type ReviewEvent = Pick<MarketEvent, 'id' | 'symbol' | 'baseAsset' | 'time' | 'type' | 'direction' | 'score' | 'returnsPct' | 'moveSigmas' | 'volumeRatio' | 'price' | 'live' | 'news'>

/** Another model's call on the same event, as the reviewer is told it. */
export interface ReviewOther {
  model: string
  side: 'long' | 'short' | null
  confidence: number
  refused: boolean
}

/** Why a trade stands out, if it does: none, and no second look is asked. Only answers on file when
 * the trade would open can disagree with it. */
export function reviewTriggers(input: {
  event: Pick<ReviewEvent, 'returnsPct' | 'moveSigmas' | 'live' | 'baseAsset' | 'time' | 'news'>
  side: 'long' | 'short'
  others: readonly Pick<ReviewOther, 'side'>[]
  stories: readonly Pick<ReadStory, 'assets' | 'impact' | 'publishedAt' | 'stale'>[]
  nowSec: number
}): ReviewTrigger[] {
  const { event } = input
  const out: ReviewTrigger[] = []
  if (input.others.some((other) => other.side !== null && other.side !== input.side)) out.push('models_disagree')
  if (Math.abs(event.returnsPct.m15) >= REVIEW_LINES.largeMovePct || Math.abs(event.moveSigmas) >= REVIEW_LINES.largeMoveSigmas) out.push('large_move')
  const major = input.stories.some(
    (story) =>
      !story.stale &&
      story.impact >= REVIEW_LINES.majorNewsImpact &&
      story.publishedAt >= event.time - REVIEW_LINES.majorNewsSeconds &&
      story.publishedAt <= input.nowSec &&
      story.assets.some((asset) => asset.ticker === event.baseAsset)
  )
  if (event.news !== undefined || major) out.push('major_news')
  const volume = event.live?.quoteVolume24h ?? null
  const spread = event.live?.spreadPct ?? null
  if ((volume !== null && volume < REVIEW_LINES.thinQuoteVolume) || (spread !== null && spread > REVIEW_LINES.wideSpreadPct)) out.push('thin_pair')
  return out
}

/** The call under review, from the answer the watch's paper trades follow. */
export interface ReviewCall {
  model: string
  side: 'long' | 'short'
  confidence: number
  entryMin: number
  entryMax: number
  stopLoss: number | null
  takeProfit: number | null
  rationale: string
}

/** What the reviewer is asked: the event, the call, the other calls on file, the major news, and why. */
export interface ReviewQuestion {
  event: {
    pair: string
    kind: string
    direction: string
    score: number
    movePct15m: number
    moveSigmas: number
    volumeRatio: number | null
    quoteVolume24h: number | null
    spreadPct: number | null
    announcement: string | null
  }
  call: ReviewCall
  others: { model: string; call: 'BUY' | 'SELL' | 'NO TRADE' | 'REFUSED'; confidence: number }[]
  news: { title: string; source: string; kind: NewsEventType; impact: number }[]
  triggers: ReviewTrigger[]
}

export interface ReviewVerdict {
  verdict: (typeof REVIEW_VERDICTS)[number]
  confidence: number
  reason: string
}

/** What a second look came to: whether one was asked, why, and what came of it. */
export interface TradeReview {
  asked: boolean
  triggers: ReviewTrigger[]
  outcome: AiAdditionOutcome<ReviewVerdict> | null
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A review request as it arrives over the bridge, read as one: the event and the call, each field in
 * its shape, or null. */
export function parseReviewRequest(value: unknown): { event: ReviewEvent; call: ReviewCall } | null {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as { event?: Partial<ReviewEvent>; decision?: Partial<AiSignalDecision> }
  const event = raw.event
  const decision = raw.decision
  if (event === undefined || decision === undefined || event === null || decision === null) return null
  if (typeof event.id !== 'string' || typeof event.symbol !== 'string' || !/^[A-Z0-9]{2,20}$/.test(event.symbol) || typeof event.baseAsset !== 'string') return null
  if (!finite(event.time) || typeof event.type !== 'string' || typeof event.direction !== 'string' || !finite(event.score) || !finite(event.moveSigmas) || !finite(event.price)) return null
  if (event.returnsPct === undefined || event.returnsPct === null || !finite(event.returnsPct.m15)) return null
  if (event.volumeRatio !== null && !finite(event.volumeRatio)) return null
  const live = event.live ?? null
  if (live !== null && ((live.quoteVolume24h !== null && !finite(live.quoteVolume24h)) || (live.spreadPct !== null && !finite(live.spreadPct)))) return null
  const entry = decision.detail?.entry
  if (typeof decision.model !== 'string' || (decision.recommendation !== 'buy' && decision.recommendation !== 'sell') || !finite(decision.confidence)) return null
  if (entry === undefined || entry === null || !finite(entry.min) || !finite(entry.max)) return null
  const stop = decision.detail?.stopLoss ?? null
  const target = decision.detail?.takeProfit ?? null
  if ((stop !== null && !finite(stop)) || (target !== null && !finite(target))) return null
  return {
    event: {
      id: event.id,
      symbol: event.symbol,
      baseAsset: event.baseAsset,
      time: event.time,
      type: event.type,
      direction: event.direction,
      score: event.score,
      returnsPct: event.returnsPct,
      moveSigmas: event.moveSigmas,
      volumeRatio: event.volumeRatio ?? null,
      price: event.price,
      live,
      ...(event.news !== undefined && event.news !== null ? { news: event.news } : {})
    } as ReviewEvent,
    call: {
      model: decision.model,
      side: decision.recommendation === 'buy' ? 'long' : 'short',
      confidence: decision.confidence,
      entryMin: entry.min,
      entryMax: entry.max,
      stopLoss: stop,
      takeProfit: target,
      rationale: typeof decision.rationale === 'string' ? decision.rationale.slice(0, 500) : ''
    }
  }
}

const round = (value: number | null, places = 4): number | null => (value === null ? null : Number(value.toPrecision(places + 2)))

/** The reviewer's question. */
export function reviewQuestionOf(input: {
  event: ReviewEvent
  call: ReviewCall
  others: readonly ReviewOther[]
  stories: readonly Pick<ReadStory, 'title' | 'sourceName' | 'eventType' | 'impact' | 'assets' | 'publishedAt' | 'stale'>[]
  triggers: ReviewTrigger[]
  nowSec: number
}): ReviewQuestion {
  const { event } = input
  return {
    event: {
      pair: event.symbol,
      kind: event.type,
      direction: event.direction,
      score: Math.round(event.score),
      movePct15m: round(event.returnsPct.m15) as number,
      moveSigmas: round(event.moveSigmas) as number,
      volumeRatio: round(event.volumeRatio),
      quoteVolume24h: event.live?.quoteVolume24h ?? null,
      spreadPct: round(event.live?.spreadPct ?? null),
      announcement: event.news?.title ?? null
    },
    call: input.call,
    others: input.others.map((other) => ({
      model: other.model,
      call: other.refused ? 'REFUSED' : other.side === 'long' ? 'BUY' : other.side === 'short' ? 'SELL' : 'NO TRADE',
      confidence: other.confidence
    })),
    news: input.stories
      .filter(
        (story) =>
          !story.stale &&
          story.impact >= REVIEW_LINES.majorNewsImpact &&
          story.publishedAt >= event.time - REVIEW_LINES.majorNewsSeconds &&
          story.publishedAt <= input.nowSec &&
          story.assets.some((asset) => asset.ticker === event.baseAsset)
      )
      .slice(0, 5)
      .map((story) => ({ title: story.title, source: story.sourceName, kind: story.eventType, impact: story.impact })),
    triggers: input.triggers
  }
}

/** A reviewer's answer, checked. */
export function validateReviewVerdict(value: unknown): { ok: true; verdict: ReviewVerdict } | { ok: false; reason: string } {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null) as Record<string, unknown> | null
  if (raw === null) return { ok: false, reason: 'The answer was not an object.' }
  if (!isOneOf(REVIEW_VERDICTS, raw.verdict)) return { ok: false, reason: `verdict is not one of ${REVIEW_VERDICTS.join(', ')}.` }
  if (typeof raw.confidence !== 'number' || !(raw.confidence >= 0 && raw.confidence <= 1)) return { ok: false, reason: 'confidence is not from 0 to 1.' }
  if (typeof raw.reason !== 'string' || raw.reason.trim() === '' || raw.reason.length > REVIEW_MAX_REASON) return { ok: false, reason: `reason is not text of 1 to ${REVIEW_MAX_REASON} characters.` }
  return { ok: true, verdict: { verdict: raw.verdict, confidence: raw.confidence, reason: raw.reason.trim() } }
}

/** Why a reviewed trade is not opened, or null: only a REJECT the reviewer gave stops one. A review
 * that was not asked, was refused, or failed leaves the trade as it was. */
export function reviewRefusal(review: TradeReview | null): string | null {
  if (review === null || review.outcome === null || review.outcome.status !== 'answered' || review.outcome.answer.verdict !== 'REJECT') return null
  return `The reviewer rejected it (${review.triggers.map(describeReviewTrigger).join(', ')}): ${review.outcome.answer.reason}`
}

/** The reviewer's verdicts on file, by event id: answered rows of its prompt, checked again. */
export function reviewsOf(rows: readonly Pick<AiCallRecord, 'promptVersion' | 'status' | 'subjectId' | 'additionAnswer'>[]): Record<string, ReviewVerdict> {
  const out: Record<string, ReviewVerdict> = {}
  for (const row of rows) {
    if (row.promptVersion !== AI_ADDITION_PROMPT_VERSIONS.review || row.status !== 'ok' || row.subjectId === undefined) continue
    const verdict = validateReviewVerdict(row.additionAnswer)
    if (verdict.ok) out[row.subjectId] = verdict.verdict
  }
  return out
}
