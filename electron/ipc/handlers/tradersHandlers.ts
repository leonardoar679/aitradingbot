import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { TraderAnalysis, TraderMeta } from '../../../shared/traders/traderAnalysis'
import { analyzeTrader, importTrader, listTraders, onTraderProgress } from '../../services/traderService'

// COPY TRADERS (V8 Stage 6; electron/services/traderService.ts): a pasted trader read from its venue and kept, an
// analysis of one on file, the traders on file with their last analysis, and each step pushed as it goes. What the
// window hands in is held to its shape and length first. Nothing here reads a key, asks a model or places anything.

const MAX_PASTE = 500

export function registerTradersHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onTraderProgress((progress) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.TradersProgress, progress)
  })
  mainWindow.on('closed', stopForwarding)

  ipcMain.handle(IpcChannel.TradersImport, async (_event, raw: unknown): Promise<TraderMeta | { refused: string }> => {
    if (typeof raw !== 'string' || raw.length > MAX_PASTE) return { refused: 'That is not an address or a link this app reads.' }
    return importTrader(raw)
  })
  ipcMain.handle(IpcChannel.TradersAnalyze, (_event, key: unknown): Promise<TraderAnalysis> => analyzeTrader(typeof key === 'string' ? key.slice(0, 80) : null))
  ipcMain.handle(IpcChannel.TradersList, () => listTraders())
}
