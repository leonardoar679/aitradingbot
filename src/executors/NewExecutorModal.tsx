import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { GridForm } from './GridForm'
import { DcaForm } from './DcaForm'
import { TwapForm } from './TwapForm'
import { PositionForm } from './PositionForm'
import { OrderForm } from './OrderForm'
import { XemmForm } from './XemmForm'
import { ArbitrageForm } from './ArbitrageForm'
import { fieldLabelStyle, textInputStyle } from './formStyles'
import {
  EXCHANGES,
  type Exchange,
  type SymbolInfo,
  type ExecutorType,
  type GridExecutorParams,
  type DcaExecutorParams,
  type TwapExecutorParams,
  type PositionExecutorParams,
  type OrderExecutorParams,
  type XemmExecutorParams,
  type ArbitrageExecutorParams
} from '../../shared/ipc'

type AnyExecutorParams =
  | GridExecutorParams
  | DcaExecutorParams
  | TwapExecutorParams
  | PositionExecutorParams
  | OrderExecutorParams
  | XemmExecutorParams
  | ArbitrageExecutorParams

interface NewExecutorModalProps {
  onCreate: (input: {
    name: string
    type: ExecutorType
    exchange: Exchange
    pair: SymbolInfo
    keepPosition: boolean
    params: AnyExecutorParams
  }) => void
  onClose: () => void
}

const TYPE_TABS: { id: ExecutorType; label: string }[] = [
  { id: 'grid', label: 'Grid' },
  { id: 'dca', label: 'DCA' },
  { id: 'twap', label: 'TWAP' },
  { id: 'position', label: 'Position' },
  { id: 'order', label: 'Order' },
  { id: 'xemm', label: 'XEMM' },
  { id: 'arbitrage', label: 'Arbitrage' }
]

// Order Executors always hand their fill over as a position; Position Executors default to
// keeping one too, since that's usually the point of opening it. Grid/DCA/TWAP default to
// closing out fully. XEMM/Arbitrage never leave a lingering position by design.
const DEFAULT_KEEP_POSITION: Record<ExecutorType, boolean> = {
  grid: false,
  dca: false,
  twap: false,
  position: true,
  order: true,
  xemm: false,
  arbitrage: false
}

const SPREAD_TYPES: ExecutorType[] = ['xemm', 'arbitrage']

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

function defaultPositionParams(): PositionExecutorParams {
  return {
    side: 'buy',
    entryPrice: null,
    amountQuote: 1000,
    takeProfitPct: 2,
    stopLossPct: 1,
    timeLimitSec: null,
    trailingStop: null
  }
}

function defaultOrderParams(): OrderExecutorParams {
  return { side: 'buy', amountQuote: 500, executionStrategy: 'market', limitPrice: null }
}

function defaultSpreadMarket(exchange: Exchange, pair: SymbolInfo): XemmExecutorParams['buyingMarket'] {
  return { exchange, symbol: pair.symbol, baseAsset: pair.baseAsset, quoteAsset: pair.quoteAsset }
}

function defaultXemmParams(buying: XemmExecutorParams['buyingMarket'], selling: XemmExecutorParams['sellingMarket']): XemmExecutorParams {
  return { buyingMarket: buying, sellingMarket: selling, makerSide: 'buy', orderAmountQuote: 500, minProfitabilityPct: 0.2 }
}

function defaultArbitrageParams(buying: ArbitrageExecutorParams['buyingMarket'], selling: ArbitrageExecutorParams['sellingMarket']): ArbitrageExecutorParams {
  return { buyingMarket: buying, sellingMarket: selling, orderAmountQuote: 500, minProfitabilityPct: 0.4 }
}

export function NewExecutorModal({ onCreate, onClose }: NewExecutorModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [exchange, setExchange] = useState<Exchange>(EXCHANGES[0].id)
  const [pair, setPair] = useState<SymbolInfo>(EXCHANGES[0].defaultSymbol)
  const [type, setType] = useState<ExecutorType>('grid')
  const [lastPrice, setLastPrice] = useState<number | null>(null)
  const [keepPosition, setKeepPosition] = useState(DEFAULT_KEEP_POSITION.grid)
  const [gridParams, setGridParams] = useState<GridExecutorParams>(defaultGridParams(null))
  const [dcaParams, setDcaParams] = useState<DcaExecutorParams>(defaultDcaParams())
  const [twapParams, setTwapParams] = useState<TwapExecutorParams>(defaultTwapParams())
  const [positionParams, setPositionParams] = useState<PositionExecutorParams>(defaultPositionParams())
  const [orderParams, setOrderParams] = useState<OrderExecutorParams>(defaultOrderParams())
  const [xemmParams, setXemmParams] = useState<XemmExecutorParams>(
    defaultXemmParams(defaultSpreadMarket(EXCHANGES[0].id, EXCHANGES[0].defaultSymbol), defaultSpreadMarket(EXCHANGES[1].id, EXCHANGES[1].defaultSymbol))
  )
  const [arbitrageParams, setArbitrageParams] = useState<ArbitrageExecutorParams>(
    defaultArbitrageParams(defaultSpreadMarket(EXCHANGES[0].id, EXCHANGES[0].defaultSymbol), defaultSpreadMarket(EXCHANGES[1].id, EXCHANGES[1].defaultSymbol))
  )

  const isSpreadType = SPREAD_TYPES.includes(type)

  useEffect(() => {
    if (isSpreadType) return
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
  }, [exchange, pair.symbol, isSpreadType])

  function handleExchangeChange(next: Exchange): void {
    setExchange(next)
    const info = EXCHANGES.find((e) => e.id === next)
    if (info) setPair(info.defaultSymbol)
  }

  function handleTypeChange(next: ExecutorType): void {
    setType(next)
    setKeepPosition(DEFAULT_KEEP_POSITION[next])
  }

  function handleCreate(): void {
    if (!name.trim()) return

    if (isSpreadType) {
      const params = type === 'xemm' ? xemmParams : arbitrageParams
      const buying = params.buyingMarket
      onCreate({
        name: name.trim(),
        type,
        exchange: buying.exchange,
        pair: { symbol: buying.symbol, baseAsset: buying.baseAsset, quoteAsset: buying.quoteAsset },
        keepPosition,
        params
      })
      return
    }

    const params =
      type === 'grid'
        ? gridParams
        : type === 'dca'
          ? dcaParams
          : type === 'twap'
            ? twapParams
            : type === 'position'
              ? positionParams
              : orderParams
    onCreate({ name: name.trim(), type, exchange, pair, keepPosition, params })
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
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

        <div style={{ display: 'flex', flexWrap: 'wrap', padding: '0.9rem 1.1rem 0', gap: '0.4rem' }}>
          {TYPE_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => handleTypeChange(t.id)}
              style={{
                flex: '1 1 30%',
                padding: '0.5rem',
                fontSize: '0.78rem',
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

          {!isSpreadType && (
            <>
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
            </>
          )}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.9rem' }}>
            {type === 'grid' && <GridForm params={gridParams} onChange={setGridParams} />}
            {type === 'dca' && <DcaForm params={dcaParams} onChange={setDcaParams} />}
            {type === 'twap' && <TwapForm params={twapParams} onChange={setTwapParams} />}
            {type === 'position' && <PositionForm params={positionParams} onChange={setPositionParams} />}
            {type === 'order' && <OrderForm params={orderParams} onChange={setOrderParams} />}
            {type === 'xemm' && <XemmForm params={xemmParams} onChange={setXemmParams} />}
            {type === 'arbitrage' && <ArbitrageForm params={arbitrageParams} onChange={setArbitrageParams} />}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: isSpreadType ? 'not-allowed' : 'pointer', opacity: isSpreadType ? 0.5 : 1 }}>
            <input type="checkbox" checked={keepPosition} disabled={isSpreadType} onChange={(e) => setKeepPosition(e.target.checked)} />
            Keep position when stopped (hand over to Inventory)
          </label>
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
