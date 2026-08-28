// Single source of truth for IPC channel names and payload shapes.
// Imported by both electron/ (main + preload) and src/ (renderer).

import type { ExchangeBalance } from './liveBalances'

export type { ExchangeBalance }

export const IpcChannel = {
  AppPing: 'app:ping',
  AppGetVersion: 'app:getVersion',
  BacktestExportSave: 'backtest:exportSave',
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
  MarketSymbolRules: 'market:symbolRules',
  CredentialsList: 'credentials:list',
  CredentialsSet: 'credentials:set',
  CredentialsTest: 'credentials:test',
  CredentialsRemove: 'credentials:remove',
  CredentialsBalances: 'credentials:balances',
  CredentialsFuturesPositions: 'credentials:futuresPositions',
  CredentialsCloseFuturesPosition: 'credentials:closeFuturesPosition',
  CredentialsFuturesStops: 'credentials:futuresStops',
  CredentialsPlaceFuturesStop: 'credentials:placeFuturesStop',
  CredentialsCancelFuturesStop: 'credentials:cancelFuturesStop',
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
  LiveTradingUpdateWatcherEntryPrice: 'liveTrading:updateWatcherEntryPrice',
  LiveTradingStopWatcher: 'liveTrading:stopWatcher',
  LiveTradingDrainWatcherEvents: 'liveTrading:drainWatcherEvents',
  LiveTradingCreateTwapRun: 'liveTrading:createTwapRun',
  LiveTradingListActiveTwapRuns: 'liveTrading:listActiveTwapRuns',
  LiveTradingStopTwapRun: 'liveTrading:stopTwapRun',
  LiveTradingDrainTwapEvents: 'liveTrading:drainTwapEvents',
  ExecutorPlaceLiveOrder: 'executor:placeLiveOrder',
  ExecutorPlaceLiveLimitOrder: 'executor:placeLiveLimitOrder'
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]

/** One movement of money in or out of the paper account.
 *
 * The account's balances are authoritative; this exists so a balance can be EXPLAINED rather than
 * only asserted. "Why do I have 9,400 USDT when I funded 10,000" has an answer here. */
export interface AccountLedgerEntry {
  id: string
  at: number
  asset: string
  /** Negative when money leaves the free balance (funding an executor), positive when it comes
   * back (an executor stopping, or its profit landing). */
  delta: number
  reason: 'fund' | 'allocate' | 'release' | 'adjust' | 'reset'
  /** The executor this movement belongs to, when there is one. */
  executorId: string | null
  note: string
}

/** The simulated account behind paper trading -- the thing that makes "input asset type and
 * balance, then start trading" mean something.
 *
 * Before this existed, every paper executor invented its own money: two executors could each
 * commit 10,000 USDT with nothing anywhere recording that you only ever had 10,000. Balances here
 * are FREE funds only. Money committed to a running executor has left the balance, exactly as it
 * would if you had moved it into a strategy, and comes back when that executor stops. */
export interface PaperAccount {
  /** asset -> free amount. Absent means zero. */
  balances: Record<string, number>
  /** What was funded, kept separately so performance can be measured against the starting point
   * rather than against a number that moves every time an executor opens. */
  initialBalances: Record<string, number>
  createdAt: number
  ledger: AccountLedgerEntry[]
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'colorblind'
  bots: Bot[]
  botRuns: BotRun[]
  executors: ExecutorConfig[]
  routines: RoutineConfig[]
  heldPositions: HeldPosition[]
  controllers: ControllerConfig[]
  /** Null until the user sets up a paper account. Null is not the same as an empty account: it
   * means "never configured", which is what lets the UI offer setup instead of reporting a
   * balance of zero as though it were a fact. */
  paperAccount: PaperAccount | null
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

/** Exchanges this app can place a real order on.
 *
 * Deliberately narrower than the set it can read an account from, and deliberately a separate
 * list rather than a flag on the same one. Reading a balance and spending it are different
 * permissions with different consequences, and a single list serving both is how an exchange
 * quietly becomes tradable because someone added a balance reader for it. Anything not named here
 * is read-only in this app however good the key is. */
export const TRADING_EXCHANGES: Exchange[] = ['binance']

export function canTradeOn(exchange: Exchange): boolean {
  return TRADING_EXCHANGES.includes(exchange)
}

/** What one exchange says the user actually holds, as read over their own API key.
 *
 * Read-only in every sense: nothing in the app writes to it, and it is never mixed into the paper
 * account. They are different money, and a beginner conflating the two is exactly the mistake
 * this app should not help them make. */
export interface LiveBalanceSnapshot {
  exchange: Exchange
  /** Non-zero balances, largest first -- see shared/liveBalances.ts. */
  rows: ExchangeBalance[]
  /** Assets the exchange reported in a form that could not be read as a number. */
  unreadable: string[]
  /** When this was read, so the UI can say how old it is rather than implying it is live. */
  fetchedAt: number
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
  /** The fee rate the exchange really charged on the most recent live fill, or null if none has
   * been seen yet. Reported so Settings can say when FEE_RATE disagrees with reality; it drives
   * nothing on its own. */
  observedFeeRate: number | null
  /** The managed allocation -- the most of the real balance this app may have at work at once --
   * or null when none is configured and the gate does not apply. See shared/allocation.ts. */
  allocationQuote: number | null
  /** What is at work right now against that allocation, derived from the live positions and
   * resting orders that exist. Always 0 when allocationQuote is null. */
  allocationCommittedQuote: number
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
  entryPrice: number
  trailingPeakPrice: number
  /** Consecutive failed evaluations. Non-zero means the exit barriers are not currently being
   * checked, so the UI must stop implying the position is protected. */
  consecutiveFailures: number
  lastError: string | null
}

/** A live TWAP run's progress while still active — polled every 5s by ExecutorCard/
 * ExecutorDetailView the same way LiveWatcherSummary is. Only ever covers slices the run itself
 * placed (slice 0 always resolves synchronously at creation and lives on
 * ExecutorConfig.liveOrder instead — see liveTwapService.ts and the ExecutorConfig doc comment on
 * liveTwapRunId for why the two are combined for display rather than merged into one record). */
export interface LiveTwapRunSummary {
  id: string
  executorId: string
  ordersPlaced: number
  numOrders: number
  totalQuoteFilled: number
  totalBaseFilled: number
  failedSlices: number
  lastError: string | null
}

/** Pushed once a live TWAP run finishes — either every slice was attempted (status 'done') or it
 * was stopped manually before that (status 'stopped'). Drained by LiveOrderScheduler the same way
 * a live Position/DCA watcher's resolved event is. */
export interface LiveTwapResolution {
  executorId: string
  runId: string
  status: 'done' | 'stopped'
  ordersPlaced: number
  numOrders: number
  totalQuoteFilled: number
  totalBaseFilled: number
  failedSlices: number
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
  /** Simulation only, and optional so every executor stored before this existed still loads as
   * what it was: absent means 1x, which is spot and behaves exactly as before.
   *
   * Above 1x the position can be liquidated, and live mode is refused outright -- this app places
   * no leveraged order on any exchange. See shared/perp.ts. */
  leverage?: number
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
   * while any live limit order is still resting. For a live DCA executor with more than one
   * fill, this is only ever the LAST resolved order — see liveOrder history via liveTrading if a
   * full fill-by-fill record is ever needed; the running position is authoritative, this is just
   * a "something resolved" breadcrumb. */
  liveOrder: LiveOrderRecord | null
  /** Ids of still-resting live limit orders — one entry for a live Order executor's single
   * resting limit, up to one per unfilled level for a live DCA executor's ladder (each level is
   * its own independent resting order, not a single order like Order/Position). Empty while
   * nothing is resting (paper executors always have an empty array). LiveOrderScheduler polls
   * every id in here every 5s and removes entries as they resolve. */
  pendingLiveOrderIds: string[]
  /** Non-null only while a live Position or DCA executor has at least one open (filled) position
   * being watched for an automatic exit (status stays 'active' the whole time) — points at the
   * watcher record in livePositionWatchersService.ts. For DCA, this is created on the FIRST level
   * fill and its entryPrice is kept refreshed (updateWatcherEntryPrice) as later levels fill,
   * since the average cost basis keeps moving until the ladder either exits or runs out of
   * levels. Null once the exit fires or the executor is stopped manually. */
  liveWatcherId: string | null
  /** Set when arming this executor exit watcher failed, or when a fill happened but no live
   * position could be found to arm one against. Non-null means a REAL position may be open on the
   * exchange with no take-profit, stop-loss or time limit on it.
   *
   * It exists because that failure used to be a console.error and nothing else: the fill cleared
   * pendingLiveOrderIds, the failed createWatcher left liveWatcherId null, and the "everything is
   * empty, so we are done" rule then marked the executor stopped -- reporting an unprotected real
   * position as a job cleanly finished. While this is set the executor stays active, retries
   * arming the watcher on every poll, and says so on its card.
   *
   * Undefined on executors saved before this field existed; read it as `?? null`. */
  liveWatcherError: string | null
  /** Set when arming this executor's exit watcher failed, or when a fill happened but no live
   * position could be found to arm one against. Non-null means a REAL position may be open on the
   * exchange with no take-profit, stop-loss or time limit on it.
   *
   * It exists because the failure used to be a console.error and nothing else: the fill cleared
   * pendingLiveOrderIds, the failed createWatcher left liveWatcherId null, and the "everything is
   * empty, so we are done" rule below then marked the executor stopped -- reporting an unprotected
   * real position as a job cleanly finished. While this is set the executor stays active, retries
   * arming the watcher on every poll, and says so on its card.
   *
   * Undefined on executors saved before this field existed; read it as 
  /** Set once a live Position/DCA executor's watcher triggers a real exit (or Stop force-closes
   * it). Null for every paper executor and for a live position still being watched. */
  liveExitResult: LiveExitResult | null
  /** Real market price captured once via market.fetchTicker24h at creation time — only set for a
   * live DCA executor, which needs a real reference price to compute each level's real limit
   * price (dcaLevelPrice) since there's no candle replay live the way paper mode has. Null for
   * every other executor. */
  liveDcaBasePrice: number | null
  /** Non-null only while a live TWAP executor still has slices left to place beyond the first
   * (which always resolves synchronously at creation and lives on `liveOrder` instead) — points
   * at the run record in liveTwapService.ts, a main-process-resident loop that places the
   * remaining slices on a timer independent of any renderer being open. Null once every slice has
   * been attempted or Stop halts the run early. */
  liveTwapRunId: string | null
  /** Set once a live TWAP run finishes (every slice attempted, or Stop halted it early). Combines
   * slice 0 (from `liveOrder`) with every slice the run itself placed, so it's the one place with
   * the true final count/VWAP — see the LiveTwapRunSummary doc comment for why the two sources
   * are never merged into a single running record. Null for every other executor. */
  liveTwapResult: {
    ordersPlaced: number
    numOrders: number
    totalQuoteFilled: number
    totalBaseFilled: number
    failedSlices: number
    stoppedEarly: boolean
  } | null
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
/** Why a controller stopped itself, kept so the page can say more than "stopped".
 *
 * Optional because controllers saved before this existed have no such record, and a controller
 * paused by hand never gets one. */
export interface ControllerBreachRecord {
  kind: 'stop-loss' | 'take-profit' | 'max-drawdown'
  limitPct: number
  actualPct: number
  atSec: number
}

export interface ControllerConfig {
  id: string
  name: string
  executorIds: string[]
  riskControls: ControllerRiskControls
  status: 'active' | 'stopped'
  createdAt: number
  lastBreach?: ControllerBreachRecord | null
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

/** Where a finished backtest goes when the user exports it.
 *
 * The renderer sends already-formatted text rather than a result object: it owns the backtest
 * types, and duplicating them in the main process to re-serialize there would create two
 * definitions of the file format that could drift. The main process shows the save dialog and
 * writes bytes.
 *
 * There is no path in this request on purpose. The user picks it in a native dialog every time,
 * so nothing here can write to an arbitrary location on its own. */
export interface BacktestExportRequest {
  defaultFileName: string
  content: string
  format: 'json' | 'csv'
}

export type BacktestExportResult =
  | { status: 'saved'; filePath: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }
