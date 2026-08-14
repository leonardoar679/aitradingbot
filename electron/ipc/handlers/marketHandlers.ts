import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  IpcChannel,
  type Candle,
  type Exchange,
  type HistoricalRangeResult,
  type Interval,
  type SymbolInfo,
  type Ticker24h
} from '../../../shared/ipc'
import {
  listSymbols,
  fetchHistoricalCandles,
  subscribeCandles,
  unsubscribeCandles,
  onCandleUpdate,
  fetchTicker24h,
  subscribeTicker,
  unsubscribeTicker,
  onTickerUpdate,
  fetchHistoricalRange,
  cancelHistoricalRangeFetch
} from '../../services/marketService'

export function registerMarketHandlers(mainWindow: BrowserWindow): void {
  const stopForwardingCandles = onCandleUpdate((candle) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.MarketCandleUpdate, candle)
    }
  })
  const stopForwardingTicker = onTickerUpdate((ticker) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.MarketTickerUpdate, ticker)
    }
  })
  mainWindow.on('closed', () => {
    stopForwardingCandles()
    stopForwardingTicker()
    unsubscribeCandles()
    unsubscribeTicker()
  })

  ipcMain.handle(
    IpcChannel.MarketListSymbols,
    (_event, exchange: Exchange): Promise<SymbolInfo[]> => listSymbols(exchange)
  )

  ipcMain.handle(
    IpcChannel.MarketSubscribeCandles,
    async (_event, exchange: Exchange, symbol: string, interval: Interval): Promise<Candle[]> => {
      const history = await fetchHistoricalCandles(exchange, symbol, interval)
      await subscribeCandles(exchange, symbol, interval)
      return history
    }
  )
  ipcMain.handle(IpcChannel.MarketUnsubscribeCandles, () => unsubscribeCandles())

  ipcMain.handle(
    IpcChannel.MarketSubscribeTicker,
    async (_event, exchange: Exchange, symbol: string): Promise<Ticker24h> => {
      const snapshot = await fetchTicker24h(exchange, symbol)
      await subscribeTicker(exchange, symbol)
      return snapshot
    }
  )
  ipcMain.handle(IpcChannel.MarketUnsubscribeTicker, () => unsubscribeTicker())

  // A one-off snapshot price for a symbol the renderer isn't (necessarily) subscribed to via
  // subscribeTicker/onTickerUpdate -- that pair is a single global subscription (one consumer at
  // a time), which doesn't fit a caller that needs several symbols' prices at once (e.g. the
  // Portfolio page pricing multiple distinct holdings on each poll).
  ipcMain.handle(
    IpcChannel.MarketFetchTicker24h,
    async (_event, exchange: Exchange, symbol: string): Promise<Ticker24h> => fetchTicker24h(exchange, symbol)
  )

  ipcMain.handle(
    IpcChannel.MarketFetchHistoricalRange,
    async (
      _event,
      exchange: Exchange,
      symbol: string,
      interval: Interval,
      startSec: number,
      endSec: number,
      requestId?: string
    ): Promise<HistoricalRangeResult> => {
      // Callers that never cancel (bot polls, routines, executor/simulation fetches) don't pass
      // a requestId -- each such call still gets its own internal identity here, so it can never
      // collide with (or be truncated by) an unrelated cancellable fetch like Backtest's.
      const id = requestId ?? randomUUID()
      return fetchHistoricalRange(exchange, symbol, interval, startSec, endSec, id, (done, total) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannel.MarketHistoricalRangeProgress, { requestId: id, done, total })
        }
      })
    }
  )
  ipcMain.handle(IpcChannel.MarketCancelHistoricalRange, (_event, requestId: string) => cancelHistoricalRangeFetch(requestId))
}
