import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { BotPositionRow } from './BotPositionRow'
import { HeldPositionRow } from './HeldPositionRow'
import { LivePositionRow } from './LivePositionRow'
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
  const [loaded, setLoaded] = useState(false)
  const loadedRef = useRef(false)

  function refreshLivePositions(): void {
    window.api.liveTrading.listPositions().then(setLivePositions).catch((error) => console.error('Failed to load live positions:', error))
  }

  useEffect(() => {
    refreshLivePositions()
    const timer = setInterval(refreshLivePositions, LIVE_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setBots(settings.bots)
      setHeldPositions(settings.heldPositions)
      setLoaded(true)
      loadedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    void window.api.settings.set({ heldPositions })
  }, [heldPositions])

  function handleCloseHeldPosition(id: string): void {
    setHeldPositions((prev) => prev.filter((p) => p.id !== id))
  }

  const activeBots = bots.filter((b) => b.enabled)

  return (
    <>
      <PageHeader
        title="Positions"
        subtitle="Live paper positions from your running bots — real market data, simulated money"
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
        {livePositions.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            No open live positions. A live-mode Order Executor's BUY fill lands here — closing one places a real market
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
      </Card>

      <Card title="Inventory (Handed-Over Positions)">
        {loaded && heldPositions.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            Nothing here yet. When an executor with "Keep position when stopped" enabled is stopped mid-trade, its
            open position lands here instead of being discarded.
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
