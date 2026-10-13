import type { AiConfig } from './aiCost'
import type { AiCallRecord } from './aiLedger'
import type { AiSignalDecision } from './aiSignal'
import type { ExecutorConfig, PositionExecutorParams } from './ipc'
import type { MarketEvent } from './marketEvent'
import type { MarketRegime } from './marketResearch'
import type { CauseLabel, MoveExplanation } from './moveExplanation'
import type { NewsEventType, ReadStory } from './newsFeed'

// THE AI ADDITIONS (the V3 engine plan's Stage 7): small questions put to a model beside the watch's.
// The news analyst reads each story of high impact once; the conclusion to "Why did it move?" weighs
// the evidence the fixed rules found, and must cite what it rests on; the exit check looks again at
// one of the app's own open paper trades when something has changed, and its EXIT closes that paper
// trade at the next minute; the reviewer takes a second look before one of the watch's paper trades,
// when something about it stands out, and REJECT means no trade.
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
// nowhere. Two can only ever do less: the reviewer's REJECT opens no paper trade, and the exit
// check's EXIT closes one of the app's own paper trades sooner than its plan would have -- never a
// live one, and it never moves a stop or makes a trade longer (shared/aiExit.ts).

export const AI_ADDITION_KINDS = ['news', 'why', 'exit', 'review', 'daily'] as const
export type AiAdditionKind = (typeof AI_ADDITION_KINDS)[number]

/** Calls a day each may make, at most: the plan's limits, chosen with the user's $5 day. */
export const AI_ADDITION_DAILY_LIMITS: Record<AiAdditionKind, number> = { news: 40, why: 20, exit: 30, review: 20, daily: 1 }

/** Each addition's question and answer, versioned as every prompt here is: part of the cache key and
 * of every ledger row, and pinned by a hash (tests/aiAdditions.test.ts). */
export const AI_ADDITION_PROMPT_VERSIONS: Record<AiAdditionKind, string> = {
  news: 'news-analyst-v1',
  why: 'why-conclusion-v1',
  exit: 'exit-check-v1',
  review: 'reviewer-v1',
  daily: 'daily-summary-v1'
}
export const AI_ADDITION_SCHEMA_VERSIONS: Record<AiAdditionKind, string> = {
  news: 'news-reading-v1',
  why: 'why-conclusion-v1',
  exit: 'exit-verdict-v1',
  review: 'review-verdict-v1',
  daily: 'daily-summary-v1'
}

export const AI_ADDITION_INFO: Record<AiAdditionKind, { name: string; what: string; automatic: boolean }> = {
  news: {
    name: 'News analyst',
    what: "Reads each story of high impact once, as it arrives: which coin it concerns, which way it points, how much and for how long, and whether it is already in the price. Shown on Explorer's news, and weighed in the news part of the signal score.",
    automatic: true
  },
  why: {
    name: '"Why did it move?" conclusion',
    what: 'Weighs the evidence the fixed rules found for a move (the stories that name the coin, Bitcoin, the volume) and concludes, citing each item it rests on, or it is dropped. On a click in the Why window, at the price shown; and by itself for a coin a story of high impact names.',
    automatic: true
  },
  exit: {
    name: 'Exit check',
    what: "Looks again at one of the app's own open paper trades when something has changed: it is near its target or its stop, there is news on the coin, the market's regime has changed, or the price moved sharply against it; once a trade for each. EXIT closes the paper trade at the next minute; REDUCE is recorded only. It never moves a stop, never makes a trade longer, and never touches a live position.",
    automatic: true
  },
  review: {
    name: 'Reviewer',
    what: "A second look before one of the watch's paper trades, only when the models disagree, the move is unusually large, major news hit the coin or the pair is thin. REJECT means no trade; a review that cannot be had leaves the trade as it was.",
    automatic: true
  },
  daily: {
    name: 'Daily summary',
    what: "One paragraph about the day before, written from the daily report's figures on Performance: the market, the major news, the app's own paper trades, the models' standing and the risk condition. Asked once a day after 00:05 UTC by itself while the watch is on, or from the report on a click; held to one call a day. It writes about figures and recommends nothing.",
    automatic: true
  }
}

/** On or off, each. Only `false` switches one off: on 6 October 2026 the user chose them on. */
export type AiAdditionsConfig = Record<AiAdditionKind, boolean>
export const DEFAULT_AI_ADDITIONS: AiAdditionsConfig = { news: true, why: true, exit: true, review: true, daily: true }

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
  if (input.callsToday >= limit) return `The ${name.toLowerCase()} has made ${limit === 1 ? 'its one call' : `its ${limit} calls`} today.`
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

// ---------------------------------------------------------------------------------------------
// The exit check.

/** When one of the app's own open paper trades is looked at again. Fixed lines, written down before
 * any result. */
export const EXIT_LINES = {
  /** Of the way from its entry to its target, or to its stop, this much covered is near it. */
  nearShare: 0.75,
  /** A move against the trade this large over the pair's last fifteen closed minutes, in percent, is
   * sharp. */
  oppositeMovePct: 2,
  /** A story of this impact or more naming the coin, published since the trade was opened, is news on
   * it: the reviewer's line for major news. */
  newsImpact: REVIEW_LINES.majorNewsImpact,
  /** A price older than this is not shown to it: the trade is not where it would say. */
  priceMaxAgeSeconds: 300
} as const

export const EXIT_TRIGGERS = ['near_target', 'near_stop', 'news', 'regime_change', 'opposite_move'] as const
export type ExitTrigger = (typeof EXIT_TRIGGERS)[number]
export const EXIT_VERDICTS = ['KEEP', 'REDUCE', 'EXIT'] as const
export const EXIT_MAX_REASON = 300
/** Of the call or the announcement a trade was opened on, at most this much is shown. */
export const EXIT_THESIS_CHARS = 300

export function describeExitTrigger(trigger: ExitTrigger): string {
  const words: Record<ExitTrigger, string> = {
    near_target: 'it is near its target',
    near_stop: 'it is near its stop',
    news: 'news on the coin',
    regime_change: "the market's regime changed",
    opposite_move: 'a sharp move against it'
  }
  return words[trigger]
}

/** One of the app's own open paper trades, as the exit check reads it from the executors on file. */
export interface ExitTrade {
  id: string
  symbol: string
  baseAsset: string
  side: 'buy' | 'sell'
  createdAt: number
  stopLossPct: number | null
  takeProfitPct: number | null
  timeLimitSec: number
  /** What opened it: the watch on a model's call, or a news rule on Binance's announcement. */
  origin: { kind: 'watch'; eventId: string; eventTime: number; model: string } | { kind: 'news'; category: 'DELISTING' | 'MONITORING_TAG'; title: string }
}

/** The trade an exit check may be asked about, read from the executor on file; or why not. Only the
 * app's own paper positions that are still open, have a time limit for an EXIT to bring forward,
 * and have not been closed by one already. A live executor is never one, whatever it carries. */
export function exitTradeOf(executor: ExecutorConfig): { ok: true; trade: ExitTrade } | { ok: false; reason: string } {
  if (executor.mode !== 'paper' || executor.type !== 'position') return { ok: false, reason: 'it is not a paper position.' }
  const mark = executor.watch ?? executor.newsRule
  if (mark === undefined) return { ok: false, reason: 'it was not opened by the watch or a news rule.' }
  if (executor.status !== 'active') return { ok: false, reason: 'it has been stopped.' }
  if (mark.aiExit !== undefined) return { ok: false, reason: 'the exit check has closed it already.' }
  const params = executor.params as PositionExecutorParams
  if (params.timeLimitSec === null || !(params.timeLimitSec > 0)) return { ok: false, reason: 'it has no time limit for an EXIT to bring forward.' }
  return {
    ok: true,
    trade: {
      id: executor.id,
      symbol: executor.symbol,
      baseAsset: executor.baseAsset,
      side: params.side,
      createdAt: executor.createdAt,
      stopLossPct: params.stopLossPct,
      takeProfitPct: params.takeProfitPct,
      timeLimitSec: params.timeLimitSec,
      origin:
        executor.watch !== undefined
          ? { kind: 'watch', eventId: executor.watch.eventId, eventTime: executor.watch.eventTime, model: executor.watch.model }
          : { kind: 'news', category: executor.newsRule?.category ?? 'DELISTING', title: executor.newsRule?.title ?? '' }
    }
  }
}

/** What the renderer measures of a trade that the main process cannot: where the engine says it
 * entered (src/executors/engine.ts runs there), the last closed minute, the pair's last fifteen
 * minutes, and the market's regime by Bitcoin's minutes (shared/marketResearch.ts) when it entered
 * and now. The trade itself -- its side, its levels, its time limit, what opened it -- is read in
 * the main process from the executors on file, never taken from here. */
export interface ExitCheckRequest {
  executorId: string
  entryPrice: number
  enteredAt: number
  /** The last closed minute: its time, and its close. */
  priceTime: number
  price: number
  /** The pair's move over its last fifteen closed minutes, in percent; null when they are not all there. */
  move15mPct: number | null
  regimeAtEntry: MarketRegime | null
  regimeNow: MarketRegime | null
}

const MARKET_REGIMES: readonly MarketRegime[] = ['panic', 'high-vol', 'recovery', 'bull', 'bear', 'sideways']

/** A request as it arrives over the bridge, read as one: each field in its shape, or null. */
export function parseExitCheckRequest(value: unknown): ExitCheckRequest | null {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null) as Record<string, unknown> | null
  if (raw === null) return null
  const { executorId, entryPrice, enteredAt, priceTime, price, move15mPct, regimeAtEntry, regimeNow } = raw
  // The id is the first part of what a check is filed under, before a colon.
  if (typeof executorId !== 'string' || !/^[\w-]{1,100}$/.test(executorId)) return null
  if (!finite(entryPrice) || entryPrice <= 0 || !finite(price) || price <= 0) return null
  if (!finite(enteredAt) || !finite(priceTime) || enteredAt % 60 !== 0 || priceTime % 60 !== 0 || enteredAt > priceTime) return null
  if (move15mPct !== null && !finite(move15mPct)) return null
  const regime = (x: unknown): x is MarketRegime | null => x === null || MARKET_REGIMES.includes(x as MarketRegime)
  if (!regime(regimeAtEntry) || !regime(regimeNow)) return null
  return { executorId, entryPrice, enteredAt, priceTime, price, move15mPct, regimeAtEntry, regimeNow }
}

/** A trade's gain so far in its own favour, in percent of its entry: positive when it is ahead. */
export function exitGainPct(side: 'buy' | 'sell', entryPrice: number, price: number): number {
  return side === 'buy' ? (price / entryPrice - 1) * 100 : (1 - price / entryPrice) * 100
}

/** The stories that are news on a trade's coin: of high impact, naming it, published since the trade
 * was opened. */
export function exitNewsOf<S extends Pick<ReadStory, 'assets' | 'impact' | 'publishedAt' | 'stale'>>(stories: readonly S[], baseAsset: string, sinceSec: number, nowSec: number): S[] {
  return stories.filter(
    (story) =>
      !story.stale &&
      story.impact >= EXIT_LINES.newsImpact &&
      story.publishedAt > sinceSec &&
      story.publishedAt <= nowSec &&
      story.assets.some((asset) => asset.ticker === baseAsset)
  )
}

/** Why a trade is looked at again now, if it is: none, and nothing is asked. */
export function exitTriggers(input: {
  trade: Pick<ExitTrade, 'side' | 'stopLossPct' | 'takeProfitPct' | 'baseAsset' | 'createdAt'>
  request: Pick<ExitCheckRequest, 'entryPrice' | 'price' | 'move15mPct' | 'regimeAtEntry' | 'regimeNow'>
  stories: readonly Pick<ReadStory, 'assets' | 'impact' | 'publishedAt' | 'stale'>[]
  nowSec: number
}): ExitTrigger[] {
  const { trade, request } = input
  const gain = exitGainPct(trade.side, request.entryPrice, request.price)
  const out: ExitTrigger[] = []
  if (trade.takeProfitPct !== null && trade.takeProfitPct > 0 && gain >= EXIT_LINES.nearShare * trade.takeProfitPct) out.push('near_target')
  if (trade.stopLossPct !== null && trade.stopLossPct > 0 && -gain >= EXIT_LINES.nearShare * trade.stopLossPct) out.push('near_stop')
  if (exitNewsOf(input.stories, trade.baseAsset, trade.createdAt, input.nowSec).length > 0) out.push('news')
  if (request.regimeAtEntry !== null && request.regimeNow !== null && request.regimeAtEntry !== request.regimeNow) out.push('regime_change')
  const against = request.move15mPct === null ? null : trade.side === 'buy' ? -request.move15mPct : request.move15mPct
  if (against !== null && against >= EXIT_LINES.oppositeMovePct) out.push('opposite_move')
  return out
}

/** What a check is filed under in the ledger: the trade, and the reasons it was asked for. */
export function exitSubjectId(executorId: string, triggers: readonly ExitTrigger[]): string {
  return `${executorId}:${triggers.join('+')}`
}

/** The reasons the exit check has been asked about a trade for already, from the ledger's rows of its
 * prompt: one ask a trade and a reason, whatever came of it -- answered, refused or failed. */
export function exitTriggersAsked(rows: readonly Pick<AiCallRecord, 'promptVersion' | 'subjectId'>[], executorId: string): Set<ExitTrigger> {
  const asked = new Set<ExitTrigger>()
  for (const row of rows) {
    if (row.promptVersion !== AI_ADDITION_PROMPT_VERSIONS.exit || row.subjectId === undefined || !row.subjectId.startsWith(`${executorId}:`)) continue
    for (const part of row.subjectId.slice(executorId.length + 1).split('+')) if (isOneOf(EXIT_TRIGGERS, part)) asked.add(part)
  }
  return asked
}

/** What the exit check is asked: the trade and its plan, where it stands, the news since it was
 * opened, and why it is asked. */
export interface ExitQuestion {
  trade: {
    pair: string
    side: 'long' | 'short'
    openedBy: string
    /** What it was opened on: the call's reasoning, or the announcement. */
    thesis: string
    entryPrice: number
    minutesOpen: number
    /** Its stop and its target, as distances from the entry in percent; null for none. */
    stopPct: number | null
    targetPct: number | null
    /** Until its time limit closes it. */
    minutesLeft: number
  }
  now: {
    price: number
    /** In the trade's favour, in percent of its entry. */
    gainPct: number
    move15mPct: number | null
    regimeAtEntry: MarketRegime | null
    regimeNow: MarketRegime | null
  }
  news: { title: string; source: string; kind: NewsEventType; impact: number; minutesAgo: number }[]
  triggers: ExitTrigger[]
}

/** The exit check's question. */
export function exitQuestionOf(input: {
  trade: ExitTrade
  request: ExitCheckRequest
  thesis: string
  stories: readonly Pick<ReadStory, 'title' | 'sourceName' | 'eventType' | 'impact' | 'assets' | 'publishedAt' | 'stale'>[]
  triggers: ExitTrigger[]
  nowSec: number
}): ExitQuestion {
  const { trade, request, nowSec } = input
  const { origin } = trade
  return {
    trade: {
      pair: trade.symbol,
      side: trade.side === 'buy' ? 'long' : 'short',
      openedBy:
        origin.kind === 'watch'
          ? `the watch, following ${origin.model}'s call on a market event`
          : `the ${origin.category === 'MONITORING_TAG' ? 'Monitoring Tag' : 'delisting'} rule, on Binance's announcement`,
      thesis: input.thesis.slice(0, EXIT_THESIS_CHARS),
      entryPrice: round(request.entryPrice, 6) as number,
      minutesOpen: Math.max(0, Math.round((nowSec - request.enteredAt) / 60)),
      stopPct: round(trade.stopLossPct),
      targetPct: round(trade.takeProfitPct),
      minutesLeft: Math.max(0, Math.round((request.enteredAt + trade.timeLimitSec - nowSec) / 60))
    },
    now: {
      price: round(request.price, 6) as number,
      gainPct: round(exitGainPct(trade.side, request.entryPrice, request.price)) as number,
      move15mPct: round(request.move15mPct),
      regimeAtEntry: request.regimeAtEntry,
      regimeNow: request.regimeNow
    },
    news: exitNewsOf(input.stories, trade.baseAsset, trade.createdAt, nowSec)
      .slice(0, 5)
      .map((story) => ({ title: story.title, source: story.sourceName, kind: story.eventType, impact: story.impact, minutesAgo: Math.round((nowSec - story.publishedAt) / 60) })),
    triggers: input.triggers
  }
}

export interface ExitVerdict {
  verdict: (typeof EXIT_VERDICTS)[number]
  confidence: number
  reason: string
}

/** An exit check's answer, checked. */
export function validateExitVerdict(value: unknown): { ok: true; verdict: ExitVerdict } | { ok: false; reason: string } {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null) as Record<string, unknown> | null
  if (raw === null) return { ok: false, reason: 'The answer was not an object.' }
  if (!isOneOf(EXIT_VERDICTS, raw.verdict)) return { ok: false, reason: `verdict is not one of ${EXIT_VERDICTS.join(', ')}.` }
  if (typeof raw.confidence !== 'number' || !(raw.confidence >= 0 && raw.confidence <= 1)) return { ok: false, reason: 'confidence is not from 0 to 1.' }
  if (typeof raw.reason !== 'string' || raw.reason.trim() === '' || raw.reason.length > EXIT_MAX_REASON) return { ok: false, reason: `reason is not text of 1 to ${EXIT_MAX_REASON} characters.` }
  return { ok: true, verdict: { verdict: raw.verdict, confidence: raw.confidence, reason: raw.reason.trim() } }
}

/** What looking at a trade again came to: whether the check was asked, why, and what came of it. */
export interface ExitCheck {
  asked: boolean
  triggers: ExitTrigger[]
  outcome: AiAdditionOutcome<ExitVerdict> | null
}

/** The EXIT to act on, or null: only an answered EXIT closes a trade. KEEP, REDUCE, and a check that
 * was not asked, was refused or failed leave the trade to its own plan. */
export function exitOrderOf(check: ExitCheck | null): { model: string; triggers: ExitTrigger[]; confidence: number; reason: string } | null {
  if (check === null || check.outcome === null || check.outcome.status !== 'answered' || check.outcome.answer.verdict !== 'EXIT') return null
  return { model: check.outcome.model, triggers: [...check.triggers], confidence: check.outcome.answer.confidence, reason: check.outcome.answer.reason }
}

/** The exit check's answers on file, as they are listed: the answered rows of its prompt, each
 * checked again, with the trade each was about. */
export function exitVerdictsOf(rows: readonly Pick<AiCallRecord, 'promptVersion' | 'status' | 'subjectId' | 'additionAnswer' | 'at'>[]): { executorId: string; at: number; verdict: ExitVerdict }[] {
  const out: { executorId: string; at: number; verdict: ExitVerdict }[] = []
  for (const row of rows) {
    if (row.promptVersion !== AI_ADDITION_PROMPT_VERSIONS.exit || row.status !== 'ok' || row.subjectId === undefined) continue
    const checked = validateExitVerdict(row.additionAnswer)
    const cut = row.subjectId.lastIndexOf(':')
    if (checked.ok && cut > 0) out.push({ executorId: row.subjectId.slice(0, cut), at: row.at, verdict: checked.verdict })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The daily summary (the V4 document, §87; the user's choice of 7 October 2026: one AI-written
// paragraph a day, on by default inside the $5 day). The question is the daily report's figures
// (shared/dailyReport.ts dailySummaryQuestionOf), bounded; the answer is a paragraph and a
// confidence. It is asked once a day about the day before, after 00:05 UTC while the watch is on
// (src/performance/dailySummary.ts), or from the report on a click.

export const DAILY_SUMMARY_MAX_CHARS = 900
export const DAILY_SUMMARY_MIN_CHARS = 20
/** Characters a text in the question is cut to: a title, a reason, a model's name. */
export const DAILY_SUMMARY_TEXT_CHARS = 200
/** The most rows each list of the question may carry. */
export const DAILY_SUMMARY_MAX_ROWS = { movers: 5, news: 8, tickers: 5, net: 10, refused: 6, models: 6 } as const

export interface DailySummaryQuestion {
  /** The UTC day, `YYYY-MM-DD`. */
  day: string
  market: {
    regime: string | null
    btcDayPct: number | null
    ethDayPct: number | null
    breadthPct: number | null
    pairsRead: number
    moversUp: { pair: string; dayPct: number }[]
    moversDown: { pair: string; dayPct: number }[]
  }
  news: { title: string; source: string; impact: number; tickers: string[]; hourAfterPct: number | null }[]
  /** False when the day is older than the feed keeps stories: nothing can be said of its news. */
  newsKept: boolean
  trades: {
    opened: number
    ended: number
    openNow: number
    net: { asset: string; amount: number }[]
    r: number
    rTrades: number
    bestPct: number | null
    worstPct: number | null
    refused: { reason: string; count: number }[]
  }
  calls: { made: number; answered: number; valid: number; costUsd: number }
  answers: { buy: number; sell: number; hold: number; noTrade: number }
  models: { model: string; closed: number; netPctATrade: number | null; profitFactor: number | null }[]
  risk: { pausedWatch: boolean; pausedNews: boolean; aiSpentUsd: number; aiCapUsd: number; healthPauses: number; highAlerts: number }
}

export interface DailySummaryAnswer {
  summary: string
  confidence: number
}

/** A paragraph, checked: of a sensible length, with a confidence in range. */
export function validateDailySummary(value: unknown): { ok: true; summary: DailySummaryAnswer } | { ok: false; reason: string } {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  if (typeof raw.summary !== 'string' || raw.summary.trim().length < DAILY_SUMMARY_MIN_CHARS) return { ok: false, reason: 'summary is missing or too short' }
  if (raw.summary.length > DAILY_SUMMARY_MAX_CHARS) return { ok: false, reason: `summary is longer than ${DAILY_SUMMARY_MAX_CHARS} characters` }
  if (!finite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) return { ok: false, reason: 'confidence is missing or out of range' }
  return { ok: true, summary: { summary: raw.summary.trim(), confidence: raw.confidence } }
}

export interface DailySummaryRequest {
  day: string
  question: DailySummaryQuestion
}

const numberOrNull = (value: unknown): value is number | null => value === null || finite(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= DAILY_SUMMARY_TEXT_CHARS
const rows = <T>(value: unknown, most: number, each: (entry: unknown) => T | null): T[] | null => {
  if (!Array.isArray(value) || value.length > most) return null
  const out: T[] = []
  for (const entry of value) {
    const read = each(entry)
    if (read === null) return null
    out.push(read)
  }
  return out
}
const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/** A request as it arrives over the bridge, read as one: a UTC day, and the question about it with
 * each figure in its shape and each list within its bound, rebuilt so that nothing else passes; or
 * null. */
export function parseDailySummaryRequest(value: unknown): DailySummaryRequest | null {
  const raw = record(value)
  if (raw === null) return null
  const { day } = raw
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) return null
  const q = record(raw.question)
  if (q === null || q.day !== day || typeof q.newsKept !== 'boolean') return null
  const market = record(q.market)
  const trades = record(q.trades)
  const calls = record(q.calls)
  const answers = record(q.answers)
  const risk = record(q.risk)
  if (market === null || trades === null || calls === null || answers === null || risk === null) return null
  const mover = (entry: unknown): { pair: string; dayPct: number } | null => {
    const item = record(entry)
    return item !== null && text(item.pair) && finite(item.dayPct) ? { pair: item.pair, dayPct: item.dayPct } : null
  }
  const moversUp = rows(market.moversUp, DAILY_SUMMARY_MAX_ROWS.movers, mover)
  const moversDown = rows(market.moversDown, DAILY_SUMMARY_MAX_ROWS.movers, mover)
  if (moversUp === null || moversDown === null) return null
  if (!(market.regime === null || text(market.regime)) || !numberOrNull(market.btcDayPct) || !numberOrNull(market.ethDayPct) || !numberOrNull(market.breadthPct) || !finite(market.pairsRead)) return null
  const news = rows(q.news, DAILY_SUMMARY_MAX_ROWS.news, (entry) => {
    const item = record(entry)
    if (item === null || !text(item.title) || !text(item.source) || !finite(item.impact) || !numberOrNull(item.hourAfterPct)) return null
    const tickers = rows(item.tickers, DAILY_SUMMARY_MAX_ROWS.tickers, (ticker) => (text(ticker) ? ticker : null))
    return tickers === null ? null : { title: item.title, source: item.source, impact: item.impact, tickers, hourAfterPct: item.hourAfterPct }
  })
  if (news === null) return null
  const net = rows(trades.net, DAILY_SUMMARY_MAX_ROWS.net, (entry) => {
    const item = record(entry)
    return item !== null && text(item.asset) && finite(item.amount) ? { asset: item.asset, amount: item.amount } : null
  })
  const refused = rows(trades.refused, DAILY_SUMMARY_MAX_ROWS.refused, (entry) => {
    const item = record(entry)
    return item !== null && text(item.reason) && finite(item.count) ? { reason: item.reason, count: item.count } : null
  })
  if (net === null || refused === null) return null
  if (!finite(trades.opened) || !finite(trades.ended) || !finite(trades.openNow) || !finite(trades.r) || !finite(trades.rTrades) || !numberOrNull(trades.bestPct) || !numberOrNull(trades.worstPct)) return null
  if (!finite(calls.made) || !finite(calls.answered) || !finite(calls.valid) || !finite(calls.costUsd)) return null
  if (!finite(answers.buy) || !finite(answers.sell) || !finite(answers.hold) || !finite(answers.noTrade)) return null
  const models = rows(q.models, DAILY_SUMMARY_MAX_ROWS.models, (entry) => {
    const item = record(entry)
    return item !== null && text(item.model) && finite(item.closed) && numberOrNull(item.netPctATrade) && numberOrNull(item.profitFactor)
      ? { model: item.model, closed: item.closed, netPctATrade: item.netPctATrade, profitFactor: item.profitFactor }
      : null
  })
  if (models === null) return null
  if (typeof risk.pausedWatch !== 'boolean' || typeof risk.pausedNews !== 'boolean' || !finite(risk.aiSpentUsd) || !finite(risk.aiCapUsd) || !finite(risk.healthPauses) || !finite(risk.highAlerts)) return null
  return {
    day,
    question: {
      day,
      market: { regime: market.regime, btcDayPct: market.btcDayPct, ethDayPct: market.ethDayPct, breadthPct: market.breadthPct, pairsRead: market.pairsRead, moversUp, moversDown },
      news,
      newsKept: q.newsKept,
      trades: { opened: trades.opened, ended: trades.ended, openNow: trades.openNow, net, r: trades.r, rTrades: trades.rTrades, bestPct: trades.bestPct, worstPct: trades.worstPct, refused },
      calls: { made: calls.made, answered: calls.answered, valid: calls.valid, costUsd: calls.costUsd },
      answers: { buy: answers.buy, sell: answers.sell, hold: answers.hold, noTrade: answers.noTrade },
      models,
      risk: { pausedWatch: risk.pausedWatch, pausedNews: risk.pausedNews, aiSpentUsd: risk.aiSpentUsd, aiCapUsd: risk.aiCapUsd, healthPauses: risk.healthPauses, highAlerts: risk.highAlerts }
    }
  }
}

/** What a day's summary is filed under in the ledger. */
export function dailySubjectId(day: string): string {
  return `day:${day}`
}

/** The daily summary over the bridge (the main process's summarizeDay). */
export interface DailySummary {
  asked: boolean
  outcome: AiAdditionOutcome<DailySummaryAnswer> | null
}

export interface DailySummaryOnFile {
  day: string
  summary: DailySummaryAnswer
  at: number
  model: string
}

/** The summaries on file, by the day each is about: the newest answered row under the addition's
 * prompt for each day. */
export function dailySummariesOf(rows: readonly Pick<AiCallRecord, 'promptVersion' | 'status' | 'subjectId' | 'additionAnswer' | 'at' | 'model'>[]): Record<string, DailySummaryOnFile> {
  const out: Record<string, DailySummaryOnFile> = {}
  for (const row of [...rows].sort((a, b) => a.at - b.at)) {
    if (row.promptVersion !== AI_ADDITION_PROMPT_VERSIONS.daily || row.status !== 'ok' || row.subjectId === undefined || !row.subjectId.startsWith('day:')) continue
    const checked = validateDailySummary(row.additionAnswer)
    if (!checked.ok) continue
    const day = row.subjectId.slice(4)
    out[day] = { day, summary: checked.summary, at: row.at, model: row.model }
  }
  return out
}
