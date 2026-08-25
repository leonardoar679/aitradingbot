import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { BotPositionRow } from './BotPositionRow'
import { HeldPositionRow } from './HeldPositionRow'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { LivePositionRow } from './LivePositionRow'
import { LedgerCheck } from './LedgerCheck'
import { LiveHistoryRow } from './LiveHistoryRow'
import type { Bot } from '../bots/types'
import type { HeldPosition, LivePosition } from '../../shared/ipc'

const LIVE_POLL_MS = 15_000

const headerCellStyle: React.CSSProperties = {
  padding: '0 0.9rem 0.6rem',
  fontSize: '0.68rem',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  textAlign: 'left'
}

export function PositionsPage(): React.JSX.Element {
  const [bots, setBots] = useState<Bot[]>([])
  const [heldPositions, setHeldPositions] = useState<HeldPosition[]>([])
  const [livePositions, setLivePositions] = useState<LivePosition[]>([])
  const [liveHistory, setLiveHistory] = useState<LivePosition[]>([])
  const [loaded, setLoaded] = useState(false)
  const [liveError, setLiveError] = useState<string | null>(null)
  /** Closing a held position is a click that either removes the row or does nothing at all --
   * previously a failed settings write only reached console.error, so "nothing happened" was the
   * whole of the feedback. */
  const [heldError, setHeldError] = useState<string | null>(null)
  const loadedRef = useRef(false)

  // A failed poll must not look like "genuinely no open positions" on a page titled Real Money —
  // keep whatever was last successfully loaded and surface the failure instead of silently
  // clearing/freezing the table with no indication anything went wrong.
  function refreshLivePositions(): void {
    window.api.liveTrading
      .listPositions()
      .then((positions) => {
        setLivePositions(positions)
        setLiveError(null)
      })
      .catch((error) => {
        console.error('Failed to load live positions:', error)
        setLiveError(error instanceof Error ? error.message : String(error))
      })
    window.api.liveTrading
      .listClosedPositions()
      .then(setLiveHistory)
      .catch((error) => console.error('Failed to load live trade history:', error))
  }

  useEffect(() => {
    refreshLivePositions()
    const timer = setInterval(refreshLivePositions, LIVE_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  // Inventory is re-read on the same tick as live positions, not just once at mount: a
  // controller's risk-control breach can hand a position over while this page is open (see
  // handOverPositionOnStop), and a list frozen at mount would never show it.
  function refreshSettingsBacked(): void {
    window.api.settings
      .get()
      .then((settings) => {
        setBots(settings.bots)
        setHeldPositions(settings.heldPositions)
        setLoaded(true)
        loadedRef.current = true
      })
      .catch((error) => console.error('Failed to load positions settings:', error))
  }

  useEffect(() => {
    refreshSettingsBacked()
    const timer = setInterval(refreshSettingsBacked, LIVE_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  // Writes against a freshly re-read array rather than persisting local state wholesale.
  // settings.set replaces the entire heldPositions array, so echoing back a copy loaded at mount
  // would silently delete anything handed over since -- and closing one row is a removal of one
  // id, which applies just as correctly to the current array as to the stale one.
  function handleCloseHeldPosition(id: string): void {
    void (async () => {
      setHeldError(null)
      try {
        // Queued: re-reading before the write narrows the gap but does not close it, and a
        // handover landing inside it would be erased by this removal.
        const next = await settingsWrites(async () => {
          const fresh = await window.api.settings.get()
          const remaining = fresh.heldPositions.filter((p) => p.id !== id)
          await window.api.settings.set({ heldPositions: remaining })
          return remaining
        })
        setHeldPositions(next)
      } catch (error) {
        console.error('Failed to close held position:', error)
        setHeldError(describeError(error))
      }
    })()
  }

  const activeBots = bots.filter((b) => b.enabled)

  return (
    <>
      <PageHeader
        title="Positions"
        subtitle="Paper positions from bots and executors, plus any real-money positions — each section says which it is"
      />
      <Card title="Open Positions">
        {loaded && activeBots.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            No active bots. Enable a bot from the Bots page to see its paper position here.
          </p>
        )}
        {activeBots.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>Bot</th>
                  <th style={headerCellStyle}>Side</th>
                  <th style={headerCellStyle}>Entry</th>
                  <th style={headerCellStyle}>Mark</th>
                  <th style={headerCellStyle}>Stop</th>
                  <th style={headerCellStyle}>Unrealized P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {activeBots.map((bot) => (
                  <BotPositionRow key={bot.id} bot={bot} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Live Positions — Real Money">
        {liveError && (
          <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0 0 0.7rem' }}>
            Failed to refresh live positions ({liveError}) — the list below may be stale. Retrying every {LIVE_POLL_MS / 1000}s.
          </p>
        )}
        {livePositions.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            No open live positions. A live-mode Order, Position, DCA, TWAP or Grid executor's BUY fill lands here — closing one places a real market
            sell.
          </p>
        )}
        {livePositions.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>Symbol</th>
                  <th style={headerCellStyle}>Qty</th>
                  <th style={headerCellStyle}>Avg Cost</th>
                  <th style={headerCellStyle}>Mark</th>
                  <th style={headerCellStyle}>Unrealized P&amp;L</th>
                  <th style={headerCellStyle}></th>
                </tr>
              </thead>
              <tbody>
                {livePositions.map((position) => (
                  <LivePositionRow key={position.id} position={position} onClosed={refreshLivePositions} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {livePositions.length > 0 && <LedgerCheck positions={livePositions} />}
      </Card>

      <Card title="Live Trade History — Realized P&L">
        {liveHistory.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            No closed live positions yet. Once a live position is fully closed, it lands here with its realized P&amp;L.
          </p>
        )}
        {liveHistory.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>Symbol</th>
                  <th style={headerCellStyle}>Entry</th>
                  <th style={headerCellStyle}>Exit</th>
                  <th style={headerCellStyle}>Realized P&amp;L</th>
                  <th style={headerCellStyle}>Closed</th>
                </tr>
              </thead>
              <tbody>
                {liveHistory.map((position) => (
                  <LiveHistoryRow key={position.id} position={position} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Inventory (Handed-Over Positions)">
        {loaded && heldPositions.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            Nothing here yet. When an executor with "Keep position when stopped" enabled is stopped mid-trade, its
            open position lands here instead of being discarded.
          </p>
        )}
        {heldError !== null && (
          <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0 0 0.7rem' }}>
            That position could not be closed ({heldError}) — it is still listed below, and still
            counts toward your holdings. Try Close again.
          </p>
        )}
        {heldPositions.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>Source</th>
                  <th style={headerCellStyle}>Side</th>
                  <th style={headerCellStyle}>Entry</th>
                  <th style={headerCellStyle}>Mark</th>
                  <th style={headerCellStyle}>Amount</th>
                  <th style={headerCellStyle}>Unrealized P&amp;L</th>
                  <th style={headerCellStyle}></th>
                </tr>
              </thead>
              <tbody>
                {heldPositions.map((position) => (
                  <HeldPositionRow key={position.id} position={position} onClose={handleCloseHeldPosition} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
