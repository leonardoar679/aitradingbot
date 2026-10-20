import { ipcMain, shell } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { exportResearchBundle, getResearchStatus, researchDir, writeResearchReport } from '../../services/researchFolderService'

// The research folder (V7.2-R Stage 2; electron/services/researchFolderService.ts): its status, an export on a
// click, the folder opened in the system's file browser, and the window's reports written into it. Nothing here
// reads a key, asks a model or places an order.
export function registerResearchFolderHandlers(): void {
  ipcMain.handle(IpcChannel.ResearchFolderStatus, () => getResearchStatus())
  ipcMain.handle(IpcChannel.ResearchFolderExport, () => exportResearchBundle('manual'))
  ipcMain.handle(IpcChannel.ResearchFolderOpen, async () => {
    const problem = await shell.openPath(researchDir())
    return { ok: problem === '', problem: problem === '' ? null : problem }
  })
  ipcMain.handle(IpcChannel.ResearchFolderWriteReport, (_event, request: { kind: unknown; stamp: unknown; report: unknown }) => writeResearchReport(request ?? { kind: null, stamp: null, report: null }))
}
