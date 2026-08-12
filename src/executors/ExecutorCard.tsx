import { Grid3x3, Layers3, Timer } from 'lucide-react'
import { EXCHANGES, type ExecutorConfig } from '../../shared/ipc'
import { useExecutorSimulation } from './useExecutorSimulation'
import { formatQuotePrice } from '../utils/formatCurrency'

const TYPE_META = {
  grid: { label: 'Grid', icon: Grid3x3, color: '#3b82f6' },
  dca: { label: 'DCA', icon: Layers3, color: '#d4a94a' },
  twap: { label: 'TWAP', icon: Timer, color: '#3ecf6a' }
} as const

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

function MetricsPanel({ executor }: { executor: ExecutorConfig }): React.JSX.Element {
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
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: executor.status === 'active' ? 'var(--up)' : 'var(--text-muted)'
          }}
        />
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
