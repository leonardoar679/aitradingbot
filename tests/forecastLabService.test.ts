import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForecastBar } from '../shared/forecast/bars'
import { LAB_VERSION } from '../shared/forecast/lab'
import { serializeLab, serializeReplay, type LabFile } from '../shared/forecast/labFile'

// THE FORECAST LAB, FROM THE MAIN PROCESS'S SIDE (electron/services/forecastLabService.ts; V6 Stage 11):
// made in the worker once a walk forward's calibration is in use and the training is idle, once a run,
// read back from its file at a start; a failure on record and not tried again for the run; what the
// page is shown -- the leaderboard from the walk forward's own record, the live record of the last
// week, the refit's switch -- a tested hour replayed with its path and its coin's stories, and a pair's
// bars for the strategies. The worker, the training, the bars, the news and the settings are faked.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

const T = Date.parse('2026-10-01T12:00:00Z') / 1000

const fake = vi.hoisted(() => ({
  asked: [] as Record<string, unknown>[],
  fail: false,
  training: {
    status: 'ready' as string,
    current: { runId: 'run-a', fittedAt: 0, foldsRunId: 'run-a' } as { runId: string; fittedAt: number; foldsRunId: string | null } | null,
    calibratedRunId: 'run-a' as string | null,
    progress: null,
    lastError: null,
    nextRefitAt: 1_800_000_000,
    promotions: [] as unknown[]
  },
  listeners: [] as (() => void)[],
  series: new Map<string, { m5: ForecastBar[]; h1: ForecastBar[] }>(),
  stories: [] as { id: string; publishedAt: number; tickers: string[]; eventType: string; stale: boolean }[],
  readings: {} as Record<string, unknown>,
  settings: {} as Record<string, unknown>,
  calibration: null as unknown
}))

function labFile(runId: string): LabFile {
  return { version: LAB_VERSION, runId, madeAt: T, span: { from: T, to: T + 7200 }, pairs: ['SOLUSDT'], horizons: {} }
}

vi.mock('../electron/services/forecastWorkerService', () => ({
  askWorker: vi.fn(async (request: { task: string; outDir: string; runId: string }) => {
    fake.asked.push(request)
    if (fake.fail) return { id: 1, ok: false, error: 'the worker ran out of memory' }
    mkdirSync(join(request.outDir, request.runId), { recursive: true })
    writeFileSync(join(request.outDir, request.runId, 'lab.json'), serializeLab(labFile(request.runId)))
    writeFileSync(
      join(request.outDir, request.runId, 'lab-replay-hour1.json'),
      serializeReplay('hour1', [{ t: T, pair: 'SOLUSDT', q: [-2, -1, 0.5, 2, 3], pUp: 0.55, dir: 'NEUTRAL', move: 1, best: 1.5, worst: -0.5 }])
    )
    return { id: 1, ok: true, result: { task: 'lab', runId: request.runId, horizons: [], ms: 3 } }
  })
}))

vi.mock('../electron/services/forecastTrainingService', () => ({
  getForecastTrainingState: () => fake.training,
  currentForecastCalibration: () => fake.calibration,
  onForecastTraining: (listener: () => void) => {
    fake.listeners.push(listener)
    return () => undefined
  }
}))

vi.mock('../electron/services/forecastDataService', () => ({ readForecastBars: async (pair: string) => fake.series.get(pair)?.m5 ?? [] }))
vi.mock('../electron/services/newsFeedService', () => ({ newsHistory: async () => fake.stories }))
vi.mock('../electron/services/forecastService', () => ({ forecastNewsReadings: () => fake.readings }))
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => fake.settings }))

const models = (): string => join(process.env.AI_TEST_USER_DATA as string, 'forecastModels')
const records = (): string => join(process.env.AI_TEST_USER_DATA as string, 'forecasts')

async function service() {
  const mod = await import('../electron/services/forecastLabService')
  mod.forecastLabForTest.reset()
  return mod
}

async function settle(mod: Awaited<ReturnType<typeof service>>): Promise<void> {
  await mod.forecastLabForTest.ensure()
  await mod.forecastLabForTest.making()
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-lab-'))
  fake.asked.length = 0
  fake.fail = false
  fake.training = { status: 'ready', current: { runId: 'run-a', fittedAt: 0, foldsRunId: 'run-a' }, calibratedRunId: 'run-a', progress: null, lastError: null, nextRefitAt: 1_800_000_000, promotions: [] }
  fake.listeners.length = 0
  fake.series = new Map()
  fake.stories = []
  fake.readings = {}
  fake.settings = {}
  fake.calibration = null
})

describe('making the Lab', () => {
  it('waits for a walk forward in use and an idle worker, makes it once a run, and reads it back at a start', async () => {
    fake.training = { ...fake.training, calibratedRunId: null }
    const lab = await service()
    await settle(lab)
    expect(fake.asked).toEqual([])
    fake.training = { ...fake.training, calibratedRunId: 'run-a', status: 'testing' }
    await settle(lab)
    expect(fake.asked).toEqual([])
    fake.training = { ...fake.training, status: 'ready' }
    fake.stories = [{ id: 's', publishedAt: T, tickers: ['SOL'], eventType: 'HACK', stale: false }]
    await settle(lab)
    expect(fake.asked).toHaveLength(1)
    expect(fake.asked[0]).toMatchObject({ task: 'lab', runId: 'run-a', stories: [{ publishedAt: T, tickers: ['SOL'], eventType: 'HACK' }] })
    expect((await lab.getForecastLab()).status).toMatchObject({ state: 'ready', runId: 'run-a' })
    await settle(lab)
    expect(fake.asked).toHaveLength(1)
    // On record with the training's lines.
    const month = readdirSync(models()).find((name) => name.startsWith('training-'))!
    expect(JSON.parse(readFileSync(join(models(), month), 'utf-8').trim())).toMatchObject({ kind: 'lab', runId: 'run-a', ok: true })
    // A start with the run's Lab on file reads it and asks nothing.
    vi.resetModules()
    const again = await service()
    await settle(again)
    expect(fake.asked).toHaveLength(1)
    expect((await again.getForecastLab()).lab?.runId).toBe('run-a')
  })

  it('makes a new walk forward\'s Lab, and keeps a failure on record without trying the run again', async () => {
    const lab = await service()
    fake.fail = true
    await settle(lab)
    expect((await lab.getForecastLab()).status).toMatchObject({ state: 'failed', runId: 'run-a', lastError: 'the worker ran out of memory' })
    await settle(lab)
    expect(fake.asked).toHaveLength(1)
    fake.fail = false
    fake.training = { ...fake.training, calibratedRunId: 'run-b' }
    await settle(lab)
    expect(fake.asked.map((request) => request.runId)).toEqual(['run-a', 'run-b'])
    expect((await lab.getForecastLab()).lab?.runId).toBe('run-b')
  })
})

describe('what the page is shown', () => {
  it('the leaderboard from the walk forward\'s own record, the live record of the last week, and the refit', async () => {
    mkdirSync(models(), { recursive: true })
    const now = Math.floor(Date.now() / 1000)
    const month = new Date(now * 1000).toISOString().slice(0, 7)
    const score = (pinball: number) => ({ n: 9000, pinball, coverage80: 0.8, coverage50: 0.5, direction: 0.5, bias: 0, width80: 2 })
    writeFileSync(
      join(models(), `training-${month}.jsonl`),
      [
        { kind: 'folds', runId: 'run-a', ok: true, horizons: [{ horizon: 'hour1', scores: [{ model: 'persistence', overall: score(0.4) }, { model: 'gbt', overall: score(0.38) }] }], degraded: ['gbt:hour1'] },
        // Another run's walk forward written after it: not the one in use.
        { kind: 'folds', runId: 'run-old', ok: true, horizons: [{ horizon: 'hour1', scores: [{ model: 'persistence', overall: score(0.5) }] }] }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    )
    fake.training = { ...fake.training, promotions: [{ horizon: 'hour1', model: 'gbt', promoted: true, lines: [] }] }
    fake.calibration = { horizons: { hour1: { variants: { v2: { weights: { pooled: [{ model: 'gbt', weight: 1 }] } } } } } }
    fake.settings = { forecast: { refitNightly: false } }
    mkdirSync(records(), { recursive: true })
    const t = Math.floor(now / 3600) * 3600 - 7200
    const line = { v: 'forecast-record-v1', id: 'p1', pair: 'SOLUSDT', t, at: t * 1000, price: 180, cls: 'large', regime: 'sideways', best: 'hour1', run: 'r', foldsRun: 'f', why: 'grid', h: { hour1: { q: [-2, -1, 0.5, 2, 3], pUp: 0.55, dir: 'NEUTRAL', strong: false, uncertain: false, rel: 'HIGH', width: 5, usualWidth: 4, skill: 0, dirSkill: 0, cell: 'large', v1: [-2, -1, 0.5, 2, 3], v1pUp: 0.5, parts: [] } } }
    const old = { ...line, id: 'p0', t: t - 9 * 86_400 }
    writeFileSync(join(records(), `predictions-${month}.jsonl`), `${JSON.stringify(old)}\n${JSON.stringify(line)}\n`)
    const outcome = { v: 'forecast-record-v1', id: 'p1', pair: 'SOLUSDT', h: 'hour1', t, due: t + 3600, move: 1, best: 1.2, worst: -0.2, below: '00011', v1below: '00011', in80: true, in50: true, up: true, dir: 'NEUTRAL', pUp: 0.55, cell: 'large', cls: 'large', errors: ['RIGHT_RANGE'] }
    writeFileSync(join(records(), `outcomes-${month}.jsonl`), `${JSON.stringify({ ...outcome, id: 'p0', t: t - 9 * 86_400 })}\n${JSON.stringify(outcome)}\n{torn\n`)
    const lab = await service()
    const view = await lab.getForecastLab()
    expect(view.leaderboard.map((row) => [row.model, row.weight, row.promoted, row.degraded])).toEqual([
      ['gbt', 1, true, true],
      ['persistence', 0, null, false]
    ])
    // A week back: the older outcome is out.
    expect(view.liveDays).toBe(7)
    expect(view.live.horizons.hour1?.outcomes).toBe(1)
    expect(view.refit).toMatchObject({ on: false, nextAt: 1_800_000_000, trainingStatus: 'ready' })
  })

  it('replays a tested hour with its path and its coin\'s stories and readings, and serves a pair\'s bars at a width', async () => {
    const m5: ForecastBar[] = []
    for (let time = T - 6 * 3600; time < T + 2 * 86_400; time += 300) m5.push({ time, open: 100, high: 101, low: 99, close: 100 + (time - T) / 36_000, volume: 2, quoteVolume: 200, takerBuyVolume: 1, trades: 3 })
    fake.series.set('SOLUSDT', { m5, h1: [] })
    fake.stories = [
      { id: 's1', publishedAt: T - 3600, tickers: ['SOL'], eventType: 'HACK', stale: false },
      { id: 's2', publishedAt: T - 1800, tickers: ['ETH'], eventType: 'ETF', stale: false }
    ]
    fake.readings = { s1: { ticker: 'SOL', relationship: 'DIRECT', direction: 'down', impact: 85, pricedIn: true, at: T - 3500 } }
    const lab = await service()
    await settle(lab)
    const replay = await lab.forecastReplay('SOLUSDT', T + 1234)
    expect(replay?.t).toBe(T)
    expect(Object.keys(replay!.horizons)).toEqual(['hour1'])
    expect(replay!.horizons.hour1).toMatchObject({ move: 1, dir: 'NEUTRAL' })
    expect(replay!.path[0].time).toBe(T - 3 * 3600)
    expect(replay!.path[replay!.path.length - 1].time).toBe(T + 86_400 - 300)
    expect(replay!.stories).toEqual([{ id: 's1', publishedAt: T - 3600, kind: 'HACK', reading: 'down, impact 85, priced in' }])
    expect(await lab.forecastReplay('SOLUSDT', T + 86_400 * 3)).toBeNull()
    expect(await lab.forecastReplay(42, T)).toBeNull()
    const hours = await lab.forecastBars('SOLUSDT', '1h', T, T + 6 * 3600)
    // The hours that had closed by the end: the one opening at T + 5 h closes at it.
    expect(hours.map((bar) => bar.time)).toEqual([T, T + 3600, T + 7200, T + 10_800, T + 14_400, T + 18_000])
    expect(hours[0]).toMatchObject({ open: 100, high: 101, low: 99, volume: 24 })
    expect(await lab.forecastBars('SOLUSDT', '5m', T, T + 3600)).toEqual([])
    expect(await lab.forecastBars('ETHUSDT', '1h', T, T + 3600)).toEqual([])
    expect(await lab.forecastBars('../SOLUSDT', '1h', T, T + 3600)).toEqual([])
    expect(existsSync(join(models(), 'run-a', 'lab-replay-hour1.json'))).toBe(true)
  })
})
