import { PageHeader } from '../components/PageHeader'
import { HoldingsSummary } from '../overview/HoldingsSummary'
import { MarketStatusStrip } from '../overview/MarketStatusStrip'
import { TopOpportunityCard } from '../overview/TopOpportunityCard'
import type { AiOrderProposal } from '../../shared/aiProposal'
import type { Page } from '../navigation/pages'

/** The first thing a person sees (the V6 document, §3): the market in a line, then what can be acted
 * on, then what is held. The prediction goes on top once the forecast engine makes one; until then
 * the best opportunity the watch has is what this page leads with. Everything Overview had stays on
 * Overview, under All Features. Opening it asks no model and places nothing. */
export function HomePage({ onPrepareOrder, onNavigate }: { onPrepareOrder: (proposal: AiOrderProposal) => void; onNavigate: (page: Page) => void }): React.JSX.Element {
  return (
    <>
      <PageHeader title="Home" subtitle="The market in a line, what can be acted on now, and what you hold" />
      <MarketStatusStrip />
      <TopOpportunityCard onPrepareOrder={onPrepareOrder} onNavigate={onNavigate} />
      <HoldingsSummary onNavigate={onNavigate} />
    </>
  )
}
