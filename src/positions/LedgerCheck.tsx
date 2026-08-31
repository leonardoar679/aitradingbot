import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, TriangleAlert } from 'lucide-react'
import { describeError } from '../utils/ipcError'
import { describeDiscrepancy, reconcileLivePositions, type ReconcileResult } from '../../shared/reconcileLive'
import { EXCHANGES, type Exchange, type LivePosition } from '../../shared/ipc'

const RECHECK_MS = 30_000

/** Checks the live-position ledger against what the exchange actually holds.
 *
 * The ledger is built from fills this app saw, and several ordinary things put it out of step:
 * selling the coin on the exchange's own site, a fill that came back unusable and was refused,
 * a withdrawal. None of them announce themselves, and the ledger is what prices this page and
 * what Close sells.
 *
 * Reports and stops there. A balance cannot say where it came from, so adjusting real-money
 * records to match one would be guessing with someone's account. */
export function LedgerCheck({ positions }: { positions: LivePosition[] }): React.JSX.Element | null {
  const [result, setResult] = useState<{ exchange: Exchange; reconciled: ReconcileResult; at: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // One exchange's worth at a time. Binance is the only one that can hold a live position today,
  // and the check is scoped per exchange because a balance only means anything against the
  // positions on that same exchange.
  const exchange = positions.find((p) => p.closedAt === null)?.exchange ?? null

  // The page re-polls its positions on a timer, handing this a brand-new array every time even
  // when nothing about them changed. Depending on the array itself would spend a signed balance
  // request per poll for an identical answer -- the same "a new object every tick looks like a
  // change" trap that once starved the routine scheduler. What matters is the content.
  const signature = positions
    .filter((p) => p.closedAt === null)
    .map((p) => `${p.id}:${p.qty}:${p.exchange}:${p.baseAsset}`)
    .join('|')

  const positionsRef = useRef(positions)
  positionsRef.current = positions

  const check = useCallback(async () => {
    if (exchange === null) {
      setResult(null)
      setError(null)
      return
    }
    try {
      const snapshot = await window.api.credentials.balances(exchange, false)
      const here = positionsRef.current.filter((p) => p.exchange === exchange)
      setResult({ exchange, reconciled: reconcileLivePositions(here, snapshot), at: Date.now() })
      setError(null)
    } catch (e) {
      // Not alarming. Being unable to check is not evidence of a problem, and a red banner every
      // time the network hiccups would make the real warning below indistinguishable from noise.
      setError(describeError(e))
      setResult(null)
    }
  }, [exchange])

  useEffect(() => {
    void check()
    // Re-checked on its own timer as well as when the positions change, because the divergence
    // this looks for happens somewhere else entirely: selling the coin on the exchange's own site
    // changes nothing here, so waiting for a change in this app's own records would mean never
    // noticing. Slower than the page's own poll, and the main process caches a balance read for
    // fifteen seconds, so this settles at about two signed requests a minute.
    const timer = setInterval(() => void check(), RECHECK_MS)
    return (): void => clearInterval(timer)
  }, [check, signature])

  if (exchange === null) return null
  const exchangeName = EXCHANGES.find((e) => e.id === exchange)?.name ?? exchange

  if (error !== null) {
    return (
      <p style={{ margin: '0.8rem 0 0', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
        Could not check these against your {exchangeName} balance ({error}). The quantities above are what this app
        recorded, not what the exchange currently reports.
      </p>
    )
  }
  if (result === null) return null

  const { discrepancies, unchecked } = result.reconciled

  return (
    <div style={{ marginTop: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {discrepancies.map((discrepancy) => (
        <p
          key={discrepancy.asset}
          style={{
            margin: 0,
            fontSize: '0.78rem',
            lineHeight: 1.55,
            color: 'var(--down)',
            border: '1px solid var(--down)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.6rem 0.7rem'
          }}
        >
          <TriangleAlert size={13} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
          {describeDiscrepancy(discrepancy, exchangeName)}
        </p>
      ))}

      {unchecked.length > 0 && (
        <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--gold)' }}>
          {exchangeName} reported {unchecked.join(', ')} in a form this app could not read, so
          {unchecked.length === 1 ? ' that position was' : ' those positions were'} not checked.
        </p>
      )}

      {discrepancies.length === 0 && unchecked.length === 0 && (
        // Said out loud rather than left as silence. A check nobody can see is one nobody trusts,
        // and this is the line that tells the user the numbers above are backed by the account.
        <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          <CheckCircle2 size={12} style={{ verticalAlign: '-1px', marginRight: '0.35rem', color: 'var(--up)' }} />
          Checked against your {exchangeName} balance at {new Date(result.at).toLocaleTimeString()} — the account holds
          everything listed above.
        </p>
      )}
    </div>
  )
}
