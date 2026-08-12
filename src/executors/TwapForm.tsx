import type { ExecutorSide, TwapExecutorParams } from '../../shared/ipc'
import { fieldLabelStyle, textInputStyle, sideButtonStyle } from './formStyles'

interface TwapFormProps {
  params: TwapExecutorParams
  onChange: (params: TwapExecutorParams) => void
}

export function TwapForm({ params, onChange }: TwapFormProps): React.JSX.Element {
  function set<K extends keyof TwapExecutorParams>(key: K, value: TwapExecutorParams[K]): void {
    onChange({ ...params, [key]: value })
  }

  const numOrders = params.orderIntervalSec > 0 ? Math.max(1, Math.floor(params.totalDurationSec / params.orderIntervalSec)) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {(['buy', 'sell'] as ExecutorSide[]).map((s) => (
          <button key={s} style={sideButtonStyle(params.side === s, s)} onClick={() => set('side', s)}>
            {s}
          </button>
        ))}
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
          <label style={fieldLabelStyle()}>Total Duration (minutes)</label>
          <input
            type="number"
            value={params.totalDurationSec ? params.totalDurationSec / 60 : ''}
            onChange={(e) => set('totalDurationSec', Number(e.target.value) * 60)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Order Interval (seconds)</label>
          <input
            type="number"
            value={params.orderIntervalSec || ''}
            onChange={(e) => set('orderIntervalSec', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
      </div>

      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
        {numOrders > 0
          ? `${numOrders} slice${numOrders === 1 ? '' : 's'} of ${(params.totalAmountQuote / numOrders || 0).toFixed(2)} each`
          : 'Set a duration and interval to see the slice breakdown.'}
      </p>
    </div>
  )
}
