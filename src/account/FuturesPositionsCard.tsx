import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { distanceToLiquidationPct, type FuturesReadout } from '../../shared/futuresPositions'

/** Real perpetual-futures positions, read from Binance over the user's own key.
 *
 * This app can close one of them and cannot open one -- see binanceFuturesTrading.ts for why
 * those two halves are not the same decision. It is here for one reason: someone holding a
 * leveraged position has a
 * liquidation price whether they have looked at it or not, and the paper side of this app spends
 * a great deal of effort teaching what that number means. Showing the real one costs nothing.
 *
 * Refreshed on a timer rather than once, because unlike a balance this number matters most
 * exactly when it is moving. */
const REFRESH_MS = 20_000

/** Below this the position is close enough that the distance is the headline, not a detail. */
const URGENT_DISTANCE_PCT = 10

/** Typed in full, not a click. Closing is risk-reducing and never blocked by the size gates, but
 * it is still real money moving on a real exchange and it cannot be undone -- and this button
 * sits next to a liquidation warning, exactly where someone is most likely to be in a hurry. */
const CLOSE_CONFIRM_PHRASE = 'CLOSE POSITION'

export function FuturesPositionsCard(): React.JSX.Element | null {
  const [readout, setReadout] = useState<FuturesReadout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [closed, setClosed] = useState<string | null>(null)

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

  async function handleClose(symbol: string): Promise<void> {
    setBusy(true)
    setCloseError(null)
    try {
      const result = await window.api.credentials.closeFuturesPosition('binance', symbol)
      setClosed(
        `Closed ${result.closedQty} ${symbol}${result.avgPrice !== null ? ` at ${result.avgPrice}` : ''} (order ${result.orderId}, ${result.status}).`
      )
      setClosing(null)
      setConfirmText('')
      // Re-read rather than removing the row locally: a partial fill leaves a smaller position
      // still open, and crossing it off the list would tell the user they were flat when they
      // are not.
      setReadout(await window.api.credentials.futuresPositions('binance'))
    } catch (e) {
      // Never cleared automatically. If a close failed, the position is still open and still
      // leveraged, and that is the single most important thing on this page.
      setCloseError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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
        Read from your account, closest to liquidation first. This app can <strong>close</strong> one of these for you at
        the market price — that is the only change it can make to a futures account. It cannot open a leveraged position
        and has no code to do so, because opening one it could not then watch and exit would leave it to be liquidated.
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

            {closing === position.symbol ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.3rem' }}>
                <span style={{ color: 'var(--down)', fontWeight: 600 }}>
                  This closes your real {position.symbol} position at whatever the market pays, right now. It cannot be
                  undone. Type CLOSE POSITION to confirm.
                </span>
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="CLOSE POSITION"
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-primary)',
                    padding: '0.35rem 0.5rem',
                    fontSize: '0.78rem'
                  }}
                />
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={() => void handleClose(position.symbol)}
                    disabled={busy || confirmText.trim() !== CLOSE_CONFIRM_PHRASE}
                    style={{
                      background: 'var(--down)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      color: '#fff',
                      padding: '0.35rem 0.7rem',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      cursor: busy || confirmText.trim() !== CLOSE_CONFIRM_PHRASE ? 'not-allowed' : 'pointer',
                      opacity: busy || confirmText.trim() !== CLOSE_CONFIRM_PHRASE ? 0.5 : 1
                    }}
                  >
                    {busy ? 'Closing…' : 'Close it for real'}
                  </button>
                  <button
                    onClick={() => {
                      setClosing(null)
                      setConfirmText('')
                    }}
                    disabled={busy}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--text-secondary)',
                      padding: '0.35rem 0.7rem',
                      fontSize: '0.76rem',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setClosing(position.symbol)
                  setConfirmText('')
                  setCloseError(null)
                }}
                style={{
                  alignSelf: 'flex-start',
                  marginTop: '0.3rem',
                  background: 'transparent',
                  border: '1px solid var(--down)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--down)',
                  padding: '0.3rem 0.65rem',
                  fontSize: '0.74rem',
                  cursor: 'pointer'
                }}
              >
                Close this position
              </button>
            )}
          </div>
        )
      })}

      {closed !== null && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: 'var(--up)', lineHeight: 1.5 }}>{closed}</p>
      )}

      {closeError !== null && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: 'var(--down)', lineHeight: 1.5 }}>
          Could not close it: {closeError} — the position is still open. Check it on Binance.
        </p>
      )}

      {readout.unreadable.length > 0 && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: 'var(--down)', lineHeight: 1.5 }}>
          {readout.unreadable.join(', ')} could not be read. Those positions exist and are not shown above — check them
          on Binance rather than assuming you are flat.
        </p>
      )}
    </div>
  )
}
