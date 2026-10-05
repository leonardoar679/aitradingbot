import { PageHeader } from '../components/PageHeader'
import { FirstRunCard } from '../portfolio/PortfolioSections'
import type { AiOrderProposal } from '../../shared/aiProposal'
import type { Page } from '../navigation/pages'
import { HoldingsSummary } from './HoldingsSummary'
import { MarketSummaryCard } from './MarketSummaryCard'
import { SafetySummary } from './SafetySummary'
import { TopOpportunityCard } from './TopOpportunityCard'

/** The landing page, answering five questions from what the app already reads: what the market
 * is doing, what can be acted on, what the models make of it, what you hold, and whether real
 * money is at risk. Opening it asks no model and places nothing. */
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1.25rem', alignItems: 'start' }}>
        <MarketSummaryCard onNavigate={onNavigate} />
        <SafetySummary onNavigate={onNavigate} />
      </div>
      <TopOpportunityCard onPrepareOrder={onPrepareOrder} onNavigate={onNavigate} />
      <HoldingsSummary onNavigate={onNavigate} />
    </>
  )
}
