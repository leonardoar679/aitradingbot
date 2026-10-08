import type { AiCallRecord } from './aiLedger'
import type { OpportunityOutcome } from './aiOpportunityOutcome'
import { describeDecider } from './aiPanel'
import { GPT_MIN_CONFIDENCE } from './aiSignal'
import { describeWatchPaperResult, watchPaperEntered, type WatchPaperOutcome } from './aiWatchPaper'
import type { ExecutorConfig, PositionExecutorParams, PositionExitReason } from './ipc'
import { describeEventType, type MarketEvent } from './marketEvent'

// One trade's whole story, from the minute the scanner raised an event to how the position the
// watch opened on it ended -- the V3 document's chain:
//
//   MarketEvent -> AiRecommendation -> TradeIntent -> RiskDecision -> ExecutionResult -> TradeOutcome
//
// NOTHING NEW IS STORED. Each link is a record this app already keeps, found by the ids that join
// them: the event (marketEvents/, its id), each model's answer (the call ledger, by eventId), the
// plan and the paper position the watch made (an executor carrying the event's id and the model
// it followed), where that position filled (a simulation of its own candles, as its card runs)
// and how it ended (written on the executor when the watch stopped it). The links that were never
// written down -- why the watch opened nothing on a call it would act on -- are said to be unknown
// rather than guessed.

/** The document's chain, by the record each link is in this app. */
export interface TradeLifecycle {
  /** MarketEvent. Null when it is no longer among the events on file. */
  event: MarketEvent | null
  /** AiRecommendation: every model's answer about the event, from the call ledger. */
  recommendations: AiCallRecord[]
  /** TradeIntent and RiskDecision: the paper position the watch opened on its checks passing, or
   * null when it opened none. */
  intent: ExecutorConfig | null
  /** ExecutionResult: where the position filled, from a simulation of its own candles. */
  execution: TradeFill | null
  /** TradeOutcome: how it ended, as written when the watch stopped it. */
  outcome: WatchPaperOutcome | null
}

export interface TradeFill {
  status: 'pending' | 'open' | 'closed'
  enteredAt: number | null
  entryPrice: number | null
  exitReason: PositionExitReason | null
  closedAt: number | null
  realizedPnl: number | null
}

export interface WatchTradeRecords {
  eventId: string
  /** The model whose call this trade follows, or whose call it would have. */
  model: string
  event: MarketEvent | null
  /** Every ledger row about the event, whichever model and whoever asked. */
  calls: AiCallRecord[]
  /** The paper position the watch opened on this model's call, if it opened one. */
  executor: ExecutorConfig | null
  fill: TradeFill | null
  /** The recommendation's own score, on minute bars (shared/aiOpportunityOutcome.ts), where it was
   * worked out: set beside the paper position's fill, which since 8 October 2026 can be taken from
   * the live book the second the trade was made. */
  scored?: OpportunityOutcome | null
}

export interface TimelineStep {
  /** Unix seconds, or null when the record does not say. */
  at: number | null
  label: string
  detail: string
  tone?: 'up' | 'down' | 'muted'
}

export interface WatchTradeTrace {
  lifecycle: TradeLifecycle
  steps: TimelineStep[]
  /** The three prices the document asks to be set side by side: the price the model saw, the
   * range it named, and where the paper position actually filled. */
  prices: { atEvent: number | null; rangeMin: number | null; rangeMax: number | null; fill: number | null }
  ids: { eventId: string; callIds: string[]; executorId: string | null }
}

function plainNumber(value: number): string {
  return Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 19)
}

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`
  return `${Math.round(seconds / 60)} minutes`
}

function callWord(recommendation: AiCallRecord['recommendation']): string {
  return recommendation === 'buy' ? 'BUY' : recommendation === 'sell' ? 'SELL' : 'NO TRADE'
}

/** Whether a ledger row is a call this app acts on: a side, at the confidence it acts at. */
export function isActedCall(row: AiCallRecord): boolean {
  return row.status === 'ok' && (row.recommendation === 'buy' || row.recommendation === 'sell') && (row.confidence ?? 0) >= GPT_MIN_CONFIDENCE
}

function describeAnswer(row: AiCallRecord): { detail: string; tone?: TimelineStep['tone'] } {
  if (row.status === 'failed') return { detail: `did not answer: ${row.error ?? 'the call failed'}.`, tone: 'muted' }
  if (row.status === 'rejected') return { detail: `answered, and the answer was refused: ${row.error ?? 'not in the shape asked for'}.`, tone: 'down' }
  const served = row.servedModel !== undefined && row.servedModel !== row.model ? `, served as ${row.servedModel}` : ''
  const latency = row.usage.latencyMs !== null && row.usage.latencyMs !== undefined ? ` in ${(row.usage.latencyMs / 1000).toFixed(1)}s` : ''
  const asked = row.source !== undefined ? `, asked by the ${row.source}` : ''
  const word = callWord(row.recommendation)
  const under = isActedCall(row) || word === 'NO TRADE' ? '' : `: under the ${Math.round(GPT_MIN_CONFIDENCE * 100)}% this app acts at`
  return {
    detail: `${word} at ${Math.round((row.confidence ?? 0) * 100)}%${served}${latency}${asked}${under}.`,
    tone: word === 'BUY' ? 'up' : word === 'SELL' ? 'down' : 'muted'
  }
}

function describePlan(executor: ExecutorConfig, quoteAsset: string): string {
  const params = executor.params as PositionExecutorParams
  const side = params.side === 'buy' ? 'BUY' : 'SELL'
  const range = params.entryRange ? `, entering between ${plainNumber(params.entryRange.min)} and ${plainNumber(params.entryRange.max)}` : ''
  const until = params.entryExpiresAt ? ` until ${utcClock(params.entryExpiresAt)} UTC` : ''
  const levels =
    params.stopLossPct !== null && params.takeProfitPct !== null ? `, stop ${params.stopLossPct}% and target ${params.takeProfitPct}% from the fill` : ''
  const held = params.timeLimitSec !== null ? `, held at most ${duration(params.timeLimitSec)}` : ''
  const followed = executor.watch !== undefined ? ` on ${describeDecider(executor.watch.model)}'s call at ${Math.round(executor.watch.confidence * 100)}%` : ''
  return `${side} ${params.amountQuote} ${quoteAsset}${followed}${range}${until}${levels}${held}. Paper: nothing real was placed.`
}

/** Joins one trade's records, by their ids, into the timeline its card and its journal line show. */
export function traceWatchTrade(records: WatchTradeRecords): WatchTradeTrace {
  const { event, executor, fill } = records
  const calls = [...records.calls].sort((a, b) => a.at - b.at)
  const followed = calls.filter((row) => row.model === records.model && row.status !== 'failed').at(-1) ?? null
  const outcome = executor?.watch?.result ?? null
  const steps: TimelineStep[] = []

  if (event !== null) {
    const rank = event.live?.rank !== undefined ? `, ranked ${event.live.rank} in its minute` : ''
    steps.push({
      at: event.time,
      label: 'Event raised',
      detail: `${event.symbol} ${describeEventType(event.type).toLowerCase()}, score ${event.score.toFixed(0)} (${event.band})${rank}, at a price of ${plainNumber(event.price)}.`
    })
  } else {
    steps.push({ at: executor?.watch?.eventTime ?? null, label: 'Event raised', detail: `${records.eventId}: no longer among the events on file.`, tone: 'muted' })
  }

  for (const row of calls) {
    const answer = describeAnswer(row)
    steps.push({ at: row.at, label: describeDecider(row.model), detail: answer.detail, tone: answer.tone })
  }
  if (calls.length === 0) steps.push({ at: null, label: 'No answer', detail: 'No model has answered about this event.', tone: 'muted' })

  if (executor !== null) {
    steps.push({ at: executor.createdAt, label: 'Paper position opened', detail: describePlan(executor, executor.quoteAsset) })
    if (fill !== null && fill.enteredAt !== null && fill.entryPrice !== null) {
      const streamed = (executor.params as PositionExecutorParams).entryFill ?? null
      const scored = records.scored ?? null
      const scoredNote =
        scored === null
          ? ''
          : scored.entryPrice !== null && scored.entryTime !== null
            ? `; scored on minute bars: ${plainNumber(scored.entryPrice)} at ${secondsClock(scored.entryTime)} UTC`
            : scored.status === 'expired'
              ? '; scored on minute bars: expired unfilled'
              : ''
      steps.push({
        at: fill.enteredAt,
        label: 'Entered',
        detail: streamed !== null ? `Filled at ${plainNumber(fill.entryPrice)} from the live book at ${secondsClock(streamed.at)} UTC${scoredNote}.` : `Filled at ${plainNumber(fill.entryPrice)}${scoredNote}.`
      })
    }
    if (outcome !== null) {
      steps.push({
        at: outcome.closedAt,
        label: outcome.exit === 'entry_expired' ? 'Never entered' : outcome.exit === 'btc_moved' ? 'Dropped' : 'Closed',
        detail: describeWatchPaperResult(outcome, executor.quoteAsset, executor.params as PositionExecutorParams),
        tone: !watchPaperEntered(outcome) ? 'muted' : outcome.pnlQuote >= 0 ? 'up' : 'down'
      })
    } else if (fill !== null && fill.status === 'closed' && fill.exitReason !== null) {
      const result: WatchPaperOutcome = { exit: fill.exitReason, pnlQuote: fill.realizedPnl ?? 0, closedAt: fill.closedAt ?? 0 }
      steps.push({
        at: fill.closedAt,
        label: fill.exitReason === 'entry_expired' ? 'Never entered' : 'Closed',
        detail: `${describeWatchPaperResult(result, executor.quoteAsset, executor.params as PositionExecutorParams)} The watch has not stopped it yet.`,
        tone: fill.exitReason === 'entry_expired' ? 'muted' : (fill.realizedPnl ?? 0) >= 0 ? 'up' : 'down'
      })
    } else if (executor.status === 'stopped') {
      steps.push({ at: executor.stoppedAt, label: 'Stopped', detail: 'Stopped by hand before its position had closed.', tone: 'muted' })
    } else if (fill !== null) {
      steps.push({ at: null, label: fill.status === 'open' ? 'Open' : 'Waiting to enter', detail: fill.status === 'open' ? 'In the position now.' : 'Its entry has not traded yet.', tone: 'muted' })
    }
  } else if (followed === null) {
    steps.push({ at: null, label: 'No paper position', detail: `None: ${describeDecider(records.model)} gave no answer to act on.`, tone: 'muted' })
  } else if (isActedCall(followed)) {
    steps.push({
      at: null,
      label: 'No paper position',
      detail:
        'The watch opened none on this call. Paper trades may have been off, or following another model, or a limit or the paper account may have stopped it: which one was not recorded.',
      tone: 'muted'
    })
  } else {
    steps.push({ at: null, label: 'No paper position', detail: 'None: this was not a call this app acts on.', tone: 'muted' })
  }

  const range = (executor?.params as PositionExecutorParams | undefined)?.entryRange ?? followed?.detail?.entry ?? null
  return {
    lifecycle: { event, recommendations: calls, intent: executor, execution: fill, outcome },
    steps,
    prices: {
      atEvent: event?.price ?? followed?.referencePrice ?? null,
      rangeMin: range?.min ?? null,
      rangeMax: range?.max ?? null,
      fill: fill?.entryPrice ?? null
    },
    ids: { eventId: records.eventId, callIds: calls.map((row) => row.id), executorId: executor?.id ?? null }
  }
}

const secondsClock = (sec: number): string => new Date(sec * 1000).toISOString().slice(11, 19)

/** The three prices side by side, in words. Where there is no fill, says why rather than "none
 * yet": a fill only comes later to a position that is still waiting to enter. */
export function describeTracePrices(trace: WatchTradeTrace): string {
  const { prices, lifecycle } = trace
  const seen = prices.atEvent === null ? 'not on file' : plainNumber(prices.atEvent)
  const range = prices.rangeMin === null || prices.rangeMax === null ? 'none' : `${plainNumber(prices.rangeMin)} – ${plainNumber(prices.rangeMax)}`
  const { intent, execution, outcome } = lifecycle
  const expired = outcome?.exit === 'entry_expired' || execution?.exitReason === 'entry_expired'
  const fill =
    prices.fill !== null
      ? plainNumber(prices.fill)
      : intent === null
        ? 'none, as no paper position was opened'
        : outcome?.exit === 'btc_moved'
          ? 'none, as it was dropped before it entered'
          : expired
            ? 'none, as it never entered'
            : execution === null
              ? 'not worked out, as its candles could not be read'
              : intent.status === 'stopped'
                ? 'none, as it was stopped before it entered'
                : 'none yet'
  return `Price the model saw: ${seen} · range it named: ${range} · fill: ${fill}.`
}
