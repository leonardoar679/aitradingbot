import { ipcMain, type BrowserWindow } from 'electron'
import { EXPERIMENT_KINDS, type ExperimentKind } from '../../../shared/experimentRun'
import { IpcChannel } from '../../../shared/ipc'
import { fileExperimentReport, listExperimentRuns, startExperimentRun, startExperimentRunService, stopExperimentRun } from '../../services/experimentRunService'

/** The runs the app keeps of itself (shared/experimentRun.ts). None of these asks a model or trades:
 * a run is a record and a clock, and its report is built by the window from what is on file. */
export function registerExperimentHandlers(mainWindow: BrowserWindow): void {
  startExperimentRunService(mainWindow)
  ipcMain.handle(IpcChannel.ExperimentStart, (_event, input: unknown) => {
    const raw = (typeof input === 'object' && input !== null ? input : {}) as { kind?: unknown; minutes?: unknown }
    const kind = (EXPERIMENT_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as ExperimentKind) : null
    if (kind === null) throw new Error(`A run is ${EXPERIMENT_KINDS.join(', ')}.`)
    return startExperimentRun({ kind, minutes: typeof raw.minutes === 'number' ? raw.minutes : null })
  })
  ipcMain.handle(IpcChannel.ExperimentList, () => listExperimentRuns())
  ipcMain.handle(IpcChannel.ExperimentStop, (_event, id: unknown) => stopExperimentRun(String(id)))
  ipcMain.handle(IpcChannel.ExperimentReport, (_event, id: unknown, report: unknown) => fileExperimentReport(String(id), report))
}
