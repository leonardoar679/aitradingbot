import { History, Repeat } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { PageTabs } from '../components/PageTabs'
import { BacktestPage } from '../backtest/BacktestPage'
import { RoutinesPage } from '../routines/RoutinesPage'
import type { ResearchTab } from '../navigation/pages'

/** History, measured: a strategy backtested over a chosen range, compared, charted and monitored
 * live (Backtest), and backtests re-run on a schedule while the app is open (Automation). */
export function ResearchPage({ tab, onTab }: { tab: ResearchTab; onTab: (tab: ResearchTab) => void }): React.JSX.Element {
  return (
    <>
      <PageHeader title="Backtest & Research" subtitle="Strategies run over history, compared and charted, and backtests re-run on a schedule" />
      <PageTabs
        tabs={[
          { id: 'backtest', label: 'Backtest', icon: History },
          { id: 'automation', label: 'Automation', icon: Repeat }
        ]}
        current={tab}
        onChange={onTab}
      />
      {tab === 'backtest' && <BacktestPage embedded />}
      {tab === 'automation' && (
        <>
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Recurring backtests that re-run on a schedule while this app is open, each run keeping its report for the session.
          </p>
          <RoutinesPage embedded />
        </>
      )}
    </>
  )
}
