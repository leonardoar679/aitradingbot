import { useEffect, useState } from 'react'
import { Grid3x3, Layers3, Timer, Target, FileText, Shuffle, Scale, Waves } from 'lucide-react'
import {
  EXCHANGES,
  type ExecutorConfig,
  type OrderExecutorParams,
  type PositionExecutorParams,
  type DcaExecutorParams,
  type GridExecutorParams,
  type LiveTwapRunSummary
} from '../../shared/ipc'
import { buildGridLevels } from './engine'
import { useExecutorSimulation } from './useExecutorSimulation'
import { useSpreadExecutorSimulation } from './useSpreadExecutorSimulation'
import { formatQuotePrice } from '../utils/formatCurrency'

const WATCHER_POLL_MS = 5_000

interface LiveWatcherInfo {
  entryPrice: number | null
  trailingPeakPrice: number | null
  consecutiveFailures: number
  lastError: string | null
}

const EMPTY_WATCHER_INFO: LiveWatcherInfo = { entryPrice: null, trailingPeakPrice: null, consecutiveFailures: 0, lastError: null }

// A watcher only protects a position while it can actually fetch a price. If evaluation keeps
// failing (rate limit, network drop) the barriers are simply not being checked -- so say so,
// rather than leaving "Watching" on screen implying a stop-loss that isn't running. Two ticks of
// grace (~10s) keeps a single blip from crying wolf.
const WATCHER_FAILURE_WARN_THRESHOLD = 3

function WatcherHealth({ info }: { info: LiveWatcherInfo }): React.JSX.Element | null {
  if (info.consecutiveFailures < WATCHER_FAILURE_WARN_THRESHOLD) return null
  return (
    <span style={{ color: 'var(--down)', fontWeight: 700 }}>
      ⚠ Exit checks failing ({info.consecutiveFailures}x) — barriers are NOT being evaluated
      {info.lastError ? `: ${info.lastError}` : ''}
    </span>
  )
}

/** Polls the real entry price (and, for Position, the trailing-peak price) of a watched live
 * Position or DCA position -- null for every other executor (never polls). Same 5s cadence as
 * LiveOrderScheduler's own poll; the one-watcher-per-symbol constraint (Phase 3) means this is
 * realistically at most a handful of concurrent pollers. */
function useLiveWatcherInfo(executor: ExecutorConfig): LiveWatcherInfo {
  const [info, setInfo] = useState<LiveWatcherInfo>(EMPTY_WATCHER_INFO)
  const watching =
    (executor.type === 'position' || executor.type === 'dca' || executor.type === 'grid') &&
    executor.mode === 'live' &&
    executor.liveWatcherId !== null

  useEffect(() => {
    if (!watching) {
      setInfo(EMPTY_WATCHER_INFO)
      return
    }
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const watchers = await window.api.liveTrading.listActiveWatchers()
        if (cancelled) return
        const match = watchers.find((w) => w.executorId === executor.id)
        setInfo(
          match
            ? {
                entryPrice: match.entryPrice,
                trailingPeakPrice: match.trailingPeakPrice,
                consecutiveFailures: match.consecutiveFailures ?? 0,
                lastError: match.lastError ?? null
              }
            : EMPTY_WATCHER_INFO
        )
      } catch {
        // Best-effort display only -- a failed poll just leaves the last known info on screen.
      }
    }
    void poll()
    const timer = setInterval(poll, WATCHER_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [watching, executor.id])

  return info
}

/** Polls a live TWAP run's progress while it's still placing slices -- null once liveTwapRunId
 * clears (either finished or not a live TWAP executor). Mirrors useLiveWatcherInfo's polling
 * shape, but the run's own accumulators only ever cover slices it placed (not slice 0, which
 * resolves synchronously at creation and lives on executor.liveOrder instead) -- callers combine
 * both, see the LiveTwapRunSummary doc comment in shared/ipc.ts. */
export function useLiveTwapInfo(executor: ExecutorConfig): LiveTwapRunSummary | null {
  const [info, setInfo] = useState<LiveTwapRunSummary | null>(null)
  const running = executor.type === 'twap' && executor.mode === 'live' && executor.liveTwapRunId !== null

  useEffect(() => {
    if (!running) {
      setInfo(null)
      return
    }
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const runs = await window.api.liveTrading.listActiveTwapRuns()
        if (cancelled) return
        setInfo(runs.find((r) => r.executorId === executor.id) ?? null)
      } catch {
        // Best-effort display only -- a failed poll just leaves the last known info on screen.
      }
    }
    void poll()
    const timer = setInterval(poll, WATCHER_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [running, executor.id])

  return info
}

const TYPE_META = {
  grid: { label: 'Grid', icon: Grid3x3, color: '#3b82f6' },
  dca: { label: 'DCA', icon: Layers3, color: '#d4a94a' },
  twap: { label: 'TWAP', icon: Timer, color: '#3ecf6a' },
  position: { label: 'Position', icon: Target, color: '#f97316' },
  order: { label: 'Order', icon: FileText, color: '#94a3b8' },
  xemm: { label: 'XEMM', icon: Shuffle, color: '#a855f7' },
  arbitrage: { label: 'Arbitrage', icon: Scale, color: '#ec4899' },
  marketmaking: { label: 'Market Making', icon: Waves, color: '#06b6d4' }
} as const

const EXIT_REASON_LABEL: Record<string, string> = {
  take_profit: 'Take Profit',
  stop_loss: 'Stop Loss',
  time_limit: 'Time Limit',
  trailing_stop: 'Trailing Stop',
  manual: 'Manual Stop'
}

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

/** Shared between live Position and live DCA -- both resolve into the exact same real
 * LiveExitResult shape, closed the exact same way (automatic trigger or manual Stop). */
function ClosedLiveMetrics({ executor }: { executor: ExecutorConfig }): React.JSX.Element {
  const { entryPrice, exitPrice, exitReason, realizedPnl, closedAt } = executor.liveExitResult!
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Closed — real exit ({EXIT_REASON_LABEL[exitReason]})</span>
      <span style={{ color: 'var(--text-secondary)' }}>
        {formatQuotePrice(entryPrice, executor.quoteAsset)} → {formatQuotePrice(exitPrice, executor.quoteAsset)}
      </span>
      <span style={{ color: pctColor(realizedPnl), fontWeight: 600 }}>
        {realizedPnl >= 0 ? '+' : ''}
        {formatQuotePrice(realizedPnl, executor.quoteAsset)} · {new Date(closedAt * 1000).toLocaleString()}
      </span>
    </div>
  )
}

function MetricsPanel({ executor }: { executor: ExecutorConfig }): React.JSX.Element {
  if (executor.mode === 'live') {
    return <LiveOrderMetrics executor={executor} />
  }
  if (executor.type === 'xemm' || executor.type === 'arbitrage') {
    return <SpreadMetrics executor={executor} />
  }
  return <SingleMarketMetrics executor={executor} />
}

/** Live executors never run the simulation hooks — there's nothing to simulate, the order
 * already really happened (or, for a resting limit order, is really still open on Binance; or,
 * for a live Position, is really being watched right now for an automatic exit). This reads
 * state straight off the executor's own config rather than replaying anything. */
export function LiveOrderMetrics({ executor }: { executor: ExecutorConfig }): React.JSX.Element {
  const watcherInfo = useLiveWatcherInfo(executor)
  const twapInfo = useLiveTwapInfo(executor)
  if (executor.type === 'position') {
    if (executor.liveWatcherId) {
      const params = executor.params as PositionExecutorParams
      const conditions: string[] = []
      if (params.stopLossPct !== null) conditions.push(`SL -${params.stopLossPct}%`)
      if (params.takeProfitPct !== null) conditions.push(`TP +${params.takeProfitPct}%`)
      if (params.trailingStop !== null) conditions.push(`Trail ${params.trailingStop.trailPct}% (act. +${params.trailingStop.activationPct}%)`)
      if (params.timeLimitSec !== null) conditions.push(`${Math.round(params.timeLimitSec / 3600)}h limit`)
      const entryPrice = params.entryPrice ?? 0
      const trailingStop = params.trailingStop
      const trailingPeak = watcherInfo.trailingPeakPrice
      // Mirrors the buy-only activation/trail math in evaluateWatcher (livePositionWatchersService.ts):
      // the trail target only exists once the peak has risen far enough past entry to activate.
      const activationTarget = trailingStop !== null ? entryPrice * (1 + trailingStop.activationPct / 100) : null
      const trailingActive = trailingStop !== null && trailingPeak !== null && activationTarget !== null && trailingPeak >= activationTarget
      const trailTarget = trailingActive && trailingStop !== null && trailingPeak !== null ? trailingPeak * (1 - trailingStop.trailPct / 100) : null
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
          <span style={{ color: 'var(--down)', fontWeight: 600 }}>Watching — real position open</span>
          <WatcherHealth info={watcherInfo} />
          <span style={{ color: 'var(--text-secondary)' }}>
            {params.amountQuote} {executor.quoteAsset} @ {formatQuotePrice(entryPrice, executor.quoteAsset)} (entry)
          </span>
          {conditions.length > 0 && <span style={{ color: 'var(--text-muted)' }}>{conditions.join(' · ')}</span>}
          {trailingStop !== null && trailingPeak !== null && (
            <span style={{ color: 'var(--text-muted)' }}>
              Peak {formatQuotePrice(trailingPeak, executor.quoteAsset)}
              {trailTarget !== null
                ? ` · trail stop ${formatQuotePrice(trailTarget, executor.quoteAsset)}`
                : ' · trailing not yet activated'}
            </span>
          )}
          <span style={{ color: 'var(--text-muted)' }}>Stop force-exits this position on Binance</span>
        </div>
      )
    }
    if (executor.liveExitResult) return <ClosedLiveMetrics executor={executor} />
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)' }}>Entry failed — see name for details</div>
  }
  if (executor.type === 'dca') {
    const params = executor.params as DcaExecutorParams
    const restingCount = executor.pendingLiveOrderIds.length
    if (executor.liveWatcherId) {
      const conditions: string[] = [`TP +${params.takeProfitPct}%`]
      if (params.stopLossPct !== null) conditions.push(`SL -${params.stopLossPct}%`)
      if (params.timeLimitSec !== null) conditions.push(`${Math.round(params.timeLimitSec / 3600)}h limit`)
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
          <span style={{ color: 'var(--down)', fontWeight: 600 }}>Watching — real position open</span>
          <WatcherHealth info={watcherInfo} />
          {watcherInfo.entryPrice !== null && (
            <span style={{ color: 'var(--text-secondary)' }}>Avg entry {formatQuotePrice(watcherInfo.entryPrice, executor.quoteAsset)}</span>
          )}
          <span style={{ color: 'var(--text-muted)' }}>{conditions.join(' · ')}</span>
          {restingCount > 0 && (
            <span style={{ color: 'var(--text-muted)' }}>
              {restingCount} more ladder level{restingCount === 1 ? '' : 's'} still resting
            </span>
          )}
          <span style={{ color: 'var(--text-muted)' }}>Stop cancels remaining levels and force-exits this position</span>
        </div>
      )
    }
    if (executor.liveExitResult) return <ClosedLiveMetrics executor={executor} />
    if (restingCount > 0) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
          <span style={{ color: 'var(--down)', fontWeight: 600 }}>
            {restingCount} of {params.levels.length} levels resting
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>TP +{params.takeProfitPct}% from average fill once any level fills</span>
          <span style={{ color: 'var(--text-muted)' }}>Stop cancels every resting level</span>
        </div>
      )
    }
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)' }}>Ladder failed — see name for details</div>
  }
  if (executor.type === 'grid') {
    // Bounded live ladder sharing ONE exit -- not full paper Grid's perpetual per-level cycling.
    // Same watcher/pendingLiveOrderIds mechanism as DCA, just a different level-count source
    // (buildGridLevels(params) instead of params.levels) and no stop-loss/time-limit (Grid has no
    // native fields for those, and Stop Price isn't enforced live -- see the Phase 6 plan).
    const params = executor.params as GridExecutorParams
    const totalLevels = buildGridLevels(params).length
    const restingCount = executor.pendingLiveOrderIds.length
    if (executor.liveWatcherId) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
          <span style={{ color: 'var(--down)', fontWeight: 600 }}>Watching — real position open</span>
          <WatcherHealth info={watcherInfo} />
          {watcherInfo.entryPrice !== null && (
            <span style={{ color: 'var(--text-secondary)' }}>Avg entry {formatQuotePrice(watcherInfo.entryPrice, executor.quoteAsset)}</span>
          )}
          <span style={{ color: 'var(--text-muted)' }}>TP +{params.takeProfitPct}% (shared, not per-level)</span>
          {restingCount > 0 && (
            <span style={{ color: 'var(--text-muted)' }}>
              {restingCount} more grid level{restingCount === 1 ? '' : 's'} still resting
            </span>
          )}
          <span style={{ color: 'var(--text-muted)' }}>Stop cancels remaining levels and force-exits this position</span>
        </div>
      )
    }
    if (executor.liveExitResult) return <ClosedLiveMetrics executor={executor} />
    if (restingCount > 0) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
          <span style={{ color: 'var(--down)', fontWeight: 600 }}>
            {restingCount} of {totalLevels} levels resting (nearest to price)
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>TP +{params.takeProfitPct}% from average fill once any level fills</span>
          <span style={{ color: 'var(--text-muted)' }}>Stop cancels every resting level</span>
        </div>
      )
    }
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)' }}>Ladder failed — see name for details</div>
  }
  if (executor.type === 'twap') {
    // Slice 0 resolved synchronously at creation (executor.liveOrder) -- combine it with
    // whatever the run itself has placed since, for a correct total count and VWAP. See the
    // LiveTwapRunSummary doc comment in shared/ipc.ts for why these two sources are separate.
    const slice0Qty = executor.liveOrder?.filledQty ?? 0
    const slice0Quote = executor.liveOrder?.cummulativeQuoteQty ?? 0
    if (executor.liveTwapResult) {
      const { ordersPlaced, numOrders, totalQuoteFilled, totalBaseFilled, failedSlices, stoppedEarly } = executor.liveTwapResult
      const totalQty = slice0Qty + totalBaseFilled
      const totalQuote = slice0Quote + totalQuoteFilled
      const vwap = totalQty > 0 ? totalQuote / totalQty : null
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {stoppedEarly ? 'Stopped early' : 'Done'} — {1 + ordersPlaced} of {numOrders} orders placed
          </span>
          {vwap !== null && <span style={{ color: 'var(--text-secondary)' }}>VWAP {formatQuotePrice(vwap, executor.quoteAsset)}</span>}
          {failedSlices > 0 && <span style={{ color: 'var(--down)' }}>{failedSlices} slice{failedSlices === 1 ? '' : 's'} failed to place</span>}
        </div>
      )
    }
    if (twapInfo) {
      const totalQty = slice0Qty + twapInfo.totalBaseFilled
      const totalQuote = slice0Quote + twapInfo.totalQuoteFilled
      const vwap = totalQty > 0 ? totalQuote / totalQty : null
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
          <span style={{ color: 'var(--down)', fontWeight: 600 }}>
            Live — {1 + twapInfo.ordersPlaced} of {twapInfo.numOrders} orders placed
          </span>
          {vwap !== null && <span style={{ color: 'var(--text-secondary)' }}>VWAP {formatQuotePrice(vwap, executor.quoteAsset)}</span>}
          {twapInfo.failedSlices > 0 && (
            <span style={{ color: 'var(--down)' }}>{twapInfo.failedSlices} slice{twapInfo.failedSlices === 1 ? '' : 's'} failed to place</span>
          )}
          <span style={{ color: 'var(--text-muted)' }}>Stop halts remaining orders, never undoes ones already placed</span>
        </div>
      )
    }
    if (!executor.liveOrder) {
      return <div style={{ fontSize: '0.75rem', color: 'var(--down)' }}>First slice failed — see name for details</div>
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>1 of 1 orders placed</span>
        <span style={{ color: 'var(--text-secondary)' }}>VWAP {formatQuotePrice(executor.liveOrder.avgFillPrice, executor.quoteAsset)}</span>
      </div>
    )
  }
  if (executor.pendingLiveOrderIds.length > 0) {
    const params = executor.params as OrderExecutorParams
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
        <span style={{ color: 'var(--down)', fontWeight: 600 }}>Resting — real limit order</span>
        <span style={{ color: 'var(--text-secondary)' }}>
          {params.side.toUpperCase()} {params.amountQuote} {executor.quoteAsset} @ {formatQuotePrice(params.limitPrice ?? 0, executor.quoteAsset)}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>Stop cancels this order on Binance</span>
      </div>
    )
  }
  if (!executor.liveOrder) {
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)' }}>Order failed — see name for details</div>
  }
  const { avgFillPrice, filledQty, cummulativeQuoteQty, placedAt } = executor.liveOrder
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Filled — real order</span>
      <span style={{ color: 'var(--text-secondary)' }}>
        {filledQty} {executor.baseAsset} @ avg {formatQuotePrice(avgFillPrice, executor.quoteAsset)}
      </span>
      <span style={{ color: 'var(--text-muted)' }}>
        {formatQuotePrice(cummulativeQuoteQty, executor.quoteAsset)} total · {new Date(placedAt * 1000).toLocaleString()}
      </span>
    </div>
  )
}

function SpreadMetrics({ executor }: { executor: ExecutorConfig }): React.JSX.Element {
  const sim = useSpreadExecutorSimulation(executor)

  if (executor.status === 'stopped') {
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Stopped</div>
  }
  if (sim.status === 'loading') {
    // Distinguish the normal first-minute wait from a generic fetch -- a brand-new executor has
    // no closed 1m candle to replay yet, and an indefinite "Loading…" there reads as a hang.
    return (
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        {sim.waitingForFirstCandle ? 'Waiting for the first 1-minute candle to close…' : 'Loading market data…'}
      </div>
    )
  }
  if (sim.status === 'error') {
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)' }}>Error: {sim.error}</div>
  }
  if (!sim.state) return <></>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
      <span style={{ color: 'var(--text-primary)' }}>
        {sim.state.captures.length} capture{sim.state.captures.length === 1 ? '' : 's'}
      </span>
      {sim.state.lastSpreadPct !== null && (
        <span style={{ color: 'var(--text-secondary)' }}>Spread {sim.state.lastSpreadPct.toFixed(3)}%</span>
      )}
      <span style={{ color: pctColor(sim.state.realizedPnl), fontWeight: 600 }}>
        {sim.state.realizedPnl >= 0 ? '+' : ''}
        {formatQuotePrice(sim.state.realizedPnl, executor.quoteAsset)} realized
      </span>
    </div>
  )
}

function SingleMarketMetrics({ executor }: { executor: ExecutorConfig }): React.JSX.Element {
  const sim = useExecutorSimulation(executor)

  if (executor.status === 'stopped') {
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Stopped</div>
  }
  if (sim.status === 'loading') {
    // Distinguish the normal first-minute wait from a generic fetch -- a brand-new executor has
    // no closed 1m candle to replay yet, and an indefinite "Loading…" there reads as a hang.
    return (
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        {sim.waitingForFirstCandle ? 'Waiting for the first 1-minute candle to close…' : 'Loading market data…'}
      </div>
    )
  }
  if (sim.status === 'error') {
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)' }}>Error: {sim.error}</div>
  }
  if (!sim.state) return <></>

  if (sim.state.kind === 'grid') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
        <span style={{ color: sim.state.stoppedAt !== null ? 'var(--down)' : 'var(--text-primary)', fontWeight: sim.state.stoppedAt !== null ? 600 : 400 }}>
          {sim.state.filledCount} / {sim.state.levels.length} levels filled
          {sim.state.stoppedAt !== null ? ' · stopped — stop price hit' : ''}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>{sim.state.closedLevels} cycles closed</span>
        <span style={{ color: pctColor(sim.state.realizedPnl), fontWeight: 600 }}>
          {sim.state.realizedPnl >= 0 ? '+' : ''}
          {formatQuotePrice(sim.state.realizedPnl, executor.quoteAsset)} realized
        </span>
      </div>
    )
  }

  if (sim.state.kind === 'dca') {
    const current = sim.latestCandle?.close ?? null
    const side = (executor.params as { side: 'buy' | 'sell' }).side
    const rawPct =
      sim.state.avgEntryPrice && current ? ((current - sim.state.avgEntryPrice) / sim.state.avgEntryPrice) * 100 : 0
    const unrealizedPct = side === 'sell' ? -rawPct : rawPct
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
        <span style={{ color: 'var(--text-primary)' }}>
          {sim.state.fills.length} fill{sim.state.fills.length === 1 ? '' : 's'}
          {sim.state.status === 'closed' ? ' · closed' : ''}
        </span>
        {sim.state.avgEntryPrice !== null ? (
          <span style={{ color: 'var(--text-secondary)' }}>
            Avg entry {formatQuotePrice(sim.state.avgEntryPrice, executor.quoteAsset)}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>Waiting for first fill</span>
        )}
        {sim.state.realizedPnl !== null && (
          <span style={{ color: pctColor(sim.state.realizedPnl), fontWeight: 600 }}>
            {sim.state.realizedPnl >= 0 ? '+' : ''}
            {formatQuotePrice(sim.state.realizedPnl, executor.quoteAsset)} realized
          </span>
        )}
        {sim.state.realizedPnl === null && sim.state.avgEntryPrice !== null && current && (
          <span style={{ color: pctColor(unrealizedPct), fontWeight: 600 }}>
            {unrealizedPct >= 0 ? '+' : ''}
            {unrealizedPct.toFixed(2)}% unrealized
          </span>
        )}
      </div>
    )
  }

  if (sim.state.kind === 'twap') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
        <span style={{ color: 'var(--text-primary)' }}>{sim.state.progressPct.toFixed(0)}% complete</span>
        <span style={{ color: 'var(--text-muted)' }}>
          {sim.state.fills.length} / {sim.state.numOrders} slices
        </span>
        {sim.state.vwap !== null && (
          <span style={{ color: 'var(--text-secondary)' }}>VWAP {formatQuotePrice(sim.state.vwap, executor.quoteAsset)}</span>
        )}
      </div>
    )
  }

  if (sim.state.kind === 'position') {
    const current = sim.latestCandle?.close ?? null
    const rawPct =
      sim.state.entryPrice && current ? ((current - sim.state.entryPrice) / sim.state.entryPrice) * 100 : 0
    const unrealizedPct = sim.state.side === 'sell' ? -rawPct : rawPct
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
        <span style={{ color: 'var(--text-primary)' }}>
          {sim.state.status === 'pending' ? 'Waiting for entry' : sim.state.status === 'open' ? 'Open' : 'Closed'}
        </span>
        {sim.state.entryPrice !== null && (
          <span style={{ color: 'var(--text-secondary)' }}>Entry {formatQuotePrice(sim.state.entryPrice, executor.quoteAsset)}</span>
        )}
        {sim.state.status === 'closed' && sim.state.realizedPnl !== null && (
          <span style={{ color: pctColor(sim.state.realizedPnl), fontWeight: 600 }}>
            {sim.state.realizedPnl >= 0 ? '+' : ''}
            {formatQuotePrice(sim.state.realizedPnl, executor.quoteAsset)} ({sim.state.exitReason ? EXIT_REASON_LABEL[sim.state.exitReason] : ''})
          </span>
        )}
        {sim.state.status === 'open' && current && (
          <span style={{ color: pctColor(unrealizedPct), fontWeight: 600 }}>
            {unrealizedPct >= 0 ? '+' : ''}
            {unrealizedPct.toFixed(2)}% unrealized
          </span>
        )}
      </div>
    )
  }

  if (sim.state.kind === 'order') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
        <span style={{ color: 'var(--text-primary)' }}>{sim.state.status === 'filled' ? 'Filled' : 'Pending'}</span>
        {sim.state.fillPrice !== null && (
          <span style={{ color: 'var(--text-secondary)' }}>Fill {formatQuotePrice(sim.state.fillPrice, executor.quoteAsset)}</span>
        )}
      </div>
    )
  }

  // sim.state.kind === 'marketmaking'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
      {sim.state.bidPrice !== null && sim.state.askPrice !== null && (
        <span style={{ color: 'var(--text-secondary)' }}>
          Bid {formatQuotePrice(sim.state.bidPrice, executor.quoteAsset)} / Ask {formatQuotePrice(sim.state.askPrice, executor.quoteAsset)}
        </span>
      )}
      <span style={{ color: 'var(--text-primary)' }}>
        {sim.state.filledBuys} buys · {sim.state.filledSells} sells
      </span>
      {sim.state.inventoryPct !== null && (
        <span style={{ color: 'var(--text-muted)' }}>Inventory {sim.state.inventoryPct.toFixed(0)}% of one order</span>
      )}
      <span style={{ color: pctColor(sim.state.realizedPnl), fontWeight: 600 }}>
        {sim.state.realizedPnl >= 0 ? '+' : ''}
        {formatQuotePrice(sim.state.realizedPnl, executor.quoteAsset)} realized
      </span>
    </div>
  )
}

export function ExecutorCard({
  executor,
  onStop,
  onViewDetail
}: {
  executor: ExecutorConfig
  onStop: (id: string) => void
  onViewDetail: (id: string) => void
}): React.JSX.Element {
  const meta = TYPE_META[executor.type]
  const Icon = meta.icon
  const exchangeName = EXCHANGES.find((e) => e.id === executor.exchange)?.name ?? executor.exchange

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '1.1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.7rem'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.2rem 0.55rem',
            borderRadius: 999,
            background: `${meta.color}22`,
            color: meta.color,
            fontSize: '0.7rem',
            fontWeight: 700,
            textTransform: 'uppercase'
          }}
        >
          <Icon size={12} />
          {meta.label}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {executor.mode === 'live' && (
            <span
              style={{
                padding: '0.2rem 0.5rem',
                borderRadius: 999,
                background: 'var(--down)',
                color: '#fff',
                fontSize: '0.65rem',
                fontWeight: 800,
                letterSpacing: '0.04em'
              }}
            >
              LIVE
            </span>
          )}
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: executor.status === 'active' ? 'var(--up)' : 'var(--text-muted)'
            }}
          />
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{executor.name}</div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {exchangeName} • {executor.symbol}
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
        <MetricsPanel executor={executor} />
      </div>

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          onClick={() => onViewDetail(executor.id)}
          style={{
            flex: 1,
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 999,
            padding: '0.5rem',
            color: 'var(--text-secondary)',
            fontSize: '0.78rem',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          View Chart
        </button>
        {executor.status === 'active' && (
          <button
            onClick={() => onStop(executor.id)}
            style={{
              flex: 1,
              background: 'var(--bg-app)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              padding: '0.5rem',
              color: 'var(--down)',
              fontSize: '0.78rem',
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            Stop
          </button>
        )}
      </div>
    </div>
  )
}
