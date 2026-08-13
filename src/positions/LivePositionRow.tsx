import { useState } from 'react'
import { EXCHANGES, type LivePosition } from '../../shared/ipc'
import { useLastPrice } from '../hooks/useLastPrice'
import { formatQuotePrice } from '../utils/formatCurrency'

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

const cellStyle: React.CSSProperties = { padding: '0.65rem 0.9rem', fontSize: '0.82rem' }

export function LivePositionRow({
  position,
  onClosed
}: {
  position: LivePosition
  onClosed: () => void
}): React.JSX.Element {
  const markPrice = useLastPrice(position.exchange, position.symbol)
  const exchangeName = EXCHANGES.find((e) => e.id === position.exchange)?.name ?? position.exchange
  const pnlPct = markPrice ? ((markPrice - position.avgCost) / position.avgCost) * 100 : null
  const unrealizedQuote = markPrice ? position.qty * (markPrice - position.avgCost) : null

  const [confirming, setConfirming] = useState(false)
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClose(): Promise<void> {
    if (!confirming) {
      setConfirming(true)
      // Two-step confirm: a real Close is one click too many to be a misclick, but closing is
      // risk-reducing, so this stays lighter than the typed-phrase gate used to create live
      // exposure. Reverts to a plain "Close" if the second click doesn't come quickly.
      setTimeout(() => setConfirming(false), 4000)
      return
    }
    setClosing(true)
    setError(null)
    try {
      await window.api.liveTrading.closePosition(position.id)
      onClosed()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConfirming(false)
    } finally {
      setClosing(false)
    }
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
        {position.symbol}
        <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)' }}>{exchangeName} · real holdings</div>
      </td>
      <td style={cellStyle}>
        {position.qty} {position.baseAsset}
      </td>
      <td style={cellStyle}>{formatQuotePrice(position.avgCost, position.quoteAsset)}</td>
      <td style={cellStyle}>{markPrice !== null ? formatQuotePrice(markPrice, position.quoteAsset) : '—'}</td>
      <td style={{ ...cellStyle, fontWeight: 600, color: pnlPct !== null ? pctColor(pnlPct) : 'var(--text-muted)' }}>
        {unrealizedQuote !== null && pnlPct !== null
          ? `${unrealizedQuote >= 0 ? '+' : ''}${formatQuotePrice(unrealizedQuote, position.quoteAsset)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`
          : '—'}
      </td>
      <td style={cellStyle}>
        <button
          onClick={() => void handleClose()}
          disabled={closing}
          style={{
            background: confirming ? 'var(--down)' : 'transparent',
            border: '1px solid var(--down)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.35rem 0.7rem',
            color: confirming ? '#fff' : 'var(--down)',
            fontSize: '0.75rem',
            fontWeight: 700,
            cursor: closing ? 'default' : 'pointer'
          }}
        >
          {closing ? 'Closing…' : confirming ? 'Confirm real sell?' : 'Close'}
        </button>
        {error && <div style={{ fontSize: '0.7rem', color: 'var(--down)', marginTop: '0.3rem' }}>{error}</div>}
      </td>
    </tr>
  )
}
