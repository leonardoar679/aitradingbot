import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { GridForm } from './GridForm'
import { DcaForm } from './DcaForm'
import { TwapForm } from './TwapForm'
import { fieldLabelStyle, textInputStyle } from './formStyles'
import {
  EXCHANGES,
  type Exchange,
  type SymbolInfo,
  type ExecutorType,
  type GridExecutorParams,
  type DcaExecutorParams,
  type TwapExecutorParams
} from '../../shared/ipc'

interface NewExecutorModalProps {
  onCreate: (input: {
    name: string
    type: ExecutorType
    exchange: Exchange
    pair: SymbolInfo
    params: GridExecutorParams | DcaExecutorParams | TwapExecutorParams
  }) => void
  onClose: () => void
}

const TYPE_TABS: { id: ExecutorType; label: string }[] = [
  { id: 'grid', label: 'Grid' },
  { id: 'dca', label: 'DCA' },
  { id: 'twap', label: 'TWAP' }
]

function defaultGridParams(price: number | null): GridExecutorParams {
  const p = price ?? 100
  return {
    side: 'buy',
    startPrice: Number((p * 0.95).toFixed(6)),
    endPrice: Number((p * 1.05).toFixed(6)),
    totalAmountQuote: 1000,
    maxOpenOrders: 5,
    levelSpreadPct: 0.5,
    takeProfitPct: 0.5,
    limitPrice: null
  }
}

function defaultDcaParams(): DcaExecutorParams {
  return {
    side: 'buy',
    levels: [
      { priceOffsetPct: 1, amountQuote: 100 },
      { priceOffsetPct: 2, amountQuote: 150 },
      { priceOffsetPct: 3, amountQuote: 200 }
    ],
    takeProfitPct: 1.5,
    stopLossPct: null,
    timeLimitSec: null
  }
}

function defaultTwapParams(): TwapExecutorParams {
  return { side: 'buy', totalAmountQuote: 1000, totalDurationSec: 3600, orderIntervalSec: 300 }
}

export function NewExecutorModal({ onCreate, onClose }: NewExecutorModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [exchange, setExchange] = useState<Exchange>(EXCHANGES[0].id)
  const [pair, setPair] = useState<SymbolInfo>(EXCHANGES[0].defaultSymbol)
  const [type, setType] = useState<ExecutorType>('grid')
  const [lastPrice, setLastPrice] = useState<number | null>(null)
  const [gridParams, setGridParams] = useState<GridExecutorParams>(defaultGridParams(null))
  const [dcaParams, setDcaParams] = useState<DcaExecutorParams>(defaultDcaParams())
  const [twapParams, setTwapParams] = useState<TwapExecutorParams>(defaultTwapParams())

  useEffect(() => {
    let cancelled = false
    setLastPrice(null)
    window.api.market
      .subscribeTicker(exchange, pair.symbol)
      .then((snapshot) => {
        if (cancelled) return
        setLastPrice(snapshot.lastPrice)
        setGridParams(defaultGridParams(snapshot.lastPrice))
      })
      .catch((error) => console.error('Failed to load last price:', error))
      .finally(() => {
        void window.api.market.unsubscribeTicker()
      })
    return () => {
      cancelled = true
    }
  }, [exchange, pair.symbol])

  function handleExchangeChange(next: Exchange): void {
    setExchange(next)
    const info = EXCHANGES.find((e) => e.id === next)
    if (info) setPair(info.defaultSymbol)
  }

  function handleCreate(): void {
    if (!name.trim()) return
    const params = type === 'grid' ? gridParams : type === 'dca' ? dcaParams : twapParams
    onCreate({ name: name.trim(), type, exchange, pair, params })
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxHeight: '85vh',
          overflowY: 'auto',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.9rem 1.1rem', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>New Executor</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'flex', padding: '0.9rem 1.1rem 0', gap: '0.4rem' }}>
          {TYPE_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setType(t.id)}
              style={{
                flex: 1,
                padding: '0.5rem',
                fontSize: '0.8rem',
                fontWeight: 700,
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                background: type === t.id ? 'var(--accent-soft)' : 'var(--bg-app)',
                color: type === t.id ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer'
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ padding: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div>
            <label style={fieldLabelStyle()}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BTC Grid" autoFocus style={textInputStyle()} />
          </div>
          <div style={{ display: 'flex', gap: '0.7rem' }}>
            <div style={{ flex: 1 }}>
              <label style={fieldLabelStyle()}>Exchange</label>
              <ExchangeSelect exchange={exchange} onSelect={handleExchangeChange} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={fieldLabelStyle()}>Symbol</label>
              <SymbolSearch exchange={exchange} symbol={pair.symbol} onSelect={setPair} />
            </div>
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
            Last price: {lastPrice !== null ? lastPrice : 'loading…'}
          </p>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.9rem' }}>
            {type === 'grid' && <GridForm params={gridParams} onChange={setGridParams} />}
            {type === 'dca' && <DcaForm params={dcaParams} onChange={setDcaParams} />}
            {type === 'twap' && <TwapForm params={twapParams} onChange={setTwapParams} />}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.6rem', padding: '0 1.1rem 1.1rem' }}>
          <button
            onClick={onClose}
            style={{ flex: 1, background: 'var(--bg-app)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.7rem', color: 'var(--text-primary)', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim()}
            style={{
              flex: 1,
              background: 'linear-gradient(135deg, #7c86ff, #6366f1)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '0.7rem',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: name.trim() ? 'pointer' : 'not-allowed',
              opacity: name.trim() ? 1 : 0.6
            }}
          >
            Create Executor
          </button>
        </div>
      </div>
    </div>
  )
}
