import { Grid3x3, Layers3, Timer, Target, FileText, Shuffle, Scale, Waves } from 'lucide-react'
import { EXCHANGES, type ExecutorConfig, type OrderExecutorParams, type PositionExecutorParams } from '../../shared/ipc'
import { useExecutorSimulation } from './useExecutorSimulation'
import { useSpreadExecutorSimulation } from './useSpreadExecutorSimulation'
import { formatQuotePrice } from '../utils/formatCurrency'

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
function LiveOrderMetrics({ executor }: { executor: ExecutorConfig }): React.JSX.Element {
  if (executor.type === 'position') {
    if (executor.liveWatcherId) {
      const params = executor.params as PositionExecutorParams
      const conditions: string[] = []
      if (params.stopLossPct !== null) conditions.push(`SL -${params.stopLossPct}%`)
      if (params.takeProfitPct !== null) conditions.push(`TP +${params.takeProfitPct}%`)
      if (params.trailingStop !== null) conditions.push(`Trail ${params.trailingStop.trailPct}% (act. +${params.trailingStop.activationPct}%)`)
      if (params.timeLimitSec !== null) conditions.push(`${Math.round(params.timeLimitSec / 3600)}h limit`)
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
          <span style={{ color: 'var(--down)', fontWeight: 600 }}>Watching — real position open</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            {params.amountQuote} {executor.quoteAsset} @ {formatQuotePrice(params.entryPrice ?? 0, executor.quoteAsset)} (entry)
          </span>
          {conditions.length > 0 && <span style={{ color: 'var(--text-muted)' }}>{conditions.join(' · ')}</span>}
          <span style={{ color: 'var(--text-muted)' }}>Stop force-exits this position on Binance</span>
        </div>
      )
    }
    if (executor.liveExitResult) {
      const { entryPrice, exitPrice, exitReason, realizedPnl, closedAt } = executor.liveExitResult
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
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)' }}>Entry failed — see name for details</div>
  }
  if (executor.pendingLiveOrderId) {
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
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Loading market data…</div>
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
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Loading market data…</div>
  }
  if (sim.status === 'error') {
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)' }}>Error: {sim.error}</div>
  }
  if (!sim.state) return <></>

  if (sim.state.kind === 'grid') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
        <span style={{ color: 'var(--text-primary)' }}>
          {sim.state.filledCount} / {sim.state.levels.length} levels filled
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
