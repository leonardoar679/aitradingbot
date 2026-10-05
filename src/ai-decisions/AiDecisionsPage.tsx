import { Atom, History } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { PageTabs } from '../components/PageTabs'
import { AiKeyGate } from '../ai/AiKeyGate'
import { AnalyzeTab } from '../agents/AnalyzeTab'
import { SignalsTab } from '../agents/SignalsTab'
import type { AiDecisionsTab } from '../navigation/pages'
import type { AiOrderProposal } from '../../shared/aiProposal'

/** A model's decision about one market, asked for by hand, and every call any model has made with
 * how it turned out.
 *
 * NOTHING HERE TRADES. A call to buy can fill in an order form, which this page hands up to the
 * app to open on Strategies › Execution; a person sets the amount and submits it there. */
export function AiDecisionsPage({
  tab,
  onTab,
  onPrepareOrder
}: {
  tab: AiDecisionsTab
  onTab: (tab: AiDecisionsTab) => void
  onPrepareOrder: (proposal: AiOrderProposal) => void
}): React.JSX.Element {
  return (
    <>
      <PageHeader title="AI Decisions" subtitle="Ask a model about a market, and see every call and how it turned out" />
      <AiKeyGate>
        {(version) => (
          <>
            <PageTabs
              tabs={[
                { id: 'analyze', label: 'Analyze', icon: Atom },
                { id: 'signals', label: 'Signals', icon: History }
              ]}
              current={tab}
              onChange={onTab}
            />
            {tab === 'analyze' && <AnalyzeTab key={version} onPrepareOrder={onPrepareOrder} />}
            {tab === 'signals' && <SignalsTab key={version} />}
          </>
        )}
      </AiKeyGate>
    </>
  )
}
