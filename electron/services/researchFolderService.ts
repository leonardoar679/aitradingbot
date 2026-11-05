import { app } from 'electron'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'node:util'
import { deflateRaw, gzip } from 'node:zlib'
import { parseAiCallLines, type AiCallRecord } from '../../shared/aiLedger'
import { routingTableOf, type RoutedBot } from '../../shared/aiRouting'
import type { AppSettings } from '../../shared/ipc'
import {
  AI_REQUEST_COLUMNS,
  EXPORT_PATTERN,
  EXPORT_SOURCES,
  RESEARCH_FOLDER,
  RESEARCH_LINES,
  PAPER_TRADE_COLUMNS,
  RESEARCH_VERSION,
  TRADER_EXPORT_FILES,
  aiRequestCsvRow,
  aiRequestLine,
  csvOf,
  exportFileName,
  exportsToSweep,
  hashTraderIds,
  inExportWindow,
  nextDailyExportAt,
  paperAccountEvents,
  paperOrderEvents,
  paperTradeRows,
  redactSecrets,
  scrubKeyPatterns,
  type AiRequestLine,
  type ExportManifest,
  type ManifestFile,
  type PaperOrderEvent,
  type ResearchExport,
  type ResearchStatus
} from '../../shared/research'
import { zipArchive, type ZipEntry } from '../../shared/zip'
import { traderRefOfKey } from '../../shared/traders/traderRef'
import { executorsWithArchive } from './booksService'
import { fetchHistoricalRange } from './marketService'
import { getAiConfig } from './aiConfigService'
import { onAiCallAppended } from './aiLedgerService'
import { getEffectiveConfig } from './effectiveConfigService'
import { getSettings, onSettingsWritten } from './settingsService'

// THE RESEARCH FOLDER (V7.2-R Stage 2, 20 October 2026; shared/research.ts): what the app keeps for analysis
// elsewhere, written as it runs, and the daily ZIP of it with the records it does not copy. Everything here
// reads the app's own files and writes into <userData>/trader-spider-research/; it reads no key (the export is
// an allowlist that names none, and the settings and AI config go in only as redacted copies), asks no model
// and places nothing.

const deflateAsync = promisify(deflateRaw)
const gzipAsync = promisify(gzip)

let started = false
let exportTimer: ReturnType<typeof setTimeout> | null = null
let lastExport: ResearchStatus['lastExport'] = null
let exporting: Promise<ResearchExport> | null = null

export function researchDir(): string {
  return join(app.getPath('userData'), RESEARCH_FOLDER)
}
const sub = (name: string): string => join(researchDir(), name)

/** Writes a file whole, through a temporary name, so that an export or a reader never sees half of it. */
async function writeWhole(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** What the app runs under, as JSON, every secret field left out: the effective configuration, who asks which
 * model, the AI config and the settings. Written at start, hourly and before every export. */
export async function writeConfigSnapshots(): Promise<void> {
  await mkdir(sub('config'), { recursive: true })
  const [effective, ai, settings] = await Promise.all([getEffectiveConfig(), getAiConfig(), getSettings()])
  const bots = (settings.bots ?? []) as RoutedBot[]
  await writeWhole(join(sub('config'), 'effective-config.json'), json(redactSecrets(effective)))
  await writeWhole(join(sub('config'), 'ai-config.json'), json(redactSecrets(ai)))
  await writeWhole(join(sub('config'), 'settings.json'), json(redactSecrets(settings)))
  await writeWhole(
    join(sub('config'), 'model-routing.json'),
    json({ version: RESEARCH_VERSION, at: new Date().toISOString(), defaultModel: ai.defaultModel, roles: ai.roles, enabledModels: ai.enabledModels, callers: routingTableOf(ai, bots) })
  )
}

// THE LOGS: the main process's errors and warnings, and every AI call as the ledger appends it (who asked, the
// model asked and the one that answered, the provider, the time, the tokens, the cost), a JSON line each,
// rotated past RESEARCH_LINES.logRotateBytes into gzip'd numbered files, the newest RESEARCH_LINES.logsKept kept.
// A line that cannot be written is dropped without a word: a log that logged its own failure would loop.

let logQueue: Promise<void> = Promise.resolve()
let writesSinceCheck = 0
const LOG_FILES = ['application.jsonl', 'errors.jsonl', 'ai-requests.jsonl'] as const

/** Rotates a log past `limit` bytes: the file gzip'd to <name>.1.jsonl.gz, the older ones shifted, the oldest
 * past `kept` deleted. Exported for its test. */
export async function rotateLog(path: string, limit: number = RESEARCH_LINES.logRotateBytes, kept: number = RESEARCH_LINES.logsKept): Promise<boolean> {
  const size = await stat(path).then((entry) => entry.size).catch(() => 0)
  if (size <= limit) return false
  const base = path.replace(/\.jsonl$/, '')
  await rm(`${base}.${kept}.jsonl.gz`, { force: true })
  for (let k = kept - 1; k >= 1; k--) await rename(`${base}.${k}.jsonl.gz`, `${base}.${k + 1}.jsonl.gz`).catch(() => undefined)
  const text = await readFile(path)
  await writeWhole(`${base}.1.jsonl.gz`, await gzipAsync(text))
  await writeFile(path, '')
  return true
}

/** A console argument as text: an error's stack, a string as it is, anything else as JSON where it can be. */
function textOf(part: unknown): string {
  if (part instanceof Error) return part.stack ?? part.message
  if (typeof part === 'string') return part
  try {
    return JSON.stringify(part) ?? String(part)
  } catch {
    return String(part)
  }
}

/** Lines appended to the folder's logs, in order; every 200 writes the logs are rotated where they are past
 * their limit. */
function appendLogs(lines: { file: (typeof LOG_FILES)[number]; line: string }[]): void {
  logQueue = logQueue
    .then(async () => {
      await mkdir(sub('logs'), { recursive: true })
      for (const entry of lines) await appendFile(join(sub('logs'), entry.file), entry.line)
      if (++writesSinceCheck >= 200) {
        writesSinceCheck = 0
        for (const file of LOG_FILES) await rotateLog(join(sub('logs'), file))
      }
    })
    .catch(() => undefined)
}

function logLine(level: 'error' | 'warn', parts: unknown[]): void {
  const text = parts.map(textOf).join(' ')
  const line = `${JSON.stringify({ at: new Date().toISOString(), level, text: text.slice(0, 4000) })}\n`
  appendLogs(level === 'error' ? [{ file: 'application.jsonl', line }, { file: 'errors.jsonl', line }] : [{ file: 'application.jsonl', line }])
}

/** An AI call as the ledger appends it: a line of the folder's AI request log. */
function noteAiCall(record: AiCallRecord): void {
  appendLogs([{ file: 'ai-requests.jsonl', line: `${JSON.stringify(aiRequestLine(record))}\n` }])
}

/** The main process's console.error and console.warn, also written to the folder's logs. */
function installLogSink(): void {
  const error = console.error.bind(console)
  const warn = console.warn.bind(console)
  console.error = (...parts: unknown[]): void => {
    error(...parts)
    logLine('error', parts)
  }
  console.warn = (...parts: unknown[]): void => {
    warn(...parts)
    logLine('warn', parts)
  }
}

// THE TRADES: each paper or demo order's opening, end and stop, and the paper account's money, as the settings
// are written (shared/research.ts paperOrderEvents, paperAccountEvents), a month file each.

let tradeQueue: Promise<void> = Promise.resolve()

function noteSettings(before: AppSettings, after: AppSettings): void {
  const nowSec = Math.floor(Date.now() / 1000)
  const orders = paperOrderEvents(before.executors ?? [], after.executors ?? [], nowSec)
  const money = paperAccountEvents(before.paperAccount?.ledger, after.paperAccount?.ledger)
  if (orders.length === 0 && money.length === 0) return
  const month = new Date(nowSec * 1000).toISOString().slice(0, 7)
  tradeQueue = tradeQueue
    .then(async () => {
      await mkdir(sub('trades'), { recursive: true })
      if (orders.length > 0) await appendFile(join(sub('trades'), `paper-orders-${month}.jsonl`), orders.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
      if (money.length > 0) await appendFile(join(sub('trades'), `paper-account-${month}.jsonl`), money.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    })
    .catch((failure) => console.error('The research folder could not record a paper trade:', failure))
}

/** The trade log's queue drained: for a test, and before an export. */
export function researchWritesSettled(): Promise<void> {
  return Promise.all([tradeQueue, logQueue]).then(() => undefined)
}

// THE REPORTS: the hour's and the day's, as the window builds them (src/performance/ResearchReportScheduler.tsx),
// each kept by its stamp, and the latest of each kind under a fixed name.

const REPORT_KINDS = ['hour', 'day'] as const
const STAMP = { hour: /^\d{4}-\d{2}-\d{2}-\d{2}$/, day: /^\d{4}-\d{2}-\d{2}$/ } as const
/** Reports older than this are deleted at start: an export holds the last fortnight's. */
const REPORT_DAYS_KEPT = 60

export async function writeResearchReport(request: { kind: unknown; stamp: unknown; report: unknown }): Promise<{ ok: boolean; path: string }> {
  const kind = request.kind
  if (!REPORT_KINDS.includes(kind as 'hour')) throw new Error('A research report is an hour\'s or a day\'s')
  const stamp = String(request.stamp)
  if (!STAMP[kind as 'hour'].test(stamp)) throw new Error(`Not a stamp for an ${String(kind)}'s report: ${stamp}`)
  if (typeof request.report !== 'object' || request.report === null) throw new Error('A research report is an object')
  await mkdir(sub('reports'), { recursive: true })
  const report = redactSecrets(request.report) as Record<string, unknown>
  const body = json({ version: RESEARCH_VERSION, kind, stamp, writtenAt: new Date().toISOString(), ...report })
  const path = join(sub('reports'), `${String(kind)}-${stamp}.json`)
  await writeWhole(path, body)
  // The latest of each, under a fixed name: the day's summary, and the forecast's and the paper's of either.
  if (kind === 'day') await writeWhole(join(sub('reports'), 'daily-summary.json'), body)
  if (report.forecast !== undefined) await writeWhole(join(sub('reports'), 'forecast-accuracy.json'), json({ kind, stamp, forecast: report.forecast }))
  if (report.paper !== undefined) await writeWhole(join(sub('reports'), 'paper-performance.json'), json({ kind, stamp, paper: report.paper }))
  return { ok: true, path }
}

async function sweepOldReports(nowSec: number): Promise<void> {
  const names = await readdir(sub('reports')).catch(() => [] as string[])
  const cutoff = new Date((nowSec - REPORT_DAYS_KEPT * 86_400) * 1000).toISOString().slice(0, 10)
  for (const name of names) {
    const day = /^(?:hour|day)-(\d{4}-\d{2}-\d{2})/.exec(name)?.[1]
    if (day !== undefined && day < cutoff) await unlink(join(sub('reports'), name)).catch(() => undefined)
  }
}

// THE EXPORT: the allowlist's files in the window, the derived AI request log, the run in use's calibration,
// and a manifest, packed into exports/<name>.zip; the newest RESEARCH_LINES.exportsKept kept.

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** The AI calls of the window, a line each (shared/research.ts aiRequestLine), from the ledger's month files:
 * the whole window, where the folder's own log holds only the calls since it started. */
async function aiRequestsOf(fromSec: number): Promise<AiRequestLine[]> {
  const dir = join(app.getPath('userData'), 'aiLedger')
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => /^calls-\d{4}-\d{2}\.jsonl$/.test(name)).sort()
  const lines: AiRequestLine[] = []
  for (const name of names) {
    const { rows } = parseAiCallLines(await readFile(join(dir, name), 'utf-8').catch(() => ''))
    for (const row of rows) if (row.at >= fromSec) lines.push(aiRequestLine(row))
  }
  return lines
}

const PAPER_ORDERS = /^paper-orders-(\d{4}-\d{2})\.jsonl$/

/** The paper orders' events of the month files the export packs, in the order they were written. */
async function paperEventsOf(nowSec: number): Promise<PaperOrderEvent[]> {
  const source = { from: `${RESEARCH_FOLDER}/trades`, match: PAPER_ORDERS, to: 'trades', window: 'month' as const }
  const names = (await readdir(sub('trades')).catch(() => [] as string[])).filter((name) => inExportWindow(source, name, nowSec)).sort()
  const events: PaperOrderEvent[] = []
  for (const name of names) {
    for (const line of (await readFile(join(sub('trades'), name), 'utf-8').catch(() => '')).split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line) as PaperOrderEvent
        if (typeof event.id === 'string' && (event.kind === 'opened' || event.kind === 'closed' || event.kind === 'stopped')) events.push(event)
      } catch {
        // A torn last line: the events above it stand.
      }
    }
  }
  return events
}

const encoded = (body: string): Uint8Array => new TextEncoder().encode(body)

/** A trader's token in an export (V8 Stage 10): its key hashed, so that an export shows how a trader did and not who. */
export const traderTokenOf = (key: string): string => `trader-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`

/** A contract named for a multiple of its coin -- Binance's perpetuals write a thousand PEPE as 1000PEPEUSDT, a million
 * MOG as 1000000MOGUSDT and a million BABYDOGE as 1MBABYDOGEUSDT -- read on Bitget's spot market, which may list only
 * the coin's own pair (V8 Stage 12: the three-day run's export asked Bitget for 1000PEPEUSDT and was told it does not
 * exist): that pair and the multiple its prices are read at; null for any other name. */
export function multipleOf(symbol: string): { symbol: string; multiple: number } | null {
  const match = /^(1000000|1000|1M)([A-Z][A-Z0-9]*USDT)$/.exec(symbol)
  return match === null ? null : { symbol: match[2], multiple: match[1] === '1000' ? 1_000 : 1_000_000 }
}

/** Bitget's spans read at most, the newest first, and the longest one may be (V8 Stage 10). */
const BITGET_SPANS_MAX = 30
const BITGET_SPAN_MAX_SEC = 86_400
const BITGET_SPAN_MARGIN_SEC = 300

/** The pairs traded in the window and when: the books' trades and the paper orders', each a span, the newest first. */
async function tradedSpans(events: readonly PaperOrderEvent[], fromSec: number, nowSec: number): Promise<{ symbol: string; fromSec: number; toSec: number }[]> {
  const spans: { symbol: string; fromSec: number; toSec: number }[] = []
  for (const executor of await executorsWithArchive().catch(() => [])) {
    if (executor.book === undefined || executor.mode !== 'paper') continue
    const end = executor.book.result?.closedAt ?? (executor.status === 'active' ? nowSec : executor.stoppedAt ?? nowSec)
    spans.push({ symbol: executor.symbol, fromSec: executor.createdAt ?? end, toSec: end })
  }
  const opened = new Map<string, PaperOrderEvent>()
  for (const event of events) {
    if (event.kind === 'opened') opened.set(event.id, event)
    else if (opened.has(event.id)) {
      const start = opened.get(event.id) as PaperOrderEvent
      spans.push({ symbol: start.symbol, fromSec: start.at, toSec: event.at })
      opened.delete(event.id)
    }
  }
  for (const start of opened.values()) spans.push({ symbol: start.symbol, fromSec: start.at, toSec: nowSec })
  const padded = spans
    .filter((span) => /^[A-Z0-9]{2,30}$/.test(span.symbol) && span.toSec >= fromSec && span.fromSec <= nowSec)
    .map((span) => ({ symbol: span.symbol, fromSec: Math.max(span.fromSec, span.toSec - BITGET_SPAN_MAX_SEC) - BITGET_SPAN_MARGIN_SEC, toSec: Math.min(nowSec, span.toSec + BITGET_SPAN_MARGIN_SEC) }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.fromSec - b.fromSec))
  // A pair traded more than once at a time, or again within the margins, is one span: one file of its bars (found by
  // V8 Stage 12's rehearsal, two of the copy book's trades of SOL opening in one minute named one file twice and the
  // archive refused the export).
  const merged: { symbol: string; fromSec: number; toSec: number }[] = []
  for (const span of padded) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.symbol === span.symbol && span.fromSec <= last.toSec) last.toSec = Math.max(last.toSec, span.toSec)
    else merged.push({ ...span })
  }
  return merged
    .map((span) => ({ ...span, fromSec: Math.max(span.fromSec, span.toSec - BITGET_SPAN_MAX_SEC - 2 * BITGET_SPAN_MARGIN_SEC) }))
    .sort((a, b) => b.toSec - a.toSec)
    .slice(0, BITGET_SPANS_MAX)
}

async function makeExport(reason: 'daily' | 'manual'): Promise<ResearchExport> {
  const userData = app.getPath('userData')
  const nowSec = Math.floor(Date.now() / 1000)
  await writeConfigSnapshots().catch((failure) => console.error('The research folder could not write its configuration:', failure))
  await researchWritesSettled()
  const entries: ZipEntry[] = []
  const skipped: { path: string; why: string }[] = []
  const add = async (path: string, name: string): Promise<void> => {
    try {
      const [data, info] = await Promise.all([readFile(path), stat(path)])
      entries.push({ name, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mtime: info.mtime })
    } catch (failure) {
      skipped.push({ path: name, why: failure instanceof Error ? failure.message : String(failure) })
    }
  }
  for (const source of EXPORT_SOURCES) {
    const dir = join(userData, source.from)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names.sort()) if (inExportWindow(source, name, nowSec)) await add(join(dir, name), `${source.to}/${name}`)
  }
  // The run in use's calibration: what the forecast in the record was read by.
  try {
    const current = JSON.parse(await readFile(join(userData, 'forecastModels', 'current.json'), 'utf-8')) as { foldsRunId?: unknown; runId?: unknown }
    const run = typeof current.foldsRunId === 'string' ? current.foldsRunId : typeof current.runId === 'string' ? current.runId : null
    if (run !== null && /^run-\d{8}-\d{4}$/.test(run)) await add(join(userData, 'forecastModels', run, 'calibration.json'), 'forecasts/models/calibration.json')
  } catch {
    // No model in use yet: nothing to add.
  }
  // The derived files: the window's AI requests as lines and as a table, and the paper trades as a table.
  const made = new Date(nowSec * 1000)
  const requests = await aiRequestsOf(nowSec - RESEARCH_LINES.exportWindowDays * 86_400)
  entries.push({ name: 'logs/ai-requests.jsonl', data: encoded(requests.map((line) => `${JSON.stringify(line)}\n`).join('')), mtime: made })
  entries.push({ name: 'logs/ai-requests.csv', data: encoded(csvOf(AI_REQUEST_COLUMNS, requests.map(aiRequestCsvRow))), mtime: made })
  const paperEvents = await paperEventsOf(nowSec)
  const trades = paperTradeRows(paperEvents).map((row) => ({ ...row }) as Record<string, unknown>)
  entries.push({ name: 'trades/paper-trades.csv', data: encoded(csvOf(PAPER_TRADE_COLUMNS, trades)), mtime: made })
  // The traders on file (V8 Stage 10): each one's month files in the window and its state, under a token in place of
  // its key; and Bitget's one-minute bars of each pair traded in the window, over its trade, a second venue's prices
  // to check the first's by.
  const tokens: { id: string; token: string }[] = []
  const tradersDir = join(userData, 'traders')
  for (const key of (await readdir(tradersDir).catch(() => [] as string[])).sort()) {
    const ref = traderRefOfKey(key)
    if (ref === null) continue
    const token = traderTokenOf(key)
    tokens.push({ id: key, token }, { id: ref.id, token })
    const source = { from: `traders/${key}`, match: TRADER_EXPORT_FILES.month, to: `traders/${token}`, window: 'month' as const }
    for (const name of (await readdir(join(tradersDir, key)).catch(() => [] as string[])).sort()) {
      if (inExportWindow(source, name, nowSec) || TRADER_EXPORT_FILES.whole.test(name)) await add(join(tradersDir, key, name), `traders/${token}/${name}`)
    }
  }
  for (const span of await tradedSpans(paperEvents, nowSec - RESEARCH_LINES.exportWindowDays * 86_400, nowSec)) {
    const name = `market/bitget-1m/${span.symbol}-${new Date(span.fromSec * 1000).toISOString().slice(0, 16).replace(/[-:]/g, '')}.jsonl`
    // The pair as traded, then, for a contract named for a multiple of its coin, the coin's own pair at that multiple:
    // its prices times the multiple and its volume in the contract's units, each bar naming the pair it was read from.
    const multiple = multipleOf(span.symbol)
    const reads = [{ symbol: span.symbol, multiple: 1 }, ...(multiple === null ? [] : [multiple])]
    const failures: string[] = []
    for (const { symbol, multiple: times } of reads) {
      try {
        const read = await fetchHistoricalRange('bitget', symbol, '1m', span.fromSec, span.toSec, `export-${name}`, () => undefined)
        if (read.candles.length === 0) throw new Error(`Bitget returned no bars of ${symbol}`)
        // Twelve figures, past which a product is the float's noise (0.0047339999999999995).
        const at = (value: number): number => Number(value.toPrecision(12))
        const bars =
          times === 1
            ? read.candles
            : read.candles.map((bar) => ({ time: bar.time, open: at(bar.open * times), high: at(bar.high * times), low: at(bar.low * times), close: at(bar.close * times), volume: at(bar.volume / times), bitgetSymbol: symbol, multiple: times }))
        entries.push({ name, data: encoded(bars.map((bar) => `${JSON.stringify(bar)}\n`).join('')), mtime: made })
        break
      } catch (failure) {
        failures.push(failure instanceof Error ? failure.message : String(failure))
      }
    }
    if (failures.length === reads.length) skipped.push({ path: name, why: failures.join('; ') })
  }
  // Every text file: each trader's key and id as its token, and every value shaped like a key replaced.
  let scrubbed = 0
  for (const entry of entries) {
    if (!/\.(?:jsonl|json|csv)$/.test(entry.name)) continue
    const cleaned = scrubKeyPatterns(hashTraderIds(new TextDecoder().decode(entry.data), tokens))
    scrubbed += cleaned.scrubbed
    entry.data = encoded(cleaned.text)
  }
  const effective = await getEffectiveConfig().catch(() => null)
  const manifest: ExportManifest = {
    version: RESEARCH_VERSION,
    madeAt: new Date(nowSec * 1000).toISOString(),
    reason,
    windowDays: RESEARCH_LINES.exportWindowDays,
    app: { version: app.getVersion(), engineVersion: effective?.engineVersion ?? '?', configVersion: effective?.configVersion ?? '?' },
    files: entries.map((entry): ManifestFile => ({ path: entry.name, bytes: entry.data.length, sha256: sha256(entry.data) })),
    skipped,
    traders: tokens.length / 2,
    scrubbed
  }
  entries.push({ name: 'manifest.json', data: new TextEncoder().encode(json(manifest)), mtime: new Date(nowSec * 1000) })
  // Deflated off the main thread, a file at a time.
  for (const entry of entries) {
    const deflated = await deflateAsync(entry.data)
    entry.deflated = new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength)
  }
  const archive = zipArchive(entries)
  await mkdir(sub('exports'), { recursive: true })
  const name = exportFileName(nowSec)
  const path = join(sub('exports'), name)
  await writeWhole(path, archive)
  for (const old of exportsToSweep(await readdir(sub('exports')).catch(() => [] as string[]))) await unlink(join(sub('exports'), old)).catch(() => undefined)
  lastExport = { name, bytes: archive.length, files: entries.length, madeAt: nowSec, reason }
  return { path, name, bytes: archive.length, files: entries.length, madeAt: nowSec, reason, skipped }
}

/** An export now, one at a time: a second asked while one is being made gets that one. */
export function exportResearchBundle(reason: 'daily' | 'manual' = 'manual'): Promise<ResearchExport> {
  if (exporting === null) {
    exporting = makeExport(reason).finally(() => {
      exporting = null
    })
  }
  return exporting
}

function scheduleDailyExport(): void {
  if (exportTimer !== null) clearTimeout(exportTimer)
  const nowSec = Math.floor(Date.now() / 1000)
  exportTimer = setTimeout(
    () => {
      void exportResearchBundle('daily')
        .catch((failure) => console.error('The daily research export failed:', failure))
        .finally(scheduleDailyExport)
    },
    Math.max(1000, (nextDailyExportAt(nowSec) - nowSec) * 1000)
  )
}

export async function getResearchStatus(): Promise<ResearchStatus> {
  const exports = await readdir(sub('exports')).catch(() => [] as string[])
  const sized = await Promise.all(
    exports
      .filter((name) => EXPORT_PATTERN.test(name))
      .sort()
      .reverse()
      .map(async (name) => ({ name, bytes: await stat(join(sub('exports'), name)).then((entry) => entry.size).catch(() => 0) }))
  )
  const reports = await readdir(sub('reports')).catch(() => [] as string[])
  const latest = (kind: 'hour' | 'day'): string | null =>
    reports
      .map((name) => new RegExp(`^${kind}-(\\d{4}-\\d{2}-\\d{2}${kind === 'hour' ? '-\\d{2}' : ''})\\.json$`).exec(name)?.[1])
      .filter((stamp): stamp is string => stamp !== undefined)
      .sort()
      .pop() ?? null
  return { version: RESEARCH_VERSION, dir: researchDir(), exportsDir: sub('exports'), exports: sized, lastExport, nextExportAt: nextDailyExportAt(Math.floor(Date.now() / 1000)), latestHour: latest('hour'), latestDay: latest('day') }
}

/** Starts the folder: its parts, the log sink, the trade log, the configuration's snapshots (now and hourly),
 * the old reports swept, and the daily export. Called once, from electron/main.ts. */
export function startResearchFolder(): void {
  if (started) return
  started = true
  void (async (): Promise<void> => {
    for (const part of ['config', 'logs', 'trades', 'reports', 'exports']) await mkdir(sub(part), { recursive: true })
    installLogSink()
    onSettingsWritten(noteSettings)
    onAiCallAppended(noteAiCall)
    await sweepOldReports(Math.floor(Date.now() / 1000))
    await writeConfigSnapshots()
  })().catch((failure) => console.error('The research folder could not start:', failure))
  setInterval(() => void writeConfigSnapshots().catch(() => undefined), 3_600_000)
  scheduleDailyExport()
}

/** Test seams. */
export const researchForTest = {
  noteSettings,
  noteAiCall,
  reset(): void {
    started = false
    lastExport = null
    exporting = null
    if (exportTimer !== null) clearTimeout(exportTimer)
    exportTimer = null
  }
}
