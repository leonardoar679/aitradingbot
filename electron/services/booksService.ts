import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { ExecutorConfig } from '../../shared/ipc'
import { readMiss, type MissRecord } from '../../shared/misses'
import {
  BOOK_IDS,
  PAPER_BOOKS_VERSION,
  bookStandingOf,
  healPaperBooks,
  type BookEquityMark,
  type BookId,
  type BookStanding
} from '../../shared/paperBooks'
import { appendJsonLine, listMonthFiles } from './jsonlStore'
import { getSettings } from './settingsService'

// THE PAPER BOOKS' FILES (shared/paperBooks.ts, shared/misses.ts; V8 Stage 2): each book's equity marked once an
// hour while the books run -- so a drawdown and a daily stop survive a restart -- and every missed opportunity a
// book's writer reports. Both are appended to paperBooks/, a file a UTC month, never swept. It reads the
// settings and prices open trades; it opens, closes and places nothing.

const HOUR_MS = 3_600_000

export const booksSeam = {
  dir: (): string => join(app.getPath('userData'), 'paperBooks'),
  now: (): number => Math.floor(Date.now() / 1000),
  /** An open paper trade's result now, in its quote; null where it cannot be priced. Until a book's first
   * writer exists (V8 Stage 3 on), every open trade of a book is priced by it. */
  openResult: (_executor: ExecutorConfig): number | null => null
}

const monthOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 7)

/** Writes one missed opportunity, refusing one that is not whole. */
export async function recordMiss(value: unknown): Promise<MissRecord> {
  const miss = readMiss(value)
  if (miss === null) throw new Error('A missed opportunity was not recorded: it is not a whole miss-v1 line')
  await appendJsonLine(join(booksSeam.dir(), `misses-${monthOf(miss.at)}.jsonl`), miss)
  return miss
}

async function linesOf(path: string): Promise<unknown[]> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
}

/** The misses on file since `sinceSec`, oldest first. */
export async function listMisses(sinceSec = 0): Promise<MissRecord[]> {
  const dir = booksSeam.dir()
  const out: MissRecord[] = []
  for (const { name } of await listMonthFiles(dir, /^misses-(\d{4}-\d{2})\.jsonl$/)) {
    for (const raw of await linesOf(join(dir, name))) {
      const miss = readMiss(raw)
      if (miss !== null && miss.at >= sinceSec) out.push(miss)
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Every book's standing now, from the settings' executors. */
export async function bookStandings(): Promise<{ running: boolean; startedAt: number | null; standings: BookStanding[] }> {
  const settings = await getSettings()
  const books = healPaperBooks(settings.paperBooks)
  const executors = (settings.executors ?? []) as ExecutorConfig[]
  const startedAt = books.startedAt ?? 0
  return { running: books.running, startedAt: books.startedAt, standings: BOOK_IDS.map((id) => bookStandingOf(id, books.books[id], executors, startedAt, booksSeam.openResult)) }
}

/** Marks each book's equity now, while the books run: one line a book. */
export async function markBookEquity(): Promise<BookEquityMark[]> {
  const { running, startedAt, standings } = await bookStandings()
  if (!running || startedAt === null) return []
  const at = booksSeam.now()
  const marks: BookEquityMark[] = standings.map((standing) => ({
    v: PAPER_BOOKS_VERSION,
    book: standing.id,
    startedAt,
    at,
    equity: standing.equity,
    settledEquity: standing.settledEquity,
    realizedQuote: standing.realizedQuote,
    unrealizedQuote: standing.unrealizedQuote,
    open: standing.open,
    openStakeQuote: standing.openStakeQuote
  }))
  for (const mark of marks) await appendJsonLine(join(booksSeam.dir(), `equity-${monthOf(at)}.jsonl`), mark)
  return marks
}

/** The equity marks of a book's run that began at `startedAt`, oldest first. */
export async function listEquityMarks(book: BookId, startedAt: number): Promise<BookEquityMark[]> {
  const dir = booksSeam.dir()
  const out: BookEquityMark[] = []
  for (const { name } of await listMonthFiles(dir, /^equity-(\d{4}-\d{2})\.jsonl$/)) {
    for (const raw of await linesOf(join(dir, name))) {
      const mark = raw as Partial<BookEquityMark>
      if (mark.v === PAPER_BOOKS_VERSION && mark.book === book && mark.startedAt === startedAt && typeof mark.at === 'number') out.push(mark as BookEquityMark)
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

let timer: ReturnType<typeof setTimeout> | null = null

/** Marks the books at every UTC hour while the app runs (nothing while they are stopped). */
export function startBookMarks(): void {
  if (timer !== null) return
  const next = (): void => {
    const now = Date.now()
    timer = setTimeout(() => {
      void markBookEquity().catch((error) => console.error("The paper books' equity could not be marked:", error))
      next()
    }, HOUR_MS - (now % HOUR_MS) + 1000)
  }
  next()
}

export function stopBookMarks(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}
