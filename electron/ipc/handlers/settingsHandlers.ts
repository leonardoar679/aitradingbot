import { ipcMain } from 'electron'
import { IpcChannel, type AppSettings } from '../../../shared/ipc'
import { getSettings, setSettings } from '../../services/settingsService'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannel.SettingsGet, () => getSettings())
  ipcMain.handle(IpcChannel.SettingsSet, (_event, patch: Partial<AppSettings>) => setSettings(patch))
}
