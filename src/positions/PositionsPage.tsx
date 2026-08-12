import { useEffect, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { BotPositionRow } from './BotPositionRow'
import type { Bot } from '../bots/types'

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
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setBots(settings.bots)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

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
    </>
  )
}
