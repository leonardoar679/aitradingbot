import { useEffect, useRef, useState } from 'react'
import { Activity, Archive, Plus, Zap, type LucideIcon } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { BotCard } from './BotCard'
import { AddBotModal } from './AddBotModal'
import { BotDetailView } from './BotDetailView'
import { RunsTab } from './RunsTab'
import { ArchivedTab } from './ArchivedTab'
import { estimateConfirmBot, estimatePaidBot, fetchBotDryRunResult, summarizePaperTrades } from './useDryRun'
import type { AiSignalEstimate } from '../../shared/aiSignal'
import type { AiOrderProposal } from '../../shared/aiProposal'
import {
  archiveBot,
  confirmsEntries,
  costsMoneyToRun,
  createBot,
  describeConfirmBotCost,
  describePaidBotCost,
  gptCadenceOf,
  gptPinsFrom,
  resolvedStrategy,
  withAiPins,
  type AiPins,
  type Bot,
  type ConfirmBotEstimate
} from './types'
import type { BotRun, Exchange, SymbolInfo } from '../../shared/ipc'
import { describeError } from '../utils/ipcError'

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
// Null returns here (never enabled, no candles, too-short run) are legitimate "nothing to
// record" cases and stay silent. A thrown error is not — it's left to the caller to surface,
// rather than swallowed here, since a bot the user just disabled silently losing its run history
// with zero feedback is exactly the kind of thing that should be visible.
async function buildRunRecord(bot: Bot, endedAt: number): Promise<BotRun | null> {
  if (bot.enabledAt === null) return null
  // Reuses the dry-run's own fetch + summary rather than re-deriving them. This previously
  // fetched candles starting at enabledAt with no warmup padding, while the card the user had
  // been watching fetches 220 extra candles first so EMA(200)/ATR(14) are actually warmed up.
  // A bot run of a few days is far shorter than that warmup, so the strategy produced no signals
  // at all and the permanently-saved record read "0 trades, 0.00%" -- flatly contradicting the
  // "3 paper trades, +4.2%" shown on the card right up until the moment it was disabled.
  // summarizePaperTrades is the same helper BotCard displays through, so the record and the card
  // now cannot drift apart.
  const fetched = await fetchBotDryRunResult(bot)
  if (fetched === null) return null
  const { paperTrades, paperWins, paperNetPct } = summarizePaperTrades(fetched.result.trades, bot.enabledAt)
  if (paperTrades.length === 0 && endedAt - bot.enabledAt < 300) return null
  const trades = paperTrades
  const wins = paperWins
  const netPct = paperNetPct
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
}

export function BotsPage({
  onPrepareOrder
}: {
  /** Opens an executor form filled in from a running bot's call to buy (shared/aiProposal.ts).
   * The form is on the Executors page, so this page only hands the proposal up. */
  onPrepareOrder?: (proposal: AiOrderProposal) => void
} = {}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('active')
  const [bots, setBots] = useState<Bot[]>([])
  const [botRuns, setBotRuns] = useState<BotRun[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)
  const [runRecordError, setRunRecordError] = useState<string | null>(null)
  const loadedRef = useRef(false)
  const enablingRef = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setBots(settings.bots)
      setBotRuns(settings.botRuns)
      loadedRef.current = true
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    void window.api.settings.set({ bots })
  }, [bots])

  function handleCreate(input: {
    name: string
    exchange: Exchange
    pair: SymbolInfo
    strategyId: string
    aiConfirm: boolean
    aiEveryBars: number
  }): void {
    const created = createBot({ id: crypto.randomUUID(), ...input })
    setBots((prev) => [...prev, created])
    setShowAdd(false)
    // OPEN WHAT WAS JUST MADE. The new card is appended to the end of the grid, so on a profile
    // with a few bots it lands below the fold: the modal closed, the visible page did not change,
    // and creating a bot looked like it had failed. It had not -- the record was written every
    // time -- but nothing on screen said so.
    setSelectedBotId(created.id)
  }

  /** Writes the permanent BotRun for a bot that has just stopped. Shared by disable and archive,
   * which are both stops and must both record one. */
  function recordRun(bot: Bot, endedAt: number): void {
    setRunRecordError(null)
    void buildRunRecord(bot, endedAt)
      .then((run) => {
        if (!run) return
        setBotRuns((prev) => {
          const next = [...prev, run]
          void window.api.settings.set({ botRuns: next })
          return next
        })
      })
      .catch((error) => {
        console.error('Failed to build bot run record:', error)
        setRunRecordError(`Couldn't save run history for "${bot.name}": ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** Flips a bot. `pin` is given only when a paid bot is being switched on, and fixes what it will
   * ask for as long as it stays on -- see Bot.aiModel and Bot.aiRoute. */
  function applyToggle(bot: Bot, pin?: AiPins): void {
    const turningOff = bot.enabled
    const nowSec = Math.floor(Date.now() / 1000)
    setBots((prev) =>
      prev.map((b) => (b.id === bot.id ? withAiPins({ ...b, enabled: !b.enabled, enabledAt: turningOff ? null : nowSec }, pin) : b))
    )
    if (turningOff) recordRun(bot, nowSec)
  }

  /** Every other strategy is free to run. GPT Intraday is not: it asks a model with the user's own
   * key, once per candle, for as long as the bot is on. The Backtest page has always asked before
   * spending; enabling a bot spent the same money on one click and said nothing. Asking here is
   * the same rule applied to the same cost -- and the question now carries the model and a
   * figure, read from the same estimate the run itself would be planned from. */
  async function enablePaidBot(bot: Bot): Promise<void> {
    // The estimate takes a moment (it fetches candles), and a second click in that gap would
    // otherwise raise a second confirmation for the same bot.
    if (enablingRef.current.has(bot.id)) return
    enablingRef.current.add(bot.id)
    try {
      let estimate: AiSignalEstimate | null = null
      let problem: string | null = null
      try {
        // Estimated without the old pins: switching on re-pins to the current default model, and
        // to the route set under Agents → Models if there is one.
        const config = await window.api.ai.getConfig()
        estimate = await estimatePaidBot({
          exchange: bot.exchange,
          symbol: bot.symbol,
          strategyId: bot.strategyId,
          aiEveryBars: bot.aiEveryBars,
          aiRoute: config.route ?? undefined
        })
      } catch (error) {
        problem = describeError(error)
      }
      if (!window.confirm(describePaidBotCost(bot.name, estimate, problem, gptCadenceOf(bot)))) return
      // Pinned from the estimate the confirmation was written from: what the bot runs is what was
      // just agreed to, never an older pin.
      applyToggle(bot, gptPinsFrom(estimate))
    } finally {
      enablingRef.current.delete(bot.id)
    }
  }

  /** The same rule for the other way a bot can spend: a model reviewing its strategy's entries.
   * Cheaper by orders of magnitude -- a call per signalled entry rather than per candle -- and
   * still the user's money, so it still asks, with the model and a price. */
  async function enableConfirmBot(bot: Bot): Promise<void> {
    if (enablingRef.current.has(bot.id)) return
    enablingRef.current.add(bot.id)
    try {
      let estimate: ConfirmBotEstimate | null = null
      let problem: string | null = null
      try {
        estimate = await estimateConfirmBot({ exchange: bot.exchange, symbol: bot.symbol, strategyId: bot.strategyId, aiConfirm: true })
      } catch (error) {
        problem = describeError(error)
      }
      if (!window.confirm(describeConfirmBotCost(bot.name, resolvedStrategy(bot).name, estimate, problem))) return
      applyToggle(bot, { model: estimate?.quote.model })
    } finally {
      enablingRef.current.delete(bot.id)
    }
  }

  function handleToggle(id: string): void {
    const bot = bots.find((b) => b.id === id)
    if (!bot) return
    if (!bot.enabled && costsMoneyToRun(bot.strategyId)) {
      void enablePaidBot(bot)
      return
    }
    if (!bot.enabled && confirmsEntries(bot)) {
      void enableConfirmBot(bot)
      return
    }
    applyToggle(bot)
  }

  function handleArchive(id: string): void {
    const bot = bots.find((b) => b.id === id)
    if (!bot) return
    // ARCHIVING A RUNNING BOT IS A STOP TOO. This wrote enabled:false and nothing else: no run
    // record, so the Archived tab's own promise -- "Archiving a bot from the Active tab keeps its
    // Runs history" -- was false for precisely the bots that had history worth keeping, and the
    // dry-run record vanished exactly as it would have before buildRunRecord existed. It also
    // left enabledAt set on a stopped bot, a state no other path in this page can produce.
    const nowSec = Math.floor(Date.now() / 1000)
    setBots((prev) => prev.map((b) => (b.id === id ? archiveBot(b) : b)))
    setSelectedBotId((prev) => (prev === id ? null : prev))
    if (bot.enabled) recordRun(bot, nowSec)
  }

  function handleRestore(id: string): void {
    setBots((prev) => prev.map((b) => (b.id === id ? { ...b, archived: false } : b)))
  }

  function handleDeletePermanently(id: string): void {
    const bot = bots.find((b) => b.id === id)
    if (!bot) return
    // The only irreversible action on this page, and it fired on a single click of a button
    // sitting directly beside Restore.
    const confirmed = window.confirm(
      `Delete "${bot.name}" permanently?\n\nIts recorded runs stay in the Runs tab, but the bot itself cannot be restored.`
    )
    if (!confirmed) return
    setBots((prev) => prev.filter((b) => b.id !== id))
  }

  const activeBots = bots.filter((b) => !b.archived)
  const archivedBots = bots.filter((b) => b.archived)
  const selectedBot = activeBots.find((b) => b.id === selectedBotId) ?? null

  return (
    <>
      <PageHeader title="Bots" subtitle="Configure and manage your AI trading bots" />

      {runRecordError && (
        <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0 0 0.9rem' }}>{runRecordError}</p>
      )}

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
              Enabling a bot starts a paper-trading dry run — real market data, its chosen strategy replayed the same
              way it was backtested, and simulated (not real) money. It only runs while this app is open, and never
              places real orders.
            </p>
          )}

          {selectedBot && (
            <div style={{ marginTop: '0.9rem' }}>
              <BotDetailView
                bot={selectedBot}
                onBack={() => setSelectedBotId(null)}
                onToggle={handleToggle}
                onPrepareOrder={onPrepareOrder}
              />
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
              <BotCard
                key={bot.id}
                bot={bot}
                onToggle={handleToggle}
                onArchive={handleArchive}
                onViewDetail={setSelectedBotId}
                onPrepareOrder={onPrepareOrder}
              />
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
