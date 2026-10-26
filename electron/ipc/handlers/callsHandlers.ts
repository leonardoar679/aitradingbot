import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { PrimaryCallState } from '../../../shared/forecast/primaryCall'
import { onPrimaryCall, primaryCallState } from '../../services/primaryCallService'

// The primary call (V8 Stage 3; electron/services/primaryCallService.ts): the state as last weighed, and each new one
// pushed as it is weighed. These only read: nothing here records, opens or places anything.
export function registerCallsHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onPrimaryCall((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.CallsUpdate, state)
  })
  mainWindow.on('closed', stopForwarding)
  ipcMain.handle(IpcChannel.CallsState, (): PrimaryCallState => primaryCallState())
}
