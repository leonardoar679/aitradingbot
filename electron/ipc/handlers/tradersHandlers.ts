import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { readFile, stat } from 'fs/promises'
import { basename } from 'path'
import { IpcChannel } from '../../../shared/ipc'
import type { TraderAnalysis, TraderMeta } from '../../../shared/traders/traderAnalysis'
import { TRADER_FILE_LINES } from '../../../shared/traders/traderFile'
import { analyzeTrader, importTrader, importTraderFile, listTraders, onTraderProgress } from '../../services/traderService'
import { followPerpOf, followStatuses, onCloneSignal, onFollowStatus, onLeaderEvent, recentFollowRecords, setClone, setFollow } from '../../services/followService'
import { perpBars, perpBook, perpFunding, perpPrice } from '../../services/perpMarketService'

// COPY TRADERS (V8 Stages 6-7; electron/services/traderService.ts): a pasted trader read from its venue and kept, a file
// of trades the person chooses in this process's own dialog -- the window never names a path -- read and kept, an
// analysis of one on file, the traders on file with their last analysis, and each step pushed as it goes. What the
// window hands in is held to its shape and length first. Nothing here reads a key, asks a model or places anything.

const MAX_PASTE = 500

export function registerTradersHandlers(mainWindow: BrowserWindow): void {
  const forward = (channel: string, payload: unknown): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  const stops = [
    onTraderProgress((progress) => forward(IpcChannel.TradersProgress, progress)),
    onLeaderEvent((event) => forward(IpcChannel.TradersLeaderEvent, event)),
    onCloneSignal((signal) => forward(IpcChannel.TradersCloneSignal, signal)),
    onFollowStatus((statuses) => forward(IpcChannel.TradersFollowStatusChanged, statuses))
  ]
  mainWindow.on('closed', () => stops.forEach((stop) => stop()))

  ipcMain.handle(IpcChannel.TradersImport, async (_event, raw: unknown): Promise<TraderMeta | { refused: string }> => {
    if (typeof raw !== 'string' || raw.length > MAX_PASTE) return { refused: 'That is not an address or a link this app reads.' }
    return importTrader(raw)
  })
  ipcMain.handle(IpcChannel.TradersImportFile, async (): Promise<TraderMeta | { refused: string } | { canceled: true }> => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "A file of a trader's trades",
      properties: ['openFile'],
      filters: [{ name: 'Trades (CSV or JSON)', extensions: ['csv', 'json', 'txt'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true }
    const path = picked.filePaths[0]
    if ((await stat(path)).size > TRADER_FILE_LINES.maxBytes) return { refused: `The file is larger than ${TRADER_FILE_LINES.maxBytes / 1024 / 1024} MB.` }
    return importTraderFile({ name: basename(path), bytes: await readFile(path) })
  })
  ipcMain.handle(IpcChannel.TradersAnalyze, (_event, key: unknown): Promise<TraderAnalysis> => analyzeTrader(typeof key === 'string' ? key.slice(0, 80) : null))
  ipcMain.handle(IpcChannel.TradersList, () => listTraders())
  // Following and cloning on paper (V8 Stage 8): each switched on or off only by its button; the perpetual's price and
  // funding for the writers, its venue and symbol held to their shape.
  ipcMain.handle(IpcChannel.TradersFollow, (_event, request: { key?: unknown; on?: unknown } | undefined) => setFollow(request?.key, request?.on === true))
  ipcMain.handle(IpcChannel.TradersClone, (_event, request: { key?: unknown; on?: unknown } | undefined) => setClone(request?.key, request?.on === true))
  ipcMain.handle(IpcChannel.TradersFollowStatus, () => followStatuses())
  ipcMain.handle(IpcChannel.TradersFollowRecords, (_event, sinceMs: unknown) => recentFollowRecords(sinceMs))
  const perpOf = (request: { venue?: unknown; symbol?: unknown } | undefined): { venue: 'binance' | 'bitget'; symbol: string } => {
    if ((request?.venue !== 'binance' && request?.venue !== 'bitget') || typeof request.symbol !== 'string' || !/^[A-Z0-9]{2,30}$/.test(request.symbol)) throw new Error('Name a perpetual: Binance or Bitget, and its symbol.')
    return { venue: request.venue, symbol: request.symbol }
  }
  ipcMain.handle(IpcChannel.TradersPerpPrice, (_event, request: { venue?: unknown; symbol?: unknown } | undefined) => {
    const perp = perpOf(request)
    return perpPrice(perp.venue, perp.symbol)
  })
  ipcMain.handle(IpcChannel.TradersPerpFunding, (_event, request: { venue?: unknown; symbol?: unknown; fromSec?: unknown; toSec?: unknown } | undefined) => {
    const perp = perpOf(request)
    const fromSec = Number(request?.fromSec)
    const toSec = Number(request?.toSec)
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec || toSec - fromSec > 30 * 86_400) throw new Error('Name a span of at most thirty days.')
    return perpFunding(perp.venue, perp.symbol, fromSec, toSec)
  })
  // The books' writers (V8 Stage 9): a coin's perpetual, Binance's first; a perpetual's book, for the liquidity gate; and
  // its 1-minute bars, a day at most, for a short's exits.
  ipcMain.handle(IpcChannel.TradersPerpOf, (_event, coin: unknown) => {
    if (typeof coin !== 'string' || !/^[A-Z0-9]{1,20}$/.test(coin)) throw new Error('Name a coin by its ticker.')
    return followPerpOf(coin)
  })
  ipcMain.handle(IpcChannel.TradersPerpBook, (_event, request: { venue?: unknown; symbol?: unknown } | undefined) => {
    const perp = perpOf(request)
    return perpBook(perp.venue, perp.symbol)
  })
  ipcMain.handle(IpcChannel.TradersPerpBars, (_event, request: { venue?: unknown; symbol?: unknown; fromSec?: unknown; toSec?: unknown } | undefined) => {
    const perp = perpOf(request)
    const fromSec = Number(request?.fromSec)
    const toSec = Number(request?.toSec)
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec || toSec - fromSec > 86_400) throw new Error('Name a span of at most a day.')
    return perpBars(perp.venue, perp.symbol, '1m', fromSec, toSec)
  })
}
