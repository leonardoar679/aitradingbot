import { useEffect, useRef, useState } from 'react'
import { Activity, Archive, Plus, Zap, type LucideIcon } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { BotCard } from './BotCard'
import { AddBotModal } from './AddBotModal'
import { BotDetailView } from './BotDetailView'
import { RunsTab } from './RunsTab'
import { ArchivedTab } from './ArchivedTab'
import { runBacktest } from '../backtest/engine'
import type { Bot } from './types'
import type { BotRun, Exchange, SymbolInfo } from '../../shared/ipc'

type Tab = 'active' | 'runs' | 'archived'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'active', label: 'Active', icon: Zap },
  { id: 'runs', label: 'Runs', icon: Activity },
  { id: 'archived', label: 'Archived', icon: Archive }
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

// Fetches the bot's own enabled-window candles and replays the same backtest engine used by its
// live dry-run, to record a permanent BotRun summary at the moment it's disabled — otherwise
// that dry-run history (only ever recomputed live, never stored) would simply vanish.
async function buildRunRecord(bot: Bot, endedAt: number): Promise<BotRun | null> {
  if (bot.enabledAt === null) return null
  try {
    const { candles } = await window.api.market.fetchHistoricalRange(bot.exchange, bot.symbol, '4h', bot.enabledAt, endedAt)
    if (candles.length === 0) return null
    const result = runBacktest(candles, { forceCloseAtEnd: false })
    const trades = result.trades.filter((t) => t.entryTime >= bot.enabledAt!)
    if (trades.length === 0 && endedAt - bot.enabledAt < 300) return null
    const wins = trades.filter((t) => t.pnl > 0).length
    const netPct = trades.length > 0 ? (trades.reduce((acc, t) => acc * (1 + t.returnPct / 100), 1) - 1) * 100 : 0
    return {
      id: crypto.randomUUID(),
      botId: bot.id,
      botName: bot.name,
      exchange: bot.exchange,
      symbol: bot.symbol,
      startedAt: bot.enabledAt,
      endedAt,
      trades: trades.length,
      wins,
      netPct
    }
  } catch (error) {
    console.error('Failed to build bot run record:', error)
    return null
  }
}

export function BotsPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('active')
  const [bots, setBots] = useState<Bot[]>([])
  const [botRuns, setBotRuns] = useState<BotRun[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setBots(settings.bots)
      setBotRuns(settings.botRuns)
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
        enabledAt: null,
        archived: false
      }
    ])
    setShowAdd(false)
  }

  function handleToggle(id: string): void {
    const bot = bots.find((b) => b.id === id)
    if (!bot) return

    const turningOff = bot.enabled
    const nowSec = Math.floor(Date.now() / 1000)
    setBots((prev) => prev.map((b) => (b.id === id ? { ...b, enabled: !b.enabled, enabledAt: turningOff ? null : nowSec } : b)))

    if (turningOff) {
      void buildRunRecord(bot, nowSec).then((run) => {
        if (!run) return
        setBotRuns((prev) => {
          const next = [...prev, run]
          void window.api.settings.set({ botRuns: next })
          return next
        })
      })
    }
  }

  function handleArchive(id: string): void {
    setBots((prev) => prev.map((b) => (b.id === id ? { ...b, archived: true, enabled: false } : b)))
    setSelectedBotId((prev) => (prev === id ? null : prev))
  }

  function handleRestore(id: string): void {
    setBots((prev) => prev.map((b) => (b.id === id ? { ...b, archived: false } : b)))
  }

  function handleDeletePermanently(id: string): void {
    setBots((prev) => prev.filter((b) => b.id !== id))
  }

  const activeBots = bots.filter((b) => !b.archived)
  const archivedBots = bots.filter((b) => b.archived)
  const selectedBot = activeBots.find((b) => b.id === selectedBotId) ?? null

  return (
    <>
      <PageHeader title="Bots" subtitle="Configure and manage your AI trading bots" />

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} style={tabButtonStyle(tab === id)} onClick={() => setTab(id)}>
            <Icon size={15} />
            {label}
            {id === 'archived' && archivedBots.length > 0 && ` (${archivedBots.length})`}
          </button>
        ))}
      </div>

      {tab === 'active' && (
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
            {activeBots.map((bot) => (
              <BotCard key={bot.id} bot={bot} onToggle={handleToggle} onArchive={handleArchive} onViewDetail={setSelectedBotId} />
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

      {tab === 'runs' && <RunsTab runs={botRuns} />}

      {tab === 'archived' && (
        <ArchivedTab bots={archivedBots} onRestore={handleRestore} onDelete={handleDeletePermanently} />
      )}

      {showAdd && <AddBotModal onCreate={handleCreate} onClose={() => setShowAdd(false)} />}
    </>
  )
}
