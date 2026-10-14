import type { AiHelpRow, AiHelpVerdict } from './aiHelp'
import type { ExecutorConfig } from './ipc'
import { positionSlippageRate } from './fees'
import { rMultiple } from './paperRisk'
import type { ReportVersions, SessionReport, SessionReportInput } from './shadowReport'
import type { ForecastRunSection } from './forecast/runSection'

// EXPERIMENTS IN THE APP (the V5 document, §56-62 and §124-126; V5 Stage 9, 8 October 2026). A run
// is a record: when it began, when it ends, what mode the app was in, the versions it ran under, the
// models and the universe, and, once it has ended, its report. The main process keeps the record and
// the clock (electron/services/experimentRunService.ts: a run continues to its end across a
// restart); the window builds the report at the end from what is on file
// (src/ai-benchmark/experimentReport.ts) and hands it back to be filed. Nothing here asks a model
// or opens a trade: a run measures what the app did by itself over its hours.
//
// THE RECORD IS APPEND-ONLY: one JSON line per change, the newest line for an id winning, so that
// a run's start and its end can be written minutes or hours apart without rewriting a file.

export const EXPERIMENT_RUNS_VERSION = 'experiment-run-v1'

export const EXPERIMENT_KINDS = ['shadow-1h', 'paper-12h', 'custom'] as const
export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number]

/** The minutes each kind runs; a custom run names its own. */
export const EXPERIMENT_KIND_MINUTES: Record<Exclude<ExperimentKind, 'custom'>, number> = { 'shadow-1h': 60, 'paper-12h': 720 }
/** A custom run's bounds, in minutes: a check's three minutes to a week. */
export const EXPERIMENT_MIN_MINUTES = 3
export const EXPERIMENT_MAX_MINUTES = 7 * 24 * 60

/** What the status bar's chip read when the run began: the watch off or asking with no paper trade
 * (SHADOW), with paper trades (PAPER), or with CONFIRM on. */
export type ExperimentMode = 'SHADOW' | 'PAPER' | 'CONFIRM'

export function experimentModeOf(config: { watch: { enabled: boolean; confirmLive: boolean }; watchPaper: { enabled: boolean } }): ExperimentMode {
  if (!config.watch.enabled || !config.watchPaper.enabled) return 'SHADOW'
  return config.watch.confirmLive ? 'CONFIRM' : 'PAPER'
}

export type ExperimentStatus = 'running' | 'ended' | 'reported' | 'stopped'

export interface ExperimentVersions {
  prompt: string
  context: string
  schema: string
  detector: string
  config: string
  engine: string
}

export interface ExperimentRun {
  id: string
  kind: ExperimentKind
  minutes: number
  /** Unix seconds. */
  startedAt: number
  endsAt: number
  mode: ExperimentMode
  versions: ExperimentVersions
  models: string[]
  universe: number
  status: ExperimentStatus
  /** Set when the run was stopped early: when. The report then covers what ran. */
  stoppedAt?: number
  /** Filed by the window once the run has ended; absent until then. */
  report?: ExperimentReport
  reportedAt?: number
}

/** The §60 gates beyond the session report's, each with what it counted. */
export interface ExperimentGate {
  id: 'duplicate_orders' | 'calls_without_event' | 'trades_without_call' | 'silent_failures' | 'long_gaps'
  label: string
  status: 'pass' | 'fail'
  detail: string
}

/** The §126 verdict's inputs, from the app's own paper trades closed in the span. */
export interface ExperimentVerdictFigures {
  closed: number
  netQuote: number
  aiCostUsd: number
  /** The net after fees, less what the answers cost (the quote taken as dollars). */
  netAfterAiUsd: number
  profitFactor: number | null
  /** Deepest fall of the running total in R, trades in time order. */
  maxDrawdownR: number
}

export type ExperimentVerdict = 'YES' | 'NOT YET' | 'NOT ENOUGH TRADES'

/** The verdict's lines (the V5 document, §126), pinned. */
export const VERDICT_LINES = { minTrades: 30, maxDrawdownR: 10, minProfitFactor: 1 } as const

export interface ExperimentReport {
  version: string
  /** The session report over the run's span (shared/shadowReport.ts), gates and all. */
  session: SessionReport
  gates: ExperimentGate[]
  /** "Does AI help?" over the span's events, one entry a model the watch asked. Empty where
   * nothing could be scored. */
  help: { model: string; rows: AiHelpRow[]; verdicts: AiHelpVerdict[] }[]
  costs: { feesQuote: number; slippageQuote: number; aiUsd: number }
  figures: ExperimentVerdictFigures
  verdict: ExperimentVerdict
  /** The price forecast over the span, with its gates (shared/forecast/runSection.ts; V6 Stage 15).
   * Absent on a report filed before, or where the record could not be read. */
  forecast?: ForecastRunSection
  /** Every gate that applies, the session's, these and the forecast's, passed. */
  passed: boolean
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isMode = (value: unknown): value is ExperimentMode => value === 'SHADOW' || value === 'PAPER' || value === 'CONFIRM'
const isKind = (value: unknown): value is ExperimentKind => (EXPERIMENT_KINDS as readonly unknown[]).includes(value)
const isStatus = (value: unknown): value is ExperimentStatus => value === 'running' || value === 'ended' || value === 'reported' || value === 'stopped'

/** A line of the runs file, read as a record; null for a line that is not one. The report is kept
 * as written: it was built by the app and is read back whole. */
export function healExperimentRun(value: unknown): ExperimentRun | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const versions = raw.versions as Record<string, unknown> | undefined
  if (typeof raw.id !== 'string' || raw.id === '' || !isKind(raw.kind) || !finite(raw.minutes) || !finite(raw.startedAt) || !finite(raw.endsAt) || !isMode(raw.mode) || !isStatus(raw.status)) return null
  if (typeof versions !== 'object' || versions === null || !Array.isArray(raw.models) || !finite(raw.universe)) return null
  const text = (entry: unknown): string => (typeof entry === 'string' ? entry : '')
  return {
    id: raw.id,
    kind: raw.kind,
    minutes: raw.minutes,
    startedAt: raw.startedAt,
    endsAt: raw.endsAt,
    mode: raw.mode,
    versions: { prompt: text(versions.prompt), context: text(versions.context), schema: text(versions.schema), detector: text(versions.detector), config: text(versions.config), engine: text(versions.engine) },
    models: raw.models.filter((model): model is string => typeof model === 'string'),
    universe: raw.universe,
    status: raw.status,
    ...(finite(raw.stoppedAt) ? { stoppedAt: raw.stoppedAt } : {}),
    ...(typeof raw.report === 'object' && raw.report !== null ? { report: raw.report as ExperimentReport } : {}),
    ...(finite(raw.reportedAt) ? { reportedAt: raw.reportedAt } : {})
  }
}

/** The runs file's lines folded: the newest line for each id is the run as it stands, newest first. */
export function foldExperimentRuns(lines: readonly ExperimentRun[]): ExperimentRun[] {
  const byId = new Map<string, ExperimentRun>()
  for (const run of lines) byId.set(run.id, run)
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
}

export function parseExperimentRunLines(text: string): { rows: ExperimentRun[]; skipped: number } {
  const rows: ExperimentRun[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const run = healExperimentRun(JSON.parse(line))
      if (run === null) skipped++
      else rows.push(run)
    } catch {
      skipped++
    }
  }
  return { rows: foldExperimentRuns(rows), skipped }
}

/** Where a run stands at `nowSec`: running until its end passes, then ended until its report is
 * filed. A stopped run is ended at the moment it was stopped. */
export function experimentStatusAt(run: Pick<ExperimentRun, 'status' | 'endsAt' | 'stoppedAt' | 'report'>, nowSec: number): ExperimentStatus {
  if (run.report !== undefined) return 'reported'
  if (run.status === 'stopped' || run.stoppedAt !== undefined) return 'stopped'
  return nowSec >= run.endsAt ? 'ended' : 'running'
}

/** The span a run's report covers: from its start to its end, or to when it was stopped. */
export function experimentSpan(run: Pick<ExperimentRun, 'startedAt' | 'endsAt' | 'stoppedAt'>): { fromSec: number; toSec: number } {
  return { fromSec: run.startedAt, toSec: run.stoppedAt !== undefined ? Math.min(run.stoppedAt, run.endsAt) : run.endsAt }
}

/** A run's minutes, from its kind, or from what a custom run asked for, held to the bounds. */
export function experimentMinutesOf(kind: ExperimentKind, minutes?: number | null): number {
  if (kind !== 'custom') return EXPERIMENT_KIND_MINUTES[kind]
  const asked = finite(minutes) ? Math.round(minutes) : EXPERIMENT_MIN_MINUTES
  return Math.min(EXPERIMENT_MAX_MINUTES, Math.max(EXPERIMENT_MIN_MINUTES, asked))
}

export function experimentIdOf(startedAt: number, existing: readonly string[]): string {
  const stamp = new Date(startedAt * 1000).toISOString().slice(0, 16).replace('T', '-').replace(':', '')
  let id = `run-${stamp}`
  let n = 2
  while (existing.includes(id)) id = `run-${stamp}-${n++}`
  return id
}

export function describeExperimentKind(kind: ExperimentKind, minutes: number): string {
  if (kind === 'shadow-1h') return 'One hour'
  if (kind === 'paper-12h') return 'Twelve hours'
  return minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}` : `${minutes} minutes`
}

/** The app's own paper trades: the watch's and the news rules'. */
function ownTrades(executors: readonly ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.mode === 'paper' && executor.type === 'position' && (executor.watch !== undefined || executor.newsRule !== undefined))
}

const within = (time: number, span: { fromSec: number; toSec: number }): boolean => time >= span.fromSec && time <= span.toSec
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The gates the document adds to the session report's (§60), over the same input: no two of the
 * app's own paper trades from one call; every watch call about an event; every watch trade from a
 * call; every row of the ledger with a status; no gap in the stream over three minutes. Each is a
 * count over the span, and each applies to any span. */
export function experimentGates(input: Pick<SessionReportInput, 'fromSec' | 'toSec' | 'calls' | 'executors' | 'connection'>): ExperimentGate[] {
  const span = { fromSec: input.fromSec, toSec: input.toSec }
  const own = ownTrades(input.executors).filter((executor) => within(executor.createdAt, span))
  const watchTrades = own.filter((executor) => executor.watch !== undefined)
  const byCall = new Map<string, number>()
  for (const executor of watchTrades) {
    const callId = executor.watch?.callId
    if (callId !== undefined) byCall.set(callId, (byCall.get(callId) ?? 0) + 1)
  }
  const duplicated = [...byCall.values()].filter((count) => count > 1).length
  const watchCalls = input.calls.filter((row) => row.source === 'watch' && within(row.at, span))
  const withoutEvent = watchCalls.filter((row) => row.eventId === undefined).length
  const withoutCall = watchTrades.filter((executor) => executor.watch?.callId === undefined).length
  const inSpan = input.calls.filter((row) => within(row.at, span))
  const silent = inSpan.filter((row) => row.status !== 'ok' && row.status !== 'rejected' && row.status !== 'failed').length
  // A gap still open has no end yet: it runs to the span's end.
  const gaps = input.connection === null ? [] : input.connection.gaps.filter((gap) => (gap.to ?? Number.POSITIVE_INFINITY) > span.fromSec && gap.from < span.toSec)
  const long = gaps.filter((gap) => Math.min(gap.to ?? span.toSec, span.toSec) - Math.max(gap.from, span.fromSec) > 180).length
  return [
    {
      id: 'duplicate_orders',
      label: 'No two paper trades from one call',
      status: duplicated === 0 ? 'pass' : 'fail',
      detail: duplicated === 0 ? `Each of the ${plural(watchTrades.length, 'watch trade', 'watch trades')} follows a call of its own.` : `${plural(duplicated, 'call', 'calls')} opened more than one paper trade.`
    },
    {
      id: 'calls_without_event',
      label: 'Every watch call names its event',
      status: withoutEvent === 0 ? 'pass' : 'fail',
      detail: withoutEvent === 0 ? `Each of the ${plural(watchCalls.length, 'watch call', 'watch calls')} names the event it was about.` : `${plural(withoutEvent, 'watch call names', 'watch calls name')} no event.`
    },
    {
      id: 'trades_without_call',
      label: 'Every watch trade names its call',
      status: withoutCall === 0 ? 'pass' : 'fail',
      detail: withoutCall === 0 ? `Each of the ${plural(watchTrades.length, 'watch trade', 'watch trades')} names the call it followed.` : `${plural(withoutCall, 'watch trade names', 'watch trades name')} no call.`
    },
    {
      id: 'silent_failures',
      label: 'No silent AI failure',
      status: silent === 0 ? 'pass' : 'fail',
      detail: silent === 0 ? `Each of the ${plural(inSpan.length, 'call', 'calls')} has a status: answered, refused or failed.` : `${plural(silent, 'row', 'rows')} of the ledger carry no status.`
    },
    {
      id: 'long_gaps',
      label: 'No stream gap over three minutes',
      status: long === 0 ? 'pass' : 'fail',
      detail: input.connection === null ? "The stream's log could not be read, so no gap is counted." : long === 0 ? `${plural(gaps.length, 'gap', 'gaps')} in the span, none over three minutes.` : `${plural(long, 'gap', 'gaps')} over three minutes.`
    }
  ]
}

/** The §126 figures over the app's own paper trades closed in the span, and what the answers cost. */
export function experimentFigures(input: Pick<SessionReportInput, 'fromSec' | 'toSec' | 'executors' | 'calls'>): ExperimentVerdictFigures {
  const span = { fromSec: input.fromSec, toSec: input.toSec }
  const closed = ownTrades(input.executors)
    .map((executor) => ({ executor, result: executor.watch?.result ?? executor.newsRule?.result }))
    .filter((entry): entry is { executor: ExecutorConfig; result: NonNullable<ExecutorConfig['watch']>['result'] & object } => entry.result !== undefined && within(entry.result.closedAt, span))
    .sort((a, b) => a.result.closedAt - b.result.closedAt)
  let wins = 0
  let losses = 0
  let net = 0
  let running = 0
  let peak = 0
  let drawdown = 0
  for (const { executor, result } of closed) {
    net += result.pnlQuote
    if (result.pnlQuote > 0) wins += result.pnlQuote
    else losses += -result.pnlQuote
    const params = executor.params as { amountQuote: number; stopLossPct: number | null; slippageRate?: number | null }
    const r = rMultiple(result.pnlQuote, params) ?? 0
    running += r
    peak = Math.max(peak, running)
    drawdown = Math.max(drawdown, peak - running)
  }
  const aiCostUsd = input.calls.filter((row) => within(row.at, span)).reduce((sum, row) => sum + (row.usage?.costUsd ?? 0), 0)
  return {
    closed: closed.length,
    netQuote: net,
    aiCostUsd,
    netAfterAiUsd: net - aiCostUsd,
    profitFactor: losses > 0 ? wins / losses : null,
    maxDrawdownR: drawdown
  }
}

/** YES when, over thirty closed trades or more, the net after fees and the answers' cost is above
 * nought, gains cover losses, and the deepest fall stayed under ten R; NOT ENOUGH TRADES under
 * thirty; NOT YET otherwise. */
export function experimentVerdictOf(figures: ExperimentVerdictFigures): ExperimentVerdict {
  if (figures.closed < VERDICT_LINES.minTrades) return 'NOT ENOUGH TRADES'
  const profitable = figures.netAfterAiUsd > 0 && (figures.profitFactor === null || figures.profitFactor > VERDICT_LINES.minProfitFactor)
  return profitable && figures.maxDrawdownR < VERDICT_LINES.maxDrawdownR ? 'YES' : 'NOT YET'
}

/** What the span's trades gave up to slippage, as the engine charges it: each fill at its rate. */
export function experimentSlippageQuote(input: Pick<SessionReportInput, 'fromSec' | 'toSec' | 'executors'>): number {
  const span = { fromSec: input.fromSec, toSec: input.toSec }
  let total = 0
  for (const executor of ownTrades(input.executors)) {
    const result = executor.watch?.result ?? executor.newsRule?.result
    if (result === undefined || !within(result.closedAt, span) || result.exit === 'entry_expired' || result.exit === 'btc_moved') continue
    const params = executor.params as { amountQuote: number; slippageRate?: number | null }
    total += params.amountQuote * 2 * positionSlippageRate(params)
  }
  return total
}

/** The report, from the session report over the span and the input it was built from. */
export function experimentReportOf(input: { session: SessionReport; sessionInput: SessionReportInput; help: ExperimentReport['help']; forecast?: ForecastRunSection | null }): ExperimentReport {
  const gates = experimentGates(input.sessionInput)
  const figures = experimentFigures(input.sessionInput)
  const feesQuote = input.session.paper.fees.reduce((sum, entry) => sum + entry.amount, 0)
  const forecast = input.forecast ?? null
  return {
    version: EXPERIMENT_RUNS_VERSION,
    session: input.session,
    gates,
    help: input.help,
    costs: { feesQuote, slippageQuote: experimentSlippageQuote(input.sessionInput), aiUsd: input.session.calls.costUsd },
    figures,
    verdict: experimentVerdictOf(figures),
    ...(forecast === null ? {} : { forecast }),
    passed: input.session.passed && gates.every((gate) => gate.status === 'pass') && (forecast === null || forecast.passed)
  }
}

export function describeExperimentVerdict(verdict: ExperimentVerdict, figures: ExperimentVerdictFigures): string {
  const head = `AI ADDING VALUE: ${verdict}.`
  if (verdict === 'NOT ENOUGH TRADES') return `${head} ${figures.closed} of the ${VERDICT_LINES.minTrades} closed paper trades the verdict needs.`
  const pf = figures.profitFactor === null ? 'no losing trade to divide by' : `gains over losses ${figures.profitFactor.toFixed(2)}`
  return `${head} ${figures.closed} closed trades: net ${figures.netQuote.toFixed(2)} after fees, ${figures.netAfterAiUsd.toFixed(2)} after the answers' $${figures.aiCostUsd.toFixed(2)}; ${pf}; deepest fall ${figures.maxDrawdownR.toFixed(1)} R.`
}

/** The versions a run records, as the report names them (shared/shadowReport.ts ReportVersions). */
export function experimentVersionsOf(versions: ExperimentVersions): ReportVersions {
  return { config: versions.config, engine: versions.engine, detector: versions.detector, prompts: [versions.prompt], schemas: [versions.schema] }
}
