import { describeHealth, describePause, healthVerdict, type HealthState } from '../../shared/exchangeHealth'
import { Card } from '../components/Card'
import { SummaryLine } from '../components/SummaryLine'
import { useExchangeHealth } from '../hooks/useExchangeHealth'
import { useLiveConnection } from '../hooks/useLiveMarket'

/** The health state with the stream's part read live, so the verdict here is the gate's. */
export function healthNow(state: HealthState, connection: { open: boolean; lastMessageAt: number | null } | null, nowMs: number): HealthState {
  if (connection === null) return state
  return { ...state, streamOpen: connection.open, dataAgeS: connection.lastMessageAt === null ? null : Math.max(0, (nowMs - connection.lastMessageAt) / 1000) }
}

/** Exchange health, read-only (the V4 document, §92-93): the data host's latency and the clock's
 * difference from Binance's, measured once a minute; the live-price socket; the key's last test; and
 * whether live ENTRIES are paused by them. Exits never are. */
export function ExchangeHealthCard(): React.JSX.Element {
  const measured = useExchangeHealth()
  const connection = useLiveConnection()

  if (measured === null) {
    return (
      <Card title="Exchange health">
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>Loading…</p>
      </Card>
    )
  }
  const state = healthNow(measured, connection, Date.now())
  const verdict = healthVerdict(state)
  const words = describeHealth(state)
  const pause = describePause(verdict)
  return (
    <Card title="Exchange health">
      <SummaryLine label="New live orders" value={pause ?? 'Not paused by the exchange'} tone={pause === null ? 'up' : 'down'} />
      <SummaryLine label="Data host" value={state.host ?? 'not measured yet'} />
      <SummaryLine label="REST round trip" value={words.latency} tone={state.restFailures > 0 || state.slowReads > 0 ? 'down' : undefined} />
      <SummaryLine label="Clock" value={words.clock} tone={verdict.reasons.some((reason) => reason.includes('clock')) ? 'down' : undefined} />
      <SummaryLine label="Live-price socket" value={words.stream} tone={state.streamOpen ? undefined : 'down'} />
      <SummaryLine label="Binance key" value={words.key} tone={state.keyOk === false ? 'down' : state.keyOk === null ? 'muted' : undefined} />
      <p style={{ margin: '0.75rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Measured once a minute with one public request for the time{state.measuredAt === null ? '' : `, last at ${new Date(state.measuredAt * 1000).toISOString().slice(11, 19)} UTC`}. A new real
        order is refused while the data is stale and REST fails, the clock is off by over five seconds, REST is slow three reads running, or the key's last test
        failed. A closing order is never refused by this: an open position keeps its protection.
      </p>
    </Card>
  )
}
