import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  AI_ADDITION_DAILY_LIMITS,
  AI_ADDITION_KINDS,
  AI_ADDITION_PROMPT_VERSIONS,
  AI_ADDITION_SCHEMA_VERSIONS,
  additionCallsToday,
  additionProblem,
  additionsModelOf,
  newsQuestionOf,
  validateNewsReading,
  validateWhyConclusion,
  whyQuestionOf,
  type AiAdditionKind,
  type AiAdditionOutcome,
  type AiAdditionsStatus,
  type MoveConclusion,
  type NewsReading
} from '../../shared/aiAdditions'
import { averageCallCostUsd, estimateCallCostUsd } from '../../shared/aiCost'
import { HIGH_IMPACT } from '../../shared/alerts'
import { NOTABLE_MOVE_PCT, explainMove } from '../../shared/moveExplanation'
import type { NewsFeedState, ReadStory } from '../../shared/newsFeed'
import { writeJsonAtomic } from './atomicWrite'
import { additionPromptChars, AI_ADDITION_SCHEMAS, buildAdditionMessages } from './aiAdditionPrompts'
import { assertAiBudget, findAiModel, getAiConfig, recordAiSpend } from './aiConfigService'
import { getDecryptedAiCredential } from './aiCredentialsService'
import { appendAiCall, listAiCalls } from './aiLedgerService'
import { requestWithRetry, withCost } from './aiSignalService'
import { scanSourceFor } from './marketService'
import { getNewsFeedState, onNewsFeedUpdate } from './newsFeedService'

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
// its cache and the ledger's rows (tests/aiNoLivePath.test.ts).

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
  const model = additionsModelOf(config)
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
    return await paid(input, model, key)
  } finally {
    await inTurn(async () => {
      const left = (inFlight.get(input.kind) ?? 1) - 1
      if (left > 0) inFlight.set(input.kind, left)
      else inFlight.delete(input.kind)
    })
  }
}

async function paid<T>(input: Parameters<typeof askAddition<T>>[0], model: string, key: string): Promise<AdditionOutcome<T>> {
  try {
    await assertAiBudget()
  } catch (error) {
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
    detail: null
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
  if (result.finishReason === 'length') verdict = { ok: false, reason: 'The answer was cut off at the output limit before it finished.' }
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
  }
}

/** Each addition's switch, what it has asked today and what one more call is expected to cost. Free:
 * it reads the setting, the ledger and the price list. */
export async function getAiAdditionsStatus(): Promise<AiAdditionsStatus> {
  const config = await getAiConfig()
  const model = additionsModelOf(config)
  const nowSec = Math.floor(Date.now() / 1000)
  const page = await listAiCalls({ source: 'addition', sinceSec: Math.floor(nowSec / DAY) * DAY, limit: LEDGER_ROWS_READ })
  const info = await findAiModel(model)
  const perCall = {} as AiAdditionsStatus['perCall']
  const today = {} as AiAdditionsStatus['today']
  for (const kind of AI_ADDITION_KINDS) {
    today[kind] = additionCallsToday(page.rows, kind, nowSec)
    const history = await listAiCalls({ model, promptVersion: AI_ADDITION_PROMPT_VERSIONS[kind], limit: COST_HISTORY_ROWS })
    const measured = averageCallCostUsd(history.rows)
    const priced = info === null ? null : estimateCallCostUsd(info, additionPromptChars(kind, SAMPLE_PAYLOAD[kind]))
    perCall[kind] = measured !== null ? { usd: measured, basis: 'history' } : priced !== null ? { usd: priced, basis: 'pricing' } : { usd: null, basis: 'unknown' }
  }
  return { model, watchOn: config.watch.enabled, additions: config.additions, limits: { ...AI_ADDITION_DAILY_LIMITS }, today, perCall }
}
