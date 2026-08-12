import { Plus, Trash2 } from 'lucide-react'
import type { ExecutorSide, DcaExecutorParams } from '../../shared/ipc'
import { fieldLabelStyle, textInputStyle, sideButtonStyle } from './formStyles'

interface DcaFormProps {
  params: DcaExecutorParams
  onChange: (params: DcaExecutorParams) => void
}

export function DcaForm({ params, onChange }: DcaFormProps): React.JSX.Element {
  function set<K extends keyof DcaExecutorParams>(key: K, value: DcaExecutorParams[K]): void {
    onChange({ ...params, [key]: value })
  }

  function updateLevel(index: number, patch: Partial<DcaExecutorParams['levels'][number]>): void {
    set(
      'levels',
      params.levels.map((l, i) => (i === index ? { ...l, ...patch } : l))
    )
  }

  function addLevel(): void {
    const last = params.levels[params.levels.length - 1]
    set('levels', [...params.levels, { priceOffsetPct: (last?.priceOffsetPct ?? 0) + 1, amountQuote: last?.amountQuote ?? 100 }])
  }

  function removeLevel(index: number): void {
    set('levels', params.levels.filter((_, i) => i !== index))
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

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
          <label style={{ ...fieldLabelStyle(), marginBottom: 0 }}>
            Levels ({params.side === 'buy' ? 'offset % below' : 'offset % above'} current price)
          </label>
          <button
            onClick={addLevel}
            style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.72rem', cursor: 'pointer' }}
          >
            <Plus size={12} /> Level
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {params.levels.map((level, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="number"
                step="0.1"
                value={level.priceOffsetPct || ''}
                onChange={(e) => updateLevel(i, { priceOffsetPct: Number(e.target.value) })}
                placeholder="Offset %"
                style={{ ...textInputStyle(), flex: 1 }}
              />
              <input
                type="number"
                value={level.amountQuote || ''}
                onChange={(e) => updateLevel(i, { amountQuote: Number(e.target.value) })}
                placeholder="Amount (quote)"
                style={{ ...textInputStyle(), flex: 1 }}
              />
              <button
                onClick={() => removeLevel(i)}
                disabled={params.levels.length <= 1}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', opacity: params.levels.length <= 1 ? 0.4 : 1 }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>Take Profit %</label>
          <input
            type="number"
            step="0.1"
            value={params.takeProfitPct || ''}
            onChange={(e) => set('takeProfitPct', Number(e.target.value))}
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
    </div>
  )
}
