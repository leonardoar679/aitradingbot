import type { ArbitrageExecutorParams } from '../../shared/ipc'
import { SpreadMarketPicker } from './SpreadMarketPicker'
import { fieldLabelStyle, textInputStyle } from './formStyles'

interface ArbitrageFormProps {
  params: ArbitrageExecutorParams
  onChange: (params: ArbitrageExecutorParams) => void
}

export function ArbitrageForm({ params, onChange }: ArbitrageFormProps): React.JSX.Element {
  function set<K extends keyof ArbitrageExecutorParams>(key: K, value: ArbitrageExecutorParams[K]): void {
    onChange({ ...params, [key]: value })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <SpreadMarketPicker label="Buying Market" market={params.buyingMarket} onChange={(m) => set('buyingMarket', m)} />
      <SpreadMarketPicker label="Selling Market" market={params.sellingMarket} onChange={(m) => set('sellingMarket', m)} />

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Order Amount (quote)</label>
          <input
            type="number"
            value={params.orderAmountQuote || ''}
            onChange={(e) => set('orderAmountQuote', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Min Profitability %</label>
          <input
            type="number"
            step="0.01"
            value={params.minProfitabilityPct || ''}
            onChange={(e) => set('minProfitabilityPct', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
      </div>

      <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
        Captures the spread in either direction, unlike XEMM which is one-directional (buying
        market → selling market only).
      </p>
    </div>
  )
}
