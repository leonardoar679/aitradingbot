import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { SummaryLine } from '../components/SummaryLine'
import { describeReconciliation, type ReconciliationReadout } from '../../shared/reconcileLive'
import { describeUserStream, type UserStreamState } from '../../shared/userStream'

const POLL_MS = 10_000

/** The account's own stream and the reconciliation, read-only (the V5 document, S101-102): whether
 * the main process is hearing the account's own order reports and balances, and what its minute's
 * look at the exchange's resting orders and balances found against the ledgers. Nothing here places,
 * cancels or rewrites anything: a finding is told as a notice and shown, and a person puts it right. */
export function AccountStreamCard(): React.JSX.Element {
  const [stream, setStream] = useState<UserStreamState | null>(null)
  const [readout, setReadout] = useState<ReconciliationReadout | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = async (): Promise<void> => {
      try {
        const [nextStream, nextReadout] = await Promise.all([window.api.liveTrading.userStream(), window.api.liveTrading.reconciliation()])
        if (cancelled) return
        setStream(nextStream)
        setReadout(nextReadout)
      } catch {
        // Left as it was: the next read says.
      }
    }
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (stream === null || readout === null) {
    return (
      <Card title="The account's own stream">
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>Loading...</p>
      </Card>
    )
  }
  const streamWords = describeUserStream(stream, Date.now())
  const check = describeReconciliation(readout, 'Binance')
  return (
    <Card title="The account's own stream">
      <div data-testid="account-stream">
        <SummaryLine label="Stream" value={streamWords.line} tone={streamWords.tone} />
        <SummaryLine label="Reconciliation" value={check.line} tone={check.tone} />
        {check.findings.map((finding) => (
          <p key={finding} data-testid="reconciliation-finding" style={{ margin: '0.5rem 0 0', fontSize: '0.78rem', lineHeight: 1.55, color: 'var(--down)', border: '1px solid var(--down)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.7rem' }}>
            {finding}
          </p>
        ))}
      </div>
      <p style={{ margin: '0.75rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Binance pushes each order's fate and the balances after it over one authenticated socket, which the main process keeps open while a key is stored and the session is armed or an
        order or position of this app is open; a fill is booked the moment it is heard, and the 5-second poll is the check. Once a minute the orders resting on the exchange and the
        account's balances are read against the ledgers; what disagrees is told once per order or asset and shown here, and the ledger is never rewritten by it.
      </p>
    </Card>
  )
}
