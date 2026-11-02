import { PageHeader } from '../components/PageHeader'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { PaperAccountSection } from '../account/PaperAccountSection'
import { TradePage } from '../trade/TradePage'
import { EnglishOnly, msg, useI18n } from '../i18n'
import { PaperTestingCard } from './PaperTestingCard'

/** Simulated money against real prices: paper testing's three books, the paper account paper strategies spend and hand
 * back, and the manual paper order ticket. Nothing here reaches an exchange. Translated since V8 Stage 10, but the
 * paper account's section, which stays English. `askStart` opens Start's confirmation, as Home's tile asks. */
export function PaperTradingPage({ askStart = false, onHandoffTaken }: { askStart?: boolean; onHandoffTaken?: () => void } = {}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <PageHeader title={t('Paper Trading')} subtitle={t('Simulated money against real prices: the three paper books, the paper account, and a manual paper order ticket. Nothing here reaches an exchange.')} />
      <ErrorBoundary label={msg('Paper testing')}>
        <PaperTestingCard askStart={askStart} onAskTaken={onHandoffTaken} />
      </ErrorBoundary>
      <EnglishOnly>
        <PaperAccountSection />
      </EnglishOnly>
      <TradePage embedded />
    </>
  )
}
