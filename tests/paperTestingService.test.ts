import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NEWS_CONFIG, type NewsConfig, type NewsConfigPatch } from '../shared/news'
import { DEFAULT_PAPER_BOOKS } from '../shared/paperBooks'
import { PAPER_TESTING_VERSION } from '../shared/paperTesting'

// START AND STOP PAPER TESTING, IN THE MAIN PROCESS (electron/services/paperTestingService.ts; V8 Stage 9): Start writes
// every switch it is about to turn on and its earlier value before it changes anything, then turns them on, starts the
// books and marks them; Stop marks them while they run, stops them -- their run's start kept -- puts each switch back
// exactly, files the run and lets started.json go; a Stop that cannot put a switch back keeps it for the next. The
// settings and the news reader are faked at their services; the books' files are real, in a scratch folder.

let settings: Record<string, unknown> = {}
const news = vi.hoisted(() => ({ config: null as NewsConfig | null, patches: [] as NewsConfigPatch[], fail: false }))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/settingsService', () => ({
  getSettings: async () => settings,
  setSettings: async (patch: Record<string, unknown>) => {
    settings = { ...settings, ...patch }
    return settings
  }
}))
vi.mock('../electron/services/newsService', async () => {
  const { DEFAULT_NEWS_CONFIG: defaults, applyNewsConfigPatch, copyNewsConfig } = await import('../shared/news')
  const stateOf = () => ({ config: copyNewsConfig(news.config ?? defaults), lastReadAt: 1, nextReadAt: null, error: null, recent: [], health: { failuresInRow: 0, stoppedAt: null, stoppedReason: null } })
  return {
    getNewsState: async () => stateOf(),
    setNewsConfig: async (patch: NewsConfigPatch) => {
      news.patches.push(patch)
      if (news.fail) throw new Error('the disk is full')
      const next = applyNewsConfigPatch(news.config ?? defaults, patch)
      if (typeof next === 'string') throw new Error(next)
      news.config = next
      return stateOf()
    }
  }
})

const NOW = 1_793_100_000
let dir = ''

// The modules read once before the first test, under the hook's own time: each test then reads them again from the
// cache, so that a slow first read on a busy machine is not charged to a test's five seconds.
beforeAll(async () => {
  await import('../electron/services/paperTestingService')
}, 60_000)

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'paper-testing-'))
  settings = { paperBooks: DEFAULT_PAPER_BOOKS, executors: [], copyTrading: { follows: { 'hyperliquid-0x0b4b6beaca45fce66ca818fbd867ec3761ed2143': { since: 1, maxHoldSec: 60 } }, clones: {} } }
  news.config = DEFAULT_NEWS_CONFIG
  news.patches = []
  news.fail = false
})

async function service(now = NOW) {
  const books = await import('../electron/services/booksService')
  books.booksSeam.dir = () => dir
  books.booksSeam.now = () => now
  return import('../electron/services/paperTestingService')
}

const lines = (name: string): unknown[] => readFileSync(join(dir, name), 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as unknown)
const month = new Date(NOW * 1000).toISOString().slice(0, 7)

describe('Start', () => {
  it('writes what it turns on and what each was, then turns them on, starts the books from now and marks them', async () => {
    const testing = await service()
    const state = await testing.startPaperTesting()
    const record = { v: PAPER_TESTING_VERSION, startedAt: NOW, switched: [{ switch: 'news.enabled', was: false }, { switch: 'news.delisting.paperShort', was: false }] }
    expect(JSON.parse(readFileSync(join(dir, 'started.json'), 'utf-8'))).toEqual(record)
    expect(news.patches).toEqual([{ enabled: true, delisting: { paperShort: { enabled: true } } }])
    expect(news.config).toMatchObject({ enabled: true, delisting: { paperShort: { enabled: true }, askModels: true }, monitoringTag: DEFAULT_NEWS_CONFIG.monitoringTag })
    expect(settings.paperBooks).toEqual({ ...DEFAULT_PAPER_BOOKS, running: true, startedAt: NOW })
    expect(lines(`equity-${month}.jsonl`)).toHaveLength(3)
    expect(state).toMatchObject({ running: true, startedAt: NOW, started: record, switches: { 'news.enabled': true, 'news.delisting.paperShort': true, 'news.delisting.askModels': true }, tagShort: false, follows: 1, clones: 0 })
    expect(state.standings.map((standing) => standing.id)).toEqual(['news', 'copy', 'baseline'])
    await expect(testing.startPaperTesting()).rejects.toThrow('Paper testing is already running.')
  })

  it('turns nothing on that is on already, and records nothing to put back', async () => {
    news.config = { ...DEFAULT_NEWS_CONFIG, enabled: true, delisting: { ...DEFAULT_NEWS_CONFIG.delisting, paperShort: { enabled: true, stakeQuote: 250 } } }
    const testing = await service()
    expect((await testing.startPaperTesting()).started?.switched).toEqual([])
    expect(news.patches).toEqual([])
    await testing.stopPaperTesting()
    expect(news.patches).toEqual([])
    expect(news.config?.delisting.paperShort).toEqual({ enabled: true, stakeQuote: 250 })
  })

  it('is one at a time', async () => {
    const testing = await service()
    const results = await Promise.allSettled([testing.startPaperTesting(), testing.startPaperTesting()])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: new Error('A Start or a Stop of paper testing is already under way.') })
  })
})

describe('Stop', () => {
  it('marks the books while they run, stops them with their start kept, puts back exactly what Start turned on, and files the run', async () => {
    news.config = { ...DEFAULT_NEWS_CONFIG, monitoringTag: { ...DEFAULT_NEWS_CONFIG.monitoringTag, paperShort: { enabled: true, stakeQuote: 100 } } }
    await (await service()).startPaperTesting()
    // Changed during the run: the delisting's models switched off by hand. Start did not turn them on: they stay off.
    news.config = { ...(news.config as NewsConfig), delisting: { ...(news.config as NewsConfig).delisting, askModels: false } }
    vi.resetModules()
    const state = await (await service(NOW + 3600)).stopPaperTesting()
    expect(news.patches.at(-1)).toEqual({ enabled: false, delisting: { paperShort: { enabled: false } } })
    expect(news.config).toMatchObject({ enabled: false, delisting: { paperShort: { enabled: false }, askModels: false }, monitoringTag: { paperShort: { enabled: true } } })
    expect(settings.paperBooks).toEqual({ ...DEFAULT_PAPER_BOOKS, running: false, startedAt: NOW })
    expect(lines(`equity-${month}.jsonl`).map((mark) => (mark as { at: number }).at)).toEqual([NOW, NOW, NOW, NOW + 3600, NOW + 3600, NOW + 3600])
    expect(lines(`runs-${month}.jsonl`)).toEqual([{ v: PAPER_TESTING_VERSION, startedAt: NOW, stoppedAt: NOW + 3600, switched: [{ switch: 'news.enabled', was: false }, { switch: 'news.delisting.paperShort', was: false }], restored: true }])
    expect(existsSync(join(dir, 'started.json'))).toBe(false)
    expect(state).toMatchObject({ running: false, startedAt: NOW, started: null })
    await expect((await service()).stopPaperTesting()).rejects.toThrow('Paper testing is not running.')
  })

  it('that cannot put a switch back keeps what to put back, refuses a Start, and is made again', async () => {
    const testing = await service()
    await testing.startPaperTesting()
    news.fail = true
    const state = await testing.stopPaperTesting()
    expect(state).toMatchObject({ running: false, started: { startedAt: NOW } })
    expect(existsSync(join(dir, 'started.json'))).toBe(true)
    await expect(testing.startPaperTesting()).rejects.toThrow('The last Stop could not put every switch back: Stop paper testing again first.')
    news.fail = false
    await testing.stopPaperTesting()
    expect(news.config).toMatchObject({ enabled: false, delisting: { paperShort: { enabled: false } } })
    expect(existsSync(join(dir, 'started.json'))).toBe(false)
    expect(lines(`runs-${month}.jsonl`).map((run) => (run as { restored: boolean }).restored)).toEqual([false, true])
    // The books were marked once at Start and once at the first Stop, while they ran; not again after.
    expect(lines(`equity-${month}.jsonl`)).toHaveLength(6)
  })
})
