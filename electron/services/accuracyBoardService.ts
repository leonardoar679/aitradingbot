import { app } from 'electron'
import { createReadStream, existsSync, renameSync, writeFileSync } from 'fs'
import { open, readFile } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import { ACCURACY_BOARD_VERSION, BOARD_LINES, accuracyBoardOf, addToTally, boardDayOf, boardEntryOf, dailyBoardEntryOf, emptyTally, type AccuracyBoard, type BoardDay, type BoardEntry, type BoardHorizonKey, type BoardOutcome } from '../../shared/evaluation/accuracyBoard'
import { parseDailyOutcome, type DailyOutcomeLine } from '../../shared/forecast/daily/dailyRecord'
import { DAILY_HORIZONS } from '../../shared/forecast/daily/dailySize'
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
//
// KEPT THROUGH A QUIT AND A CRASH (V10 Stage 8, 19 November 2026): the board is written at once when the app quits, and
// it keeps the latest settle moment it counted, of each forecast's outcomes; a start after a crash -- the minute's counts
// never written -- finds a record file whose last line was settled later, and counts from the record what it missed,
// once. Nothing is written while the record is being read, so that a quit then leaves the last whole board.

const FILE = 'accuracy-board.json'
/** Outcomes settled this long before a start can still be counted live after it, while the record is read. */
const LIVE_WINDOW_SEC = 6 * 3600
/** The end of a record file read to find its last line's settle moment. */
const TAIL_BYTES = 512 * 1024
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
  /** The latest settle moment counted (seconds), of the five-minute forecast's outcomes and of the daily forecast's; absent
   * on a board kept before V10 Stage 8. */
  countedTo?: number | null
  dailyCountedTo?: number | null
}

export const boardSeam = {
  dir: (): string => join(app.getPath('userData'), 'forecasts'),
  nowSec: (): number => Math.floor(Date.now() / 1000),
  write: (path: string, data: unknown): Promise<void> => writeJsonAtomic(path, data)
}

const keyOf = (day: number, h: BoardHorizonKey): string => `${day}/${h}`
let days = new Map<string, BoardDay>()
let recent: BoardEntry[] = []
let updatedAt: number | null = null
let filledBefore: number | null = null
let filling = false
let loaded: Promise<void> | null = null
/** The kept board has been read back (or the reading of the days before begun): only then is it written. */
let readBack = false
let persistTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
let countedTo: number | null = null
let dailyCountedTo: number | null = null
/** While the record is read at a start (the days before, or what a crash left uncounted): the outcomes counted live
 * meanwhile, and those the reading counted, near the start, so that none is counted twice. */
let reading = false
/** A write was held back while the record was read: made at the reading's end. */
let deferred = false
const countedLive = new Set<string>()
const countedRead = new Set<string>()
const lineKey = (id: string, h: string): string => `${id}/${h}`
const later = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b))

function oldestKept(nowSec: number): number {
  return Math.floor(nowSec / 86_400) * 86_400 - (BOARD_LINES.days - 1) * 86_400
}

/** An outcome counted live: false where the reading at the start counted it already. */
function takeLive(id: string, h: string): boolean {
  if (!reading) return true
  const key = lineKey(id, h)
  if (countedRead.has(key)) return false
  countedLive.add(key)
  return true
}

/** An outcome counted from the record at a start: false where it was counted live already. Only those settled near the
 * start can have been. */
function takeRead(id: string, h: string, settled: number, start: number): boolean {
  if (settled < start - LIVE_WINDOW_SEC) return true
  const key = lineKey(id, h)
  if (countedLive.has(key)) return false
  countedRead.add(key)
  return true
}

/** An outcome counted into its day; days past the kept thirty are dropped by trim, after each batch. */
function count(outcome: BoardOutcome & { h: BoardHorizonKey; at?: number; due: number }): void {
  const settled = outcome.at ?? outcome.due
  if ((DAILY_HORIZONS as readonly string[]).includes(outcome.h)) dailyCountedTo = later(dailyCountedTo, settled)
  else countedTo = later(countedTo, settled)
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

const boardFile = (): BoardFile => ({ v: ACCURACY_BOARD_VERSION, updatedAt, days: [...days.values()], recent, filledBefore, countedTo, dailyCountedTo })

/** Whether the board may be written: read back first, and not while the record is read (the reading writes it at its end;
 * a board written halfway would be taken, at the next start, for the whole). */
const writable = (): boolean => readBack && !filling && !reading

async function persist(): Promise<void> {
  if (!writable()) {
    deferred = true
    return
  }
  deferred = false
  await boardSeam.write(join(boardSeam.dir(), FILE), boardFile()).catch((error) => console.warn('The accuracy board could not be kept:', error instanceof Error ? error.message : error))
}

/** The board written at once, as the app quits (main.ts): the minute's counts are not lost to a quit. */
export function flushAccuracyBoardSync(): void {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = null
  if (!writable()) return
  const path = join(boardSeam.dir(), FILE)
  try {
    writeFileSync(`${path}.quit`, JSON.stringify(boardFile()))
    renameSync(`${path}.quit`, path)
  } catch (error) {
    console.warn('The accuracy board could not be kept at the quit:', error instanceof Error ? error.message : error)
  }
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
    if (!takeLive(outcome.id, outcome.h)) continue
    count(outcome)
    recent.push(boardEntryOf(outcome))
  }
  updatedAt = boardSeam.nowSec()
  trim()
  schedulePersist()
  told()
}

/** The daily forecast's outcomes as they are settled (dailyForecastService.ts calls it): counted on their days. */
export function takeBoardDailyOutcomes(lines: readonly DailyOutcomeLine[]): void {
  if (lines.length === 0) return
  for (const outcome of lines) {
    if (!takeLive(outcome.id, outcome.h)) continue
    count({ ...outcome, dir: 'NEUTRAL' })
    recent.push(dailyBoardEntryOf(outcome))
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
  reading = true
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
        if (settled >= before || settled < from || !takeRead(line.id, line.h, settled, before)) return
        const known = forecasts.get(line.id)?.[line.h]
        const outcome: OutcomeLine = line.mid === undefined && known !== undefined ? { ...line, mid: known.mid, size: known.size } : line
        count(outcome)
        recent.push(boardEntryOf(outcome))
      })
      trim()
    }
    filledBefore = before
    updatedAt = updatedAt ?? boardSeam.nowSec()
  } catch (error) {
    console.warn('The accuracy board could not read the days before:', error instanceof Error ? error.message : error)
  } finally {
    endReading()
    filling = false
  }
  // Written whole, once the reading is done: a quit halfway through left the board unwritten, to be read again.
  if (filledBefore !== null) await persist()
  told()
}

function endReading(): void {
  reading = false
  countedLive.clear()
  countedRead.clear()
}

/** The latest settle moment of the lines at a record file's end; null where it has none. */
async function lastSettled(path: string, parse: (value: unknown) => { at?: number; due: number } | null): Promise<number | null> {
  if (!existsSync(path)) return null
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    let latest: number | null = null
    for (const raw of buffer.toString('utf-8').split('\n')) {
      if (raw.trim() === '') continue
      try {
        const line = parse(JSON.parse(raw))
        if (line !== null) latest = later(latest, line.at ?? line.due)
      } catch {
        // The first line, cut by the read, or a torn one.
      }
    }
    return latest
  } finally {
    await handle.close()
  }
}

/** The months of the record from one moment to another. */
function monthsFrom(from: number, to: number): string[] {
  const months = new Set<string>()
  for (let at = from; at < to; at += 20 * 86_400) months.add(recordMonth(at))
  months.add(recordMonth(to))
  return [...months].sort()
}

/** After a crash: what the record holds settled after the kept board's last count, counted once (V10 Stage 8). A record
 * file is read only where its end was settled later than that, which a quit that wrote the board never leaves. */
async function catchUp(from: number | null, fromDaily: number | null, start: number): Promise<void> {
  reading = true
  let caught = 0
  try {
    if (from !== null) {
      const since = Math.max(from, oldestKept(start) - 86_400)
      for (const month of monthsFrom(since, start)) {
        const path = join(boardSeam.dir(), `outcomes-${month}.jsonl`)
        const end = await lastSettled(path, parseOutcomeLine)
        if (end === null || end <= from) continue
        await eachLine(path, (value) => {
          const line = parseOutcomeLine(value)
          if (line === null || isMissing(line)) return
          const settled = line.at ?? line.due
          if (settled <= from || !takeRead(line.id, line.h, settled, start)) return
          count(line)
          recent.push(boardEntryOf(line))
          caught++
        })
      }
    }
    if (fromDaily !== null) {
      const years = [...new Set([new Date(fromDaily * 1000).getUTCFullYear(), new Date(start * 1000).getUTCFullYear()])].sort()
      for (const year of years) {
        await eachLine(join(boardSeam.dir(), `daily-outcomes-${year}.jsonl`), (value) => {
          const line = parseDailyOutcome(value)
          if (line === null || line.at <= fromDaily || !takeRead(line.id, line.h, line.at, start)) return
          count({ ...line, dir: 'NEUTRAL' })
          recent.push(dailyBoardEntryOf(line))
          caught++
        })
      }
    }
  } catch (error) {
    console.warn('The accuracy board could not count what a crash left:', error instanceof Error ? error.message : error)
  } finally {
    endReading()
  }
  if (caught > 0) {
    updatedAt = boardSeam.nowSec()
    trim()
  }
  if (caught > 0 || deferred) await persist()
  if (caught > 0) told()
}

async function load(): Promise<void> {
  const started = boardSeam.nowSec()
  // A reading from the first moment: an outcome counted live while the kept board is read is not counted again from the
  // record after it.
  reading = true
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
      const keptTo = typeof raw.countedTo === 'number' ? raw.countedTo : null
      const keptDailyTo = typeof raw.dailyCountedTo === 'number' ? raw.dailyCountedTo : null
      countedTo = later(countedTo, keptTo)
      dailyCountedTo = later(dailyCountedTo, keptDailyTo)
      trim()
      readBack = true
      await catchUp(keptTo, keptDailyTo, started)
      return
    }
  } catch {
    // No board kept yet.
  }
  // None kept: the days before are read once, in the background.
  readBack = true
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
  return accuracyBoardOf([...days.values()], recent, [...HORIZONS, ...DAILY_HORIZONS], updatedAt, filling)
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
  readBack = false
  countedTo = null
  dailyCountedTo = null
  deferred = false
  endReading()
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
