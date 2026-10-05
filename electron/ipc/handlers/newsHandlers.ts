import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { NewsConfigPatch, NewsFilter } from '../../../shared/news'
import { getNewsRecord } from '../../services/newsRecordService'
import { getNewsState, listNews, onNewsUpdate, setNewsConfig } from '../../services/newsService'

// Nothing here can spend money or place an order. Every channel reads Binance's public
// announcement lists, a coin's public candles or the files the reader and the record wrote, or
// switches the reader on and off.
export function registerNewsHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onNewsUpdate((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.NewsUpdate, state)
  })
  mainWindow.on('closed', stopForwarding)

  ipcMain.handle(IpcChannel.NewsGetState, () => getNewsState())
  ipcMain.handle(IpcChannel.NewsSetConfig, (_event, patch: NewsConfigPatch) => setNewsConfig(patch ?? {}))
  ipcMain.handle(IpcChannel.NewsList, (_event, filter: NewsFilter) => listNews(filter ?? {}))
  ipcMain.handle(IpcChannel.NewsRecord, () => getNewsRecord())
}
