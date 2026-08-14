// Single source of truth for IPC channel names and payload shapes.
// Imported by both electron/ (main + preload) and src/ (renderer).

export const IpcChannel = {
  AppPing: 'app:ping',
  AppGetVersion: 'app:getVersion',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  MarketListSymbols: 'market:listSymbols',
  MarketSubscribeCandles: 'market:subscribeCandles',
  MarketUnsubscribeCandles: 'market:unsubscribeCandles',
  MarketCandleUpdate: 'market:candleUpdate',
  MarketSubscribeTicker: 'market:subscribeTicker',
  MarketUnsubscribeTicker: 'market:unsubscribeTicker',
  MarketTickerUpdate: 'market:tickerUpdate',
  MarketFetchHistoricalRange: 'market:fetchHistoricalRange',
  MarketHistoricalRangeProgress: 'market:historicalRangeProgress',
  MarketCancelHistoricalRange: 'market:cancelHistoricalRange',
  MarketFetchTicker24h: 'market:fetchTicker24h',
  CredentialsList: 'credentials:list',
  CredentialsSet: 'credentials:set',
  CredentialsTest: 'credentials:test',
  CredentialsRemove: 'credentials:remove',
  LiveTradingGetStatus: 'liveTrading:getStatus',
  LiveTradingSetConfig: 'liveTrading:setConfig',
  LiveTradingEngageKillSwitch: 'liveTrading:engageKillSwitch',
  LiveTradingReleaseKillSwitch: 'liveTrading:releaseKillSwitch',
  LiveTradingSetSessionArmed: 'liveTrading:setSessionArmed',
  LiveTradingListPositions: 'liveTrading:listPositions',
  LiveTradingListClosedPositions: 'liveTrading:listClosedPositions',
  LiveTradingClosePosition: 'liveTrading:closePosition',
  LiveTradingPollOpenOrders: 'liveTrading:pollOpenOrders',
  LiveTradingCancelOrder: 'liveTrading:cancelOrder',
  LiveTradingCreateWatcher: 'liveTrading:createWatcher',
  LiveTradingListActiveWatchers: 'liveTrading:listActiveWatchers',
  LiveTradingStopWatcher: 'liveTrading:stopWatcher',
  LiveTradingDrainWatcherEvents: 'liveTrading:drainWatcherEvents',
  ExecutorPlaceLiveOrder: 'executor:placeLiveOrder',
  ExecutorPlaceLiveLimitOrder: 'executor:placeLiveLimitOrder'
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface AppSettings {
  theme: 'dark' | 'light' | 'colorblind'
  bots: Bot[]
  botRuns: BotRun[]
  executors: ExecutorConfig[]
  routines: RoutineConfig[]
  heldPositions: HeldPosition[]
  controllers: ControllerConfig[]
}

/** Status of a stored exchange API credential. Crosses IPC — never the raw key/secret, which
 * stay encrypted at rest and are only ever decrypted inside the main process. */
export interface CredentialStatus {
  exchange: Exchange
  configured: boolean
  addedAt: number | null
  lastTestedAt: number | null
  lastTestOk: boolean | null
}

/** Current state of every real-money safety gate — see electron/services/liveTradingService.ts,
 * the only place any of this is actually enforced. `sessionArmed` always resets to false on
 * every app launch and is never persisted. */
export interface LiveTradingStatus {
  sessionArmed: boolean
  killSwitchEngaged: boolean
  maxOrderQuote: number
  hardMaxOrderQuote: number
  dailyCapQuote: number
  dailyUsedQuote: number
  dailyLossLimitQuote: number
  realizedPnlToday: number
}

/** The result of one real order fill. `avgFillPrice` is notional-weighted across a market
 * order's fills, since a market order can cross multiple price levels. */
export interface LiveOrderRecord {
  orderId: number
  status: string
  filledQty: number
  avgFillPrice: number
  cummulativeQuoteQty: number
  placedAt: number
}

/** Net accumulated base-asset holdings for one symbol, built from live BUY fills and reduced or
 * closed by live SELL fills — spot only, so always long (never negative `qty`). `avgCost` is a
 * running weighted average, same accounting as `simulateMarketMaking` in src/executors/engine.ts.
 * Closed positions (`closedAt !== null`) are kept for realized daily-P&L aggregation — see
 * electron/services/livePositionsService.ts. */
export interface LivePosition {
  id: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  qty: number
  avgCost: number
  openedAt: number
  closedAt: number | null
  exitPrice: number | null
  /** Null until the first reducing/closing sell fill; accumulates from there (a position can be
   * partially reduced by a live Order executor sell and stay open with qty > 0). */
  realizedPnl: number | null
}

/** A real resting live limit order — the only genuinely asynchronous real-money state this app
 * holds, since a live market order resolves synchronously. Survives app restarts (see
 * electron/services/liveOrdersService.ts): `LiveOrderScheduler` polls every `status === 'open'`
 * record regardless of which executor created it or whether the app was closed in between. */
export interface LiveOrder {
  id: string
  executorId: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  side: ExecutorSide
  orderId: number
  limitPrice: number
  quantity: number
  status: 'open' | 'filled' | 'cancelled' | 'expired'
  filledQty: number
  avgFillPrice: number | null
  placedAt: number
  resolvedAt: number | null
}

/** The result of a live Position executor's automatic exit — mirrors PositionExecutorState's
 * shape (src/executors/types.ts) but with a *real* fill price/P&L from the actual market sell,
 * never the nominal barrier target (a fast move between watcher polls can mean a worse real fill
 * than "the stop-loss price," same as a real stop order isn't a price guarantee either). */
export interface LiveExitResult {
  entryPrice: number
  exitReason: 'take_profit' | 'stop_loss' | 'time_limit' | 'trailing_stop' | 'manual'
  exitPrice: number
  realizedPnl: number
  closedAt: number
}

/** What the renderer is allowed to see about an active live Position watcher — used both for the
 * pre-flight symbol-conflict check (exchange/symbol) and, for a watcher with a configured
 * trailing stop, to show the live trailing-peak price and dynamic trail target (a real safety
 * number that would otherwise be invisible until the moment it triggers). */
export interface LiveWatcherSummary {
  executorId: string
  exchange: Exchange
  symbol: string
  trailingPeakPrice: number
}

/** OHLCV candle. `time` is a Unix timestamp in seconds (UTC), matching lightweight-charts. */
export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** Progress of an in-flight `fetchHistoricalRange` job. `total` is an estimate derived from
 * the requested range and interval; `done` is the real count of candles fetched so far.
 * `requestId` scopes this event to the specific fetch that produced it -- several independent
 * fetches (a background bot poll, a scheduled routine, a Backtest run) can be in flight at once,
 * all broadcasting to the same renderer, so a listener must filter on its own requestId. */
export interface HistoricalRangeProgress {
  requestId: string
  done: number
  total: number
}

export interface HistoricalRangeResult {
  candles: Candle[]
  cancelled: boolean
}

/** 24h rolling ticker stats. `volume` is in the base asset, `quoteVolume` in the quote asset. */
export interface Ticker24h {
  symbol: string
  lastPrice: number
  priceChange: number
  priceChangePercent: number
  highPrice: number
  lowPrice: number
  volume: number
  quoteVolume: number
}

export type Exchange = 'binance' | 'coinbase' | 'kraken' | 'bithumb' | 'upbit' | 'coinone' | 'korbit' | 'gopax'

export type Interval = '1m' | '15m' | '1h' | '4h' | '1d' | '1w'

export interface IntervalInfo {
  id: Interval
  label: string
}

export const INTERVALS: IntervalInfo[] = [
  { id: '1m', label: '1m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1H' },
  { id: '4h', label: '4H' },
  { id: '1d', label: '1D' },
  { id: '1w', label: '1W' }
]

export const DEFAULT_INTERVAL: Interval = '15m'

export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60
}

/** A trading pair as listed on a given exchange. `symbol` is that exchange's native format
 * (e.g. Binance 'BTCUSDT', Coinbase 'BTC-USD', Kraken 'XBT/USD') — not interchangeable across exchanges. */
export interface SymbolInfo {
  symbol: string
  baseAsset: string
  quoteAsset: string
}

export interface ExchangeInfo {
  id: Exchange
  name: string
  defaultSymbol: SymbolInfo
}

export const EXCHANGES: ExchangeInfo[] = [
  {
    id: 'binance',
    name: 'Binance',
    defaultSymbol: { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }
  },
  {
    id: 'coinbase',
    name: 'Coinbase',
    defaultSymbol: { symbol: 'BTC-USD', baseAsset: 'BTC', quoteAsset: 'USD' }
  },
  {
    id: 'kraken',
    name: 'Kraken',
    defaultSymbol: { symbol: 'XBT/USD', baseAsset: 'XBT', quoteAsset: 'USD' }
  },
  {
    id: 'bithumb',
    name: 'Bithumb',
    defaultSymbol: { symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }
  },
  {
    id: 'upbit',
    name: 'Upbit',
    defaultSymbol: { symbol: 'KRW-BTC', baseAsset: 'BTC', quoteAsset: 'KRW' }
  },
  {
    id: 'coinone',
    name: 'Coinone',
    defaultSymbol: { symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }
  },
  {
    id: 'korbit',
    name: 'Korbit',
    defaultSymbol: { symbol: 'btc_krw', baseAsset: 'BTC', quoteAsset: 'KRW' }
  },
  {
    id: 'gopax',
    name: 'GOPAX',
    defaultSymbol: { symbol: 'BTC-KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }
  }
]

export interface Bot {
  id: string
  name: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  /** Human-readable label shown on cards/Archived/Runs — auto-filled from the chosen strategy's
   * name. `strategyId` is what actually drives dispatch, see src/backtest/strategies/. */
  strategy: string
  strategyId: string
  enabled: boolean
  /** Unix seconds when this bot was last turned on — null while disabled. Dry-run paper trades
   * are only counted from this point on, not from the indicator warmup lookback before it. */
  enabledAt: number | null
  /** Archived bots are hidden from the Active tab and can no longer be enabled, but are kept
   * (not deleted) so their Runs history stays attributable. */
  archived: boolean
}

/** A completed dry-run session, recorded when a bot is disabled — one row per enable/disable
 * cycle, independent of whether the bot is later archived or re-enabled. */
export interface BotRun {
  id: string
  botId: string
  botName: string
  exchange: Exchange
  symbol: string
  startedAt: number
  endedAt: number
  trades: number
  wins: number
  netPct: number
}

export type ExecutorType = 'grid' | 'dca' | 'twap' | 'position' | 'order' | 'xemm' | 'arbitrage' | 'marketmaking'
export type ExecutorSide = 'buy' | 'sell'

export interface GridExecutorParams {
  side: ExecutorSide
  startPrice: number
  endPrice: number
  totalAmountQuote: number
  maxOpenOrders: number
  levelSpreadPct: number
  takeProfitPct: number
  limitPrice: number | null
}

export interface DcaLevel {
  priceOffsetPct: number
  amountQuote: number
}

export interface DcaExecutorParams {
  side: ExecutorSide
  levels: DcaLevel[]
  takeProfitPct: number
  stopLossPct: number | null
  timeLimitSec: number | null
}

export interface TwapExecutorParams {
  side: ExecutorSide
  totalAmountQuote: number
  totalDurationSec: number
  orderIntervalSec: number
}

export interface PositionExecutorParams {
  side: ExecutorSide
  /** null = enter at market (the first candle's open) instead of waiting for a touch. */
  entryPrice: number | null
  amountQuote: number
  takeProfitPct: number | null
  stopLossPct: number | null
  timeLimitSec: number | null
  trailingStop: { activationPct: number; trailPct: number } | null
}

export type OrderExecutionStrategy = 'limit' | 'limit_maker' | 'market' | 'limit_chaser'

export interface OrderExecutorParams {
  side: ExecutorSide
  amountQuote: number
  executionStrategy: OrderExecutionStrategy
  /** Required for limit/limit_maker/limit_chaser; ignored for market. */
  limitPrice: number | null
}

export interface SpreadMarket {
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
}

export interface XemmExecutorParams {
  buyingMarket: SpreadMarket
  sellingMarket: SpreadMarket
  makerSide: ExecutorSide
  orderAmountQuote: number
  minProfitabilityPct: number
}

export interface ArbitrageExecutorParams {
  buyingMarket: SpreadMarket
  sellingMarket: SpreadMarket
  orderAmountQuote: number
  minProfitabilityPct: number
}

/** Classic two-sided market making: quotes a bid/ask around the live price at a fixed spread,
 * refreshed on an interval, with optional inventory-skew management — the standard technique of
 * biasing quotes back toward a target inventory % as fills drift holdings away from it. */
export interface MarketMakingExecutorParams {
  side: 'both' | 'buy' | 'sell'
  spreadPct: number
  orderRefreshSec: number
  orderAmountQuote: number
  /** null = no inventory-skew management; quotes stay symmetric around the reference price. */
  inventoryTargetPct: number | null
  inventorySkewIntensity: number
}

export type ExecutorStatus = 'active' | 'stopped'

export interface ExecutorConfig {
  id: string
  name: string
  type: ExecutorType
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  createdAt: number
  status: ExecutorStatus
  stoppedAt: number | null
  /** Mirrors Condor's Position Handover: when true, an open/unrealized position is transferred
   * into the Positions → Inventory list on stop, instead of being discarded. */
  keepPosition: boolean
  /** 'live' only ever means anything for type 'order' with executionStrategy 'market' or
   * 'limit' on Binance — every other combination is always 'paper'. See liveTradingService.ts
   * for the gates a live order must pass, ExecutorPlaceLiveOrder/ExecutorPlaceLiveLimitOrder for
   * where it's actually placed. */
  mode: 'paper' | 'live'
  /** Set once a live executor's order actually fills (market: immediately; limit: whenever
   * LiveOrderScheduler detects the resting order resolved). Null for every paper executor and
   * for a live limit order still resting. */
  liveOrder: LiveOrderRecord | null
  /** Non-null only while a live limit order is still resting (status stays 'active' the whole
   * time) — points at the LiveOrder record LiveOrderScheduler is polling. Null once resolved. */
  pendingLiveOrderId: string | null
  /** Non-null only while a live Position executor's entry has filled and its exit conditions are
   * being watched for automatically (status stays 'active' the whole time) — points at the
   * watcher record in livePositionWatchersService.ts. Null once the exit fires or the executor
   * is stopped manually. */
  liveWatcherId: string | null
  /** Set once a live Position executor's watcher triggers a real exit (or Stop force-closes it).
   * Null for every paper executor and for a live Position still being watched. */
  liveExitResult: LiveExitResult | null
  params: GridExecutorParams | DcaExecutorParams | TwapExecutorParams | PositionExecutorParams | OrderExecutorParams | XemmExecutorParams | ArbitrageExecutorParams | MarketMakingExecutorParams
}

/** A position handed over from a stopped executor (Condor's "Position Handover" → agent
 * inventory) instead of being discarded when the executor that opened it terminates. Purely
 * local bookkeeping — closing one never places a real order. */
export interface HeldPosition {
  id: string
  sourceExecutorId: string
  sourceExecutorName: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  side: ExecutorSide
  entryPrice: number
  amountQuote: number
  openedAt: number
}

export interface ControllerRiskControls {
  globalStopLossPct: number | null
  globalTakeProfitPct: number | null
  maxDrawdownPct: number | null
}

/** A named group of executors with shared risk controls and periodic aggregate P&L snapshots —
 * adapts Condor's Controller concept (which supervises multiple executors inside a bot
 * container) onto this app's executor list, since there's no bot-container runtime here. */
export interface ControllerConfig {
  id: string
  name: string
  executorIds: string[]
  riskControls: ControllerRiskControls
  status: 'active' | 'stopped'
  createdAt: number
}

/** A saved recurring backtest, re-run on a client-side timer while the app is open (Condor's
 * routines are scheduled Python workflows; there's no backend here to host that, so this is the
 * closest honest adaptation). Run reports are session-only — see src/routines/routineStore.ts. */
export interface RoutineConfig {
  id: string
  name: string
  exchange: Exchange
  symbol: string
  interval: Interval
  strategyId: string
  scheduleSec: number
  enabled: boolean
  createdAt: number
  lastRunAt: number | null
}
