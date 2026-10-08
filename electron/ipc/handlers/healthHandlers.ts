import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { getHealthState, onHealthUpdate } from '../../services/exchangeHealthService'

// Exchange health (shared/exchangeHealth.ts): read, and pushed as it is measured. Nothing here can
// place an order or change a setting.
export function registerHealthHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onHealthUpdate((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.HealthUpdate, state)
  })
  mainWindow.on('closed', stopForwarding)
  ipcMain.handle(IpcChannel.HealthState, () => getHealthState())
}
