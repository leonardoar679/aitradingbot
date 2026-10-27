import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { AiBenchmarkPeekRequest } from '../../../shared/aiBenchmark'
import type { AiEntryConfirmRequest } from '../../../shared/aiConfirm'
import type { AiOpportunityAskRequest, AiOpportunityPeekRequest } from '../../../shared/aiOpportunity'
import type { AiSignalTapeRequest } from '../../../shared/aiSignal'
import type { AiConfigPatch } from '../../../shared/aiCost'
import type { AiCallFilter } from '../../../shared/aiLedger'
import type { RoleChoice } from '../../../shared/aiRouting'
import {
  getAiCredentialStatus,
  getAiKeyInfo,
  removeAiCredential,
  setAiCredential,
  testAiCredential
} from '../../services/aiCredentialsService'
import { concludeMove, exitCheck, getAiAdditionsStatus, reviewTrade, summarizeDay } from '../../services/aiAdditionsService'
import { readArticle } from '../../services/aiArticleService'
import { applyAiRoles, getAiConfig, listAiModels, previewAiRoles, setAiConfig } from '../../services/aiConfigService'
import { getAiExperiment, listAiExperiments, recordAiExperiment } from '../../services/aiExperimentService'
import { getAiUsageSummary, listAiCalls } from '../../services/aiLedgerService'
import {
  askAiOpportunity,
  cancelAiSignalTape,
  confirmAiEntry,
  estimateAiSignalTape,
  generateAiSignalTape,
  peekAiBenchmark,
  peekAiEntryConfirmation,
  peekAiOpportunity
} from '../../services/aiSignalService'

// FIVE channels here can spend money: AiGenerateSignalTape, AiConfirmEntry, AiAskOpportunity and,
// since 6 October 2026, AiConcludeMove (one call, from a click in the Why window at the price shown,
// within the conclusion's own daily limit) and AiReviewTrade (one second look before a paper trade
// of the watch's, only when something about it stands out, within the reviewer's own limit and only
// while the watch is on), each one decision at a time and each behind the same budget. Everything else
// reads a file, asks OpenRouter a free question about the key or its catalogue, or changes a
// setting. Keeping that true is what lets the AI pages be opened and browsed without a
// confirmation on every tab. A benchmark adds no third: its paid calls are one-decision tapes,
// and AiPeekBenchmark only reads what is already held. Neither does a route or a panel of agents:
// a second model's call and a panel's four are made inside a tape, through the first of the two.
// Nor does the watch (shared/aiWatch.ts): what it asks arrives over AiAskOpportunity labelled as
// the watch's, and is held to the watch's own limits before the budget is looked at. Nor does
// recording an experiment (shared/aiExperiment.ts): it writes down what a run that has already
// ended asked, and counts its cost from the ledger. Nor do the AI additions (shared/aiAdditions.ts):
// the news analyst asks by itself in the main process, within its own limit and the budget, and
// AiAdditionsStatus only reads its switch, the ledger and the price list. The additions' channels
// that ask are each held to their own limit and the budget: AiExitCheck and AiSummarizeDay as the
// two above, and since V8 Stage 5 (26 October 2026) AiReadArticle, one reading of a news link on
// file from a click on News URLs at the price shown, at most twenty a day, never by itself.
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
  // Who asks which model (V7.2-R Stage 1): the preview reads and prices; the move needs the preview's token.
  ipcMain.handle(IpcChannel.AiRoutingPreview, (_event, choice: RoleChoice) => previewAiRoles(choice))
  ipcMain.handle(IpcChannel.AiRoutingApply, (_event, request: { choice: RoleChoice; token: string }) => applyAiRoles(request))
  ipcMain.handle(IpcChannel.AiListCalls, (_event, filter: AiCallFilter) => listAiCalls(filter ?? {}))
  ipcMain.handle(IpcChannel.AiUsageSummary, () => getAiUsageSummary())
  ipcMain.handle(IpcChannel.AiPeekEntryConfirmation, (_event, request: AiEntryConfirmRequest) =>
    peekAiEntryConfirmation(request)
  )
  ipcMain.handle(IpcChannel.AiConfirmEntry, (_event, request: AiEntryConfirmRequest) => confirmAiEntry(request))
  ipcMain.handle(IpcChannel.AiPeekBenchmark, (_event, request: AiBenchmarkPeekRequest) => peekAiBenchmark(request))
  ipcMain.handle(IpcChannel.AiPeekOpportunity, (_event, request: AiOpportunityPeekRequest) => peekAiOpportunity(request))
  ipcMain.handle(IpcChannel.AiAskOpportunity, (_event, request: AiOpportunityAskRequest) => askAiOpportunity(request))
  ipcMain.handle(IpcChannel.AiListExperiments, () => listAiExperiments())
  ipcMain.handle(IpcChannel.AiGetExperiment, (_event, id: string) => getAiExperiment(String(id)))
  ipcMain.handle(IpcChannel.AiRecordExperiment, (_event, input: unknown) => recordAiExperiment(input))
  ipcMain.handle(IpcChannel.AiAdditionsStatus, () => getAiAdditionsStatus())
  ipcMain.handle(IpcChannel.AiConcludeMove, (_event, symbol: unknown) => concludeMove(symbol, false))
  ipcMain.handle(IpcChannel.AiReviewTrade, (_event, request: unknown) => reviewTrade(request))
  ipcMain.handle(IpcChannel.AiExitCheck, (_event, request: unknown) => exitCheck(request))
  ipcMain.handle(IpcChannel.AiSummarizeDay, (_event, request: unknown, automatic: unknown) => summarizeDay(request, automatic === true))
  ipcMain.handle(IpcChannel.AiReadArticle, (_event, id: unknown) => readArticle(id))
}
