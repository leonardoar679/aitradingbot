import type { BookId } from './paperBooks'

// EVERY OPPORTUNITY NOT TAKEN, AND WHY (V8 Stage 2, 26 October 2026).
//
// "Record every prediction, trade and missed opportunity": a book's writer that has a candidate its source called
// -- a card, a followed trader's position, a baseline signal -- and does not trade it says so here, with the stage
// that stopped it. Only candidates that passed their own source's call are written, never a forecast with no call
// at all, so the file holds what was missed and not what was never there. A miss with a prediction behind it is
// scored by that prediction's outcome (shared/evaluation/predictionRecord.ts): what it would have made.
// paperBooks/misses-YYYY-MM.jsonl, written by the main process (electron/services/booksService.ts).

export const MISS_VERSION = 'miss-v1'

/** What stopped it: switched off, a gate of its source, a cap, a pause, the book's liquidity gate, a restart,
 * gone before it could be taken, too late for its rule, the app closed, or its writer down. */
export const MISS_STAGES = ['off', 'gate', 'cap', 'pause', 'liquidity', 'restart', 'expired', 'late', 'closed', 'down'] as const
export type MissStage = (typeof MISS_STAGES)[number]

export interface MissRecord {
  v: typeof MISS_VERSION
  at: number
  book: BookId | 'other'
  /** The writer that missed it: `news-card`, `follow`, `baseline`, `lab`, `forecast-trader`, ... */
  writer: string
  pair: string
  side: 'up' | 'down' | null
  refPrice: number | null
  stage: MissStage
  reason: string
  /** The prediction it would have followed, where one was recorded; its outcome is what it would have made. */
  predictionId: string | null
  /** Written by a gate that only watches -- the liquidity gate over the writers that were there before V8 --
   * and stopped nothing. */
  shadow: boolean
}

/** A miss as written, or null where it is not a whole one. */
export function readMiss(value: unknown): MissRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const miss = value as Partial<MissRecord>
  if (miss.v !== MISS_VERSION || typeof miss.at !== 'number' || !Number.isFinite(miss.at)) return null
  if (typeof miss.writer !== 'string' || miss.writer === '' || typeof miss.pair !== 'string' || miss.pair === '') return null
  if (!(MISS_STAGES as readonly unknown[]).includes(miss.stage) || typeof miss.reason !== 'string') return null
  if (miss.side !== 'up' && miss.side !== 'down' && miss.side !== null) return null
  if (miss.book !== 'news' && miss.book !== 'copy' && miss.book !== 'baseline' && miss.book !== 'other') return null
  if (miss.refPrice !== null && (typeof miss.refPrice !== 'number' || !(miss.refPrice > 0))) return null
  if (miss.predictionId !== null && typeof miss.predictionId !== 'string') return null
  if (typeof miss.shadow !== 'boolean') return null
  return { v: MISS_VERSION, at: miss.at, book: miss.book, writer: miss.writer.slice(0, 40), pair: miss.pair.slice(0, 30), side: miss.side, refPrice: miss.refPrice, stage: miss.stage!, reason: miss.reason.slice(0, 400), predictionId: miss.predictionId, shadow: miss.shadow }
}
