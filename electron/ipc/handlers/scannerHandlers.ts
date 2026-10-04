import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { MarketEventFilter, ScanHistoryRequest, ScannerConfigPatch } from '../../../shared/marketScanner'
import {
  cancelScanHistory,
  getScannerState,
  listMarketEvents,
  onScannerUpdate,
  pickScannerUniverse,
  scanHistory,
  setScannerConfig
} from '../../services/marketScannerService'

// Nothing here can spend money or place an order. Every channel reads public market data or a
// file the scanner wrote, or switches the scanner on and off.
export function registerScannerHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onScannerUpdate((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.ScannerUpdate, state)
  })
  mainWindow.on('closed', stopForwarding)

  ipcMain.handle(IpcChannel.ScannerGetState, () => getScannerState())
  ipcMain.handle(IpcChannel.ScannerSetConfig, (_event, patch: ScannerConfigPatch) => setScannerConfig(patch ?? {}))
  ipcMain.handle(IpcChannel.ScannerListEvents, (_event, filter: MarketEventFilter) => listMarketEvents(filter ?? {}))
  ipcMain.handle(IpcChannel.ScannerScanHistory, (_event, request: ScanHistoryRequest) =>
    scanHistory(request, (progress) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.ScannerHistoryProgress, progress)
    })
  )
  ipcMain.handle(IpcChannel.ScannerCancelHistory, (_event, requestId: string) => cancelScanHistory(requestId))
  ipcMain.handle(IpcChannel.ScannerPickUniverse, (_event, size: number) => pickScannerUniverse(size))
}
