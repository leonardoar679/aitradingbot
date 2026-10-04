import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { FuturesCloseResult, FuturesReadout } from '../shared/futuresPositions'
import type { ProtectiveStop } from '../shared/futuresStops'
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
import {
  IpcChannel,
  type AppSettings,
  type Candle,
  type CredentialStatus,
  type Exchange,
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
  type SymbolInfo,
  type Ticker24h
} from '../shared/ipc'

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke(IpcChannel.AppPing),
  getVersion: (): Promise<string> => ipcRenderer.invoke(IpcChannel.AppGetVersion),
  /** A desktop notice. Resolves false where the system cannot show one. */
  notify: (title: string, body: string): Promise<boolean> => ipcRenderer.invoke(IpcChannel.AppNotify, title, body),
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
      ipcRenderer.invoke(IpcChannel.MarketSymbolRules, exchange, symbol)
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
    // The two calls below the "free" line that are not free: each is billed unless its answer is
    // already cached.
    confirmEntry: (request: AiEntryConfirmRequest): Promise<AiSignalDecision> =>
      ipcRenderer.invoke(IpcChannel.AiConfirmEntry, request),
    askOpportunity: (request: AiOpportunityAskRequest): Promise<AiSignalDecision> =>
      ipcRenderer.invoke(IpcChannel.AiAskOpportunity, request)
  },
  liveTrading: {
    getStatus: (): Promise<LiveTradingStatus> => ipcRenderer.invoke(IpcChannel.LiveTradingGetStatus),
    setConfig: (patch: { maxOrderQuote?: number; dailyCapQuote?: number; dailyLossLimitQuote?: number; allocationQuote?: number | null }): Promise<LiveTradingStatus> =>
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
  }
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error(error)
}

export type Api = typeof api
