import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IpcChannel,
  type AppSettings,
  type Candle,
  type CredentialStatus,
  type Exchange,
  type HistoricalRangeProgress,
  type HistoricalRangeResult,
  type Interval,
  type LiveExitResult,
  type LiveOrderRecord,
  type LivePosition,
  type LiveTradingStatus,
  type LiveWatcherSummary,
  type SymbolInfo,
  type Ticker24h
} from '../shared/ipc'

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke(IpcChannel.AppPing),
  getVersion: (): Promise<string> => ipcRenderer.invoke(IpcChannel.AppGetVersion),
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
      ipcRenderer.invoke(IpcChannel.MarketFetchTicker24h, exchange, symbol)
  },
  credentials: {
    list: (): Promise<CredentialStatus[]> => ipcRenderer.invoke(IpcChannel.CredentialsList),
    set: (exchange: Exchange, apiKey: string, apiSecret: string): Promise<CredentialStatus> =>
      ipcRenderer.invoke(IpcChannel.CredentialsSet, exchange, apiKey, apiSecret),
    test: (exchange: Exchange): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IpcChannel.CredentialsTest, exchange),
    remove: (exchange: Exchange): Promise<void> => ipcRenderer.invoke(IpcChannel.CredentialsRemove, exchange)
  },
  liveTrading: {
    getStatus: (): Promise<LiveTradingStatus> => ipcRenderer.invoke(IpcChannel.LiveTradingGetStatus),
    setConfig: (patch: { maxOrderQuote?: number; dailyCapQuote?: number; dailyLossLimitQuote?: number }): Promise<LiveTradingStatus> =>
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
      ipcRenderer.invoke(IpcChannel.LiveTradingDrainWatcherEvents)
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
  }
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error(error)
}

export type Api = typeof api
