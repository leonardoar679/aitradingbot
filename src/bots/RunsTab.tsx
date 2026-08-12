import { EXCHANGES } from '../../shared/ipc'
import type { BotRun } from '../../shared/ipc'

const headerCellStyle: React.CSSProperties = {
  padding: '0 0.9rem 0.6rem',
  fontSize: '0.68rem',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  textAlign: 'left'
}

const cellStyle: React.CSSProperties = { padding: '0.65rem 0.9rem', fontSize: '0.82rem' }

function formatDuration(startSec: number, endSec: number): string {
  const totalMin = Math.max(0, Math.round((endSec - startSec) / 60))
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

export function RunsTab({ runs }: { runs: BotRun[] }): React.JSX.Element {
  if (runs.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0.9rem 0 0' }}>
        No completed runs yet. Runs are recorded when you disable a bot.
      </p>
    )
  }

  const sorted = [...runs].sort((a, b) => b.endedAt - a.endedAt)

  return (
    <div style={{ overflowX: 'auto', marginTop: '0.9rem' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headerCellStyle}>Bot</th>
            <th style={headerCellStyle}>Started</th>
            <th style={headerCellStyle}>Ended</th>
            <th style={headerCellStyle}>Duration</th>
            <th style={headerCellStyle}>Trades</th>
            <th style={headerCellStyle}>Win Rate</th>
            <th style={headerCellStyle}>Net %</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((run) => {
            const exchangeName = EXCHANGES.find((e) => e.id === run.exchange)?.name ?? run.exchange
            const winRate = run.trades > 0 ? (run.wins / run.trades) * 100 : 0
            return (
              <tr key={run.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {run.botName}
                  <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)' }}>
                    {exchangeName} • {run.symbol}
                  </div>
                </td>
                <td style={cellStyle}>{new Date(run.startedAt * 1000).toLocaleString()}</td>
                <td style={cellStyle}>{new Date(run.endedAt * 1000).toLocaleString()}</td>
                <td style={cellStyle}>{formatDuration(run.startedAt, run.endedAt)}</td>
                <td style={cellStyle}>{run.trades}</td>
                <td style={cellStyle}>{run.trades > 0 ? `${winRate.toFixed(0)}%` : '—'}</td>
                <td style={{ ...cellStyle, fontWeight: 600, color: run.trades > 0 ? pctColor(run.netPct) : 'var(--text-muted)' }}>
                  {run.trades > 0 ? `${run.netPct >= 0 ? '+' : ''}${run.netPct.toFixed(2)}%` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
