import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { UrlRecord } from '../../../shared/newsUrl'
import { analyzeUrl, linkUrlRecord, onUrlRecord, urlRecords } from '../../services/newsUrlService'

// NEWS URLS (V8 Stage 4; electron/services/newsUrlService.ts): a pasted link read and kept, the links on file, a
// person's own view linked to one, and each record pushed as it changes. What the window hands in is held to its shape
// and its length before anything reads it. Nothing here reads a key, asks a model or places anything.

const MAX_URL = 4096
const MAX_SUPPLIED = 20_000

export function registerUrlsHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onUrlRecord((record) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.UrlsUpdate, record)
  })
  mainWindow.on('closed', stopForwarding)

  ipcMain.handle(IpcChannel.UrlsAnalyze, async (_event, raw: unknown, supplied: unknown): Promise<UrlRecord | { refused: string }> => {
    if (typeof raw !== 'string' || raw.length > MAX_URL) return { refused: 'That is not a link this app reads.' }
    const text = typeof supplied === 'string' ? supplied.slice(0, MAX_SUPPLIED) : null
    return analyzeUrl({ raw, origin: 'manual', supplied: text })
  })
  ipcMain.handle(IpcChannel.UrlsList, (): Promise<UrlRecord[]> => urlRecords())
  ipcMain.handle(IpcChannel.UrlsLink, async (_event, id: unknown, link: unknown): Promise<UrlRecord | null> => {
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id) || typeof link !== 'object' || link === null) return null
    const { predictionId, executorId } = link as { predictionId?: unknown; executorId?: unknown }
    const ok = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
    return linkUrlRecord(id, { ...(ok(predictionId) ? { predictionId } : {}), ...(ok(executorId) ? { executorId } : {}) })
  })
}
