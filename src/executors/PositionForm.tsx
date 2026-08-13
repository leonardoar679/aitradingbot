import type { ExecutorSide, PositionExecutorParams } from '../../shared/ipc'
import { fieldLabelStyle, textInputStyle, sideButtonStyle } from './formStyles'

interface PositionFormProps {
  params: PositionExecutorParams
  onChange: (params: PositionExecutorParams) => void
}

export function PositionForm({ params, onChange }: PositionFormProps): React.JSX.Element {
  function set<K extends keyof PositionExecutorParams>(key: K, value: PositionExecutorParams[K]): void {
    onChange({ ...params, [key]: value })
  }

  const trailingEnabled = params.trailingStop !== null

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
          <label style={fieldLabelStyle()}>Entry Price (blank = market)</label>
          <input
            type="number"
            value={params.entryPrice ?? ''}
            onChange={(e) => set('entryPrice', e.target.value ? Number(e.target.value) : null)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Amount (quote)</label>
          <input
            type="number"
            value={params.amountQuote || ''}
            onChange={(e) => set('amountQuote', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Take Profit % (optional)</label>
          <input
            type="number"
            step="0.1"
            value={params.takeProfitPct ?? ''}
            onChange={(e) => set('takeProfitPct', e.target.value ? Number(e.target.value) : null)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Stop Loss % (optional)</label>
          <input
            type="number"
            step="0.1"
            value={params.stopLossPct ?? ''}
            onChange={(e) => set('stopLossPct', e.target.value ? Number(e.target.value) : null)}
            style={textInputStyle()}
          />
        </div>
      </div>

      <div>
        <label style={fieldLabelStyle()}>Time Limit, hours (optional)</label>
        <input
          type="number"
          value={params.timeLimitSec !== null ? params.timeLimitSec / 3600 : ''}
          onChange={(e) => set('timeLimitSec', e.target.value ? Number(e.target.value) * 3600 : null)}
          style={textInputStyle()}
        />
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={trailingEnabled}
          onChange={(e) => set('trailingStop', e.target.checked ? { activationPct: 1, trailPct: 0.5 } : null)}
        />
        Trailing stop
      </label>

      {trailingEnabled && params.trailingStop && (
        <div style={{ display: 'flex', gap: '0.7rem' }}>
          <div style={{ flex: 1 }}>
            <label style={fieldLabelStyle()}>Activation %</label>
            <input
              type="number"
              step="0.1"
              value={params.trailingStop.activationPct || ''}
              onChange={(e) => set('trailingStop', { ...params.trailingStop!, activationPct: Number(e.target.value) })}
              style={textInputStyle()}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={fieldLabelStyle()}>Trail %</label>
            <input
              type="number"
              step="0.1"
              value={params.trailingStop.trailPct || ''}
              onChange={(e) => set('trailingStop', { ...params.trailingStop!, trailPct: Number(e.target.value) })}
              style={textInputStyle()}
            />
          </div>
        </div>
      )}
    </div>
  )
}
