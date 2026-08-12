import { ipcMain, type BrowserWindow } from 'electron'
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

  ipcMain.handle(
    IpcChannel.MarketFetchHistoricalRange,
    async (
      _event,
      exchange: Exchange,
      symbol: string,
      interval: Interval,
      startSec: number,
      endSec: number
    ): Promise<HistoricalRangeResult> =>
      fetchHistoricalRange(exchange, symbol, interval, startSec, endSec, (done, total) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannel.MarketHistoricalRangeProgress, { done, total })
        }
      })
  )
  ipcMain.handle(IpcChannel.MarketCancelHistoricalRange, () => cancelHistoricalRangeFetch())
}
