import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { readFile, stat } from 'fs/promises'
import { basename } from 'path'
import { IpcChannel } from '../../../shared/ipc'
import type { TraderAnalysis, TraderMeta } from '../../../shared/traders/traderAnalysis'
import { TRADER_FILE_LINES } from '../../../shared/traders/traderFile'
import { analyzeTrader, importTrader, importTraderFile, listTraders, onTraderProgress } from '../../services/traderService'

// COPY TRADERS (V8 Stages 6-7; electron/services/traderService.ts): a pasted trader read from its venue and kept, a file
// of trades the person chooses in this process's own dialog -- the window never names a path -- read and kept, an
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
  ipcMain.handle(IpcChannel.TradersImportFile, async (): Promise<TraderMeta | { refused: string } | { canceled: true }> => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "A file of a trader's trades",
      properties: ['openFile'],
      filters: [{ name: 'Trades (CSV or JSON)', extensions: ['csv', 'json', 'txt'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true }
    const path = picked.filePaths[0]
    if ((await stat(path)).size > TRADER_FILE_LINES.maxBytes) return { refused: `The file is larger than ${TRADER_FILE_LINES.maxBytes / 1024 / 1024} MB.` }
    return importTraderFile({ name: basename(path), bytes: await readFile(path) })
  })
  ipcMain.handle(IpcChannel.TradersAnalyze, (_event, key: unknown): Promise<TraderAnalysis> => analyzeTrader(typeof key === 'string' ? key.slice(0, 80) : null))
  ipcMain.handle(IpcChannel.TradersList, () => listTraders())
}
