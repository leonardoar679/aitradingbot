import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  healAlertRecord,
  healPaperRefusalRecord,
  healRecordFilter,
  parseRecordLines,
  recordMonthKey,
  type AlertRecordOnFile,
  type PaperRefusalRecord
} from '../../shared/records'
import { appendJsonLine, listMonthFiles } from './jsonlStore'

// THE RECORDS ON FILE (shared/records.ts): the app's own paper trades refused, and the alerts told.
// One JSON line per record, one file per UTC month, append-only, like the call ledger and the
// scanner's events (jsonlStore.ts). The renderer sends each record as it happens and reads a span
// back; what it sends is healed here before it is written, and healed again as it is read, so a
// line that is not a record is skipped and counted, never obeyed. Nothing here decides anything.

const REFUSAL_FILES = /^refusals-(\d{4}-\d{2})\.jsonl$/
const ALERT_FILES = /^alerts-(\d{4}-\d{2})\.jsonl$/

function refusalsDir(): string {
  return join(app.getPath('userData'), 'paperRefusals')
}

function alertsDir(): string {
  return join(app.getPath('userData'), 'alerts')
}

/** Newest first: month files newest first, each read backwards, stopping at the month before the
 * filter's and at the limit. */
async function readSince<T extends { at: number }>(dir: string, pattern: RegExp, heal: (value: unknown) => T | null, filter: unknown): Promise<{ rows: T[]; skippedLines: number }> {
  const { sinceSec, limit } = healRecordFilter(filter)
  const oldestMonth = recordMonthKey(sinceSec)
  const rows: T[] = []
  let skippedLines = 0
  for (const { name, month } of await listMonthFiles(dir, pattern)) {
    if (month < oldestMonth) break
    const parsed = parseRecordLines(await readFile(join(dir, name), 'utf-8'), heal)
    skippedLines += parsed.skipped
    for (let i = parsed.rows.length - 1; i >= 0; i--) {
      const row = parsed.rows[i]
      if (row.at < sinceSec) continue
      rows.push(row)
      if (rows.length >= (limit ?? Number.POSITIVE_INFINITY)) return { rows, skippedLines }
    }
  }
  return { rows, skippedLines }
}

/** Writes one refusal, as the renderer sent it, once healed. Resolves to the record written, or null
 * for one that was not a refusal. */
export async function appendPaperRefusal(value: unknown): Promise<PaperRefusalRecord | null> {
  const record = healPaperRefusalRecord(value)
  if (record === null) return null
  await appendJsonLine(join(refusalsDir(), `refusals-${recordMonthKey(record.at)}.jsonl`), record)
  return record
}

export function readPaperRefusalsSince(filter: unknown): Promise<{ rows: PaperRefusalRecord[]; skippedLines: number }> {
  return readSince(refusalsDir(), REFUSAL_FILES, healPaperRefusalRecord, filter)
}

/** Writes one alert as told, once healed. */
export async function appendAlert(value: unknown): Promise<AlertRecordOnFile | null> {
  const record = healAlertRecord(value)
  if (record === null) return null
  await appendJsonLine(join(alertsDir(), `alerts-${recordMonthKey(record.at)}.jsonl`), record)
  return record
}

export function readAlertsSince(filter: unknown): Promise<{ rows: AlertRecordOnFile[]; skippedLines: number }> {
  return readSince(alertsDir(), ALERT_FILES, healAlertRecord, filter)
}
