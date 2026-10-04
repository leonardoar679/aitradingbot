import { app } from 'electron'
import { appendFile, mkdir, open, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  ledgerMonthKey,
  matchesAiCallFilter,
  parseAiCallLines,
  type AiCallFilter,
  type AiCallPage,
  type AiCallRecord
} from '../../shared/aiLedger'
import { summarizeUsage, type AiUsageSummary } from '../../shared/aiCost'
import { utcDayKey } from './dailyUsage'

// The call ledger on disk: one JSON line per call, one file per UTC month, append-only.
//
// APPENDED, NOT REWRITTEN. Every other store in this app is one JSON document replaced whole
// through writeJsonAtomic, which is right for a few kilobytes of state. A run here writes 672 rows
// and the history only grows; rewriting the whole file for each row is quadratic, and a crash
// mid-rewrite would risk every row instead of one. An append can lose at most the line being
// written.
//
// WHAT A TORN LINE COSTS. A crash part-way through an append leaves a final line with no newline.
// The reader skips it and counts it. The danger is the NEXT append: written straight after the
// torn fragment it would join onto it and be unreadable too. So the first append to each file in a
// session checks how the file ends and starts a fresh line if it has to.

const FILE_PATTERN = /^calls-(\d{4}-\d{2})\.jsonl$/
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 5000
const USAGE_WINDOW_SEC = 30 * 24 * 60 * 60
const NEWLINE = 0x0a

const appendQueues = new Map<string, Promise<void>>()
/** Files whose last byte is known to be a newline, because this process put it there. */
const cleanlyEnded = new Set<string>()

function ledgerDir(): string {
  return join(app.getPath('userData'), 'aiLedger')
}

async function endsWithNewline(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return true // No file yet: nothing to be torn.
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return true
    const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1)
    return buffer[0] === NEWLINE
  } finally {
    await handle.close()
  }
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true })
  let prefix = ''
  if (!cleanlyEnded.has(path)) {
    if (!(await endsWithNewline(path))) prefix = '\n'
    cleanlyEnded.add(path)
  }
  await appendFile(path, `${prefix}${line}\n`, 'utf-8')
}

/** Appends one row. Serialised per file so that rows land in the order they were appended.
 *
 * The reader returns newest-first by walking each file backwards, which is only true if file order
 * is append order. Concurrent appendFile calls go through a thread pool that does not keep it:
 * measured with sixty appended at once, they land shuffled. (They do not corrupt one another --
 * each small append is written whole -- so the queue is here for order, not for integrity.) */
export async function appendAiCall(record: AiCallRecord): Promise<void> {
  const path = join(ledgerDir(), `calls-${ledgerMonthKey(record.at)}.jsonl`)
  const previous = appendQueues.get(path) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => appendLine(path, JSON.stringify(record)))
  appendQueues.set(
    path,
    next.catch(() => undefined)
  )
  return next
}

/** Newest rows first, reading month files backwards and stopping as soon as enough are found. */
async function scan(filter: AiCallFilter, limit: number): Promise<AiCallPage> {
  let names: string[]
  try {
    names = await readdir(ledgerDir())
  } catch {
    return { rows: [], skippedLines: 0 }
  }
  const oldestMonth = filter.sinceSec !== undefined ? ledgerMonthKey(filter.sinceSec) : null
  const rows: AiCallRecord[] = []
  let skippedLines = 0

  for (const name of names.filter((entry) => FILE_PATTERN.test(entry)).sort().reverse()) {
    const month = FILE_PATTERN.exec(name)?.[1] ?? ''
    if (oldestMonth !== null && month < oldestMonth) break
    const parsed = parseAiCallLines(await readFile(join(ledgerDir(), name), 'utf-8'))
    skippedLines += parsed.skipped
    for (let i = parsed.rows.length - 1; i >= 0; i--) {
      if (!matchesAiCallFilter(parsed.rows[i], filter)) continue
      rows.push(parsed.rows[i])
      if (rows.length >= limit) return { rows, skippedLines }
    }
  }
  return { rows, skippedLines }
}

export async function listAiCalls(filter: AiCallFilter): Promise<AiCallPage> {
  const requested = Math.floor(filter.limit ?? DEFAULT_LIMIT)
  return scan(filter, Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LIMIT)))
}

/** Calls, tokens and dollars per model, for today and for the last thirty days. Unbounded by the
 * page limit on purpose: a total that silently stops counting at 5,000 rows is not a total. */
export async function getAiUsageSummary(): Promise<AiUsageSummary> {
  const nowSec = Math.floor(Date.now() / 1000)
  const page = await scan({ sinceSec: nowSec - USAGE_WINDOW_SEC }, Number.POSITIVE_INFINITY)
  const todayKey = utcDayKey(nowSec)
  return {
    today: summarizeUsage(page.rows.filter((row) => utcDayKey(row.at) === todayKey)),
    last30Days: summarizeUsage(page.rows),
    skippedLines: page.skippedLines
  }
}
