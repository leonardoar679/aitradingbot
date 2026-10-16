import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { FuturesCloseResult, FuturesReadout } from '../shared/futuresPositions'
import type { ProtectiveStop } from '../shared/futuresStops'
import type { PricePrediction } from '../shared/forecast/prediction'
import type { TradeDecision } from '../shared/forecast/tradeDecision'
import type { ForecastLabView, ForecastReplay } from '../shared/forecast/labView'
import type { ForecastRanking as ForecastRankingView } from '../shared/forecast/ranking'
import type { SymbolTradingRules } from '../shared/exchangeMinimums'
import type {
  AiCredentialStatus,
  AiSignalDecision,
  AiSignalEstimate,
  AiSignalProgress,
  AiSignalTape,
  AiSignalTapeRequest
} from '../shared/aiSignal'
import type { AiBenchmarkPeek, AiBenchmarkPeekRequest } from '../shared/aiBenchmark'
import type { AiEntryConfirmRequest, AiEntryPeek } from '../shared/aiConfirm'
import type { AiExperiment, AiExperimentInput, AiExperimentPage } from '../shared/aiExperiment'
import type { ExperimentKind, ExperimentReport, ExperimentRun } from '../shared/experimentRun'
import type { AiOpportunityAskRequest, AiOpportunityPeek, AiOpportunityPeekRequest } from '../shared/aiOpportunity'
import type { AiConfig, AiConfigPatch, AiKeyInfo, AiModelCatalogue, AiUsageSummary } from '../shared/aiCost'
import type { AiCallFilter, AiCallPage } from '../shared/aiLedger'
import type {
  MarketEventFilter,
  MarketEventPage,
  ScanHistoryProgress,
  ScanHistoryRequest,
  ScanHistoryResult,
  ScannerConfigPatch,
  ScannerState
} from '../shared/marketScanner'
import type { ResearchState } from '../shared/marketResearch'
import type { LiveBook, LiveState } from '../shared/liveMarket'
import type { NewsFeedState, StoryMark } from '../shared/newsFeed'
import type { AiAdditionsStatus, DailySummary, DailySummaryRequest, ExitCheck, ExitCheckRequest, MoveConclusion, TradeReview } from '../shared/aiAdditions'
import type { MarketEvent } from '../shared/marketEvent'
import type { NewsConfigPatch, NewsFilter, NewsPage, NewsState } from '../shared/news'
import type { NewsRecord } from '../shared/newsRecord'
import {
  IpcChannel,
  type AppSettings,
  type Candle,
  type CredentialStatus,
  type Exchange,
  type ForecastHistory,
  type ForecastState,
  type HistoricalRangeProgress,
  type HistoricalRangeResult,
  type Interval,
  type LiveBalanceSnapshot,
  type LiveExitResult,
  type LiveOrderRecord,
  type LivePosition,
  type LiveTradingStatus,
  type LiveTwapRunSummary,
  type LiveTwapResolution,
  type LiveWatcherSummary,
  type BacktestExportRequest,
  type BacktestExportResult,
  type MarketComparison,
  type SymbolInfo,
  type Ticker24h
} from '../shared/ipc'
import type { EffectiveConfig } from '../shared/appConfig'
import type { HealthState } from '../shared/exchangeHealth'
import type { ReconciliationReadout } from '../shared/reconcileLive'
import type { UserStreamState } from '../shared/userStream'
import type { NoticeExtra } from '../shared/notices'
import type { AlertRecordOnFile, PaperRefusalRecord, RecordFilter } from '../shared/records'

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke(IpcChannel.AppPing),
  getVersion: (): Promise<string> => ipcRenderer.invoke(IpcChannel.AppGetVersion),
  /** A desktop notice. Resolves false where the system cannot show one, or when it repeats one told
   * on its thread (shared/notices.ts NoticeExtra: its kind, its thread, how loud). */
  notify: (title: string, body: string, severity?: 'watch' | 'high' | 'critical', extra?: NoticeExtra): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.AppNotify, title, body, severity, extra),
  /** A reminder's sound for a CRITICAL banner still up (shared/alerts.ts): the main process beeps
   * where notices are on with sound, and shows and records nothing. Resolves true when it did. */
  remind: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.AppRemind),
  /** The effective configuration, read-only, with its versions (shared/appConfig.ts). */
  effectiveConfig: (): Promise<EffectiveConfig> => ipcRenderer.invoke(IpcChannel.AppEffectiveConfig),
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IpcChannel.SettingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IpcChannel.SettingsSet, patch)
  },
  market: {
    listSymbols: (exchange: Exchange): Promise<SymbolInfo[]> =>
      ipcRenderer.invoke(IpcChannel.MarketListSymbols, exchange),
    subscribeCandles: (exchange: Exchange, symbol: string, interval: Interval): Promise<Candle[]> =>
      ipcRenderer.invoke(IpcChannel.MarketSubscribeCandles, exchange, symbol, interval),
    unsubscribeCandles: (): Promise<void> => ipcRenderer.invoke(IpcChannel.MarketUnsubscribeCandles),
    onCandleUpdate: (listener: (candle: Candle) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, candle: Candle): void => listener(candle)
      ipcRenderer.on(IpcChannel.MarketCandleUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.MarketCandleUpdate, handler)
    },
    subscribeTicker: (exchange: Exchange, symbol: string): Promise<Ticker24h> =>
      ipcRenderer.invoke(IpcChannel.MarketSubscribeTicker, exchange, symbol),
    unsubscribeTicker: (): Promise<void> => ipcRenderer.invoke(IpcChannel.MarketUnsubscribeTicker),
    onTickerUpdate: (listener: (ticker: Ticker24h) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, ticker: Ticker24h): void => listener(ticker)
      ipcRenderer.on(IpcChannel.MarketTickerUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.MarketTickerUpdate, handler)
    },
    // Live prices (the second V3 document, §7): the best bid and ask and the minute forming, for the
    // pairs shown and the app's own paper trades. Public market data from the data host only.
    setLiveInterest: (symbols: string[]): Promise<void> => ipcRenderer.invoke(IpcChannel.MarketLiveInterest, symbols),
    liveState: (): Promise<LiveState> => ipcRenderer.invoke(IpcChannel.MarketLiveState),
    liveBook: (symbol: string): Promise<LiveBook | null> => ipcRenderer.invoke(IpcChannel.MarketLiveBook, symbol),
    onLiveUpdate: (listener: (state: LiveState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: LiveState): void => listener(state)
      ipcRenderer.on(IpcChannel.MarketLiveUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.MarketLiveUpdate, handler)
    },
    fetchHistoricalRange: (
      exchange: Exchange,
      symbol: string,
      interval: Interval,
      startSec: number,
      endSec: number,
      requestId?: string
    ): Promise<HistoricalRangeResult> =>
      ipcRenderer.invoke(IpcChannel.MarketFetchHistoricalRange, exchange, symbol, interval, startSec, endSec, requestId),
    cancelHistoricalRange: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.MarketCancelHistoricalRange, requestId),
    onHistoricalRangeProgress: (listener: (progress: HistoricalRangeProgress) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: HistoricalRangeProgress): void => listener(progress)
      ipcRenderer.on(IpcChannel.MarketHistoricalRangeProgress, handler)
      return () => ipcRenderer.removeListener(IpcChannel.MarketHistoricalRangeProgress, handler)
    },
    fetchTicker24h: (exchange: Exchange, symbol: string): Promise<Ticker24h> =>
      ipcRenderer.invoke(IpcChannel.MarketFetchTicker24h, exchange, symbol),
    symbolRules: (exchange: Exchange, symbol: string): Promise<SymbolTradingRules> =>
      ipcRenderer.invoke(IpcChannel.MarketSymbolRules, exchange, symbol),
    // Binance's and Bitget's quote of one pair side by side (V7.1 Stage 6): public data, read once.
    compare: (symbol: string): Promise<MarketComparison> => ipcRenderer.invoke(IpcChannel.MarketCompare, symbol)
  },
  // The market scanner. Everything here reads public market data or a file the scanner wrote:
  // none of it reaches a model, a key or an order.
  scanner: {
    getState: (): Promise<ScannerState> => ipcRenderer.invoke(IpcChannel.ScannerGetState),
    setConfig: (patch: ScannerConfigPatch): Promise<ScannerState> => ipcRenderer.invoke(IpcChannel.ScannerSetConfig, patch),
    listEvents: (filter: MarketEventFilter = {}): Promise<MarketEventPage> =>
      ipcRenderer.invoke(IpcChannel.ScannerListEvents, filter),
    scanHistory: (request: ScanHistoryRequest): Promise<ScanHistoryResult> =>
      ipcRenderer.invoke(IpcChannel.ScannerScanHistory, request),
    cancelHistory: (requestId: string): Promise<void> => ipcRenderer.invoke(IpcChannel.ScannerCancelHistory, requestId),
    pickUniverse: (size: number): Promise<(SymbolInfo & { quoteVolume24h: number })[]> =>
      ipcRenderer.invoke(IpcChannel.ScannerPickUniverse, size),
    onUpdate: (listener: (state: ScannerState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: ScannerState): void => listener(state)
      ipcRenderer.on(IpcChannel.ScannerUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.ScannerUpdate, handler)
    },
    onHistoryProgress: (listener: (progress: ScanHistoryProgress) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: ScanHistoryProgress): void => listener(progress)
      ipcRenderer.on(IpcChannel.ScannerHistoryProgress, handler)
      return () => ipcRenderer.removeListener(IpcChannel.ScannerHistoryProgress, handler)
    }
  },
  // The news feed: four free media feeds and Binance's announcements, as stories, with what the price
  // did around each. Public data; a link opens only on the feeds' own hosts. `history` reads the
  // stories on file over a span, for measuring what news did.
  feed: {
    getState: (): Promise<NewsFeedState> => ipcRenderer.invoke(IpcChannel.FeedGetState),
    openLink: (url: string): Promise<boolean> => ipcRenderer.invoke(IpcChannel.FeedOpenLink, url),
    history: (fromSec: number, toSec: number): Promise<StoryMark[]> => ipcRenderer.invoke(IpcChannel.FeedHistory, fromSec, toSec),
    onUpdate: (listener: (state: NewsFeedState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: NewsFeedState): void => listener(state)
      ipcRenderer.on(IpcChannel.FeedUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.FeedUpdate, handler)
    }
  },
  // The price forecast (the V6 document): what it stands at, every pair's latest forecast, one pair's,
  // and a pair's record of forecasts and outcomes. Made from public market data; these only read it.
  // `onUpdate` is told the close of each pass, and the window asks for what it shows.
  forecast: {
    getState: (): Promise<ForecastState> => ipcRenderer.invoke(IpcChannel.ForecastGetState),
    list: (): Promise<PricePrediction[]> => ipcRenderer.invoke(IpcChannel.ForecastList),
    get: (symbol: string): Promise<PricePrediction | null> => ipcRenderer.invoke(IpcChannel.ForecastGet, symbol),
    history: (symbol: string, fromSec: number): Promise<ForecastHistory> => ipcRenderer.invoke(IpcChannel.ForecastHistory, symbol, fromSec),
    ranking: (): Promise<ForecastRankingView> => ipcRenderer.invoke(IpcChannel.ForecastRanking),
    decision: (symbol: string): Promise<TradeDecision | null> => ipcRenderer.invoke(IpcChannel.ForecastDecision, symbol),
    lab: (): Promise<ForecastLabView> => ipcRenderer.invoke(IpcChannel.ForecastLab),
    replay: (pair: string, t: number): Promise<ForecastReplay | null> => ipcRenderer.invoke(IpcChannel.ForecastReplay, pair, t),
    bars: (pair: string, width: '15m' | '1h' | '4h', fromSec: number, toSec: number): Promise<Candle[]> => ipcRenderer.invoke(IpcChannel.ForecastBars, pair, width, fromSec, toSec),
    /** Every pair's forecasts made in a span, and their outcomes on file: what a run's report judges. */
    record: (fromSec: number, toSec: number): Promise<ForecastHistory> => ipcRenderer.invoke(IpcChannel.ForecastRecord, fromSec, toSec),
    onUpdate: (listener: (closedAt: number | null) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, closedAt: number | null): void => listener(closedAt)
      ipcRenderer.on(IpcChannel.ForecastUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.ForecastUpdate, handler)
    }
  },
  // The market research done at launch and every ten minutes: public market data and CoinGecko's
  // free trending list. It reaches no model, key or order.
  research: {
    getState: (): Promise<ResearchState> => ipcRenderer.invoke(IpcChannel.ResearchGetState),
    refresh: (): Promise<ResearchState> => ipcRenderer.invoke(IpcChannel.ResearchRefresh),
    onUpdate: (listener: (state: ResearchState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: ResearchState): void => listener(state)
      ipcRenderer.on(IpcChannel.ResearchUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.ResearchUpdate, handler)
    }
  },
  // Binance's announcements. Everything here reads its public list or the file the reader wrote:
  // none of it reaches a model, a key or an order.
  news: {
    getState: (): Promise<NewsState> => ipcRenderer.invoke(IpcChannel.NewsGetState),
    setConfig: (patch: NewsConfigPatch): Promise<NewsState> => ipcRenderer.invoke(IpcChannel.NewsSetConfig, patch),
    list: (filter: NewsFilter = {}): Promise<NewsPage> => ipcRenderer.invoke(IpcChannel.NewsList, filter),
    record: (): Promise<NewsRecord> => ipcRenderer.invoke(IpcChannel.NewsRecord),
    onUpdate: (listener: (state: NewsState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: NewsState): void => listener(state)
      ipcRenderer.on(IpcChannel.NewsUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.NewsUpdate, handler)
    }
  },
  credentials: {
    list: (): Promise<CredentialStatus[]> => ipcRenderer.invoke(IpcChannel.CredentialsList),
    set: (exchange: Exchange, apiKey: string, apiSecret: string): Promise<CredentialStatus> =>
      ipcRenderer.invoke(IpcChannel.CredentialsSet, exchange, apiKey, apiSecret),
    test: (exchange: Exchange): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IpcChannel.CredentialsTest, exchange),
    remove: (exchange: Exchange): Promise<void> => ipcRenderer.invoke(IpcChannel.CredentialsRemove, exchange),
    balances: (exchange: Exchange, force = false): Promise<LiveBalanceSnapshot> =>
      ipcRenderer.invoke(IpcChannel.CredentialsBalances, exchange, force),
    futuresPositions: (exchange: Exchange): Promise<FuturesReadout> =>
      ipcRenderer.invoke(IpcChannel.CredentialsFuturesPositions, exchange),
    closeFuturesPosition: (exchange: Exchange, symbol: string): Promise<FuturesCloseResult> =>
      ipcRenderer.invoke(IpcChannel.CredentialsCloseFuturesPosition, exchange, symbol),
    futuresStops: (exchange: Exchange): Promise<ProtectiveStop[]> =>
      ipcRenderer.invoke(IpcChannel.CredentialsFuturesStops, exchange),
    placeFuturesStop: (exchange: Exchange, symbol: string, stopPrice: number): Promise<ProtectiveStop> =>
      ipcRenderer.invoke(IpcChannel.CredentialsPlaceFuturesStop, exchange, symbol, stopPrice),
    cancelFuturesStop: (exchange: Exchange, symbol: string, orderId: number): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.CredentialsCancelFuturesStop, exchange, symbol, orderId)
  },
  ai: {
    credentialsStatus: (): Promise<AiCredentialStatus> => ipcRenderer.invoke(IpcChannel.AiCredentialsStatus),
    setCredentials: (apiKey: string): Promise<AiCredentialStatus> =>
      ipcRenderer.invoke(IpcChannel.AiCredentialsSet, apiKey),
    testCredentials: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IpcChannel.AiCredentialsTest),
    removeCredentials: (): Promise<void> => ipcRenderer.invoke(IpcChannel.AiCredentialsRemove),
    estimateSignalTape: (request: AiSignalTapeRequest): Promise<AiSignalEstimate> =>
      ipcRenderer.invoke(IpcChannel.AiEstimateSignalTape, request),
    generateSignalTape: (request: AiSignalTapeRequest): Promise<AiSignalTape> =>
      ipcRenderer.invoke(IpcChannel.AiGenerateSignalTape, request),
    cancelSignalTape: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.AiCancelSignalTape, requestId),
    onSignalProgress: (listener: (progress: AiSignalProgress) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: AiSignalProgress): void => listener(progress)
      ipcRenderer.on(IpcChannel.AiSignalProgress, handler)
      return () => ipcRenderer.removeListener(IpcChannel.AiSignalProgress, handler)
    },
    // Everything below is free to call: none of it reaches a model.
    keyInfo: (): Promise<AiKeyInfo> => ipcRenderer.invoke(IpcChannel.AiKeyInfo),
    listModels: (refresh = false): Promise<AiModelCatalogue> => ipcRenderer.invoke(IpcChannel.AiListModels, refresh),
    getConfig: (): Promise<AiConfig> => ipcRenderer.invoke(IpcChannel.AiGetConfig),
    setConfig: (patch: AiConfigPatch): Promise<AiConfig> => ipcRenderer.invoke(IpcChannel.AiSetConfig, patch),
    listCalls: (filter: AiCallFilter = {}): Promise<AiCallPage> => ipcRenderer.invoke(IpcChannel.AiListCalls, filter),
    usageSummary: (): Promise<AiUsageSummary> => ipcRenderer.invoke(IpcChannel.AiUsageSummary),
    peekEntryConfirmation: (request: AiEntryConfirmRequest): Promise<AiEntryPeek> =>
      ipcRenderer.invoke(IpcChannel.AiPeekEntryConfirmation, request),
    peekBenchmark: (request: AiBenchmarkPeekRequest): Promise<AiBenchmarkPeek> =>
      ipcRenderer.invoke(IpcChannel.AiPeekBenchmark, request),
    peekOpportunity: (request: AiOpportunityPeekRequest): Promise<AiOpportunityPeek> =>
      ipcRenderer.invoke(IpcChannel.AiPeekOpportunity, request),
    // Benchmark runs kept as runs (shared/aiExperiment.ts). Recording one writes down what a run
    // that has already ended asked; it asks nothing itself.
    listExperiments: (): Promise<AiExperimentPage> => ipcRenderer.invoke(IpcChannel.AiListExperiments),
    getExperiment: (id: string): Promise<AiExperiment | null> => ipcRenderer.invoke(IpcChannel.AiGetExperiment, id),
    recordExperiment: (input: AiExperimentInput): Promise<AiExperiment> =>
      ipcRenderer.invoke(IpcChannel.AiRecordExperiment, input),
    // Free: the additions' switches, what they have asked today and what a call costs.
    additionsStatus: (): Promise<AiAdditionsStatus> => ipcRenderer.invoke(IpcChannel.AiAdditionsStatus),
    // Billed unless held: one conclusion to "Why did it move?", asked from a click at the price shown.
    concludeMove: (symbol: string): Promise<MoveConclusion> => ipcRenderer.invoke(IpcChannel.AiConcludeMove, symbol),
    // Billed unless held, and only when something about the trade stands out: the reviewer's second
    // look before one of the watch's paper trades. REJECT means no trade.
    reviewTrade: (request: { event: MarketEvent; decision: AiSignalDecision }): Promise<TradeReview> => ipcRenderer.invoke(IpcChannel.AiReviewTrade, request),
    // Billed unless held, and only when something about one of the app's own open paper trades has
    // changed that it has not been asked about: the exit check. Its EXIT is written by the renderer,
    // on paper; this only asks.
    exitCheck: (request: ExitCheckRequest): Promise<ExitCheck> => ipcRenderer.invoke(IpcChannel.AiExitCheck, request),
    // Billed unless held, once a day: the fifth addition's paragraph about one UTC day's report
    // (shared/dailyReport.ts), by itself after 00:05 UTC while the watch is on, or on a click.
    summarizeDay: (request: DailySummaryRequest, automatic: boolean): Promise<DailySummary> => ipcRenderer.invoke(IpcChannel.AiSummarizeDay, request, automatic),
    // The two calls below the "free" line that are not free: each is billed unless its answer is
    // already cached.
    confirmEntry: (request: AiEntryConfirmRequest): Promise<AiSignalDecision> =>
      ipcRenderer.invoke(IpcChannel.AiConfirmEntry, request),
    askOpportunity: (request: AiOpportunityAskRequest): Promise<AiSignalDecision> =>
      ipcRenderer.invoke(IpcChannel.AiAskOpportunity, request)
  },
  liveTrading: {
    getStatus: (): Promise<LiveTradingStatus> => ipcRenderer.invoke(IpcChannel.LiveTradingGetStatus),
    setConfig: (patch: { maxOrderQuote?: number; dailyCapQuote?: number; dailyLossLimitQuote?: number; allocationQuote?: number | null; riskPct?: number }): Promise<LiveTradingStatus> =>
      ipcRenderer.invoke(IpcChannel.LiveTradingSetConfig, patch),
    engageKillSwitch: (): Promise<LiveTradingStatus> => ipcRenderer.invoke(IpcChannel.LiveTradingEngageKillSwitch),
    releaseKillSwitch: (): Promise<LiveTradingStatus> => ipcRenderer.invoke(IpcChannel.LiveTradingReleaseKillSwitch),
    setSessionArmed: (armed: boolean): Promise<LiveTradingStatus> =>
      ipcRenderer.invoke(IpcChannel.LiveTradingSetSessionArmed, armed),
    listPositions: (): Promise<LivePosition[]> => ipcRenderer.invoke(IpcChannel.LiveTradingListPositions),
    listClosedPositions: (): Promise<LivePosition[]> => ipcRenderer.invoke(IpcChannel.LiveTradingListClosedPositions),
    closePosition: (positionId: string, quantity: number): Promise<LiveOrderRecord> =>
      ipcRenderer.invoke(IpcChannel.LiveTradingClosePosition, positionId, quantity),
    pollOpenOrders: (): Promise<
      { executorId: string; liveOrderId: string; liveOrder: LiveOrderRecord; status: 'filled' | 'cancelled' | 'expired' }[]
    > => ipcRenderer.invoke(IpcChannel.LiveTradingPollOpenOrders),
    userStream: (): Promise<UserStreamState> => ipcRenderer.invoke(IpcChannel.LiveTradingUserStream),
    reconciliation: (): Promise<ReconciliationReadout> => ipcRenderer.invoke(IpcChannel.LiveTradingReconciliation),
    cancelOrder: (liveOrderId: string): Promise<LiveOrderRecord> =>
      ipcRenderer.invoke(IpcChannel.LiveTradingCancelOrder, liveOrderId),
    createWatcher: (
      executorId: string,
      exchange: Exchange,
      symbol: string,
      entryPrice: number,
      takeProfitPct: number | null,
      stopLossPct: number | null,
      timeLimitSec: number | null,
      trailingStop: { activationPct: number; trailPct: number } | null
    ): Promise<{ id: string }> =>
      ipcRenderer.invoke(
        IpcChannel.LiveTradingCreateWatcher,
        executorId,
        exchange,
        symbol,
        entryPrice,
        takeProfitPct,
        stopLossPct,
        timeLimitSec,
        trailingStop
      ),
    listActiveWatchers: (): Promise<LiveWatcherSummary[]> => ipcRenderer.invoke(IpcChannel.LiveTradingListActiveWatchers),
    updateWatcherEntryPrice: (watcherId: string, entryPrice: number): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.LiveTradingUpdateWatcherEntryPrice, watcherId, entryPrice),
    stopWatcher: (watcherId: string): Promise<LiveExitResult | null> => ipcRenderer.invoke(IpcChannel.LiveTradingStopWatcher, watcherId),
    drainWatcherEvents: (): Promise<{ executorId: string; liveExitResult: LiveExitResult }[]> =>
      ipcRenderer.invoke(IpcChannel.LiveTradingDrainWatcherEvents),
    createTwapRun: (
      executorId: string,
      exchange: Exchange,
      symbol: string,
      baseAsset: string,
      quoteAsset: string,
      side: 'buy' | 'sell',
      amountPerOrder: number,
      numOrders: number,
      orderIntervalSec: number
    ): Promise<{ id: string }> =>
      ipcRenderer.invoke(
        IpcChannel.LiveTradingCreateTwapRun,
        executorId,
        exchange,
        symbol,
        baseAsset,
        quoteAsset,
        side,
        amountPerOrder,
        numOrders,
        orderIntervalSec
      ),
    listActiveTwapRuns: (): Promise<LiveTwapRunSummary[]> => ipcRenderer.invoke(IpcChannel.LiveTradingListActiveTwapRuns),
    stopTwapRun: (runId: string): Promise<LiveTwapResolution | null> => ipcRenderer.invoke(IpcChannel.LiveTradingStopTwapRun, runId),
    drainTwapEvents: (): Promise<LiveTwapResolution[]> => ipcRenderer.invoke(IpcChannel.LiveTradingDrainTwapEvents)
  },
  executors: {
    placeLiveOrder: (
      exchange: Exchange,
      symbol: string,
      baseAsset: string,
      quoteAsset: string,
      side: 'buy' | 'sell',
      quoteAmount: number
    ): Promise<LiveOrderRecord> =>
      ipcRenderer.invoke(IpcChannel.ExecutorPlaceLiveOrder, exchange, symbol, baseAsset, quoteAsset, side, quoteAmount),
    placeLiveLimitOrder: (
      executorId: string,
      exchange: Exchange,
      symbol: string,
      baseAsset: string,
      quoteAsset: string,
      side: 'buy' | 'sell',
      amountQuote: number,
      limitPrice: number
    ): Promise<{ resolved: true; liveOrder: LiveOrderRecord } | { resolved: false; pendingLiveOrderId: string }> =>
      ipcRenderer.invoke(
        IpcChannel.ExecutorPlaceLiveLimitOrder,
        executorId,
        exchange,
        symbol,
        baseAsset,
        quoteAsset,
        side,
        amountQuote,
        limitPrice
      )
  },
  backtest: {
    exportSave: (request: BacktestExportRequest): Promise<BacktestExportResult> =>
      ipcRenderer.invoke(IpcChannel.BacktestExportSave, request)
  },
  /** Exchange health (shared/exchangeHealth.ts): the data host's latency and the clock, the stream
   * and the key, measured once a minute in the main process; read, and pushed as measured. */
  health: {
    state: (): Promise<HealthState> => ipcRenderer.invoke(IpcChannel.HealthState),
    onUpdate: (listener: (state: HealthState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: HealthState): void => listener(state)
      ipcRenderer.on(IpcChannel.HealthUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.HealthUpdate, handler)
    }
  },
  /** The records on file (shared/records.ts): the app's own paper trades refused, and the alerts
   * told, each written as it happens and read back by span. Records; nothing acts on them. */
  // The runs the app keeps of itself (shared/experimentRun.ts): a record and a clock in the main
  // process, the report built by the window at the end and filed through `report`. Nothing here
  // asks a model or trades.
  experiments: {
    start: (input: { kind: ExperimentKind; minutes?: number | null }): Promise<ExperimentRun> => ipcRenderer.invoke(IpcChannel.ExperimentStart, input),
    list: (): Promise<{ rows: ExperimentRun[]; skippedLines: number }> => ipcRenderer.invoke(IpcChannel.ExperimentList),
    stop: (id: string): Promise<ExperimentRun | null> => ipcRenderer.invoke(IpcChannel.ExperimentStop, id),
    report: (id: string, report: ExperimentReport): Promise<ExperimentRun | null> => ipcRenderer.invoke(IpcChannel.ExperimentReport, id, report),
    onUpdate: (listener: (run: ExperimentRun) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, run: ExperimentRun): void => listener(run)
      ipcRenderer.on(IpcChannel.ExperimentUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.ExperimentUpdate, handler)
    }
  },
  records: {
    refusal: (record: PaperRefusalRecord): Promise<PaperRefusalRecord | null> => ipcRenderer.invoke(IpcChannel.RecordsRefusal, record),
    refusals: (filter: RecordFilter): Promise<{ rows: PaperRefusalRecord[]; skippedLines: number }> => ipcRenderer.invoke(IpcChannel.RecordsRefusals, filter),
    alert: (record: AlertRecordOnFile): Promise<AlertRecordOnFile | null> => ipcRenderer.invoke(IpcChannel.RecordsAlert, record),
    alerts: (filter: RecordFilter): Promise<{ rows: AlertRecordOnFile[]; skippedLines: number }> => ipcRenderer.invoke(IpcChannel.RecordsAlerts, filter),
    /** Each notice as it is told, whatever raised it and whatever the desktop could show. */
    onTold: (listener: (record: AlertRecordOnFile) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, record: AlertRecordOnFile): void => listener(record)
      ipcRenderer.on(IpcChannel.AlertsTold, handler)
      return () => ipcRenderer.removeListener(IpcChannel.AlertsTold, handler)
    }
  }
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error(error)
}

export type Api = typeof api
