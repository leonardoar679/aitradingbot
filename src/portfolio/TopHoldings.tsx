import type { PortfolioHoldingRow } from './computePortfolioSnapshot'
import type { PortfolioStatus } from './portfolioStore'
import { colorForAsset } from './assetColor'
import { formatQuotePrice, isUsdLikeQuote } from '../utils/formatCurrency'

export function TopHoldings({
  holdings,
  totalValue,
  status
}: {
  holdings: PortfolioHoldingRow[]
  totalValue: number
  status: PortfolioStatus
}): React.JSX.Element {
  // Bar widths are scaled within a currency, never across them. `value` is denominated in each
  // holding's own quote asset, so one KRW position (values in the millions) sitting next to USD
  // positions would otherwise flatten every USD bar to zero width. The percentage below already
  // segregates currencies this way -- the bar scale simply hadn't.
  const scaleKeyFor = (quoteAsset: string): string => (isUsdLikeQuote(quoteAsset) ? 'usd' : quoteAsset)
  const maxByScale = new Map<string, number>()
  for (const h of holdings) {
    const key = scaleKeyFor(h.quoteAsset)
    maxByScale.set(key, Math.max(maxByScale.get(key) ?? 0, h.value))
  }

  // Total Value can only sum the dollar family -- this app has no exchange-rate table anywhere,
  // so a KRW-quoted holding cannot be folded into a dollar figure. It was being dropped in
  // silence: the row still appeared here with a real ₩ value while contributing nothing to the
  // headline total and showing a blank percentage. Korean exchanges are first-class here (the
  // XEMM/Arbitrage defaults are literally Bithumb and Upbit), so this is a normal thing to hold,
  // and the total has to say what it left out rather than just quietly disagree with the list.
  const excludedTotals = new Map<string, number>()
  for (const h of holdings) {
    if (isUsdLikeQuote(h.quoteAsset)) continue
    const quote = h.quoteAsset.toUpperCase()
    excludedTotals.set(quote, (excludedTotals.get(quote) ?? 0) + h.value)
  }
  const excludedNote =
    excludedTotals.size > 0
      ? [...excludedTotals.entries()].map(([quote, value]) => formatQuotePrice(value, quote)).join(', ')
      : null

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
      {status !== 'ready' ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          {status === 'error'
            ? "Couldn't read your holdings — retrying automatically."
            : 'Reading your positions…'}
        </p>
      ) : holdings.length === 0 ? (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          No holdings yet — live positions, held paper positions, and open executors will appear here.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          {holdings.map((holding) => {
            const color = colorForAsset(holding.baseAsset)
            const scaleMax = maxByScale.get(scaleKeyFor(holding.quoteAsset)) ?? 0
            const width = scaleMax > 0 ? (holding.value / scaleMax) * 100 : 0
            const countsTowardTotal = isUsdLikeQuote(holding.quoteAsset)
            const percent = countsTowardTotal && totalValue > 0 ? (holding.value / totalValue) * 100 : null
            return (
              <div key={`${holding.baseAsset}-${holding.quoteAsset}-${holding.isLive}`} style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: 150, flexShrink: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>{holding.baseAsset}</span>
                  {/* The same base asset can be held against different quotes (BTC/USDT and
                      BTC/KRW are separate rows on purpose). Without the quote shown, those two
                      render as an identical "BTC" line twice with no way to tell them apart. */}
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                    {holding.quoteAsset.toUpperCase()}
                  </span>
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
      {status === 'ready' && excludedNote !== null && (
        <p style={{ margin: '0.9rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Total Value covers dollar-quoted holdings only. {excludedNote} in non-dollar positions is listed above
          but not included — converting it would need an exchange rate this app doesn't have.
        </p>
      )}
    </section>
  )
}
