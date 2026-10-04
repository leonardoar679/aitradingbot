import { useEffect, useState } from 'react'
import { Activity, Atom, Boxes, History, KeyRound, Radar, Scale, type LucideIcon } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import type { AiCredentialStatus } from '../../shared/aiSignal'
import type { AiOrderProposal } from '../../shared/aiProposal'
import { AiKeyCard } from '../ai/AiKeyCard'
import { AnalyzeTab } from './AnalyzeTab'
import { BenchmarkTab } from './BenchmarkTab'
import { OpportunitiesTab } from './OpportunitiesTab'
import { SignalsTab } from './SignalsTab'
import { ModelsTab } from './ModelsTab'
import { UsageTab } from './UsageTab'
import { tabButtonStyle } from './agentStyles'

type Tab = 'analyze' | 'opportunities' | 'signals' | 'benchmark' | 'models' | 'usage'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'analyze', label: 'Analyze', icon: Atom },
  { id: 'opportunities', label: 'Opportunities', icon: Radar },
  { id: 'signals', label: 'Signals', icon: History },
  { id: 'benchmark', label: 'Benchmark', icon: Scale },
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'usage', label: 'Usage', icon: Activity }
]

/** The AI workspace: ask a model, put the events the scanner raises to several of them, see how
 * calls turned out, set several models against the same questions, choose which models may be
 * asked, and see what asking has cost.
 *
 * Each tab is mounted only while it is selected, so opening this page loads one tab's data and
 * nothing else. None of that loading reaches a model. Three things here spend: the Analyze button,
 * which carries its price; Ask on an event, which states its price in a confirmation first; and
 * a benchmark run, which reads the cache first and says what the rest will cost before anything
 * is asked.
 *
 * THE KEY IS ASKED FOR HERE, because this is the page that cannot do anything without it. With
 * none stored the card is above every tab and cannot be closed; once one is stored it folds away
 * behind "API key" on the tab row, where it can be replaced, tested or removed. */
export function AgentsPage({
  onPrepareOrder
}: {
  /** Opens an executor form filled in from a call (shared/aiProposal.ts). The form is on another
   * page, so this page only hands the proposal up; it has no way to submit one. */
  onPrepareOrder?: (proposal: AiOrderProposal) => void
} = {}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('analyze')
  const [keyStatus, setKeyStatus] = useState<AiCredentialStatus | null>(null)
  const [keyOpen, setKeyOpen] = useState(false)
  const [keyVersion, setKeyVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.api.ai.credentialsStatus().then((status) => {
      if (!cancelled) setKeyStatus(status)
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  const keyMissing = keyStatus !== null && !keyStatus.configured

  function handleKeyChanged(next: AiCredentialStatus): void {
    setKeyStatus(next)
    // Left open after a save, so the line saying the key was accepted does not vanish with the form.
    setKeyOpen(true)
    // Every tab priced, listed or refused by the key it found when it mounted. Mounting the one
    // on screen again is how it finds the new one.
    setKeyVersion((version) => version + 1)
  }

  return (
    <>
      <PageHeader title="Agents" subtitle="Ask a model about a market, and measure whether its calls were right" />

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} style={tabButtonStyle(tab === id)} onClick={() => setTab(id)}>
            <Icon size={15} />
            {label}
          </button>
        ))}
        {keyStatus?.configured === true && (
          <button
            style={{ ...tabButtonStyle(keyOpen), marginLeft: 'auto' }}
            onClick={() => setKeyOpen((open) => !open)}
            aria-expanded={keyOpen}
          >
            <KeyRound size={15} />
            API key
          </button>
        )}
      </div>

      {(keyMissing || keyOpen) && <AiKeyCard where="agents" onChanged={handleKeyChanged} />}

      {tab === 'analyze' && <AnalyzeTab key={keyVersion} onPrepareOrder={onPrepareOrder} />}
      {tab === 'opportunities' && <OpportunitiesTab key={keyVersion} onPrepareOrder={onPrepareOrder} />}
      {tab === 'signals' && <SignalsTab key={keyVersion} />}
      {tab === 'benchmark' && <BenchmarkTab key={keyVersion} />}
      {tab === 'models' && <ModelsTab key={keyVersion} />}
      {tab === 'usage' && <UsageTab key={keyVersion} />}
    </>
  )
}
