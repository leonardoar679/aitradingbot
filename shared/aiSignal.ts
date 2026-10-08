import { INTERVAL_SECONDS, type Candle, type Exchange, type Interval } from './ipc'
import { computeAtr } from './atr'
import type { AiAgentReports } from './aiPanel'
import type { AiEscalateWhen, AiFirstOpinion, AiRoute } from './aiRoute'

export const GPT_INTRADAY_STRATEGY_ID = 'gpt-intraday'
export const GPT_INTRADAY_INTERVAL: Interval = '15m'
/** Completed bars every decision is computed from: seven days of 15m.
 *
 * Was 64, when the prompt was 64 raw candles and nothing else. The model is now shown indicators
 * and 1h/4h views built from this window (shared/aiContext.ts), and those need the history -- a 4h
 * ADX(14) alone wants thirty four-hour bars.
 *
 * It is ONE number on purpose. The context is built from exactly this many bars however much
 * history a caller happened to fetch, so a backtest, a bot and the chart all produce the same
 * context for the same candle, and therefore the same cache key. A window that grew with the
 * caller's fetch would bill the same decision once per caller.
 *
 * An entry review (shared/aiConfirm.ts) runs on the strategy's own bar size, and uses the same
 * count of ITS bars: 112 days of 4h, 28 days of 1h. The number is a bar count, not a span. */
export const GPT_LOOKBACK_BARS = 672
export const GPT_MAX_DECISIONS = 672
/** How often GPT Intraday may be asked, in bars of its 15-minute interval: on every candle, every
 * hour, or every four hours.
 *
 * THE CEILING IS ON DECISIONS, NOT ON DAYS. Asked on every candle, 672 decisions are seven days
 * and eight or nine trades -- too few to tell a model with an edge from a coin
 * (research/gptneed.ts). Asked every four hours, the same 672 decisions at the same price are 112
 * days.
 *
 * THE QUESTION DOES NOT CHANGE. A decision at 12:00 is the same seven days of 15-minute candles
 * and the same prompt whether the model was last asked at 11:45 or at 08:00, so it is the same
 * cache entry: a slower run reuses whatever a faster one, the Analyze tab or a benchmark already
 * paid for at that candle, and they reuse it. The model is not told how often it is asked. It
 * never was.
 *
 * ON THE CLOCK. Decisions fall on multiples of the cadence since the epoch (08:00, 12:00, 16:00
 * UTC ...), not on every Nth candle from wherever a run happened to start, so a backtest and a
 * bot ask about the same candles. Between decisions nothing is asked and a position is simply
 * held; its stop is still checked on every candle. */
export const GPT_DECISION_EVERY_BARS = [1, 4, 16] as const

export function isGptDecisionEvery(value: unknown): value is (typeof GPT_DECISION_EVERY_BARS)[number] {
  return GPT_DECISION_EVERY_BARS.includes(value as (typeof GPT_DECISION_EVERY_BARS)[number])
}

/** Whether the model is asked on the candle opening at `candleTime`.
 *
 * At the fastest cadence every candle is a decision candle WHATEVER ITS TIMESTAMP. That is how
 * this strategy has always run, and a series whose bars do not sit on the quarter-hour must not
 * quietly stop being asked about. */
export function isDecisionCandle(candleTime: number, everyBars: number, interval: Interval): boolean {
  return everyBars <= 1 || candleTime % (everyBars * INTERVAL_SECONDS[interval]) === 0
}

/** The longest stretch one run can cover at this cadence, in days: 7, 28 or 112. */
export function gptMaxSpanDays(everyBars: number): number {
  return (GPT_MAX_DECISIONS * everyBars * INTERVAL_SECONDS[GPT_INTRADAY_INTERVAL]) / 86_400
}

/** Decisions in a day at this cadence: 96, 24 or 6. */
export function gptDecisionsPerDay(everyBars: number): number {
  return 86_400 / (everyBars * INTERVAL_SECONDS[GPT_INTRADAY_INTERVAL])
}

/** `15 minutes`, `hour`, `4 hours`: what follows the word "every". */
export function describeGptCadence(everyBars: number): string {
  const minutes = (everyBars * INTERVAL_SECONDS[GPT_INTRADAY_INTERVAL]) / 60
  if (minutes < 60) return `${minutes} minutes`
  return minutes === 60 ? 'hour' : `${minutes / 60} hours`
}
export const GPT_MIN_CONFIDENCE = 0.65
export const GPT_PROMPT_VERSION = 'intraday-v2'
/** The shape of the answer the model is asked for. Recorded on every call beside the prompt and
 * context versions, so a change in results can be traced to the thing that changed. */
export const AI_SCHEMA_VERSION = 'signal-v2'

/** Who bills an AI call. Every confirmation and cost line in the UI names the biller, and they
 * must all name the same one: this app used to call OpenAI directly and said so in nine places. */
export const AI_PROVIDER_LABEL = 'OpenRouter'
/** The same model the direct OpenAI path defaulted to, by its OpenRouter id. */
export const DEFAULT_AI_MODEL = 'openai/gpt-5-mini'
export const DEFAULT_AI_DAILY_CAP_USD = 1

/** An OpenRouter model id: `vendor/model`, optionally `:variant`. Checked on both sides of the
 * bridge, because the id is interpolated into a request and stored in a config file. */
export function isAiModelSlug(value: string): boolean {
  return value.length > 0 && value.length <= 100 && /^[a-zA-Z0-9._:/-]+$/.test(value)
}

/** How every OpenRouter key begins. */
export const AI_KEY_PREFIX = 'sk-or-'

/** Why a pasted value cannot be an OpenRouter key, or null when it could be one.
 *
 * Asked BEFORE the value is sent anywhere, on both sides of the bridge. A key is verified by
 * posting it to OpenRouter, and this app holds other secrets that a key field can be handed by
 * mistake: an exchange key, or the OpenAI key it used to ask for. One of those must not leave the
 * machine in order to find out that it is the wrong one. */
export function describeUnusableAiKey(value: string): string | null {
  const key = value.trim()
  if (key === '') return `${AI_PROVIDER_LABEL} API key is required`
  if (/\s/.test(key)) return `That is not one ${AI_PROVIDER_LABEL} key: it has a space or a line break in the middle.`
  if (!key.startsWith(AI_KEY_PREFIX)) return `That does not look like an ${AI_PROVIDER_LABEL} key: they start with "${AI_KEY_PREFIX}".`
  return null
}

export type AiRecommendation = 'buy' | 'sell' | 'hold'
export type AiPositionState = 'flat' | 'long'
/** Where a call came from, so the ledger can say what the money was spent on. */
export type AiCallSource = 'agent' | 'backtest' | 'bot' | 'chart' | 'benchmark' | 'opportunity' | 'watch' | 'addition'

export const AI_MARKET_REGIMES = ['strong_bull', 'bull', 'neutral', 'bear', 'strong_bear'] as const
export type AiMarketRegime = (typeof AI_MARKET_REGIMES)[number]

export const AI_RISK_LEVELS = ['low', 'medium', 'high'] as const
export type AiRiskLevel = (typeof AI_RISK_LEVELS)[number]

/** How long a call is meant to hold, in bars of the decision's own interval: 15m, 1h, 4h and 1d
 * on 15-minute candles. A closed set rather than free text, so calls can be scored against the
 * horizon they named. */
export const AI_HORIZON_BARS = [1, 4, 16, 96] as const

/** Why the model decided what it did, from a CLOSED vocabulary.
 *
 * Free-text reasons cannot be counted: "momentum is positive" and "bullish momentum" are the same
 * reason and two different strings. A fixed list is what lets the history answer "how did calls
 * citing a breakout do" at all. */
export const AI_REASON_CODES = [
  'trend_up',
  'trend_down',
  'momentum_up',
  'momentum_down',
  'breakout',
  'breakdown',
  'overbought',
  'oversold',
  'range_bound',
  'high_volatility',
  'low_volatility',
  'volume_confirms',
  'volume_absent',
  'timeframes_agree',
  'timeframes_conflict',
  'cost_exceeds_edge'
] as const
export type AiReasonCode = (typeof AI_REASON_CODES)[number]
export const AI_MAX_REASON_CODES = 5

export interface AiCredentialStatus {
  configured: boolean
  addedAt: number | null
  lastTestedAt: number | null
  lastTestOk: boolean | null
  /** True while the credential file still holds the OpenAI key from before this app used
   * OpenRouter. That key is never decrypted or sent anywhere now; the flag exists so Settings can
   * say it is there and offer to remove it, rather than leaving an unused secret on disk unseen. */
  legacyOpenAiKey: boolean
}

/** What one call consumed. `costUsd` is what OpenRouter reported charging; null when the response
 * carried no figure and the model's price list could not stand in for it. */
export interface AiCallUsage {
  promptTokens: number
  completionTokens: number
  costUsd: number | null
  latencyMs: number
}

/** Where a recommendation says to enter, and for how many minutes that holds. Only an answer to
 * an opportunity question carries one (shared/aiOpportunity.ts). */
export interface AiEntryWindow {
  min: number
  max: number
  validMinutes: number
}

/** Everything a usable answer carries beyond the three fields the position machine acts on.
 *
 * Nothing here is executed. The stop and target in particular are the MODEL'S levels, recorded so
 * they can be scored against what the market did; the strategy still places its own ATR stop. */
export interface AiSignalDetail {
  marketRegime: AiMarketRegime
  riskLevel: AiRiskLevel
  horizonBars: number
  stopLoss: number | null
  takeProfit: number | null
  reasonCodes: AiReasonCode[]
  /** Set when the model proposed levels that were thrown away, saying why. Null otherwise. */
  levelsNote: string | null
  /** Present on an answer to an opportunity question: null for a call not to trade, the entry
   * range for a call to. ABSENT on every other answer, so a signal cached before opportunities
   * existed still reads as the signal it was. */
  entry?: AiEntryWindow | null
}

export interface AiSignalDecision {
  candleTime: number
  recommendation: AiRecommendation
  confidence: number
  rationale: string
  model: string
  cached: boolean
  error: string | null
  /** The ledger row this decision was written as (its cache key when the model answered, a random
   * id when it did not), and the question's version, since 8 October 2026: what a trade made of it
   * is joined to it by. Absent on decisions written before. */
  callId?: string
  promptVersion?: string
  /** Why the validator refused the model's answer; null or absent when it was usable.
   *
   * Distinct from `error`, and the difference is who was paid. An `error` means the model was
   * never reached, so nothing is cached and the call is tried again. A rejection means the model
   * DID answer and was billed for it, so the verdict is cached like any other answer -- asking
   * again would pay again for the same question. Either way it acts as a hold. */
  rejected?: string | null
  /** Absent on a safety hold and on a rejected answer. */
  detail?: AiSignalDetail | null
  /** What the call that produced this decision cost. Kept on a cached decision too, where it
   * describes the original call rather than a new one -- `cached` says which. */
  usage?: AiCallUsage | null
  /** Present when a route passed this decision on to its second model (shared/aiRoute.ts): what
   * the first model had said. Everything else on the decision is then the SECOND model's answer.
   * Never written to the cache, where each model's answer is filed on its own. */
  first?: AiFirstOpinion | null
  /** Present on a decision a panel of agents reached (shared/aiPanel.ts): what its three analysts
   * reported before the decision was made. `model` is then the panel's id, and `usage` is what all
   * four calls took together. Like `first`, assembled when the decision is read and never cached:
   * each call's answer is filed on its own. */
  agents?: AiAgentReports | null
}

export interface AiSignalTapeRequest {
  requestId: string
  exchange: Exchange
  symbol: string
  interval: Interval
  candles: Candle[]
  /** First execution-candle index. Its prompt ends at candles[startIndex - 1]. */
  startIndex: number
  maxDecisions?: number
  /** Ask only on candles that fall on this many bars of the clock; see GPT_DECISION_EVERY_BARS.
   * Absent means every candle. */
  decideEveryBars?: number
  /** The model to ask. Absent means the configured default. A bot passes the model it was
   * enabled with, so changing the default cannot silently re-ask its whole history elsewhere.
   * May name a panel of agents instead (shared/aiPanel.ts), which the default never is. */
  model?: string
  /** A second model or panel, and when a decision is passed on to it (shared/aiRoute.ts). Absent
   * or null means one model decides alone.
   *
   * NAMED BY THE CALLER, NEVER READ FROM THE SETTINGS HERE. A route can double what a decision
   * costs, so it runs only where a caller asked for it by name: a backtest and a bot being
   * switched on, both of which state it in their confirmation first. A bot switched on before
   * routes existed, the chart and the Analyze tab name none, and go on asking one model. */
  route?: AiRoute | null
  source?: AiCallSource
}

/** How a tape's route was used. */
export interface AiSignalTapeRoute extends AiRoute {
  /** Decisions that were passed on to the second model. */
  escalated: number
}

export interface AiSignalTape {
  promptVersion: string
  exchange: Exchange
  symbol: string
  interval: Interval
  /** The model every decision on this tape was asked of. With a route, the first model. */
  model: string
  /** Present when the tape was decided under a route. */
  route?: AiSignalTapeRoute
  decisions: AiSignalDecision[]
  /** Decisions this run made no call for at all. */
  cachedCount: number
  /** Decisions this run made at least one call for. */
  generatedCount: number
  /** Model calls this run made, answered or not. The same as generatedCount with one model; under
   * a route a decision can take two. */
  callCount: number
  /** Decisions that never reached a model answer and fell back to a safety hold.
   *
   * Exposed because a tape of nothing but failures is indistinguishable, downstream, from a tape
   * of genuine holds: both produce zero entries and a backtest that reports 0 trades, 0.00% and a
   * health check blaming the strategy. An account with no credits returned 96 of these and the
   * results page called it a clean run. Callers must say so rather than render the placeholder. */
  errorCount: number
  /** Answers the model gave that the validator refused. They act as holds, and unlike errors they
   * are a fact about the model rather than about the connection. */
  rejectedCount: number
  /** What the calls made for THIS tape cost. Cached decisions contribute nothing. */
  costUsd: number
}

export interface AiSignalProgress {
  requestId: string
  completed: number
  total: number
  cached: number
}

/** The second model's share of an estimate. */
export interface AiRouteEstimate {
  model: string
  when: AiEscalateWhen
  /** The most calls the second model can be asked for: every decision not already settled could
   * be passed on to it. */
  maximumApiCalls: number
  /** One CALL's expected cost. A panel makes four of them a decision; see `callsPerDecision`. */
  perCallCostUsd: number | null
  costBasis: 'history' | 'pricing' | 'unknown'
  /** How long one call to it has been taking here, in milliseconds: an average of its own answered
   * calls under the same prompt. Null or absent when it has not been called here -- there is no
   * price list for time. */
  perCallLatencyMs?: number | null
  /** Present when one decision takes more than one call: the second step is a panel. */
  callsPerDecision?: number
}

export interface AiSignalEstimate {
  total: number
  /** Decisions already settled from the cache. Under a route that takes both answers wherever the
   * first one is passed on. */
  cached: number
  /** Every call the run could make, to either model. Zero means the run is free. */
  maximumApiCalls: number
  model: string
  /** Present when the run is routed: the second model, and how much of `maximumApiCalls` is its. */
  route?: AiRouteEstimate
  /** One call's expected cost, or null when nothing is known about what this model costs. With a
   * route, one call to the FIRST model. */
  perCallCostUsd: number | null
  /** Present when one decision by `model` takes more than one call: it is a panel. */
  callsPerDecision?: number
  /** Each model's calls at its own price, added up. An upper bound on the count, an estimate on
   * the price. Null when a model that would be called has no known price. */
  estimatedCostUsd: number | null
  /** Where the per-call figure came from: this model's own recent calls, its published price
   * list, or nowhere. Shown beside the number so a guess is not read as a measurement. */
  costBasis: 'history' | 'pricing' | 'unknown'
  /** How long one call to it has been taking here, in milliseconds: an average of its own answered
   * calls under the same prompt. Null or absent when it has not been called here -- there is no
   * price list for time. */
  perCallLatencyMs?: number | null
  /** What is left of today's AI budget. A run stops when it reaches zero. */
  budgetRemainingUsd: number
  /** The cadence the run was estimated at, when it is not every candle. */
  decideEveryBars?: number
}

export interface ParsedAiSignal {
  recommendation: AiRecommendation
  confidence: number
  rationale: string
}

/** The three fields the position machine acts on. Also what a cached decision is checked against. */
export function parseAiSignalResponse(value: unknown): ParsedAiSignal | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.recommendation !== 'buy' && record.recommendation !== 'sell' && record.recommendation !== 'hold') {
    return null
  }
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return null
  if (record.confidence < 0 || record.confidence > 1) return null
  if (typeof record.rationale !== 'string') return null
  return {
    recommendation: record.recommendation,
    confidence: record.confidence,
    rationale: record.rationale.slice(0, 500)
  }
}

export type AiAnswerVerdict =
  | { ok: true; signal: ParsedAiSignal; detail: AiSignalDetail }
  | { ok: false; reason: string }

function isOneOf<T>(allowed: readonly T[], value: unknown): value is T {
  return allowed.includes(value as T)
}

/** A price level: null, or a positive finite number. */
function isLevel(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

/** Decides whether a model's answer can be used, and what of it.
 *
 * THE SCHEMA IS NOT THE AUTHORITY. The request asks OpenRouter to enforce a strict JSON schema,
 * but that schema carries only types and enums -- providers disagree about which range keywords
 * they honour -- so every range is checked here, and so is everything else. An answer that fails
 * is refused whole; it never becomes a trade.
 *
 * Two different outcomes, deliberately:
 *
 *   A malformed FIELD (an unknown regime, a confidence of 3, a stop of -1) refuses the answer.
 *   The model did not say something usable.
 *
 *   Levels that are well formed but make no sense for the action (a buy whose stop is above the
 *   price) discard THE LEVELS and keep the action. Nothing in this app executes on a
 *   model-proposed stop or target -- the strategy places its own ATR stop -- so refusing a
 *   coherent buy over a field nothing reads would throw away the part that matters. The note says
 *   what was dropped, and it is the rule to revisit before anything ever does act on these.
 *
 * `referencePrice` is the last close the model was shown, which is the only price it could have
 * placed its levels against. */
export function validateAiAnswer(value: unknown, referencePrice: number): AiAnswerVerdict {
  const signal = parseAiSignalResponse(value)
  if (!signal) return { ok: false, reason: 'recommendation, confidence or rationale is missing or out of range' }
  const record = value as Record<string, unknown>

  if (!isOneOf(AI_MARKET_REGIMES, record.marketRegime)) return { ok: false, reason: 'marketRegime is not an allowed value' }
  if (!isOneOf(AI_RISK_LEVELS, record.riskLevel)) return { ok: false, reason: 'riskLevel is not an allowed value' }
  if (!isOneOf<number>(AI_HORIZON_BARS, record.horizonBars)) return { ok: false, reason: 'horizonBars is not an allowed value' }
  if (!isLevel(record.stopLoss)) return { ok: false, reason: 'stopLoss is not a price or null' }
  if (!isLevel(record.takeProfit)) return { ok: false, reason: 'takeProfit is not a price or null' }
  if (!Array.isArray(record.reasonCodes) || !record.reasonCodes.every((code) => isOneOf(AI_REASON_CODES, code))) {
    return { ok: false, reason: 'reasonCodes holds a value outside the allowed list' }
  }

  let stopLoss = record.stopLoss
  let takeProfit = record.takeProfit
  let levelsNote: string | null = null
  if (signal.recommendation !== 'buy') {
    if (stopLoss !== null || takeProfit !== null) levelsNote = 'Levels ignored: only a buy carries a stop and a target.'
    stopLoss = null
    takeProfit = null
  } else if (stopLoss !== null && stopLoss >= referencePrice) {
    levelsNote = `Levels discarded: the stop (${stopLoss}) is not below the price (${referencePrice}).`
    stopLoss = null
    takeProfit = null
  } else if (takeProfit !== null && takeProfit <= referencePrice) {
    levelsNote = `Levels discarded: the target (${takeProfit}) is not above the price (${referencePrice}).`
    stopLoss = null
    takeProfit = null
  }

  return {
    ok: true,
    signal,
    detail: {
      marketRegime: record.marketRegime,
      riskLevel: record.riskLevel,
      horizonBars: record.horizonBars,
      stopLoss,
      takeProfit,
      reasonCodes: [...new Set(record.reasonCodes as AiReasonCode[])].slice(0, AI_MAX_REASON_CODES),
      levelsNote
    }
  }
}

/** The candles a tape walks, and how many of them it decides on.
 *
 * `start` to `end` is the stretch whose stops are applied, one candle at a time; `total` is the
 * number of decision candles in it, which is what the ceiling counts. `end` is one past the last
 * decision candle: nothing after it is asked about, so nothing after it needs walking. */
export function decisionRange(request: AiSignalTapeRequest): { start: number; end: number; total: number } {
  if (request.interval !== GPT_INTRADAY_INTERVAL) {
    throw new Error('GPT Intraday only supports 15-minute candles')
  }
  const every = request.decideEveryBars ?? 1
  if (!isGptDecisionEvery(every)) {
    throw new Error('GPT Intraday can be asked every 15 minutes, every hour or every four hours')
  }
  const start = Math.max(GPT_LOOKBACK_BARS, Math.floor(request.startIndex))
  const requested = request.maxDecisions ?? GPT_MAX_DECISIONS
  const limit = Math.min(GPT_MAX_DECISIONS, Math.max(0, Math.floor(requested)))
  let total = 0
  let end = start
  for (let index = start; index < request.candles.length && total < limit; index++) {
    if (!isDecisionCandle(request.candles[index].time, every, request.interval)) continue
    total++
    end = index + 1
  }
  return { start, end, total }
}

/** The completed bars a decision at `executionIndex` may read: the lookback ending one bar before
 * it, and nothing at or after it. shared/aiContext.ts builds everything a model is shown from
 * exactly this slice. */
export function promptWindow(candles: Candle[], executionIndex: number): Candle[] {
  if (executionIndex < GPT_LOOKBACK_BARS || executionIndex > candles.length) return []
  return candles.slice(executionIndex - GPT_LOOKBACK_BARS, executionIndex)
}

// ---------------------------------------------------------------------------------------------
// THE POSITION MACHINE, ONCE.
//
// GPT Intraday decides in three places and they must agree exactly: estimateAiSignalTape walks it
// to predict cache keys, generateAiSignalTape walks it to fill in each prompt's `position`, and
// generateGptIntradaySignals walks it to emit the entries and exits the engine executes. The
// position is not cosmetic in any of them -- it is IN the prompt and IN the cache key, so a
// disagreement means the model was asked the wrong question and the answer was filed under the
// wrong key.
//
// They had already drifted twice. The service used a plain 14-bar mean of true ranges while the
// engine used Wilder smoothing (11.6% apart on average, 61% at worst), and the confidence gate was
// spelled 0.65 in the service and GPT_MIN_CONFIDENCE in the strategy. A third difference survived
// both of those fixes: on a zero ATR the service placed the stop at `close - 0 * 1.5`, which IS
// the close, so the position stopped out on its own entry candle -- while the strategy fell back
// to a fixed fraction. Three copies of a rule is the defect; these functions are the fix.

export const GPT_ATR_PERIOD = 14
export const GPT_ATR_STOP_MULTIPLE = 1.5
export const GPT_FALLBACK_STOP_FRACTION = 0.03

export interface GptPosition {
  long: boolean
  stop: number | null
}

export const GPT_FLAT: GptPosition = { long: false, stop: null }

/** The ATR series the stop is placed from -- Wilder, the same estimator the engine uses. */
export function gptAtrSeries(candles: Candle[]): number[] {
  return computeAtr(candles, GPT_ATR_PERIOD)
}

/** The stop an entry at `index` receives.
 *
 * The fallback covers two unusable readings, not one: NaN before the ATR seed index, and ZERO on a
 * flat series. Zero is the dangerous one because it is finite and arithmetic on it succeeds
 * silently, placing the stop exactly at the entry close. */
export function gptStopFor(candles: Candle[], atr: number[], index: number): number {
  const reference = atr[index - 1]
  const distance =
    Number.isFinite(reference) && reference > 0
      ? reference * GPT_ATR_STOP_MULTIPLE
      : candles[index].close * GPT_FALLBACK_STOP_FRACTION
  return Math.max(0, candles[index].close - distance)
}

/** Stop-out, evaluated before the bar's own decision -- a stop set yesterday fires on today's low
 * whatever the model says today. */
export function gptApplyStop(position: GptPosition, candle: Candle): GptPosition {
  if (position.long && position.stop !== null && candle.low <= position.stop) return GPT_FLAT
  return position
}

export type GptAction = 'enter' | 'exit' | 'none'

/** What a decision does, given the position carried into the bar.
 *
 * A decision carrying an error is not a decision: safeHold parses as a perfectly valid `hold`, so
 * the error field is the only thing separating "the model said hold" from "the model was never
 * reached". Confidence 0 already fails the gate, but relying on that couples this rule to the
 * shape of the fallback rather than to its meaning. A rejected answer is refused here for the same
 * reason: it is stored as a zero-confidence hold, and that is its shape, not its meaning. */
export function gptActionFor(decision: AiSignalDecision | undefined, position: GptPosition): GptAction {
  if (!decision || decision.error !== null || decision.rejected || decision.confidence < GPT_MIN_CONFIDENCE) return 'none'
  if (decision.recommendation === 'buy' && !position.long) return 'enter'
  if (decision.recommendation === 'sell' && position.long) return 'exit'
  return 'none'
}
