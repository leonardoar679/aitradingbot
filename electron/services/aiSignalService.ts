import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  GPT_FLAT,
  GPT_INTRADAY_INTERVAL,
  GPT_LOOKBACK_BARS,
  GPT_MAX_DECISIONS,
  GPT_PROMPT_VERSION,
  decisionRange,
  gptActionFor,
  gptApplyStop,
  gptAtrSeries,
  gptStopFor,
  isDecisionCandle,
  parseAiSignalResponse,
  validateAiAnswer,
  type AiAnswerVerdict,
  type AiCallSource,
  type AiCallUsage,
  type AiPositionState,
  type AiSignalDecision,
  type AiSignalEstimate,
  type AiSignalProgress,
  type AiSignalTape,
  type AiSignalTapeRequest
} from '../../shared/aiSignal'
import {
  AI_CONTEXT_VERSION,
  aiContextJson,
  aiPromptVersion,
  aiSchemaVersion,
  buildAiContext,
  buildEventContext,
  withAgentReports,
  type AiMarketContext
} from '../../shared/aiContext'
import {
  AI_OPPORTUNITY_MAX_MODELS,
  validateOpportunityAnswer,
  type AiOpportunityAskRequest,
  type AiOpportunityModelPeek,
  type AiOpportunityPeek,
  type AiOpportunityPeekRequest,
  type AiOpportunityQuestion
} from '../../shared/aiOpportunity'
import { marketEventId } from '../../shared/marketEvent'
import {
  AI_AGENT_PROMPT_VERSIONS,
  AI_AGENT_ROLES,
  AI_AGENT_SCHEMA_VERSION,
  AI_PANEL_CALLS,
  AI_PANEL_PROMPT_VERSION,
  deciderCalls,
  describeDecider,
  isPanelId,
  panelModelOf,
  validateAgentReport,
  type AiAgentReport,
  type AiAgentReports,
  type AiAgentRole
} from '../../shared/aiPanel'
import {
  isBarSettled,
  parseStrategyBlock,
  type AiEntryConfirmRequest,
  type AiEntryPeek
} from '../../shared/aiConfirm'
import {
  AI_BENCHMARK_MAX_DECISIONS,
  AI_BENCHMARK_MAX_MODELS,
  type AiBenchmarkModelPeek,
  type AiBenchmarkPeek,
  type AiBenchmarkPeekRequest
} from '../../shared/aiBenchmark'
import { averageCallCostUsd, averageCallLatencyMs, estimateCallCostUsd } from '../../shared/aiCost'
import { escalates, routedDecision } from '../../shared/aiRoute'
import { splitAiModelId } from '../../shared/aiEffort'
import type { AiCallRecord } from '../../shared/aiLedger'
import { INTERVAL_SECONDS, type Candle } from '../../shared/ipc'
import { writeJsonAtomic } from './atomicWrite'
import { getDecryptedAiCredential } from './aiCredentialsService'
import {
  assertAiBudget,
  budgetRemainingUsd,
  findAiModel,
  recordAiSpend,
  resolveAiDecider,
  resolveAiModel,
  resolveAiPipeline
} from './aiConfigService'
import { appendAiCall, listAiCalls } from './aiLedgerService'
import { withinWatchLimits } from './aiWatchService'
import {
  AI_AGENT_SCHEMAS,
  AI_MAX_OUTPUT_TOKENS,
  aiAgentPromptChars,
  aiPanelDecisionPromptChars,
  aiPromptChars,
  buildAgentMessages,
  buildAiMessages,
  responseSchemaFor
} from './aiPrompt'
import { chatCompletion, OpenRouterError, type ChatCompletionResult } from './openRouterClient'

interface CachedDecision extends AiSignalDecision {
  promptVersion: string
}

const CANCELLED = 'GPT signal generation cancelled'
const CALL_TIMEOUT_MS = 60_000
const MAX_ATTEMPTS = 3
/** A run that has failed this many decisions running is not going to succeed on the next one. */
const MAX_CONSECUTIVE_FAILURES = 5
/** Nor is a model whose answers have been refused this many times running going to start
 * answering in the shape asked for. The difference is that every one of those was BILLED: a
 * failed call costs nothing and is asked again, a refused answer is paid for and kept. The first
 * real call to a second vendor's model came back as four tokens the validator refused -- a model
 * listed as taking a strict schema that did not fill this one -- and nothing would have stopped
 * a 672-decision run paying for 672 of those. */
const MAX_CONSECUTIVE_REFUSALS = 5
/** How many of a model's own recent calls an estimate is averaged over. */
const COST_HISTORY_ROWS = 50
/** The pause before a retry, doubled each attempt. An object so tests can shorten it: a test of
 * the retry RULE should not have to sit through the back-off. */
export const aiRetry = { baseDelayMs: 500 }

const cancelledRequests = new Set<string>()
const cancelWaiters = new Map<string, () => void>()
/** Calls currently in the air, by cache key. See once. */
const inFlight = new Map<string, Promise<AiSignalDecision>>()
/** The same for a panel's analysts, whose answers are reports rather than decisions. */
const inFlightReports = new Map<string, Promise<AgentAnswer>>()

function cacheDirectory(): string {
  return join(app.getPath('userData'), 'aiSignalCache')
}

/** What a decision is filed under: the question, and who was asked.
 *
 * The context already carries the market, the candle and the position, so hashing it covers all
 * of them. The versions and the model are added because the same context put to a different model,
 * or under a different prompt, is a different question -- and its answer must not be served as
 * this one's. The prompt version is read off the context (an entry review names a strategy, a
 * standalone signal does not), so a key can never be built for one prompt and asked under another. */
export function aiSignalCacheKey(input: { model: string; context: AiMarketContext }): string {
  return createHash('sha256')
    .update(JSON.stringify([aiPromptVersion(input.context), aiSchemaVersion(input.context), input.model, aiContextJson(input.context)]))
    .digest('hex')
}

async function readCached(key: string, promptVersion: string): Promise<CachedDecision | null> {
  try {
    const parsed = JSON.parse(await readFile(join(cacheDirectory(), `${key}.json`), 'utf-8')) as CachedDecision
    if (parsed.promptVersion !== promptVersion) return null
    if (!parseAiSignalResponse(parsed)) return null
    // A previously-cached failure is a miss, not a hit. Writes are gated on this too, so nothing
    // new can land here -- but caches written before that gate existed are still on disk, and a
    // machine holding them would otherwise never call the model again for those candles no matter
    // how many credits were added. Refusing them here retires the poisoned entries on read.
    if (parsed.error !== null) return null
    return parsed
  } catch {
    return null
  }
}

async function writeCached(key: string, decision: CachedDecision): Promise<void> {
  await mkdir(cacheDirectory(), { recursive: true })
  await writeJsonAtomic(join(cacheDirectory(), `${key}.json`), decision)
}

function contextAt(request: AiSignalTapeRequest, index: number, position: AiPositionState): AiMarketContext {
  const context = buildAiContext(request.candles, index, {
    exchange: request.exchange,
    symbol: request.symbol,
    interval: request.interval,
    position
  })
  // decisionRange never starts before the lookback, so this is unreachable from a well-formed
  // request; it is here so a malformed one fails loudly instead of sending an empty prompt.
  if (!context) throw new Error('Not enough completed candles before this decision')
  return context
}

async function requestWithRetry(
  apiKey: string,
  model: string,
  messages: { role: 'system' | 'user'; content: string }[],
  jsonSchema: { name: string; schema: Record<string, unknown> }
): Promise<ChatCompletionResult> {
  // The id an answer is filed under is not always the id OpenRouter knows: a model asked at a
  // lower reasoning effort is the same model there, with the effort as a parameter.
  const { slug, effort } = splitAiModelId(model)
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await chatCompletion({
        apiKey,
        model: slug,
        ...(effort !== null ? { reasoningEffort: effort } : {}),
        messages,
        jsonSchema,
        maxTokens: AI_MAX_OUTPUT_TOKENS,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
      })
    } catch (error) {
      lastError = error
      // A refusal that will be the same next time is not worth a second attempt, let alone a third.
      if (error instanceof OpenRouterError && error.kind === 'fatal') break
      if (attempt === MAX_ATTEMPTS - 1) break
      await new Promise((resolve) => setTimeout(resolve, aiRetry.baseDelayMs * 2 ** attempt))
    }
  }
  throw lastError
}

function safeHold(candleTime: number, model: string, error: unknown): AiSignalDecision {
  return {
    candleTime,
    recommendation: 'hold',
    confidence: 0,
    rationale: 'Signal unavailable; held by safety fallback.',
    model,
    cached: false,
    error: error instanceof Error ? error.message : String(error)
  }
}

/** The price a context's levels were placed against: the event's own on an opportunity, the
 * last close on everything else. */
function referencePriceOf(context: AiMarketContext): number {
  return context.event?.price ?? context.lastClose
}

function interpret(result: ChatCompletionResult, context: AiMarketContext): AiAnswerVerdict {
  if (result.finishReason === 'length') {
    return { ok: false, reason: 'The answer was cut off at the output limit before it finished.' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.content)
  } catch {
    return { ok: false, reason: 'The answer was not valid JSON.' }
  }
  // An opportunity's answer is judged by its own rules: there the levels are the answer.
  return context.event !== undefined ? validateOpportunityAnswer(parsed, referencePriceOf(context)) : validateAiAnswer(parsed, referencePriceOf(context))
}

/** Fills in a cost when the response carried none, from the model's price list and the tokens the
 * response DID report. Left null when neither is known: an invented zero would read as "free". */
async function withCost(usage: AiCallUsage, model: string): Promise<AiCallUsage> {
  if (usage.costUsd !== null) return usage
  const info = await findAiModel(model)
  if (!info || info.promptPricePerToken === null || info.completionPricePerToken === null) return usage
  return {
    ...usage,
    costUsd: usage.promptTokens * info.promptPricePerToken + usage.completionTokens * info.completionPricePerToken
  }
}

/** Bookkeeping around an answer must never throw the answer away. A ledger or cache write that
 * fails is reported and the decision still stands: losing a row is a gap in the history, but
 * losing a paid answer means paying for it again. */
async function record(what: string, work: Promise<void>): Promise<void> {
  try {
    await work
  } catch (error) {
    console.error(`AI ${what} failed:`, error)
  }
}

interface AskInput {
  key: string
  apiKey: string
  model: string
  context: AiMarketContext
  candleTime: number
  source: AiCallSource
  /** Set when a route is asking for a second opinion: the model whose answer sent it on. */
  escalatedFrom?: string
  /** Set when the call is a panel's decision, the fourth of its four (shared/aiPanel.ts). */
  agent?: 'decision'
}

/** The paid path: one decision that is not in the cache. */
async function askModel(input: AskInput): Promise<AiSignalDecision> {
  await assertAiBudget()

  const promptVersion = aiPromptVersion(input.context)
  const row = {
    source: input.source,
    model: input.model,
    promptVersion,
    contextVersion: AI_CONTEXT_VERSION,
    schemaVersion: aiSchemaVersion(input.context),
    exchange: input.context.exchange,
    symbol: input.context.symbol,
    interval: input.context.interval,
    candleTime: input.candleTime,
    position: input.context.position,
    referencePrice: referencePriceOf(input.context),
    ...(input.context.strategy !== undefined ? { strategyId: input.context.strategy.id } : {}),
    ...(input.context.event !== undefined
      ? {
          eventId: marketEventId(input.context.exchange, input.context.symbol, input.context.event.time),
          eventType: input.context.event.type
        }
      : {}),
    ...(input.escalatedFrom !== undefined ? { escalatedFrom: input.escalatedFrom } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {})
  }
  const finishedAt = (): number => Math.floor(Date.now() / 1000)

  let result: ChatCompletionResult
  try {
    result = await requestWithRetry(input.apiKey, input.model, buildAiMessages(input.context), responseSchemaFor(input.context))
  } catch (error) {
    const failed: AiCallRecord = {
      ...row,
      id: randomUUID(),
      at: finishedAt(),
      status: 'failed',
      provider: null,
      usage: { promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: 0 },
      error: error instanceof Error ? error.message : String(error),
      recommendation: null,
      confidence: null,
      rationale: null,
      detail: null
    }
    await record('ledger write', appendAiCall(failed))
    // Fatal means every remaining decision would fail the same way, so the run stops here with
    // the reason instead of producing a tape of safety holds.
    if (error instanceof OpenRouterError && error.kind === 'fatal') throw error
    return safeHold(input.candleTime, input.model, error)
  }

  // From here the model has answered and been paid, usable or not.
  const usage = await withCost(result.usage, input.model)
  await record('spend record', recordAiSpend(usage.costUsd ?? 0))

  const verdict = interpret(result, input.context)
  const decision: AiSignalDecision = verdict.ok
    ? {
        candleTime: input.candleTime,
        ...verdict.signal,
        model: input.model,
        cached: false,
        error: null,
        rejected: null,
        detail: verdict.detail,
        usage
      }
    : {
        candleTime: input.candleTime,
        recommendation: 'hold',
        confidence: 0,
        rationale: '',
        model: input.model,
        cached: false,
        error: null,
        rejected: verdict.reason,
        detail: null,
        usage
      }

  // A SAFETY HOLD IS NEVER CACHED; A REJECTED ANSWER ALWAYS IS. A safety hold is the absence of a
  // decision -- the model was not reached -- and it parses as a perfectly valid one, so caching it
  // turns a transient failure into a permanent one: an account that was simply out of credits
  // produced 96 cached holds, and the rerun then reported "96 confirmed cached, at most 0 API
  // calls" and 0 trades, with nothing anywhere saying the run had never reached a model. A
  // rejection is the opposite case. The model answered, the answer was billed, and asking the
  // same question again would bill it again for what is very likely the same unusable answer.
  await record('cache write', writeCached(input.key, { ...decision, promptVersion }))
  await record(
    'ledger write',
    appendAiCall({
      ...row,
      id: input.key,
      at: finishedAt(),
      status: verdict.ok ? 'ok' : 'rejected',
      provider: result.provider,
      usage,
      error: verdict.ok ? null : verdict.reason,
      recommendation: verdict.ok ? verdict.signal.recommendation : null,
      confidence: verdict.ok ? verdict.signal.confidence : null,
      rationale: verdict.ok ? verdict.signal.rationale : null,
      detail: verdict.ok ? verdict.detail : null
    })
  )
  return decision
}

/** At most one call in the air per decision.
 *
 * One running bot is polled by its card, its detail view, the Positions page and the portfolio
 * scheduler, each on its own timer. When a new candle closes, any two of them can miss the cache
 * at the same moment and both ask the model -- two bills for one decision. The second asker joins
 * the first one's call instead, and is told the answer was not its own spend. */
async function once<T>(pending: Map<string, Promise<T>>, key: string, ask: () => Promise<T>): Promise<{ value: T; joined: boolean }> {
  const running = pending.get(key)
  if (running) return { value: await running, joined: true }
  const started = ask().finally(() => pending.delete(key))
  // A cancelled run stops waiting on this, and an unawaited rejection would otherwise be reported
  // as unhandled. Whoever does await it still receives the rejection.
  started.catch(() => undefined)
  pending.set(key, started)
  return { value: await started, joined: false }
}

async function decideOnce(key: string, ask: () => Promise<AiSignalDecision>): Promise<{ decision: AiSignalDecision; joined: boolean }> {
  const asked = await once(inFlight, key, ask)
  return { decision: asked.value, joined: asked.joined }
}

/** A promise that rejects when this run is cancelled, so a cancel is felt immediately rather than
 * after the call in the air returns. The call itself is NOT aborted: the provider has very likely
 * billed it already, so it is left to finish and cache its answer for the next run to use. */
function cancellation(requestId: string): { whenCancelled: Promise<never>; dispose: () => void } {
  let reject: (error: Error) => void = () => undefined
  const whenCancelled = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise
  })
  whenCancelled.catch(() => undefined)
  cancelWaiters.set(requestId, () => reject(new Error(CANCELLED)))
  return { whenCancelled, dispose: () => cancelWaiters.delete(requestId) }
}

export function cancelAiSignalTape(requestId: string): void {
  cancelledRequests.add(requestId)
  cancelWaiters.get(requestId)?.()
}

// ---------------------------------------------------------------------------------------------
// THE PANEL (shared/aiPanel.ts). Three analysts and a decision, each an ordinary guarded call.
//
// Nothing below adds a way to spend. A panel is reached through the tape -- named as its model,
// or as the second step of its route -- and each of its four calls passes the same gates a single
// model's one call does: the cache first, the in-flight join, the budget immediately before the
// request, the validator after it, a ledger row either way.
//
// ASKED ONE AFTER ANOTHER, not three at once. The analysts do not wait on each other and could be
// asked together, but the daily budget is checked before each call rather than reserved, so calls
// in the air are what a run can overshoot it by. One at a time keeps that at one call for a tape,
// exactly as it was.

interface AgentAnswer {
  role: AiAgentRole
  /** Null when the model was not reached, or gave an answer the validator refused. */
  report: AiAgentReport | null
  rejected: string | null
  error: string | null
  usage: AiCallUsage | null
}

/** What an analyst's answer is filed under. The same context bytes the standalone signal is keyed
 * on, under the analyst's own prompt version, so no report can be served as a decision or as
 * another analyst's. */
export function aiAgentCacheKey(input: { role: AiAgentRole; model: string; context: AiMarketContext }): string {
  return createHash('sha256')
    .update(JSON.stringify([AI_AGENT_PROMPT_VERSIONS[input.role], AI_AGENT_SCHEMA_VERSION, input.model, aiContextJson(input.context)]))
    .digest('hex')
}

async function readCachedReport(key: string, role: AiAgentRole): Promise<AgentAnswer | null> {
  try {
    const parsed = JSON.parse(await readFile(join(cacheDirectory(), `${key}.json`), 'utf-8')) as Partial<AgentAnswer> & {
      promptVersion?: string
    }
    if (parsed.promptVersion !== AI_AGENT_PROMPT_VERSIONS[role] || parsed.role !== role) return null
    // Only an answer is ever written here; anything carrying an error is not one.
    if (parsed.error !== null && parsed.error !== undefined) return null
    const usage = parsed.usage ?? null
    if (parsed.report === null || parsed.report === undefined) {
      return typeof parsed.rejected === 'string' ? { role, report: null, rejected: parsed.rejected, error: null, usage } : null
    }
    // Checked again on the way out: the report goes into a prompt, and a file on disk is not proof
    // of what was written to it.
    const verdict = validateAgentReport(role, parsed.report)
    return verdict.ok ? { role, report: verdict.report, rejected: null, error: null, usage } : null
  } catch {
    return null
  }
}

function interpretReport(role: AiAgentRole, result: ChatCompletionResult): { ok: true; report: AiAgentReport } | { ok: false; reason: string } {
  if (result.finishReason === 'length') {
    return { ok: false, reason: 'The answer was cut off at the output limit before it finished.' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.content)
  } catch {
    return { ok: false, reason: 'The answer was not valid JSON.' }
  }
  return validateAgentReport(role, parsed)
}

interface AskAgentInput {
  key: string
  apiKey: string
  role: AiAgentRole
  model: string
  context: AiMarketContext
  candleTime: number
  source: AiCallSource
  escalatedFrom?: string
}

/** The paid path for one analyst: the same steps as askModel, for an answer that is a report. */
async function askAgent(input: AskAgentInput): Promise<AgentAnswer> {
  await assertAiBudget()

  const promptVersion = AI_AGENT_PROMPT_VERSIONS[input.role]
  const row = {
    source: input.source,
    model: input.model,
    promptVersion,
    contextVersion: AI_CONTEXT_VERSION,
    schemaVersion: AI_AGENT_SCHEMA_VERSION,
    exchange: input.context.exchange,
    symbol: input.context.symbol,
    interval: input.context.interval,
    candleTime: input.candleTime,
    position: input.context.position,
    referencePrice: input.context.lastClose,
    agent: input.role,
    ...(input.escalatedFrom !== undefined ? { escalatedFrom: input.escalatedFrom } : {}),
    // An analyst makes no call on the market: there is nothing here to score.
    recommendation: null,
    detail: null
  }
  const finishedAt = (): number => Math.floor(Date.now() / 1000)

  let result: ChatCompletionResult
  try {
    result = await requestWithRetry(input.apiKey, input.model, buildAgentMessages(input.role, input.context), AI_AGENT_SCHEMAS[input.role])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await record(
      'ledger write',
      appendAiCall({
        ...row,
        id: randomUUID(),
        at: finishedAt(),
        status: 'failed',
        provider: null,
        usage: { promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: 0 },
        error: message,
        confidence: null,
        rationale: null
      })
    )
    if (error instanceof OpenRouterError && error.kind === 'fatal') throw error
    return { role: input.role, report: null, rejected: null, error: message, usage: null }
  }

  // From here the model has answered and been paid, usable or not.
  const usage = await withCost(result.usage, input.model)
  await record('spend record', recordAiSpend(usage.costUsd ?? 0))

  const verdict = interpretReport(input.role, result)
  const answer: AgentAnswer = verdict.ok
    ? { role: input.role, report: verdict.report, rejected: null, error: null, usage }
    : { role: input.role, report: null, rejected: verdict.reason, error: null, usage }

  // The rule askModel follows: an answer the model gave is cached whether it can be used or not,
  // and a call that never got one is not.
  await record(
    'cache write',
    mkdir(cacheDirectory(), { recursive: true }).then(() =>
      writeJsonAtomic(join(cacheDirectory(), `${input.key}.json`), { ...answer, promptVersion, model: input.model })
    )
  )
  await record(
    'ledger write',
    appendAiCall({
      ...row,
      id: input.key,
      at: finishedAt(),
      status: verdict.ok ? 'ok' : 'rejected',
      provider: result.provider,
      usage,
      error: verdict.ok ? null : verdict.reason,
      confidence: verdict.ok ? verdict.report.confidence : null,
      rationale: verdict.ok ? verdict.report.note : null,
      ...(verdict.ok ? { report: verdict.report } : {})
    })
  )
  return answer
}

/** What a paid step needs from the run it belongs to. */
interface RunContext {
  apiKey: string
  source: AiCallSource
  whenCancelled: Promise<never>
}

/** What several calls took together: one after another, so the latencies add up as well. Null when
 * any of them is unknown, and its cost null when any cost is -- a total that left one out would
 * read as the whole. */
function usageOfAll(usages: (AiCallUsage | null | undefined)[]): AiCallUsage | null {
  if (usages.length === 0 || usages.some((usage) => !usage)) return null
  const known = usages as AiCallUsage[]
  return {
    promptTokens: known.reduce((sum, usage) => sum + usage.promptTokens, 0),
    completionTokens: known.reduce((sum, usage) => sum + usage.completionTokens, 0),
    costUsd: known.some((usage) => usage.costUsd === null) ? null : known.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0),
    latencyMs: known.reduce((sum, usage) => sum + usage.latencyMs, 0)
  }
}

interface PanelOutcome {
  /** Null only when nothing may be asked (`run` is null) and something would have to be. */
  decision: AiSignalDecision | null
  /** Calls this run made itself: none when every answer was held or joined. */
  calls: number
  costUsd: number
  /** Calls still to make before there is a decision. Zero whenever there is one. */
  missing: number
}

/** A panel's decision for one snapshot: its three analysts in order, then the decision.
 *
 * With a `run` it asks for whatever is not held. Without one it only reads, and says how many
 * calls are missing -- which is how an estimate and a benchmark's free first pass look at a panel.
 * One function for both, so what a free pass says is held is exactly what a paid one will find.
 *
 * A PANEL THAT CANNOT HEAR FROM AN ANALYST DOES NOT DECIDE. An analyst that could not be reached
 * makes the decision a failure: uncached, counted, asked again next time. An analyst whose answer
 * the validator refused makes it a refused answer: the refusal is cached like any other, and the
 * decision is not asked for at all -- asking it to combine three reports with two would be asking
 * a different question from the one a panel is. */
async function resolvePanel(
  panelId: string,
  context: AiMarketContext,
  candleTime: number,
  run: RunContext | null,
  escalatedFrom?: string
): Promise<PanelOutcome> {
  const model = panelModelOf(panelId)
  if (model === null) throw new Error(`"${panelId}" does not name a panel of agents on a model`)
  let calls = 0
  let costUsd = 0
  const usages: (AiCallUsage | null)[] = []
  const reports: Partial<Record<AiAgentRole, AiAgentReport>> = {}
  const hold = (why: { error?: string; rejected?: string }): PanelOutcome => ({
    decision: {
      candleTime,
      recommendation: 'hold',
      confidence: 0,
      rationale: why.error !== undefined ? 'Signal unavailable; held by safety fallback.' : '',
      model: panelId,
      cached: calls === 0,
      error: why.error ?? null,
      rejected: why.rejected ?? null,
      detail: null,
      usage: usageOfAll(usages)
    },
    calls,
    costUsd,
    missing: 0
  })

  for (const [position, role] of AI_AGENT_ROLES.entries()) {
    const key = aiAgentCacheKey({ role, model, context })
    let answer = await readCachedReport(key, role)
    if (!answer) {
      // The decision cannot be asked for until every report is in, so it is missing as well.
      if (!run) return { decision: null, calls, costUsd, missing: AI_AGENT_ROLES.length - position + 1 }
      const asked = await Promise.race([
        once(inFlightReports, key, () =>
          askAgent({ key, apiKey: run.apiKey, role, model, context, candleTime, source: run.source, escalatedFrom })
        ),
        run.whenCancelled
      ])
      answer = asked.value
      // A report joined from another caller's request was not this run's spend.
      if (!asked.joined) {
        calls++
        costUsd += answer.usage?.costUsd ?? 0
      }
    }
    usages.push(answer.usage)
    if (answer.error !== null) return hold({ error: `The ${role} analyst could not be reached: ${answer.error}` })
    if (answer.report === null) return hold({ rejected: `The ${role} analyst's answer was refused: ${answer.rejected}` })
    reports[role] = answer.report
  }

  const agents = reports as AiAgentReports
  const decisionContext = withAgentReports(context, agents)
  const key = aiSignalCacheKey({ model, context: decisionContext })
  let answered: AiSignalDecision | null = await readCached(key, AI_PANEL_PROMPT_VERSION)
  if (!answered) {
    if (!run) return { decision: null, calls, costUsd, missing: 1 }
    const asked = await Promise.race([
      decideOnce(key, () =>
        askModel({ key, apiKey: run.apiKey, model, context: decisionContext, candleTime, source: run.source, escalatedFrom, agent: 'decision' })
      ),
      run.whenCancelled
    ])
    answered = asked.decision
    if (!asked.joined) {
      calls++
      costUsd += answered.usage?.costUsd ?? 0
    }
  }
  return {
    // The decision is the PANEL'S: named as the panel, and costing what all four calls cost.
    decision: { ...answered, candleTime, model: panelId, cached: calls === 0, agents, usage: usageOfAll([...usages, answered.usage]) },
    calls,
    costUsd,
    missing: 0
  }
}

/** What is already held of one decider's answer to one question, and how many calls would still
 * have to be made for it. Spends nothing. */
async function peekDecider(decider: string, context: AiMarketContext): Promise<{ decision: AiSignalDecision | null; missing: number }> {
  if (isPanelId(decider)) {
    const held = await resolvePanel(decider, context, context.decisionTime, null)
    return { decision: held.decision, missing: held.missing }
  }
  const cached = await readCached(aiSignalCacheKey({ model: decider, context }), aiPromptVersion(context))
  return cached ? { decision: cached, missing: 0 } : { decision: null, missing: 1 }
}

/** What ONE CALL made for `decider` is expected to cost, and how that is known. A panel's four
 * calls are four different prompts; this is their average, so that calls times this is the bill.
 * Each prompt is priced from its own history where it has one and from the price list where it
 * does not, and the basis reported is the weakest of the four. */
interface CallEstimate {
  costUsd: number | null
  basis: AiSignalEstimate['costBasis']
  /** How long one call has been taking, from this model's own answered calls under the same
   * prompt. Null without any: unlike a price, a pace has no published list to fall back on. */
  latencyMs: number | null
}

async function deciderCallCost(decider: string, sample: AiMarketContext | null): Promise<CallEstimate> {
  const model = panelModelOf(decider)
  if (model === null) return perCallCost(decider, sample)
  const info = await findAiModel(model)
  const prompts = [
    ...AI_AGENT_ROLES.map((role) => ({ version: AI_AGENT_PROMPT_VERSIONS[role], chars: sample ? aiAgentPromptChars(role, sample) : null })),
    { version: AI_PANEL_PROMPT_VERSION, chars: sample ? aiPanelDecisionPromptChars(sample) : null }
  ]
  let total = 0
  let basis: AiSignalEstimate['costBasis'] = 'history'
  // The four calls' time, as long as every one of them has been timed. There is no price list to
  // fall back on for time, so one untimed prompt leaves the whole figure unknown.
  let time: number | null = 0
  for (const prompt of prompts) {
    const history = await listAiCalls({ model, promptVersion: prompt.version, limit: COST_HISTORY_ROWS })
    const taken = averageCallLatencyMs(history.rows)
    time = time === null || taken === null ? null : time + taken
    const measured = averageCallCostUsd(history.rows)
    if (measured !== null) {
      total += measured
      continue
    }
    const priced = info && prompt.chars !== null ? estimateCallCostUsd(info, prompt.chars) : null
    if (priced === null) return { costUsd: null, basis: 'unknown', latencyMs: null }
    total += priced
    basis = 'pricing'
  }
  return { costUsd: total / AI_PANEL_CALLS, basis, latencyMs: time === null ? null : time / AI_PANEL_CALLS }
}

/** What one call to `model` is expected to cost, and how that is known. */
async function perCallCost(model: string, sample: AiMarketContext | null): Promise<CallEstimate> {
  // Priced from calls made under the SAME prompt: an entry review carries a strategy block and a
  // different instruction, so a standalone signal's average is not what one of these costs.
  const promptVersion = sample ? aiPromptVersion(sample) : GPT_PROMPT_VERSION
  // Asked for BY PROMPT, not filtered afterwards: the newest fifty rows of a model that has just
  // run a panel are all analysts' reports, and filtering those leaves no history at all for a
  // prompt that has plenty of it further back.
  const history = await listAiCalls({ model, promptVersion, limit: COST_HISTORY_ROWS })
  const latencyMs = averageCallLatencyMs(history.rows)
  const measured = averageCallCostUsd(history.rows)
  if (measured !== null) return { costUsd: measured, basis: 'history', latencyMs }
  const info = await findAiModel(model)
  if (info && sample) {
    const priced = estimateCallCostUsd(info, aiPromptChars(sample))
    if (priced !== null) return { costUsd: priced, basis: 'pricing', latencyMs }
  }
  return { costUsd: null, basis: 'unknown', latencyMs }
}

export async function estimateAiSignalTape(request: AiSignalTapeRequest): Promise<AiSignalEstimate> {
  // Asked for first so that a missing key is reported here, before the confirmation, rather than
  // after someone has agreed to a run that cannot start.
  await getDecryptedAiCredential()
  const { model, route } = await resolveAiPipeline(request)
  const { start, end, total } = decisionRange(request)
  const every = request.decideEveryBars ?? 1
  const atrSeries = gptAtrSeries(request.candles)
  let position = GPT_FLAT
  let cached = 0
  // Set where the walk stops: what the decision it stopped at still needs from each step. It is
  // the one open decision whose calls can be counted exactly -- its first answer may be held and
  // its second not, and a panel may hold some of its reports.
  let stoppedAt: { first: number; second: number } | null = null
  let sample: AiMarketContext | null = null
  for (let index = start; index < end; index++) {
    // The stop is checked on every candle; the model is asked only on the ones the cadence names.
    position = gptApplyStop(position, request.candles[index])
    if (!isDecisionCandle(request.candles[index].time, every, request.interval)) continue
    const context = contextAt(request, index, position.long ? 'long' : 'flat')
    sample = context
    const first = await peekDecider(model, context)
    // Position is part of later cache keys. Once one decision is missing, later keys cannot be
    // predicted safely, so the remainder is reported as a conservative maximum API-call count.
    if (!first.decision) {
      stoppedAt = { first: first.missing, second: route ? deciderCalls(route.model) : 0 }
      break
    }
    let decision = first.decision
    if (route && escalates(decision, position, route.when)) {
      const second = await peekDecider(route.model, context)
      if (!second.decision) {
        stoppedAt = { first: 0, second: second.missing }
        break
      }
      decision = second.decision
    }
    cached++
    const action = gptActionFor(decision, position)
    if (action === 'enter') position = { long: true, stop: gptStopFor(request.candles, atrSeries, index) }
    else if (action === 'exit') position = GPT_FLAT
  }
  const open = total - cached
  // Every open decision after the one the walk stopped at is counted at its ceiling. Which of them
  // the first step will pass on is not known until it has answered, so for the second step the
  // ceiling is all of them.
  const later = stoppedAt ? open - 1 : 0
  const firstCalls = (stoppedAt?.first ?? 0) + later * deciderCalls(model)
  const secondCalls = route ? (stoppedAt?.second ?? 0) + later * deciderCalls(route.model) : 0
  const maximumApiCalls = firstCalls + secondCalls
  // A bot switched on this instant has no decision due yet, so the loop above built nothing to
  // price. The context for the NEXT candle is the same size as any other, and without it the
  // confirmation that most needs a figure -- the one before a bot starts spending -- had none.
  sample ??= buildAiContext(request.candles, request.candles.length, {
    exchange: request.exchange,
    symbol: request.symbol,
    interval: request.interval,
    position: 'flat'
  })
  const cost = await deciderCallCost(model, sample)
  const secondCost = route ? await deciderCallCost(route.model, sample) : null
  const firstUsd = cost.costUsd === null ? null : cost.costUsd * firstCalls
  const secondUsd = secondCost === null ? 0 : secondCost.costUsd === null ? null : secondCost.costUsd * secondCalls
  return {
    total,
    cached,
    maximumApiCalls,
    model,
    ...(route && secondCost
      ? {
          route: {
            ...route,
            maximumApiCalls: secondCalls,
            perCallCostUsd: secondCost.costUsd,
            costBasis: secondCost.basis,
            perCallLatencyMs: secondCost.latencyMs,
            ...(deciderCalls(route.model) > 1 ? { callsPerDecision: deciderCalls(route.model) } : {})
          }
        }
      : {}),
    perCallCostUsd: cost.costUsd,
    ...(deciderCalls(model) > 1 ? { callsPerDecision: deciderCalls(model) } : {}),
    estimatedCostUsd: firstUsd === null || secondUsd === null ? null : firstUsd + secondUsd,
    costBasis: cost.basis,
    perCallLatencyMs: cost.latencyMs,
    budgetRemainingUsd: await budgetRemainingUsd(),
    ...(every > 1 ? { decideEveryBars: every } : {})
  }
}

export async function generateAiSignalTape(
  request: AiSignalTapeRequest,
  onProgress?: (progress: AiSignalProgress) => void
): Promise<AiSignalTape> {
  if (!request.requestId.trim()) throw new Error('Signal request ID is required')
  if (request.maxDecisions !== undefined && request.maxDecisions > GPT_MAX_DECISIONS) {
    throw new Error(`GPT Intraday is limited to ${GPT_MAX_DECISIONS} decisions per run`)
  }
  const { apiKey } = await getDecryptedAiCredential()
  const { model, route } = await resolveAiPipeline(request)
  const source = request.source ?? 'agent'
  const { start, end, total } = decisionRange(request)
  const every = request.decideEveryBars ?? 1
  const decisions: AiSignalDecision[] = []
  const atrSeries = gptAtrSeries(request.candles)
  let position = GPT_FLAT
  let cachedCount = 0
  let callCount = 0
  let escalated = 0
  let errorCount = 0
  let rejectedCount = 0
  let costUsd = 0
  let consecutiveFailures = 0
  // Refused answers in a row, held or new, and what the last of them was refused for.
  let consecutiveRefusals = 0
  let lastRefusal: { by: string; reason: string } | null = null
  cancelledRequests.delete(request.requestId)
  const { whenCancelled, dispose } = cancellation(request.requestId)

  const run: RunContext = { apiKey, source, whenCancelled }

  /** One decider's answer to one question: held already, or asked for now. `calls` and `costUsd`
   * are this run's own -- what it made and is billed for -- and are zero for an answer that was
   * held or joined. A model takes one call; a panel takes up to four. */
  const answerFrom = async (
    asked: string,
    context: AiMarketContext,
    candleTime: number,
    escalatedFrom?: string
  ): Promise<{ decision: AiSignalDecision; calls: number; costUsd: number }> => {
    if (isPanelId(asked)) {
      const panel = await resolvePanel(asked, context, candleTime, run, escalatedFrom)
      // With a run to ask through, a panel always comes back with a decision.
      return { decision: panel.decision as AiSignalDecision, calls: panel.calls, costUsd: panel.costUsd }
    }
    const key = aiSignalCacheKey({ model: asked, context })
    const cached = await readCached(key, GPT_PROMPT_VERSION)
    if (cached) return { decision: { ...cached, candleTime, cached: true }, calls: 0, costUsd: 0 }
    const answered = await Promise.race([
      decideOnce(key, () => askModel({ key, apiKey, model: asked, context, candleTime, source, escalatedFrom })),
      whenCancelled
    ])
    // An answer joined from another caller's request was not this run's spend.
    return answered.joined
      ? { decision: { ...answered.decision, candleTime, cached: true }, calls: 0, costUsd: 0 }
      : { decision: answered.decision, calls: 1, costUsd: answered.decision.usage?.costUsd ?? 0 }
  }

  try {
    for (let index = start; index < end; index++) {
      if (cancelledRequests.has(request.requestId)) throw new Error(CANCELLED)
      // Every candle can stop a position out, asked about or not. Skipping the stop on the candles
      // between two decisions would put "long" in the next question for a position that was
      // stopped out an hour ago: the wrong question, filed under the wrong key.
      position = gptApplyStop(position, request.candles[index])
      if (!isDecisionCandle(request.candles[index].time, every, request.interval)) continue
      const context = contextAt(request, index, position.long ? 'long' : 'flat')
      const candleTime = request.candles[index].time
      // Checked BEFORE asking, and only an answer that would have to be bought stops the run:
      // decisions already held are free to replay, refused or not. So a rerun after this has
      // stopped a run stops again at the same place without spending anything.
      if (consecutiveRefusals >= MAX_CONSECUTIVE_REFUSALS && lastRefusal !== null && (await peekDecider(model, context)).decision === null) {
        throw new Error(
          `Stopped before asking again: the last ${MAX_CONSECUTIVE_REFUSALS} answers from ${describeDecider(lastRefusal.by)} were refused, and each was billed. ` +
            `It is answering, but not in the shape asked for (${lastRefusal.reason}). Everything answered so far is cached. Choose another model under Agents → Models.`
        )
      }
      const first = await answerFrom(model, context, candleTime)
      let decision = first.decision
      callCount += first.calls
      costUsd += first.costUsd
      if (route && escalates(first.decision, position, route.when)) {
        // THE SAME CONTEXT, so the same question: the second model's answer is filed where any
        // other call to it about this candle would look, and it is not told what the first said.
        const second = await answerFrom(route.model, context, candleTime, model)
        decision = routedDecision(first.decision, second.decision)
        escalated++
        callCount += second.calls
        costUsd += second.costUsd
      }

      if (decision.cached) cachedCount++
      if (decision.rejected) {
        rejectedCount++
        consecutiveRefusals++
        lastRefusal = { by: decision.model, reason: decision.rejected }
      } else if (decision.error === null) {
        // Only an answer that was accepted ends the streak. A call that failed says nothing
        // about whether the model can answer in shape.
        consecutiveRefusals = 0
      }
      if (decision.error !== null) {
        errorCount++
        consecutiveFailures++
      } else {
        consecutiveFailures = 0
      }
      decisions.push(decision)

      // The breaker is for failures no status code names as permanent: a provider that is down, a
      // rate limit that is not lifting. Each of those is retried three times per decision already;
      // carrying on through 672 of them is two thousand requests to learn nothing new.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Under a route the failures are of DECISIONS: the first model may have answered every one
        // of them while the second could not be reached, so "calls failed in a row" would be false
        // -- and which of the two models is down is the thing someone needs to know.
        const what = route ? 'decisions in a row could not be answered' : 'AI calls failed in a row'
        const from = route ? ` (${decision.model})` : ''
        throw new Error(
          `Stopped after ${MAX_CONSECUTIVE_FAILURES} ${what}. Everything answered before that is cached. Last error${from}: ${decision.error}`
        )
      }

      const action = gptActionFor(decision, position)
      if (action === 'enter') position = { long: true, stop: gptStopFor(request.candles, atrSeries, index) }
      else if (action === 'exit') position = GPT_FLAT
      onProgress?.({ requestId: request.requestId, completed: decisions.length, total, cached: cachedCount })
    }
  } finally {
    dispose()
    cancelledRequests.delete(request.requestId)
  }

  return {
    promptVersion: GPT_PROMPT_VERSION,
    exchange: request.exchange,
    symbol: request.symbol,
    interval: request.interval,
    model,
    ...(route ? { route: { ...route, escalated } } : {}),
    decisions,
    cachedCount,
    generatedCount: decisions.length - cachedCount,
    callCount,
    errorCount,
    rejectedCount,
    costUsd
  }
}

// ---------------------------------------------------------------------------------------------
// ENTRY REVIEWS (shared/aiConfirm.ts). One decision at a time, for a bar a strategy signalled on.
//
// The tape above walks a position machine because GPT Intraday decides on every candle and its
// position is part of each question. A review is asked only where a strategy would open a
// position, and which bars those are depends on the engine's whole path -- stops, cooldowns,
// leverage -- so the renderer finds them by running the real engine
// (src/backtest/aiConfirmation.ts) and asks here about one bar at a time. Everything that guards
// a paid call is shared with the tape: the cache, the in-flight join, the budget, the ledger and
// the validator.

const CANDLE_FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const

function isCandle(value: unknown): value is Candle {
  if (typeof value !== 'object' || value === null) return false
  const candle = value as Record<string, unknown>
  return CANDLE_FIELDS.every((field) => typeof candle[field] === 'number' && Number.isFinite(candle[field]))
}

/** The question a review asks, built from a request that has been checked rather than trusted.
 *
 * The window must be EXACTLY the lookback, ending at the signal bar. A longer one would be a
 * different context -- and a different cache key -- for the same entry, which is the one thing
 * the fixed lookback exists to prevent. */
function reviewQuestion(request: AiEntryConfirmRequest): { context: AiMarketContext; signalBar: Candle } {
  if (INTERVAL_SECONDS[request.interval] === undefined) throw new Error('Unknown candle interval')
  if (typeof request.symbol !== 'string' || request.symbol.trim() === '') throw new Error('An entry review needs a symbol')
  const window = request.window
  if (!Array.isArray(window) || window.length !== GPT_LOOKBACK_BARS || !window.every(isCandle)) {
    throw new Error(
      `An entry review needs exactly ${GPT_LOOKBACK_BARS} completed candles ending at the bar the strategy signalled on`
    )
  }
  for (let index = 1; index < window.length; index++) {
    if (window[index].time <= window[index - 1].time) throw new Error('The candles of an entry review are out of order')
  }
  const context = buildAiContext(window, window.length, {
    exchange: request.exchange,
    symbol: request.symbol,
    interval: request.interval,
    position: 'flat',
    strategy: parseStrategyBlock(request.strategy)
  })
  if (!context) throw new Error('Not enough completed candles before this decision')
  return { context, signalBar: window[window.length - 1] }
}

/** What reviewing this entry would cost, and the answer if it has already been paid for. Spends
 * nothing: it reads the cache, the ledger and a price list. */
export async function peekAiEntryConfirmation(request: AiEntryConfirmRequest): Promise<AiEntryPeek> {
  const model = await resolveAiModel(request.model)
  const { context, signalBar } = reviewQuestion(request)
  const cached = await readCached(aiSignalCacheKey({ model, context }), aiPromptVersion(context))
  // Asked for only when a call would be needed, and asked for HERE so that a missing key is
  // reported before the confirmation rather than after someone has agreed to a run that cannot
  // start. A review that is already cached needs no key at all.
  if (!cached) await getDecryptedAiCredential()
  const cost = await perCallCost(model, context)
  return {
    decision: cached ? { ...cached, candleTime: signalBar.time, cached: true } : null,
    model,
    perCallCostUsd: cost.costUsd,
    costBasis: cost.basis,
    budgetRemainingUsd: await budgetRemainingUsd()
  }
}

/** One entry reviewed. Billed unless it is already cached.
 *
 * Returns the decision whatever it says; isEntryConfirmed in shared/aiConfirm.ts is what reads it.
 * A call that never reached a model comes back as a safety hold carrying `error`, is not cached,
 * and is asked again next time -- the same rule the tape follows. A refusal that will not change
 * (the key, the balance, the budget) is thrown instead, so the caller stops rather than retrying. */
export async function confirmAiEntry(request: AiEntryConfirmRequest): Promise<AiSignalDecision> {
  const model = await resolveAiModel(request.model)
  const { context, signalBar } = reviewQuestion(request)
  const key = aiSignalCacheKey({ model, context })
  const cached = await readCached(key, aiPromptVersion(context))
  if (cached) return { ...cached, candleTime: signalBar.time, cached: true }

  // Checked on the paid path only: a bar still forming has a close that moves, so its context
  // would differ on every poll and every poll would pay for a new answer about the same entry.
  if (!isBarSettled(signalBar.time, request.interval, Math.floor(Date.now() / 1000))) {
    throw new Error('The candle this entry was signalled on has not closed yet, so there is nothing settled to review.')
  }
  const { apiKey } = await getDecryptedAiCredential()
  const asked = await decideOnce(key, () =>
    askModel({ key, apiKey, model, context, candleTime: signalBar.time, source: request.source ?? 'backtest' })
  )
  return asked.joined ? { ...asked.decision, candleTime: signalBar.time, cached: true } : asked.decision
}

// ---------------------------------------------------------------------------------------------
// BENCHMARKS (shared/aiBenchmark.ts). The same flat-account questions, put to several models.
//
// NOTHING BELOW SPENDS. A benchmark's paid calls are ordinary one-decision tapes -- the renderer
// asks generateAiSignalTape above about one candle and one model at a time -- so the cache, the
// in-flight join, the budget, the ledger and the validator are the tape's, and the channels that
// can spend stay the two they were. What a benchmark needs that a tape does not is the free
// question it has to ask first: which of several hundred answers are already held, and what the
// rest would cost. That is one request here instead of one estimate per answer.

/** The question for each sampled candle, from a request that has been checked rather than trusted.
 *
 * Built by the same buildAiContext call, over the same bars, as a tape's first decision at that
 * candle. That is what makes an answer held here the answer a flat bot, a backtest or the Analyze
 * tab would be served -- and what makes a benchmark's own paid call land where this looks. */
function benchmarkQuestions(request: AiBenchmarkPeekRequest): AiMarketContext[] {
  if (request.interval !== GPT_INTRADAY_INTERVAL) {
    throw new Error('A benchmark asks the GPT Intraday question, which is only put on 15-minute candles')
  }
  if (typeof request.symbol !== 'string' || request.symbol.trim() === '') throw new Error('A benchmark needs a symbol')
  const { candles, times } = request
  if (!Array.isArray(candles) || !candles.every(isCandle)) throw new Error('A benchmark needs completed candles')
  for (let index = 1; index < candles.length; index++) {
    if (candles[index].time <= candles[index - 1].time) throw new Error('The candles of a benchmark are out of order')
  }
  if (!Array.isArray(times) || times.length === 0 || times.length > AI_BENCHMARK_MAX_DECISIONS) {
    throw new Error(`A benchmark asks between 1 and ${AI_BENCHMARK_MAX_DECISIONS} decisions of each model`)
  }
  const indexByTime = new Map(candles.map((candle, index) => [candle.time, index]))
  return times.map((time, position) => {
    if (position > 0 && !(time > times[position - 1])) throw new Error('The decisions of a benchmark are out of order')
    const index = indexByTime.get(time)
    const context =
      index === undefined
        ? null
        : buildAiContext(candles, index, {
            exchange: request.exchange,
            symbol: request.symbol,
            interval: request.interval,
            position: 'flat'
          })
    if (!context) {
      throw new Error(
        `Every benchmark decision needs a candle opening at its time and ${GPT_LOOKBACK_BARS} completed candles before it`
      )
    }
    return context
  })
}

/** Which of a benchmark's answers are already held, and what one more call to each model is
 * expected to cost. Spends nothing: it reads the cache, the ledger and a price list. */
export async function peekAiBenchmark(request: AiBenchmarkPeekRequest): Promise<AiBenchmarkPeek> {
  const requested: unknown = request.models
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > AI_BENCHMARK_MAX_MODELS) {
    throw new Error(`A benchmark compares between 1 and ${AI_BENCHMARK_MAX_MODELS} models`)
  }
  if (new Set(requested).size !== requested.length) throw new Error('A benchmark was given the same model twice')
  const models: string[] = []
  for (const model of requested) {
    // resolveAiModel reads "no model named" as "the default", which is right for a run and wrong
    // for a list: every entry here has to be a model somebody chose.
    if (typeof model !== 'string') throw new Error('A benchmark was given a model that is not a model id')
    // A panel may be set beside the models: it is asked the same questions and scored the same way.
    models.push(await resolveAiDecider(model))
  }
  const contexts = benchmarkQuestions(request)

  const held: (AiSignalDecision | null)[][] = []
  for (const model of models) {
    held.push(
      await Promise.all(
        contexts.map(async (context, position) => {
          const { decision } = await peekDecider(model, context)
          return decision ? { ...decision, candleTime: request.times[position], cached: true } : null
        })
      )
    )
  }
  // As with an entry review: a missing key is reported here, before anyone is asked to agree to a
  // run that could not start -- and only when a call would be needed. A benchmark that is already
  // paid for can be read back with no key at all.
  if (held.some((decisions) => decisions.includes(null))) await getDecryptedAiCredential()

  const peeked: AiBenchmarkModelPeek[] = []
  for (const [position, model] of models.entries()) {
    const cost = await deciderCallCost(model, contexts[0])
    peeked.push({
      model,
      decisions: held[position],
      perCallCostUsd: cost.costUsd,
      costBasis: cost.basis,
      perCallLatencyMs: cost.latencyMs,
      callsPerAnswer: deciderCalls(model)
    })
  }
  return { models: peeked, budgetRemainingUsd: await budgetRemainingUsd() }
}

// ---------------------------------------------------------------------------------------------
// OPPORTUNITIES (shared/aiOpportunity.ts). An event the scanner raised, put to a model as "is
// this a trade, and if so where, and until when?".
//
// ONE DECISION AT A TIME, like an entry review: the renderer asks about one event and one model,
// and each call is guarded exactly as every other one is -- the cache, the in-flight join, the
// validator, the ledger, the daily budget. Asking several models about one event, and asking
// about hundreds of events in a benchmark, are loops in the renderer over this one call.

/** The question for an event, from a request that has been checked rather than trusted.
 *
 * THE EVENT IS WORKED OUT HERE, FROM THE CANDLES. The request names a market and sends candles;
 * whether those candles end in an event is decided by the same detector the scanner runs, so a
 * caller cannot have a model asked -- and billed -- about a minute by saying it was interesting. */
function opportunityQuestion(request: AiOpportunityQuestion): AiMarketContext {
  if (typeof request?.symbol !== 'string' || request.symbol.trim() === '') throw new Error('An opportunity needs a symbol')
  for (const [name, candles] of [
    ['15-minute', request.candles15m],
    ['1-minute', request.candles1m]
  ] as const) {
    if (!Array.isArray(candles) || !candles.every(isCandle)) throw new Error(`An opportunity needs completed ${name} candles`)
    for (let index = 1; index < candles.length; index++) {
      if (candles[index].time <= candles[index - 1].time) throw new Error(`The ${name} candles of an opportunity are out of order`)
    }
  }
  const context = buildEventContext(request.candles15m, request.candles1m, { exchange: request.exchange, symbol: request.symbol })
  if (!context?.event) {
    throw new Error(
      'These candles do not end in an event. A model is asked only about a minute the scanner would raise, with twelve hours of 1-minute candles before it and seven days of 15-minute candles.'
    )
  }
  return context
}

/** Which models already hold an answer for this event, and what one more call to each of the
 * others is expected to cost. Spends nothing: it reads the cache, the ledger and a price list. */
export async function peekAiOpportunity(request: AiOpportunityPeekRequest): Promise<AiOpportunityPeek> {
  const requested: unknown = request?.models
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > AI_OPPORTUNITY_MAX_MODELS) {
    throw new Error(`An event is put to between 1 and ${AI_OPPORTUNITY_MAX_MODELS} models`)
  }
  if (new Set(requested).size !== requested.length) throw new Error('An event was given the same model twice')
  const models: string[] = []
  for (const model of requested) {
    if (typeof model !== 'string') throw new Error('An event was given a model that is not a model id')
    models.push(await resolveAiModel(model))
  }
  const context = opportunityQuestion(request)
  const event = context.event as NonNullable<AiMarketContext['event']>

  const held = await Promise.all(models.map((model) => readCached(aiSignalCacheKey({ model, context }), aiPromptVersion(context))))
  // A missing key is reported here, before anyone is asked to agree to a call that could not be
  // made -- and only when a call would be needed.
  if (held.includes(null)) await getDecryptedAiCredential()

  const peeked: AiOpportunityModelPeek[] = []
  for (const [position, model] of models.entries()) {
    const cost = await perCallCost(model, context)
    const cached = held[position]
    peeked.push({
      model,
      decision: cached ? { ...cached, candleTime: event.time, cached: true } : null,
      perCallCostUsd: cost.costUsd,
      costBasis: cost.basis,
      perCallLatencyMs: cost.latencyMs
    })
  }
  return {
    eventId: marketEventId(context.exchange, context.symbol, event.time),
    eventTime: event.time,
    models: peeked,
    budgetRemainingUsd: await budgetRemainingUsd()
  }
}

/** One model's answer to one event. Billed unless it is already cached.
 *
 * Returns the decision whatever it says. A call that never reached a model comes back as a safety
 * hold carrying `error`, is not cached, and is asked again next time; an answer the validator
 * refused is billed, cached and kept, and reads as no trade. A refusal that will not change (the
 * key, the balance, the budget) is thrown, so that a loop over many events stops. */
export async function askAiOpportunity(request: AiOpportunityAskRequest): Promise<AiSignalDecision> {
  const model = await resolveAiModel(request.model)
  const context = opportunityQuestion(request)
  const event = context.event as NonNullable<AiMarketContext['event']>
  const key = aiSignalCacheKey({ model, context })
  const cached = await readCached(key, aiPromptVersion(context))
  if (cached) return { ...cached, candleTime: event.time, cached: true }

  // Checked on the paid path only, as an entry review's is: a minute still forming has a close
  // that moves, so its question would differ on every look and every look would pay again.
  if (event.time > Math.floor(Date.now() / 1000)) {
    throw new Error('The minute this event was read at has not closed yet, so there is nothing settled to ask about.')
  }
  // Where a call came from is a label on its row, with one exception: a call the watch asks for
  // was agreed to by nobody at the moment it is made, so it is held to the watch's own limits.
  const source: AiCallSource = request.source === 'watch' || request.source === 'benchmark' ? request.source : 'opportunity'
  const ask = async (): Promise<AiSignalDecision> => {
    const { apiKey } = await getDecryptedAiCredential()
    const asked = await decideOnce(key, () => askModel({ key, apiKey, model, context, candleTime: event.time, source }))
    return asked.joined ? { ...asked.decision, candleTime: event.time, cached: true } : asked.decision
  }
  if (source !== 'watch') return ask()
  return withinWatchLimits({ model, eventId: marketEventId(context.exchange, context.symbol, event.time), eventTime: event.time }, ask)
}
