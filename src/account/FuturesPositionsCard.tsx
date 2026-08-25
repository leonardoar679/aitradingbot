import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { distanceToLiquidationPct, type FuturesReadout } from '../../shared/futuresPositions'

/** Real perpetual-futures positions, read from Binance over the user's own key.
 *
 * This app cannot open, close or change any of them -- the module that fetches them contains no
 * order endpoint at all. It is here for one reason: someone holding a leveraged position has a
 * liquidation price whether they have looked at it or not, and the paper side of this app spends
 * a great deal of effort teaching what that number means. Showing the real one costs nothing.
 *
 * Refreshed on a timer rather than once, because unlike a balance this number matters most
 * exactly when it is moving. */
const REFRESH_MS = 20_000

/** Below this the position is close enough that the distance is the headline, not a detail. */
const URGENT_DISTANCE_PCT = 10

export function FuturesPositionsCard(): React.JSX.Element | null {
  const [readout, setReadout] = useState<FuturesReadout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const next = await window.api.credentials.futuresPositions('binance')
        if (cancelled) return
        setReadout(next)
        setError(null)
      } catch (e) {
        if (cancelled) return
        // Kept and shown rather than swallowed. The overwhelmingly likely cause is a spot key
        // without futures permission, and silently showing nothing would read as "no positions"
        // to someone who has one.
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setChecked(true)
      }
    }
    void poll()
    const timer = setInterval(poll, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // Nothing to say yet, and nothing worth a card: no key, no futures permission, or genuinely no
  // positions. An empty card claiming "no futures positions" would be a claim this app cannot
  // make when the request never succeeded.
  if (!checked) return null
  if (error !== null && readout === null) return null
  if (readout === null || (readout.positions.length === 0 && readout.unreadable.length === 0)) return null

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '1rem 1.1rem',
        background: 'var(--surface)'
      }}
    >
      <h3 style={{ margin: '0 0 0.35rem', fontSize: '0.82rem', letterSpacing: '0.06em', color: 'var(--text-secondary)' }}>
        BINANCE FUTURES — REAL POSITIONS
      </h3>
      <p style={{ margin: '0 0 0.9rem', fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Read from your account, closest to liquidation first. This app cannot open, close or change any of these — it
        has no futures order path at all. Manage them on Binance.
      </p>

      {readout.positions.map((position) => {
        const distance = distanceToLiquidationPct(position)
        const urgent = distance !== null && distance <= URGENT_DISTANCE_PCT
        const side = position.positionAmt > 0 ? 'LONG' : 'SHORT'
        return (
          <div
            key={position.symbol}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.2rem',
              padding: '0.6rem 0',
              borderTop: '1px solid var(--border)',
              fontSize: '0.78rem'
            }}
          >
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
              {position.symbol} · {position.leverage}x {side}
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                {' '}
                · {position.marginType === 'cross' ? 'cross margin — your whole futures wallet backs it' : 'isolated margin'}
              </span>
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>
              Entry {position.entryPrice} · mark {position.markPrice} ·{' '}
              <span style={{ color: position.unrealizedPnl >= 0 ? 'var(--up)' : 'var(--down)', fontWeight: 600 }}>
                {position.unrealizedPnl >= 0 ? '+' : ''}
                {position.unrealizedPnl.toFixed(2)}
              </span>{' '}
              unrealized
            </span>
            {position.liquidationPrice === null || distance === null ? (
              <span style={{ color: 'var(--text-muted)' }}>Binance reports no liquidation price for this one.</span>
            ) : (
              <span style={{ color: urgent ? 'var(--down)' : 'var(--text-secondary)', fontWeight: urgent ? 600 : 400 }}>
                {urgent && <AlertTriangle size={12} style={{ verticalAlign: -1, marginRight: 4 }} />}
                Liquidation {position.liquidationPrice} — a {distance.toFixed(2)}% move against it closes the position
                and that margin is gone.
              </span>
            )}
          </div>
        )
      })}

      {readout.unreadable.length > 0 && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: 'var(--down)', lineHeight: 1.5 }}>
          {readout.unreadable.join(', ')} could not be read. Those positions exist and are not shown above — check them
          on Binance rather than assuming you are flat.
        </p>
      )}
    </div>
  )
}
