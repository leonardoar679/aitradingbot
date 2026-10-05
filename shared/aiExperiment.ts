import { EVENT_BENCHMARK_EVENT_COUNTS, type EventScoring } from './aiEventBenchmark'
import type { AiCallRecord } from './aiLedger'
import { AI_OPPORTUNITY_MAX_MODELS } from './aiOpportunity'
import type { MarketEvent } from './marketEvent'
import { SCAN_HISTORY_MAX_PAIRS, isMarketEvent } from './marketScanner'

// A BENCHMARK RUN, KEPT AS A RUN.
//
// A benchmark on events (shared/aiEventBenchmark.ts) draws its sample from "the N most traded
// pairs" over "the last D days". Both move: the pairs are ranked by the last 24 hours and the days
// by the calendar. The same settings a day later are a different sample -- on 5 October 2026 the
// run of the day before came back with 75 of the 95 events it had compared. The answers bought for
// the rest were still in the cache, and nothing asked for them.
//
// So a run that asked a model leaves a record: which events, found where and when, which models,
// under which versions, at what cost. Opening one reads its events from the record instead of
// drawing them again, so a model asked later is asked about exactly the events the first ones were.
//
// THE EVENTS ARE KEPT WHOLE, NOT AS IDS. An id can be turned back into an event only by the
// detector that found it, and the reason the detector has a version is that it may change.
//
// RESULTS ARE STILL NOT STORED. A record says what was asked. What the answers earned is worked
// out from the cache and from candles each time it is looked at, like every other outcome in this
// app, so a record cannot disagree with the tables beside it.
//
// WHAT A RUN COST IS READ FROM THE LEDGER. The renderer says when a run began and ended and which
// events and models it covered; the calls, the dollars and the versions are counted by the main
// process from the rows those calls wrote. A run that left no row is not recorded at all.

/** The most events one record holds: the largest sample a benchmark draws. */
export const EXPERIMENT_MAX_EVENTS: number = Math.max(...EVENT_BENCHMARK_EVENT_COUNTS)

export interface AiExperimentVersions {
  /** The distinct versions on the run's ledger rows. One of each, unless a run mixed two. */
  prompt: string[]
  context: string[]
  schema: string[]
  /** The detector the events were found by (shared/marketEvent.ts). */
  detector: string
  /** For each model asked, the versions its provider said answered (AiCallRecord.servedModel):
   * what a name like `openai/gpt-5-mini` meant on the day. A model whose rows do not say is left
   * out, and a record written before this was kept has none. */
  served?: Record<string, string[]>
}

export interface AiExperiment {
  /** `EXP-2026-1004-001`: the UTC day the run began, and its number that day. */
  id: string
  /** When the run began and when it ended, in Unix seconds. */
  startedAt: number
  endedAt: number
  /** The stretch of history the events were looked for in, and the pairs it was read on. */
  startSec: number
  endSec: number
  pairs: string[]
  /** Events found there, before sampling. */
  found: number
  /** The sample: every event the run could put to a model, oldest first, as the scan found it. */
  events: MarketEvent[]
  /** The earliest experiment with this same sample, when there is one: this run asked more
   * models about events already recorded. Null on the run that drew them. */
  eventsOf: string | null
  /** The models this run asked. */
  models: string[]
  versions: AiExperimentVersions
  /** The scoring assumptions in force when the run was recorded. */
  scoring: EventScoring
  /** From the ledger: calls a model answered, refused ones included; calls that never reached
   * one; and what the answered ones cost. */
  calls: number
  failed: number
  costUsd: number
  /** Anything to be said about how the record came to be. */
  note: string | null
}

/** What the renderer hands over when a run ends. Everything else on a record is the main
 * process's to work out. */
export interface AiExperimentInput {
  startedAt: number
  endedAt: number
  startSec: number
  endSec: number
  pairs: string[]
  found: number
  events: MarketEvent[]
  models: string[]
  note?: string | null
}

/** A record without its events, for a list. */
export type AiExperimentSummary = Omit<AiExperiment, 'events'> & { eventCount: number }

export interface AiExperimentPage {
  /** Newest run first. */
  rows: AiExperimentSummary[]
  /** Lines that could not be read. Reported rather than swallowed, like the call ledger's. */
  skippedLines: number
}

const ID_PATTERN = /^EXP-\d{4}-\d{4}-\d{3,}$/

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '')
}

/** An event with everything a benchmark reads off it. The scanner's own check is the one its
 * file of events needs; a sample is also traded by a fixed bracket, which reads the move. */
function isWholeEvent(value: unknown): value is MarketEvent {
  if (!isMarketEvent(value)) return false
  const event = value as unknown as Record<string, unknown>
  const returns = event.returnsPct as Record<string, unknown> | null | undefined
  return (
    typeof event.exchange === 'string' &&
    typeof event.direction === 'string' &&
    typeof event.moveSigmas === 'number' &&
    typeof returns === 'object' &&
    returns !== null &&
    typeof returns.m15 === 'number'
  )
}

function byTime(a: MarketEvent, b: MarketEvent): number {
  return a.time - b.time || a.symbol.localeCompare(b.symbol)
}

/** Checks what a renderer handed over and puts it in one order. Throws, in words a person can
 * read, on anything that could not be a run of this app's benchmark. */
export function normalizeExperimentInput(value: unknown): AiExperimentInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('An experiment needs its run described.')
  const input = value as Record<string, unknown>
  if (!isSeconds(input.startedAt) || !isSeconds(input.endedAt) || input.endedAt < input.startedAt) {
    throw new Error('An experiment needs the times its run began and ended.')
  }
  if (!isSeconds(input.startSec) || !isSeconds(input.endSec) || input.endSec <= input.startSec) {
    throw new Error('An experiment needs the period its events were found in.')
  }
  if (!isStrings(input.pairs) || input.pairs.length === 0 || input.pairs.length > SCAN_HISTORY_MAX_PAIRS) {
    throw new Error('An experiment needs the pairs its events were found on.')
  }
  if (!isStrings(input.models) || input.models.length === 0 || input.models.length > AI_OPPORTUNITY_MAX_MODELS) {
    throw new Error(`An experiment needs the models it asked: at least one, at most ${AI_OPPORTUNITY_MAX_MODELS}.`)
  }
  const events = input.events
  if (!Array.isArray(events) || events.length === 0 || events.length > EXPERIMENT_MAX_EVENTS || !events.every(isWholeEvent)) {
    throw new Error(`An experiment needs its events: at least one, at most ${EXPERIMENT_MAX_EVENTS}.`)
  }
  if (new Set(events.map((event) => event.id)).size !== events.length) throw new Error('An experiment cannot hold the same event twice.')
  if (typeof input.found !== 'number' || !Number.isInteger(input.found) || input.found < events.length) {
    throw new Error('An experiment cannot hold more events than were found.')
  }
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null
  return {
    startedAt: Math.floor(input.startedAt),
    endedAt: Math.floor(input.endedAt),
    startSec: Math.floor(input.startSec),
    endSec: Math.floor(input.endSec),
    pairs: [...new Set(input.pairs)].sort(),
    found: input.found,
    events: [...events].sort(byTime),
    models: [...new Set(input.models)],
    note
  }
}

/** The next id for a run that began at `startedAt`: one more than the highest already given out
 * for that UTC day. */
export function experimentIdFor(startedAt: number, existingIds: readonly string[]): string {
  const day = new Date(startedAt * 1000).toISOString()
  const prefix = `EXP-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}-`
  let highest = 0
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue
    const number = Number(id.slice(prefix.length))
    if (Number.isInteger(number) && number > highest) highest = number
  }
  return `${prefix}${String(highest + 1).padStart(3, '0')}`
}

function sameIds(a: MarketEvent[], b: MarketEvent[]): boolean {
  if (a.length !== b.length) return false
  const ids = new Set(a.map((event) => event.id))
  return b.every((event) => ids.has(event.id))
}

/** Whether a record already describes this run: begun in the same second, on the same events,
 * asking the same models. Recording a run twice gives the record it already has. */
export function isSameRun(record: AiExperiment, input: AiExperimentInput): boolean {
  return (
    record.startedAt === input.startedAt &&
    record.models.length === input.models.length &&
    input.models.every((model) => record.models.includes(model)) &&
    sameIds(record.events, input.events)
  )
}

/** The earliest record holding exactly these events, or null: whose sample a run is on. */
export function sampleOwner(records: AiExperiment[], events: MarketEvent[]): string | null {
  let owner: AiExperiment | null = null
  for (const record of records) {
    if (!sameIds(record.events, events)) continue
    if (owner === null || record.startedAt < owner.startedAt) owner = record
  }
  return owner === null ? null : (owner.eventsOf ?? owner.id)
}

export interface ExperimentRunTotals {
  versions: Omit<AiExperimentVersions, 'detector'>
  calls: number
  failed: number
  costUsd: number
}

/** What a run made of its calls, counted from the ledger rows those calls wrote: a benchmark's
 * rows, about one of the run's events, by one of its models, finished while it was running. */
export function experimentRunTotals(rows: AiCallRecord[], input: Pick<AiExperimentInput, 'startedAt' | 'endedAt' | 'events' | 'models'>): ExperimentRunTotals {
  const ids = new Set(input.events.map((event) => event.id))
  const prompt = new Set<string>()
  const context = new Set<string>()
  const schema = new Set<string>()
  const served = new Map<string, Set<string>>()
  let calls = 0
  let failed = 0
  let costUsd = 0
  for (const row of rows) {
    if (row.source !== 'benchmark' || row.eventId === undefined || !ids.has(row.eventId)) continue
    if (!input.models.includes(row.model) || row.at < input.startedAt || row.at > input.endedAt) continue
    prompt.add(row.promptVersion)
    context.add(row.contextVersion)
    schema.add(row.schemaVersion)
    if (row.status === 'failed') {
      failed++
      continue
    }
    calls++
    costUsd += row.usage.costUsd ?? 0
    if (typeof row.servedModel === 'string') served.set(row.model, (served.get(row.model) ?? new Set<string>()).add(row.servedModel))
  }
  return {
    versions: {
      prompt: [...prompt].sort(),
      context: [...context].sort(),
      schema: [...schema].sort(),
      served: Object.fromEntries([...served.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([model, names]) => [model, [...names].sort()]))
    },
    calls,
    failed,
    costUsd
  }
}

export function summarizeExperiment(record: AiExperiment): AiExperimentSummary {
  const { events, ...rest } = record
  return { ...rest, eventCount: events.length }
}

function isAiExperiment(value: unknown): value is AiExperiment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const versions = row.versions as Record<string, unknown> | null | undefined
  return (
    typeof row.id === 'string' &&
    ID_PATTERN.test(row.id) &&
    isSeconds(row.startedAt) &&
    isSeconds(row.endedAt) &&
    isSeconds(row.startSec) &&
    isSeconds(row.endSec) &&
    isStrings(row.pairs) &&
    typeof row.found === 'number' &&
    Array.isArray(row.events) &&
    row.events.length > 0 &&
    row.events.every(isWholeEvent) &&
    (row.eventsOf === null || typeof row.eventsOf === 'string') &&
    isStrings(row.models) &&
    typeof versions === 'object' &&
    versions !== null &&
    Array.isArray(versions.prompt) &&
    Array.isArray(versions.context) &&
    Array.isArray(versions.schema) &&
    typeof versions.detector === 'string' &&
    (versions.served === undefined || (typeof versions.served === 'object' && versions.served !== null && !Array.isArray(versions.served))) &&
    typeof row.scoring === 'object' &&
    row.scoring !== null &&
    typeof row.calls === 'number' &&
    typeof row.failed === 'number' &&
    typeof row.costUsd === 'number' &&
    (row.note === null || typeof row.note === 'string')
  )
}

/** Reads the experiments file's text, in the order the records were written. A line that does not
 * parse is counted and skipped, never thrown on: the realistic cause is one torn final line, and
 * refusing the file for it would hide every record above it. */
export function parseAiExperimentLines(text: string): { rows: AiExperiment[]; skipped: number } {
  const rows: AiExperiment[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isAiExperiment(parsed)) rows.push(parsed)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { rows, skipped }
}

/** What differs between the rules a record was made under and the ones in force now, in words,
 * or nothing when they are the same. A record opened under other rules is still shown -- its
 * answers are what they were -- and says so. */
export function experimentDrift(record: Pick<AiExperiment, 'versions' | 'scoring'>, now: { detector: string; scoring: EventScoring }): string[] {
  const drift: string[] = []
  if (record.versions.detector !== now.detector) {
    drift.push(`its events were found by detector ${record.versions.detector}, and the detector is now ${now.detector}`)
  }
  if (JSON.stringify(record.scoring) !== JSON.stringify(now.scoring)) {
    drift.push('the fees, slippage or fixed bracket it was first scored with have changed since')
  }
  return drift
}
