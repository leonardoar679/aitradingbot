import { useEffect, useState } from 'react'
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import { distanceToLiquidationPct, type FuturesReadout } from '../../shared/futuresPositions'
import {
  describeProtectiveStop,
  describeStopPlacementError,
  stopDistancePct,
  stopForPosition,
  stopRiskQuote,
  type ProtectiveStop
} from '../../shared/futuresStops'

/** Real perpetual-futures positions, read from Binance over the user's own key.
 *
 * This app can close one of them, put a stop on one, and take that stop off again. It cannot open
 * one -- see binanceFuturesTrading.ts for why those are not the same decision. It is here for one
 * reason: someone holding a leveraged position has a liquidation price whether they have looked
 * at it or not, and the paper side of this app spends a great deal of effort teaching what that
 * number means. Showing the real one costs nothing.
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

function inputStyle(): React.CSSProperties {
  return {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    padding: '0.35rem 0.5rem',
    fontSize: '0.78rem'
  }
}

function smallButtonStyle(color: string): React.CSSProperties {
  return {
    alignSelf: 'flex-start',
    background: 'transparent',
    border: `1px solid ${color}`,
    borderRadius: 'var(--radius-sm)',
    color,
    padding: '0.3rem 0.65rem',
    fontSize: '0.74rem',
    cursor: 'pointer'
  }
}

export function FuturesPositionsCard(): React.JSX.Element | null {
  const [readout, setReadout] = useState<FuturesReadout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [closed, setClosed] = useState<string | null>(null)

  // Kept apart from `readout` on purpose: the two reads fail independently, and an empty stop
  // list has to mean "no stop", never "the request failed". See readFuturesStops.
  const [stops, setStops] = useState<ProtectiveStop[] | null>(null)
  const [stopsError, setStopsError] = useState<string | null>(null)
  const [stopFor, setStopFor] = useState<string | null>(null)
  const [stopInput, setStopInput] = useState('')
  const [stopBusy, setStopBusy] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const [stopNotice, setStopNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function poll(): Promise<void> {
      const [positionResult, stopResult] = await Promise.allSettled([
        window.api.credentials.futuresPositions('binance'),
        window.api.credentials.futuresStops('binance')
      ])
      if (cancelled) return

      if (positionResult.status === 'fulfilled') {
        setReadout(positionResult.value)
        setError(null)
      } else {
        // Kept and shown rather than swallowed. The overwhelmingly likely cause is a spot key
        // without futures permission, and silently showing nothing would read as "no positions"
        // to someone who has one.
        const e = positionResult.reason
        setError(e instanceof Error ? e.message : String(e))
      }

      if (stopResult.status === 'fulfilled') {
        setStops(stopResult.value)
        setStopsError(null)
      } else {
        // Deliberately does NOT clear `stops`: falling back to an empty list would draw "no stop
        // on this position" for a position that may well have one.
        const e = stopResult.reason
        setStopsError(e instanceof Error ? e.message : String(e))
      }
      setChecked(true)
    }
    void poll()
    const timer = setInterval(poll, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  async function refreshStops(): Promise<void> {
    try {
      setStops(await window.api.credentials.futuresStops('binance'))
      setStopsError(null)
    } catch (e) {
      setStopsError(e instanceof Error ? e.message : String(e))
    }
  }

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
      // Binance cancels a closePosition stop once the position is gone, so the stop list is stale
      // the moment a close succeeds.
      await refreshStops()
    } catch (e) {
      // Never cleared automatically. If a close failed, the position is still open and still
      // leveraged, and that is the single most important thing on this page.
      setCloseError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handlePlaceStop(symbol: string): Promise<void> {
    setStopBusy(true)
    setStopError(null)
    try {
      const placed = await window.api.credentials.placeFuturesStop('binance', symbol, Number(stopInput))
      setStopNotice(`${symbol} will now be closed if the price reaches ${placed.stopPrice}. Binance holds this order — it works whether this app is open or not.`)
      setStopFor(null)
      setStopInput('')
      await refreshStops()
    } catch (e) {
      setStopError(e instanceof Error ? e.message : String(e))
    } finally {
      setStopBusy(false)
    }
  }

  async function handleCancelStop(symbol: string, orderId: number): Promise<void> {
    setStopBusy(true)
    setStopError(null)
    try {
      await window.api.credentials.cancelFuturesStop('binance', symbol, orderId)
      setStopNotice(`The stop on ${symbol} is gone. Nothing closes this position now except liquidation.`)
      await refreshStops()
    } catch (e) {
      setStopError(e instanceof Error ? e.message : String(e))
    } finally {
      setStopBusy(false)
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
        Read from your account, closest to liquidation first. This app can <strong>close</strong> one of these at the
        market price, and <strong>put a stop</strong> on one so the exchange closes it for you if the price reaches a
        level you choose. Those are the only changes it can make to a futures account: it cannot open a leveraged
        position and has no code to do so.
      </p>

      {readout.positions.map((position) => {
        const distance = distanceToLiquidationPct(position)
        const urgent = distance !== null && distance <= URGENT_DISTANCE_PCT
        const side = position.positionAmt > 0 ? 'LONG' : 'SHORT'
        const stop = stops === null ? null : stopForPosition(position, stops)
        const typedStop = Number(stopInput)
        const stopProblem = stopInput.trim() === '' ? null : describeStopPlacementError(position, typedStop)
        const typedRisk = stopProblem === null ? stopRiskQuote(position, typedStop) : null
        const typedDistance = stopProblem === null ? stopDistancePct(position, typedStop) : null
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

            {/* Whether this position has an exit before liquidation. Three states, and the third
                one is the reason they are not two: this app not knowing is not the same as there
                being no stop, and only one of those is safe to imply. */}
            {stops === null ? (
              <span style={{ color: 'var(--down)' }}>
                Your resting orders could not be read, so this app cannot tell whether this position has a stop on it.
                Check on Binance rather than assuming either way.
              </span>
            ) : stop !== null ? (
              <span style={{ color: 'var(--up)' }}>
                <ShieldCheck size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
                {describeProtectiveStop(position, stop)}
                {stop.type !== 'STOP_MARKET' && ` (${stop.type} — placed elsewhere, not by this app)`}
              </span>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>
                No stop on this position. Nothing closes it before liquidation unless you do it yourself.
              </span>
            )}

            {stopFor === position.symbol ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.35rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Close this position if the price reaches:
                </span>
                <input
                  value={stopInput}
                  onChange={(e) => setStopInput(e.target.value)}
                  inputMode="decimal"
                  placeholder={position.positionAmt > 0 ? 'below ' + position.markPrice : 'above ' + position.markPrice}
                  style={{ ...inputStyle(), maxWidth: '12rem' }}
                />
                {stopProblem !== null ? (
                  <span style={{ color: 'var(--down)' }}>{stopProblem}</span>
                ) : typedRisk !== null && typedDistance !== null ? (
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {typedDistance.toFixed(2)}% away.{' '}
                    {typedRisk > 0
                      ? `If it triggers you lose about ${typedRisk.toFixed(2)} USDT of this position.`
                      : `This locks in about ${Math.abs(typedRisk).toFixed(2)} USDT of the gain.`}{' '}
                    It becomes a market order when touched, so the price you actually get can be worse.
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>
                    Binance holds this order. It works whether this app is open or not.
                  </span>
                )}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={() => void handlePlaceStop(position.symbol)}
                    disabled={stopBusy || stopInput.trim() === '' || stopProblem !== null}
                    style={{
                      background: 'var(--up)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      color: '#fff',
                      padding: '0.35rem 0.7rem',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      cursor: stopBusy || stopInput.trim() === '' || stopProblem !== null ? 'not-allowed' : 'pointer',
                      opacity: stopBusy || stopInput.trim() === '' || stopProblem !== null ? 0.5 : 1
                    }}
                  >
                    {stopBusy ? 'Placing…' : 'Place this stop'}
                  </button>
                  <button
                    onClick={() => {
                      setStopFor(null)
                      setStopInput('')
                      setStopError(null)
                    }}
                    disabled={stopBusy}
                    style={{ ...smallButtonStyle('var(--border)'), color: 'var(--text-secondary)' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              stops !== null && (
                <button
                  onClick={() => {
                    setStopFor(position.symbol)
                    setStopInput('')
                    setStopError(null)
                    setStopNotice(null)
                  }}
                  disabled={stopBusy}
                  style={{ ...smallButtonStyle(stop !== null ? 'var(--border)' : 'var(--up)'), color: stop !== null ? 'var(--text-secondary)' : 'var(--up)', marginTop: '0.3rem' }}
                >
                  {stop !== null ? 'Replace this stop' : 'Set a stop'}
                </button>
              )
            )}

            {stop !== null && stopFor !== position.symbol && (
              <button
                onClick={() => void handleCancelStop(position.symbol, stop.orderId)}
                disabled={stopBusy}
                style={{ ...smallButtonStyle('var(--border)'), color: 'var(--text-muted)', marginTop: '0.2rem' }}
              >
                {stopBusy ? 'Working…' : 'Remove the stop'}
              </button>
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
                  style={inputStyle()}
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
                    style={{ ...smallButtonStyle('var(--border)'), color: 'var(--text-secondary)' }}
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
                style={{ ...smallButtonStyle('var(--down)'), marginTop: '0.3rem' }}
              >
                Close this position
              </button>
            )}
          </div>
        )
      })}

      {stopNotice !== null && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{stopNotice}</p>
      )}

      {stopError !== null && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: 'var(--down)', lineHeight: 1.5 }}>
          {stopError} — nothing about the position changed. Check its stop on Binance before relying on one.
        </p>
      )}

      {closed !== null && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: 'var(--up)', lineHeight: 1.5 }}>{closed}</p>
      )}

      {closeError !== null && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: 'var(--down)', lineHeight: 1.5 }}>
          Could not close it: {closeError} — the position is still open. Check it on Binance.
        </p>
      )}

      {stopsError !== null && stops !== null && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          The stop list above may be out of date — the last refresh failed ({stopsError}).
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
