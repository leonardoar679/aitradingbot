import { useEffect, useState } from 'react'
import { Briefcase, Bot as BotIcon, TrendingUp, Link2, Sparkles } from 'lucide-react'
import { StatCard } from '../components/StatCard'
import { PortfolioEvolutionChart } from './PortfolioEvolutionChart'
import { TopHoldings } from './TopHoldings'
import { usePortfolioSnapshots, usePortfolioStatus, usePortfolioErrorMessage } from './portfolioStore'
import type { Bot } from '../../shared/ipc'
import { cleanIpcErrorMessage } from '../utils/ipcError'
import { useI18n } from '../i18n'

// What was the Portfolio page, in the pieces the new pages are made of: the first-run card leads
// Overview, and the value, the chart and the holdings are on Performance. Every figure still comes
// from PortfolioScheduler's snapshots, which run whichever page is open.

function formatUsd(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function useSettingsCounts(): { bots: Bot[]; executorCount: number | null } {
  const [bots, setBots] = useState<Bot[]>([])
  // null until settings have been read, so the first-run card cannot flash at someone who
  // already has executors set up.
  const [executorCount, setExecutorCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setBots(settings.bots)
      setExecutorCount(settings.executors.length)
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  return { bots, executorCount }
}

/** Overview is the landing page, so this is the only screen a brand-new user is guaranteed to see.
 * Without it the Starter Presets sit behind a button on a page they have no reason to open, which
 * makes them useless to exactly the person they were built for. */
export function FirstRunCard({ onGetStarted }: { onGetStarted: () => void }): React.JSX.Element | null {
  const { bots, executorCount } = useSettingsCounts()
  if (!(executorCount === 0 && bots.length === 0)) return null

  return (
    <div
      style={{
        display: 'flex',
        gap: '0.9rem',
        alignItems: 'flex-start',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)',
        padding: '1rem 1.1rem'
      }}
    >
      <Sparkles size={18} style={{ color: 'var(--gold)', flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.92rem' }}>Nothing running yet</div>
        <p style={{ margin: '0.35rem 0 0', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          If you have not set up a trading bot before, the starter presets are the place to begin — ready-made
          strategies adapted from Hummingbot, each one explaining in plain language what it does and the conditions
          under which it loses money. They run on <strong style={{ color: 'var(--text-primary)' }}>simulated money</strong>{' '}
          against real market prices, so nothing here can cost you anything.
        </p>
        <button
          onClick={onGetStarted}
          style={{
            marginTop: '0.7rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'var(--accent)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '0.5rem 0.9rem',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 700,
            cursor: 'pointer'
          }}
        >
          <Sparkles size={14} /> Browse Starter Presets
        </button>
      </div>
    </div>
  )
}

/** Total value, bots running and their P&L, and what the system holds. */
export function PortfolioSummary(): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const usd = (value: number): string => (i18n.language === 'en' ? formatUsd(value) : i18n.money(value, 'USD', 2))
  const { bots } = useSettingsCounts()
  const runningBots = bots.filter((b) => b.enabled).length

  const snapshots = usePortfolioSnapshots()
  const status = usePortfolioStatus()
  const errorMessage = usePortfolioErrorMessage()
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  // "Since session start," not "this week" -- history is session-only (PortfolioScheduler starts
  // tracking from when the app launched), so a real calendar-week comparison doesn't exist yet.
  const sessionChange = snapshots.length >= 2 ? latest!.totalValue - snapshots[0].totalValue : null

  const totalValue = latest?.totalValue ?? 0
  const holdings = latest?.holdings ?? []
  const activeExecutorCount = latest?.activeExecutorCount ?? 0
  const botsAggregatePct = latest?.botsAggregatePct ?? null

  // Every figure below comes from the snapshot, so before the first one lands they are all
  // placeholders rather than facts. Rendering the placeholder zeros as real numbers told anyone
  // launching the app with open positions that their portfolio was worth $0.00 -- which is both
  // wrong and alarming -- for however long that first pass took.
  const pending = status !== 'ready'
  const pendingValue = status === 'error' ? t('Unavailable') : t('Loading…')

  return (
    <>
      {status === 'error' && (
        <div
          style={{
            background: 'rgba(239,83,80,0.12)',
            border: '1px solid rgba(239,83,80,0.4)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.7rem 0.9rem',
            color: 'var(--down)',
            fontSize: '0.8rem',
            lineHeight: 1.5
          }}
        >
          {errorMessage
            ? t("Couldn't read your portfolio: {error} Your positions are unaffected — this page only reads them. It retries automatically every couple of minutes.", { error: cleanIpcErrorMessage(errorMessage) })
            : t("Couldn't read your portfolio. Your positions are unaffected — this page only reads them. It retries automatically every couple of minutes.")}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        <StatCard
          icon={Briefcase}
          label={t('Total Value')}
          value={pending ? pendingValue : usd(totalValue)}
          sub={!pending && sessionChange !== null ? t('{change} since session start', { change: usd(sessionChange) }) : undefined}
          subColor={sessionChange !== null && sessionChange < 0 ? 'var(--down)' : 'var(--up)'}
        />
        <StatCard icon={BotIcon} label={t('Active Bots')} value={t('{count} running', { count: runningBots })} wraps />
        <StatCard
          icon={TrendingUp}
          label={t('Bot PNL')}
          value={
            pending
              ? pendingValue
              : botsAggregatePct !== null
                ? i18n.language === 'en'
                  ? `${botsAggregatePct >= 0 ? '+' : ''}${botsAggregatePct.toFixed(2)}%`
                  : i18n.pct(botsAggregatePct, 2)
                : t('No paper trades yet')
          }
          valueColor={!pending && botsAggregatePct !== null ? (botsAggregatePct >= 0 ? 'var(--up)' : 'var(--down)') : undefined}
          wraps={!pending && botsAggregatePct === null}
        />
        <StatCard icon={Link2} label={t('System')} value={pending ? pendingValue : t('{assets} assets / {executors} executors', { assets: holdings.length, executors: activeExecutorCount })} wraps />
      </div>
    </>
  )
}

/** The value over time, and what it is made of. */
export function PortfolioHistory(): React.JSX.Element {
  const snapshots = usePortfolioSnapshots()
  const status = usePortfolioStatus()
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null

  return (
    <>
      <PortfolioEvolutionChart />
      <TopHoldings holdings={latest?.holdings ?? []} totalValue={latest?.totalValue ?? 0} status={status} unavailable={latest?.unavailable} />
    </>
  )
}
