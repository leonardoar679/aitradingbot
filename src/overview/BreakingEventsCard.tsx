import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { TextLink } from '../components/TextLink'
import { describeEventType } from '../../shared/marketEvent'
import { noteStyle } from '../agents/agentStyles'
import { useEventFeed } from '../agents/useEventFeed'
import { subscribeAlerts, type AlertRecord } from '../news/alertStore'
import type { Page } from '../navigation/pages'
import { useNowSec } from '../utils/useNowSec'
import { breakingEvents, describeAnswers, majorAlerts } from './overviewBlocks'

/** Events read for this card: the newest, as many as Opportunities shows at first. */
const EVENTS_READ = 20

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** The last hour's events at candidate or above, strongest first (a market-wide move before the
 * pairs in it), with what the models said about each, and the session's alerts at HIGH or above
 * (the second V3 document, §51). It reads the scanner's events, the ledger's answers and the alerts
 * raised; it asks and opens nothing. */
export function BreakingEventsCard({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const { feed, scannerOn, problem } = useEventFeed(EVENTS_READ)
  const nowSec = useNowSec(true, 15_000)
  const [alerts, setAlerts] = useState<readonly AlertRecord[]>([])
  useEffect(() => subscribeAlerts(setAlerts), [])
  const events = useMemo(() => breakingEvents(feed, nowSec), [feed, nowSec])
  const major = useMemo(() => majorAlerts(alerts), [alerts])

  return (
    <Card title="Breaking events">
      {problem !== null ? (
        <p style={noteStyle}>{problem}</p>
      ) : events.length === 0 ? (
        <p style={{ ...noteStyle, marginTop: 0 }}>{scannerOn === false ? 'The scanner is off, so no event is being raised.' : 'No event at candidate or above in the last hour.'}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.86rem', lineHeight: 1.6, color: 'var(--text-primary)' }}>
          {events.map((item) => (
            <li key={item.event.id}>
              <strong>{item.event.symbol}</strong> {describeEventType(item.event.type).toLowerCase()} at {utcClock(item.event.time)} UTC, score {item.event.score.toFixed(0)} ({item.event.band})
              <span style={{ color: 'var(--text-secondary)' }}> · models: {describeAnswers(item)}</span>
            </li>
          ))}
        </ul>
      )}
      {major.length > 0 && (
        <>
          <p style={{ margin: '0.7rem 0 0.2rem', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>Major alerts this session</p>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.84rem', lineHeight: 1.6 }}>
            {major.map((alert) => (
              <li key={alert.id}>
                <strong style={{ color: alert.severity === 'critical' ? 'var(--down)' : 'var(--gold, var(--text-primary))' }}>{alert.severity.toUpperCase()}</strong> {utcClock(alert.at)} UTC: {alert.title}
              </li>
            ))}
          </ul>
        </>
      )}
      <p style={{ margin: '0.7rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        Every event is on <TextLink onClick={() => onNavigate('opportunities')}>Opportunities</TextLink>, and the news behind the alerts on{' '}
        <TextLink onClick={() => onNavigate('discovery')}>Discovery</TextLink>.
      </p>
    </Card>
  )
}
