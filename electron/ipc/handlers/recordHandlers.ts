import { ipcMain } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { getEffectiveConfig } from '../../services/effectiveConfigService'
import { appendAlert, appendPaperRefusal, readAlertsSince, readPaperRefusalsSince } from '../../services/recordStoreService'

// The records on file (shared/records.ts) and the effective configuration (shared/appConfig.ts).
// Nothing here can spend money, place an order or change a setting: a refusal or an alert is written
// as the renderer tells it and read back by span, and the configuration is read and hashed.
export function registerRecordHandlers(): void {
  ipcMain.handle(IpcChannel.RecordsRefusal, (_event, record: unknown) => appendPaperRefusal(record))
  ipcMain.handle(IpcChannel.RecordsRefusals, (_event, filter: unknown) => readPaperRefusalsSince(filter))
  ipcMain.handle(IpcChannel.RecordsAlert, (_event, record: unknown) => appendAlert(record))
  ipcMain.handle(IpcChannel.RecordsAlerts, (_event, filter: unknown) => readAlertsSince(filter))
  ipcMain.handle(IpcChannel.AppEffectiveConfig, () => getEffectiveConfig())
}
