import { useEffect, useState } from 'react'
import { CheckCircle2, TriangleAlert } from 'lucide-react'
import { describeReconciliation, type ReconciliationReadout } from '../../shared/reconcileLive'
import { EXCHANGES, type LivePosition } from '../../shared/ipc'
import { useI18n } from '../i18n'

const RECHECK_MS = 30_000

/** What the main process's reconciliation found for the live-position ledger (the V5 document,
 * S102; electron/services/liveReconcileService.ts).
 *
 * The ledger is built from fills this app saw, and several ordinary things put it out of step:
 * selling the coin on the exchange's own site, a fill that came back unusable and was refused,
 * a withdrawal. None of them announce themselves, and the ledger is what prices this page and
 * what Close sells. Until 8 October 2026 this card read the balance itself, and only while it was
 * on screen; the check now runs once a minute in the main process whichever page is open, tells a
 * notice, and this shows its last look.
 *
 * Reports and stops there. A balance cannot say where it came from, so adjusting real-money
 * records to match one would be guessing with someone's account. */
export function LedgerCheck({ positions }: { positions: LivePosition[] }): React.JSX.Element | null {
  const i18n = useI18n()
  const [readout, setReadout] = useState<ReconciliationReadout | null>(null)

  // Binance is the only exchange that can hold a live position today, and the reconciliation is
  // its own; the card is scoped to it as the check is.
  const exchange = positions.find((p) => p.closedAt === null && p.exchange === 'binance')?.exchange ?? null

  useEffect(() => {
    if (exchange === null) return
    let cancelled = false
    const read = async (): Promise<void> => {
      try {
        const next = await window.api.liveTrading.reconciliation()
        if (!cancelled) setReadout(next)
      } catch {
        // Left as it was: the next read says.
      }
    }
    void read()
    const timer = setInterval(() => void read(), RECHECK_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [exchange])

  if (exchange === null || readout === null) return null
  const exchangeName = EXCHANGES.find((e) => e.id === exchange)?.name ?? exchange
  const words = describeReconciliation(readout, exchangeName, i18n)

  return (
    <div data-testid="ledger-check" style={{ marginTop: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {words.findings.map((finding) => (
        <p
          key={finding}
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
          <TriangleAlert size={13} style={{ verticalAlign: '-2px', marginInlineEnd: '0.35rem' }} />
          {finding}
        </p>
      ))}
      {/* Said out loud rather than left as silence. A check nobody can see is one nobody trusts,
          and this is the line that tells the user whether the numbers above are backed by the account. */}
      <p style={{ margin: 0, fontSize: '0.74rem', color: words.tone === 'up' ? 'var(--text-muted)' : words.tone === 'down' ? 'var(--down)' : 'var(--gold)' }}>
        {words.tone === 'up' && <CheckCircle2 size={12} style={{ verticalAlign: '-1px', marginInlineEnd: '0.35rem', color: 'var(--up)' }} />}
        {words.line}
      </p>
    </div>
  )
}
