import { Atom, History, ListChecks } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { PageTabs } from '../components/PageTabs'
import { AiKeyGate } from '../ai/AiKeyGate'
import { AnalyzeTab } from '../agents/AnalyzeTab'
import { SignalsTab } from '../agents/SignalsTab'
import { EventDecisionsTab } from './EventDecisionsTab'
import type { AiDecisionsTab } from '../navigation/pages'
import type { AiOrderProposal } from '../../shared/aiProposal'

/** A model's decision about one market, asked for by hand; every call any model has made with
 * how it turned out; and, since 8 October 2026 (the V5 document, §54), each recent event with
 * what every model said about it.
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
      <PageHeader title="AI Decisions" subtitle="Ask a model about a market, see each event with every model's answer, and every call and how it turned out" />
      <AiKeyGate>
        {(version) => (
          <>
            <PageTabs
              tabs={[
                { id: 'analyze', label: 'Analyze', icon: Atom },
                { id: 'events', label: 'Events', icon: ListChecks },
                { id: 'signals', label: 'Signals', icon: History }
              ]}
              current={tab}
              onChange={onTab}
            />
            {tab === 'analyze' && <AnalyzeTab key={version} onPrepareOrder={onPrepareOrder} />}
            {tab === 'events' && <EventDecisionsTab key={version} />}
            {tab === 'signals' && <SignalsTab key={version} />}
          </>
        )}
      </AiKeyGate>
    </>
  )
}
