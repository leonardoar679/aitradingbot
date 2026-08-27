import { useState } from 'react'
import { EXCHANGES, type HeldPosition } from '../../shared/ipc'
import { useLastPrice } from '../hooks/useLastPrice'
import { formatQuotePrice } from '../utils/formatCurrency'
import { netUnrealizedPct } from '../../shared/fees'
import { describeHeldCloseBlock, describeHeldCloseConfirm, heldPositionCloseValue } from './closeHeldPosition'

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

const cellStyle: React.CSSProperties = { padding: '0.65rem 0.9rem', fontSize: '0.82rem' }

export function HeldPositionRow({
  position,
  onClose
}: {
  position: HeldPosition
  /** Takes the value as well as the id: closing pays this back into the cash balance, and the
   * price it is worked out from is the one this row is showing the user. */
  onClose: (id: string, closeValue: number) => void
}): React.JSX.Element {
  const markPrice = useLastPrice(position.exchange, position.symbol)
  const exchangeName = EXCHANGES.find((e) => e.id === position.exchange)?.name ?? position.exchange
  const pnlPct = markPrice !== null ? netUnrealizedPct(position.entryPrice, markPrice, position.side) : null

  const [confirming, setConfirming] = useState(false)
  const closeValue = heldPositionCloseValue(position, markPrice)
  const closeBlock = describeHeldCloseBlock(position, markPrice)

  function handleCloseClick(): void {
    // Refused rather than discarded when it cannot be valued. Closing has to pay back what the
    // position is worth, and with no price there is no honest figure -- the old behaviour deleted
    // the row anyway, which is how the money went missing.
    if (closeValue === null) return
    if (!confirming) {
      // Closing is permanent, so a single misclick should not do it. The confirmation names the
      // amount coming back, and reverts to a plain "Close" if the second click doesn't come.
      setConfirming(true)
      setTimeout(() => setConfirming(false), 4000)
      return
    }
    onClose(position.id, closeValue)
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
          disabled={closeValue === null}
          title={closeBlock ?? `Sells this position at ${formatQuotePrice(markPrice ?? 0, position.quoteAsset)} and returns the proceeds to your balance`}
          style={{
            background: confirming ? 'var(--down)' : 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.35rem 0.7rem',
            color: confirming ? '#fff' : 'var(--text-secondary)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: closeValue === null ? 'not-allowed' : 'pointer',
            opacity: closeValue === null ? 0.5 : 1
          }}
        >
          {closeValue === null ? 'Close' : confirming ? describeHeldCloseConfirm(position, markPrice) : 'Close'}
        </button>
        {closeBlock !== null && (
          <div style={{ marginTop: '0.3rem', fontSize: '0.68rem', color: 'var(--text-muted)', maxWidth: '18rem', lineHeight: 1.4 }}>
            {closeBlock}
          </div>
        )}
      </td>
    </tr>
  )
}
