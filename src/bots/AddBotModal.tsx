import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { STRATEGIES, DEFAULT_STRATEGY_ID } from '../backtest/strategies'
import { canConfirmEntries } from '../backtest/aiConfirmation'
import { EXCHANGES, type Exchange, type SymbolInfo } from '../../shared/ipc'
import {
  AI_PROVIDER_LABEL,
  GPT_DECISION_EVERY_BARS,
  GPT_INTRADAY_STRATEGY_ID,
  describeGptCadence,
  gptDecisionsPerDay
} from '../../shared/aiSignal'

interface AddBotModalProps {
  onCreate: (input: {
    name: string
    exchange: Exchange
    pair: SymbolInfo
    strategyId: string
    aiConfirm: boolean
    aiEveryBars: number
  }) => void
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
  const [aiConfirm, setAiConfirm] = useState(false)
  const [aiEveryBars, setAiEveryBars] = useState<number>(GPT_DECISION_EVERY_BARS[0])
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
    // Re-checked against the strategy rather than read off the box: the box is hidden when GPT
    // Intraday is selected, and a tick left over from another strategy must not follow it there.
    // createBot keeps the cadence only on GPT Intraday, for the same reason: the picker is hidden
    // on every other strategy, and a choice made before switching away must not follow it.
    onCreate({ name: name.trim(), exchange, pair, strategyId, aiConfirm: aiConfirm && canConfirmEntries(strategyId), aiEveryBars })
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
                Paper only — it never places real orders. It does ask a model through {AI_PROVIDER_LABEL} with your
                key while the bot runs, which bills your {AI_PROVIDER_LABEL} credits; every other strategy is free to
                run unless you have a model confirm its entries.
              </p>
            )}
            {strategyId === GPT_INTRADAY_STRATEGY_ID && (
              <div style={{ marginTop: '0.6rem' }}>
                <label style={fieldLabelStyle()}>Ask the model</label>
                <select
                  value={aiEveryBars}
                  onChange={(e) => setAiEveryBars(Number(e.target.value))}
                  style={textInputStyle()}
                  aria-label="How often the model is asked"
                >
                  {GPT_DECISION_EVERY_BARS.map((bars) => (
                    <option key={bars} value={bars}>
                      every {describeGptCadence(bars)} · {gptDecisionsPerDay(bars)} calls a day
                    </option>
                  ))}
                </select>
                <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>
                  Fixed once the bot is created. Between two questions the position is held, and its stop is still
                  checked on every candle.
                </p>
              </div>
            )}
            {canConfirmEntries(strategyId) && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  fontSize: '0.72rem',
                  color: 'var(--text-muted)',
                  margin: '0.6rem 0 0',
                  lineHeight: 1.45,
                  cursor: 'pointer'
                }}
              >
                <input
                  type="checkbox"
                  checked={aiConfirm}
                  onChange={(e) => setAiConfirm(e.target.checked)}
                  style={{ marginTop: '0.15rem', flexShrink: 0 }}
                />
                <span>
                  <strong style={{ color: 'var(--text-primary)' }}>Have an AI model confirm each entry.</strong> The strategy decides;
                  a model can veto an entry it signals. One {AI_PROVIDER_LABEL} call per signalled entry, with your key. You are shown
                  the model and the price before the bot is switched on, and nothing is asked while it is stopped. Paper only.
                </span>
              </label>
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
