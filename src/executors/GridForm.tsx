import type { ExecutorSide, GridExecutorParams } from '../../shared/ipc'
import { fieldLabelStyle, textInputStyle, sideButtonStyle } from './formStyles'

interface GridFormProps {
  params: GridExecutorParams
  onChange: (params: GridExecutorParams) => void
}

export function GridForm({ params, onChange }: GridFormProps): React.JSX.Element {
  function set<K extends keyof GridExecutorParams>(key: K, value: GridExecutorParams[K]): void {
    onChange({ ...params, [key]: value })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {(['buy', 'sell'] as ExecutorSide[]).map((s) => (
          <button key={s} style={sideButtonStyle(params.side === s, s)} onClick={() => set('side', s)}>
            {s}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Start Price</label>
          <input
            type="number"
            value={params.startPrice || ''}
            onChange={(e) => set('startPrice', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>End Price</label>
          <input
            type="number"
            value={params.endPrice || ''}
            onChange={(e) => set('endPrice', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
      </div>

      <div>
        <label style={fieldLabelStyle()}>Total Amount (quote)</label>
        <input
          type="number"
          value={params.totalAmountQuote || ''}
          onChange={(e) => set('totalAmountQuote', Number(e.target.value))}
          style={textInputStyle()}
        />
      </div>

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Level Spread %</label>
          <input
            type="number"
            step="0.01"
            value={params.levelSpreadPct || ''}
            onChange={(e) => set('levelSpreadPct', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Take Profit % / level</label>
          <input
            type="number"
            step="0.01"
            value={params.takeProfitPct || ''}
            onChange={(e) => set('takeProfitPct', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Max Open Orders</label>
          <input
            type="number"
            value={params.maxOpenOrders || ''}
            onChange={(e) => set('maxOpenOrders', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Stop Price (optional)</label>
          <input
            type="number"
            value={params.limitPrice ?? ''}
            onChange={(e) => set('limitPrice', e.target.value ? Number(e.target.value) : null)}
            style={textInputStyle()}
          />
        </div>
      </div>

      <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
        If price crosses Stop Price, every filled level closes at that price and the grid stops
        for good — it will not fill another level again, even if price re-enters the range. Not
        enforced for live Grid.
      </p>
    </div>
  )
}
