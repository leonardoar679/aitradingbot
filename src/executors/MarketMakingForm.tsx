import type { MarketMakingExecutorParams } from '../../shared/ipc'
import { fieldLabelStyle, textInputStyle } from './formStyles'

interface MarketMakingFormProps {
  params: MarketMakingExecutorParams
  onChange: (params: MarketMakingExecutorParams) => void
}

const SIDE_OPTIONS: { id: MarketMakingExecutorParams['side']; label: string }[] = [
  { id: 'both', label: 'Both' },
  { id: 'buy', label: 'Buy only' },
  { id: 'sell', label: 'Sell only' }
]

export function MarketMakingForm({ params, onChange }: MarketMakingFormProps): React.JSX.Element {
  function set<K extends keyof MarketMakingExecutorParams>(key: K, value: MarketMakingExecutorParams[K]): void {
    onChange({ ...params, [key]: value })
  }

  const skewEnabled = params.inventoryTargetPct !== null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {SIDE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => set('side', opt.id)}
            style={{
              flex: 1,
              padding: '0.5rem',
              fontSize: '0.78rem',
              fontWeight: 700,
              border: `1px solid ${params.side === opt.id ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-sm)',
              background: params.side === opt.id ? 'var(--accent-soft)' : 'transparent',
              color: params.side === opt.id ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer'
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Spread %</label>
          <input
            type="number"
            step="0.01"
            value={params.spreadPct || ''}
            onChange={(e) => set('spreadPct', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Refresh (seconds)</label>
          <input
            type="number"
            value={params.orderRefreshSec || ''}
            onChange={(e) => set('orderRefreshSec', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
      </div>

      <div>
        <label style={fieldLabelStyle()}>Order Amount (quote)</label>
        <input
          type="number"
          value={params.orderAmountQuote || ''}
          onChange={(e) => set('orderAmountQuote', Number(e.target.value))}
          style={textInputStyle()}
        />
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={skewEnabled}
          onChange={(e) => set('inventoryTargetPct', e.target.checked ? 0 : null)}
        />
        Inventory-skew management
      </label>

      {skewEnabled && (
        <div style={{ display: 'flex', gap: '0.7rem' }}>
          <div style={{ flex: 1 }}>
            <label style={fieldLabelStyle()}>Target Inventory (% of one order)</label>
            <input
              type="number"
              value={params.inventoryTargetPct ?? ''}
              onChange={(e) => set('inventoryTargetPct', Number(e.target.value))}
              style={textInputStyle()}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={fieldLabelStyle()}>Skew Intensity</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="1"
              value={params.inventorySkewIntensity || ''}
              onChange={(e) => set('inventorySkewIntensity', Number(e.target.value))}
              style={textInputStyle()}
            />
          </div>
        </div>
      )}

      <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
        Quotes a bid/ask around the live price and refreshes on the interval above. Fills use
        exactly the standing bid/ask when price touches them — no order-book depth is simulated.
      </p>
    </div>
  )
}
