import { useState } from 'react'
import { FlaskConical, Table2, Timer } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { PageTabs } from '../components/PageTabs'
import { AiKeyGate } from '../ai/AiKeyGate'
import { BenchmarkTab } from '../agents/BenchmarkTab'
import { ResearchTab } from '../agents/ResearchTab'
import { ExperimentsTab } from './ExperimentsTab'

type BenchmarkPageTab = 'benchmark' | 'research' | 'experiments'

/** Several models on the same questions, scored side by side, and the experiments kept; since
 * 8 October 2026, the research on the record; and the runs the app keeps of itself (V5 Stage 9).
 * It asks, scores and shows, and does nothing else: no answer here reaches an order form. The
 * research and the runs ask no model at all, so they need no key. */
export function AiBenchmarkPage(): React.JSX.Element {
  const [tab, setTab] = useState<BenchmarkPageTab>('benchmark')
  return (
    <>
      <PageHeader title="AI Benchmark" subtitle="Several models on the same questions, scored side by side, every experiment kept, the research on the record, and the app's own runs" />
      <PageTabs
        tabs={[
          { id: 'benchmark', label: 'Benchmark', icon: FlaskConical },
          { id: 'research', label: 'Research', icon: Table2 },
          { id: 'experiments', label: 'Experiments', icon: Timer }
        ]}
        current={tab}
        onChange={setTab}
      />
      {tab === 'benchmark' && <AiKeyGate>{(version) => <BenchmarkTab key={version} />}</AiKeyGate>}
      {tab === 'research' && <ResearchTab />}
      {tab === 'experiments' && <ExperimentsTab />}
    </>
  )
}
