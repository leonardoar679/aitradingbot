import { app } from 'electron'
import { readFile } from 'fs/promises'
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
import { appendJsonLine, listMonthFiles } from './jsonlStore'

// The call ledger on disk: one JSON line per call, one file per UTC month, append-only. How a
// line is appended, and what a torn one costs, is jsonlStore.ts.

const FILE_PATTERN = /^calls-(\d{4}-\d{2})\.jsonl$/
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 5000
const USAGE_WINDOW_SEC = 30 * 24 * 60 * 60

function ledgerDir(): string {
  return join(app.getPath('userData'), 'aiLedger')
}

/** Appends one row. Rows land in the order they were appended, which is what lets the reader
 * return newest-first by walking each file backwards. */
export async function appendAiCall(record: AiCallRecord): Promise<void> {
  return appendJsonLine(join(ledgerDir(), `calls-${ledgerMonthKey(record.at)}.jsonl`), record)
}

/** Newest rows first, reading month files backwards and stopping as soon as enough are found. */
async function scan(filter: AiCallFilter, limit: number): Promise<AiCallPage> {
  const oldestMonth = filter.sinceSec !== undefined ? ledgerMonthKey(filter.sinceSec) : null
  const rows: AiCallRecord[] = []
  let skippedLines = 0

  for (const { name, month } of await listMonthFiles(ledgerDir(), FILE_PATTERN)) {
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

/** Every row finished at or after `sinceSec`, newest first, however many there are. For counting
 * what a run made (aiExperimentService.ts): a count that stops at a page limit is not a count. */
export async function readAiCallsSince(sinceSec: number): Promise<AiCallPage> {
  return scan({ sinceSec }, Number.POSITIVE_INFINITY)
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
