import { PageHeader } from '../components/PageHeader'
import { AiKeyGate } from '../ai/AiKeyGate'
import { OpportunitiesTab } from '../agents/OpportunitiesTab'
import type { AiOrderProposal } from '../../shared/aiProposal'

/** What can be traded right now: the watch, the recommendations still valid, and every event the
 * scanner raised with what the models asked about it recommend.
 *
 * NOTHING HERE TRADES. "Paper trade" on a call hands a filled-in order form up to the app, which
 * opens it on Strategies › Execution; a person sets the amount and submits it there. */
export function OpportunitiesPage({
  onPrepareOrder
}: {
  /** Opens an executor form filled in from a recommendation. The form is on another page, so this
   * page only hands the proposal up; it has no way to submit one. */
  onPrepareOrder: (proposal: AiOrderProposal) => void
}): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Opportunities"
        subtitle="What can be traded right now: the events the scanner raised, and what the models asked about them recommend"
      />
      <AiKeyGate>{(version) => <OpportunitiesTab key={version} onPrepareOrder={onPrepareOrder} />}</AiKeyGate>
    </>
  )
}
