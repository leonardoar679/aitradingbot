import { ipcMain } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { BOOK_IDS, type BookId } from '../../../shared/paperBooks'
import { readSourcePrediction } from '../../../shared/evaluation/predictionRecord'
import { recordSourcePrediction, sourceRecord } from '../../services/predictionLedgerService'
import { archiveSettled, bookStandings, listEquityMarks, listMisses, recordMiss } from '../../services/booksService'

// The record of predictions that are not the forecast's own, and V8's paper books (V8 Stage 2). The window may
// record only predictions of the sources it makes itself -- a person's own call -- never a rule's, a reading's
// or a trader's, which the main process writes where it makes them. Nothing here reads a key, asks a model or
// places an order.

/** The sources the window may record. */
export const WINDOW_SOURCES = ['user'] as const

export function registerBooksHandlers(): void {
  ipcMain.handle(IpcChannel.PredictionsRecord, async (_event, value: unknown) => {
    const prediction = readSourcePrediction(value)
    if (prediction === null) throw new Error('Not a whole prediction: nothing was recorded.')
    if (!(WINDOW_SOURCES as readonly string[]).includes(prediction.source)) throw new Error(`The window cannot record a ${prediction.source.slice(0, 40)} prediction.`)
    await recordSourcePrediction(prediction)
    return { ok: true, id: prediction.id }
  })
  ipcMain.handle(IpcChannel.PredictionsList, (_event, filter: { source?: unknown; sinceSec?: unknown } | undefined) =>
    sourceRecord({
      ...(typeof filter?.source === 'string' ? { source: filter.source } : {}),
      ...(typeof filter?.sinceSec === 'number' && Number.isFinite(filter.sinceSec) ? { sinceSec: filter.sinceSec } : {})
    })
  )
  ipcMain.handle(IpcChannel.BooksState, () => bookStandings())
  ipcMain.handle(IpcChannel.BooksMarks, async (_event, request: { book?: unknown; startedAt?: unknown } | undefined) => {
    if (!(BOOK_IDS as readonly unknown[]).includes(request?.book) || typeof request?.startedAt !== 'number') throw new Error('Name a book and the start of its run.')
    return listEquityMarks(request.book as BookId, request.startedAt)
  })
  ipcMain.handle(IpcChannel.BooksMiss, (_event, value: unknown) => recordMiss(value))
  ipcMain.handle(IpcChannel.BooksMisses, (_event, sinceSec: unknown) => listMisses(typeof sinceSec === 'number' && Number.isFinite(sinceSec) ? sinceSec : 0))
  ipcMain.handle(IpcChannel.BooksArchive, (_event, executors: unknown) => archiveSettled(executors))
}
