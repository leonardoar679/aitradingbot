import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { AiSignalTapeRequest } from '../../../shared/aiSignal'
import {
  getAiCredentialStatus,
  removeAiCredential,
  setAiCredential,
  testAiCredential
} from '../../services/aiCredentialsService'
import { cancelAiSignalTape, estimateAiSignalTape, generateAiSignalTape } from '../../services/aiSignalService'

export function registerAiHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(IpcChannel.AiCredentialsStatus, () => getAiCredentialStatus())
  ipcMain.handle(IpcChannel.AiCredentialsSet, (_event, apiKey: string, model: string) =>
    setAiCredential(apiKey, model)
  )
  ipcMain.handle(IpcChannel.AiCredentialsTest, () => testAiCredential())
  ipcMain.handle(IpcChannel.AiCredentialsRemove, () => removeAiCredential())
  ipcMain.handle(IpcChannel.AiEstimateSignalTape, (_event, request: AiSignalTapeRequest) =>
    estimateAiSignalTape(request)
  )
  ipcMain.handle(IpcChannel.AiGenerateSignalTape, (_event, request: AiSignalTapeRequest) =>
    generateAiSignalTape(request, (progress) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.AiSignalProgress, progress)
    })
  )
  ipcMain.handle(IpcChannel.AiCancelSignalTape, (_event, requestId: string) => cancelAiSignalTape(requestId))
}
