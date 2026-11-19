import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { FuturesCloseResult, FuturesReadout } from '../shared/futuresPositions'
import type { ProtectiveStop } from '../shared/futuresStops'
import type { PricePrediction } from '../shared/forecast/prediction'
import type { BtcTodayView } from '../shared/forecast/btcDay'
import type { RoleChoice, RoutingPreview } from '../shared/aiRouting'
import type { ResearchExport, ResearchStatus } from '../shared/research'
import type { TradeDecision } from '../shared/forecast/tradeDecision'
import type { RoundTrip } from '../shared/venueCosts'
import type { SourceFiguresRow, SourceOutcome, SourcePrediction } from '../shared/evaluation/predictionRecord'
import type { BookEquityMark, BookId, BookStanding } from '../shared/paperBooks'
import type { MissRecord } from '../shared/misses'
import type { PaperTestingState } from '../shared/paperTesting'
import type { BooksReport } from '../shared/paperBooksReport'
import type { PrimaryCallState } from '../shared/forecast/primaryCall'
import type { UrlRecord } from '../shared/newsUrl'
import type { BitgetCopyCheck, TraderAnalysis, TraderList, TraderMeta, TraderProgress } from '../shared/traders/traderAnalysis'
import type { CopyTradingSettings } from '../shared/traders/copyTrading'
import type { ExecutorConfig as BookExecutor } from '../shared/ipc'
import type { FundingRate } from '../shared/traders/delay'
import type { CloneSignal, FollowStatus, LeaderEvent } from '../shared/traders/follow'
import type { DiscoveryState } from '../shared/traders/discovery'
import type { ForecastLabView, ForecastReplay } from '../shared/forecast/labView'
import type { AccuracyBoard } from '../shared/evaluation/accuracyBoard'
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
import type { AiAdditionsStatus, ArticleReadingResult, DailySummary, DailySummaryRequest, ExitCheck, ExitCheckRequest, MoveConclusion, TradeReview } from '../shared/aiAdditions'
import type { MarketEvent } from '../shared/marketEvent'
import type { NewsConfigPatch, NewsFilter, NewsPage, NewsState } from '../shared/news'
import type { NewsRecord } from '../shared/newsRecord'
import {
  IpcChannel,
  type AppSettings,
  type Candle,
  type CredentialSetOptions,
  type CredentialSlot,
  type CredentialStatus,
  type Exchange,
  type ForecastHistory,
  type ForecastReplayState,
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
    /** A pair's round trip now on Binance and Bitget, from their public books at the reference stake (V7.2-R Stage 4),
     * for a buy or a sell (V8 Stage 3). */
    venueCosts: (symbol: string, side: 'BUY' | 'SELL' = 'BUY'): Promise<{ trips: RoundTrip[]; cheapest: RoundTrip | null; at: number } | null> =>
      ipcRenderer.invoke(IpcChannel.ForecastVenueCosts, symbol, side),
    lab: (): Promise<ForecastLabView> => ipcRenderer.invoke(IpcChannel.ForecastLab),
    replay: (pair: string, t: number): Promise<ForecastReplay | null> => ipcRenderer.invoke(IpcChannel.ForecastReplay, pair, t),
    /** The replay out of sample of the newest walk forward that kept its weeks' models (V7.2-R Stage 5). */
    outOfSample: (): Promise<ForecastReplayState> => ipcRenderer.invoke(IpcChannel.ForecastOutOfSample),
    /** The run before the one in use put back in use (V7.1 Stage 13): models and verdicts, nothing else. */
    rollback: (): Promise<{ ok: boolean; error: string | null }> => ipcRenderer.invoke(IpcChannel.ForecastRollback),
    bars: (pair: string, width: '15m' | '1h' | '4h', fromSec: number, toSec: number): Promise<Candle[]> => ipcRenderer.invoke(IpcChannel.ForecastBars, pair, width, fromSec, toSec),
    /** Each pair's share of days that closed 5% and 10% away over its ninety days (V8 Stage 10). */
    dayMoves: (): Promise<{ at: number; sizes: readonly number[]; rows: { pair: string; moments: number; rates: Record<number, number> }[] }> => ipcRenderer.invoke(IpcChannel.ForecastDayMoves),
    /** Bitcoin's day so far and its big days over the last 90, for Home (V9 Stage 1). */
    btcToday: (): Promise<BtcTodayView> => ipcRenderer.invoke(IpcChannel.ForecastBtcToday),
    /** Every pair's forecasts made in a span, and their outcomes on file: what a run's report judges. */
    record: (fromSec: number, toSec: number): Promise<ForecastHistory> => ipcRenderer.invoke(IpcChannel.ForecastRecord, fromSec, toSec),
    /** The accuracy board (V10 Stage 2): way, size and range of the settled forecasts, by day and horizon. */
    board: (): Promise<AccuracyBoard> => ipcRenderer.invoke(IpcChannel.ForecastBoard),
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
    // A key's passphrase and its slot (real or demo) since V7.1 Stage 7: both optional, a demo slot
    // only on an exchange with a demo account of its own.
    set: (exchange: Exchange, apiKey: string, apiSecret: string, options: CredentialSetOptions = {}): Promise<CredentialStatus> =>
      ipcRenderer.invoke(IpcChannel.CredentialsSet, exchange, apiKey, apiSecret, options),
    test: (exchange: Exchange, slot: CredentialSlot = 'real'): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IpcChannel.CredentialsTest, exchange, slot),
    remove: (exchange: Exchange, slot: CredentialSlot = 'real'): Promise<void> => ipcRenderer.invoke(IpcChannel.CredentialsRemove, exchange, slot),
    balances: (exchange: Exchange, force = false, slot: CredentialSlot = 'real'): Promise<LiveBalanceSnapshot> =>
      ipcRenderer.invoke(IpcChannel.CredentialsBalances, exchange, force, slot),
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
    // Free: who asks which model, and what a move to these roles would change and cost (V7.2-R Stage 1).
    routingPreview: (choice: RoleChoice): Promise<RoutingPreview> => ipcRenderer.invoke(IpcChannel.AiRoutingPreview, choice),
    // Changes what asks by itself -- the watch, its paper trades, the additions, running paid bots -- and only
    // with the token of the preview its confirmation was written from.
    routingApply: (request: { choice: RoleChoice; token: string }): Promise<{ config: AiConfig; movedBots: { id: string; name: string; from: string; to: string }[] }> =>
      ipcRenderer.invoke(IpcChannel.AiRoutingApply, request),
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
    // Billed unless held, and only on a click on News URLs at the price shown: the article reading of a news link on
    // file (V8 Stage 5), at most twenty a day. Its record is read in the main process by its id; nothing is handed in.
    readArticle: (id: string): Promise<ArticleReadingResult> => ipcRenderer.invoke(IpcChannel.AiReadArticle, id),
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
  // The demo book (V7.1 Stage 8): an exchange's demo account over its demo key, in ledgers of its
  // own, with no live gate -- play money. A bridge of its own, so that the paper laboratory, allowed
  // this one, is held off the real one by test (tests/aiNoLivePath.test.ts).
  demoTrading: {
    placeOrder: (exchange: Exchange, symbol: string, baseAsset: string, quoteAsset: string, side: 'buy' | 'sell', quoteAmount: number): Promise<LiveOrderRecord> =>
      ipcRenderer.invoke(IpcChannel.DemoTradingPlaceOrder, exchange, symbol, baseAsset, quoteAsset, side, quoteAmount),
    placeLimitOrder: (
      executorId: string,
      exchange: Exchange,
      symbol: string,
      baseAsset: string,
      quoteAsset: string,
      side: 'buy' | 'sell',
      amountQuote: number,
      limitPrice: number
    ): Promise<{ resolved: true; liveOrder: LiveOrderRecord } | { resolved: false; pendingLiveOrderId: string }> =>
      ipcRenderer.invoke(IpcChannel.DemoTradingPlaceLimitOrder, executorId, exchange, symbol, baseAsset, quoteAsset, side, amountQuote, limitPrice),
    closePosition: (positionId: string, quantity: number): Promise<LiveOrderRecord> => ipcRenderer.invoke(IpcChannel.DemoTradingClosePosition, positionId, quantity),
    cancelOrder: (liveOrderId: string): Promise<LiveOrderRecord> => ipcRenderer.invoke(IpcChannel.DemoTradingCancelOrder, liveOrderId),
    listPositions: (): Promise<LivePosition[]> => ipcRenderer.invoke(IpcChannel.DemoTradingListPositions),
    listClosedPositions: (): Promise<LivePosition[]> => ipcRenderer.invoke(IpcChannel.DemoTradingListClosedPositions),
    reconciliation: (): Promise<ReconciliationReadout> => ipcRenderer.invoke(IpcChannel.DemoTradingReconciliation),
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
      ipcRenderer.invoke(IpcChannel.DemoTradingCreateWatcher, executorId, exchange, symbol, entryPrice, takeProfitPct, stopLossPct, timeLimitSec, trailingStop),
    listActiveWatchers: (): Promise<LiveWatcherSummary[]> => ipcRenderer.invoke(IpcChannel.DemoTradingListActiveWatchers),
    stopWatcher: (watcherId: string): Promise<LiveExitResult | null> => ipcRenderer.invoke(IpcChannel.DemoTradingStopWatcher, watcherId),
    poll: (): Promise<{
      orderResolutions: { executorId: string; liveOrderId: string; liveOrder: LiveOrderRecord; status: 'filled' | 'cancelled' | 'expired' }[]
      watcherEvents: { executorId: string; liveExitResult: LiveExitResult }[]
    }> => ipcRenderer.invoke(IpcChannel.DemoTradingPoll)
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
  // The record of predictions that are not the forecast's own (V8 Stage 2): a person's own call recorded, the
  // record read with each one's outcome. Nothing here reads a key or places anything.
  predictions: {
    record: (prediction: SourcePrediction): Promise<{ ok: boolean; id: string }> => ipcRenderer.invoke(IpcChannel.PredictionsRecord, prediction),
    list: (filter: { source?: string; sinceSec?: number } = {}): Promise<{ prediction: SourcePrediction; outcome: SourceOutcome | null }[]> => ipcRenderer.invoke(IpcChannel.PredictionsList, filter),
    /** The record's figures a source and kind (V8 Stage 10). */
    figures: (): Promise<SourceFiguresRow[]> => ipcRenderer.invoke(IpcChannel.PredictionsFigures)
  },
  // The primary call (V8 Stage 3): the cards weighed, the delisted coins past the rule's window and the refusals, as
  // last weighed; `onUpdate` is told each weighing. Reading it records, opens and places nothing.
  calls: {
    state: (): Promise<PrimaryCallState> => ipcRenderer.invoke(IpcChannel.CallsState),
    onUpdate: (listener: (state: PrimaryCallState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: PrimaryCallState): void => listener(state)
      ipcRenderer.on(IpcChannel.CallsUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.CallsUpdate, handler)
    }
  },
  // News URLs (V8 Stage 4): a pasted link read and kept -- with text a person supplies where its page cannot be read --
  // the links on file, a person's own view linked to one, and each record as it changes. Nothing here places anything.
  urls: {
    analyze: (raw: string, supplied: string | null = null): Promise<UrlRecord | { refused: string }> => ipcRenderer.invoke(IpcChannel.UrlsAnalyze, raw, supplied),
    list: (): Promise<UrlRecord[]> => ipcRenderer.invoke(IpcChannel.UrlsList),
    link: (id: string, link: { predictionId?: string; executorId?: string }): Promise<UrlRecord | null> => ipcRenderer.invoke(IpcChannel.UrlsLink, id, link),
    onUpdate: (listener: (record: UrlRecord) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, record: UrlRecord): void => listener(record)
      ipcRenderer.on(IpcChannel.UrlsUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.UrlsUpdate, handler)
    }
  },
  // Copy Traders (V8 Stages 6-7): a pasted trader read from its venue and kept, a file of trades chosen in the main
  // process's dialog, analysed, the traders on file, each step as it goes; and the read-only Bitget copy-trading check,
  // asked only from its button. Nothing here follows or places anything.
  traders: {
    import: (raw: string): Promise<TraderMeta | { refused: string }> => ipcRenderer.invoke(IpcChannel.TradersImport, raw),
    importFile: (): Promise<TraderMeta | { refused: string } | { canceled: true }> => ipcRenderer.invoke(IpcChannel.TradersImportFile),
    analyze: (key: string): Promise<TraderAnalysis> => ipcRenderer.invoke(IpcChannel.TradersAnalyze, key),
    list: (): Promise<TraderList> => ipcRenderer.invoke(IpcChannel.TradersList),
    bitgetCheck: (): Promise<BitgetCopyCheck> => ipcRenderer.invoke(IpcChannel.TradersBitgetCheck),
    follow: (key: string, on: boolean): Promise<FollowStatus[]> => ipcRenderer.invoke(IpcChannel.TradersFollow, { key, on }),
    clone: (key: string, on: boolean): Promise<CopyTradingSettings['clones']> => ipcRenderer.invoke(IpcChannel.TradersClone, { key, on }),
    followStatus: (): Promise<FollowStatus[]> => ipcRenderer.invoke(IpcChannel.TradersFollowStatus),
    followRecords: (sinceMs: number): Promise<{ events: LeaderEvent[]; signals: CloneSignal[] }> => ipcRenderer.invoke(IpcChannel.TradersFollowRecords, sinceMs),
    perpPrice: (venue: 'binance' | 'bitget', symbol: string): Promise<number> => ipcRenderer.invoke(IpcChannel.TradersPerpPrice, { venue, symbol }),
    perpFunding: (venue: 'binance' | 'bitget', symbol: string, fromSec: number, toSec: number): Promise<FundingRate[]> => ipcRenderer.invoke(IpcChannel.TradersPerpFunding, { venue, symbol, fromSec, toSec }),
    perpOf: (coin: string): Promise<{ venue: 'binance' | 'bitget'; symbol: string } | null> => ipcRenderer.invoke(IpcChannel.TradersPerpOf, coin),
    perpBook: (venue: 'binance' | 'bitget', symbol: string): Promise<{ bids: [number, number][]; asks: [number, number][]; atMs: number }> => ipcRenderer.invoke(IpcChannel.TradersPerpBook, { venue, symbol }),
    perpBars: (venue: 'binance' | 'bitget', symbol: string, fromSec: number, toSec: number): Promise<Candle[]> => ipcRenderer.invoke(IpcChannel.TradersPerpBars, { venue, symbol, fromSec, toSec }),
    onLeaderEvent: (listener: (event: LeaderEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, event: LeaderEvent): void => listener(event)
      ipcRenderer.on(IpcChannel.TradersLeaderEvent, handler)
      return () => ipcRenderer.removeListener(IpcChannel.TradersLeaderEvent, handler)
    },
    onCloneSignal: (listener: (signal: CloneSignal) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, signal: CloneSignal): void => listener(signal)
      ipcRenderer.on(IpcChannel.TradersCloneSignal, handler)
      return () => ipcRenderer.removeListener(IpcChannel.TradersCloneSignal, handler)
    },
    onFollowStatus: (listener: (statuses: FollowStatus[]) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, statuses: FollowStatus[]): void => listener(statuses)
      ipcRenderer.on(IpcChannel.TradersFollowStatusChanged, handler)
      return () => ipcRenderer.removeListener(IpcChannel.TradersFollowStatusChanged, handler)
    },
    onProgress: (listener: (progress: TraderProgress) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: TraderProgress): void => listener(progress)
      ipcRenderer.on(IpcChannel.TradersProgress, handler)
      return () => ipcRenderer.removeListener(IpcChannel.TradersProgress, handler)
    },
    /** The traders the app found (V9 Stage 3): what it found and analysed, and its switch. */
    discovery: (): Promise<DiscoveryState> => ipcRenderer.invoke(IpcChannel.TradersDiscovery),
    setDiscovery: (on: boolean): Promise<DiscoveryState> => ipcRenderer.invoke(IpcChannel.TradersDiscoverySet, on),
    onDiscovery: (listener: (state: DiscoveryState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: DiscoveryState): void => listener(state)
      ipcRenderer.on(IpcChannel.TradersDiscoveryChanged, handler)
      return () => ipcRenderer.removeListener(IpcChannel.TradersDiscoveryChanged, handler)
    }
  },
  // V8's three paper books (V8 Stage 2): each book's standing and equity marks, and the opportunities not taken.
  books: {
    state: (): Promise<{ running: boolean; startedAt: number | null; standings: BookStanding[] }> => ipcRenderer.invoke(IpcChannel.BooksState),
    marks: (book: BookId, startedAt: number): Promise<BookEquityMark[]> => ipcRenderer.invoke(IpcChannel.BooksMarks, { book, startedAt }),
    miss: (miss: MissRecord): Promise<MissRecord> => ipcRenderer.invoke(IpcChannel.BooksMiss, miss),
    misses: (sinceSec = 0): Promise<MissRecord[]> => ipcRenderer.invoke(IpcChannel.BooksMisses, sinceSec),
    archive: (executors: BookExecutor[]): Promise<number> => ipcRenderer.invoke(IpcChannel.BooksArchive, executors),
    /** Binance's spot book now, for one of the baseline's eight symbols (V8 Stage 9). */
    spotBook: (symbol: string): Promise<{ bids: [number, number][]; asks: [number, number][]; atMs: number }> => ipcRenderer.invoke(IpcChannel.BooksSpotBook, symbol),
    /** Paper testing (V8 Stage 9): its state, its Start, its Stop. */
    testing: (): Promise<PaperTestingState> => ipcRenderer.invoke(IpcChannel.BooksTesting),
    start: (): Promise<PaperTestingState> => ipcRenderer.invoke(IpcChannel.BooksStart),
    stop: (): Promise<PaperTestingState> => ipcRenderer.invoke(IpcChannel.BooksStop),
    /** The run that runs or ran last, each book as V8-S9-BOOKS reads it (V8 Stage 10). */
    report: (): Promise<BooksReport> => ipcRenderer.invoke(IpcChannel.BooksReport)
  },
  // The research folder (V7.2-R Stage 2): free to read and to export; nothing here reads a key or places anything.
  researchFolder: {
    status: (): Promise<ResearchStatus> => ipcRenderer.invoke(IpcChannel.ResearchFolderStatus),
    exportNow: (): Promise<ResearchExport> => ipcRenderer.invoke(IpcChannel.ResearchFolderExport),
    open: (): Promise<{ ok: boolean; problem: string | null }> => ipcRenderer.invoke(IpcChannel.ResearchFolderOpen),
    writeReport: (request: { kind: 'hour' | 'day'; stamp: string; report: unknown }): Promise<{ ok: boolean; path: string }> =>
      ipcRenderer.invoke(IpcChannel.ResearchFolderWriteReport, request)
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

// Only the app's own bridges reach the window (V8 Stage 1): the toolkit's generic ipcRenderer, once exposed as
// window.electron and used by nothing, would let any script in the page invoke any channel by name.
try {
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error(error)
}

export type Api = typeof api
