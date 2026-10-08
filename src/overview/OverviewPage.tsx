import { PageHeader } from '../components/PageHeader'
import { FirstRunCard } from '../portfolio/PortfolioSections'
import type { AiOrderProposal } from '../../shared/aiProposal'
import type { Page } from '../navigation/pages'
import { BreakingEventsCard } from './BreakingEventsCard'
import { HoldingsSummary } from './HoldingsSummary'
import { MarketStatusStrip } from './MarketStatusStrip'
import { MarketSummaryCard } from './MarketSummaryCard'
import { NewsImpactCard } from './NewsImpactCard'
import { SafetySummary } from './SafetySummary'
import { TodayPerformanceCard } from './TodayPerformanceCard'
import { TopOpportunityCard } from './TopOpportunityCard'

/** The landing page, in the order the second V3 document's §51 gives it, from what the app already
 * reads: the market's status, the best opportunities, the breaking events, the news that matters,
 * what you hold, and what today made -- and whether real money is at risk. Opening it asks no model
 * and places nothing. */
export function OverviewPage({
  onGetStarted,
  onPrepareOrder,
  onNavigate
}: {
  onGetStarted: () => void
  onPrepareOrder: (proposal: AiOrderProposal) => void
  onNavigate: (page: Page) => void
}): React.JSX.Element {
  return (
    <>
      <PageHeader title="Overview" subtitle="What the market is doing, what can be acted on, what you hold, and whether real money is at risk" />
      <FirstRunCard onGetStarted={onGetStarted} />
      <MarketStatusStrip />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1.25rem', alignItems: 'start' }}>
        <MarketSummaryCard onNavigate={onNavigate} />
        <SafetySummary onNavigate={onNavigate} />
      </div>
      <TopOpportunityCard onPrepareOrder={onPrepareOrder} onNavigate={onNavigate} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1.25rem', alignItems: 'start' }}>
        <BreakingEventsCard onNavigate={onNavigate} />
        <NewsImpactCard onNavigate={onNavigate} />
      </div>
      <HoldingsSummary onNavigate={onNavigate} />
      <TodayPerformanceCard onNavigate={onNavigate} />
    </>
  )
}
