import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { subscribe, unsubscribe, onPriceUpdate } from '../../services/marketService'

export function registerMarketHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onPriceUpdate((update) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.MarketPriceUpdate, update)
    }
  })
  mainWindow.on('closed', stopForwarding)

  ipcMain.handle(IpcChannel.MarketSubscribe, (_event, symbol: string) => subscribe(symbol))
  ipcMain.handle(IpcChannel.MarketUnsubscribe, (_event, symbol: string) => unsubscribe(symbol))
}
