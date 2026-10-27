import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { bookOpenNetOf, bookPriceRefOf, priceRefKey, type BookPriceRef } from '../../shared/bookValuation'
import type { ExecutorConfig } from '../../shared/ipc'
import { readMiss, type MissRecord } from '../../shared/misses'
import {
  BOOK_IDS,
  PAPER_BOOKS_VERSION,
  bookOf,
  bookStandingOf,
  dayStartEquityOf,
  healPaperBooks,
  type BookEquityMark,
  type BookId,
  type BookStanding
} from '../../shared/paperBooks'
import { appendJsonLine, appendJsonLines, listMonthFiles } from './jsonlStore'
import { fetchTicker24h } from './marketService'
import { perpPrice } from './perpMarketService'
import { getSettings } from './settingsService'

// THE PAPER BOOKS' FILES (shared/paperBooks.ts, shared/misses.ts; V8 Stage 2): each book's equity marked once an
// hour while the books run -- so a drawdown and a daily stop survive a restart -- and every missed opportunity a
// book's writer reports. Both are appended to paperBooks/, a file a UTC month, never swept. Since V8 Stage 8 a book's
// trades settled a day ago are moved out of the settings by their writer into paperBooks/archive-YYYY-MM.jsonl, and a
// book's standing reads them there beside the settings. It reads the settings and prices open trades; it opens,
// closes and places nothing.

const HOUR_MS = 3_600_000

export const booksSeam = {
  dir: (): string => join(app.getPath('userData'), 'paperBooks'),
  now: (): number => Math.floor(Date.now() / 1000),
  /** A book trade's price now (V8 Stage 9): its perpetual's last, or its spot pair's; null where it cannot be read. */
  price: async (ref: BookPriceRef): Promise<number | null> => {
    try {
      const price = ref.kind === 'perp' ? await perpPrice(ref.venue, ref.symbol) : Number((await fetchTicker24h(ref.venue, ref.symbol)).lastPrice)
      return Number.isFinite(price) && price > 0 ? price : null
    } catch {
      return null
    }
  }
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

/** A book's trades settled and moved out of the settings, kept whole: stopped, paper, a book's, with their result.
 * Returns how many were kept. */
export async function archiveSettled(value: unknown): Promise<number> {
  const executors = (Array.isArray(value) ? value : []).filter(
    (executor): executor is ExecutorConfig =>
      typeof executor === 'object' && executor !== null && (executor as ExecutorConfig).status === 'stopped' && bookOf(executor as ExecutorConfig) !== 'other' && (executor as ExecutorConfig).book?.result !== undefined
  )
  if (executors.length === 0) return 0
  await appendJsonLines(join(booksSeam.dir(), `archive-${monthOf(booksSeam.now())}.jsonl`), executors)
  return executors.length
}

/** The books' settled trades moved out of the settings, each once. */
async function archived(): Promise<ExecutorConfig[]> {
  const dir = booksSeam.dir()
  const out = new Map<string, ExecutorConfig>()
  for (const { name } of await listMonthFiles(dir, /^archive-(\d{4}-\d{2})\.jsonl$/).catch(() => [])) {
    for (const raw of await linesOf(join(dir, name))) {
      const executor = raw as ExecutorConfig
      if (typeof executor?.id === 'string' && bookOf(executor) !== 'other' && executor.book?.result !== undefined) out.set(executor.id, executor)
    }
  }
  return [...out.values()]
}

/** Every book's standing now, from the settings' executors and the settled ones moved out of them. */
export async function bookStandings(): Promise<{ running: boolean; startedAt: number | null; standings: BookStanding[] }> {
  const settings = await getSettings()
  const books = healPaperBooks(settings.paperBooks)
  const current = (settings.executors ?? []) as ExecutorConfig[]
  const ids = new Set(current.map((executor) => executor.id))
  const executors = [...current, ...(await archived()).filter((executor) => !ids.has(executor.id))]
  const startedAt = books.startedAt ?? 0
  // Each open trade of a book's run priced once, its result from its own stamp (shared/bookValuation.ts).
  const open = executors.filter((executor) => executor.status === 'active' && bookOf(executor) !== 'other' && executor.book?.startedAt === startedAt)
  const refs = new Map<string, BookPriceRef>()
  for (const executor of open) {
    const ref = bookPriceRefOf(executor)
    if (ref !== null) refs.set(priceRefKey(ref), ref)
  }
  const prices = new Map(await Promise.all([...refs].map(async ([key, ref]) => [key, await booksSeam.price(ref)] as const)))
  const nowMs = booksSeam.now() * 1000
  const openResult = (executor: ExecutorConfig): number | null => {
    const ref = bookPriceRefOf(executor)
    const px = ref === null ? null : (prices.get(priceRefKey(ref)) ?? null)
    return px === null ? null : bookOpenNetOf(executor, px, nowMs)
  }
  const standings: BookStanding[] = []
  for (const id of BOOK_IDS) {
    const standing = bookStandingOf(id, books.books[id], executors, startedAt, openResult)
    // The day's start, from the run's marks: what the daily stop reads.
    const marks = books.startedAt === null ? [] : await listEquityMarks(id, books.startedAt).catch(() => [])
    standings.push({ ...standing, dayStartEquity: books.startedAt === null ? null : dayStartEquityOf(marks, booksSeam.now(), standing.startQuote) })
  }
  return { running: books.running, startedAt: books.startedAt, standings }
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
