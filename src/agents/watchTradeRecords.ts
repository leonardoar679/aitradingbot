import type { AiCallFilter, AiCallPage } from '../../shared/aiLedger'
import { watchPaperExecutors } from '../../shared/aiWatchPaper'
import type { Candle, Exchange, ExecutorConfig } from '../../shared/ipc'
import type { MarketEventFilter, MarketEventPage } from '../../shared/marketScanner'
import type { TradeFill, WatchTradeRecords } from '../../shared/tradeLifecycle'
import { runExecutorSimulation } from '../executors/engine'

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

/** Every record of one trade, found by the ids that join them: the event, the answers about it,
 * the paper position the watch opened on `model`'s call (given, or looked up), and its fill. */
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
  return {
    eventId,
    model,
    event: events.rows.find((event) => event.id === eventId) ?? null,
    calls: calls.rows.filter((row) => row.eventId === eventId),
    executor,
    fill
  }
}
