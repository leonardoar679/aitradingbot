// Single source of truth for IPC channel names and payload shapes.
// Imported by both electron/ (main + preload) and src/ (renderer).

import type { AiRoute } from './aiRoute'
import type { ExchangeBalance } from './liveBalances'

export type { ExchangeBalance }

export const IpcChannel = {
  AppPing: 'app:ping',
  AppGetVersion: 'app:getVersion',
  AppNotify: 'app:notify',
  AppRemind: 'app:remind',
  AppEffectiveConfig: 'app:effectiveConfig',
  RecordsRefusal: 'records:refusal',
  RecordsRefusals: 'records:refusals',
  RecordsAlert: 'records:alert',
  RecordsAlerts: 'records:alerts',
  AlertsTold: 'alerts:told',
  ExperimentStart: 'experiment:start',
  ExperimentList: 'experiment:list',
  ExperimentStop: 'experiment:stop',
  ExperimentReport: 'experiment:report',
  ExperimentUpdate: 'experiment:update',
  HealthState: 'health:state',
  HealthUpdate: 'health:update',
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
  MarketCompare: 'market:compare',
  MarketLiveInterest: 'market:liveInterest',
  MarketLiveState: 'market:liveState',
  MarketLiveBook: 'market:liveBook',
  MarketLiveUpdate: 'market:liveUpdate',
  ScannerGetState: 'scanner:getState',
  ScannerSetConfig: 'scanner:setConfig',
  ScannerListEvents: 'scanner:listEvents',
  ScannerScanHistory: 'scanner:scanHistory',
  ScannerCancelHistory: 'scanner:cancelHistory',
  ScannerPickUniverse: 'scanner:pickUniverse',
  ScannerUpdate: 'scanner:update',
  ScannerHistoryProgress: 'scanner:historyProgress',
  ResearchGetState: 'research:getState',
  ResearchRefresh: 'research:refresh',
  ResearchUpdate: 'research:update',
  FeedGetState: 'feed:getState',
  ForecastGetState: 'forecast:getState',
  ForecastList: 'forecast:list',
  ForecastGet: 'forecast:get',
  ForecastHistory: 'forecast:history',
  ForecastRanking: 'forecast:ranking',
  ForecastDecision: 'forecast:decision',
  ForecastLab: 'forecast:lab',
  ForecastReplay: 'forecast:replay',
  ForecastBars: 'forecast:bars',
  ForecastRecord: 'forecast:record',
  ForecastUpdate: 'forecast:update',
  FeedUpdate: 'feed:update',
  FeedOpenLink: 'feed:openLink',
  FeedHistory: 'feed:history',
  NewsGetState: 'news:getState',
  NewsSetConfig: 'news:setConfig',
  NewsList: 'news:list',
  NewsUpdate: 'news:update',
  NewsRecord: 'news:record',
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
  AiCredentialsStatus: 'ai:credentialsStatus',
  AiCredentialsSet: 'ai:credentialsSet',
  AiCredentialsTest: 'ai:credentialsTest',
  AiCredentialsRemove: 'ai:credentialsRemove',
  AiEstimateSignalTape: 'ai:estimateSignalTape',
  AiGenerateSignalTape: 'ai:generateSignalTape',
  AiCancelSignalTape: 'ai:cancelSignalTape',
  AiSignalProgress: 'ai:signalProgress',
  AiKeyInfo: 'ai:keyInfo',
  AiListModels: 'ai:listModels',
  AiGetConfig: 'ai:getConfig',
  AiSetConfig: 'ai:setConfig',
  AiListCalls: 'ai:listCalls',
  AiUsageSummary: 'ai:usageSummary',
  AiPeekEntryConfirmation: 'ai:peekEntryConfirmation',
  AiConfirmEntry: 'ai:confirmEntry',
  AiPeekBenchmark: 'ai:peekBenchmark',
  AiPeekOpportunity: 'ai:peekOpportunity',
  AiAskOpportunity: 'ai:askOpportunity',
  AiListExperiments: 'ai:listExperiments',
  AiGetExperiment: 'ai:getExperiment',
  AiRecordExperiment: 'ai:recordExperiment',
  AiAdditionsStatus: 'ai:additionsStatus',
  AiConcludeMove: 'ai:concludeMove',
  AiReviewTrade: 'ai:reviewTrade',
  AiExitCheck: 'ai:exitCheck',
  AiSummarizeDay: 'ai:summarizeDay',
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
  /** The account's own stream and the reconciliation, read-only (the V5 document, S101-102). */
  LiveTradingUserStream: 'liveTrading:userStream',
  LiveTradingReconciliation: 'liveTrading:reconciliation',
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

/** What the price forecast stands at (the V6 document; V6 Stage 7): its engine, its training and its
 * bars, for the window. */
export interface ForecastState {
  engine: import('./forecast/status').EngineState
  training: import('./forecast/status').TrainingState
  data: import('./forecast/bars').ForecastDataStatus
}

/** A pair's forecasts on record and their outcomes. */
export interface ForecastHistory {
  predictions: import('./forecast/forecastRecord').PredictionLine[]
  outcomes: (import('./forecast/forecastRecord').OutcomeLine | import('./forecast/forecastRecord').MissingOutcomeLine)[]
  /** A span's passes (forecast:record only, since V6 Stage 16): the pairs each recorded close held bars for. */
  passes?: import('./forecast/forecastRecord').PassLine[]
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
  /** The version of this file's shape (shared/configMigration.ts), stamped by the main process
   * each time it writes the file. Absent on a file from before 8 October 2026, which is read as
   * version 0 and stamped on its first read. */
  configVersion?: number
  /** How the paper trades the app opens by itself are sized, and how much they may have out
   * together (shared/paperRisk.ts). Absent on a file written before it existed, and healed on
   * every read: its defaults apply. */
  paperRisk?: PaperRiskSettings
  /** The daily notice of what those trades did the day before (shared/paperDigest.ts), and the
   * last day it told. Absent until first written, and healed on every read. */
  paperDigest?: PaperDigestSettings
  /** The losing run in R that pauses those trades until someone resumes them, and whether each of
   * the two that open them is paused (shared/paperPause.ts). Absent until first written, and healed
   * on every read: its defaults apply. */
  paperPause?: PaperPauseSettings
  /** Whether the app raises desktop notices at all, and with sound (shared/alerts.ts). Absent until
   * first written, and healed on every read: on, with sound. */
  alerts?: AlertSettings
  /** Whether closing the window hides it to the tray and keeps everything running, or quits the
   * app (shared/keepRunning.ts). Absent until first written, and healed on every read: off. */
  keepRunningWhenClosed?: boolean
  /** Which of the sidebar's two personalities (shared/uiMode.ts): normal folds Research and All
   * Features away, expert opens every group. Absent until first written, and healed on every read:
   * normal. */
  uiMode?: 'normal' | 'expert'
  /** The language the normal-user pages and the notices are in (shared/i18n/languages.ts; V6 Stage 14).
   * Absent until chosen: the first launch asks, offering the computer's language, and the expert pages
   * stay English in any. Healed on every read. */
  language?: import('./i18n/languages').Language
  /** The price forecast's nightly refit, on unless switched off (shared/forecast/training.ts), and the
   * forecast trader (shared/forecast/trader.ts), off until switched on. Absent until first written, and
   * healed on every read. Written whole: a patch replaces it. */
  forecast?: { refitNightly?: boolean; trader?: Partial<import('./forecast/trader').ForecastTraderSettings>; lab?: Partial<import('./forecast/labTrader').LabSettings> }
  /** How the four sounds play (shared/sounds.ts; V6 Stage 13): the volume, kinds muted, the cooldown,
   * quiet hours. Absent until first written, and healed on every read. */
  sounds?: Partial<import('./sounds').SoundSettings>
}

/** The app's desktop notices: on or off, and with sound or silent. */
export interface AlertSettings {
  enabled: boolean
  sound: boolean
  /** Whether the operating system's notices are shown (V6 Stage 13). Off, notices are still recorded,
   * shown in the window and heard. Absent before: on. */
  desktop?: boolean
}

/** A losing run pauses the paper trades the app opens by itself, the watch's and the news rules'
 * each on its own record, until someone resumes them. It only ever opens less. */
export interface PaperPauseSettings {
  /** What the run lost together, in R, that pauses one. Null: no run does. */
  lossR: number | null
  /** How many of its last closed trades with a stop the run is. */
  trades: number
  watch: PaperPauseState
  news: PaperPauseState
  /** The forecast trader's (V6 Stage 12). Absent before it: not paused. */
  forecast: PaperPauseState
}

export interface PaperPauseState {
  /** When it was last resumed, in seconds: trades closed then or before are not counted. Null: all
   * are. */
  countFrom: number | null
  /** When a run paused it, and that run: how many trades, and what they made in R together. Null
   * while it is not paused. */
  paused: { at: number; r: number; trades: number } | null
}

/** One desktop notice a day of what the app's own paper trades did the UTC day before. */
export interface PaperDigestSettings {
  enabled: boolean
  /** `2026-10-05`: the last day told, so that a restart does not tell it twice. */
  lastDay: string | null
}

/** The paper trades the app opens by itself -- the watch's and the news rules' -- sized by what
 * their stop would lose, and capped in what they stake together. Both only ever open less. */
export interface PaperRiskSettings {
  /** 'risk': a trade with a stop stakes what would lose about `riskQuote` there, after fees, and
   * never more than its own stake. 'stake': each stakes its own stake. 'equity' (since 8 October
   * 2026): as 'risk', with the risk per trade a share of the paper account's equity, `riskPct`,
   * and `riskQuote` where there is no paper account to measure. */
  sizing: 'risk' | 'stake' | 'equity'
  /** In the trade's quote asset. */
  riskQuote: number
  /** Of the paper account's equity, in percent: what one trade risks at its stop under 'equity'. */
  riskPct: number
  /** The most their open paper trades may stake together, per quote asset. Null: no cap. */
  maxOutQuote: number | null
  /** Of the paper account's funding (or the money-out cap without one), the most those open on one
   * side may stake on pairs that move with Bitcoin (shared/paperExposure.ts). Absent before the risk
   * modes (V6 Stage 12): 0.15, as it was fixed. */
  correlatedShare?: number
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
  /** Of the allocation, or of the day's cap without one, the share in percent a real order filled
   * in from a call is sized to risk at the call's stop (shared/aiProposal.ts suggestedLiveAmount).
   * A suggestion for the form, since 8 October 2026; no gate reads it. */
  riskPct: number
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
  /** The real position it guards (LivePosition.id), since 8 October 2026: what Positions joins it
   * by. */
  livePositionId: string
  exchange: Exchange
  symbol: string
  entryPrice: number
  trailingPeakPrice: number
  /** Its barriers and its entry's minute, since 8 October 2026: shown beside the position, and what
   * its thesis status is measured on (src/positions/thesisMeasure.ts). A copy: changing one here
   * changes nothing on the watcher. */
  takeProfitPct: number | null
  stopLossPct: number | null
  timeLimitSec: number | null
  trailingStop: { activationPct: number; trailPct: number } | null
  enteredAt: number
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

/** One exchange's quote of a pair, read now for the comparison of exchanges (V7.1 Stage 6; the rule in
 * shared/marketCompare.ts). Every figure is null where the exchange does not list the pair or did not
 * answer, and `problem` says which. */
export interface ExchangeQuote {
  exchange: Exchange
  symbol: string
  price: number | null
  bid: number | null
  ask: number | null
  /** The spread as a share of the mid, in percent. */
  spreadPct: number | null
  /** What rests within half a percent of the mid on each side, in the quote currency. */
  bidDepthQuote: number | null
  askDepthQuote: number | null
  quoteVolume24h: number | null
  /** How old the book was by the exchange's own stamp, ms; null where it gives none. */
  bookAgeMs: number | null
  /** How long the reads took together, ms. */
  roundTripMs: number | null
  problem: string | null
}

export interface MarketComparison {
  symbol: string
  /** When it was read, ms. */
  at: number
  quotes: ExchangeQuote[]
}

export type Exchange = 'binance' | 'bitget' | 'coinbase' | 'kraken' | 'bithumb' | 'upbit' | 'coinone' | 'korbit' | 'gopax'

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
  /** True for a token that tracks a listed stock or fund -- on Binance, NVDAB, SPYB and the rest --
   * where the exchange's own listing says so. Its price is made by the stock's market, on that
   * market's hours. Absent on every other pair. */
  stockToken?: boolean
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
    // Public market data since V7.1 Stage 6 (16 October 2026); its account and orders come after.
    id: 'bitget',
    name: 'Bitget',
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
  /** The model a paid bot asks, fixed at the moment it was switched on. Absent on every free
   * strategy and on bots saved before this existed, which fall back to the configured default.
   *
   * Pinned rather than read from the default each poll, because the model is part of what the bot
   * IS. With the default read live, choosing a different one under Settings › AI would re-ask a
   * running bot's whole history of that model's replacement -- paid for, unannounced -- and turn
   * its paper record into another model's from that candle on. */
  aiModel?: string
  /** True when a model is asked to confirm each entry this bot's strategy signals, and can veto
   * it (shared/aiConfirm.ts). Absent on every bot saved before this existed, and meaningless on
   * GPT Intraday, where the model already makes every decision.
   *
   * Part of what the bot IS, like the strategy: it is chosen when the bot is created and is not a
   * switch on a running one, because a paper record that was confirmed for its first month and
   * unconfirmed for its second is a record of neither. */
  aiConfirm?: boolean
  /** How often a GPT Intraday bot asks its model, in 15-minute bars: 4 is hourly, 16 is every four
   * hours (shared/aiSignal.ts, GPT_DECISION_EVERY_BARS). Absent means every candle, which is what
   * every bot saved before this existed does. Meaningless on any other strategy.
   *
   * Chosen when the bot is created, for the reason aiConfirm is: it decides which candles the
   * model is asked about, so changing it part-way would splice two different strategies into one
   * paper record. */
  aiEveryBars?: number
  /** The second model a GPT Intraday bot passes decisions on to, and when (shared/aiRoute.ts).
   * Absent means one model decides alone, which is what every bot saved before this existed does.
   *
   * Pinned at the moment the bot is switched on, with aiModel and for the same reason: a route is
   * part of which model made each decision. It is also written ONLY there, after the confirmation
   * that states it, so a bot never starts asking a second model because a setting changed. */
  aiRoute?: AiRoute
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
  /** Simulation only. Unix seconds after which an entry that has not filled is abandoned: the
   * position closes having bought nothing. Set on a paper position made from a recommendation
   * (shared/aiProposal.ts, shared/aiWatchPaper.ts), whose entry is only good for so many minutes.
   * Absent or null, an entry waits for as long as the executor runs, as every one stored before
   * this existed still does. A live position never carries it: a resting live order is cancelled
   * by a person, not by a clock in this app. */
  entryExpiresAt?: number | null
  /** Simulation only. The range of prices a recommendation said to enter in. With it the position
   * enters in the first candle that trades inside the range -- at that candle's open when the
   * open is inside it, otherwise at the edge the price came in by -- whichever side the price
   * comes from, and `entryPrice` is not consulted. That is the rule a recommendation is scored by
   * (shared/aiOpportunityOutcome.ts), so a paper position made from one enters where its score
   * says it did, and a price that has left the range is neither chased nor bought at once from
   * its far side. Absent or null on every other position, and never on a live one: an exchange
   * has no order that means this. */
  entryRange?: { min: number; max: number } | null
  /** Simulation only. What each market fill gives up, as a fraction (shared/fees.ts
   * positionSlippageRate): the entry, a stop, a trailing stop and the time limit fill that much worse
   * than their price; a take-profit is a resting limit and is paid exactly. Set on the app's own
   * paper trades to the rate their recommendation is scored at (shared/aiOpportunityOutcome.ts), so
   * a paper trade and its score agree on what it cost. Absent or null, a position fills at its
   * prices, as every one a person makes, and every one stored before this existed, still does. */
  slippageRate?: number | null
  /** Simulation only. A fill already taken when the executor was made: the streamed ask (for a buy)
   * or bid (for a sell) at the second the recommendation was enterable (shared/liveMarket.ts
   * streamedEntry), in Unix seconds. The position is in the market from the minute containing
   * `at`, at `price` plus its slippage, and `entryRange`, `entryPrice` and `entryExpiresAt` are not
   * consulted. Set on the watch's paper trades since 8 October 2026 (src/agents/watchPaperTrade.ts),
   * so that an answer at second 18 of a minute does not wait for the next one; the recommendation's
   * score stays on minute bars, and the two are shown side by side. Never on a live executor, and
   * absent on every one stored before. */
  entryFill?: { price: number; at: number } | null
}

/** How a simulated position ended. `entry_expired` is one that never began: its entry was not
 * reached before `entryExpiresAt`, and it bought nothing. */
export type PositionExitReason = 'take_profit' | 'stop_loss' | 'time_limit' | 'trailing_stop' | 'liquidation' | 'entry_expired'

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

/** Written on one of the app's own PAPER trades when the exit check (shared/aiAdditions.ts) answered
 * EXIT while it was open, and its time limit was brought forward so that the engine closes it in the
 * next minute (shared/aiExit.ts). Nothing else about it changed: its stop, its target, its entry and
 * its stake are as they were. Never present on a live executor: neither file that writes one can
 * make or find a live one. */
export interface AiExitMark {
  /** When its time limit was brought forward, and the minute it closes in. */
  at: number
  closeAt: number
  /** Where the engine says it entered, and the time limit it had: with its parameters, the plan as
   * it was, which is what it is measured against. */
  enteredAt: number
  planTimeLimitSec: number
  /** Who answered, why it was asked (shared/aiAdditions.ts EXIT_TRIGGERS), and what it said. */
  model: string
  triggers: string[]
  confidence: number
  reason: string
  /** What the plan would have made, worked out once its own time limit had passed: its exit, its
   * result after fees, and the minute. Null when its minutes could not be read to the end; absent
   * until then. */
  plan?: { exit: PositionExitReason; pnlQuote: number; closedAt: number } | null
}

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
  /** Set when the form this executor was created from was filled in from a model's call
   * (shared/aiProposal.ts). It records where the idea came from and nothing reads it in order to
   * act: the executor was submitted by a person, like every other one. Absent on every executor
   * set up from an empty form. */
  proposedBy?: { model: string; candleTime: number; confidence: number }
  /** Set on a PAPER Position the watch opened by itself (shared/aiWatchPaper.ts): the event it was
   * about and the answer it followed. The watch finds its own trades by this, to hold itself to
   * one an event and so many open at once, and to stop and settle one when its position has
   * closed. Never present on a live executor: the watch has no way to make one. */
  watch?: {
    eventId: string
    eventTime: number
    model: string
    confidence: number
    /** The ledger row of the call it follows, and the question's version, since 8 October 2026: what
     * joins the trade to its call without guessing by event and model. Absent on older trades. */
    callId?: string
    promptVersion?: string
    /** How it ended, written when the watch stops it because its position has closed: the exit,
     * what it made or lost in the quote asset after the simulation's fees, and the minute. A
     * stopped executor is not simulated again, so this is what its card has to show, and it is
     * all there is with no paper account for the result to go to. Absent while it is open, and on
     * one a person stopped first. `btc_moved` is one the watch dropped before it entered, because
     * Bitcoin had moved against it by more than its safeguard allows; `btcMovePct` is that move.
     * `ai_exit` is one the exit check closed: its time limit, brought forward, ended it. */
    result?: {
      exit: PositionExitReason | 'btc_moved' | 'ai_exit'
      pnlQuote: number
      closedAt: number
      btcMovePct?: number
      /** How far the price went for the trade and against it while it was held, in percent of the
       * entry, from the minutes it was settled on (since 8 October 2026; absent before). */
      bestPct?: number
      worstPct?: number
    }
    /** Set when the exit check answered EXIT while it was open (AiExitMark). */
    aiExit?: AiExitMark
    /** The live book it was opened against (shared/liveMarket.ts): its best bid and ask, the
     * spread, how old the price was, and where it came from. Absent on one opened before
     * 6 October 2026, when the live price was first checked. */
    book?: { bid: number; ask: number; spreadPct: number; ageMs: number; source: 'stream' | 'rest' }
    /** How its pair's hourly moves over the seven days before it was opened correlated with
     * Bitcoin's (shared/paperExposure.ts); null when they could not be read. Absent on one opened
     * before 6 October 2026, which counts as tracking Bitcoin. */
    btcCorrelation?: number | null
    /** The call's expected value when the trade was opened (shared/expectedValue.ts), since
     * 8 October 2026: in percent and in R, at a calibrated win rate or the model's own confidence.
     * Shown on the trade's timeline; nothing reads it to act. */
    ev?: { pct: number; r: number | null; basis: 'calibrated' | 'confidence'; winRate: number; sample: number; scope: 'event type' | 'all events' | null; costsPct?: number; aiCostPct?: number }
    /** The conditions' factor on the risk it was sized at (shared/dynamicRisk.ts; since 8 October
     * 2026), and why: absent at the whole risk, and on one opened before. */
    riskFactor?: number
    riskReasons?: string[]
    /** The market's regime when it was opened (shared/marketResearch.ts), for where the result came
     * from (shared/performance/attribution.ts; since 8 October 2026): a record, read by nothing that
     * decides. Null where the research had not read the market; absent on one opened before. */
    regime?: 'panic' | 'high-vol' | 'recovery' | 'bull' | 'bear' | 'sideways' | null
  }
  /** Set on a PAPER Position short opened by a rule research/NEWS.md measured, on Binance's
   * announcement (shared/newsActions.ts): which announcement and which coin. A delisting's is out
   * four hours after the announcement's minute, with no stop and no target; a Monitoring Tag's has
   * a stop and a target and is out within the hour. Never present on a live executor:
   * src/news/newsPaperShort.ts, the one file that makes one, spells paper as a literal. How it
   * ended is written on it when it is stopped, as on the watch's. */
  /** Set on a PAPER Position the forecast trader opened (shared/forecast/trader.ts; V6 Stage 12): the
   * forecast, the decision and the plan it followed, and how it ended once stopped. Never on a live
   * executor: src/forecast/forecastTrader.ts, the one file that makes one, spells paper as a literal. */
  forecast?: import('./forecast/trader').ForecastTradeMark
  /** Set on a PAPER Position the paper laboratory opened (shared/forecast/labTrader.ts; V7.1 Stage 4): the
   * strategy it was opened under, and the forecast, decision and plan it followed. Never on a live
   * executor: src/forecast/labTrader.ts, the one file that makes one, spells paper as a literal. */
  lab?: import('./forecast/labTrader').LabTradeMark
  newsRule?: {
    articleId: number
    ticker: string
    releaseSec: number
    title: string
    /** Which kind of announcement it was opened on. ABSENT on a short opened before the Monitoring
     * Tag was read (5 October 2026): every one of those was a delisting's. */
    category?: 'DELISTING' | 'MONITORING_TAG'
    result?: { exit: PositionExitReason | 'ai_exit'; pnlQuote: number; closedAt: number }
    /** As on the watch's: set when the exit check answered EXIT while it was open. */
    aiExit?: AiExitMark
    /** As on the watch's: its pair's correlation with Bitcoin when it was opened. */
    btcCorrelation?: number | null
  }
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
  /** Text for `json` and `csv`; base64 PNG bytes, without the `data:` prefix, for `png`. Base64
   * rather than a Buffer or a typed array because this crosses the structured-clone boundary and
   * a plain string is the one representation both sides already agree on. */
  content: string
  format: 'json' | 'csv' | 'png'
}

export type BacktestExportResult =
  | { status: 'saved'; filePath: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }
