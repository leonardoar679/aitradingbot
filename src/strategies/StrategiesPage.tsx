import { Activity, Zap } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { PageTabs } from '../components/PageTabs'
import { BotsPage } from '../bots/BotsPage'
import { ExecutorsPage } from '../executors/ExecutorsPage'
import type { StrategiesTab } from '../navigation/pages'
import type { AiOrderProposal } from '../../shared/aiProposal'

/** What runs: the strategy bots (Active Runs) and the executors they and you run on (Execution).
 * The eight executor types, the starter presets and the New Executor form are all on Execution,
 * which is also where a call's filled-in order form opens. */
export function StrategiesPage({
  tab,
  onTab,
  onPrepareOrder,
  autoOpenPresets,
  onPresetsOpened,
  proposal,
  proposalLive = false,
  onProposalTaken
}: {
  tab: StrategiesTab
  onTab: (tab: StrategiesTab) => void
  onPrepareOrder: (proposal: AiOrderProposal, live?: boolean) => void
  autoOpenPresets: boolean
  onPresetsOpened: () => void
  proposal: AiOrderProposal | null
  /** The call was confirmed (CONFIRM): the form opens as a real order where the session allows. */
  proposalLive?: boolean
  onProposalTaken: () => void
}): React.JSX.Element {
  return (
    <>
      <PageHeader title="Strategies" subtitle="What runs: strategy bots, and the executors they and you run on" />
      <PageTabs
        tabs={[
          { id: 'runs', label: 'Active Runs', icon: Zap },
          { id: 'execution', label: 'Execution', icon: Activity }
        ]}
        current={tab}
        onChange={onTab}
      />
      {tab === 'runs' && <BotsPage embedded onPrepareOrder={onPrepareOrder} />}
      {tab === 'execution' && (
        <ExecutorsPage
          embedded
          autoOpenPresets={autoOpenPresets}
          onPresetsOpened={onPresetsOpened}
          proposal={proposal}
          proposalLive={proposalLive}
          onProposalTaken={onProposalTaken}
        />
      )}
    </>
  )
}
