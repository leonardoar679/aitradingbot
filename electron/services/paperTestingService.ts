import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { healPaperBooks } from '../../shared/paperBooks'
import {
  PAPER_TESTING_VERSION,
  readStartedRecord,
  restorePatchOf,
  startPatchOf,
  switchStateOf,
  switchesToTurnOn,
  type PaperTestingState,
  type RunRecord,
  type StartedRecord
} from '../../shared/paperTesting'
import { healCopyTrading } from '../../shared/traders/copyTrading'
import { writeJsonAtomic } from './atomicWrite'
import { bookStandings, booksSeam, markBookEquity } from './booksService'
import { appendJsonLine } from './jsonlStore'
import { getNewsState, setNewsConfig } from './newsService'
import { getSettings, setSettings } from './settingsService'

// START AND STOP PAPER TESTING (shared/paperTesting.ts; V8 Stage 9, 27 October 2026). Start writes
// paperBooks/started.json before it changes anything -- every switch it is about to turn on and that switch's earlier
// value -- then starts the books from that second, then turns the switches on, and marks the books' equity: the books
// run before the reader is on, so that an announcement its first read finds is the news book's, not the paper
// account's. Stop marks the books' equity while they still run, puts each switch Start turned on back to its earlier
// value, then stops the books -- the reader off before they are, so that nothing it reads in between goes to the paper
// account -- and files the run in paperBooks/runs-YYYY-MM.jsonl; the window then closes the books' open trades at the
// price then (src/trading/paperTesting.ts). A Stop that could not put a switch back stops the books still, and keeps
// started.json, so the next Stop tries again. One Start or Stop at a time. Nothing here asks a model, reads a key or
// places an order: it switches the news reader and the books, which open paper trades only.

let busy = false

async function alone<T>(work: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('A Start or a Stop of paper testing is already under way.')
  busy = true
  try {
    return await work()
  } finally {
    busy = false
  }
}

const startedPath = (): string => join(booksSeam.dir(), 'started.json')

async function readStarted(): Promise<StartedRecord | null> {
  try {
    return readStartedRecord(JSON.parse(await readFile(startedPath(), 'utf-8')))
  } catch {
    return null
  }
}

/** Whether paper testing runs, since when, what Start turned on, each book's standing, the switches as they are, the
 * announcement reader's health, and the traders followed and cloned. */
export async function paperTestingState(): Promise<PaperTestingState> {
  const [{ running, startedAt, standings }, news, settings, started] = await Promise.all([bookStandings(), getNewsState(), getSettings(), readStarted()])
  const copy = healCopyTrading(settings.copyTrading)
  return {
    running,
    startedAt,
    started,
    standings,
    switches: switchStateOf(news.config),
    tagShort: news.config.monitoringTag.paperShort.enabled,
    reader: { lastReadAt: news.lastReadAt, error: news.error, health: news.health },
    follows: Object.keys(copy.follows).length,
    clones: Object.keys(copy.clones).length
  }
}

/** Starts the three books from now, after writing what it turns on and what each was. */
export async function startPaperTesting(): Promise<PaperTestingState> {
  return alone(async () => {
    const books = healPaperBooks((await getSettings()).paperBooks)
    if (books.running) throw new Error('Paper testing is already running.')
    const pending = await readStarted()
    if (pending !== null) throw new Error('The last Stop could not put every switch back: Stop paper testing again first.')
    const startedAt = booksSeam.now()
    const switched = switchesToTurnOn((await getNewsState()).config)
    const record: StartedRecord = { v: PAPER_TESTING_VERSION, startedAt, switched }
    await mkdir(booksSeam.dir(), { recursive: true })
    await writeJsonAtomic(startedPath(), record)
    await setSettings({ paperBooks: { ...books, running: true, startedAt } })
    if (switched.length > 0) await setNewsConfig(startPatchOf(switched))
    await markBookEquity().catch((error) => console.error("The paper books' equity could not be marked at Start:", error))
    return paperTestingState()
  })
}

/** Stops the books, after their last marks, and puts back every switch Start turned on. */
export async function stopPaperTesting(): Promise<PaperTestingState> {
  return alone(async () => {
    const books = healPaperBooks((await getSettings()).paperBooks)
    const started = await readStarted()
    if (!books.running && started === null) throw new Error('Paper testing is not running.')
    if (books.running) await markBookEquity().catch((error) => console.error("The paper books' equity could not be marked at Stop:", error))
    let restored = true
    if (started !== null && started.switched.length > 0) {
      try {
        await setNewsConfig(restorePatchOf(started.switched))
      } catch (error) {
        restored = false
        console.error('A switch paper testing turned on could not be put back:', error)
      }
    }
    // The run's start is kept, so that its figures stay readable until the next Start.
    if (books.running) await setSettings({ paperBooks: { ...books, running: false } })
    if (started !== null) {
      const stoppedAt = booksSeam.now()
      const run: RunRecord = { v: PAPER_TESTING_VERSION, startedAt: started.startedAt, stoppedAt, switched: started.switched, restored }
      await appendJsonLine(join(booksSeam.dir(), `runs-${new Date(stoppedAt * 1000).toISOString().slice(0, 7)}.jsonl`), run)
      if (restored) await rm(startedPath(), { force: true })
    }
    return paperTestingState()
  })
}
