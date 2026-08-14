import { useState } from 'react'
import { EXCHANGES, type HeldPosition } from '../../shared/ipc'
import { useLastPrice } from '../hooks/useLastPrice'
import { formatQuotePrice } from '../utils/formatCurrency'

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

const cellStyle: React.CSSProperties = { padding: '0.65rem 0.9rem', fontSize: '0.82rem' }

export function HeldPositionRow({ position, onClose }: { position: HeldPosition; onClose: (id: string) => void }): React.JSX.Element {
  const markPrice = useLastPrice(position.exchange, position.symbol)
  const exchangeName = EXCHANGES.find((e) => e.id === position.exchange)?.name ?? position.exchange
  const rawPct = markPrice ? ((markPrice - position.entryPrice) / position.entryPrice) * 100 : null
  const pnlPct = rawPct !== null && position.side === 'sell' ? -rawPct : rawPct

  const [confirming, setConfirming] = useState(false)

  function handleCloseClick(): void {
    if (!confirming) {
      // Discarding this record is permanent (no undo, no P&L kept) -- a single misclick
      // shouldn't be enough. Reverts to a plain "Close" if the second click doesn't come quickly.
      setConfirming(true)
      setTimeout(() => setConfirming(false), 4000)
      return
    }
    onClose(position.id)
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
        {position.sourceExecutorName}
        <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)' }}>
          {exchangeName} • {position.symbol}
        </div>
      </td>
      <td style={{ ...cellStyle, color: position.side === 'buy' ? 'var(--up)' : 'var(--down)', fontWeight: 600, textTransform: 'uppercase' }}>
        {position.side === 'buy' ? 'Long' : 'Short'}
      </td>
      <td style={cellStyle}>{formatQuotePrice(position.entryPrice, position.quoteAsset)}</td>
      <td style={cellStyle}>{markPrice !== null ? formatQuotePrice(markPrice, position.quoteAsset) : '—'}</td>
      <td style={cellStyle}>{formatQuotePrice(position.amountQuote, position.quoteAsset)}</td>
      <td style={{ ...cellStyle, fontWeight: 600, color: pnlPct !== null ? pctColor(pnlPct) : 'var(--text-muted)' }}>
        {pnlPct !== null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : '—'}
      </td>
      <td style={cellStyle}>
        <button
          onClick={handleCloseClick}
          style={{
            background: confirming ? 'var(--down)' : 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.35rem 0.7rem',
            color: confirming ? '#fff' : 'var(--text-secondary)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          {confirming ? 'Confirm discard?' : 'Close'}
        </button>
      </td>
    </tr>
  )
}
