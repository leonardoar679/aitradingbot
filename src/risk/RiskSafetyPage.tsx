import { PageHeader } from '../components/PageHeader'
import { ControllersPage } from '../controllers/ControllersPage'
import { LiveRiskLimitsCard } from './LiveRiskLimitsCard'

/** Every limit in the app, in one place: the ones every real order is checked against, and the
 * controller groups that stop the executors attached to them when a shared limit is breached.
 * Arming and the kill switch stay on the bar at the top of every page, where they are one click
 * from anywhere. */
export function RiskSafetyPage(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Risk & Safety"
        subtitle="The limits every real order is checked against, and the groups that stop strategies on a breach"
      />
      <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        Arming live trading and the kill switch are on the bar at the top of every page. A model never sizes, places or arms an
        order: whatever a model says, these limits and that bar are what a real order has to pass.
      </p>
      <LiveRiskLimitsCard />
      <div style={{ marginTop: '0.4rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Controller groups</h2>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Executors grouped under a shared stop-loss, take-profit and maximum drawdown, with a P&amp;L snapshot every five
          minutes. A breach stops every executor attached.
        </p>
      </div>
      <ControllersPage embedded />
    </>
  )
}
