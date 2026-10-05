import { PageHeader } from '../components/PageHeader'
import { FirstRunCard, PortfolioSummary } from '../portfolio/PortfolioSections'

/** The landing page. */
export function OverviewPage({ onGetStarted }: { onGetStarted: () => void }): React.JSX.Element {
  return (
    <>
      <PageHeader title="Overview" subtitle="What you hold, and where to start" />
      <FirstRunCard onGetStarted={onGetStarted} />
      <PortfolioSummary />
    </>
  )
}
