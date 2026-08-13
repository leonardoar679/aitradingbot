import { useEffect, useRef, useState } from 'react'
import { Cpu, Plus } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { StatCard } from '../components/StatCard'
import { NewExecutorModal } from './NewExecutorModal'
import { ExecutorCard } from './ExecutorCard'
import { ExecutorDetailView } from './ExecutorDetailView'
import { SpreadExecutorDetailView } from './SpreadExecutorDetailView'
import { computeExecutorPosition } from './computeSnapshot'
import {
  EXCHANGES,
  type ExecutorConfig,
  type Exchange,
  type ExecutorType,
  type SymbolInfo,
  type GridExecutorParams,
  type DcaExecutorParams,
  type TwapExecutorParams,
  type PositionExecutorParams,
  type OrderExecutorParams,
  type XemmExecutorParams,
  type ArbitrageExecutorParams,
  type MarketMakingExecutorParams,
  type HeldPosition
} from '../../shared/ipc'
import type { Bot } from '../bots/types'

export function ExecutorsPage(): React.JSX.Element {
  const [bots, setBots] = useState<Bot[]>([])
  const [executors, setExecutors] = useState<ExecutorConfig[]>([])
  const [showNew, setShowNew] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setBots(settings.bots)
      setExecutors(settings.executors)
      loadedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    void window.api.settings.set({ executors })
  }, [executors])

  async function handleCreate(input: {
    name: string
    type: ExecutorType
    exchange: Exchange
    pair: SymbolInfo
    keepPosition: boolean
    mode: 'paper' | 'live'
    params: GridExecutorParams | DcaExecutorParams | TwapExecutorParams | PositionExecutorParams | OrderExecutorParams | XemmExecutorParams | ArbitrageExecutorParams | MarketMakingExecutorParams
  }): Promise<void> {
    // Defense in depth — the UI only ever offers 'live' for type 'order', but this is the last
    // line of defense before anything real could happen.
    const mode = input.mode === 'live' && input.type === 'order' ? 'live' : 'paper'

    const base: ExecutorConfig = {
      id: crypto.randomUUID(),
      name: input.name,
      type: input.type,
      exchange: input.exchange,
      symbol: input.pair.symbol,
      baseAsset: input.pair.baseAsset,
      quoteAsset: input.pair.quoteAsset,
      createdAt: Math.floor(Date.now() / 1000),
      status: 'active',
      stoppedAt: null,
      keepPosition: input.keepPosition,
      mode,
      liveOrder: null,
      params: input.params
    }
    setShowNew(false)

    if (mode === 'paper') {
      setExecutors((prev) => [...prev, base])
      return
    }

    // Live: place the one real order now — this is the only place in the app that does. The
    // executor is created already 'stopped' either way, since a live Order executor is one-shot.
    const orderParams = input.params as OrderExecutorParams
    const stoppedAt = Math.floor(Date.now() / 1000)
    try {
      const result = await window.api.executors.placeLiveOrder(
        input.exchange,
        input.pair.symbol,
        input.pair.baseAsset,
        input.pair.quoteAsset,
        orderParams.side,
        orderParams.amountQuote
      )
      setExecutors((prev) => [...prev, { ...base, status: 'stopped', stoppedAt, liveOrder: result }])
    } catch (error) {
      console.error('Live order failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      setExecutors((prev) => [...prev, { ...base, name: `${base.name} (failed: ${message})`, status: 'stopped', stoppedAt }])
    }
  }

  function handleStop(id: string): void {
    const executor = executors.find((e) => e.id === id)
    setExecutors((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: 'stopped', stoppedAt: Math.floor(Date.now() / 1000) } : e))
    )
    if (!executor || !executor.keepPosition) return

    // Position Handover: fire the check as a background job — the executor's status already
    // flipped above, this only decides whether an open position gets a row in Inventory.
    void (async () => {
      try {
        const position = await computeExecutorPosition(executor)
        if (!position) return
        const settings = await window.api.settings.get()
        const held: HeldPosition = {
          id: crypto.randomUUID(),
          sourceExecutorId: executor.id,
          sourceExecutorName: executor.name,
          exchange: executor.exchange,
          symbol: executor.symbol,
          baseAsset: executor.baseAsset,
          quoteAsset: executor.quoteAsset,
          side: position.side,
          entryPrice: position.entryPrice,
          amountQuote: position.amountQuote,
          openedAt: Math.floor(Date.now() / 1000)
        }
        await window.api.settings.set({ heldPositions: [...settings.heldPositions, held] })
      } catch (error) {
        console.error('Failed to hand over position on stop:', error)
      }
    })()
  }

  const activeBots = bots.filter((b) => b.enabled)
  const activeExecutors = executors.filter((e) => e.status === 'active')
  const stoppedExecutors = executors.filter((e) => e.status === 'stopped')
  const selected = executors.find((e) => e.id === selectedId) ?? null

  if (selected) {
    if (selected.type === 'xemm' || selected.type === 'arbitrage') {
      return <SpreadExecutorDetailView executor={selected} onBack={() => setSelectedId(null)} />
    }
    return <ExecutorDetailView executor={selected} onBack={() => setSelectedId(null)} />
  }

  return (
    <>
      <PageHeader title="Executors" subtitle="Where your bots and paper strategies actually run" />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        <StatCard icon={Cpu} label="Executors Online" value="1 / 1" valueColor="var(--positive)" />
        <StatCard icon={Cpu} label="Active Strategies" value={`${activeBots.length + activeExecutors.length}`} />
      </div>

      <Card title="Local Executor">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.9rem' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--positive)', flexShrink: 0 }} />
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>This device</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Running</span>
        </div>
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Bots and Grid/DCA/TWAP executors all run inside this desktop app as paper-trading simulations — real
          market data, simulated money, no remote workers. They only run while this app stays open. Cloud/remote
          executors aren't available yet.
        </p>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
          Executors
        </h2>
        <button
          onClick={() => setShowNew(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'linear-gradient(135deg, #7c86ff, #6366f1)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '0.55rem 0.9rem',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 700,
            cursor: 'pointer'
          }}
        >
          <Plus size={14} /> New Executor
        </button>
      </div>

      {executors.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
          No executors yet. Create a Grid, DCA, TWAP, Position, Order, XEMM, or Arbitrage executor to start a
          paper-trading strategy against live market data.
        </p>
      )}

      {activeExecutors.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
          {activeExecutors.map((executor) => (
            <ExecutorCard key={executor.id} executor={executor} onStop={handleStop} onViewDetail={setSelectedId} />
          ))}
        </div>
      )}

      {stoppedExecutors.length > 0 && (
        <>
          <h2 style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Stopped
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
            {stoppedExecutors.map((executor) => (
              <ExecutorCard key={executor.id} executor={executor} onStop={handleStop} onViewDetail={setSelectedId} />
            ))}
          </div>
        </>
      )}

      {activeBots.length > 0 && (
        <Card title="Bots on this executor">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {activeBots.map((bot) => {
              const exchangeName = EXCHANGES.find((e) => e.id === bot.exchange)?.name ?? bot.exchange
              return (
                <div
                  key={bot.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.6rem 0.8rem',
                    background: 'var(--bg-app)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)'
                  }}
                >
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{bot.name}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {exchangeName} • {bot.symbol} • {bot.strategy}
                    </div>
                  </div>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--positive)' }}>Running</span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {showNew && <NewExecutorModal onCreate={handleCreate} onClose={() => setShowNew(false)} />}
    </>
  )
}
