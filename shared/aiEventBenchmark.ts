import { isActionableOpportunity, opportunitySide, type OpportunitySide } from './aiOpportunity'
import {
  DEFAULT_OPPORTUNITY_COSTS,
  REPLAY_ASK_DELAY_SEC,
  opportunityCallOf,
  replayAnsweredAt,
  scoreOpportunity,
  slippageRateForEvent,
  type OpportunityCall,
  type OpportunityOutcome
} from './aiOpportunityOutcome'
import { MIN_SCORED_CALLS } from './aiOutcome'
import type { AiSignalDecision } from './aiSignal'
import type { Candle } from './ipc'
import type { MarketEvent, MarketEventType } from './marketEvent'

// The same events, put to several models, and scored by what their recommendations earned.
//
// The clock benchmark (shared/aiBenchmark.ts) asks "would you buy this market?" at fixed times and
// scores a call by where the price was four hours later. This one asks about the minutes the
// scanner raised, and scores a recommendation by following it: its entry, its stop, its target,
// its clocks, fees, slippage and the model's own latency (shared/aiOpportunityOutcome.ts).
//
// ONLY EVENTS EVERY MODEL ANSWERED ARE COMPARED, for the reason the clock benchmark gives: a model
// scored on easier events than the one beside it has not been compared with it.
//
// EVERY TABLE CARRIES ROWS THAT ARE NOT MODELS. "Follow every event" and "fade every event" take
// the same events with one fixed bracket and no judgement at all. research/EVENTS.md measured
// both over years and found they lose about a round trip's cost; a model is worth its price only
// by as much as it beats them here, on the same events, in the same weeks.
//
// THE VOTING RULES ARE WORKED OUT, NOT ASKED. What a majority, a unanimous panel or a pair of
// models would have traded is a function of answers already held, so it costs nothing to see --
// and it is shown so the question "does agreement help?" is answered by counting.
//
// NOTHING HERE IS STORED. The answers are in the decision cache and the call ledger; this is
// recomputed from them and from candles whenever it is looked at.

export const EVENT_BENCHMARK_PERIOD_DAYS = [7, 14, 30] as const
export const EVENT_BENCHMARK_PAIR_COUNTS = [10, 20, 40] as const
export const EVENT_BENCHMARK_EVENT_COUNTS = [50, 100, 200, 300] as const
export const EVENT_BENCHMARK_DEFAULT_DAYS = 14
export const EVENT_BENCHMARK_DEFAULT_PAIRS = 20
export const EVENT_BENCHMARK_DEFAULT_EVENTS = 100

/** How long after an event its recommendation can still be changing: an hour to enter, a day to
 * hold, and ten minutes. A benchmark asks about nothing newer -- an answer that cannot be scored
 * yet buys nothing today. */
export const EVENT_BENCHMARK_SETTLE_SEC = 60 * 60 + 24 * 60 * 60 + 10 * 60

/** What "return" is counted in: every trade is the same stake, and this is it, in dollars. Only
 * the two figures that set a model's results against what asking it cost need a number. */
export const EVENT_BENCHMARK_STAKE_USD = 1000

/** The bracket the no-model rows trade: the one research/EVENTS.md scored every event by. */
const BASELINE_STOP_SIGMAS = 1.5
const BASELINE_TARGET_SIGMAS = 3
const BASELINE_HOLD_SECONDS = 60 * 60
const MIN_SLICE_TRADES = 10
const CONFIDENCE_BANDS = [0.65, 0.7, 0.8, 0.9, 1]
const SEGMENTS = 3

/** The stretch of history a benchmark covers: `days` ending at the last UTC midnight early enough
 * for every recommendation in it to have run its course. Anchored to the day, so running again
 * tomorrow covers the same days and one more, and most of what was bought is asked for again. */
export function eventBenchmarkWindow(nowSec: number, days: number): { startSec: number; endSec: number } {
  const endSec = Math.floor((nowSec - EVENT_BENCHMARK_SETTLE_SEC) / 86_400) * 86_400
  return { startSec: endSec - days * 86_400, endSec }
}

/** FNV-1a, to a number in [0, 1). Only for choosing a sample: it has to be the same every time
 * and say nothing about the event. */
function hash01(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 4_294_967_296
}

/** At most `max` of `events`, oldest first.
 *
 * CHOSEN BY A HASH OF EACH EVENT'S OWN ID, each type in proportion to how many of it there are.
 * Whether an event is in the sample does not depend on which other events were found, so a scan
 * of a longer period, or the same one run tomorrow, keeps the events it had -- and their answers
 * come from the cache instead of being paid for twice. A hash also cannot prefer the events that
 * turned out well, which choosing "the strongest" quietly would. */
export function sampleEvents(events: MarketEvent[], max: number): MarketEvent[] {
  const byTime = (a: MarketEvent, b: MarketEvent): number => a.time - b.time || a.symbol.localeCompare(b.symbol)
  if (events.length <= max) return [...events].sort(byTime)
  const byType = new Map<MarketEventType, MarketEvent[]>()
  for (const event of events) {
    const list = byType.get(event.type)
    if (list) list.push(event)
    else byType.set(event.type, [event])
  }
  const picked: MarketEvent[] = []
  const spare: MarketEvent[] = []
  for (const list of byType.values()) {
    const ordered = [...list].sort((a, b) => hash01(a.id) - hash01(b.id) || a.id.localeCompare(b.id))
    const share = Math.floor((max * list.length) / events.length)
    picked.push(...ordered.slice(0, share))
    spare.push(...ordered.slice(share))
  }
  // Rounding each type down leaves a few places over; they go to whatever hashes lowest.
  spare.sort((a, b) => hash01(a.id) - hash01(b.id) || a.id.localeCompare(b.id))
  picked.push(...spare.slice(0, Math.max(0, max - picked.length)))
  return picked.sort(byTime)
}

export type EventBenchmarkAnswers = Record<string, (AiSignalDecision | null)[]>

export interface EventBenchmarkInput {
  /** The sampled events, oldest first. */
  events: MarketEvent[]
  models: string[]
  /** `answers[model][i]` is that model's answer for `events[i]`, or null where it has none. */
  answers: EventBenchmarkAnswers
  /** COMPLETED 1-minute candles from each event on, by event id. An event with none scores as
   * still waiting, and is counted as unsettled rather than as a loss. */
  bars: Record<string, Candle[]>
  /** Each event's pair's traded value a day at the time, by event id, where known: what its
   * slippage is charged by. */
  dailyVolume?: Record<string, number | null>
  /** `answeredAt[model][i]`: when that answer really arrived, in Unix seconds, where it is known.
   * An answer the watch bought live is scored from the moment it came. Absent or null, the answer
   * is a replayed one, taken to have arrived after the ask delay and the model's own latency. */
  answeredAt?: Record<string, (number | null)[]>
  nowSec: number
}

export interface EventTrade {
  /** Index into the benchmark's events. */
  index: number
  time: number
  type: MarketEventType
  side: OpportunitySide
  confidence: number
  holdSeconds: number
  outcome: OpportunityOutcome
}

export interface EventBenchmarkSlice {
  by: 'type' | 'side' | 'hold' | 'confidence'
  key: string
  trades: number
  wins: number
  netSumPct: number
  /** Null under ten closed trades in the slice. */
  meanNetPct: number | null
}

export interface EventBenchmarkRow {
  name: string
  /** Of every sampled event, how many this row has an answer for, refused answers included. Null
   * on a row that is not a model. */
  answered: number | null
  // Everything below is over the COMPARED events only.
  refused: number
  longs: number
  shorts: number
  noTrades: number
  /** Recommendations this app acts on: a side, at 65% confidence or more. */
  actionable: number
  /** Of those: never filled before the entry expired. */
  expired: number
  /** Of those: not settled yet, or with no candles to settle them by. */
  unsettled: number
  /** Of those: entered and closed. Every figure below is over these. */
  closed: number
  wins: number
  /** Null under MIN_SCORED_CALLS closed trades, like every rate in this app. */
  winRatePct: number | null
  /** Half the width of a 95% interval around it, in points. */
  winRateMarginPct: number | null
  /** The closed trades' net returns added up: what equal stakes returned, in percent of one. */
  netSumPct: number
  /** Net return a trade. Null under MIN_SCORED_CALLS. */
  meanNetPct: number | null
  /** Gains over losses. Null with no losing trade to divide by, or too few trades. */
  profitFactor: number | null
  meanWinPct: number | null
  meanLossPct: number | null
  /** Deepest fall of the running total, in percent of one stake, trades taken in time order. */
  maxDrawdownPct: number
  meanHoldMinutes: number | null
  meanBestPct: number | null
  meanWorstPct: number | null
  medianLatencyMs: number | null
  /** What these answers cost when they were bought. Null on a row that is not a model. */
  costUsd: number | null
  /** The net total at EVENT_BENCHMARK_STAKE_USD a trade, less what the answers cost. */
  netAfterAiCostUsd: number | null
  /** That net total, before AI cost, for each dollar the answers cost. */
  perAiDollarUsd: number | null
  /** The period in three consecutive parts: a result that holds in only one shows here. */
  segments: { trades: number; wins: number; netSumPct: number }[]
  slices: EventBenchmarkSlice[]
  trades: EventTrade[]
}

export interface EventBenchmarkSummary {
  sampled: number
  compared: number
  models: EventBenchmarkRow[]
  /** The same events traded with no judgement: follow every one, fade every one. */
  baselines: EventBenchmarkRow[]
  /** Which events those two rows cover: the compared ones, so that they sit beside the models
   * on the same events -- or, while no model has answered anything to compare, every sampled
   * event, because what the events did with no model at all is known before a cent is spent. */
  baselinesOver: 'compared' | 'sampled'
  /** What combining the models' answers would have traded. Empty with fewer than two models. */
  rules: EventBenchmarkRow[]
  /** The time each of the three segments ends, the last being the newest event's. */
  segmentEnds: number[]
}

export const EVENT_BASELINE_FOLLOW = 'Follow every event (no model)'
export const EVENT_BASELINE_FADE = 'Fade every event (no model)'
export const EVENT_RULE_MAJORITY = 'More than half agree'
export const EVENT_RULE_UNANIMOUS = 'All agree'
export const EVENT_RULE_WEIGHTED = 'Weighed by confidence'

function isAnswer(decision: AiSignalDecision | null | undefined): decision is AiSignalDecision {
  return decision !== null && decision !== undefined && decision.error === null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function meanOf(values: number[], floor = MIN_SCORED_CALLS): number | null {
  return values.length >= floor && values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function costsFor(input: EventBenchmarkInput, event: MarketEvent): { feeRate: number; slippageRate: number } {
  return { feeRate: DEFAULT_OPPORTUNITY_COSTS.feeRate, slippageRate: slippageRateForEvent(event, input.dailyVolume?.[event.id]) }
}

function tradeOf(input: EventBenchmarkInput, index: number, call: OpportunityCall, confidence: number): EventTrade {
  const event = input.events[index]
  return {
    index,
    time: event.time,
    type: event.type,
    side: call.side,
    confidence,
    holdSeconds: call.holdSeconds,
    outcome: scoreOpportunity(call, input.bars[event.id] ?? [], input.nowSec, costsFor(input, event))
  }
}

/** When a model's answer for an event was in hand: when it really arrived, for an answer bought
 * live, and otherwise after the ask delay and however long that model took to give it. */
function arrivalOf(input: EventBenchmarkInput, model: string, index: number, decision: AiSignalDecision): number {
  return input.answeredAt?.[model]?.[index] ?? replayAnsweredAt(input.events[index].time, decision.usage?.latencyMs)
}

/** The trade a recommendation makes, when it is one this app acts on, entered no earlier than
 * `answeredAt`: the model's own arrival -- or, for a rule that needs every model's answer before
 * it can decide, the last of them. */
function modelTrade(input: EventBenchmarkInput, index: number, decision: AiSignalDecision | null, answeredAt: number): EventTrade | null {
  if (!isActionableOpportunity(decision)) return null
  const call = opportunityCallOf(input.events[index].time, decision, answeredAt)
  return call === null ? null : tradeOf(input, index, call, decision?.confidence ?? 0)
}

/** The no-model trade on an event: the bracket research/EVENTS.md scored, entered at the open of
 * the first minute after the question could have been put. Null for an event with no direction,
 * and where there is no such minute among the candles. */
function baselineTrade(input: EventBenchmarkInput, index: number, follow: boolean): EventTrade | null {
  const event = input.events[index]
  if (event.direction === 'none' || !(Math.abs(event.moveSigmas) > 0)) return null
  const usualMovePct = Math.abs(event.returnsPct.m15 / event.moveSigmas)
  const answeredAt = event.time + REPLAY_ASK_DELAY_SEC
  const first = (input.bars[event.id] ?? []).find((bar) => bar.time >= answeredAt)
  if (!first || !(usualMovePct > 0)) return null
  const long = (event.direction === 'up') === follow
  const sign = long ? 1 : -1
  return tradeOf(
    input,
    index,
    {
      time: event.time,
      side: long ? 'long' : 'short',
      entryMin: first.open,
      entryMax: first.open,
      stopLoss: first.open * (1 - (sign * BASELINE_STOP_SIGMAS * usualMovePct) / 100),
      takeProfit: first.open * (1 + (sign * BASELINE_TARGET_SIGMAS * usualMovePct) / 100),
      expiresAt: first.time + 60,
      holdSeconds: BASELINE_HOLD_SECONDS,
      answeredAt
    },
    1
  )
}

function holdLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${Math.round(seconds / 60)}m`
}

function confidenceBand(confidence: number): string {
  for (let i = CONFIDENCE_BANDS.length - 2; i >= 0; i--) {
    if (confidence >= CONFIDENCE_BANDS[i]) return `${Math.round(CONFIDENCE_BANDS[i] * 100)}–${Math.round(CONFIDENCE_BANDS[i + 1] * 100)}%`
  }
  return `under ${Math.round(CONFIDENCE_BANDS[0] * 100)}%`
}

function slicesOf(closed: EventTrade[], withConfidence: boolean): EventBenchmarkSlice[] {
  const groups: { by: EventBenchmarkSlice['by']; key: (trade: EventTrade) => string }[] = [
    { by: 'type', key: (trade) => trade.type },
    { by: 'side', key: (trade) => trade.side },
    { by: 'hold', key: (trade) => holdLabel(trade.holdSeconds) }
  ]
  if (withConfidence) groups.push({ by: 'confidence', key: (trade) => confidenceBand(trade.confidence) })
  const slices: EventBenchmarkSlice[] = []
  for (const group of groups) {
    const byKey = new Map<string, EventTrade[]>()
    for (const trade of closed) {
      const key = group.key(trade)
      const list = byKey.get(key)
      if (list) list.push(trade)
      else byKey.set(key, [trade])
    }
    for (const [key, list] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const nets = list.map((trade) => trade.outcome.netPct ?? 0)
      slices.push({
        by: group.by,
        key,
        trades: list.length,
        wins: nets.filter((net) => net > 0).length,
        netSumPct: nets.reduce((sum, net) => sum + net, 0),
        meanNetPct: meanOf(nets, MIN_SLICE_TRADES)
      })
    }
  }
  return slices
}

interface RowSource {
  name: string
  /** Events compared, for a row that is not a model: what it did not trade it passed on. */
  compared: number
  answered: number | null
  /** One per compared event: the answer there, for the counts. Null on a row that is not a model. */
  decisions: (AiSignalDecision | null)[] | null
  trades: EventTrade[]
  withConfidence: boolean
}

function rowOf(source: RowSource, segmentEnds: number[]): EventBenchmarkRow {
  const decisions = source.decisions ?? []
  const usable = decisions.filter((decision): decision is AiSignalDecision => isAnswer(decision) && !decision.rejected)
  const closed = source.trades.filter((trade) => trade.outcome.status === 'closed')
  const nets = closed.map((trade) => trade.outcome.netPct ?? 0)
  const wins = nets.filter((net) => net > 0)
  const losses = nets.filter((net) => net <= 0)
  const netSumPct = nets.reduce((sum, net) => sum + net, 0)
  const enough = closed.length >= MIN_SCORED_CALLS

  let running = 0
  let peak = 0
  let maxDrawdownPct = 0
  for (const trade of closed) {
    running += trade.outcome.netPct ?? 0
    if (running > peak) peak = running
    if (peak - running > maxDrawdownPct) maxDrawdownPct = peak - running
  }

  const rate = closed.length > 0 ? wins.length / closed.length : 0
  const grossLoss = -losses.reduce((sum, net) => sum + net, 0)
  const costs = decisions.filter(isAnswer).map((decision) => decision.usage?.costUsd ?? null)
  const priced = costs.filter((cost): cost is number => cost !== null)
  const costUsd = source.decisions === null || priced.length === 0 ? null : priced.reduce((sum, cost) => sum + cost, 0)
  const netUsd = (netSumPct / 100) * EVENT_BENCHMARK_STAKE_USD

  return {
    name: source.name,
    answered: source.answered,
    refused: decisions.filter((decision) => isAnswer(decision) && Boolean(decision.rejected)).length,
    // A model's own answers, whatever their confidence. A row that is not a model has no
    // answers, only the trades it took and the events it passed on.
    longs: source.decisions === null ? source.trades.filter((trade) => trade.side === 'long').length : usable.filter((decision) => opportunitySide(decision) === 'long').length,
    shorts: source.decisions === null ? source.trades.filter((trade) => trade.side === 'short').length : usable.filter((decision) => opportunitySide(decision) === 'short').length,
    noTrades: source.decisions === null ? source.compared - source.trades.length : usable.filter((decision) => opportunitySide(decision) === null).length,
    actionable: source.trades.length,
    expired: source.trades.filter((trade) => trade.outcome.status === 'expired').length,
    unsettled: source.trades.filter((trade) => trade.outcome.status === 'waiting' || trade.outcome.status === 'open').length,
    closed: closed.length,
    wins: wins.length,
    winRatePct: enough ? rate * 100 : null,
    winRateMarginPct: enough ? 1.96 * Math.sqrt((rate * (1 - rate)) / closed.length) * 100 : null,
    netSumPct,
    meanNetPct: meanOf(nets),
    profitFactor: enough && grossLoss > 0 ? wins.reduce((sum, net) => sum + net, 0) / grossLoss : null,
    meanWinPct: enough && wins.length > 0 ? wins.reduce((sum, net) => sum + net, 0) / wins.length : null,
    meanLossPct: enough && losses.length > 0 ? losses.reduce((sum, net) => sum + net, 0) / losses.length : null,
    maxDrawdownPct,
    meanHoldMinutes: meanOf(closed.map((trade) => trade.outcome.heldMinutes ?? 0)),
    meanBestPct: meanOf(closed.map((trade) => trade.outcome.bestPct ?? 0)),
    meanWorstPct: meanOf(closed.map((trade) => trade.outcome.worstPct ?? 0)),
    medianLatencyMs: source.decisions === null ? null : median(decisions.filter(isAnswer).map((decision) => decision.usage?.latencyMs ?? null).filter((ms): ms is number => ms !== null)),
    costUsd,
    netAfterAiCostUsd: costUsd === null ? null : netUsd - costUsd,
    perAiDollarUsd: costUsd === null || !(costUsd > 0) ? null : netUsd / costUsd,
    segments: segmentEnds.map((end, segment) => {
      const start = segment === 0 ? -Infinity : segmentEnds[segment - 1]
      const inside = closed.filter((trade) => trade.time > start && trade.time <= end)
      return {
        trades: inside.length,
        wins: inside.filter((trade) => (trade.outcome.netPct ?? 0) > 0).length,
        netSumPct: inside.reduce((sum, trade) => sum + (trade.outcome.netPct ?? 0), 0)
      }
    }),
    slices: slicesOf(closed, source.withConfidence),
    trades: source.trades
  }
}

/** The answer whose levels a rule trades: of those taking `side`, the most confident, and the
 * first named where two are equally so. A rule decides WHETHER to trade; it has no levels of its
 * own, so it borrows them from the model surest of that side. */
function surest(decisions: AiSignalDecision[], side: OpportunitySide): AiSignalDecision | null {
  let best: AiSignalDecision | null = null
  for (const decision of decisions) {
    if (opportunitySide(decision) !== side) continue
    if (best === null || decision.confidence > best.confidence) best = decision
  }
  return best
}

type Rule = (actionable: AiSignalDecision[], all: AiSignalDecision[]) => OpportunitySide | null

const RULES: { name: string; pick: Rule }[] = [
  {
    // More than half of the models take one side at a confidence this app acts on, and none takes
    // the other.
    name: EVENT_RULE_MAJORITY,
    pick: (actionable, all): OpportunitySide | null => {
      const long = actionable.filter((decision) => opportunitySide(decision) === 'long').length
      const short = actionable.length - long
      if (long > 0 && short > 0) return null
      if (long * 2 > all.length) return 'long'
      return short * 2 > all.length ? 'short' : null
    }
  },
  {
    name: EVENT_RULE_UNANIMOUS,
    pick: (actionable, all): OpportunitySide | null => {
      if (actionable.length !== all.length || all.length === 0) return null
      const first = opportunitySide(actionable[0])
      return actionable.every((decision) => opportunitySide(decision) === first) ? first : null
    }
  },
  {
    // Each answer weighs what it is confident of. A side is taken when its weight is more than
    // the other side's and the abstainers' together.
    name: EVENT_RULE_WEIGHTED,
    pick: (actionable, all): OpportunitySide | null => {
      let long = 0
      let short = 0
      let none = 0
      for (const decision of all) {
        const side = actionable.includes(decision) ? opportunitySide(decision) : null
        if (side === 'long') long += decision.confidence
        else if (side === 'short') short += decision.confidence
        else none += decision.confidence
      }
      if (long > short + none) return 'long'
      return short > long + none ? 'short' : null
    }
  }
]

/** The comparison, from the answers held and the candles that followed each event. */
export function summarizeEventBenchmark(input: EventBenchmarkInput): EventBenchmarkSummary {
  const answerAt = (model: string, index: number): AiSignalDecision | null => {
    const decision = input.answers[model]?.[index]
    return isAnswer(decision) ? decision : null
  }
  const comparedIndices = input.events.map((_, index) => index).filter((index) => input.models.length > 0 && input.models.every((model) => answerAt(model, index) !== null))

  const baselinesOver = comparedIndices.length > 0 ? 'compared' : 'sampled'
  const baselineIndices = baselinesOver === 'compared' ? comparedIndices : input.events.map((_, index) => index)

  // Three consecutive parts of those events' own span, by time.
  const times = baselineIndices.map((index) => input.events[index].time)
  const segmentEnds: number[] = []
  if (times.length > 0) {
    const first = times[0]
    const last = times[times.length - 1]
    for (let segment = 1; segment <= SEGMENTS; segment++) segmentEnds.push(segment === SEGMENTS ? last : first + ((last - first) * segment) / SEGMENTS)
  }

  const models = input.models.map((model) => {
    const decisions = comparedIndices.map((index) => answerAt(model, index))
    const trades = comparedIndices
      .map((index) => {
        const decision = answerAt(model, index)
        return decision === null ? null : modelTrade(input, index, decision, arrivalOf(input, model, index, decision))
      })
      .filter((trade): trade is EventTrade => trade !== null)
    return rowOf(
      { name: model, compared: comparedIndices.length, answered: input.events.filter((_, index) => answerAt(model, index) !== null).length, decisions, trades, withConfidence: true },
      segmentEnds
    )
  })

  const baselines = [
    { name: EVENT_BASELINE_FOLLOW, follow: true },
    { name: EVENT_BASELINE_FADE, follow: false }
  ].map(({ name, follow }) =>
    rowOf(
      {
        name,
        compared: baselineIndices.length,
        answered: null,
        decisions: null,
        trades: baselineIndices.map((index) => baselineTrade(input, index, follow)).filter((trade): trade is EventTrade => trade !== null),
        withConfidence: false
      },
      segmentEnds
    )
  )

  const rules =
    input.models.length < 2
      ? []
      : RULES.map(({ name, pick }) => {
          const trades: EventTrade[] = []
          for (const index of comparedIndices) {
            const arrivals: number[] = []
            const answered: AiSignalDecision[] = []
            for (const model of input.models) {
              const decision = answerAt(model, index)
              if (decision === null) continue
              answered.push(decision)
              arrivals.push(arrivalOf(input, model, index, decision))
            }
            const all = answered.filter((decision) => !decision.rejected)
            const actionable = all.filter((decision) => isActionableOpportunity(decision))
            const side = pick(actionable, all)
            const source = side === null ? null : surest(actionable, side)
            // A rule cannot act until the last model has answered.
            const trade = source === null ? null : modelTrade(input, index, source, Math.max(...arrivals))
            if (trade !== null) trades.push(trade)
          }
          return rowOf({ name, compared: comparedIndices.length, answered: null, decisions: null, trades, withConfidence: false }, segmentEnds)
        })

  return { sampled: input.events.length, compared: comparedIndices.length, models, baselines, baselinesOver, rules, segmentEnds }
}
