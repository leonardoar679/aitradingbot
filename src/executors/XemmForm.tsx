import type { ExecutorSide, XemmExecutorParams } from '../../shared/ipc'
import { SpreadMarketPicker } from './SpreadMarketPicker'
import { fieldLabelStyle, textInputStyle, sideButtonStyle } from './formStyles'

interface XemmFormProps {
  params: XemmExecutorParams
  onChange: (params: XemmExecutorParams) => void
}

export function XemmForm({ params, onChange }: XemmFormProps): React.JSX.Element {
  function set<K extends keyof XemmExecutorParams>(key: K, value: XemmExecutorParams[K]): void {
    onChange({ ...params, [key]: value })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <SpreadMarketPicker label="Buying Market" market={params.buyingMarket} onChange={(m) => set('buyingMarket', m)} />
      <SpreadMarketPicker label="Selling Market" market={params.sellingMarket} onChange={(m) => set('sellingMarket', m)} />

      <div>
        <label style={fieldLabelStyle()}>Maker Side</label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {(['buy', 'sell'] as ExecutorSide[]).map((s) => (
            <button key={s} style={sideButtonStyle(params.makerSide === s, s)} onClick={() => set('makerSide', s)}>
              {s}
            </button>
          ))}
        </div>
      </div>

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
    </div>
  )
}
