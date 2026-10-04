import { AI_ROUND_TRIP_COST_PCT } from './aiContext'
import {
  MIN_SCORED_CALLS,
  OUTCOME_PRIMARY_BARS,
  scoreCall,
  summarizeOutcomes,
  type AiCalibrationBucket,
  type AiOutcome,
  type ScoredCallRow
} from './aiOutcome'
import { AI_ESCALATE_WHEN, escalates, routedDecision, type AiEscalateWhen } from './aiRoute'
import {
  GPT_FLAT,
  GPT_LOOKBACK_BARS,
  GPT_MAX_DECISIONS,
  gptActionFor,
  type AiCallUsage,
  type AiSignalDecision,
  type AiSignalEstimate
} from './aiSignal'
import { INTERVAL_SECONDS, type Candle, type Exchange, type Interval } from './ipc'

// The same questions, put to several models.
//
// The Signals tab scores every call a model has made, but each model's calls there are the ones
// its own bot, backtest or Analyze click happened to ask: different candles, different markets,
// different position states. A 58% hit rate over one model's week against 52% over another's
// month says which stretch of market was easier, not which model is better. A benchmark fixes the
// questions first -- one market, one set of candles, the account holding nothing -- and asks every
// model all of them.
//
// THE POSITION IS ALWAYS FLAT. GPT Intraday's context carries the position, and a tape walks a
// position machine, so after the first decision two models disagree on they are no longer being
// asked the same thing. "Would you open a position here?" at every sampled candle keeps the
// questions identical across models -- and makes each one the very question, and the very cache
// entry, that a flat bot, a backtest or the Analyze tab asks at that candle.
//
// THE SAMPLE IS A CLOCK, NOT A RANGE. Candles are taken on fixed multiples of the spacing since
// the epoch (00:00, 04:00, 08:00 UTC ...), not counted back from "now". Run again tomorrow, the
// same benchmark asks about the same candles plus the new ones, and everything already answered
// is served from the cache instead of being paid for twice.
//
// NOTHING HERE IS STORED. The answers live in the decision cache and the call ledger like any
// other call; the comparison is recomputed from them and the candles each time it is looked at.

export const AI_BENCHMARK_MAX_MODELS = 6
/** Decisions asked of each model in one benchmark, at most: the ceiling every other AI run has. */
export const AI_BENCHMARK_MAX_DECISIONS = GPT_MAX_DECISIONS
export const AI_BENCHMARK_PERIOD_DAYS = [7, 14, 30, 60, 90] as const
/** Bars between two sampled candles. On 15-minute candles: 1h, 2h, 4h, 8h and a day. */
export const AI_BENCHMARK_SPACING_BARS = [4, 8, 16, 32, 96] as const
export const AI_BENCHMARK_DEFAULT_DAYS = 30
/** The scoring horizon itself, so that no two sampled calls are judged on overlapping candles.
 * Closer together, neighbouring calls share most of their outcome and are not independent
 * evidence: thirty of them are worth fewer than thirty. */
export const AI_BENCHMARK_DEFAULT_SPACING_BARS = OUTCOME_PRIMARY_BARS

/** Open time of the newest candle whose outcome at the primary horizon is already known. A
 * benchmark asks about nothing newer: an answer that cannot be scored yet buys nothing today. */
export function latestScorableTime(nowSec: number, interval: Interval): number {
  const barSec = INTERVAL_SECONDS[interval]
  const newestClosedOpen = Math.floor(nowSec / barSec) * barSec - barSec
  return newestClosedOpen - OUTCOME_PRIMARY_BARS * barSec
}

/** The candles a benchmark asks about, as execution-candle open times, oldest first. */
export function benchmarkSampleTimes(input: { nowSec: number; days: number; everyBars: number; interval: Interval }): number[] {
  const stepSec = input.everyBars * INTERVAL_SECONDS[input.interval]
  if (!(stepSec > 0) || !(input.days > 0)) return []
  const count = Math.floor((input.days * 86_400) / stepSec)
  const last = Math.floor(latestScorableTime(input.nowSec, input.interval) / stepSec) * stepSec
  return Array.from({ length: count }, (_, i) => last - (count - 1 - i) * stepSec)
}

/** The sampled times this market can actually be asked about: a candle opens exactly then, and a
 * full lookback of candles precedes it. The rest are counted rather than silently dropped. */
export function usableBenchmarkTimes(candles: Candle[], times: number[]): { times: number[]; missing: number } {
  const indexByTime = new Map(candles.map((candle, index) => [candle.time, index]))
  const usable = times.filter((time) => (indexByTime.get(time) ?? -1) >= GPT_LOOKBACK_BARS)
  return { times: usable, missing: times.length - usable.length }
}

/** `answers[model][i]` is that model's decision for `times[i]`, or null where it has not answered:
 * never asked, or asked and not reached. A refused answer IS an answer -- the model was paid and
 * said something unusable -- and is held here like any other. */
export type AiBenchmarkAnswers = Record<string, (AiSignalDecision | null)[]>

export interface AiBenchmarkPeekRequest {
  exchange: Exchange
  symbol: string
  interval: Interval
  /** Completed candles, oldest first, reaching back at least the lookback before the first time. */
  candles: Candle[]
  /** Open times of the candles the decisions execute on, oldest first. */
  times: number[]
  models: string[]
}

export interface AiBenchmarkModelPeek {
  model: string
  /** One per requested time, in order: the decision already held, or null when asking would cost. */
  decisions: (AiSignalDecision | null)[]
  /** One CALL's expected cost. */
  perCallCostUsd: number | null
  costBasis: AiSignalEstimate['costBasis']
  /** One call's measured time here, in milliseconds. Null when it has not been called here. */
  perCallLatencyMs?: number | null
  /** Calls one missing answer takes: one for a model, four for a panel of agents. */
  callsPerAnswer: number
}

/** What a benchmark already holds and what the rest would cost. Reading it spends nothing. */
export interface AiBenchmarkPeek {
  models: AiBenchmarkModelPeek[]
  budgetRemainingUsd: number
}

export interface AiBenchmarkHeldPath {
  /** Entries taken. One that arrives while an earlier one is still being held is passed over. */
  trades: number
  wins: number
  /** Compounded over the trades taken, after the round-trip cost on each. */
  returnPct: number
  /** Deepest fall from a peak, counting the worst price inside each hold. */
  maxDrawdownPct: number
}

export interface AiBenchmarkModelRow {
  model: string
  /** Of every sampled decision, how many this model has answered, refused answers included. */
  answered: number
  // Everything below is over the COMPARED decisions only: the ones every model answered.
  refused: number
  buys: number
  sells: number
  holds: number
  /** Buys the bot would act on: at or above its confidence gate. */
  entries: number
  /** Buys and sells whose outcome at the primary horizon is known. */
  scored: number
  hits: number
  /** Null under MIN_SCORED_CALLS, like every hit rate in this app. */
  hitRatePct: number | null
  /** Half the width of a 95% interval around the hit rate, in percentage points. Two models whose
   * intervals overlap have not been told apart. Null wherever the hit rate is. */
  hitRateMarginPct: number | null
  meanBuyReturnPct: number | null
  /** Mean best and worst move inside the horizon after a buy: how far it ran, and how far it went
   * against the position first. Null under MIN_SCORED_CALLS scored buys. */
  meanBestPct: number | null
  meanWorstPct: number | null
  calibration: AiCalibrationBucket[]
  held: AiBenchmarkHeldPath
  medianLatencyMs: number | null
  /** What these answers cost when they were first asked, cached or not. Null with none priced. */
  costUsd: number | null
  costPerCallUsd: number | null
}

export interface AiBenchmarkAgreement {
  a: string
  b: string
  /** Compared decisions both models answered usably. */
  both: number
  /** Of those, the ones where they made the same call. */
  same: number
}

export interface AiBenchmarkDecisionRow {
  time: number
  /** Whether every model answered it, so that it counts in the comparison. */
  compared: boolean
  /** The execution candle's close: the price an entry here would fill at. */
  referencePrice: number | null
  /** The move from that price to the close of the primary horizon. Null while it is pending. */
  primaryReturnPct: number | null
  /** One per model, in the order the models were given. Null where a model has not answered. */
  calls: (AiSignalDecision | null)[]
}

export interface AiBenchmarkSummary {
  sampled: number
  /** Decisions every model answered. Every figure on a model row is over these and no others, so
   * that no model is scored on easier candles than the one beside it. */
  compared: number
  models: AiBenchmarkModelRow[]
  /** A model that answered "buy" every time, fully confident: what the market alone did on the
   * compared decisions. A hit rate is only worth something above this row's. */
  baseline: AiBenchmarkModelRow
  agreement: AiBenchmarkAgreement[]
  /** Compared decisions on which every model made the same usable call. Null with one model. */
  unanimous: number | null
  /** Bought at the first compared decision and sold at the end of the last one's horizon, after
   * one round trip. Null with nothing compared. */
  buyAndHoldPct: number | null
  decisions: AiBenchmarkDecisionRow[]
}

export interface AiBenchmarkInput {
  /** COMPLETED candles only, oldest first: a forming bar's close is not a fact yet. */
  candles: Candle[]
  /** The sampled execution candles' open times, oldest first. */
  times: number[]
  models: string[]
  answers: AiBenchmarkAnswers
}

export const AI_BENCHMARK_BASELINE = 'Buy every time (no model)'

/** An answer a model actually gave. A decision carrying `error` is a safety hold: the model was
 * not reached, so it is not an answer and never counts as one. */
function isAnswer(decision: AiSignalDecision | null | undefined): decision is AiSignalDecision {
  return decision !== null && decision !== undefined && decision.error === null
}

function isUsable(decision: AiSignalDecision): boolean {
  return !decision.rejected
}

function primaryReturn(outcome: AiOutcome): number | null {
  return outcome.forward.find((entry) => entry.bars === OUTCOME_PRIMARY_BARS)?.returnPct ?? null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function meanOf(values: number[]): number | null {
  return values.length >= MIN_SCORED_CALLS ? values.reduce((a, b) => a + b, 0) / values.length : null
}

/** What taking every entry and holding it for the primary horizon would have done.
 *
 * The plan this benchmark follows asks for a return and a drawdown per model, and those need a
 * path. This is the smallest one that is the SAME for every model: enter at the execution candle's
 * close, leave at the close of the horizon the call is scored at, pay the round trip, and pass
 * over any entry that arrives while the last one is still held. It is not the bot's own exit rule
 * (an ATR stop and the model's later sells) -- that path depends on answers to questions a
 * benchmark does not ask.
 *
 * The drawdown counts the worst price INSIDE each hold, not only where it closed: a trade that
 * fell 6% and came back is a 6% drawdown someone would have sat through. */
export function heldPath(entries: { index: number; outcome: AiOutcome }[]): AiBenchmarkHeldPath {
  let equity = 1
  let peak = 1
  let maxDrawdownPct = 0
  let trades = 0
  let wins = 0
  let freeFrom = Number.NEGATIVE_INFINITY
  for (const entry of [...entries].sort((a, b) => a.index - b.index)) {
    if (entry.index < freeFrom) continue
    const moved = primaryReturn(entry.outcome)
    // An entry whose horizon has not closed is not a trade yet, and holds nothing up.
    if (moved === null) continue
    const worst = entry.outcome.worstPct
    if (worst !== null) maxDrawdownPct = Math.max(maxDrawdownPct, (1 - (equity * (1 + worst / 100)) / peak) * 100)
    const net = moved - AI_ROUND_TRIP_COST_PCT
    equity *= 1 + net / 100
    maxDrawdownPct = Math.max(maxDrawdownPct, (1 - equity / peak) * 100)
    peak = Math.max(peak, equity)
    trades++
    if (net > 0) wins++
    freeFrom = entry.index + OUTCOME_PRIMARY_BARS
  }
  return { trades, wins, returnPct: (equity - 1) * 100, maxDrawdownPct }
}

interface Sample {
  time: number
  /** Position of the execution candle, or -1 when it is not among the candles. */
  index: number
}

function scoreAgainst(candles: Candle[], sample: Sample, decision: AiSignalDecision | null): AiOutcome {
  return scoreCall(
    {
      candleTime: sample.time,
      recommendation: decision !== null && isUsable(decision) ? decision.recommendation : null,
      stopLoss: decision?.detail?.stopLoss ?? null,
      takeProfit: decision?.detail?.takeProfit ?? null,
      horizonBars: decision?.detail?.horizonBars ?? null
    },
    candles,
    sample.index
  )
}

function modelRow(
  model: string,
  candles: Candle[],
  calls: { sample: Sample; decision: AiSignalDecision }[],
  answered: number
): AiBenchmarkModelRow {
  const outcomes = new Map<string, AiOutcome>()
  const scoredRows: ScoredCallRow[] = []
  const entries: { index: number; outcome: AiOutcome }[] = []
  const best: number[] = []
  const worst: number[] = []
  const latencies: number[] = []
  const costs: number[] = []
  let refused = 0
  let buys = 0
  let sells = 0
  let holds = 0

  for (const { sample, decision } of calls) {
    const outcome = scoreAgainst(candles, sample, decision)
    const id = String(sample.time)
    outcomes.set(id, outcome)
    const usable = isUsable(decision)
    scoredRows.push({
      id,
      model,
      status: usable ? 'ok' : 'rejected',
      recommendation: usable ? decision.recommendation : null,
      confidence: usable ? decision.confidence : null
    })
    if (decision.usage) {
      latencies.push(decision.usage.latencyMs)
      if (decision.usage.costUsd !== null) costs.push(decision.usage.costUsd)
    }
    if (!usable) {
      refused++
      continue
    }
    if (decision.recommendation === 'hold') {
      holds++
      continue
    }
    if (decision.recommendation === 'sell') {
      sells++
      continue
    }
    buys++
    if (outcome.bestPct !== null && outcome.worstPct !== null) {
      best.push(outcome.bestPct)
      worst.push(outcome.worstPct)
    }
    // The bot's own gate, not a copy of it: what counts as an entry here is what would be one there.
    if (gptActionFor(decision, GPT_FLAT) === 'enter') entries.push({ index: sample.index, outcome })
  }

  // Accuracy and calibration come from the same function the Signals tab uses, so "right" means
  // one thing in this app.
  const score = summarizeOutcomes(scoredRows, outcomes).find((entry) => entry.model === model)
  const scored = score?.scored ?? 0
  const hits = score?.hits ?? 0
  const hitRatePct = score?.hitRatePct ?? null
  const totalCost = costs.reduce((a, b) => a + b, 0)

  return {
    model,
    answered,
    refused,
    buys,
    sells,
    holds,
    entries: entries.length,
    scored,
    hits,
    hitRatePct,
    hitRateMarginPct:
      hitRatePct !== null && scored > 0 ? 1.96 * Math.sqrt(((hits / scored) * (1 - hits / scored)) / scored) * 100 : null,
    meanBuyReturnPct: score?.meanBuyReturnPct ?? null,
    meanBestPct: meanOf(best),
    meanWorstPct: meanOf(worst),
    calibration: score?.calibration ?? [],
    held: heldPath(entries),
    medianLatencyMs: median(latencies),
    costUsd: costs.length > 0 ? totalCost : null,
    costPerCallUsd: costs.length > 0 ? totalCost / costs.length : null
  }
}

function alwaysBuy(time: number): AiSignalDecision {
  return {
    candleTime: time,
    recommendation: 'buy',
    confidence: 1,
    rationale: '',
    model: AI_BENCHMARK_BASELINE,
    cached: true,
    error: null,
    rejected: null,
    detail: null,
    usage: null
  }
}

/** The sampled candles, each model's answer to them, and which of them every model answered. One
 * function, because the comparison and the routes drawn from it must be over the same decisions. */
function comparedSet(input: AiBenchmarkInput): {
  samples: Sample[]
  answerAt: (model: string, i: number) => AiSignalDecision | null
  comparedAt: boolean[]
  comparedIndices: number[]
} {
  const indexByTime = new Map(input.candles.map((candle, index) => [candle.time, index]))
  const samples: Sample[] = input.times.map((time) => ({ time, index: indexByTime.get(time) ?? -1 }))
  const answerAt = (model: string, i: number): AiSignalDecision | null => {
    const decision = input.answers[model]?.[i]
    return isAnswer(decision) ? decision : null
  }
  const comparedAt = samples.map((_, i) => input.models.length > 0 && input.models.every((model) => answerAt(model, i) !== null))
  return { samples, answerAt, comparedAt, comparedIndices: samples.map((_, i) => i).filter((i) => comparedAt[i]) }
}

export interface AiBenchmarkRouteRow {
  when: AiEscalateWhen
  /** Compared decisions the first model's answer passed on to the second. */
  escalated: number
  /** Scored exactly as a model's row is, over the same compared decisions. Its latency and cost
   * are the route's own -- every first answer, plus the second's where the decision was passed
   * on -- so `costPerCallUsd` here is the cost of one DECISION.
   *
   * The cost is null unless EVERY one of those answers has a price. A model row averages over the
   * answers that are priced; here the ones without a price would be the passed-on ones, and an
   * average that left them out would print the first model's price as the route's. */
  row: AiBenchmarkModelRow
}

export interface AiBenchmarkRouteSummary {
  first: string
  second: string
  /** One per rule a route can pass a decision on by. Empty when the two models are the same one,
   * or either is not part of the benchmark. */
  routes: AiBenchmarkRouteRow[]
}

/** What both calls of a passed-on decision took together: the second is asked after the first. */
function usageOfBoth(first: AiCallUsage | null | undefined, second: AiCallUsage | null | undefined): AiCallUsage | null {
  if (!first || !second) return null
  return {
    promptTokens: first.promptTokens + second.promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
    costUsd: first.costUsd === null || second.costUsd === null ? null : first.costUsd + second.costUsd,
    latencyMs: first.latencyMs + second.latencyMs
  }
}

/** What a route between two of a benchmark's models would have done, from answers already held.
 *
 * NOTHING IS ASKED. A route's second model is put the same question as its first
 * (shared/aiRoute.ts), so the decision a route reaches is a function of the two answers this
 * benchmark already has for that candle: the first model's, unless the rule passes it on, and then
 * the second's. That makes a route something to measure before it is switched on, on the very
 * decisions the two models were measured on alone.
 *
 * EVERY QUESTION HERE IS ASKED WITH THE ACCOUNT FLAT, so "wants to trade" can only mean an entry.
 * This says how a route would have chosen entries; it says nothing about exits. */
export function summarizeBenchmarkRoutes(input: AiBenchmarkInput, first: string, second: string): AiBenchmarkRouteSummary {
  if (first === second || !input.models.includes(first) || !input.models.includes(second)) return { first, second, routes: [] }
  const { samples, answerAt, comparedIndices } = comparedSet(input)
  const routes = AI_ESCALATE_WHEN.map((when): AiBenchmarkRouteRow => {
    let escalated = 0
    const calls = comparedIndices.map((i) => {
      const a = answerAt(first, i) as AiSignalDecision
      const b = answerAt(second, i) as AiSignalDecision
      if (!escalates(a, GPT_FLAT, when)) return { sample: samples[i], decision: a }
      escalated++
      return { sample: samples[i], decision: { ...routedDecision(a, b), usage: usageOfBoth(a.usage, b.usage) } }
    })
    const costs = calls.map(({ decision }) => decision.usage?.costUsd ?? null)
    const costUsd = costs.length > 0 && costs.every((cost) => cost !== null) ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) : null
    return {
      when,
      escalated,
      row: {
        ...modelRow(`${first} → ${second}`, input.candles, calls, comparedIndices.length),
        costUsd,
        costPerCallUsd: costUsd === null ? null : costUsd / costs.length
      }
    }
  })
  return { first, second, routes }
}

/** The comparison, from the answers held and the candles that followed them.
 *
 * ONLY DECISIONS EVERY MODEL ANSWERED ARE COMPARED. A run that stopped early -- the budget ran
 * out, one model was unreachable -- leaves the models with different numbers of answers, and a
 * model scored on a hundred candles is not comparable with one scored on sixty of them plus forty
 * others. Each row still says how many decisions that model has answered in all, so a short one
 * is visible, and running the benchmark again asks only for what is missing. */
export function summarizeBenchmark(input: AiBenchmarkInput): AiBenchmarkSummary {
  const { samples, answerAt, comparedAt, comparedIndices } = comparedSet(input)

  const models = input.models.map((model) =>
    modelRow(
      model,
      input.candles,
      comparedIndices.map((i) => ({ sample: samples[i], decision: answerAt(model, i) as AiSignalDecision })),
      samples.filter((_, i) => answerAt(model, i) !== null).length
    )
  )
  const baseline = modelRow(
    AI_BENCHMARK_BASELINE,
    input.candles,
    comparedIndices.map((i) => ({ sample: samples[i], decision: alwaysBuy(samples[i].time) })),
    comparedIndices.length
  )

  const agreement: AiBenchmarkAgreement[] = []
  for (let first = 0; first < input.models.length; first++) {
    for (let second = first + 1; second < input.models.length; second++) {
      const a = input.models[first]
      const b = input.models[second]
      let both = 0
      let same = 0
      for (const i of comparedIndices) {
        const left = answerAt(a, i) as AiSignalDecision
        const right = answerAt(b, i) as AiSignalDecision
        if (!isUsable(left) || !isUsable(right)) continue
        both++
        if (left.recommendation === right.recommendation) same++
      }
      agreement.push({ a, b, both, same })
    }
  }

  let unanimous: number | null = null
  if (input.models.length >= 2) {
    unanimous = comparedIndices.filter((i) => {
      const calls = input.models.map((model) => answerAt(model, i) as AiSignalDecision)
      return calls.every((call) => isUsable(call) && call.recommendation === calls[0].recommendation)
    }).length
  }

  let buyAndHoldPct: number | null = null
  const firstCompared = samples[comparedIndices[0]]
  const lastCompared = samples[comparedIndices[comparedIndices.length - 1]]
  if (firstCompared !== undefined && lastCompared !== undefined && firstCompared.index >= 0 && lastCompared.index >= 0) {
    const bought = input.candles[firstCompared.index]
    const sold = input.candles[Math.min(lastCompared.index + OUTCOME_PRIMARY_BARS, input.candles.length - 1)]
    if (bought.close > 0) buyAndHoldPct = (sold.close / bought.close - 1) * 100 - AI_ROUND_TRIP_COST_PCT
  }

  return {
    sampled: samples.length,
    compared: comparedIndices.length,
    models,
    baseline,
    agreement,
    unanimous,
    buyAndHoldPct,
    decisions: samples.map((sample, i) => {
      const market = scoreAgainst(input.candles, sample, null)
      return {
        time: sample.time,
        compared: comparedAt[i],
        referencePrice: market.referencePrice,
        primaryReturnPct: primaryReturn(market),
        calls: input.models.map((model) => answerAt(model, i))
      }
    })
  }
}
