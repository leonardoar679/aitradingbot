import type { AiCallFilter, AiCallPage, AiCallRecord } from '../../shared/aiLedger'
import { DEFAULT_OPPORTUNITY_COSTS, opportunityCallOf, scoreOpportunity, type OpportunityOutcome } from '../../shared/aiOpportunityOutcome'
import { watchPaperExecutors } from '../../shared/aiWatchPaper'
import { positionSlippageRate } from '../../shared/fees'
import type { Candle, Exchange, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import type { MarketEventFilter, MarketEventPage } from '../../shared/marketScanner'
import type { TradeFill, WatchTradeRecords } from '../../shared/tradeLifecycle'
import { runExecutorSimulation } from '../executors/engine'
import { decisionOfCall } from './opportunities'

/** What one trade's timeline reads, injected so it can be exercised without the bridge. Every one
 * of them reads; none writes. */
export interface TimelineDeps {
  listEvents: (filter: MarketEventFilter) => Promise<MarketEventPage>
  listCalls: (filter: AiCallFilter) => Promise<AiCallPage>
  listExecutors: () => Promise<ExecutorConfig[]>
  /** 1-minute candles of [startSec, endSec]. */
  fetchCandles: (exchange: Exchange, symbol: string, startSec: number, endSec: number) => Promise<Candle[]>
  nowSec: () => number
}

/** Rows read back to find one event's answers: a symbol's recent calls. */
const CALLS_READ = 2000

/** `binance:BTCUSDT:1791187260` -> its symbol and minute. */
export function parseEventId(eventId: string): { symbol: string; time: number } | null {
  const parts = eventId.split(':')
  if (parts.length !== 3) return null
  const time = Number(parts[2])
  return parts[1] !== '' && Number.isFinite(time) ? { symbol: parts[1], time } : null
}

/** Where a paper position filled and how it ended, from its own candles: the simulation its card
 * runs, and the one the watch ran when it stopped it -- the same candles, from the minute it was
 * opened to the one it closed in (or now), completed bars only. */
export async function simulateFill(executor: ExecutorConfig, deps: Pick<TimelineDeps, 'fetchCandles' | 'nowSec'>): Promise<TradeFill | null> {
  const now = deps.nowSec()
  const endedAt = executor.watch?.result?.closedAt ?? executor.stoppedAt
  const end = endedAt === null || endedAt === undefined ? now : Math.min(now, endedAt + 60)
  const candles = (await deps.fetchCandles(executor.exchange, executor.symbol, executor.createdAt, end)).filter((bar) => bar.time + 60 <= end)
  if (candles.length === 0) return null
  const state = runExecutorSimulation(candles, executor, candles[0].close)
  if (state.kind !== 'position') return null
  return {
    status: state.status,
    enteredAt: state.enteredAt,
    entryPrice: state.entryPrice,
    exitReason: state.exitReason,
    closedAt: state.closedAt,
    realizedPnl: state.realizedPnl
  }
}

/** The recommendation's own score on minute bars, as the leaderboard scores it, from the minutes
 * after the event; null where there is nothing to score it by. Since 8 October 2026 a paper trade
 * can fill from the live book the second it is made, and this is what it is set beside. */
async function scoreCall(
  event: MarketEventPage['rows'][number],
  row: AiCallRecord,
  executor: ExecutorConfig,
  deps: Pick<TimelineDeps, 'fetchCandles' | 'nowSec'>
): Promise<OpportunityOutcome | null> {
  const call = opportunityCallOf(event.time, decisionOfCall(row), row.at)
  if (call === null) return null
  const now = deps.nowSec()
  const end = Math.min(now, call.expiresAt + call.holdSeconds + 120)
  const bars = (await deps.fetchCandles(event.exchange, event.symbol, event.time - 60, end)).filter((bar) => bar.time + 60 <= end)
  return scoreOpportunity(call, bars, now, { ...DEFAULT_OPPORTUNITY_COSTS, slippageRate: positionSlippageRate(executor.params as PositionExecutorParams) })
}

/** Every record of one trade, found by the ids that join them: the event, the answers about it,
 * the paper position the watch opened on `model`'s call (given, or looked up), its fill, and the
 * recommendation's own score to set beside it. */
export async function loadWatchTradeRecords(
  eventId: string,
  model: string,
  given: ExecutorConfig | null,
  deps: TimelineDeps
): Promise<WatchTradeRecords> {
  const parsed = parseEventId(eventId)
  const [events, calls, executors] = await Promise.all([
    parsed === null ? Promise.resolve({ rows: [], skippedLines: 0 }) : deps.listEvents({ symbol: parsed.symbol, sinceSec: parsed.time - 60, limit: 200 }),
    parsed === null ? Promise.resolve({ rows: [], skippedLines: 0 }) : deps.listCalls({ symbol: parsed.symbol, limit: CALLS_READ }),
    given === null ? deps.listExecutors() : Promise.resolve([given])
  ])
  const executor =
    given ?? watchPaperExecutors(executors).find((entry) => entry.watch?.eventId === eventId && entry.watch.model === model) ?? null
  const fill = executor === null ? null : await simulateFill(executor, deps).catch(() => null)
  const event = events.rows.find((entry) => entry.id === eventId) ?? null
  const followed = calls.rows.find((row) => row.eventId === eventId && row.model === model && row.status !== 'failed') ?? null
  const scored = executor === null || event === null || followed === null ? null : await scoreCall(event, followed, executor, deps).catch(() => null)
  return {
    eventId,
    model,
    event,
    calls: calls.rows.filter((row) => row.eventId === eventId),
    executor,
    fill,
    scored
  }
}
