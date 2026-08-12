import { useEffect, useState } from 'react'
import { Briefcase, Bot as BotIcon, TrendingUp, Link2 } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { PortfolioEvolutionChart } from './PortfolioEvolutionChart'
import { TopHoldings } from './TopHoldings'
import { MOCK_HOLDINGS, TOTAL_VALUE, WEEKLY_CHANGE } from './data'
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

  return (
    <>
      <PageHeader title="Portfolio" subtitle="Overview of your balances, bots, and performance" />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        <StatCard
          icon={Briefcase}
          label="Total Value"
          value={formatUsd(TOTAL_VALUE)}
          sub={`(${formatUsd(WEEKLY_CHANGE)} this week)`}
          subColor="var(--down)"
        />
        <StatCard
          icon={BotIcon}
          label="Active Bots"
          value={`${runningBots} running`}
        />
        <StatCard
          icon={TrendingUp}
          label="Bot PNL"
          value="+$0.00"
          valueColor="var(--positive)"
        />
        <StatCard
          icon={Link2}
          label="System"
          value={`${MOCK_HOLDINGS.length} assets / 0 executors`}
        />
      </div>

      <PortfolioEvolutionChart />

      <TopHoldings />
    </>
  )
}
