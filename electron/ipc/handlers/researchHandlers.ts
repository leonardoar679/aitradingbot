import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { getResearchState, onResearchUpdate, refreshResearch } from '../../services/marketResearchService'

// Nothing here can spend money or place an order. The research reads public market data and
// CoinGecko's free trending list; these channels show what it found, or ask it to read again.
export function registerResearchHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onResearchUpdate((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.ResearchUpdate, state)
  })
  mainWindow.on('closed', stopForwarding)

  ipcMain.handle(IpcChannel.ResearchGetState, () => getResearchState())
  ipcMain.handle(IpcChannel.ResearchRefresh, () => refreshResearch())
}
