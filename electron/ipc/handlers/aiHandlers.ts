import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { AiBenchmarkPeekRequest } from '../../../shared/aiBenchmark'
import type { AiEntryConfirmRequest } from '../../../shared/aiConfirm'
import type { AiSignalTapeRequest } from '../../../shared/aiSignal'
import type { AiConfigPatch } from '../../../shared/aiCost'
import type { AiCallFilter } from '../../../shared/aiLedger'
import {
  getAiCredentialStatus,
  getAiKeyInfo,
  removeAiCredential,
  setAiCredential,
  testAiCredential
} from '../../services/aiCredentialsService'
import { getAiConfig, listAiModels, setAiConfig } from '../../services/aiConfigService'
import { getAiUsageSummary, listAiCalls } from '../../services/aiLedgerService'
import {
  cancelAiSignalTape,
  confirmAiEntry,
  estimateAiSignalTape,
  generateAiSignalTape,
  peekAiBenchmark,
  peekAiEntryConfirmation
} from '../../services/aiSignalService'

// TWO channels here can spend money: AiGenerateSignalTape and AiConfirmEntry. Everything else
// reads a file, asks OpenRouter a free question about the key or its catalogue, or changes a
// setting. Keeping that true is what lets the AI pages be opened and browsed without a
// confirmation on every tab. A benchmark adds no third: its paid calls are one-decision tapes,
// and AiPeekBenchmark only reads what is already held. Neither does a route or a panel of agents:
// a second model's call and a panel's four are made inside a tape, through the first of the two.
export function registerAiHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(IpcChannel.AiCredentialsStatus, () => getAiCredentialStatus())
  ipcMain.handle(IpcChannel.AiCredentialsSet, (_event, apiKey: string) => setAiCredential(apiKey))
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
  ipcMain.handle(IpcChannel.AiKeyInfo, () => getAiKeyInfo())
  ipcMain.handle(IpcChannel.AiListModels, (_event, refresh: boolean) => listAiModels(refresh === true))
  ipcMain.handle(IpcChannel.AiGetConfig, () => getAiConfig())
  ipcMain.handle(IpcChannel.AiSetConfig, (_event, patch: AiConfigPatch) => setAiConfig(patch ?? {}))
  ipcMain.handle(IpcChannel.AiListCalls, (_event, filter: AiCallFilter) => listAiCalls(filter ?? {}))
  ipcMain.handle(IpcChannel.AiUsageSummary, () => getAiUsageSummary())
  ipcMain.handle(IpcChannel.AiPeekEntryConfirmation, (_event, request: AiEntryConfirmRequest) =>
    peekAiEntryConfirmation(request)
  )
  ipcMain.handle(IpcChannel.AiConfirmEntry, (_event, request: AiEntryConfirmRequest) => confirmAiEntry(request))
  ipcMain.handle(IpcChannel.AiPeekBenchmark, (_event, request: AiBenchmarkPeekRequest) => peekAiBenchmark(request))
}
