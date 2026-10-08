import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { SummaryLine } from '../components/SummaryLine'
import { TextLink } from '../components/TextLink'
import { LiveAccountSection } from '../account/LiveAccountSection'
import { LivePathCard } from './LivePathCard'
import type { LiveTradingStatus, LiveWatcherSummary } from '../../shared/ipc'
import type { Page } from '../navigation/pages'

const POLL_MS = 15_000

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

  return (
    <Card title="This session">
      {problem !== null ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--down)' }}>{problem}</p>
      ) : status === null ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>Loading…</p>
      ) : (
        <>
          <SummaryLine
            label="Real orders"
            value={status.killSwitchEngaged ? 'Blocked by the kill switch' : status.sessionArmed ? 'Armed: can be placed' : 'Disarmed: none can be placed'}
            tone={status.killSwitchEngaged || status.sessionArmed ? 'down' : 'up'}
          />
          <SummaryLine label="Placed today" value={`${status.dailyUsedQuote.toFixed(2)} of ${status.dailyCapQuote} a day`} />
          <SummaryLine
            label="Realized today"
            value={`${status.realizedPnlToday >= 0 ? '+' : ''}${status.realizedPnlToday.toFixed(2)}, against a loss limit of ${status.dailyLossLimitQuote} a day`}
            tone={status.realizedPnlToday < 0 ? 'down' : undefined}
          />
          <SummaryLine
            label="Managed allocation"
            value={status.allocationQuote === null ? 'None set' : `${status.allocationCommittedQuote.toFixed(2)} of ${status.allocationQuote.toFixed(2)} at work`}
          />
          <SummaryLine label="Exits being watched" value={watchers.length === 0 ? 'None' : `${watchers.length}: ${watchers.map((watcher) => watcher.symbol).join(', ')}`} />
          <p style={{ margin: '0.75rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
            Arming and the kill switch are on the bar at the top of every page. The limits are set on{' '}
            <TextLink onClick={() => onNavigate('risk')}>Risk &amp; Safety</TextLink>, real positions and their history are on{' '}
            <TextLink onClick={() => onNavigate('positions')}>Positions</TextLink>, and live executors are made and stopped on{' '}
            <TextLink onClick={() => onNavigate('strategies')}>Strategies</TextLink>.
          </p>
        </>
      )}
    </Card>
  )
}

/** Real money: the session's gates, where you stand on the path to live, and what you really hold on
 * each connected exchange. */
export function LiveTradingPage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  return (
    <>
      <PageHeader title="Live Trading" subtitle="Real money: the session's gates, the path to live, and what you hold on your connected exchanges" />
      <LiveSessionCard onNavigate={onNavigate} />
      <LivePathCard onNavigate={onNavigate} />
      <LiveAccountSection />
    </>
  )
}
