import { EXCHANGES, type LivePosition } from '../../shared/ipc'
import { formatQuotePrice } from '../utils/formatCurrency'

const cellStyle: React.CSSProperties = { padding: '0.65rem 0.9rem', fontSize: '0.82rem' }

function pctColor(pnl: number): string {
  return pnl >= 0 ? 'var(--up)' : 'var(--down)'
}

export function LiveHistoryRow({ position }: { position: LivePosition }): React.JSX.Element {
  const exchangeName = EXCHANGES.find((e) => e.id === position.exchange)?.name ?? position.exchange
  const pnl = position.realizedPnl ?? 0

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
        {position.symbol}
        <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)' }}>{exchangeName}</div>
      </td>
      <td style={cellStyle}>{formatQuotePrice(position.avgCost, position.quoteAsset)}</td>
      <td style={cellStyle}>{position.exitPrice !== null ? formatQuotePrice(position.exitPrice, position.quoteAsset) : '—'}</td>
      <td style={{ ...cellStyle, fontWeight: 600, color: pctColor(pnl) }}>
        {pnl >= 0 ? '+' : ''}
        {formatQuotePrice(pnl, position.quoteAsset)}
      </td>
      <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{position.closedAt !== null ? new Date(position.closedAt * 1000).toLocaleString() : '—'}</td>
    </tr>
  )
}
