import { app } from 'electron'
import { createReadStream, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import { ACCURACY_BOARD_VERSION, BOARD_LINES, accuracyBoardOf, addToTally, boardDayOf, boardEntryOf, emptyTally, type AccuracyBoard, type BoardDay, type BoardEntry } from '../../shared/evaluation/accuracyBoard'
import { HORIZONS, type Horizon } from '../../shared/forecast/features'
import { isMissing, parseOutcomeLine, parsePredictionLine, recordMonth, type MissingOutcomeLine, type OutcomeLine } from '../../shared/forecast/forecastRecord'
import { expectedMove } from '../../shared/forecast/size'
import { writeJsonAtomic } from './atomicWrite'

// THE ACCURACY BOARD, KEPT (V10 Stage 2, 19 November 2026; shared/evaluation/accuracyBoard.ts). Each outcome the forecast
// settles is counted as it is written (forecastService.ts hands them in), into its UTC day and horizon, and the latest are
// kept for the forecast-by-forecast list: forecasts/accuracy-board.json, small, rewritten at most once a minute. A
// month's outcomes are 100 MB and more, so nothing reads them again -- except once, where no board is kept yet: the days
// of the record before this build are then read in the background, month by month, each outcome given its forecast's
// middle and expected size from the forecast's own line. It reads the record and writes only its own file.

const FILE = 'accuracy-board.json'
const PERSIST_MS = 60_000
/** Lines read between yields to the rest of the main process while the days before are read. */
const YIELD_EVERY = 4000

interface BoardFile {
  v: typeof ACCURACY_BOARD_VERSION
  updatedAt: number | null
  days: BoardDay[]
  recent: BoardEntry[]
  /** The record was read for the days before this moment (seconds), once. */
  filledBefore: number | null
}

export const boardSeam = {
  dir: (): string => join(app.getPath('userData'), 'forecasts'),
  nowSec: (): number => Math.floor(Date.now() / 1000),
  write: (path: string, data: unknown): Promise<void> => writeJsonAtomic(path, data)
}

const keyOf = (day: number, h: Horizon): string => `${day}/${h}`
let days = new Map<string, BoardDay>()
let recent: BoardEntry[] = []
let updatedAt: number | null = null
let filledBefore: number | null = null
let filling = false
let loaded: Promise<void> | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function oldestKept(nowSec: number): number {
  return Math.floor(nowSec / 86_400) * 86_400 - (BOARD_LINES.days - 1) * 86_400
}

/** An outcome counted into its day; days past the kept thirty are dropped by trim, after each batch. */
function count(outcome: OutcomeLine): void {
  const day = boardDayOf(outcome)
  const key = keyOf(day, outcome.h)
  let entry = days.get(key)
  if (entry === undefined) {
    entry = { day, h: outcome.h, tally: emptyTally() }
    days.set(key, entry)
  }
  addToTally(entry.tally, outcome)
}

function trim(): void {
  const oldest = oldestKept(boardSeam.nowSec())
  for (const [key, entry] of days) if (entry.day < oldest) days.delete(key)
  recent = recent.sort((a, b) => b.at - a.at).slice(0, BOARD_LINES.recentKept)
}

function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persist()
  }, PERSIST_MS)
}

async function persist(): Promise<void> {
  const file: BoardFile = { v: ACCURACY_BOARD_VERSION, updatedAt, days: [...days.values()], recent, filledBefore }
  await boardSeam.write(join(boardSeam.dir(), FILE), file).catch((error) => console.warn('The accuracy board could not be kept:', error instanceof Error ? error.message : error))
}

function told(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('An accuracy board listener failed:', error)
    }
  }
}

/** The outcomes a close settled, counted (forecastService.ts calls it with each close's lines). */
export function takeBoardOutcomes(lines: readonly (OutcomeLine | MissingOutcomeLine)[]): void {
  const measured = lines.filter((line): line is OutcomeLine => !isMissing(line))
  if (measured.length === 0) return
  for (const outcome of measured) {
    count(outcome)
    recent.push(boardEntryOf(outcome))
  }
  updatedAt = boardSeam.nowSec()
  trim()
  schedulePersist()
  told()
}

/** Lines of a JSONL file, read a line at a time; none where there is no file. */
async function eachLine(path: string, take: (value: unknown) => void): Promise<void> {
  if (!existsSync(path)) return
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf-8' }), crlfDelay: Infinity })
  let read = 0
  for await (const raw of reader) {
    if (raw.trim() === '') continue
    try {
      take(JSON.parse(raw))
    } catch {
      // A torn line: left out.
    }
    if (++read % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve))
  }
}

/** The days before `before` read once from the record: each month's forecasts for their middles and sizes, then its
 * outcomes settled before `before` counted. */
async function fill(before: number): Promise<void> {
  filling = true
  told()
  try {
    const from = oldestKept(before)
    const months = [...new Set([recordMonth(from - 8 * 86_400), recordMonth(from), recordMonth(before)])].sort()
    for (const month of months) {
      const forecasts = new Map<string, Partial<Record<Horizon, { mid: number; size: number }>>>()
      await eachLine(join(boardSeam.dir(), `predictions-${month}.jsonl`), (value) => {
        const line = parsePredictionLine(value)
        if (line === null || line.t < from - 8 * 86_400) return
        const byHorizon: Partial<Record<Horizon, { mid: number; size: number }>> = {}
        for (const h of HORIZONS) {
          const q = line.h[h]?.q
          if (q !== undefined) byHorizon[h] = { mid: q[2], size: Math.round(expectedMove(q) * 10_000) / 10_000 }
        }
        forecasts.set(line.id, byHorizon)
      })
      await eachLine(join(boardSeam.dir(), `outcomes-${month}.jsonl`), (value) => {
        const line = parseOutcomeLine(value)
        if (line === null || isMissing(line)) return
        const settled = line.at ?? line.due
        if (settled >= before || settled < from) return
        const known = forecasts.get(line.id)?.[line.h]
        const outcome: OutcomeLine = line.mid === undefined && known !== undefined ? { ...line, mid: known.mid, size: known.size } : line
        count(outcome)
        recent.push(boardEntryOf(outcome))
      })
      trim()
    }
    filledBefore = before
    updatedAt = updatedAt ?? boardSeam.nowSec()
    await persist()
  } catch (error) {
    console.warn('The accuracy board could not read the days before:', error instanceof Error ? error.message : error)
  } finally {
    filling = false
    told()
  }
}

async function load(): Promise<void> {
  const started = boardSeam.nowSec()
  try {
    const raw = JSON.parse(await readFile(join(boardSeam.dir(), FILE), 'utf-8')) as Partial<BoardFile>
    if (raw.v === ACCURACY_BOARD_VERSION && Array.isArray(raw.days) && Array.isArray(raw.recent)) {
      // What was counted since the start is added to what was kept.
      const kept = new Map(raw.days.map((entry) => [keyOf(entry.day, entry.h), entry]))
      for (const [key, entry] of days) {
        const mine = kept.get(key)
        if (mine === undefined) kept.set(key, entry)
        else for (const field of Object.keys(entry.tally) as (keyof BoardDay['tally'])[]) mine.tally[field] += entry.tally[field]
      }
      days = kept
      recent = [...raw.recent, ...recent]
      updatedAt = Math.max(raw.updatedAt ?? 0, updatedAt ?? 0) || null
      filledBefore = raw.filledBefore ?? null
      trim()
      return
    }
  } catch {
    // No board kept yet.
  }
  // None kept: the days before are read once, in the background.
  void fill(started)
}

/** Starts the board: what was kept read back, or the days before read once. Called once, from main.ts. */
export function startAccuracyBoard(): Promise<void> {
  loaded ??= load()
  return loaded
}

/** The board as the window shows it. */
export async function accuracyBoard(): Promise<AccuracyBoard> {
  await startAccuracyBoard()
  return accuracyBoardOf([...days.values()], recent, HORIZONS, updatedAt, filling)
}

export function onAccuracyBoard(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam: as a new session finds it. */
export function resetAccuracyBoard(): void {
  days = new Map()
  recent = []
  updatedAt = null
  filledBefore = null
  filling = false
  loaded = null
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = null
  listeners.clear()
}

/** Test seam: what is kept written now, without waiting the minute. */
export function flushAccuracyBoard(): Promise<void> {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = null
  return persist()
}
