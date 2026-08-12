import { useEffect, useRef, useState } from 'react'
import { Copy, LineChart, Layers, PieChart, Plus, Shuffle, Star, type LucideIcon } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { BotCard } from './BotCard'
import { AddBotModal } from './AddBotModal'
import { BotDetailView } from './BotDetailView'
import type { Bot } from './types'
import type { Exchange, SymbolInfo } from '../../shared/ipc'

type Tab = 'for-you' | 'baskets' | 'strategies' | 'copy' | 'tradingview' | 'arbitrage'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'for-you', label: 'For you', icon: Star },
  { id: 'baskets', label: 'Crypto baskets', icon: PieChart },
  { id: 'strategies', label: 'Strategies', icon: Layers },
  { id: 'copy', label: 'Copy Trading', icon: Copy },
  { id: 'tradingview', label: 'TradingView', icon: LineChart },
  { id: 'arbitrage', label: 'Arbitrage', icon: Shuffle }
]

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    background: 'transparent',
    border: 'none',
    padding: '0.7rem 1rem',
    fontSize: '0.85rem',
    fontWeight: active ? 700 : 500,
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
    borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
    whiteSpace: 'nowrap'
  }
}

export function BotsPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('for-you')
  const [bots, setBots] = useState<Bot[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setBots(settings.bots)
      loadedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    void window.api.settings.set({ bots })
  }, [bots])

  function handleCreate(input: { name: string; exchange: Exchange; pair: SymbolInfo; strategy: string }): void {
    setBots((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: input.name,
        exchange: input.exchange,
        symbol: input.pair.symbol,
        baseAsset: input.pair.baseAsset,
        quoteAsset: input.pair.quoteAsset,
        strategy: input.strategy,
        enabled: false,
        enabledAt: null
      }
    ])
    setShowAdd(false)
  }

  function handleToggle(id: string): void {
    setBots((prev) =>
      prev.map((b) =>
        b.id === id ? { ...b, enabled: !b.enabled, enabledAt: !b.enabled ? Math.floor(Date.now() / 1000) : null } : b
      )
    )
  }

  function handleRemove(id: string): void {
    setBots((prev) => prev.filter((b) => b.id !== id))
    setSelectedBotId((prev) => (prev === id ? null : prev))
  }

  const selectedBot = bots.find((b) => b.id === selectedBotId) ?? null

  return (
    <>
      <PageHeader title="Bots" subtitle="Configure and manage your AI trading bots" />

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} style={tabButtonStyle(tab === id)} onClick={() => setTab(id)}>
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'for-you' && (
        <>
          {!selectedBot && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0.9rem 0 0' }}>
              Enabling a bot starts a paper-trading dry run — real market data, the same EMA(20/50) + EMA(200) regime
              filter + ATR(14) strategy that was backtested, and simulated (not real) money. It only runs while this
              app is open, and never places real orders.
            </p>
          )}

          {selectedBot && (
            <div style={{ marginTop: '0.9rem' }}>
              <BotDetailView bot={selectedBot} onBack={() => setSelectedBotId(null)} />
            </div>
          )}

          <div
            style={{
              display: selectedBot ? 'none' : 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: '1rem',
              marginTop: '0.9rem'
            }}
          >
            {bots.map((bot) => (
              <BotCard key={bot.id} bot={bot} onToggle={handleToggle} onRemove={handleRemove} onViewDetail={setSelectedBotId} />
            ))}
            <button
              onClick={() => setShowAdd(true)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.4rem',
                minHeight: 220,
                background: 'transparent',
                border: '1px dashed var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-secondary)',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <Plus size={20} />
              Add Bot
            </button>
          </div>
        </>
      )}

      {tab !== 'for-you' && (
        <div
          style={{
            marginTop: '0.9rem',
            padding: '3rem 1rem',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.85rem',
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius-md)'
          }}
        >
          {TABS.find((t) => t.id === tab)?.label} is coming soon.
        </div>
      )}

      {showAdd && <AddBotModal onCreate={handleCreate} onClose={() => setShowAdd(false)} />}
    </>
  )
}
