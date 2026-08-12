import { MOCK_HOLDINGS, TOTAL_VALUE } from './data'

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function TopHoldings(): React.JSX.Element {
  const maxValue = Math.max(...MOCK_HOLDINGS.map((h) => h.value))

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        {MOCK_HOLDINGS.map((holding) => {
          const percent = (holding.value / TOTAL_VALUE) * 100
          const width = (holding.value / maxValue) * 100
          return (
            <div key={holding.symbol} style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: 90, flexShrink: 0 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: holding.color,
                    flexShrink: 0
                  }}
                />
                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {holding.symbol}
                </span>
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
                <div
                  style={{
                    width: `${width}%`,
                    height: '100%',
                    borderRadius: 6,
                    background: holding.color
                  }}
                />
              </div>
              <div
                style={{
                  width: 140,
                  flexShrink: 0,
                  textAlign: 'right',
                  fontSize: '0.82rem',
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap'
                }}
              >
                {formatUsd(holding.value)} <span style={{ color: 'var(--text-muted)' }}>({percent.toFixed(1)}%)</span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
