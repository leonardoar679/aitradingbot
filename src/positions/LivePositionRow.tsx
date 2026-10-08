import { useEffect, useState } from 'react'
import { describeDuration } from '../../shared/aiCost'
import { EXCHANGES, type LivePosition, type LiveWatcherSummary } from '../../shared/ipc'
import { useLastPrice } from '../hooks/useLastPrice'
import { formatQuotePrice } from '../utils/formatCurrency'
import { netRealizedPnl } from '../../shared/fees'
import { ThesisChip } from './ThesisChip'
import type { ThesisReading } from './thesisMeasure'

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

const cellStyle: React.CSSProperties = { padding: '0.65rem 0.9rem', fontSize: '0.82rem' }

/** The watcher's barriers in words: what guards the position, read from its copy. */
export function describeWatcherBarriers(watcher: Pick<LiveWatcherSummary, 'stopLossPct' | 'takeProfitPct' | 'trailingStop' | 'timeLimitSec' | 'consecutiveFailures'>): string {
  const parts: string[] = []
  if (watcher.stopLossPct !== null) parts.push(`stop ${watcher.stopLossPct}%`)
  if (watcher.takeProfitPct !== null) parts.push(`target ${watcher.takeProfitPct}%`)
  if (watcher.trailingStop !== null) parts.push(`trailing ${watcher.trailingStop.trailPct}% from +${watcher.trailingStop.activationPct}%`)
  if (watcher.timeLimitSec !== null) parts.push(`time ${describeDuration(watcher.timeLimitSec * 1000).replace('about ', '')}`)
  const words = parts.length === 0 ? 'watcher: no barriers' : `watcher: ${parts.join(' · ')}`
  return watcher.consecutiveFailures > 0 ? `${words} (not being checked)` : words
}

export function LivePositionRow({
  position,
  onClosed,
  thesis = null
}: {
  position: LivePosition
  onClosed: () => void
  /** Its watcher and its thesis status (src/positions/thesisMeasure.ts), where it has a watcher;
   * null for a position nothing watches. Shown only: the watcher closes it by its own barriers. */
  thesis?: { watcher: LiveWatcherSummary; reading: ThesisReading | null } | null
}): React.JSX.Element {
  const markPrice = useLastPrice(position.exchange, position.symbol)
  const exchangeName = EXCHANGES.find((e) => e.id === position.exchange)?.name ?? position.exchange
  // Net of the round-trip fee, matching what closing at this mark would actually realize and
  // what every paper position on this same page already reports (computeSnapshot.ts). Shown
  // gross, a position was "up" while a real close would still have booked a loss.
  const unrealizedQuote = markPrice !== null ? netRealizedPnl(position.qty, position.avgCost, markPrice) : null
  const costBasis = position.qty * position.avgCost
  const pnlPct = unrealizedQuote !== null && costBasis > 0 ? (unrealizedQuote / costBasis) * 100 : null

  const [closeQtyText, setCloseQtyText] = useState(String(position.qty))
  const [confirming, setConfirming] = useState(false)
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Defaults (and resets) to a full close whenever the tracked qty changes — e.g. after a
  // partial close, or an external live-order sell reducing this position elsewhere.
  useEffect(() => {
    setCloseQtyText(String(position.qty))
    setConfirming(false)
  }, [position.qty])

  const closeQty = Number(closeQtyText)
  const closeQtyValid = Number.isFinite(closeQty) && closeQty > 0 && closeQty <= position.qty

  async function handleClose(): Promise<void> {
    if (!closeQtyValid) return
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
      await window.api.liveTrading.closePosition(position.id, closeQty)
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
        {thesis !== null && (
          <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)', marginTop: '0.3rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span>{describeWatcherBarriers(thesis.watcher)}</span>
            {thesis.reading !== null ? <ThesisChip verdict={thesis.reading.verdict} /> : <span>thesis: measuring…</span>}
          </div>
        )}
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', minWidth: 160 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <input
              type="number"
              value={closeQtyText}
              onChange={(e) => {
                setCloseQtyText(e.target.value)
                setConfirming(false)
              }}
              disabled={closing}
              style={{
                width: 90,
                background: 'var(--bg-app)',
                border: `1px solid ${closeQtyValid ? 'var(--border)' : 'var(--down)'}`,
                borderRadius: 'var(--radius-sm)',
                padding: '0.3rem 0.4rem',
                color: 'var(--text-primary)',
                fontSize: '0.75rem'
              }}
            />
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{position.baseAsset}</span>
          </div>
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            {[0.25, 0.5, 0.75, 1].map((frac) => (
              <button
                key={frac}
                onClick={() => {
                  setCloseQtyText(String(position.qty * frac))
                  setConfirming(false)
                }}
                disabled={closing}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.15rem 0.4rem',
                  color: 'var(--text-secondary)',
                  fontSize: '0.68rem',
                  cursor: 'pointer'
                }}
              >
                {frac === 1 ? '100%' : `${frac * 100}%`}
              </button>
            ))}
          </div>
          <button
            onClick={() => void handleClose()}
            disabled={closing || !closeQtyValid}
            style={{
              background: confirming ? 'var(--down)' : 'transparent',
              border: '1px solid var(--down)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.35rem 0.7rem',
              color: confirming ? '#fff' : 'var(--down)',
              fontSize: '0.75rem',
              fontWeight: 700,
              cursor: closing || !closeQtyValid ? 'default' : 'pointer',
              opacity: !closeQtyValid ? 0.5 : 1
            }}
          >
            {closing ? 'Closing…' : confirming ? `Confirm real sell of ${closeQtyText} ${position.baseAsset}?` : 'Close'}
          </button>
          {!closeQtyValid && <div style={{ fontSize: '0.68rem', color: 'var(--down)' }}>Enter a qty between 0 and {position.qty}</div>}
          {error && <div style={{ fontSize: '0.7rem', color: 'var(--down)' }}>{error}</div>}
        </div>
      </td>
    </tr>
  )
}
