import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { getLiveState, liveBook, onLiveUpdate, setLiveInterest } from '../../services/liveMarketService'

// Live prices (the second V3 document, §7). Nothing here can spend money or place an order: the
// stream is public market data from the data host, these channels say which pairs to stream and
// show what it holds, and a book is read once over REST when the stream has none fresh.
export function registerLiveMarketHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onLiveUpdate((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.MarketLiveUpdate, state)
  })
  mainWindow.on('closed', stopForwarding)

  ipcMain.handle(IpcChannel.MarketLiveInterest, (_event, symbols: unknown) => setLiveInterest(symbols))
  ipcMain.handle(IpcChannel.MarketLiveState, () => getLiveState())
  ipcMain.handle(IpcChannel.MarketLiveBook, (_event, symbol: unknown) => liveBook(symbol))
}
