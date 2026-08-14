import { useEffect, useState } from 'react'
import { Briefcase, Bot as BotIcon, TrendingUp, Link2 } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { PortfolioEvolutionChart } from './PortfolioEvolutionChart'
import { TopHoldings } from './TopHoldings'
import { usePortfolioSnapshots } from './portfolioStore'
import type { Bot } from '../../shared/ipc'

function formatUsd(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function PortfolioPage(): React.JSX.Element {
  const [bots, setBots] = useState<Bot[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (!cancelled) setBots(settings.bots)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const runningBots = bots.filter((b) => b.enabled).length

  const snapshots = usePortfolioSnapshots()
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  // "Since session start," not "this week" -- history is session-only (PortfolioScheduler starts
  // tracking from when the app launched), so a real calendar-week comparison doesn't exist yet.
  const sessionChange = snapshots.length >= 2 ? latest!.totalValue - snapshots[0].totalValue : null

  const totalValue = latest?.totalValue ?? 0
  const holdings = latest?.holdings ?? []
  const activeExecutorCount = latest?.activeExecutorCount ?? 0
  const botsAggregatePct = latest?.botsAggregatePct ?? null

  return (
    <>
      <PageHeader title="Portfolio" subtitle="Overview of your balances, bots, and performance" />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        <StatCard
          icon={Briefcase}
          label="Total Value"
          value={formatUsd(totalValue)}
          sub={sessionChange !== null ? `${formatUsd(sessionChange)} since session start` : undefined}
          subColor={sessionChange !== null && sessionChange < 0 ? 'var(--down)' : 'var(--up)'}
        />
        <StatCard
          icon={BotIcon}
          label="Active Bots"
          value={`${runningBots} running`}
        />
        <StatCard
          icon={TrendingUp}
          label="Bot PNL"
          value={botsAggregatePct !== null ? `${botsAggregatePct >= 0 ? '+' : ''}${botsAggregatePct.toFixed(2)}%` : 'No paper trades yet'}
          valueColor={botsAggregatePct !== null ? (botsAggregatePct >= 0 ? 'var(--up)' : 'var(--down)') : undefined}
        />
        <StatCard
          icon={Link2}
          label="System"
          value={`${holdings.length} assets / ${activeExecutorCount} executors`}
        />
      </div>

      <PortfolioEvolutionChart />

      <TopHoldings holdings={holdings} totalValue={totalValue} />
    </>
  )
}
