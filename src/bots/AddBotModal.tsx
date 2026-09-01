import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { STRATEGIES, DEFAULT_STRATEGY_ID } from '../backtest/strategies'
import { EXCHANGES, type Exchange, type SymbolInfo } from '../../shared/ipc'
import { GPT_INTRADAY_STRATEGY_ID } from '../../shared/aiSignal'

interface AddBotModalProps {
  onCreate: (input: { name: string; exchange: Exchange; pair: SymbolInfo; strategyId: string }) => void
  onClose: () => void
}

function fieldLabelStyle(): React.CSSProperties {
  return { fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem', display: 'block' }
}

function textInputStyle(): React.CSSProperties {
  return {
    width: '100%',
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.6rem 0.75rem',
    color: 'var(--text-primary)',
    fontSize: '0.85rem'
  }
}

export function AddBotModal({ onCreate, onClose }: AddBotModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [exchange, setExchange] = useState<Exchange>(EXCHANGES[0].id)
  const [pair, setPair] = useState<SymbolInfo>(EXCHANGES[0].defaultSymbol)
  const [strategyId, setStrategyId] = useState(DEFAULT_STRATEGY_ID)
  const canCreate = name.trim().length > 0

  // Escape closes, like the backdrop and the X already do.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return (): void => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleExchangeChange(next: Exchange): void {
    setExchange(next)
    const info = EXCHANGES.find((e) => e.id === next)
    if (info) setPair(info.defaultSymbol)
  }

  function handleCreate(): void {
    if (!canCreate) return
    onCreate({ name: name.trim(), exchange, pair, strategyId })
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.9rem 1.1rem',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Add AI Bot</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div>
            <label style={fieldLabelStyle()}>Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. CloudScalper"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
              }}
              style={textInputStyle()}
            />
            {!canCreate && (
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>
                Required — this is how the bot is listed.
              </p>
            )}
          </div>
          <div>
            <label style={fieldLabelStyle()}>Exchange</label>
            <ExchangeSelect exchange={exchange} onSelect={handleExchangeChange} />
          </div>
          <div>
            <label style={fieldLabelStyle()}>Symbol</label>
            <SymbolSearch exchange={exchange} symbol={pair.symbol} onSelect={setPair} />
          </div>
          <div>
            <label style={fieldLabelStyle()}>Strategy</label>
            <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} style={textInputStyle()}>
              {STRATEGIES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.4rem 0 0' }}>
              {STRATEGIES.find((s) => s.id === strategyId)?.description}
            </p>
            {strategyId === GPT_INTRADAY_STRATEGY_ID && (
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>
                Paper only — it never places real orders. It does call the OpenAI API with your key while the bot
                runs, which bills your OpenAI account; every other strategy is free to run.
              </p>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.6rem', padding: '0 1.1rem 1.1rem' }}>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              background: 'var(--bg-app)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.7rem',
              color: 'var(--text-primary)',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            style={{
              flex: 1,
              background: canCreate ? 'linear-gradient(135deg, #7c86ff, #6366f1)' : 'var(--bg-app)',
              border: canCreate ? 'none' : '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.7rem',
              color: canCreate ? '#fff' : 'var(--text-muted)',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: canCreate ? 'pointer' : 'not-allowed'
            }}
          >
            Add Bot
          </button>
        </div>
      </div>
    </div>
  )
}
