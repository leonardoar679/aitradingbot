import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HORIZONS } from '../shared/forecast/features'
import { foldModelName } from '../shared/forecast/modelFile'
import { REPLAY_FILE_VERSION, REPLAY_VERSION, type ReplayFile } from '../shared/forecast/replay'

// THE REPLAY OUT OF SAMPLE, IN THE APP (electron/services/forecastReplayService.ts; V7.2-R Stage 5): the newest walk
// forward on file that kept every week's models after the first is replayed in the worker once the training is idle,
// once a run, read back from its file at a start; a failure kept and not tried again for the run; a walk forward missing
// a week's model or its log's line passed over. The worker and the training are faked.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

const fake = vi.hoisted(() => ({
  asked: [] as Record<string, unknown>[],
  fail: false,
  training: { status: 'ready' as string },
  listeners: [] as (() => void)[]
}))

const fileOf = (runId: string): ReplayFile => ({ version: REPLAY_FILE_VERSION, runId, madeAt: 1_800_000_000, ms: 1234, summary: { version: REPLAY_VERSION, segments: [], closes: 10, forecasts: 4, outcomes: 4, cells: [], assumptions: ['said'] } })

vi.mock('../electron/services/forecastWorkerService', () => ({
  askWorker: vi.fn(async (request: { task: string; outDir: string; runId: string }, onProgress?: (progress: unknown) => void) => {
    fake.asked.push(request)
    onProgress?.({ step: 'replaying 2026-10-02', done: 288, total: 6056 })
    if (fake.fail) return { id: 1, ok: false, error: 'the worker ran out of memory' }
    writeFileSync(join(request.outDir, 'replay-trades.jsonl'), '')
    writeFileSync(join(request.outDir, 'replay.json'), JSON.stringify(fileOf(request.runId)))
    return { id: 1, ok: true, result: { task: 'replay', runId: request.runId, weeks: 3, closes: 10, trades: 0, ms: 3 } }
  })
}))

vi.mock('../electron/services/forecastTrainingService', () => ({
  getForecastTrainingState: () => fake.training,
  onForecastTraining: (listener: () => void) => {
    fake.listeners.push(listener)
    return () => undefined
  }
}))

const models = (): string => join(process.env.AI_TEST_USER_DATA as string, 'forecastModels')
const FOLDS = [0, 1, 2, 3].map((index) => ({ index, from: 1_790_000_000 + index * 604_800, to: 1_790_000_000 + (index + 1) * 604_800 }))
const PROMOTIONS = [{ horizon: 'hour1', model: 'gbt', promoted: true, lines: [] }]

/** A walk forward on file: its weeks' models (all, or all but one), and its line in the training log (or none). */
function walkForward(runId: string, options: { missing?: string; logged?: boolean } = {}): void {
  const dir = join(models(), runId)
  mkdirSync(dir, { recursive: true })
  for (const fold of FOLDS) for (const horizon of HORIZONS) if (foldModelName(fold.index, horizon) !== options.missing) writeFileSync(join(dir, foldModelName(fold.index, horizon)), '{}')
  if (options.logged === false) return
  writeFileSync(join(models(), 'training-2026-10.jsonl'), `${JSON.stringify({ at: 1, kind: 'folds', runId, ok: true, folds: FOLDS, promotions: PROMOTIONS })}\n`, { flag: 'a' })
}

async function service() {
  const mod = await import('../electron/services/forecastReplayService')
  mod.forecastReplayForTest.reset()
  return mod
}

async function settled(mod: Awaited<ReturnType<typeof service>>): Promise<void> {
  await mod.forecastReplayForTest.ensure()
  await mod.forecastReplayForTest.making()
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'replay-service-'))
  process.env.AI_TEST_USER_DATA = root
  mkdirSync(join(root, 'forecastModels'), { recursive: true })
  fake.asked = []
  fake.fail = false
  fake.training = { status: 'ready' }
  fake.listeners = []
})

describe('the replay out of sample in the app', () => {
  it('replays the newest walk forward that kept every week, once the training is idle, and reads it back at a start', async () => {
    walkForward('run-20261020-0828')
    walkForward('run-20261022-1033')
    // Newer, but a week's model is missing; newer still, but the log does not say its weeks.
    walkForward('run-20261023-0030', { missing: foldModelName(2, 'hours4') })
    walkForward('run-20261024-0030', { logged: false })
    const mod = await service()
    fake.training = { status: 'testing' }
    await settled(mod)
    expect(fake.asked).toEqual([])
    expect(mod.getForecastReplayState().status).toBe('waiting')
    fake.training = { status: 'ready' }
    await settled(mod)
    expect(fake.asked).toHaveLength(1)
    expect(fake.asked[0]).toMatchObject({ task: 'replay', runId: 'run-20261022-1033', folds: FOLDS, promotions: PROMOTIONS, outDir: models() })
    expect(mod.getForecastReplayState()).toMatchObject({ status: 'ready', runId: 'run-20261022-1033', progress: null, lastError: null, file: fileOf('run-20261022-1033') })
    // Once a run.
    await settled(mod)
    expect(fake.asked).toHaveLength(1)
    // A start: read back from its file, the worker not asked.
    const again = await service()
    await settled(again)
    expect(fake.asked).toHaveLength(1)
    expect(again.getForecastReplayState()).toMatchObject({ status: 'ready', runId: 'run-20261022-1033' })
  })

  it('keeps a failure and does not try the run again; replays the next walk forward when it comes', async () => {
    walkForward('run-20261022-1033')
    fake.fail = true
    const mod = await service()
    await settled(mod)
    expect(mod.getForecastReplayState()).toMatchObject({ status: 'failed', runId: 'run-20261022-1033', lastError: 'the worker ran out of memory', file: null })
    await settled(mod)
    expect(fake.asked).toHaveLength(1)
    fake.fail = false
    walkForward('run-20261023-0030')
    await settled(mod)
    expect(fake.asked.map((request) => request.runId)).toEqual(['run-20261022-1033', 'run-20261023-0030'])
    expect(mod.getForecastReplayState()).toMatchObject({ status: 'ready', runId: 'run-20261023-0030' })
  })

  it('shows the replay kept of an older walk forward while a newer one is made, and waits with nothing to replay', async () => {
    const empty = await service()
    await settled(empty)
    expect(empty.getForecastReplayState()).toMatchObject({ status: 'waiting', runId: null, file: null })
    writeFileSync(join(models(), 'replay.json'), JSON.stringify(fileOf('run-20261020-0828')))
    walkForward('run-20261022-1033')
    const mod = await service()
    let during: unknown = null
    const asking = vi.mocked((await import('../electron/services/forecastWorkerService')).askWorker)
    asking.mockImplementationOnce(async (request) => {
      during = mod.getForecastReplayState()
      fake.asked.push(request as unknown as Record<string, unknown>)
      writeFileSync(join(models(), 'replay.json'), JSON.stringify(fileOf('run-20261022-1033')))
      return { id: 1, ok: true, result: { task: 'replay', runId: 'run-20261022-1033', weeks: 3, closes: 10, trades: 0, ms: 3 } }
    })
    await settled(mod)
    expect(during).toMatchObject({ status: 'replaying', runId: 'run-20261022-1033', file: { runId: 'run-20261020-0828' } })
    expect(mod.getForecastReplayState()).toMatchObject({ status: 'ready', file: { runId: 'run-20261022-1033' } })
    // A kept file of another version is not read.
    writeFileSync(join(models(), 'replay.json'), JSON.stringify({ ...fileOf('run-20261022-1033'), version: 'replay-file-v0' }))
    const fresh = await service()
    await settled(fresh)
    expect(fake.asked.filter((request) => request.runId === 'run-20261022-1033')).toHaveLength(2)
    rmSync(process.env.AI_TEST_USER_DATA as string, { recursive: true, force: true })
  })

  it('starts once, and looks again whenever the training changes', async () => {
    walkForward('run-20261022-1033')
    fake.training = { status: 'fitting' }
    const mod = await service()
    mod.startForecastReplay()
    mod.startForecastReplay()
    expect(fake.listeners).toHaveLength(1)
    fake.training = { status: 'ready' }
    fake.listeners[0]()
    await vi.waitFor(() => expect(mod.getForecastReplayState().status).toBe('ready'))
    expect(fake.asked).toHaveLength(1)
  })
})
