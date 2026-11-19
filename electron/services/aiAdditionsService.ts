import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  AI_ADDITION_DAILY_LIMITS,
  AI_ADDITION_KINDS,
  AI_ADDITION_ROLES,
  dailySubjectId,
  parseDailySummaryRequest,
  validateDailySummary,
  type DailySummary,
  type DailySummaryQuestion,
  AI_ADDITION_PROMPT_VERSIONS,
  AI_ADDITION_SCHEMA_VERSIONS,
  EXIT_LINES,
  additionCallsToday,
  additionProblem,
  additionsModelOf,
  exitQuestionOf,
  exitSubjectId,
  exitTradeOf,
  exitTriggers,
  exitTriggersAsked,
  newsQuestionOf,
  parseExitCheckRequest,
  parseReviewRequest,
  reviewQuestionOf,
  reviewTriggers,
  validateExitVerdict,
  validateNewsReading,
  validateReviewVerdict,
  validateWhyConclusion,
  whyQuestionOf,
  type AiAdditionKind,
  type AiAdditionOutcome,
  type AiAdditionsStatus,
  type ExitCheck,
  type ExitTrade,
  type MoveConclusion,
  type NewsReading,
  type ReviewOther,
  type TradeReview
} from '../../shared/aiAdditions'
import { servedFamilyOf } from '../../shared/aiRouting'
import { AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS } from '../../shared/aiOpportunity'
import { averageCallCostUsd, budgetProblem, estimateCallCostUsd } from '../../shared/aiCost'
import { HIGH_IMPACT } from '../../shared/alerts'
import { NOTABLE_MOVE_PCT, explainMove } from '../../shared/moveExplanation'
import type { NewsFeedState, ReadStory } from '../../shared/newsFeed'
import { writeJsonAtomic } from './atomicWrite'
import { additionPromptChars, AI_ADDITION_SCHEMAS, buildAdditionMessages } from './aiAdditionPrompts'
import { AiBudgetError, assertAiBudget, findAiModel, getAiConfig, recordAiSpend } from './aiConfigService'
import { tell } from './noticeService'
import { breakerNotice } from '../../shared/notices'
import { getDecryptedAiCredential } from './aiCredentialsService'
import { appendAiCall, listAiCalls } from './aiLedgerService'
import { requestWithRetry, withCost } from './aiSignalService'
import { scanSourceFor } from './marketService'
import { getNewsFeedState, onNewsFeedUpdate } from './newsFeedService'
import { getSettings } from './settingsService'

// THE AI ADDITIONS' CALLS, WHERE THE MONEY IS SPENT (shared/aiAdditions.ts).
//
// Every call goes the way every other call does: the answer held is served from the cache for
// nothing; otherwise the addition's switch and its daily limit are read from the files only the main
// process writes -- the setting, and the ledger -- the daily budget immediately before the request,
// the pace and the retries of aiSignalService's own path, the validator after it, and a ledger row
// either way. One check at a time, as the watch's are, so that two calls arriving together cannot
// both take the last place under a limit.
//
// THE NEWS ANALYST ASKS BY ITSELF: each story of high impact the feed reads, once, within the hour it
// was published, and only while the watch is on.
//
// NOTHING HERE TRADES. It imports nothing that places, sizes or arms an order, and what it writes is
// its cache and the ledger's rows (tests/aiNoLivePath.test.ts). The exit check reads the executors
// on file, to find the trade it is asked about among the app's own open paper trades; what its EXIT
// does is written in the renderer, on paper, by the two files that write those trades.

const CONTEXT_VERSION = 'addition-v1'
const LEDGER_ROWS_READ = 5000
const COST_HISTORY_ROWS = 50
const ANSWER_EXCERPT_CHARS = 400
/** A story is read only within this long of being published: a reading of old news is history. */
const NEWS_FRESH_SECONDS = 3600
const DAY = 86_400

export type AdditionOutcome<T> = AiAdditionOutcome<T>

type Verdict<T> = { ok: true; answer: T } | { ok: false; reason: string }

interface CachedAddition {
  kind: AiAdditionKind
  promptVersion: string
  model: string
  answer?: unknown
  rejected?: string
}

function cacheDirectory(): string {
  return join(app.getPath('userData'), 'aiAdditionCache')
}

/** What an answer is filed under: the question, its versions, and who was asked. */
export function additionCacheKey(kind: AiAdditionKind, model: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify([AI_ADDITION_PROMPT_VERSIONS[kind], AI_ADDITION_SCHEMA_VERSIONS[kind], model, payload])).digest('hex')
}

async function readCached(key: string, kind: AiAdditionKind): Promise<CachedAddition | null> {
  try {
    const parsed = JSON.parse(await readFile(join(cacheDirectory(), `${key}.json`), 'utf-8')) as Partial<CachedAddition>
    if (parsed.kind !== kind || parsed.promptVersion !== AI_ADDITION_PROMPT_VERSIONS[kind] || typeof parsed.model !== 'string') return null
    return parsed as CachedAddition
  } catch {
    return null
  }
}

/** Bookkeeping around an answer must never throw the answer away. */
async function record(what: string, work: Promise<void>): Promise<void> {
  try {
    await work
  } catch (error) {
    console.error(`AI addition ${what} failed:`, error)
  }
}

const inFlight = new Map<AiAdditionKind, number>()
let turn: Promise<unknown> = Promise.resolve()

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = turn.then(work, work)
  turn = run.catch(() => undefined)
  return run
}

/** One addition's question, answered: from the cache, or asked within its switch, its limit and the
 * budget. Never throws for a call it decides not to make, or one that fails: that is an outcome. */
export async function askAddition<T>(input: {
  kind: AiAdditionKind
  /** What it is about: a story's id, an event's, a trade's. */
  subjectId: string
  symbol: string
  candleTime: number
  referencePrice?: number
  /** What the model is shown, and what the answer is filed under. */
  payload: unknown
  /** True when nobody pressed anything: then it is asked only while the watch is on. */
  automatic: boolean
  validate: (value: unknown) => Verdict<T>
}): Promise<AdditionOutcome<T>> {
  const config = await getAiConfig()
  // By role once roles are applied (V7.2-R Stage 1): the summaries' model, or the decider's.
  const model = additionsModelOf(config, input.kind)
  const key = additionCacheKey(input.kind, model, input.payload)
  const held = await readCached(key, input.kind)
  if (held !== null) {
    if (held.rejected !== undefined) return { status: 'refused', reason: held.rejected, cached: true, model }
    // Checked again on the way out: a file on disk is not proof of what was written to it.
    const verdict = input.validate(held.answer)
    if (verdict.ok) return { status: 'answered', answer: verdict.answer, cached: true, model }
  }

  const problem = await inTurn(async (): Promise<string | null> => {
    const nowSec = Math.floor(Date.now() / 1000)
    const page = await listAiCalls({ source: 'addition', sinceSec: Math.floor(nowSec / DAY) * DAY, limit: LEDGER_ROWS_READ })
    const callsToday = additionCallsToday(page.rows, input.kind, nowSec) + (inFlight.get(input.kind) ?? 0)
    const found = additionProblem({ kind: input.kind, additions: config.additions, watchOn: config.watch.enabled, automatic: input.automatic, callsToday })
    if (found === null) inFlight.set(input.kind, (inFlight.get(input.kind) ?? 0) + 1)
    return found
  })
  if (problem !== null) return { status: 'skipped', reason: problem }
  try {
    return await paid(input, model, key, config.roles === null ? undefined : AI_ADDITION_ROLES[input.kind])
  } finally {
    await inTurn(async () => {
      const left = (inFlight.get(input.kind) ?? 1) - 1
      if (left > 0) inFlight.set(input.kind, left)
      else inFlight.delete(input.kind)
    })
  }
}

async function paid<T>(input: Parameters<typeof askAddition<T>>[0], model: string, key: string, role?: 'decide' | 'summarize'): Promise<AdditionOutcome<T>> {
  try {
    await assertAiBudget()
  } catch (error) {
    // The day's budget spent: told once a day on the budget's thread, as the watch's own calls are
    // (aiSignalService.ts). Until 8 October 2026 an addition met the budget in silence.
    if (error instanceof AiBudgetError) {
      const { capUsd, spentUsd } = error
      tell((i18n) =>
        breakerNotice(
          'ai-budget',
          i18n.t('{problem} No addition is asked again until the budget is raised or the day turns.', { problem: i18n.language === 'en' ? error.message : (budgetProblem(capUsd, spentUsd, i18n) ?? error.message) }),
          'ai-budget',
          i18n
        )
      )
    }
    return { status: 'skipped', reason: error instanceof Error ? error.message : String(error) }
  }
  let apiKey: string
  try {
    apiKey = (await getDecryptedAiCredential()).apiKey
  } catch (error) {
    return { status: 'skipped', reason: error instanceof Error ? error.message : String(error) }
  }
  const promptVersion = AI_ADDITION_PROMPT_VERSIONS[input.kind]
  const row = {
    source: 'addition' as const,
    addition: input.kind,
    subjectId: input.subjectId,
    model,
    promptVersion,
    contextVersion: CONTEXT_VERSION,
    schemaVersion: AI_ADDITION_SCHEMA_VERSIONS[input.kind],
    exchange: 'binance' as const,
    symbol: input.symbol,
    interval: '1m' as const,
    candleTime: input.candleTime,
    position: 'flat' as const,
    referencePrice: input.referencePrice ?? 0,
    // An addition makes no call on the market: there is nothing here to score as one.
    recommendation: null,
    detail: null,
    ...(role === undefined ? {} : { role })
  }
  const finishedAt = (): number => Math.floor(Date.now() / 1000)

  let result: Awaited<ReturnType<typeof requestWithRetry>>
  try {
    result = await requestWithRetry(apiKey, model, buildAdditionMessages(input.kind, input.payload), AI_ADDITION_SCHEMAS[input.kind])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await record(
      'ledger write',
      appendAiCall({
        ...row,
        id: randomUUID(),
        at: finishedAt(),
        status: 'failed',
        provider: null,
        usage: { promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: 0 },
        error: reason,
        confidence: null,
        rationale: null
      })
    )
    return { status: 'failed', reason }
  }

  // From here the model has answered and been paid, usable or not.
  const usage = await withCost(result.usage, model)
  await record('spend record', recordAiSpend(usage.costUsd ?? 0))
  let verdict: Verdict<T>
  // Another provider's model answering is refused (V7.2-R Stage 1): what was asked is what may answer.
  const family = servedFamilyOf(model, result.servedModel)
  if (family === 'other') verdict = { ok: false, reason: `The answer came from ${result.servedModel}, not from ${model}, the model asked.` }
  else if (result.finishReason === 'length') verdict = { ok: false, reason: 'The answer was cut off at the output limit before it finished.' }
  else {
    let parsed: unknown
    try {
      parsed = JSON.parse(result.content)
      verdict = input.validate(parsed)
    } catch {
      verdict = { ok: false, reason: 'The answer was not valid JSON.' }
    }
  }
  // The rule every call here follows: an answer the model gave is cached whether it can be used or
  // not, and a call that never got one is not.
  const cached: CachedAddition = verdict.ok
    ? { kind: input.kind, promptVersion, model, answer: verdict.answer }
    : { kind: input.kind, promptVersion, model, rejected: verdict.reason }
  await record(
    'cache write',
    mkdir(cacheDirectory(), { recursive: true }).then(() => writeJsonAtomic(join(cacheDirectory(), `${key}.json`), cached))
  )
  const answer = verdict.ok ? (verdict.answer as Record<string, unknown>) : null
  await record(
    'ledger write',
    appendAiCall({
      ...row,
      id: key,
      at: finishedAt(),
      status: verdict.ok ? 'ok' : 'rejected',
      provider: result.provider,
      ...(result.servedModel !== null ? { servedModel: result.servedModel } : {}),
      ...(family === 'variant' || family === 'other' ? { servedMismatch: family } : {}),
      usage,
      error: verdict.ok ? null : verdict.reason,
      ...(verdict.ok ? {} : { answerExcerpt: result.content.slice(0, ANSWER_EXCERPT_CHARS) }),
      confidence: answer !== null && typeof answer.confidence === 'number' ? answer.confidence : null,
      rationale: answer === null ? null : typeof answer.reasons === 'string' ? answer.reasons : typeof answer.conclusion === 'string' ? answer.conclusion : typeof answer.reason === 'string' ? answer.reason : null,
      ...(verdict.ok ? { additionAnswer: verdict.answer } : {})
    })
  )
  return verdict.ok ? { status: 'answered', answer: verdict.answer, cached: false, model } : { status: 'refused', reason: verdict.reason, cached: false, model }
}

// ---------------------------------------------------------------------------------------------
// The news analyst.

/** One story, read by the analyst: once, and from the cache after that. */
export async function analyseStory(story: ReadStory, automatic: boolean): Promise<AdditionOutcome<NewsReading>> {
  const coin = story.assets.find((asset) => asset.relationship === 'DIRECT') ?? story.assets[0]
  return askAddition({
    kind: 'news',
    subjectId: story.id,
    symbol: coin === undefined ? 'NEWS' : `${coin.ticker}USDT`,
    candleTime: story.publishedAt,
    payload: newsQuestionOf(story),
    automatic,
    validate: (value) => {
      const checked = validateNewsReading(value)
      return checked.ok ? { ok: true, answer: checked.reading } : checked
    }
  })
}

// ---------------------------------------------------------------------------------------------
// The conclusion to "Why did it move?".

/** Minutes read of a pair and of Bitcoin: the four hours explainMove sets a move against, and some. */
const WHY_MINUTES = 260

/** Why a pair moved: the fixed rules' explanation, rebuilt here from its minutes and Bitcoin's -- public
 * candles from the market-data host -- and the stories the feed holds, never handed in; and the
 * conclusion, asked only where there is evidence to weigh. A person asks it from the Why window
 * (`automatic` false); the news analyst asks it by itself for a coin a story of high impact names. */
export async function concludeMove(symbol: unknown, automatic: boolean): Promise<MoveConclusion> {
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new Error('A pair is named as Binance names it, against USDT.')
  const nowSec = Math.floor(Date.now() / 1000)
  const source = scanSourceFor('binance')
  const bars = await source.fetchRecentCandles(symbol, '1m', WHY_MINUTES)
  const btcBars = symbol === 'BTCUSDT' ? bars : await source.fetchRecentCandles('BTCUSDT', '1m', WHY_MINUTES)
  const explanation = explainMove({ symbol, ticker: symbol.slice(0, -4), bars, btcBars, stories: getNewsFeedState().stories, nowSec })
  const question = whyQuestionOf(explanation, NOTABLE_MOVE_PCT)
  if (question === null) return { explanation, question, outcome: null }
  const minute = Math.floor(nowSec / 60) * 60
  const outcome = await askAddition({
    kind: 'why',
    subjectId: `${symbol}:${minute}`,
    symbol,
    candleTime: minute,
    payload: question,
    automatic,
    validate: (value) => {
      const checked = validateWhyConclusion(value, question)
      return checked.ok ? { ok: true, answer: checked.conclusion } : checked
    }
  })
  return { explanation, question, outcome }
}

// ---------------------------------------------------------------------------------------------
// The reviewer.

/** A second look before one of the watch's paper trades, when something about it stands out. The
 * request is the event and the call, read as such; the other models' calls are read here from the
 * ledger, as they stand when the trade would open, and the news from the feed. With nothing that
 * stands out, nothing is asked. It is held to the watch: the watch opens these trades by itself. */
export async function reviewTrade(request: unknown): Promise<TradeReview> {
  const parsed = parseReviewRequest(request)
  if (parsed === null) throw new Error('A review is asked about an event and a call to trade it.')
  const { event, call } = parsed
  const nowSec = Math.floor(Date.now() / 1000)
  const page = await listAiCalls({ symbol: event.symbol, sinceSec: event.time, promptVersions: AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS, limit: 500 })
  const others: ReviewOther[] = []
  for (const row of page.rows) {
    if (row.eventId !== event.id || row.model === call.model || row.status === 'failed' || others.some((other) => other.model === row.model)) continue
    const side = row.status === 'rejected' || row.detail?.entry == null ? null : row.recommendation === 'buy' ? 'long' : row.recommendation === 'sell' ? 'short' : null
    others.push({ model: row.model, side, confidence: row.confidence ?? 0, refused: row.status === 'rejected' })
  }
  const stories = getNewsFeedState().stories
  const triggers = reviewTriggers({ event, side: call.side, others, stories, nowSec })
  if (triggers.length === 0) return { asked: false, triggers, outcome: null }
  const outcome = await askAddition({
    kind: 'review',
    subjectId: event.id,
    symbol: event.symbol,
    candleTime: event.time,
    referencePrice: event.price,
    payload: reviewQuestionOf({ event, call, others, stories, triggers, nowSec }),
    automatic: true,
    validate: (value) => {
      const checked = validateReviewVerdict(value)
      return checked.ok ? { ok: true, answer: checked.verdict } : checked
    }
  })
  return { asked: true, triggers, outcome }
}

// ---------------------------------------------------------------------------------------------
// The exit check.

/** Trades a check is being asked about now: one at a time each, so that two looks cannot both ask
 * for the same reason before either is on file. */
const checking = new Set<string>()

/** What a trade was opened on: the call the watch followed, read from the ledger, or the
 * announcement a news rule shorted. */
async function exitThesisOf(trade: ExitTrade): Promise<string> {
  const { origin } = trade
  if (origin.kind === 'news') {
    return `${origin.category === 'MONITORING_TAG' ? 'Binance put the coin under its Monitoring Tag' : "Binance announced the coin's delisting"}: "${origin.title}".`
  }
  const page = await listAiCalls({ symbol: trade.symbol, model: origin.model, sinceSec: origin.eventTime, promptVersions: AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS, limit: 200 })
  const call = page.rows.find((row) => row.eventId === origin.eventId && row.status === 'ok')
  return call?.rationale ?? 'The call it was opened on is not on file.'
}

/** One of the app's own open paper trades, looked at again. The trade -- its side, its levels, its
 * time limit, what opened it -- is read here from the executors on file, and only the app's own open
 * paper positions are looked at; where it entered and what the market has done since are the
 * renderer's to measure, as the engine runs there; the news comes from the feed, and the reasons are
 * the fixed lines'. The check is asked only for a reason it has not been asked about on this trade
 * before, and it is held to the watch: it asks by itself. What an EXIT does is written in the
 * renderer, on paper (src/agents/exitCheck.ts). */
export async function exitCheck(request: unknown): Promise<ExitCheck> {
  const parsed = parseExitCheckRequest(request)
  if (parsed === null) throw new Error("An exit check is asked about one of the app's own open paper trades, as it stands.")
  const executor = (await getSettings()).executors.find((entry) => entry.id === parsed.executorId)
  const read = executor === undefined ? { ok: false as const, reason: 'there is no such trade on file.' } : exitTradeOf(executor)
  if (!read.ok) throw new Error(`The exit check looks only at the app's own open paper trades, and ${read.reason}`)
  const { trade } = read
  const nowSec = Math.floor(Date.now() / 1000)
  if (parsed.priceTime > nowSec || nowSec - (parsed.priceTime + 60) > EXIT_LINES.priceMaxAgeSeconds) throw new Error('The price the exit check would be shown is not of the last few minutes.')
  if (parsed.enteredAt < trade.createdAt - 60) throw new Error('The entry the exit check would be shown is before the trade was opened.')
  const stories = getNewsFeedState().stories
  const triggers = exitTriggers({ trade, request: parsed, stories, nowSec })
  if (triggers.length === 0 || checking.has(trade.id)) return { asked: false, triggers, outcome: null }
  checking.add(trade.id)
  try {
    const page = await listAiCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit, symbol: trade.symbol, sinceSec: trade.createdAt, limit: LEDGER_ROWS_READ })
    const asked = exitTriggersAsked(page.rows, trade.id)
    if (triggers.every((trigger) => asked.has(trigger))) return { asked: false, triggers, outcome: null }
    const thesis = await exitThesisOf(trade)
    const outcome = await askAddition({
      kind: 'exit',
      subjectId: exitSubjectId(trade.id, triggers),
      symbol: trade.symbol,
      candleTime: parsed.priceTime,
      referencePrice: parsed.price,
      payload: exitQuestionOf({ trade, request: parsed, thesis, stories, triggers, nowSec }),
      automatic: true,
      validate: (value) => {
        const checked = validateExitVerdict(value)
        return checked.ok ? { ok: true, answer: checked.verdict } : checked
      }
    })
    return { asked: true, triggers, outcome }
  } finally {
    checking.delete(trade.id)
  }
}

// ---------------------------------------------------------------------------------------------
// The daily summary.

/** One paragraph about one UTC day's report, from its figures as the renderer built them
 * (shared/dailyReport.ts). The day has to be over; the figures are read in their shape and
 * nothing else passes. Automatic when the look asks after 00:05 UTC, which holds it to the watch;
 * a click asks with the watch off too. Either way one call a day, the budget, the cache. */
export async function summarizeDay(request: unknown, automatic: boolean): Promise<DailySummary> {
  const parsed = parseDailySummaryRequest(request)
  if (parsed === null) throw new Error("A daily summary is asked about one UTC day's report, as its figures stand.")
  const dayEnd = Date.parse(`${parsed.day}T00:00:00Z`) / 1000 + DAY
  if (dayEnd > Math.floor(Date.now() / 1000)) throw new Error(`${parsed.day} is not over yet (UTC).`)
  const outcome = await askAddition({
    kind: 'daily',
    subjectId: dailySubjectId(parsed.day),
    symbol: 'BTCUSDT',
    candleTime: dayEnd - 60,
    payload: parsed.question,
    automatic,
    validate: (value) => {
      const checked = validateDailySummary(value)
      return checked.ok ? { ok: true, answer: checked.summary } : checked
    }
  })
  return { asked: true, outcome }
}

const handled = new Set<string>()
const queue: ReadStory[] = []
let draining = false

/** Each fresh story of high impact the feed holds, queued once. A story whose reaction has not yet
 * confirmed it is looked at again on the next read, within its hour. */
export function takeUpHighStories(state: Pick<NewsFeedState, 'stories' | 'reactions'>, nowSec: number): ReadStory[] {
  const taken: ReadStory[] = []
  for (const story of state.stories) {
    if (handled.has(story.id) || story.stale || nowSec - story.publishedAt > NEWS_FRESH_SECONDS || story.publishedAt > nowSec) continue
    if (story.impact < HIGH_IMPACT && state.reactions[story.id]?.verdict !== 'CONFIRMED') continue
    handled.add(story.id)
    taken.push(story)
  }
  return taken
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    for (let story = queue.shift(); story !== undefined; story = queue.shift()) {
      const outcome = await analyseStory(story, true)
      if (outcome.status === 'failed') console.warn(`The news analyst could not read "${story.title}":`, outcome.reason)
      // And why the coin it names has moved, where there is a move and evidence to weigh.
      const coin = story.assets.find((asset) => asset.relationship === 'DIRECT')
      if (coin === undefined) continue
      try {
        await concludeMove(`${coin.ticker}USDT`, true)
      } catch (error) {
        console.warn(`No conclusion for ${coin.ticker}USDT:`, error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    draining = false
  }
}

/** Test seam. */
export function resetAiAdditions(): void {
  handled.clear()
  queue.length = 0
}

let started = false

/** Starts the additions that ask by themselves. Called once, from electron/main.ts. */
export function startAiAdditions(): void {
  if (started) return
  started = true
  onNewsFeedUpdate((state) => {
    queue.push(...takeUpHighStories(state, Math.floor(Date.now() / 1000)))
    void drain().catch((error) => console.error('The news analyst stopped:', error))
  })
}

// ---------------------------------------------------------------------------------------------
// What Settings › AI shows.

/** A day's figures of a usual size, for pricing the summary before any has been asked. */
const DAILY_SAMPLE: DailySummaryQuestion = {
  day: '2026-10-07',
  market: { regime: 'sideways', btcDayPct: 0.8, ethDayPct: -0.4, breadthPct: 52, pairsRead: 60, moversUp: Array.from({ length: 5 }, (_, k) => ({ pair: `COIN${k}USDT`, dayPct: 8 - k })), moversDown: Array.from({ length: 5 }, (_, k) => ({ pair: `ALT${k}USDT`, dayPct: -6 + k })) },
  news: Array.from({ length: 4 }, () => ({ title: 'A headline of the usual length about a coin and what happened to it', source: 'CoinDesk', impact: 75, tickers: ['SOL'], hourAfterPct: 1.2 })),
  newsKept: true,
  trades: { opened: 3, ended: 2, openNow: 1, net: [{ asset: 'USDT', amount: 1.4 }], r: 0.6, rTrades: 2, bestPct: 2.1, worstPct: -1.2, refused: [{ reason: 'The paper account has no funds for it', count: 2 }] },
  calls: { made: 12, answered: 12, valid: 12, costUsd: 0.09 },
  answers: { buy: 4, sell: 1, hold: 5, noTrade: 2 },
  models: [{ model: 'sample', closed: 40, netPctATrade: 0.2, profitFactor: 1.3 }],
  risk: { pausedWatch: false, pausedNews: false, aiSpentUsd: 0.31, aiCapUsd: 5, healthPauses: 0, highAlerts: 3 }
}

/** A story's question of a usual length, for pricing one before any has been asked. */
const SAMPLE_PAYLOAD: Record<AiAdditionKind, unknown> = {
  news: newsQuestionOf({
    id: 'sample',
    sourceName: 'CoinDesk',
    title: 'A headline of the usual length about a coin and what happened to it',
    summary: 'x'.repeat(600),
    publishedAt: 0,
    eventType: 'LISTING',
    assets: [{ ticker: 'SOL', relationship: 'DIRECT' }]
  }),
  why: {
    pair: 'SOLUSDT',
    windowMinutes: 60,
    movePct: 2.4,
    volumeRatio: 3.1,
    btcMovePct: 0.4,
    label: 'PROBABLE',
    evidence: [
      { id: 'story:sample', kind: 'news', text: 'A headline of the usual length about a coin and what happened to it (CoinDesk, 11:10 UTC)' },
      { id: 'volume', kind: 'volume', text: 'Volume 3.1 times its usual over those minutes.' }
    ]
  },
  exit: {
    trade: {
      pair: 'SOLUSDT',
      side: 'long',
      openedBy: "the watch, following sample's call on a market event",
      thesis: 'x'.repeat(300),
      entryPrice: 100,
      minutesOpen: 42,
      stopPct: 1.5,
      targetPct: 3,
      minutesLeft: 18
    },
    now: { price: 98.8, gainPct: -1.2, move15mPct: -1.4, regimeAtEntry: 'bull', regimeNow: 'sideways' },
    news: [{ title: 'A headline of the usual length about a coin and what happened to it', source: 'CoinDesk', kind: 'HACK', impact: 80, minutesAgo: 12 }],
    triggers: ['near_stop', 'news']
  },
  review: {
    event: { pair: 'SOLUSDT', kind: 'breakout', direction: 'up', score: 88, movePct15m: 3.2, moveSigmas: 6.1, volumeRatio: 4.2, quoteVolume24h: 4e8, spreadPct: 0.01, announcement: null },
    call: { model: 'sample', side: 'long', confidence: 0.75, entryMin: 99.8, entryMax: 100.2, stopLoss: 98.5, takeProfit: 103, rationale: 'x'.repeat(300) },
    others: [{ model: 'other', call: 'SELL', confidence: 0.7 }],
    news: [{ title: 'A headline of the usual length about a coin and what happened to it', source: 'CoinDesk', kind: 'LISTING', impact: 72 }],
    triggers: ['models_disagree', 'major_news']
  },
  daily: DAILY_SAMPLE,
  // An article read to the extract's cap: twenty passages of 400 characters (V8 Stage 5).
  article: {
    article: {
      host: 'www.coindesk.com',
      credibility: 'outlet',
      retrieval: 'fetched',
      title: 'A headline of the usual length about a coin and what happened to it',
      publishedAt: 0,
      timeSource: 'jsonld',
      kind: 'LISTING',
      passages: Array.from({ length: 20 }, (_, k) => ({ n: k + 1, text: 'x'.repeat(400) }))
    },
    coins: [
      { ticker: 'SOL', relationship: 'DIRECT' },
      { ticker: 'ETH', relationship: 'INDIRECT' },
      { ticker: 'BTC', relationship: 'INDIRECT' }
    ],
    subject: 'SOL',
    askedAt: 0
  },
  // Ten coins of thirty closes and twenty headlines (V10 Stage 7).
  direction: {
    day: '2026-11-19',
    askedAt: 0,
    coins: Array.from({ length: 10 }, (_, k) => ({ pair: `COIN${k}USDT`, closes: Array.from({ length: 30 }, () => 12345.678), expectedMove24hPct: 3.21 })),
    headlines: Array.from({ length: 20 }, () => ({ title: 'x'.repeat(160), source: 'CoinDesk', hoursAgo: 5 }))
  }
}

/** Each addition's switch, what it has asked today and what one more call is expected to cost. Free:
 * it reads the setting, the ledger and the price list. */
export async function getAiAdditionsStatus(): Promise<AiAdditionsStatus> {
  const config = await getAiConfig()
  const model = additionsModelOf(config, 'news')
  const nowSec = Math.floor(Date.now() / 1000)
  const page = await listAiCalls({ source: 'addition', sinceSec: Math.floor(nowSec / DAY) * DAY, limit: LEDGER_ROWS_READ })
  const perCall = {} as AiAdditionsStatus['perCall']
  const today = {} as AiAdditionsStatus['today']
  const models = {} as AiAdditionsStatus['models']
  for (const kind of AI_ADDITION_KINDS) {
    // Each addition's own model: two of them once roles are applied (V7.2-R Stage 1).
    const mine = additionsModelOf(config, kind)
    models[kind] = mine
    const info = await findAiModel(mine)
    today[kind] = additionCallsToday(page.rows, kind, nowSec)
    const history = await listAiCalls({ model: mine, promptVersion: AI_ADDITION_PROMPT_VERSIONS[kind], limit: COST_HISTORY_ROWS })
    const measured = averageCallCostUsd(history.rows)
    const priced = info === null ? null : estimateCallCostUsd(info, additionPromptChars(kind, SAMPLE_PAYLOAD[kind]))
    perCall[kind] = measured !== null ? { usd: measured, basis: 'history' } : priced !== null ? { usd: priced, basis: 'pricing' } : { usd: null, basis: 'unknown' }
  }
  return { model, models, byRole: config.roles !== null, watchOn: config.watch.enabled, additions: config.additions, limits: { ...AI_ADDITION_DAILY_LIMITS }, today, perCall }
}
