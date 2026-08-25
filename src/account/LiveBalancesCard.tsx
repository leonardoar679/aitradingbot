import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Card } from '../components/Card'
import { formatAssetNumber } from '../utils/formatCurrency'
import { describeError } from '../utils/ipcError'
import { EXCHANGES, canTradeOn, type Exchange, type LiveBalanceSnapshot } from '../../shared/ipc'

/** What the user really holds on an exchange, read over their own API key.
 *
 * The app has been able to read this since live trading was first scoped -- it is the same
 * authenticated call that verifies a key before storing it -- and threw the answer away after
 * using it as a yes/no connectivity test. Someone with a connected key had no way to see their
 * own balance in an app whose whole subject is their money.
 *
 * Kept strictly apart from the paper account above it, in its own card with its own wording. The
 * two are different money, and a beginner reading one as the other is the specific confusion this
 * page must not create. */
export function LiveBalancesCard({ exchange }: { exchange: Exchange }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<LiveBalanceSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const exchangeName = EXCHANGES.find((e) => e.id === exchange)?.name ?? exchange

  const read = useCallback(
    async (force: boolean) => {
      setBusy(true)
      try {
        setSnapshot(await window.api.credentials.balances(exchange, force))
        // Cleared only on success. Clearing it up front would blank a real failure for as long as
        // the retry takes, so a key that keeps failing would flicker rather than say so.
        setError(null)
      } catch (e) {
        setError(describeError(e))
      } finally {
        setBusy(false)
      }
    },
    [exchange]
  )

  useEffect(() => {
    void read(false)
  }, [read])

  const rows = snapshot?.rows ?? []

  return (
    <Card
      title={`${exchangeName} — your real balance`}
      actions={
        <button
          onClick={() => void read(true)}
          disabled={busy}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.35rem 0.6rem',
            color: busy ? 'var(--text-muted)' : 'var(--text-secondary)',
            fontSize: '0.75rem',
            cursor: busy ? 'not-allowed' : 'pointer'
          }}
        >
          <RefreshCw size={12} /> {busy ? 'Reading…' : 'Refresh'}
        </button>
      }
    >
      <p style={{ margin: '0 0 0.9rem', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        <ShieldCheck size={12} style={{ verticalAlign: '-1px', marginRight: '0.35rem', color: 'var(--up)' }} />
        Read-only. This is money on {exchangeName}, not the simulated account above — paper strategies never touch it,
        and nothing on this page moves it.{' '}
        {/* Said per exchange rather than once, because it stopped being true everywhere the moment a
            second exchange could be connected. An exchange this app can only read must not be
            described as one an executor could spend from. */}
        {canTradeOn(exchange)
          ? 'A live executor you start yourself can, under the limits in Settings.'
          : `This app cannot place orders on ${exchangeName} at all — it only reads the balance, so a key with lookup permission alone is enough.`}
      </p>

      {error !== null && (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--down)' }}>
          <TriangleAlert size={13} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
          {error}
        </p>
      )}

      {error === null && snapshot !== null && rows.length === 0 && (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          This account holds nothing right now. That is what {exchangeName} reports, not a failure to read it.
        </p>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                <th style={{ padding: '0.45rem 0.6rem' }}>Asset</th>
                <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>Free</th>
                <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>In open orders</th>
                <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.asset} style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  <td style={{ padding: '0.5rem 0.6rem', fontWeight: 600 }}>{row.asset}</td>
                  <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>
                    {formatAssetNumber(row.free, row.asset)}
                  </td>
                  <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right', color: 'var(--text-secondary)' }}>
                    {formatAssetNumber(row.locked, row.asset)}
                  </td>
                  <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>
                    {formatAssetNumber(row.free + row.locked, row.asset)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {snapshot !== null && snapshot.unreadable.length > 0 && (
        <p style={{ margin: '0.8rem 0 0', fontSize: '0.78rem', color: 'var(--gold)' }}>
          {exchangeName} reported {snapshot.unreadable.join(', ')} in a form this app could not read as a number, so
          {snapshot.unreadable.length === 1 ? ' it is' : ' they are'} missing from the list above. Check the exchange
          directly before assuming the total here is everything.
        </p>
      )}

      {snapshot !== null && error === null && (
        <p style={{ margin: '0.8rem 0 0', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          Read at {new Date(snapshot.fetchedAt).toLocaleTimeString()}. &quot;In open orders&quot; is held against
          orders resting on the exchange — including any placed outside this app — and cannot be spent until they fill
          or are cancelled.
        </p>
      )}
    </Card>
  )
}
