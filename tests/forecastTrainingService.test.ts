import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import type { GbtModel } from '../shared/forecast/ml/gbt'
import { QUANTILE_LEVELS } from '../shared/forecast/ml/quantile'
import type { FlatTree } from '../shared/forecast/ml/tree'
import { serializeFitted } from '../shared/forecast/modelFile'
import { MODELS_VERSION, type FittedHorizon } from '../shared/forecast/models'
import { nextNightlyAt, runIdAt } from '../shared/forecast/training'

// THE FORECAST'S FITS, KEPT AND RUN (electron/services/forecastTrainingService.ts; the V6 document, §13,
// §51 and §104): a fit once the bars are there, read back from its files and put in use; the walk
// forward's verdicts after it; the nightly refit; a failed fit leaving the models in use as they were;
// and the runs older than the two newest swept. The worker, the bars and the settings are faked.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

const fake = vi.hoisted(() => ({
  asked: [] as { task: string; runId: string }[],
  failFit: false,
  data: { ready: 25, pairs: 30 },
  listeners: [] as (() => void)[],
  settings: {} as Record<string, unknown>
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

const score = (pinball: number): Record<string, number> => ({ n: 9000, pinball, coverage80: 0.8, coverage50: 0.5, direction: 0.5, bias: 0, width80: 2.5 })

vi.mock('../electron/services/forecastWorkerService', () => ({
  askWorker: vi.fn(async (request: { task: string; outDir: string; runId: string }) => {
    fake.asked.push({ task: request.task, runId: request.runId })
    if (request.task === 'fit') {
      if (fake.failFit) return { id: 1, ok: false, error: 'the worker ran out of rows' }
      writeRun(request.outDir, request.runId)
      return { id: 1, ok: true, result: { task: 'fit', runId: request.runId, symbols: ['BTCUSDT'], rows: 100, span: { from: 0, to: 1 }, horizons: [], ms: 5 } }
    }
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
          scores: [
            { model: 'persistence', overall: score(0.3), byClass: {} },
            { model: 'gbt', overall: score(0.29), byClass: {} },
            { model: 'technical', overall: score(0.31), byClass: {} }
          ]
        })),
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
  })
})

describe('a start with models in use', () => {
  it('fits nothing while they are fresh', async () => {
    const runId = 'run-20261012-0030'
    writeRun(dir(), runId)
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 3600, foldsRunId: runId, promotions: [] }))
    const training = await service()
    training.startForecastTraining()
    await vi.waitFor(() => expect(training.getForecastTrainingState().status).toBe('ready'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake.asked).toEqual([])
    expect(training.currentForecastModels().size).toBe(HORIZONS.length)
    expect(training.getForecastTrainingState().current?.runId).toBe(runId)
  })

  it('refits stale ones, and keeps them in use when the fit fails, saying why', async () => {
    const runId = 'run-20261010-0030'
    writeRun(dir(), runId)
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
    const records = readdirSync(dir()).filter((name) => name.startsWith('training-'))
    expect(JSON.parse(readFileSync(join(dir(), records[0]), 'utf-8').trim())).toMatchObject({ kind: 'error', ok: false, why: 'stale' })
  })

  it('does not refit stale ones with the nightly refit switched off', async () => {
    const runId = 'run-20261010-0030'
    writeRun(dir(), runId)
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
    const promotions = [{ horizon: 'hour1', model: 'gbt', promoted: true, lines: [] }]
    writeFileSync(join(dir(), 'current.json'), JSON.stringify({ runId, fittedAt: Math.floor(Date.now() / 1000) - 30 * 3600, foldsRunId: runId, promotions }))
    const training = await service()
    const { askWorker } = await import('../electron/services/forecastWorkerService')
    const real = vi.mocked(askWorker).getMockImplementation()!
    vi.mocked(askWorker).mockImplementation(async (request, onProgress) => (request.task === 'folds' ? { id: 3, ok: false, error: 'the walk forward was cut short' } : real(request, onProgress)))
    await training.forecastTrainingForTest.run('stale')
    vi.mocked(askWorker).mockImplementation(real)
    const current = JSON.parse(readFileSync(join(dir(), 'current.json'), 'utf-8'))
    expect(current.runId).not.toBe(runId)
    expect(current.foldsRunId).toBe(runId)
    expect(current.promotions).toEqual(promotions)
    expect(training.getForecastTrainingState()).toMatchObject({ status: 'ready', lastError: 'the walk forward was cut short', promotions })
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
