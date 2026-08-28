import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFile } from 'fs/promises'
import { IpcChannel, type BacktestExportRequest, type BacktestExportResult } from '../../../shared/ipc'

// Saving a finished backtest to disk.
//
// Every write here goes through a native save dialog, and the request carries no path — the
// renderer can say what to call the file and what goes in it, but never where it lands. That is
// the whole reason this is an IPC handler rather than a link the page could trigger silently:
// writing a file is the user's decision and they make it in their own file picker.
//
// Not atomic, unlike settings persistence (services/atomicWrite.ts). A half-written export is a
// file the user can see failed and export again; a half-written settings.json loses their bots.
// The temp-file dance there exists for data the app owns and cannot re-derive, which this is not.

const FILTERS = {
  json: [{ name: 'JSON', extensions: ['json'] }],
  csv: [{ name: 'CSV spreadsheet', extensions: ['csv'] }]
}

export function registerBacktestHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(
    IpcChannel.BacktestExportSave,
    async (_event, request: BacktestExportRequest): Promise<BacktestExportResult> => {
      try {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
          title: 'Export backtest results',
          defaultPath: request.defaultFileName,
          filters: FILTERS[request.format] ?? FILTERS.json,
          properties: ['createDirectory', 'showOverwriteConfirmation']
        })
        // Cancelled is an ordinary outcome, not a failure — the caller shows nothing for it.
        if (canceled || !filePath) return { status: 'cancelled' }

        // BOM on CSV so Excel reads it as UTF-8. Without it Excel assumes the local ANSI code
        // page and mangles any non-ASCII symbol name, which is the classic "my export looks like
        // gibberish" bug. JSON gets no BOM: it breaks strict parsers, and nothing else wants it.
        const body = request.format === 'csv' ? `﻿${request.content}` : request.content
        await writeFile(filePath, body, 'utf-8')
        return { status: 'saved', filePath }
      } catch (error) {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
