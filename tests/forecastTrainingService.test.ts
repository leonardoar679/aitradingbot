import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import type { GbtModel } from '../shared/forecast/ml/gbt'
import { QUANTILE_LEVELS } from '../shared/forecast/ml/quantile'
import type { FlatTree } from '../shared/forecast/ml/tree'
import { serializeRunCalibration } from '../shared/forecast/calibrationFile'
import { serializeFitted } from '../shared/forecast/modelFile'
import { MODELS_VERSION, type FittedHorizon } from '../shared/forecast/models'
import { buildRunCalibration } from '../shared/forecast/runCalibration'
import { nextNightlyAt, runIdAt } from '../shared/forecast/training'
import { promoted, recordOf } from './forecastRecords'

// THE FORECAST'S FITS, KEPT AND RUN (electron/services/forecastTrainingService.ts; the V6 document, §13,
// §51 and §104): a fit once the bars are there, read back from its files and put in use; the walk
// forward's verdicts and its calibration after it; a calibration missing from a run on file made again
// from its record; the nightly refit; a failed fit leaving the models in use as they were; the runs
// older than the two newest swept; and a model the walk forward's last week found worse, told (§105).
// The worker, the bars, the settings and the desktop are faked.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

const fake = vi.hoisted(() => ({
  asked: [] as { task: string; runId: string }[],
  failFit: false,
  data: { ready: 25, pairs: 30 },
  listeners: [] as (() => void)[],
  settings: {} as Record<string, unknown>,
  /** Each model's score over the walk forward's four weeks, and over its last week alone (none on file
   * before V6 Stage 10), at every horizon. */
  scores: null as { model: string; overall: Record<string, number>; byClass: Record<string, never> }[] | null,
  lastWeek: null as { model: string; score: Record<string, number> }[] | null,
  told: [] as { title: string; body: string; extra?: Record<string, unknown> }[]
}))

const leaf = (value: number): FlatTree => ({ feature: [-1], threshold: [0], bin: [0], left: [-1], right: [-1], value: [value], cover: [0], gain: [0] })
const constantGbt = (base: number, loss: GbtModel['loss'] = { kind: 'l2' }): GbtModel => ({ kind: 'gbt', loss, base, features: 63, grown: 1, trees: [leaf(0)] })
const ridge = { kind: 'ridge' as const, mean: [0], scale: [1], coef: [0], intercept: -0.5, columns: [0] }
const RESIDUAL = [-1.3, -0.6, 0, 0.6, 1.3]

function tinyFitted(horizon: Horizon): FittedHorizon {
  return {
    version: MODELS_VERSION,
    horizon,
    persistence: { residual: RESIDUAL },
    volatility: { size: ridge, residual: RESIDUAL },
    technical: { center: ridge, residual: RESIDUAL },
    forest: { center: { kind: 'forest', features: 63, trees: [leaf(0)] }, residual: RESIDUAL },
    gbt: { center: constantGbt(0), size: constantGbt(0), residual: RESIDUAL },
    quantileGbt: { levels: QUANTILE_LEVELS.map((tau, index) => constantGbt(RESIDUAL[index], { kind: 'pinball', tau })) },
    gbtPrice: { center: constantGbt(0), size: constantGbt(0), residual: RESIDUAL }
  }
}

function writeRun(dir: string, runId: string): void {
  mkdirSync(join(dir, runId), { recursive: true })
  for (const horizon of HORIZONS) writeFileSync(join(dir, runId, `${horizon}.json`), serializeFitted(tinyFitted(horizon)))
}

const CALIBRATION = buildRunCalibration(new Map([['hour1', recordOf({ rows: 6000, seed: 41 })]]), promoted('hour1', ['persistence', 'gbt']), 'placeholder')

/** A run's calibration on file, as the worker writes it after a walk forward. */
function writeCalibration(dir: string, runId: string): void {
  mkdirSync(join(dir, runId), { recursive: true })
  writeFileSync(join(dir, runId, 'calibration.json'), serializeRunCalibration({ ...CALIBRATION, runId }))
}

const score = (pinball: number): Record<string, number> => ({ n: 9000, pinball, coverage80: 0.8, coverage50: 0.5, direction: 0.5, bias: 0, width80: 2.5 })

vi.mock('../electron/services/forecastWorkerService', () => ({
  askWorker: vi.fn(async (request: { task: string; outDir: string; runId: string }) => {
    fake.asked.push({ task: request.task, runId: request.runId })
    if (request.task === 'fit') {
      if (fake.failFit) return { id: 1, ok: false, error: 'the worker ran out of rows' }
      writeRun(request.outDir, request.runId)
      return { id: 1, ok: true, result: { task: 'fit', runId: request.runId, symbols: ['BTCUSDT'], rows: 100, span: { from: 0, to: 1 }, horizons: [], ms: 5 } }
    }
    writeCalibration(request.outDir, request.runId)
    if (request.task === 'calibrate') return { id: 3, ok: true, result: { task: 'calibrate', runId: request.runId, calibration: [], ms: 2 } }
    return {
      id: 2,
      ok: true,
      result: {
        task: 'folds',
        runId: request.runId,
        folds: [],
        horizons: HORIZONS.map((horizon) => ({
          horizon,
          tested: 9000,
          kept: 2000,
          scores: fake.scores ?? [
            { model: 'persistence', overall: score(0.3), byClass: {} },
            { model: 'gbt', overall: score(0.29), byClass: {} },
            { model: 'technical', overall: score(0.31), byClass: {} }
          ],
          ...(fake.lastWeek === null ? {} : { lastWeek: fake.lastWeek })
        })),
        calibration: [],
        ms: 7
      }
    }
  })
}))

vi.mock('../electron/services/forecastDataService', () => ({
  getForecastDataStatus: () => ({ ...fake.data }),
  onForecastBars: (listener: () => void) => {
    fake.listeners.push(listener)
    return () => void fake.listeners.splice(fake.listeners.indexOf(listener), 1)
  }
}))

vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => ({ ...fake.settings }) }))

vi.mock('../electron/services/noticeService', () => ({
  tell: (notice: { title: string; body: string; extra?: Record<string, unknown> }) => {
    fake.told.push(notice)
  }
}))

const dir = (): string => join(process.env.AI_TEST_USER_DATA as string, 'forecastModels')

async function service() {
  const mod = await import('../electron/services/forecastTrainingService')
  mod.forecastTrainingForTest.reset()
  return mod
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-training-'))
  fake.asked.length = 0
  fake.failFit = false
  fake.data = { ready: 25, pairs: 30 }
  fake.listeners.length = 0
  fake.settings = {}
  fake.scores = null
  fake.lastWeek = null
  fake.told.length = 0
})

describe('the first fit', () => {
  it('waits for the bars, puts the models in use read back from their files, then the walk forward\'s verdicts', async () => {
    fake.data = { ready: 5, pairs: 30 }
    const training = await service()
    training.startForecastTraining()
    await vi.waitFor(() => expect(fake.listeners.length).toBe(1))
    expect(fake.asked).toEqual([])
    fake.data = { ready: 25, pairs: 30 }
    fake.listeners[0]()
    await vi.waitFor(() => expect(training.getForecastTrainingState().status).toBe('ready'))
    expect(fake.asked.map((entry) => entry.task)).toEqual(['fit', 'folds'])
    const state = training.getForecastTrainingState()
    expect(state.current?.runId).toBe(fake.asked[0].runId)
    expect(state.current?.foldsRunId).toBe(fake.asked[0].runId)
    expect([...training.currentForecastModels().keys()].sort()).toEqual([...HORIZONS].sort())
    // Persistence is the floor; gbt beat it and is promoted; technical did not.
    const hour = state.promotions.filter((promotion) => promotion.horizon === 'hour1').map((promotion) => [promotion.model, promotion.promoted])
    expect(hour).toEqual([
      ['persistence', true],
      ['gbt', true],
      ['technical', false]
    ])
    const current = JSON.parse(readFileSync(join(dir(), 'current.json'), 'utf-8'))
    expect(current.runId).toBe(state.current?.runId)
    expect(current.promotions).toHaveLength(HORIZONS.length * 3)
    const records = readdirSync(dir()).filter((name) => name.startsWith('training-'))
    const lines = readFileSync(join(dir(), records[0]), 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((line) => line.kind)).toEqual(['fit', 'folds'])
    expect(lines.every((line) => line.ok === true)).toBe(true)
    expect(state.nextRefitAt).toBe(nextNightlyAt(Math.floor(Date.now() / 1000)))
    // The walk forward's calibration is in use with its verdicts.
    expect(state.calibratedRunId).toBe(state.current?.runId)
    expect(training.currentForecastCalibration()?.runId).toBe(state.current?.runId)
    expect(training.currentForecastCalibration()?.horizons.hour1?.variants.v2.weights.pooled).toEqual([{ model: 'gbt', weight: 1 }])
  })
})

describe('a start with models in use', () => {
  it('fits nothing while they are fresh', async () => {
    const runId = 'run-20261012-0030'
    writeRun(dir(), runId)
    writeCalibration(dir(), runId)
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 3600, foldsRunId: runId, promotions: [] }))
    const training = await service()
    training.startForecastTraining()
    await vi.waitFor(() => expect(training.getForecastTrainingState().status).toBe('ready'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake.asked).toEqual([])
    expect(training.currentForecastModels().size).toBe(HORIZONS.length)
    expect(training.getForecastTrainingState().current?.runId).toBe(runId)
    expect(training.currentForecastCalibration()?.runId).toBe(runId)
  })

  it('makes a calibration missing from its walk forward again from the record, fitting nothing', async () => {
    const runId = 'run-20261012-0030'
    writeRun(dir(), runId)
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 3600, foldsRunId: runId, promotions: [] }))
    const training = await service()
    training.startForecastTraining()
    await vi.waitFor(() => expect(training.currentForecastCalibration()?.runId).toBe(runId))
    expect(fake.asked).toEqual([{ task: 'calibrate', runId }])
    expect(training.getForecastTrainingState().calibratedRunId).toBe(runId)
    const records = readdirSync(dir()).filter((name) => name.startsWith('training-'))
    expect(JSON.parse(readFileSync(join(dir(), records[0]), 'utf-8').trim())).toMatchObject({ kind: 'calibrate', runId, ok: true })
  })

  it("makes it again where the file on record is another run's", async () => {
    const runId = 'run-20261012-0030'
    writeRun(dir(), runId)
    writeCalibration(dir(), runId)
    writeFileSync(join(dir(), runId, 'calibration.json'), serializeRunCalibration({ ...CALIBRATION, runId: 'run-20261001-0030' }))
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 3600, foldsRunId: runId, promotions: [] }))
    const training = await service()
    training.startForecastTraining()
    await vi.waitFor(() => expect(training.currentForecastCalibration()?.runId).toBe(runId))
    expect(fake.asked).toEqual([{ task: 'calibrate', runId }])
  })

  it('refits stale ones, and keeps them in use when the fit fails, saying why', async () => {
    const runId = 'run-20261010-0030'
    writeRun(dir(), runId)
    writeCalibration(dir(), runId)
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 30 * 3600, foldsRunId: runId, promotions: [] }))
    fake.failFit = true
    const training = await service()
    training.startForecastTraining()
    await vi.waitFor(() => expect(fake.asked.length).toBe(1))
    await vi.waitFor(() => expect(training.getForecastTrainingState().lastError).toMatch(/ran out of rows/))
    const state = training.getForecastTrainingState()
    expect(state.status).toBe('ready')
    expect(state.current?.runId).toBe(runId)
    expect(training.currentForecastModels().size).toBe(HORIZONS.length)
    // The error is said at once, and written a moment after.
    await vi.waitFor(() => {
      const records = readdirSync(dir()).filter((name) => name.startsWith('training-'))
      expect(JSON.parse(readFileSync(join(dir(), records[0]), 'utf-8').trim())).toMatchObject({ kind: 'error', ok: false, why: 'stale' })
    })
  })

  it('does not refit stale ones with the nightly refit switched off', async () => {
    const runId = 'run-20261010-0030'
    writeRun(dir(), runId)
    writeCalibration(dir(), runId)
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 30 * 3600, foldsRunId: runId, promotions: [] }))
    fake.settings = { forecast: { refitNightly: false } }
    const training = await service()
    training.startForecastTraining()
    await vi.waitFor(() => expect(training.getForecastTrainingState().status).toBe('ready'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake.asked).toEqual([])
  })
})

describe('a refit', () => {
  it('is asked of the worker once however often it is asked for at once', async () => {
    const training = await service()
    await Promise.all([training.forecastTrainingForTest.run('first'), training.forecastTrainingForTest.run('first')])
    expect(fake.asked.map((entry) => entry.task)).toEqual(['fit', 'folds'])
  })

  it('puts its models in use at once, and keeps the walk forward before it until its own is done', async () => {
    const runId = 'run-20261010-0030'
    writeRun(dir(), runId)
    writeCalibration(dir(), runId)
    const promotions = [{ horizon: 'hour1', model: 'gbt', promoted: true, lines: [] }]
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 30 * 3600, foldsRunId: runId, promotions }))
    const training = await service()
    const { askWorker } = await import('../electron/services/forecastWorkerService')
    const real = vi.mocked(askWorker).getMockImplementation()!
    vi.mocked(askWorker).mockImplementation(async (request, onProgress) => (request.task === 'folds' ? { id: 3, ok: false, error: 'the walk forward was cut short' } : real(request, onProgress)))
    training.startForecastTraining()
    await vi.waitFor(() => expect(training.getForecastTrainingState().lastError).toBe('the walk forward was cut short'))
    vi.mocked(askWorker).mockImplementation(real)
    const current = JSON.parse(readFileSync(join(dir(), 'current.json'), 'utf-8'))
    expect(current.runId).not.toBe(runId)
    expect(current.foldsRunId).toBe(runId)
    expect(current.promotions).toEqual(promotions)
    expect(training.getForecastTrainingState()).toMatchObject({ status: 'ready', promotions, calibratedRunId: runId })
    expect(training.currentForecastCalibration()?.runId).toBe(runId)
  })

  it('keeps the verdicts and the calibration before it when its own calibration cannot be read back', async () => {
    const runId = 'run-20261010-0030'
    writeRun(dir(), runId)
    writeCalibration(dir(), runId)
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 30 * 3600, foldsRunId: runId, promotions: [] }))
    const training = await service()
    const { askWorker } = await import('../electron/services/forecastWorkerService')
    const real = vi.mocked(askWorker).getMockImplementation()!
    vi.mocked(askWorker).mockImplementation(async (request, onProgress) => {
      const answer = await real(request, onProgress)
      const { outDir, runId: asked } = request as { outDir: string; runId: string }
      if (request.task === 'folds') writeFileSync(join(outDir, asked, 'calibration.json'), '{"torn"')
      return answer
    })
    training.startForecastTraining()
    await vi.waitFor(() => expect(training.getForecastTrainingState().lastError).toMatch(/calibration of .+ could not be read back/))
    vi.mocked(askWorker).mockImplementation(real)
    expect(JSON.parse(readFileSync(join(dir(), 'current.json'), 'utf-8')).foldsRunId).toBe(runId)
    expect(training.currentForecastCalibration()?.runId).toBe(runId)
  })

  it('is made at night when it is on, and not when it is off', async () => {
    const training = await service()
    fake.settings = { forecast: { refitNightly: false } }
    await training.forecastTrainingForTest.nightly()
    expect(fake.asked).toEqual([])
    fake.settings = {}
    await training.forecastTrainingForTest.nightly()
    expect(fake.asked.map((entry) => entry.task)).toEqual(['fit', 'folds'])
  })
})

describe('the runs on file', () => {
  it('are swept after a walk forward to the two newest', async () => {
    for (const old of ['run-20261001-0030', 'run-20261002-0030', 'run-20261003-0030']) writeRun(dir(), old)
    const training = await service()
    await training.forecastTrainingForTest.run('first')
    const runs = readdirSync(dir()).filter((name) => name.startsWith('run-')).sort()
    expect(runs).toEqual(['run-20261003-0030', runIdAt(Math.floor(Date.now() / 1000))].sort())
    expect(existsSync(join(dir(), 'run-20261001-0030'))).toBe(false)
  })

  it('are not put in use when a horizon\'s file is damaged', async () => {
    const training = await service()
    const { askWorker } = await import('../electron/services/forecastWorkerService')
    vi.mocked(askWorker).mockImplementationOnce(async (request) => {
      const { runId, outDir } = request as { runId: string; outDir: string }
      writeRun(outDir, runId)
      writeFileSync(join(outDir, runId, 'hours4.json'), '{"broken":true}')
      return { id: 1, ok: true, result: { task: 'fit', runId, symbols: [], rows: 0, span: { from: 0, to: 0 }, horizons: [], ms: 1 } }
    })
    await training.forecastTrainingForTest.run('first')
    expect(training.currentForecastModels().size).toBe(0)
    expect(training.getForecastTrainingState().status).toBe('failed')
    expect(training.getForecastTrainingState().lastError).toMatch(/could not be read back/)
  })

  it("are not put in use when a horizon's file holds another horizon's models", async () => {
    const runId = 'run-20261012-0030'
    writeRun(dir(), runId)
    writeFileSync(join(dir(), runId, 'hours4.json'), serializeFitted(tinyFitted('hour1')))
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 3600, foldsRunId: runId, promotions: [] }))
    const training = await service()
    training.startForecastTraining()
    await vi.waitFor(() => expect(training.getForecastTrainingState().status).toBe('ready'))
    // Not read back, the run is not in use: a fit was made in its place.
    expect(fake.asked[0]?.task).toBe('fit')
    expect(training.getForecastTrainingState().current?.runId).not.toBe(runId)
  })
})

describe('a degraded model (§105)', () => {
  it("is told from the walk forward's last week for a model in use, a model and horizon a thread, a day a notice, and stays in use", async () => {
    // Over the four weeks gbt, the forest, the quantile boosting and gbt-price beat persistence and are
    // promoted; technical lost to it and is not.
    fake.scores = [
      { model: 'persistence', overall: score(0.3), byClass: {} },
      { model: 'gbt', overall: score(0.29), byClass: {} },
      { model: 'technical', overall: score(0.31), byClass: {} },
      { model: 'random-forest', overall: score(0.29), byClass: {} },
      { model: 'quantile-gbt', overall: score(0.29), byClass: {} },
      { model: 'gbt-price', overall: score(0.29), byClass: {} }
    ]
    fake.lastWeek = [
      { model: 'persistence', score: score(0.3) },
      // Within every line: not told.
      { model: 'gbt', score: score(0.29) },
      // A pinball loss above persistence's, but never promoted: not told.
      { model: 'technical', score: score(0.32) },
      // Its 80% range held 65% of the week.
      { model: 'random-forest', score: { ...score(0.29), coverage80: 0.65 } },
      // Its median off by 0.3 of the usual move.
      { model: 'quantile-gbt', score: { ...score(0.29), bias: -0.3 } },
      // Too few outcomes in the week to judge: not told, however far off.
      { model: 'gbt-price', score: { ...score(0.5), n: 150, coverage80: 0.4 } }
    ]
    const training = await service()
    await training.forecastTrainingForTest.run('first')
    expect(training.getForecastTrainingState().status).toBe('ready')
    const threads = fake.told.map((notice) => notice.extra?.thread)
    expect(threads).toEqual(HORIZONS.flatMap((horizon) => ['random-forest', 'quantile-gbt'].map((model) => `degraded:forecast:${model}:${horizon}`)))
    expect(fake.told.every((notice) => notice.extra?.kind === 'MODEL_DEGRADED' && notice.extra?.severity === 'watch' && notice.extra?.threadSeconds === 86_400)).toBe(true)
    expect(fake.told[0].title).toBe('Forecast model degraded: random-forest, 5 minutes')
    expect(fake.told[0].body).toMatch(/held 65\.0% of the week's outcomes/)
    expect(fake.told[1].body).toMatch(/off by -0\.30 of the usual move/)
    // On record with the walk forward; nothing switched off.
    const records = readdirSync(dir()).filter((name) => name.startsWith('training-'))
    const folds = readFileSync(join(dir(), records[0]), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((line) => line.kind === 'folds')
    expect(folds.degraded).toEqual(HORIZONS.flatMap((horizon) => ['random-forest', 'quantile-gbt'].map((model) => `${model}:${horizon}`)))
    expect([...training.currentForecastModels().keys()].sort()).toEqual([...HORIZONS].sort())
  })

  it('tells persistence too where its own range held the wrong share, though it cannot lose to itself', async () => {
    fake.lastWeek = [
      { model: 'persistence', score: { ...score(0.3), coverage80: 0.62 } },
      // Under persistence's loss and within the lines: not told.
      { model: 'gbt', score: score(0.29) }
    ]
    const training = await service()
    await training.forecastTrainingForTest.run('first')
    expect(fake.told.map((notice) => notice.extra?.thread)).toEqual(HORIZONS.map((horizon) => `degraded:forecast:persistence:${horizon}`))
    expect(fake.told[0].body).toMatch(/^Over the last week its 80% interval held 62\.0% of the week's outcomes\. /)
  })

  it('tells nothing from a walk forward with no last week on file', async () => {
    const training = await service()
    await training.forecastTrainingForTest.run('first')
    expect(training.getForecastTrainingState().status).toBe('ready')
    expect(fake.told).toEqual([])
  })
})
