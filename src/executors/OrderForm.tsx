import type { ExecutorSide, OrderExecutionStrategy, OrderExecutorParams } from '../../shared/ipc'
import { fieldLabelStyle, textInputStyle, sideButtonStyle } from './formStyles'

interface OrderFormProps {
  params: OrderExecutorParams
  onChange: (params: OrderExecutorParams) => void
}

const STRATEGIES: { id: OrderExecutionStrategy; label: string }[] = [
  { id: 'limit', label: 'Limit' },
  { id: 'limit_maker', label: 'Limit Maker' },
  { id: 'market', label: 'Market' },
  { id: 'limit_chaser', label: 'Limit Chaser' }
]

export function OrderForm({ params, onChange }: OrderFormProps): React.JSX.Element {
  function set<K extends keyof OrderExecutorParams>(key: K, value: OrderExecutorParams[K]): void {
    onChange({ ...params, [key]: value })
  }

  const needsLimitPrice = params.executionStrategy !== 'market'

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
        <label style={fieldLabelStyle()}>Amount (quote)</label>
        <input
          type="number"
          value={params.amountQuote || ''}
          onChange={(e) => set('amountQuote', Number(e.target.value))}
          style={textInputStyle()}
        />
      </div>

      <div>
        <label style={fieldLabelStyle()}>Execution Strategy</label>
        <select
          value={params.executionStrategy}
          onChange={(e) => set('executionStrategy', e.target.value as OrderExecutionStrategy)}
          style={textInputStyle()}
        >
          {STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {needsLimitPrice && (
        <div>
          <label style={fieldLabelStyle()}>Limit Price</label>
          <input
            type="number"
            value={params.limitPrice ?? ''}
            onChange={(e) => set('limitPrice', e.target.value ? Number(e.target.value) : null)}
            style={textInputStyle()}
          />
        </div>
      )}

      {params.executionStrategy === 'limit_chaser' && (
        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
          Simplification: without a real order book to chase, this fills immediately like a market order.
        </p>
      )}
    </div>
  )
}
