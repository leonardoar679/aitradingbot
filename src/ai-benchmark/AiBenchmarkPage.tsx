import { useState } from 'react'
import { FlaskConical, Table2 } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { PageTabs } from '../components/PageTabs'
import { AiKeyGate } from '../ai/AiKeyGate'
import { BenchmarkTab } from '../agents/BenchmarkTab'
import { ResearchTab } from '../agents/ResearchTab'

type BenchmarkPageTab = 'benchmark' | 'research'

/** Several models on the same questions, scored side by side, and the experiments kept; and, since
 * 8 October 2026, the research on the record. It asks, scores and shows, and does nothing else: no
 * answer here reaches an order form. The research asks no model at all, so it needs no key. */
export function AiBenchmarkPage(): React.JSX.Element {
  const [tab, setTab] = useState<BenchmarkPageTab>('benchmark')
  return (
    <>
      <PageHeader title="AI Benchmark" subtitle="Several models on the same questions, scored side by side, every experiment kept, and the research on the record" />
      <PageTabs
        tabs={[
          { id: 'benchmark', label: 'Benchmark', icon: FlaskConical },
          { id: 'research', label: 'Research', icon: Table2 }
        ]}
        current={tab}
        onChange={setTab}
      />
      {tab === 'benchmark' && <AiKeyGate>{(version) => <BenchmarkTab key={version} />}</AiKeyGate>}
      {tab === 'research' && <ResearchTab />}
    </>
  )
}
