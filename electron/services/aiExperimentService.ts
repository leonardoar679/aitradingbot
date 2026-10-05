import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { eventScoring } from '../../shared/aiEventBenchmark'
import {
  experimentIdFor,
  experimentRunTotals,
  isSameRun,
  normalizeExperimentInput,
  parseAiExperimentLines,
  sampleOwner,
  summarizeExperiment,
  type AiExperiment,
  type AiExperimentPage
} from '../../shared/aiExperiment'
import { EVENT_DETECTOR_VERSION } from '../../shared/marketEvent'
import { readAiCallsSince } from './aiLedgerService'
import { appendJsonLine } from './jsonlStore'

// Benchmark runs on disk (shared/aiExperiment.ts): one JSON line a run, append-only, in one file.
// A record holds a few hundred events at most and there are a handful of runs, so the whole file
// is read each time it is looked at. How a line is appended, and what a torn one costs, is
// jsonlStore.ts.
//
// NOTHING HERE ASKS A MODEL OR CHANGES AN ANSWER. It writes down what a run that has already
// happened asked, and reads the call ledger to count what that cost.

function experimentsFile(): string {
  return join(app.getPath('userData'), 'aiExperiments', 'experiments.jsonl')
}

async function readAll(): Promise<{ rows: AiExperiment[]; skipped: number }> {
  let text: string
  try {
    text = await readFile(experimentsFile(), 'utf-8')
  } catch {
    return { rows: [], skipped: 0 } // No file yet: no run has been recorded.
  }
  return parseAiExperimentLines(text)
}

/** Every recorded run, newest first, without its events. */
export async function listAiExperiments(): Promise<AiExperimentPage> {
  const { rows, skipped } = await readAll()
  return { rows: rows.map(summarizeExperiment).sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)), skippedLines: skipped }
}

/** One recorded run with its events, or null when there is none by that id. */
export async function getAiExperiment(id: string): Promise<AiExperiment | null> {
  const { rows } = await readAll()
  return rows.find((row) => row.id === id) ?? null
}

async function record(value: unknown): Promise<AiExperiment> {
  const input = normalizeExperimentInput(value)
  const { rows } = await readAll()
  const already = rows.find((row) => isSameRun(row, input))
  if (already) return already

  const totals = experimentRunTotals((await readAiCallsSince(input.startedAt)).rows, input)
  if (totals.calls + totals.failed === 0) throw new Error('No call in the ledger belongs to this run, so there is nothing to record.')

  const experiment: AiExperiment = {
    id: experimentIdFor(
      input.startedAt,
      rows.map((row) => row.id)
    ),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    startSec: input.startSec,
    endSec: input.endSec,
    pairs: input.pairs,
    found: input.found,
    events: input.events,
    eventsOf: sampleOwner(rows, input.events),
    models: input.models,
    versions: { ...totals.versions, detector: EVENT_DETECTOR_VERSION },
    scoring: eventScoring(),
    calls: totals.calls,
    failed: totals.failed,
    costUsd: totals.costUsd,
    note: input.note ?? null
  }
  await appendJsonLine(experimentsFile(), experiment)
  return experiment
}

let recording: Promise<unknown> = Promise.resolve()

/** Writes down a run that has ended. One at a time: an id is the next number for its day, and two
 * records made at once would both read the same last one. */
export function recordAiExperiment(value: unknown): Promise<AiExperiment> {
  const next = recording.catch(() => undefined).then(() => record(value))
  recording = next.catch(() => undefined)
  return next
}
