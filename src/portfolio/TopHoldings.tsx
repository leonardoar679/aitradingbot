import type { PortfolioHoldingRow } from './computePortfolioSnapshot'
import { colorForAsset } from './assetColor'
import { formatQuotePrice, isUsdLikeQuote } from '../utils/formatCurrency'

export function TopHoldings({ holdings, totalValue }: { holdings: PortfolioHoldingRow[]; totalValue: number }): React.JSX.Element {
  const maxValue = holdings.length > 0 ? Math.max(...holdings.map((h) => h.value)) : 0

  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '1.25rem'
      }}
    >
      <h2 style={{ margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
        Top Holdings
      </h2>
      {holdings.length === 0 ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          No holdings yet — live positions, held paper positions, and open executors will appear here.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          {holdings.map((holding) => {
            const color = colorForAsset(holding.baseAsset)
            const width = maxValue > 0 ? (holding.value / maxValue) * 100 : 0
            const countsTowardTotal = isUsdLikeQuote(holding.quoteAsset)
            const percent = countsTowardTotal && totalValue > 0 ? (holding.value / totalValue) * 100 : null
            return (
              <div key={`${holding.baseAsset}-${holding.quoteAsset}-${holding.isLive}`} style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: 110, flexShrink: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>{holding.baseAsset}</span>
                  {holding.isLive && (
                    <span
                      style={{
                        padding: '0.1rem 0.35rem',
                        borderRadius: 999,
                        background: 'var(--down)',
                        color: '#fff',
                        fontSize: '0.58rem',
                        fontWeight: 800,
                        letterSpacing: '0.04em'
                      }}
                    >
                      LIVE
                    </span>
                  )}
                </div>
                <div
                  style={{
                    flex: 1,
                    height: 10,
                    borderRadius: 6,
                    background: 'var(--bg-app)',
                    overflow: 'hidden'
                  }}
                >
                  <div style={{ width: `${width}%`, height: '100%', borderRadius: 6, background: color }} />
                </div>
                <div
                  style={{
                    width: 150,
                    flexShrink: 0,
                    textAlign: 'right',
                    fontSize: '0.82rem',
                    color: 'var(--text-secondary)',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {formatQuotePrice(holding.value, holding.quoteAsset)}{' '}
                  <span style={{ color: 'var(--text-muted)' }}>{percent !== null ? `(${percent.toFixed(1)}%)` : ''}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
