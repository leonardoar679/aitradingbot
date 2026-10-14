import { healAlertKind, type AlertKind, type AlertSeverity } from './alerts'

// RECORDS THE APP KEPT ONLY IN MEMORY, NOW ON FILE (the V4 document, §48 and §97): the app's own
// paper trades refused, each with why, and the alerts raised. Both were kept for the session only,
// so a restart lost them, the session report reached back no further than the app's start, and a
// trade's timeline could only say that a reason "was not recorded". Each is now one JSON line in a
// file per UTC month, appended by the main process (electron/services/recordStoreService.ts) and
// read back by the session report, the trade's timeline and Overview.
//
// A RECORD, NOT A RULE. Nothing reads either file to decide anything: a refusal on file is what
// was refused and why, an alert on file is what was told. The rules that refuse and tell are
// where they were.

/** A paper trade of the app's own that was not opened, and why: the watch's, on a model's call,
 * or the news rules', on an announcement. */
export interface PaperRefusalRecord {
  id: string
  /** Seconds. */
  at: number
  source: 'watch' | 'news'
  symbol: string
  /** The sentence the writer gave. */
  text: string
  /** The event the call was about, and the model and the ledger row of the call, where the refusal
   * was of a call: what joins it to the trade's timeline. Absent on a news rule's. */
  eventId?: string
  model?: string
  callId?: string
  side?: 'buy' | 'sell'
  /** `restart` (the V5 document, §94; since 8 October 2026): written at start for an answer the
   * app was not running to act on (shared/restartMisses.ts). Absent on every other refusal. */
  stage?: 'restart'
}

/** An alert as told: what the badge counted and the banner showed. Whether it was seen or dismissed
 * is the session's, not the record's. */
export interface AlertRecordOnFile {
  id: string
  /** Seconds. */
  at: number
  severity: AlertSeverity
  title: string
  body: string
  url?: string
  /** Since every notice carries a kind (shared/alerts.ts): what it was, and its thread. Absent on
   * alerts written before. */
  kind?: AlertKind
  thread?: string
  /** The sound it made (shared/sounds.ts; V6 Stage 13): chosen where it was raised, else by its kind.
   * Absent on alerts written before. */
  sound?: import('./sounds').NoticeSound
}

export interface RecordFilter {
  /** Records at or after this, in seconds. */
  sinceSec: number
  /** At most this many, newest first. */
  limit?: number
}

export const RECORDS_DEFAULT_LIMIT = 2000
export const RECORDS_MAX_LIMIT = 20_000

const SEVERITIES: readonly AlertSeverity[] = ['info', 'watch', 'high', 'critical']
const SOURCES = ['watch', 'news'] as const
const SIDES = ['buy', 'sell'] as const

/** `2026-10`, the UTC month a record is filed under. */
export function recordMonthKey(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 7)
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : null
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

/** A refusal as one is written or read: the fields it must have, each of the shape it must be, or
 * null. A line that is not one is skipped and counted, never obeyed. */
export function healPaperRefusalRecord(value: unknown): PaperRefusalRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id, 120)
  const at = seconds(raw.at)
  const symbol = text(raw.symbol, 30)
  const body = text(raw.text, 600)
  if (id === null || at === null || symbol === null || body === null) return null
  if (!SOURCES.includes(raw.source as (typeof SOURCES)[number])) return null
  const record: PaperRefusalRecord = { id, at, source: raw.source as PaperRefusalRecord['source'], symbol, text: body }
  const eventId = text(raw.eventId, 120)
  const model = text(raw.model, 120)
  const callId = text(raw.callId, 120)
  if (eventId !== null) record.eventId = eventId
  if (model !== null) record.model = model
  if (callId !== null) record.callId = callId
  if (SIDES.includes(raw.side as (typeof SIDES)[number])) record.side = raw.side as PaperRefusalRecord['side']
  if (raw.stage === 'restart') record.stage = 'restart'
  return record
}

/** An alert as one is written or read, by the same rule. */
export function healAlertRecord(value: unknown): AlertRecordOnFile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id, 200)
  const at = seconds(raw.at)
  const title = text(raw.title, 200)
  const body = text(raw.body, 1000)
  if (id === null || at === null || title === null || body === null) return null
  if (!SEVERITIES.includes(raw.severity as AlertSeverity)) return null
  const record: AlertRecordOnFile = { id, at, severity: raw.severity as AlertSeverity, title, body }
  const url = text(raw.url, 500)
  if (url !== null && /^https:\/\//.test(url)) record.url = url
  const kind = healAlertKind(raw.kind)
  if (kind !== null) record.kind = kind
  const thread = text(raw.thread, 200)
  if (thread !== null) record.thread = thread
  // The sound it made (V6 Stage 13), kept: until V6 Stage 15's run found it, healing dropped it, and no
  // notice on file said what it sounded like.
  const sound = raw.sound
  if (sound === 'information' || sound === 'opportunity' || sound === 'warning' || sound === 'critical' || sound === 'none') record.sound = sound
  return record
}

/** The rows of a file, oldest first as written, each healed; a line that is not JSON or not a record
 * is skipped and counted. */
export function parseRecordLines<T>(content: string, heal: (value: unknown) => T | null): { rows: T[]; skipped: number } {
  const rows: T[] = []
  let skipped = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      skipped++
      continue
    }
    const record = heal(parsed)
    if (record === null) skipped++
    else rows.push(record)
  }
  return { rows, skipped }
}

/** The filter as one is asked: a time, and a limit held to the range. */
export function healRecordFilter(value: unknown): RecordFilter {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const sinceSec = seconds(raw.sinceSec) ?? 0
  const requested = typeof raw.limit === 'number' && Number.isFinite(raw.limit) ? Math.floor(raw.limit) : RECORDS_DEFAULT_LIMIT
  return { sinceSec, limit: Math.min(RECORDS_MAX_LIMIT, Math.max(1, requested)) }
}
