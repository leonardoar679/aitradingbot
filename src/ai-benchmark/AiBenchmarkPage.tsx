import { PageHeader } from '../components/PageHeader'
import { AiKeyGate } from '../ai/AiKeyGate'
import { BenchmarkTab } from '../agents/BenchmarkTab'

/** Several models on the same questions, scored side by side, and the experiments kept. It asks,
 * scores and shows, and does nothing else: no answer here reaches an order form. */
export function AiBenchmarkPage(): React.JSX.Element {
  return (
    <>
      <PageHeader title="AI Benchmark" subtitle="Several models on the same questions, scored side by side, and every experiment kept" />
      <AiKeyGate>{(version) => <BenchmarkTab key={version} />}</AiKeyGate>
    </>
  )
}
