import { PageHeader } from '../components/PageHeader'
import { PaperAccountSection } from '../account/PaperAccountSection'
import { TradePage } from '../trade/TradePage'

/** Simulated money against real prices: the paper account paper strategies spend and hand back,
 * and the manual paper order ticket. Nothing here reaches an exchange. */
export function PaperTradingPage(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Paper Trading"
        subtitle="Simulated money against real prices: the paper account, and a manual paper order ticket. Nothing here reaches an exchange."
      />
      <PaperAccountSection />
      <TradePage embedded />
    </>
  )
}
