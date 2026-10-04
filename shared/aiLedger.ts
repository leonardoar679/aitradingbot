import type { AiAgentReport, AiAgentRole } from './aiPanel'
import type { AiCallSource, AiCallUsage, AiPositionState, AiRecommendation, AiSignalDetail } from './aiSignal'
import type { Exchange, Interval } from './ipc'

// One row per call to a model: what was asked, what it cost, and what came back.
//
// Before this existed the app could say how MANY calls a bot made and nothing else. There was no
// record of which model answered, what a call cost, or what it had said an hour later when the
// market had moved -- so "is this model any good" could only be answered by a seven-day paid
// backtest producing eight or nine trades, which is too few to answer it (research/gptneed.ts).
// Every row here is a decision that can be scored against the candles that followed it.
//
// The rows are append-only JSON lines, written by electron/services/aiLedgerService.ts. The
// parsing lives here, pure, so it can be tested without a filesystem.

/** `ok`: a usable answer. `rejected`: the model answered and the validator refused it.
 * `failed`: the model was never reached, or never finished. Only the first two were billed. */
export type AiCallStatus = 'ok' | 'rejected' | 'failed'

export interface AiCallRecord {
  /** The decision's cache key when the model answered; a random id when it did not. Stable for an
   * answered call, so the same decision can never appear as two rows. */
  id: string
  /** Unix seconds when the call finished. */
  at: number
  source: AiCallSource
  status: AiCallStatus
  model: string
  /** Which upstream provider OpenRouter routed to, when it says. */
  provider: string | null
  promptVersion: string
  contextVersion: string
  schemaVersion: string
  exchange: Exchange
  symbol: string
  interval: Interval
  /** Open time of the candle the decision executes on. */
  candleTime: number
  position: AiPositionState
  /** The last close the model was shown. */
  referencePrice: number
  usage: AiCallUsage
  /** The transport failure or the validator's reason; null for a usable answer. */
  error: string | null
  recommendation: AiRecommendation | null
  confidence: number | null
  rationale: string | null
  detail: AiSignalDetail | null
  /** Set when the call reviewed an entry a strategy had signalled (shared/aiConfirm.ts): which
   * strategy. Absent on a standalone signal. On a review, "buy" confirmed the entry and anything
   * else vetoed it, and `candleTime` is the bar the strategy signalled on -- the bar whose close
   * the entry fills at. */
  strategyId?: string
  /** Set when the call answered an opportunity question (shared/aiOpportunity.ts): the event it
   * was asked about, as the scanner names it, and that event's type. `candleTime` is then the
   * event's time -- the 1-minute bar the call executes on -- and `referencePrice` the event's
   * price, which is what the levels were placed against. */
  eventId?: string
  eventType?: string
  /** Set when the call was a route's second opinion (shared/aiRoute.ts): the model whose answer
   * sent the decision on. Absent on every other call -- including this same answer when a
   * benchmark or a backtest bought it first, since a decision is only ever one row. */
  escalatedFrom?: string
  /** Set on a call made for a panel of agents (shared/aiPanel.ts): which of its four calls this
   * was. An analyst's row carries a `report` and no recommendation -- it made no call on the
   * market to score -- and `decision` is the row that did. `model` is always the model that was
   * actually asked, so what a panel spends is counted under the model it spent it on. */
  agent?: AiAgentRole | 'decision'
  /** An analyst's report, on its row. Absent when it could not be used. */
  report?: AiAgentReport
}

export interface AiCallFilter {
  /** Newest rows first, at most this many. */
  limit?: number
  exchange?: Exchange
  symbol?: string
  model?: string
  /** Only calls made under this prompt. A model's history is several prompts' worth -- a signal,
   * an entry review, a panel's four -- and "its last fifty calls" is not "its last fifty of these". */
  promptVersion?: string
  source?: AiCallSource
  status?: AiCallStatus
  /** Only rows finished at or after this time. */
  sinceSec?: number
}

export interface AiCallPage {
  rows: AiCallRecord[]
  /** Lines that could not be read. Reported rather than swallowed: a ledger that quietly drops
   * rows is a ledger whose totals cannot be trusted. */
  skippedLines: number
}

const STATUSES: readonly string[] = ['ok', 'rejected', 'failed']

/** `2026-10`, the UTC month a row is filed under. One file per month keeps any single read small
 * and lets a query for recent rows stop without opening the whole history. */
export function ledgerMonthKey(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 7)
}

function isAiCallRecord(value: unknown): value is AiCallRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.at === 'number' &&
    typeof row.status === 'string' &&
    STATUSES.includes(row.status) &&
    typeof row.model === 'string' &&
    typeof row.symbol === 'string' &&
    typeof row.candleTime === 'number' &&
    typeof row.usage === 'object' &&
    row.usage !== null
  )
}

/** Reads a ledger file's text, oldest row first.
 *
 * A line that does not parse is counted and skipped, never thrown on. The realistic cause is a
 * crash part-way through an append, which leaves one torn final line; refusing the whole file for
 * it would hide every good row above it. */
export function parseAiCallLines(text: string): { rows: AiCallRecord[]; skipped: number } {
  const rows: AiCallRecord[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isAiCallRecord(parsed)) rows.push(parsed)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { rows, skipped }
}

export function matchesAiCallFilter(row: AiCallRecord, filter: AiCallFilter): boolean {
  if (filter.exchange !== undefined && row.exchange !== filter.exchange) return false
  if (filter.symbol !== undefined && row.symbol.toUpperCase() !== filter.symbol.toUpperCase()) return false
  if (filter.model !== undefined && row.model !== filter.model) return false
  if (filter.promptVersion !== undefined && row.promptVersion !== filter.promptVersion) return false
  if (filter.source !== undefined && row.source !== filter.source) return false
  if (filter.status !== undefined && row.status !== filter.status) return false
  if (filter.sinceSec !== undefined && row.at < filter.sinceSec) return false
  return true
}
