import { PageHeader } from '../components/PageHeader'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { PaperAccountSection } from '../account/PaperAccountSection'
import { TradePage } from '../trade/TradePage'
import { PaperTestingCard } from './PaperTestingCard'

/** Simulated money against real prices: the paper account paper strategies spend and hand back,
 * and the manual paper order ticket. Nothing here reaches an exchange. */
export function PaperTradingPage(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Paper Trading"
        subtitle="Simulated money against real prices: the paper account, and a manual paper order ticket. Nothing here reaches an exchange."
      />
      <ErrorBoundary label="Paper testing">
        <PaperTestingCard />
      </ErrorBoundary>
      <PaperAccountSection />
      <TradePage embedded />
    </>
  )
}
