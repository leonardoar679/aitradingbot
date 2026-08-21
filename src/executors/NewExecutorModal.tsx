import { useEffect, useState } from 'react'
import { X, AlertTriangle } from 'lucide-react'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { GridForm } from './GridForm'
import { DcaForm } from './DcaForm'
import { TwapForm } from './TwapForm'
import { PositionForm } from './PositionForm'
import { OrderForm } from './OrderForm'
import { XemmForm } from './XemmForm'
import { ArbitrageForm } from './ArbitrageForm'
import { MarketMakingForm } from './MarketMakingForm'
import { fieldLabelStyle, textInputStyle } from './formStyles'
import { twapNumOrders, buildGridLevels } from './engine'
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
  type ArbitrageExecutorParams,
  type MarketMakingExecutorParams,
  type LiveTradingStatus
} from '../../shared/ipc'

const LIVE_CONFIRM_PHRASE = 'PLACE REAL ORDER'

type AnyExecutorParams =
  | GridExecutorParams
  | DcaExecutorParams
  | TwapExecutorParams
  | PositionExecutorParams
  | OrderExecutorParams
  | XemmExecutorParams
  | ArbitrageExecutorParams
  | MarketMakingExecutorParams

interface NewExecutorModalProps {
  onCreate: (input: {
    name: string
    type: ExecutorType
    exchange: Exchange
    pair: SymbolInfo
    keepPosition: boolean
    mode: 'paper' | 'live'
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
  { id: 'arbitrage', label: 'Arbitrage' },
  { id: 'marketmaking', label: 'Market Making' }
]

// Order Executors always hand their fill over as a position; Position Executors default to
// keeping one too, since that's usually the point of opening it. Grid/DCA/TWAP/Market Making
// default to closing out fully — inventory is meant to be continuously recycled, not handed
// over. XEMM/Arbitrage never leave a lingering position by design.
const DEFAULT_KEEP_POSITION: Record<ExecutorType, boolean> = {
  grid: false,
  dca: false,
  twap: false,
  position: true,
  order: true,
  xemm: false,
  arbitrage: false,
  marketmaking: false
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
  return { buyingMarket: buying, sellingMarket: selling, orderAmountQuote: 500, minProfitabilityPct: 0.5 }
}

function defaultArbitrageParams(buying: ArbitrageExecutorParams['buyingMarket'], selling: ArbitrageExecutorParams['sellingMarket']): ArbitrageExecutorParams {
  return { buyingMarket: buying, sellingMarket: selling, orderAmountQuote: 500, minProfitabilityPct: 0.5 }
}

function defaultMarketMakingParams(): MarketMakingExecutorParams {
  return { side: 'both', spreadPct: 0.5, orderRefreshSec: 60, orderAmountQuote: 200, inventoryTargetPct: null, inventorySkewIntensity: 0.3 }
}

// XEMM/Arbitrage require both legs to share the same base+quote asset (see spreadAssetsMismatched
// below) -- EXCHANGES[0]/[1] (Binance BTC/USDT, Coinbase BTC/USD) don't, which left Create disabled
// out of the box on a fresh spread executor. Bithumb and Upbit both default to BTC/KRW, so use
// those two as the default legs instead -- a real, commonly-arbitraged pair.
const DEFAULT_SPREAD_BUY_EXCHANGE = EXCHANGES.find((e) => e.id === 'bithumb') ?? EXCHANGES[0]
const DEFAULT_SPREAD_SELL_EXCHANGE = EXCHANGES.find((e) => e.id === 'upbit') ?? EXCHANGES[1]

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
    defaultXemmParams(
      defaultSpreadMarket(DEFAULT_SPREAD_BUY_EXCHANGE.id, DEFAULT_SPREAD_BUY_EXCHANGE.defaultSymbol),
      defaultSpreadMarket(DEFAULT_SPREAD_SELL_EXCHANGE.id, DEFAULT_SPREAD_SELL_EXCHANGE.defaultSymbol)
    )
  )
  const [arbitrageParams, setArbitrageParams] = useState<ArbitrageExecutorParams>(
    defaultArbitrageParams(
      defaultSpreadMarket(DEFAULT_SPREAD_BUY_EXCHANGE.id, DEFAULT_SPREAD_BUY_EXCHANGE.defaultSymbol),
      defaultSpreadMarket(DEFAULT_SPREAD_SELL_EXCHANGE.id, DEFAULT_SPREAD_SELL_EXCHANGE.defaultSymbol)
    )
  )
  const [marketMakingParams, setMarketMakingParams] = useState<MarketMakingExecutorParams>(defaultMarketMakingParams())
  const [mode, setMode] = useState<'paper' | 'live'>('paper')
  const [liveConfirmText, setLiveConfirmText] = useState('')
  const [binanceCredentialConfigured, setBinanceCredentialConfigured] = useState(false)
  const [liveTradingStatus, setLiveTradingStatus] = useState<LiveTradingStatus | null>(null)

  const isSpreadType = SPREAD_TYPES.includes(type)

  // The spread % this executor trades on only means anything if both legs are the same asset
  // pair (BTC/USDT vs BTC/USDT on two exchanges, say) — comparing two different instruments
  // (e.g. BTC/USDT vs ETH/USDT) produces a "spread" and "captures" that look real but are
  // comparing unrelated prices. Nothing enforced this before; block creation until it's fixed
  // rather than silently accepting it.
  const spreadLegs = type === 'xemm' ? xemmParams : type === 'arbitrage' ? arbitrageParams : null
  const spreadAssetsMismatched =
    spreadLegs !== null &&
    (spreadLegs.buyingMarket.baseAsset !== spreadLegs.sellingMarket.baseAsset ||
      spreadLegs.buyingMarket.quoteAsset !== spreadLegs.sellingMarket.quoteAsset)

  // Live trading eligibility is re-checked fresh every time the modal opens — never cached
  // across sessions — since a credential or the kill switch could have changed since last time.
  useEffect(() => {
    let cancelled = false
    window.api.credentials
      .list()
      .then((list) => {
        if (!cancelled) setBinanceCredentialConfigured(list.some((c) => c.exchange === 'binance' && c.configured))
      })
      .catch((error) => console.error('Failed to load credential status:', error))
    window.api.liveTrading
      .getStatus()
      .then((status) => {
        if (!cancelled) setLiveTradingStatus(status)
      })
      .catch((error) => console.error('Failed to load live trading status:', error))
    return () => {
      cancelled = true
    }
  }, [])

  const canGoLiveOrder =
    type === 'order' &&
    (orderParams.executionStrategy === 'market' || orderParams.executionStrategy === 'limit') &&
    (orderParams.executionStrategy !== 'limit' || orderParams.limitPrice !== null)

  // Buy-only, market-entry-only, and at least one exit condition required — a live position with
  // no take-profit/stop-loss/trailing-stop/time-limit would sit unmonitored indefinitely, which
  // this app shouldn't offer even as an option (see the Phase 3 plan).
  const canGoLivePosition =
    type === 'position' &&
    positionParams.side === 'buy' &&
    positionParams.entryPrice === null &&
    (positionParams.takeProfitPct !== null || positionParams.stopLossPct !== null || positionParams.trailingStop !== null || positionParams.timeLimitSec !== null)

  // Buy-only, same reasoning as Position (spot can't short). Every level is placed as its own
  // real resting order, so there's no market-entry-only or single-exit-condition requirement the
  // way Position has — the ladder shape itself is the thing that used to be paper-only.
  const canGoLiveDca = type === 'dca' && dcaParams.side === 'buy'

  // Buy-only, same reasoning as Position/DCA. Slice 0 places immediately and the rest follow on
  // a timer -- no market-entry-only or exit-condition requirement the way Position has, since
  // TWAP never closes a position at all (it only ever accumulates, same as paper TWAP).
  const canGoLiveTwap = type === 'twap' && twapParams.side === 'buy'

  // Buy-only, same reasoning as the others. Grid's takeProfitPct is already a mandatory paper
  // field, so no extra "at least one exit condition" check the way Position needed. Live Grid is
  // a bounded ladder sharing one exit, not full paper Grid's perpetual per-level cycling -- see
  // the Phase 6 plan.
  const canGoLiveGrid = type === 'grid' && gridParams.side === 'buy'

  const canGoLive =
    (canGoLiveOrder || canGoLivePosition || canGoLiveDca || canGoLiveTwap || canGoLiveGrid) &&
    exchange === 'binance' &&
    binanceCredentialConfigured &&
    liveTradingStatus !== null &&
    liveTradingStatus.sessionArmed &&
    !liveTradingStatus.killSwitchEngaged

  // Force back to paper the instant anything that made 'live' valid stops being true — switching
  // type/exchange/execution-strategy, or the session getting disarmed elsewhere, must never leave
  // a stale 'live' mode armed silently.
  useEffect(() => {
    if (!canGoLive && mode === 'live') {
      setMode('paper')
      setLiveConfirmText('')
    }
  }, [canGoLive, mode])

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

  // For DCA this is the largest single level, not the ladder's total -- each level is placed as
  // its own independent order, so the per-order cap applies per level, not to the sum. TWAP is
  // the same idea: each slice is its own independent order, so the cap applies per slice. Grid's
  // per-level amount is the full ladder's total divided by its full level count (matching paper's
  // sizing), even though live only ever rests a subset of those levels -- see the Phase 6 plan.
  const liveAmountQuote =
    type === 'position'
      ? positionParams.amountQuote
      : type === 'dca'
        ? Math.max(...dcaParams.levels.map((l) => l.amountQuote))
        : type === 'twap'
          ? twapParams.totalAmountQuote / twapNumOrders(twapParams)
          : type === 'grid'
            ? gridParams.totalAmountQuote / buildGridLevels(gridParams).length
            : orderParams.amountQuote
  const liveAmountOk = liveTradingStatus === null || liveAmountQuote <= liveTradingStatus.maxOrderQuote
  const liveConfirmOk = liveConfirmText.trim() === LIVE_CONFIRM_PHRASE
  const canSubmitLive = mode !== 'live' || (canGoLive && liveAmountOk && liveConfirmOk)

  function handleCreate(): void {
    if (!name.trim() || !canSubmitLive || spreadAssetsMismatched) return

    if (isSpreadType) {
      const params = type === 'xemm' ? xemmParams : arbitrageParams
      const buying = params.buyingMarket
      onCreate({
        name: name.trim(),
        type,
        exchange: buying.exchange,
        pair: { symbol: buying.symbol, baseAsset: buying.baseAsset, quoteAsset: buying.quoteAsset },
        keepPosition,
        mode: 'paper',
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
              : type === 'order'
                ? orderParams
                : marketMakingParams
    onCreate({ name: name.trim(), type, exchange, pair, keepPosition, mode, params })
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
            {isSpreadType && spreadAssetsMismatched && (
              <p style={{ fontSize: '0.75rem', color: 'var(--down)', margin: '0.6rem 0 0' }}>
                Buying and Selling Market must be the same asset pair (same base and quote asset) — comparing different
                instruments produces a meaningless spread. Pick matching pairs on each exchange.
              </p>
            )}
            {type === 'marketmaking' && <MarketMakingForm params={marketMakingParams} onChange={setMarketMakingParams} />}
          </div>

          {mode !== 'live' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: isSpreadType ? 'not-allowed' : 'pointer', opacity: isSpreadType ? 0.5 : 1 }}>
              <input type="checkbox" checked={keepPosition} disabled={isSpreadType} onChange={(e) => setKeepPosition(e.target.checked)} />
              Keep position when stopped (hand over to Inventory)
            </label>
          )}
          {mode === 'live' && (
            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
              Position Handover doesn't apply to live orders — a real fill is always tracked on the Positions page
              regardless of this setting.
            </p>
          )}

          {(type === 'order' || type === 'position' || type === 'dca' || type === 'twap' || type === 'grid') && (
            <div
              style={{
                border: `1px solid ${mode === 'live' ? 'var(--down)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                padding: '0.8rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
                background: mode === 'live' ? 'color-mix(in srgb, var(--down) 8%, transparent)' : 'transparent'
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  color: canGoLive ? 'var(--down)' : 'var(--text-muted)',
                  cursor: canGoLive ? 'pointer' : 'not-allowed'
                }}
              >
                <input
                  type="checkbox"
                  checked={mode === 'live'}
                  disabled={!canGoLive}
                  onChange={(e) => {
                    setMode(e.target.checked ? 'live' : 'paper')
                    setLiveConfirmText('')
                  }}
                />
                <AlertTriangle size={14} />
                {type === 'position'
                  ? 'Live Trading — enters and watches a real position'
                  : type === 'dca'
                    ? 'Live Trading — places a real ladder of resting orders'
                    : type === 'twap'
                      ? 'Live Trading — places a real series of market buy orders over time'
                      : type === 'grid'
                        ? 'Live Trading — places a real bounded ladder of resting orders'
                        : 'Live Trading — places a real order with real money'}
              </label>

              {!canGoLive && (
                <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
                  {exchange !== 'binance'
                    ? 'Live trading is only available on Binance.'
                    : type === 'order' && !canGoLiveOrder
                      ? orderParams.executionStrategy !== 'market' && orderParams.executionStrategy !== 'limit'
                        ? 'Live trading only supports market and limit orders so far.'
                        : 'Set a limit price first.'
                      : type === 'position' && !canGoLivePosition
                        ? positionParams.side !== 'buy'
                          ? 'Live Position entries are buy-only — spot trading can’t open a short.'
                          : positionParams.entryPrice !== null
                            ? 'Set a market entry (leave Entry Price blank) for live — a resting live entry isn’t supported yet.'
                            : 'Set at least one exit condition — take-profit, stop-loss, trailing stop, or time limit — before going live.'
                        : type === 'dca' && !canGoLiveDca
                          ? 'Live DCA is buy-only — spot trading can’t open a short.'
                          : type === 'twap' && !canGoLiveTwap
                            ? 'Live TWAP is buy-only — spot trading can’t open a short.'
                            : type === 'grid' && !canGoLiveGrid
                              ? 'Live Grid is buy-only — spot trading can’t open a short.'
                              : !binanceCredentialConfigured
                                ? 'Add a verified Binance API key in Settings first.'
                                : liveTradingStatus?.killSwitchEngaged
                                  ? 'The kill switch is engaged — release it from the live trading bar first.'
                                  : 'Arm live trading for this session from the live trading bar first.'}
                </p>
              )}

              {mode === 'live' && (
                <>
                  <p style={{ fontSize: '0.75rem', color: 'var(--down)', margin: 0, fontWeight: 600 }}>
                    {type === 'position'
                      ? `This will immediately place a real BUY market order for ${positionParams.amountQuote} ${pair.quoteAsset} of ${pair.symbol} on Binance, then watch it for take-profit/stop-loss/trailing-stop/time-limit and exit automatically with a real sell — no per-exit confirmation. Stop on the Executors page force-exits it manually at any time.`
                      : type === 'dca'
                        ? `This will place ${dcaParams.levels.length} real resting BUY limit order${dcaParams.levels.length === 1 ? '' : 's'} for ${pair.symbol} on Binance, one per level (may fill immediately if a level is already at or above the current price). Once any level fills, the resulting position is watched for take-profit/stop-loss/time-limit and exits automatically with a real sell — no per-exit confirmation. Stop cancels every remaining resting level and force-exits any filled position, all at once.`
                        : type === 'twap'
                          ? `This will place ${twapNumOrders(twapParams)} real BUY market order${twapNumOrders(twapParams) === 1 ? '' : 's'} for ${pair.symbol} on Binance, ${(twapParams.totalAmountQuote / twapNumOrders(twapParams)).toFixed(2)} ${pair.quoteAsset} each, spread over ${Math.round(twapParams.totalDurationSec / 60)} minutes — the first fires immediately, the rest on a timer that keeps running even if this app is only in the background. It never closes a position on its own. Stop halts any orders not yet placed but never undoes ones already placed.`
                          : type === 'grid'
                            ? (() => {
                                const allLevels = buildGridLevels(gridParams)
                                const placedCount = Math.min(gridParams.maxOpenOrders, allLevels.length)
                                const perLevel = gridParams.totalAmountQuote / allLevels.length
                                return `This is NOT full Grid — it's a bounded ladder that shares ONE exit, not the perpetual per-level cycling paper Grid does. It will place ${placedCount} real resting BUY limit order${placedCount === 1 ? '' : 's'} for ${pair.symbol} on Binance (the ${placedCount} of ${allLevels.length} configured levels closest to the current price — "Max Open Orders" bounds how many real orders get placed, not how many can be open during cycling), ${perLevel.toFixed(2)} ${pair.quoteAsset} each. Once any level fills, the resulting position takes profit at +${gridParams.takeProfitPct}% from the SHARED average fill (not per-level) and exits automatically with a real sell — no per-exit confirmation. Stop Price is not enforced live (unlike paper mode, where it now closes the position and freezes the grid). Once the shared position exits, this executor stops for good — it does not re-place the level and keep cycling. Stop cancels every remaining resting level and force-exits any filled position, all at once.`
                              })()
                            : orderParams.executionStrategy === 'limit'
                              ? `This will place a real resting LIMIT ${orderParams.side.toUpperCase()} order for ${orderParams.amountQuote} ${pair.quoteAsset} of ${pair.symbol} at ${orderParams.limitPrice} on Binance — it may not fill immediately, and can be cancelled from the Executors page (Stop) while open.`
                              : `This will immediately place a real ${orderParams.side.toUpperCase()} market order for ${orderParams.amountQuote} ${pair.quoteAsset} of ${pair.symbol} on Binance.`}
                  </p>
                  {!liveAmountOk && liveTradingStatus && (
                    <p style={{ fontSize: '0.75rem', color: 'var(--down)', margin: 0 }}>
                      {type === 'dca' ? 'The largest level' : type === 'twap' ? 'Each slice' : type === 'grid' ? 'The per-level amount' : 'Amount'} exceeds the configured max live order size ({liveTradingStatus.maxOrderQuote}).
                    </p>
                  )}
                  <div>
                    <label style={fieldLabelStyle()}>Type "{LIVE_CONFIRM_PHRASE}" to confirm</label>
                    <input
                      value={liveConfirmText}
                      onChange={(e) => setLiveConfirmText(e.target.value)}
                      placeholder={LIVE_CONFIRM_PHRASE}
                      style={textInputStyle()}
                    />
                  </div>
                </>
              )}
            </div>
          )}
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
            disabled={!name.trim() || !canSubmitLive || spreadAssetsMismatched}
            style={{
              flex: 1,
              background: mode === 'live' ? 'var(--down)' : 'linear-gradient(135deg, #7c86ff, #6366f1)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '0.7rem',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: name.trim() && canSubmitLive && !spreadAssetsMismatched ? 'pointer' : 'not-allowed',
              opacity: name.trim() && canSubmitLive && !spreadAssetsMismatched ? 1 : 0.6
            }}
          >
            {mode === 'live' ? (type === 'position' ? 'Enter Real Position' : 'Place Real Order') : 'Create Executor'}
          </button>
        </div>
      </div>
    </div>
  )
}
