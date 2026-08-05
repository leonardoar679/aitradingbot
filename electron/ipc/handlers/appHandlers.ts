import { ipcMain, app } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { pingService } from '../../services/pingService'

export function registerAppHandlers(): void {
  ipcMain.handle(IpcChannel.AppPing, () => pingService())
  ipcMain.handle(IpcChannel.AppGetVersion, () => app.getVersion())
}
