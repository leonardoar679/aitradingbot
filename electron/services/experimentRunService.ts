import { app, type BrowserWindow } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { AI_CONTEXT_VERSION } from '../../shared/aiContext'
import { AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION } from '../../shared/aiOpportunity'
import {
  experimentIdOf,
  experimentMinutesOf,
  experimentModeOf,
  experimentStatusAt,
  healExperimentRun,
  parseExperimentRunLines,
  type ExperimentKind,
  type ExperimentRun
} from '../../shared/experimentRun'
import { IpcChannel } from '../../shared/ipc'
import { EVENT_DETECTOR_VERSION } from '../../shared/marketEvent'
import { getAiConfig } from './aiConfigService'
import { getEffectiveConfig } from './effectiveConfigService'
import { appendJsonLine } from './jsonlStore'
import { getScannerState } from './marketScannerService'

// THE RUNS ON FILE AND THE CLOCK (shared/experimentRun.ts; V5 Stage 9, 8 October 2026). A run is
// one JSON line per change in aiExperiments/runs.jsonl, the newest line for an id winning. The main
// process starts one (what the chip read, the versions, the models, the universe, written down at
// the start), ends it when its clock passes -- whether or not the window is open, and after a
// restart, since the end is on file -- and files the report the window builds for it. It asks no
// model, opens nothing and changes no setting: a run watches the app, and the app runs as it would.

const LOOK_MS = 30_000

function runsFile(): string {
  return join(app.getPath('userData'), 'aiExperiments', 'runs.jsonl')
}

async function readAll(): Promise<{ rows: ExperimentRun[]; skipped: number }> {
  let text: string
  try {
    text = await readFile(runsFile(), 'utf-8')
  } catch {
    return { rows: [], skipped: 0 } // No file yet: no run has been started.
  }
  return parseExperimentRunLines(text)
}

let window: BrowserWindow | null = null
let timer: NodeJS.Timeout | null = null

function tell(run: ExperimentRun): void {
  if (window !== null && !window.isDestroyed()) window.webContents.send(IpcChannel.ExperimentUpdate, run)
}

async function write(run: ExperimentRun): Promise<ExperimentRun> {
  await appendJsonLine(runsFile(), run)
  tell(run)
  return run
}

/** Every run, newest first, as it stands now: a running one whose end has passed reads as ended
 * even before the tick writes that down. */
export async function listExperimentRuns(): Promise<{ rows: ExperimentRun[]; skippedLines: number }> {
  const { rows, skipped } = await readAll()
  const nowSec = Math.floor(Date.now() / 1000)
  return { rows: rows.map((run) => ({ ...run, status: experimentStatusAt(run, nowSec) })), skippedLines: skipped }
}

/** Starts a run now, written down with what the app is as it starts. One at a time: a run still
 * running refuses another. */
export async function startExperimentRun(input: { kind: ExperimentKind; minutes?: number | null }): Promise<ExperimentRun> {
  const { rows } = await readAll()
  const nowSec = Math.floor(Date.now() / 1000)
  const running = rows.find((run) => experimentStatusAt(run, nowSec) === 'running')
  if (running !== undefined) throw new Error(`A run is still going: ${running.id}, until ${new Date(running.endsAt * 1000).toISOString().slice(11, 16)} UTC. Stop it first, or wait.`)
  const kind = input.kind
  const minutes = experimentMinutesOf(kind, input.minutes)
  const [config, effective, scanner] = await Promise.all([getAiConfig(), getEffectiveConfig(), getScannerState()])
  const run: ExperimentRun = {
    id: experimentIdOf(nowSec, rows.map((entry) => entry.id)),
    kind,
    minutes,
    startedAt: nowSec,
    endsAt: nowSec + minutes * 60,
    mode: experimentModeOf(config),
    versions: {
      prompt: AI_OPPORTUNITY_PROMPT_VERSION,
      context: AI_CONTEXT_VERSION,
      schema: AI_OPPORTUNITY_SCHEMA_VERSION,
      detector: EVENT_DETECTOR_VERSION,
      config: effective.configVersion,
      engine: effective.engineVersion
    },
    models: config.watch.enabled ? [...config.watch.models] : [],
    universe: scanner.config.universeSize,
    status: 'running'
  }
  return write(run)
}

/** Stops a running run now: its report then covers what ran. */
export async function stopExperimentRun(id: string): Promise<ExperimentRun | null> {
  const { rows } = await readAll()
  const run = rows.find((entry) => entry.id === id)
  if (run === undefined) return null
  const nowSec = Math.floor(Date.now() / 1000)
  if (experimentStatusAt(run, nowSec) !== 'running') return run
  return write({ ...run, status: 'stopped', stoppedAt: nowSec })
}

/** Files the report the window built for an ended run. A run already reported keeps its report. */
export async function fileExperimentReport(id: string, report: unknown): Promise<ExperimentRun | null> {
  const { rows } = await readAll()
  const run = rows.find((entry) => entry.id === id)
  if (run === undefined) return null
  if (run.report !== undefined) return run
  const nowSec = Math.floor(Date.now() / 1000)
  if (experimentStatusAt(run, nowSec) === 'running') throw new Error(`${id} is still running: its report comes at the end.`)
  const healed = healExperimentRun({ ...run, status: 'reported', report, reportedAt: nowSec })
  if (healed === null || healed.report === undefined) throw new Error('The report could not be read as one.')
  return write(healed)
}

/** The tick: a running run whose end has passed is written down as ended, and the window told. Once:
 * the next tick reads the run as ended from the file. Exported for its test; the service runs it on
 * its own clock. */
export async function tickExperimentRuns(): Promise<void> {
  try {
    const { rows } = await readAll()
    const nowSec = Math.floor(Date.now() / 1000)
    for (const run of rows) {
      if (run.status !== 'running' || nowSec < run.endsAt) continue
      await write({ ...run, status: 'ended' })
    }
  } catch (error) {
    console.error('The experiment runs could not be looked at:', error)
  }
}

export function startExperimentRunService(mainWindow: BrowserWindow): void {
  window = mainWindow
  if (timer === null) timer = setInterval(() => void tickExperimentRuns(), LOOK_MS)
  void tickExperimentRuns()
}

/** Test seam. */
export function stopExperimentRunService(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  window = null
}
