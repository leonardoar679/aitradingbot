import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { LiveAccountSection } from '../account/LiveAccountSection'
import type { LiveTradingStatus, LiveWatcherSummary } from '../../shared/ipc'
import type { Page } from '../navigation/pages'

const POLL_MS = 15_000

function line(label: string, value: string, tone?: 'up' | 'down' | 'gold'): React.JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.35rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.82rem' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: tone === undefined ? 'var(--text-primary)' : tone === 'gold' ? 'var(--gold)' : `var(--${tone})` }}>{value}</span>
    </div>
  )
}

/** The session's gates as they stand, read only. Arming and the kill switch are on the bar at the
 * top of every page and stay there; the limits are set on Risk & Safety. */
function LiveSessionCard({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const [status, setStatus] = useState<LiveTradingStatus | null>(null)
  const [watchers, setWatchers] = useState<LiveWatcherSummary[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      window.api.liveTrading.getStatus().then(
        (next) => {
          if (!cancelled) {
            setStatus(next)
            setProblem(null)
          }
        },
        () => {
          if (!cancelled) setProblem('The live trading status could not be read.')
        }
      )
      window.api.liveTrading.listActiveWatchers().then(
        (next) => {
          if (!cancelled) setWatchers(next)
        },
        () => undefined
      )
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const link = (label: string, page: Page): React.JSX.Element => (
    <button
      onClick={() => onNavigate(page)}
      style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}
    >
      {label}
    </button>
  )

  return (
    <Card title="This session">
      {problem !== null ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--down)' }}>{problem}</p>
      ) : status === null ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>Loading…</p>
      ) : (
        <>
          {line('Real orders', status.killSwitchEngaged ? 'Blocked by the kill switch' : status.sessionArmed ? 'Armed: can be placed' : 'Disarmed: none can be placed', status.killSwitchEngaged ? 'down' : status.sessionArmed ? 'down' : 'up')}
          {line('Placed today', `${status.dailyUsedQuote.toFixed(2)} of ${status.dailyCapQuote} a day`)}
          {line(
            'Realized today',
            `${status.realizedPnlToday >= 0 ? '+' : ''}${status.realizedPnlToday.toFixed(2)}, against a loss limit of ${status.dailyLossLimitQuote} a day`,
            status.realizedPnlToday < 0 ? 'down' : undefined
          )}
          {line(
            'Managed allocation',
            status.allocationQuote === null ? 'None set' : `${status.allocationCommittedQuote.toFixed(2)} of ${status.allocationQuote.toFixed(2)} at work`
          )}
          {line('Exits being watched', watchers.length === 0 ? 'None' : `${watchers.length}: ${watchers.map((watcher) => watcher.symbol).join(', ')}`)}
          <p style={{ margin: '0.75rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
            Arming and the kill switch are on the bar at the top of every page. The limits are set on {link('Risk & Safety', 'risk')}, real
            positions and their history are on {link('Positions', 'positions')}, and live executors are made and stopped on{' '}
            {link('Strategies', 'strategies')}.
          </p>
        </>
      )}
    </Card>
  )
}

/** Real money: the session's gates, and what you really hold on each connected exchange. */
export function LiveTradingPage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  return (
    <>
      <PageHeader title="Live Trading" subtitle="Real money: the session's gates, and what you hold on your connected exchanges" />
      <LiveSessionCard onNavigate={onNavigate} />
      <LiveAccountSection />
    </>
  )
}
