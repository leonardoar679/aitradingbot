import type { AiCallRecord } from './aiLedger'
import type { AccountLedgerEntry, ExecutorConfig } from './ipc'

// THE RESEARCH RECORD YOU CAN HAND OVER (V7.2-R Stage 2, 20 October 2026). The user runs the app on another
// machine and hands over one file for analysis. So the app keeps a folder of its own, <userData>/trader-spider-
// research/, written as it runs -- config/ (what it runs under, as JSON, with every secret field left out),
// logs/ (its errors and warnings), trades/ (each paper order's life and the paper account's money, as they
// happen), reports/ (the hour's and the day's reports, as the window builds them) -- and packs it, with the
// records it does not copy (the forecasts and their outcomes, the tape, the AI ledger, the alerts, the events,
// the news, the training log, a fortnight of bars), into exports/trader-spider-report-<day>-<time>.zip every day
// at 00:05 UTC and on a click. The archive's layout is the user's: config/, logs/, market/, forecasts/,
// trades/, reports/, with a manifest of every file, its size and its SHA-256.
//
// WHAT GOES IN IS AN ALLOWLIST (EXPORT_SOURCES), never a denylist: a file is packed only when a source names its
// folder and its pattern. The key files -- credentials.json, aiCredentials.json, their backups, the browser's
// Local State -- match no source, and the settings and AI config are packed only as the redacted copies this
// module's redactor writes (redactSecrets: every field named as a secret is, at any depth, left out). Arithmetic
// on records: nothing here reads a key, asks a model or places an order.

export const RESEARCH_VERSION = 'research-v1'
export const RESEARCH_FOLDER = 'trader-spider-research'

export const RESEARCH_LINES = {
  /** The days of records an export holds, back from its moment. */
  exportWindowDays: 14,
  /** Exports kept in exports/: the newest. */
  exportsKept: 14,
  /** A log rotated past this many bytes, gzip'd, and this many rotated kept. */
  logRotateBytes: 20 * 1024 * 1024,
  logsKept: 5,
  /** The daily export, at this UTC time. */
  dailyExportUtc: { hour: 0, minute: 5 }
} as const

/** Field names that held a secret in any file of this app, matched exactly (case aside) at any depth. A name
 * that merely contains one of these words (a class key, a key binding) is not one. */
export const SECRET_FIELDS: readonly string[] = [
  'apiKey',
  'apiSecret',
  'secretKey',
  'secret',
  'passphrase',
  'apiPassphrase',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'privateKey',
  'apiKeyEnc',
  'apiSecretEnc',
  'apiPassphraseEnc'
]
const SECRET = new Set(SECRET_FIELDS.map((name) => name.toLowerCase()))

/** A copy of a value with every secret field left out, at any depth. */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry)) as T
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET.has(key.toLowerCase())) continue
    out[key] = redactSecrets(entry)
  }
  return out as T
}

/** Whether a value still holds a secret field anywhere: what a test asks of every file in an export. */
export function holdsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsSecretField)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) => SECRET.has(key.toLowerCase()) || holdsSecretField(entry))
}

/** One source of the export: a folder of the profile (relative to userData), the files of it packed, where
 * they go in the archive, and which of them: those of a month or a day the window touches, or all. */
export interface ExportSource {
  from: string
  match: RegExp
  to: string
  window: 'month' | 'day' | 'all'
}

/** The allowlist. The month or day of a file is the pattern's last capture group. */
export const EXPORT_SOURCES: readonly ExportSource[] = [
  { from: `${RESEARCH_FOLDER}/config`, match: /^[a-z-]+\.json$/, to: 'config', window: 'all' },
  { from: `${RESEARCH_FOLDER}/logs`, match: /^(?:application|errors)(?:\.\d+)?\.jsonl(?:\.gz)?$/, to: 'logs', window: 'all' },
  { from: `${RESEARCH_FOLDER}/trades`, match: /^paper-(?:orders|account)-(\d{4}-\d{2})\.jsonl$/, to: 'trades', window: 'month' },
  { from: `${RESEARCH_FOLDER}/reports`, match: /^(?:hour|day)-(\d{4}-\d{2}-\d{2})(?:-\d{2})?\.json$/, to: 'reports', window: 'day' },
  { from: `${RESEARCH_FOLDER}/reports`, match: /^(?:daily-summary|forecast-accuracy|paper-performance)\.json$/, to: 'reports', window: 'all' },
  // The challenger's shadow week's record beside the run in use's (V7.2-R Stage 8).
  { from: 'forecasts', match: /^(?:shadow-)?(?:predictions|outcomes|passes)-(\d{4}-\d{2})\.jsonl$/, to: 'forecasts', window: 'month' },
  { from: 'forecasts', match: /^(?:(?:shadow-)?aci\.json|news-outcomes\.jsonl)$/, to: 'forecasts', window: 'all' },
  { from: 'forecasts', match: /^tape-(\d{4}-\d{2}-\d{2})\.jsonl$/, to: 'market/tape', window: 'day' },
  { from: 'forecastData', match: /^[A-Z0-9]+-(\d{4}-\d{2})\.jsonl$/, to: 'market/price-history', window: 'month' },
  { from: 'marketEvents', match: /^(?:events|status)-(\d{4}-\d{2})\.jsonl$/, to: 'market/events', window: 'month' },
  { from: 'news', match: /^(?:feed|reactions)-(\d{4}-\d{2})\.jsonl$/, to: 'market/news', window: 'month' },
  { from: 'aiLedger', match: /^calls-(\d{4}-\d{2})\.jsonl$/, to: 'logs/ai-ledger', window: 'month' },
  { from: 'alerts', match: /^alerts-(\d{4}-\d{2})\.jsonl$/, to: 'logs/alerts', window: 'month' },
  { from: 'paperRefusals', match: /^refusals-(\d{4}-\d{2})\.jsonl$/, to: 'trades/refusals', window: 'month' },
  { from: 'forecastModels', match: /^training-(\d{4}-\d{2})\.jsonl$/, to: 'forecasts/models', window: 'month' },
  { from: 'forecastModels', match: /^current\.json$/, to: 'forecasts/models', window: 'all' },
  // The replay out of sample of the newest walk forward that kept its weeks' models (V7.2-R Stage 5): its summary and
  // its filled trades, the newest replay's alone.
  { from: 'forecastModels', match: /^(?:replay\.json|replay-trades\.jsonl)$/, to: 'forecasts/models', window: 'all' }
]

const dayOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10)
const monthOf = (sec: number): string => dayOf(sec).slice(0, 7)

/** Whether a file of a source is in an export made at `nowSec`: a month or a day the window touches, or any. */
export function inExportWindow(source: ExportSource, name: string, nowSec: number, windowDays: number = RESEARCH_LINES.exportWindowDays): boolean {
  const match = source.match.exec(name)
  if (match === null) return false
  if (source.window === 'all') return true
  const stamp = match[match.length - 1]
  if (stamp === undefined) return false
  const from = nowSec - windowDays * 86_400
  return source.window === 'month' ? stamp >= monthOf(from) && stamp <= monthOf(nowSec) : stamp >= dayOf(from) && stamp <= dayOf(nowSec)
}

/** The source a file of a folder is packed by, or null where none names it. */
export function exportSourceOf(folder: string, name: string): ExportSource | null {
  return EXPORT_SOURCES.find((source) => source.from === folder && source.match.test(name)) ?? null
}

/** An export's name: the moment it was made, to the minute. */
export function exportFileName(nowSec: number): string {
  const iso = new Date(nowSec * 1000).toISOString()
  return `trader-spider-report-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}.zip`
}
export const EXPORT_PATTERN = /^trader-spider-report-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/

/** Of the exports on file, those to delete: all but the newest kept. */
export function exportsToSweep(names: readonly string[], kept: number = RESEARCH_LINES.exportsKept): string[] {
  return names
    .filter((name) => EXPORT_PATTERN.test(name))
    .sort()
    .reverse()
    .slice(kept)
}

/** When the next daily export is due, from a moment: today's 00:05 UTC if still ahead, else tomorrow's. */
export function nextDailyExportAt(nowSec: number): number {
  const day = Math.floor(nowSec / 86_400) * 86_400
  const at = day + RESEARCH_LINES.dailyExportUtc.hour * 3600 + RESEARCH_LINES.dailyExportUtc.minute * 60
  return at > nowSec ? at : at + 86_400
}

/** Where a paper trade came from. */
export type TradeOrigin = 'lab' | 'forecast' | 'watch' | 'news' | 'follow' | 'clone' | 'person'

export function originOf(executor: Pick<ExecutorConfig, 'lab' | 'forecast' | 'watch' | 'newsRule' | 'follow' | 'clone'>): TradeOrigin {
  if (executor.follow !== undefined) return 'follow'
  if (executor.clone !== undefined) return 'clone'
  if (executor.lab !== undefined) return 'lab'
  if (executor.forecast !== undefined) return 'forecast'
  if (executor.watch !== undefined) return 'watch'
  if (executor.newsRule !== undefined) return 'news'
  return 'person'
}

/** How a paper trade ended, where its mark says. */
function resultOf(executor: ExecutorConfig): Record<string, unknown> | null {
  const marks = [executor.lab, executor.forecast, executor.watch, executor.newsRule, executor.book] as ({ result?: unknown } | undefined)[]
  for (const mark of marks) if (mark !== undefined && typeof mark.result === 'object' && mark.result !== null) return mark.result as Record<string, unknown>
  return null
}

/** The mark an order was opened under (the laboratory's, the forecast trader's, the watch's, a news rule's),
 * without its result, every secret field left out; null on a person's own. */
function markOf(executor: ExecutorConfig): Record<string, unknown> | null {
  const mark = (executor.follow ?? executor.clone ?? executor.lab ?? executor.forecast ?? executor.watch ?? executor.newsRule) as Record<string, unknown> | undefined
  if (mark === undefined || typeof mark !== 'object' || mark === null) return null
  return redactSecrets(Object.fromEntries(Object.entries(mark).filter(([key]) => key !== 'result')))
}

/** One moment in a paper (or demo) order's life: opened, ended with its result, or stopped. */
export interface PaperOrderEvent {
  v: string
  at: number
  kind: 'opened' | 'closed' | 'stopped'
  id: string
  type: ExecutorConfig['type']
  mode: ExecutorConfig['mode']
  exchange: ExecutorConfig['exchange']
  symbol: string
  origin: TradeOrigin
  /** The laboratory's strategy, where one opened it. */
  strategy?: string
  /** What it was asked to do: its parameters as set (entry, stop, target, stake), at opening. */
  params?: unknown
  /** The mark it was opened under, at opening, without its result: the forecast it was read from, its plan,
   * the event or the story; absent on a person's own. */
  mark?: Record<string, unknown>
  /** How it ended, at closing. */
  result?: Record<string, unknown>
}

/** What changed in the executors between two writes of the settings: each paper or demo order opened, ended
 * with a result, or stopped, once. A live order is the live record's to keep, and is not a paper trade. */
export function paperOrderEvents(before: readonly ExecutorConfig[], after: readonly ExecutorConfig[], nowSec: number): PaperOrderEvent[] {
  const held = new Map(before.map((executor) => [executor.id, executor]))
  const out: PaperOrderEvent[] = []
  for (const executor of after) {
    if (executor.mode === 'live') continue
    const was = held.get(executor.id)
    const base = {
      v: RESEARCH_VERSION,
      id: executor.id,
      type: executor.type,
      mode: executor.mode,
      exchange: executor.exchange,
      symbol: executor.symbol,
      origin: originOf(executor),
      ...(executor.lab !== undefined ? { strategy: executor.lab.strategy } : {})
    }
    if (was === undefined) {
      const mark = markOf(executor)
      out.push({ ...base, at: executor.createdAt ?? nowSec, kind: 'opened', params: redactSecrets(executor.params), ...(mark === null ? {} : { mark }) })
    }
    const result = resultOf(executor)
    if (result !== null && (was === undefined || resultOf(was) === null)) {
      out.push({ ...base, at: typeof result.closedAt === 'number' ? result.closedAt : nowSec, kind: 'closed', result: redactSecrets(result) })
    }
    if (executor.status === 'stopped' && (was === undefined || was.status !== 'stopped') && result === null) out.push({ ...base, at: executor.stoppedAt ?? nowSec, kind: 'stopped' })
  }
  return out
}

/** The paper account's money movements written since the last settings: each ledger entry once. */
export function paperAccountEvents(before: readonly AccountLedgerEntry[] | undefined, after: readonly AccountLedgerEntry[] | undefined): (AccountLedgerEntry & { v: string })[] {
  const seen = new Set((before ?? []).map((entry) => entry.id))
  return (after ?? []).filter((entry) => !seen.has(entry.id)).map((entry) => ({ v: RESEARCH_VERSION, ...entry }))
}

/** One AI call as the export lists it (logs/ai-requests.jsonl): who asked, which model was asked and which
 * answered, through which provider, how long, how many tokens, what it cost, and how it came back. No
 * fallback is ever taken by this app: a model asked is the only model asked. */
export interface AiRequestLine {
  at: number
  component: string
  role: string | null
  asked: string
  served: string | null
  servedMismatch: 'variant' | 'other' | null
  fallback: null
  provider: string | null
  status: AiCallRecord['status']
  latencyMs: number
  promptTokens: number
  completionTokens: number
  costUsd: number | null
  error: string | null
}

export function aiRequestLine(row: AiCallRecord): AiRequestLine {
  const component = row.source === 'addition' ? `addition:${row.addition ?? '?'}` : row.source === 'bot' ? `bot:${row.botId ?? row.strategyId ?? row.symbol}` : row.source
  return {
    at: row.at,
    component,
    role: row.role ?? null,
    asked: row.model,
    served: row.servedModel ?? null,
    servedMismatch: row.servedMismatch ?? null,
    fallback: null,
    provider: row.provider,
    status: row.status,
    latencyMs: row.usage.latencyMs,
    promptTokens: row.usage.promptTokens,
    completionTokens: row.usage.completionTokens,
    costUsd: row.usage.costUsd,
    error: row.error
  }
}

// THE TABLES: the AI requests and the paper trades as CSV, beside their JSONL, for a spreadsheet.

/** A CSV field (RFC 4180): quoted where it holds a comma, a quote or a line break, a quote doubled; empty for
 * null; an object as its JSON. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** A table as CSV: its header, then a row each, CRLF line ends (what a spreadsheet reads). */
export function csvOf(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  return [columns.join(','), ...rows.map((row) => columns.map((column) => csvField(row[column])).join(','))].join('\r\n') + '\r\n'
}

/** Unix seconds as UTC time, to the second; null where it is not a moment. */
const isoOf = (sec: unknown): string | null => (typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString().slice(0, 19) + 'Z' : null)

export const AI_REQUEST_COLUMNS: readonly string[] = ['time', 'component', 'role', 'asked', 'served', 'servedMismatch', 'fallback', 'provider', 'status', 'latencyMs', 'promptTokens', 'completionTokens', 'costUsd', 'error']

/** An AI request line as a table's row: its moment as UTC time. */
export function aiRequestCsvRow(line: AiRequestLine): Record<string, unknown> {
  return { ...line, time: isoOf(line.at) }
}

/** One paper (or demo) trade, its opening joined to its end, as the export's table lists it. */
export interface PaperTradeRow {
  id: string
  origin: TradeOrigin
  strategy: string | null
  mode: string
  exchange: string
  symbol: string
  side: string | null
  stakeQuote: number | null
  openedAt: string | null
  endedAt: string | null
  end: 'open' | 'closed' | 'stopped'
  exit: string | null
  pnlQuote: number | null
}

export const PAPER_TRADE_COLUMNS: readonly string[] = ['id', 'origin', 'strategy', 'mode', 'exchange', 'symbol', 'side', 'stakeQuote', 'openedAt', 'endedAt', 'end', 'exit', 'pnlQuote']

/** The trades of a run of order events, in the order each first appears: its opening with its end, where one
 * came; a close after a stop is the end. An end whose opening came before the events read is listed with what
 * the end says. */
export function paperTradeRows(events: readonly PaperOrderEvent[]): PaperTradeRow[] {
  const rows = new Map<string, PaperTradeRow>()
  for (const event of events) {
    let row = rows.get(event.id)
    if (row === undefined) {
      row = { id: event.id, origin: event.origin, strategy: event.strategy ?? null, mode: event.mode, exchange: event.exchange, symbol: event.symbol, side: null, stakeQuote: null, openedAt: null, endedAt: null, end: 'open', exit: null, pnlQuote: null }
      rows.set(event.id, row)
    }
    if (event.kind === 'opened') {
      const params = (typeof event.params === 'object' && event.params !== null ? event.params : {}) as Record<string, unknown>
      row.openedAt = isoOf(event.at)
      row.side = typeof params.side === 'string' ? params.side : null
      row.stakeQuote = typeof params.amountQuote === 'number' ? params.amountQuote : null
    } else if (row.end === 'open' || (event.kind === 'closed' && row.end === 'stopped')) {
      row.end = event.kind
      row.endedAt = isoOf(event.at)
      if (event.kind === 'closed') {
        row.exit = typeof event.result?.exit === 'string' ? event.result.exit : null
        row.pnlQuote = typeof event.result?.pnlQuote === 'number' ? event.result.pnlQuote : null
      }
    }
  }
  return [...rows.values()]
}

/** One file of an export, as its manifest lists it. */
export interface ManifestFile {
  path: string
  bytes: number
  sha256: string
}

export interface ExportManifest {
  version: string
  madeAt: string
  /** Why it was made: the daily export, or a click. */
  reason: 'daily' | 'manual'
  windowDays: number
  app: { version: string; engineVersion: string; configVersion: string }
  files: ManifestFile[]
  /** What was left out, and why: a file that could not be read. */
  skipped: { path: string; why: string }[]
}

/** An export made (electron/services/researchFolderService.ts). */
export interface ResearchExport {
  path: string
  name: string
  bytes: number
  files: number
  madeAt: number
  reason: 'daily' | 'manual'
  skipped: { path: string; why: string }[]
}

/** What the research folder stands at, for its card. */
export interface ResearchStatus {
  version: string
  dir: string
  exportsDir: string
  exports: { name: string; bytes: number }[]
  lastExport: { name: string; bytes: number; files: number; madeAt: number; reason: 'daily' | 'manual' } | null
  nextExportAt: number
  /** The newest hour and day reports on file, as their stamps. */
  latestHour: string | null
  latestDay: string | null
}
