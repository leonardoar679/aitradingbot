import type { AiCallRecord } from './aiLedger'
import { pacedMinimumMs } from './aiPace'
import { describeDecider, isPanelId } from './aiPanel'
import { describeEscalation, type AiRoute } from './aiRoute'
import { AI_PROVIDER_LABEL, GPT_MAX_DECISIONS, describeGptCadence, type AiSignalEstimate } from './aiSignal'
import type { AiWatchConfig } from './aiWatch'
import type { AiWatchPaperConfig } from './aiWatchPaper'

// What AI calls cost, and what bounds them.
//
// This app spends the user's own money every time it asks a model something, on an account they
// top up themselves. Three things follow, and each is a function here so it can be tested without
// a network: the spend is bounded by a daily budget enforced in the main process, every run that
// can spend says roughly how much before it starts, and the ledger can be added up afterwards.

/** What OpenRouter says about the key in use. `limit*` are null for a key with no spending cap of
 * its own, which is not the same as a key with credit to spare. */
export interface AiKeyInfo {
  label: string
  usageUsd: number
  limitUsd: number | null
  limitRemainingUsd: number | null
  isFreeTier: boolean
}

export interface AiModelInfo {
  id: string
  name: string
  contextLength: number | null
  /** USD per token. Null where OpenRouter publishes no fixed price (its auto-router, for one). */
  promptPricePerToken: number | null
  completionPricePerToken: number | null
  /** Whether the model can be held to a strict JSON schema. Only these can be enabled: the
   * validator still checks every answer, but a model that cannot be constrained at all would
   * spend most of its calls producing text the validator then refuses. */
  structuredOutputs: boolean
  /** Whether the model takes a reasoning effort. Only these can be enabled at a lower one
   * (shared/aiEffort.ts): asked of a model that does not, the request has no provider to go to. */
  reasoning: boolean
}

export interface AiModelCatalogue {
  models: AiModelInfo[]
  /** Unix seconds, or null when no catalogue has ever been fetched. */
  fetchedAt: number | null
}

export interface AiConfig {
  defaultModel: string
  enabledModels: string[]
  /** The second model a GPT Intraday backtest, or a bot being switched on, is routed to, and when
   * (shared/aiRoute.ts). Null when one model decides alone. The default model is the first. */
  route: AiRoute | null
  /** Zero switches AI calls off. */
  dailyCapUsd: number
  spentTodayUsd: number
  /** Events put to models without a click, and its limits (shared/aiWatch.ts). Off unless
   * switched on. */
  watch: AiWatchConfig
  /** Paper positions the watch opens by itself on one model's calls (shared/aiWatchPaper.ts). Off
   * unless switched on, and never anything but paper. */
  watchPaper: AiWatchPaperConfig
  /** The most calls that start to any one model in a minute, whoever asks (shared/aiPace.ts). */
  callsPerMinute: number
}

export interface AiConfigPatch {
  defaultModel?: string
  enabledModels?: string[]
  /** Null switches routing off. */
  route?: AiRoute | null
  dailyCapUsd?: number
  /** Only the fields given are changed. */
  watch?: Partial<AiWatchConfig>
  /** Only the fields given are changed. */
  watchPaper?: Partial<AiWatchPaperConfig>
  /** One of AI_CALLS_PER_MINUTE_CHOICES. */
  callsPerMinute?: number
}

/** `$0.0021`, `$0.0113`, `$1.40`. Up to four decimals under ten cents, because that is where a
 * single call's cost lives: at two decimals a $0.0019 call reads as free, and a $0.0149 call reads
 * as a third cheaper than it is. Trailing zeros past the cents are dropped, so `$0.05` stays `$0.05`. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs === 0) return '$0.00'
  if (abs < 0.0001) return '<$0.0001'
  if (abs < 0.1) return `$${value.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1')}`
  return `$${value.toFixed(2)}`
}

/** Why a call may not be made right now, or null when it may.
 *
 * The budget is a guard against a loop, not the consent to spend: every path that can spend still
 * asks first. This catches what a confirmation cannot -- a bot left running, a model that costs
 * fifty times what the last one did. The message says the cache is intact because that is the
 * first thing someone stopped mid-run needs to know. */
export function budgetProblem(capUsd: number, spentUsd: number): string | null {
  if (!(capUsd > 0)) {
    return 'AI calls are switched off: the daily AI budget is $0. Raise it under Agents → Usage.'
  }
  if (spentUsd >= capUsd) {
    return (
      `Today's AI budget is used up (${formatUsd(spentUsd)} of ${formatUsd(capUsd)}). Everything generated so far is ` +
      'cached, so nothing is lost: raise the budget under Agents → Usage, or run again after midnight UTC.'
    )
  }
  return null
}

/** JSON full of numbers tokenises densely, so this deliberately assumes fewer characters per token
 * than prose would. An estimate that runs high is a nuisance; one that runs low is a surprise on
 * someone's bill. */
const CHARS_PER_PROMPT_TOKEN = 2.5
/** Reasoning models bill their thinking as output, and it dwarfs the short JSON answer. */
const ESTIMATED_COMPLETION_TOKENS = 1200

/** One call's cost from a model's price list, for a model with no call history yet. */
export function estimateCallCostUsd(
  model: Pick<AiModelInfo, 'promptPricePerToken' | 'completionPricePerToken'>,
  promptChars: number
): number | null {
  if (model.promptPricePerToken === null || model.completionPricePerToken === null) return null
  const promptTokens = Math.ceil(promptChars / CHARS_PER_PROMPT_TOKEN)
  return promptTokens * model.promptPricePerToken + ESTIMATED_COMPLETION_TOKENS * model.completionPricePerToken
}

/** What this model's answered calls have actually cost, averaged. Null without a single priced
 * row. Failed calls are left out: they cost nothing and would drag the average toward zero. */
export function averageCallCostUsd(rows: AiCallRecord[]): number | null {
  const priced = rows.filter((row) => row.status !== 'failed' && row.usage.costUsd !== null)
  if (priced.length === 0) return null
  return priced.reduce((sum, row) => sum + (row.usage.costUsd ?? 0), 0) / priced.length
}

/** How long this model's answered calls have taken, averaged. Null without one. A failed call's
 * time is the time it took to fail, which says nothing about how long an answer takes. */
export function averageCallLatencyMs(rows: AiCallRecord[]): number | null {
  const timed = rows.filter((row) => row.status !== 'failed' && row.usage.latencyMs > 0)
  if (timed.length === 0) return null
  return timed.reduce((sum, row) => sum + row.usage.latencyMs, 0) / timed.length
}

/** `about 40 seconds`, `about 12 minutes`, `about 2 hours 25 minutes`. Rounded as coarsely as the
 * figure deserves: it is a pace multiplied by a count, not a schedule. */
export function describeDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 90) {
    const whole = Math.max(1, Math.round(seconds))
    return `about ${whole} ${whole === 1 ? 'second' : 'seconds'}`
  }
  const minutes = seconds / 60
  if (minutes < 90) return `about ${Math.round(minutes)} minutes`
  let hours = Math.floor(minutes / 60)
  let rest = Math.round((minutes - hours * 60) / 5) * 5
  if (rest === 60) {
    hours++
    rest = 0
  }
  const whole = `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  return rest === 0 ? `about ${whole}` : `about ${whole} ${rest} minutes`
}

/** How long a tape's calls will take, as a sentence for its confirmation, or null when the run
 * makes none.
 *
 * A TAPE ASKS ONE QUESTION AT A TIME, so its calls add up: 672 of them at thirteen seconds is two
 * and a half hours, and the price alone -- two dollars -- says nothing of that. The first real run
 * is what showed it; against a faked transport every call took twenty milliseconds. */
function describeRunTime(estimate: AiSignalEstimate): string | null {
  if (estimate.maximumApiCalls === 0) return null
  const route = estimate.route
  const secondCalls = route?.maximumApiCalls ?? 0
  const firstCalls = estimate.maximumApiCalls - secondCalls
  const first = estimate.perCallLatencyMs ?? null
  const second = route ? (route.perCallLatencyMs ?? null) : null
  if ((firstCalls > 0 && first === null) || (secondCalls > 0 && second === null)) {
    return route
      ? 'How long that takes is not known: one of the two has not been called here yet. Calls are made one after another.'
      : 'How long that takes is not known: this model has not been called here yet. Calls are made one after another.'
  }
  const total = firstCalls * (first ?? 0) + secondCalls * (second ?? 0)
  const kept = 'It can be cancelled, and what has been answered stays cached.'
  if (route) return `One call after another, that is up to ${describeDuration(total)} at the pace the two have answered here. ${kept}`
  return `One call after another, that is ${describeDuration(total)}: it has been taking ${describePace(first ?? 0)} here. ${kept}`
}

/** `13 seconds a call`. A pace is said in whole seconds, and one too short for that is said so
 * rather than printed as zero. */
function describePace(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return 'under a second a call'
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'} a call`
}

/** One model's share of a routed run, as a line of the confirmation. A panel's line says why its
 * count is what it is: four calls for each decision it is handed. */
function routedCallsLine(
  model: string,
  calls: number,
  perCallCostUsd: number | null,
  basis: AiSignalEstimate['costBasis'],
  callsPerDecision = 1
): string {
  const name = describeDecider(model)
  if (calls === 0) return `  ${name}: nothing to ask, its answers are cached`
  const each = callsPerDecision > 1 ? `, ${callsPerDecision} for each decision passed on` : ''
  const asked = `up to ${calls.toLocaleString()} ${calls === 1 ? 'call' : 'calls'}${each}`
  if (perCallCostUsd === null) return `  ${name}: ${asked}, cost not known (no call history here and no published price)`
  const from = basis === 'history' ? 'going by its recent calls here' : 'going by its price list, an estimate'
  return `  ${name}: ${asked}, about ${formatUsd(perCallCostUsd * calls)} ${from}`
}

/** What someone is agreeing to before a run that can spend, in one message.
 *
 * States the model, because the same 672 calls are thirty cents on one and thirty dollars on
 * another. States where the figure came from, because a price-list guess for a model that has
 * never been called here is not the same kind of number as an average of what it actually cost.
 * And states what happens when the budget runs out, because the answer -- it stops, and nothing
 * generated is lost -- is the difference between a cap that is safe to hit and one that is not.
 *
 * A ROUTED RUN IS PRICED PER MODEL, AT ITS CEILING. Which decisions the first model passes on is
 * not known until it has answered, so the second model's line is every decision still open. That
 * overstates what a route usually costs and says so; the alternative is a guess at how often a
 * model will want to trade, printed as though it were a price. */
export function describeAiRunCost(estimate: AiSignalEstimate): string {
  const candles = estimate.total === 1 ? '1 candle' : `${estimate.total} candles`
  const calls = estimate.maximumApiCalls === 1 ? '1 model call' : `${estimate.maximumApiCalls} model calls`
  const route = estimate.route
  let price: string
  if (estimate.maximumApiCalls === 0) {
    price = 'Every decision is already cached, so nothing will be spent.'
  } else if (route) {
    const asked = `${describeDecider(route.model)} is asked only when ${estimate.model} ${describeEscalation(route.when)}`
    price = [
      `At most ${calls} may be made:`,
      routedCallsLine(estimate.model, estimate.maximumApiCalls - route.maximumApiCalls, estimate.perCallCostUsd, estimate.costBasis),
      routedCallsLine(route.model, route.maximumApiCalls, route.perCallCostUsd, route.costBasis, route.callsPerDecision),
      estimate.estimatedCostUsd === null
        ? `What that comes to in all is not known; ${asked}.`
        : `About ${formatUsd(estimate.estimatedCostUsd)} in all if every decision were passed on. That is the ceiling: ${asked}.`
    ].join('\n')
  } else if (estimate.estimatedCostUsd === null) {
    price = `At most ${calls} may be made. What they will cost is not known: this model has no call history here and no published price.`
  } else {
    const basis =
      estimate.costBasis === 'history'
        ? "going by this model's recent calls here"
        : 'going by its price list, an estimate, since it has not been called here yet'
    price = `At most ${calls} may be made, about ${formatUsd(estimate.estimatedCostUsd)} ${basis}.`
  }
  // Said only when it is not every candle: "672 candles" is seven days at one cadence and 112 at
  // another, and the count alone does not say which run is being agreed to.
  const spaced = estimate.decideEveryBars !== undefined && estimate.decideEveryBars > 1 ? `, one every ${describeGptCadence(estimate.decideEveryBars)},` : ''
  const second = route
    ? ` When it ${describeEscalation(route.when)}, ${describeDecider(route.model)} is asked the same question and its answer is the one that counts.`
    : ''
  const time = describeRunTime(estimate)
  return [
    `GPT Intraday will evaluate ${candles}${spaced} with ${describeDecider(estimate.model)} through ${AI_PROVIDER_LABEL}.${second} ${estimate.cached} are confirmed cached.`,
    '',
    price,
    ...(time !== null ? [time] : []),
    `${formatUsd(estimate.budgetRemainingUsd)} of today's AI budget is left. If it runs out the run stops, and everything generated up to then stays cached.`,
    '',
    'Continue?'
  ].join('\n')
}

export interface AiConfirmCostInput {
  strategyName: string
  model: string
  /** Rulings already held, which cost nothing to use again. */
  cached: number
  /** Entries still to be ruled on if every one of them is confirmed. */
  openQuestions: number
  perCallCostUsd: number | null
  costBasis: AiSignalEstimate['costBasis']
  budgetRemainingUsd: number
}

/** The same question describeAiRunCost asks, for a run where a model reviews a strategy's entries.
 *
 * The unit is the TRADE: a veto removes the whole trade the strategy would have taken, so a model
 * is asked once for each of them and never again about the same one. On a spot run that makes the
 * count exact. It is still stated as "about", because with leverage it is not -- a vetoed trade
 * is one that never liquidated the account, and the run then goes on to entries the strategy
 * alone would not have lived to reach -- and the ceiling a run cannot pass is named for that case. */
export function describeAiConfirmCost(input: AiConfirmCostInput): string {
  const calls = input.openQuestions === 1 ? '1 model call is' : `${input.openQuestions} model calls are`
  let price: string
  if (input.perCallCostUsd === null) {
    price = 'What they will cost is not known: this model has no call history here and no published price.'
  } else {
    const basis =
      input.costBasis === 'history'
        ? "going by this model's recent reviews here"
        : 'going by its price list, an estimate, since it has not reviewed an entry here yet'
    price = `That is about ${formatUsd(input.perCallCostUsd * input.openQuestions)} ${basis}.`
  }
  return [
    `${input.strategyName} will ask ${input.model} through ${AI_PROVIDER_LABEL} to confirm or veto each trade it would take, ` +
      `once per trade. ${input.cached} ${input.cached === 1 ? 'review is' : 'reviews are'} already cached.`,
    '',
    `About ${calls} expected, one for each position the strategy would still open. ${price}`,
    `A run never reviews more than ${GPT_MAX_DECISIONS} entries.`,
    `${formatUsd(input.budgetRemainingUsd)} of today's AI budget is left. If it runs out the run stops, and everything answered up to then stays cached.`,
    '',
    'Continue?'
  ].join('\n')
}

export interface AiBenchmarkCostModel {
  model: string
  /** Answers already held, which cost nothing to use again. */
  cached: number
  toAsk: number
  /** One CALL's expected cost. */
  perCallCostUsd: number | null
  costBasis: AiSignalEstimate['costBasis']
  /** One call's measured time here, in milliseconds. Null or absent when it has not been called. */
  perCallLatencyMs?: number | null
  /** Calls one answer takes: absent or 1 for a model, four for a panel of agents. */
  callsPerAnswer?: number
}

export interface AiBenchmarkCostInput {
  symbol: string
  /** Decisions sampled. Every model is asked each of them. */
  decisions: number
  models: AiBenchmarkCostModel[]
  budgetRemainingUsd: number
  /** How many questions the run keeps in the air at once. Absent, no time is stated: how long a
   * benchmark takes is its calls divided by this, and a figure that guessed it would be wrong. */
  concurrency?: number
  /** What one question is called. Absent, a decision: a benchmark of events says "event". */
  unit?: { one: string; many: string }
  /** The most calls that start to one model in a minute (shared/aiPace.ts). Given, a run is never
   * said to take less than that pace allows; absent, the time is the calls' own. */
  callsPerMinute?: number
}

/** What is still to ask across a benchmark's models, and what that is expected to cost over the
 * ones whose price is known. `unpriced` counts the models with calls to make and no price: the
 * total leaves them out, and has to say so. */
export function benchmarkCostEstimate(models: AiBenchmarkCostModel[]): { calls: number; knownUsd: number; unpriced: number } {
  let calls = 0
  let knownUsd = 0
  let unpriced = 0
  for (const model of models) {
    const modelCalls = model.toAsk * (model.callsPerAnswer ?? 1)
    calls += modelCalls
    if (model.toAsk === 0) continue
    if (model.perCallCostUsd === null) unpriced++
    else knownUsd += model.perCallCostUsd * modelCalls
  }
  return { calls, knownUsd, unpriced }
}

/** The same question describeAiRunCost asks, for a benchmark (shared/aiBenchmark.ts).
 *
 * PRICED PER MODEL, because that is where the money is: the same hundred questions are forty
 * cents on one model and six dollars on the one beside it, and a single total hides which of them
 * the run is being bought for. A model with no price is named as having none rather than left out
 * of a total that would then read as the whole bill.
 *
 * It says outright when the estimate is more than the budget has left. That run is not refused --
 * stopping at the budget and carrying on another day is a reasonable way to buy a benchmark -- but
 * nobody should agree to it expecting it to finish. */
export function describeAiBenchmarkCost(input: AiBenchmarkCostInput): string {
  const count = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`
  const total = input.decisions * input.models.length
  const cached = input.models.reduce((sum, model) => sum + model.cached, 0)
  const { calls, knownUsd, unpriced } = benchmarkCostEstimate(input.models)

  const lines = input.models.map((model) => {
    const name = describeDecider(model.model)
    if (model.toAsk === 0) return `  ${name}: nothing to ask, every answer is cached`
    const perAnswer = model.callsPerAnswer ?? 1
    const asked =
      count(model.toAsk * perAnswer, 'call', 'calls') + (perAnswer > 1 ? ` (${perAnswer} for each of ${count(model.toAsk, 'answer', 'answers')})` : '')
    if (model.perCallCostUsd === null) return `  ${name}: ${asked}, cost not known (no call history here and no published price)`
    const basis = model.costBasis === 'history' ? 'going by its recent calls here' : 'going by its price list, an estimate'
    return `  ${name}: ${asked}, about ${formatUsd(model.perCallCostUsd * model.toAsk * perAnswer)} ${basis}`
  })

  const priced = input.models.filter((model) => model.toAsk > 0).length - unpriced
  const sum =
    priced === 0
      ? 'What that will cost in all is not known.'
      : unpriced === 0
        ? `About ${formatUsd(knownUsd)} in all.`
        : `About ${formatUsd(knownUsd)} for the ${priced === 1 ? 'one model' : `${priced} models`} with a known price; the rest is not known.`
  const budget =
    priced > 0 && knownUsd > input.budgetRemainingUsd
      ? `${formatUsd(input.budgetRemainingUsd)} of today's AI budget is left, which is less than that: the run will stop when it runs out.`
      : `${formatUsd(input.budgetRemainingUsd)} of today's AI budget is left. If it runs out the run stops.`

  // A panel is counted as what it is: it is set beside the models, and it is not one.
  const panels = input.models.filter((model) => isPanelId(model.model)).length
  const plain = input.models.length - panels
  const who =
    panels === 0
      ? count(plain, 'model', 'models')
      : plain === 0
        ? count(panels, 'agent panel', 'agent panels')
        : `${count(plain, 'model', 'models')} and ${count(panels, 'agent panel', 'agent panels')}`
  // The time, where every model that would be asked has been timed here. Unlike a tape a
  // benchmark asks several questions at once, so its calls do not simply add up.
  const asking = input.models.filter((model) => model.toAsk > 0)
  let time: string | null = null
  if (asking.length > 0 && input.concurrency !== undefined && input.concurrency >= 1) {
    // The calls take what they take, a few at once -- and no less than the slowest model's share
    // of them takes at the most calls a minute any one model is asked.
    const perMinute = input.callsPerMinute
    const paced = perMinute === undefined ? 0 : Math.max(...asking.map((model) => pacedMinimumMs(model.toAsk * (model.callsPerAnswer ?? 1), perMinute)))
    const how = perMinute === undefined ? `Asking ${input.concurrency} at a time` : `Asking ${input.concurrency} at a time and no model more than ${perMinute} times a minute`
    time = asking.every((model) => model.perCallLatencyMs != null)
      ? `${how}, that is ${describeDuration(
          Math.max(paced, asking.reduce((sum, model) => sum + model.toAsk * (model.callsPerAnswer ?? 1) * (model.perCallLatencyMs ?? 0), 0) / input.concurrency)
        )} at the pace ${asking.length === 1 ? 'it has' : 'they have'} answered here.`
      : paced > 0
        ? `How long that takes is not known: a model that has not been called here has no pace to go by. At no more than ${perMinute} calls a minute to one model it takes ${describeDuration(paced)} at the least.`
        : 'How long that takes is not known: a model that has not been called here has no pace to go by.'
  }
  return [
    `Benchmark ${count(input.decisions, input.unit?.one ?? 'decision', input.unit?.many ?? 'decisions')} on ${input.symbol} with ${who} through ${AI_PROVIDER_LABEL}. ` +
      `${panels === 0 ? 'Every model' : 'Each'} is asked the same questions. ${cached.toLocaleString()} of the ${total.toLocaleString()} answers ${cached === 1 ? 'is' : 'are'} already cached.`,
    '',
    `At most ${count(calls, 'model call', 'model calls')} may be made:`,
    ...lines,
    sum,
    ...(time !== null ? [time] : []),
    '',
    `${budget} Everything answered up to then stays cached, and running the benchmark again asks only for what is missing.`,
    '',
    'Continue?'
  ].join('\n')
}

export interface AiOpportunityCostModel {
  model: string
  /** True when this model's answer is already held, so it is not asked again. */
  held: boolean
  perCallCostUsd: number | null
  costBasis: AiSignalEstimate['costBasis']
  perCallLatencyMs?: number | null
}

export interface AiOpportunityCostInput {
  symbol: string
  /** The event, in a word or two: "breakout", "breakdown". */
  event: string
  models: AiOpportunityCostModel[]
  budgetRemainingUsd: number
}

/** The same question describeAiRunCost asks, for one event put to several models
 * (shared/aiOpportunity.ts). One call a model, each priced on its own line, and the time is the
 * slowest of them rather than their sum: they are asked together and none waits on another. */
export function describeAiOpportunityCost(input: AiOpportunityCostInput): string {
  const count = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`
  const asking = input.models.filter((model) => !model.held)
  const held = input.models.length - asking.length
  const priced = asking.filter((model) => model.perCallCostUsd !== null)
  const knownUsd = priced.reduce((sum, model) => sum + (model.perCallCostUsd ?? 0), 0)

  const lines = asking.map((model) => {
    if (model.perCallCostUsd === null) return `  ${describeDecider(model.model)}: cost not known (no call history here and no published price)`
    const basis = model.costBasis === 'history' ? 'going by its recent calls here' : 'going by its price list, an estimate'
    return `  ${describeDecider(model.model)}: about ${formatUsd(model.perCallCostUsd)} ${basis}`
  })
  const sum =
    priced.length === 0
      ? 'What that will cost in all is not known.'
      : priced.length === asking.length
        ? `About ${formatUsd(knownUsd)} in all.`
        : `About ${formatUsd(knownUsd)} for the ${priced.length === 1 ? 'one model' : `${priced.length} models`} with a known price; the rest is not known.`
  const slowest = Math.max(0, ...asking.map((model) => model.perCallLatencyMs ?? 0))
  const time = !asking.every((model) => model.perCallLatencyMs != null)
    ? 'How long that takes is not known: a model that has not been called here has no pace to go by.'
    : asking.length === 1
      ? `That takes ${describeDuration(slowest)} at the pace it has answered here.`
      : `They are asked together, so that takes ${describeDuration(slowest)}: as long as the slowest of them has been taking here.`
  const budget =
    priced.length > 0 && knownUsd > input.budgetRemainingUsd
      ? `${formatUsd(input.budgetRemainingUsd)} of today's AI budget is left, which is less than that: the calls stop when it runs out.`
      : `${formatUsd(input.budgetRemainingUsd)} of today's AI budget is left.`

  return [
    `Ask ${count(input.models.length, 'model', 'models')} about the ${input.event} on ${input.symbol} through ${AI_PROVIDER_LABEL}. ` +
      `Each is shown the same snapshot and answers on its own.` +
      (held > 0 ? ` ${held === 1 ? '1 has' : `${held} have`} already answered and ${held === 1 ? 'is' : 'are'} not asked again.` : ''),
    '',
    `${count(asking.length, 'call', 'calls')} will be made:`,
    ...lines,
    sum,
    ...(asking.length > 0 ? [time] : []),
    '',
    `${budget} An answer is cached once it is bought, and is never asked for twice.`,
    '',
    'Continue?'
  ].join('\n')
}

export interface AiUsageByModel {
  model: string
  calls: number
  failed: number
  rejected: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  /** Over answered calls only; null when there were none. */
  averageLatencyMs: number | null
}

export interface AiUsageSummary {
  today: AiUsageByModel[]
  last30Days: AiUsageByModel[]
  skippedLines: number
}

/** The ledger added up per model, most expensive first. */
export function summarizeUsage(rows: AiCallRecord[]): AiUsageByModel[] {
  const byModel = new Map<string, AiUsageByModel & { latencyTotal: number; answered: number }>()
  for (const row of rows) {
    let entry = byModel.get(row.model)
    if (!entry) {
      entry = {
        model: row.model,
        calls: 0,
        failed: 0,
        rejected: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        averageLatencyMs: null,
        latencyTotal: 0,
        answered: 0
      }
      byModel.set(row.model, entry)
    }
    entry.calls++
    if (row.status === 'failed') entry.failed++
    if (row.status === 'rejected') entry.rejected++
    entry.promptTokens += row.usage.promptTokens
    entry.completionTokens += row.usage.completionTokens
    entry.costUsd += row.usage.costUsd ?? 0
    if (row.status !== 'failed') {
      entry.latencyTotal += row.usage.latencyMs
      entry.answered++
    }
  }
  return [...byModel.values()]
    .map(({ latencyTotal, answered, ...entry }) => ({
      ...entry,
      averageLatencyMs: answered > 0 ? latencyTotal / answered : null
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls)
}
