import type { AiCallSource } from '../../shared/aiSignal'
import { isActionableOpportunity, opportunitySide, opportunityWindow } from '../../shared/aiOpportunity'
import type { OpportunityExit, OpportunityStatus } from '../../shared/aiOpportunityOutcome'
import type { AiCallRecord } from '../../shared/aiLedger'
import type { Candle } from '../../shared/ipc'
import type { MarketEventType } from '../../shared/marketEvent'
import { csvField } from '../backtest/exportResults'
import { scoreAnswer, type EventFeedItem } from './opportunities'

// THE JOURNAL: every recommendation a model has made on an event the scanner raised, one line
// each, with what it did.
//
// The cards on the Opportunities tab show the last few events. This is the whole record of them,
// in one table that can be filtered and saved as a spreadsheet: what was called, at what
// confidence, with what levels, and how it ended.
//
// NOTHING HERE IS STORED, AND NOTHING ASKS A MODEL. A line is the ledger's row for an answer,
// joined to the scanner's record of its event, and scored from candles when it is looked at --
// the same scoring as a card (shared/aiOpportunityOutcome.ts). A recommendation not yet scored
// says so instead of showing a result.

export type JournalCall = 'BUY' | 'SELL' | 'NO TRADE' | 'REFUSED'
/** `no trade`: it called none, or was refused. `not acted on`: a side under the confidence this
 * app acts on. `not scored`: a call to act on whose candles have not been read. The rest are what
 * following it did. */
export type JournalStatus = 'no trade' | 'not acted on' | 'not scored' | OpportunityStatus

export interface JournalRow {
  eventId: string
  /** The event's time, Unix seconds. */
  time: number
  symbol: string
  eventType: MarketEventType
  band: string
  score: number
  model: string
  source: AiCallSource | null
  /** When the answer arrived. */
  answeredAt: number
  call: JournalCall
  confidence: number
  entryMin: number | null
  entryMax: number | null
  stopLoss: number | null
  takeProfit: number | null
  expiresAt: number | null
  holdSeconds: number | null
  status: JournalStatus
  entryTime: number | null
  entryPrice: number | null
  exit: OpportunityExit | null
  exitTime: number | null
  netPct: number | null
  bestPct: number | null
  worstPct: number | null
  heldMinutes: number | null
  costUsd: number | null
  latencyMs: number | null
  /** True when the watch opened a paper trade on this answer. */
  paperTrade: boolean
}

/** One line an answer, newest event first. `sources` says where each answer came from, by
 * `eventId:model`; `paper` holds the `eventId:model` of every answer the watch paper traded. */
export function journalRows(
  feed: EventFeedItem[],
  bars: ReadonlyMap<string, Candle[]>,
  nowSec: number,
  sources: ReadonlyMap<string, AiCallSource> = new Map(),
  paper: ReadonlySet<string> = new Set()
): JournalRow[] {
  const rows: JournalRow[] = []
  for (const item of feed) {
    const { event } = item
    for (const answer of item.answers) {
      const { decision } = answer
      const side = opportunitySide(decision)
      const detail = decision.detail ?? null
      const validity = opportunityWindow(event.time, detail)
      const acted = isActionableOpportunity(decision)
      const held = bars.get(event.id)
      const outcome = acted && held !== undefined ? scoreAnswer(item, answer, held, nowSec) : null
      const key = `${event.id}:${answer.model}`
      rows.push({
        eventId: event.id,
        time: event.time,
        symbol: event.symbol,
        eventType: event.type,
        band: event.band,
        score: event.score,
        model: answer.model,
        source: sources.get(key) ?? null,
        answeredAt: answer.answeredAt,
        call: decision.rejected ? 'REFUSED' : side === 'long' ? 'BUY' : side === 'short' ? 'SELL' : 'NO TRADE',
        confidence: decision.confidence,
        entryMin: side !== null && detail?.entry ? detail.entry.min : null,
        entryMax: side !== null && detail?.entry ? detail.entry.max : null,
        stopLoss: side !== null ? (detail?.stopLoss ?? null) : null,
        takeProfit: side !== null ? (detail?.takeProfit ?? null) : null,
        expiresAt: side !== null && validity !== null ? validity.expiresAt : null,
        holdSeconds: side !== null && validity !== null ? validity.holdSeconds : null,
        status: side === null ? 'no trade' : !acted ? 'not acted on' : outcome === null ? 'not scored' : outcome.status,
        entryTime: outcome?.entryTime ?? null,
        entryPrice: outcome?.entryPrice ?? null,
        exit: outcome?.exit ?? null,
        exitTime: outcome?.exitTime ?? null,
        netPct: outcome?.netPct ?? null,
        bestPct: outcome?.bestPct ?? null,
        worstPct: outcome?.worstPct ?? null,
        heldMinutes: outcome?.heldMinutes ?? null,
        costUsd: decision.usage?.costUsd ?? null,
        latencyMs: decision.usage?.latencyMs ?? null,
        paperTrade: paper.has(key)
      })
    }
  }
  return rows.sort((a, b) => b.time - a.time || a.symbol.localeCompare(b.symbol) || a.model.localeCompare(b.model))
}

/** Where each first answer came from, by `eventId:model`: the watch, a click, or a benchmark. The
 * feed keeps a model's first answer for an event, so this keeps the first row's source too. */
export function answerSources(calls: Pick<AiCallRecord, 'at' | 'status' | 'eventId' | 'model' | 'source'>[]): Map<string, AiCallSource> {
  const sources = new Map<string, AiCallSource>()
  for (const row of [...calls].sort((a, b) => a.at - b.at)) {
    if (row.eventId === undefined || row.status === 'failed') continue
    const key = `${row.eventId}:${row.model}`
    if (!sources.has(key)) sources.set(key, row.source)
  }
  return sources
}

export interface JournalFilter {
  model?: string
  /** Matched anywhere in the pair's name, in any case. */
  symbol?: string
  call?: JournalCall
  /** Events at or after this time, and before that one. */
  fromSec?: number
  toSec?: number
}

export function filterJournal(rows: JournalRow[], filter: JournalFilter): JournalRow[] {
  const symbol = filter.symbol?.trim().toUpperCase() ?? ''
  return rows.filter(
    (row) =>
      (filter.model === undefined || row.model === filter.model) &&
      (symbol === '' || row.symbol.toUpperCase().includes(symbol)) &&
      (filter.call === undefined || row.call === filter.call) &&
      (filter.fromSec === undefined || row.time >= filter.fromSec) &&
      (filter.toSec === undefined || row.time < filter.toSec)
  )
}

export interface JournalTotals {
  rows: number
  acted: number
  closed: number
  wins: number
  netSumPct: number
  costUsd: number
}

/** What the lines on screen add up to. A sum of closed trades, and a count: not a rate. */
export function journalTotals(rows: JournalRow[]): JournalTotals {
  const closed = rows.filter((row) => row.status === 'closed')
  return {
    rows: rows.length,
    acted: rows.filter((row) => row.status !== 'no trade' && row.status !== 'not acted on').length,
    closed: closed.length,
    wins: closed.filter((row) => (row.netPct ?? 0) > 0).length,
    netSumPct: closed.reduce((sum, row) => sum + (row.netPct ?? 0), 0),
    costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
  }
}

function iso(sec: number | null): string {
  return sec === null ? '' : new Date(sec * 1000).toISOString().replace('.000Z', 'Z')
}

function num(value: number | null, digits = 8): string | number {
  return value === null || !Number.isFinite(value) ? '' : Number(value.toPrecision(digits))
}

const CSV_COLUMNS: { head: string; cell: (row: JournalRow) => string | number }[] = [
  { head: 'event_time_utc', cell: (row) => iso(row.time) },
  { head: 'pair', cell: (row) => row.symbol },
  { head: 'event', cell: (row) => row.eventType },
  { head: 'band', cell: (row) => row.band },
  { head: 'event_score', cell: (row) => num(row.score, 4) },
  { head: 'model', cell: (row) => row.model },
  { head: 'asked_by', cell: (row) => row.source ?? '' },
  { head: 'answered_utc', cell: (row) => iso(row.answeredAt) },
  { head: 'call', cell: (row) => row.call },
  { head: 'confidence', cell: (row) => num(row.confidence, 4) },
  { head: 'entry_min', cell: (row) => num(row.entryMin) },
  { head: 'entry_max', cell: (row) => num(row.entryMax) },
  { head: 'stop', cell: (row) => num(row.stopLoss) },
  { head: 'target', cell: (row) => num(row.takeProfit) },
  { head: 'entry_valid_until_utc', cell: (row) => iso(row.expiresAt) },
  { head: 'hold_minutes', cell: (row) => (row.holdSeconds === null ? '' : Math.round(row.holdSeconds / 60)) },
  { head: 'status', cell: (row) => row.status },
  // The minute a thing happened in, as its candle is named: by when it opened. A trade that
  // entered in the 01:29 minute and left in the 01:39 one was in the market for eleven of them.
  { head: 'entered_minute_utc', cell: (row) => iso(row.entryTime) },
  { head: 'entry_price', cell: (row) => num(row.entryPrice) },
  { head: 'exit', cell: (row) => row.exit ?? '' },
  { head: 'exited_minute_utc', cell: (row) => iso(row.exitTime) },
  { head: 'net_pct', cell: (row) => num(row.netPct, 6) },
  { head: 'best_pct', cell: (row) => num(row.bestPct, 6) },
  { head: 'worst_pct', cell: (row) => num(row.worstPct, 6) },
  { head: 'held_minutes', cell: (row) => (row.heldMinutes === null ? '' : row.heldMinutes) },
  { head: 'answer_cost_usd', cell: (row) => num(row.costUsd, 6) },
  { head: 'answer_seconds', cell: (row) => (row.latencyMs === null ? '' : Number((row.latencyMs / 1000).toFixed(1))) },
  { head: 'paper_trade_by_watch', cell: (row) => (row.paperTrade ? 'yes' : 'no') }
]

/** The lines as a spreadsheet: one row an answer, a header first. Times are UTC, percentages are
 * net of fees and slippage, and an empty cell is a thing that did not happen or is not known. */
export function journalCsv(rows: JournalRow[]): string {
  const lines = [CSV_COLUMNS.map((column) => csvField(column.head)).join(',')]
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvField(column.cell(row))).join(','))
  return `${lines.join('\r\n')}\r\n`
}
