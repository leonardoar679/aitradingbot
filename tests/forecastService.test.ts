import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORECAST_BAR_SECONDS, coarseBars, type ForecastBar } from '../shared/forecast/bars'
import { aciUpdate } from '../shared/forecast/calibration'
import { FEATURE_NAMES, HORIZONS, type Horizon } from '../shared/forecast/features'
import type { GbtModel } from '../shared/forecast/ml/gbt'
import { QUANTILE_LEVELS } from '../shared/forecast/ml/quantile'
import type { FlatTree } from '../shared/forecast/ml/tree'
import { MODELS_VERSION, type FittedHorizon } from '../shared/forecast/models'
import { buildRunCalibration, type RunCalibration } from '../shared/forecast/runCalibration'
import { emptyLiveState, type LiveState } from '../shared/liveMarket'
import { promoted, recordOf } from './forecastRecords'

// THE FORECAST, LIVE (electron/services/forecastService.ts; the V6 document, §38-43): every pair
// forecast at every close once there are models and a calibration; the quarter-hour's forecasts on
// record, and each horizon's outcome written once when due, never before; the adaptive levels moved
// once a moment; a forecast made again between closes for a story, an event or a price out of its
// range, at most once a minute; and the outcomes still owed read back at a restart. The bars, the
// models and the calibration are faked; the forecasting is the app's own.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

const T0 = Date.parse('2026-08-01T00:00:00Z') / 1000
const DAYS = 34
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']

function walk(seed: number, base: number): ForecastBar[] {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const gauss = (): number => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next())
  const bars: ForecastBar[] = []
  let price = base
  for (let index = 0; index < DAYS * 288; index++) {
    const open = price
    price = price * Math.exp(0.002 * gauss())
    const volume = 100 * (0.5 + next())
    bars.push({ time: T0 + index * FORECAST_BAR_SECONDS, open, high: Math.max(open, price) * 1.0005, low: Math.min(open, price) * 0.9995, close: price, volume, quoteVolume: volume * price, takerBuyVolume: volume * next(), trades: 50 })
  }
  return bars
}

const fake = vi.hoisted(() => ({
  market: new Map<string, ForecastBar[]>(),
  /** The close the bars are held up to. */
  now: 0,
  /** Bars left out of what is held, by pair: a gap. */
  gaps: new Map<string, [number, number]>(),
  barListeners: [] as ((closedAt: number) => void)[],
  models: new Map<string, unknown>(),
  calibration: null as unknown,
  current: null as { runId: string; fittedAt: number; foldsRunId: string | null } | null,
  /** What the desktop was told, and the settings read for the pairs held and traded. */
  told: [] as { title: string; body: string; extra?: Record<string, unknown> }[],
  settings: {} as Record<string, unknown>
}))

vi.mock('../electron/services/noticeService', () => ({
  tell: (notice: { title: string; body: string; extra?: Record<string, unknown> }) => {
    fake.told.push(notice)
  }
}))

vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => fake.settings }))

vi.mock('../electron/services/forecastDataService', () => ({
  forecastUniverse: () => [...fake.market.keys()],
  forecastSeries: (symbol: string) => {
    const bars = fake.market.get(symbol)
    if (bars === undefined) return null
    const gap = fake.gaps.get(symbol)
    const m5 = bars.filter((bar) => bar.time < fake.now && (gap === undefined || bar.time < gap[0] || bar.time >= gap[1]))
    return { m5, h1: coarseBars(m5, '1h', fake.now) }
  },
  onForecastBars: (listener: (closedAt: number) => void) => {
    fake.barListeners.push(listener)
    return () => undefined
  }
}))

vi.mock('../electron/services/marketResearchService', () => ({
  getResearchState: () => ({ pairs: [{ symbol: 'BTCUSDT', quoteVolume24h: 2e9 }, { symbol: 'SOLUSDT', quoteVolume24h: 4e8 }] })
}))

vi.mock('../electron/services/forecastTrainingService', () => ({
  currentForecastModels: () => fake.models,
  currentForecastCalibration: () => fake.calibration,
  getForecastTrainingState: () => ({ status: 'ready', current: fake.current, calibratedRunId: null, progress: null, lastError: null, nextRefitAt: null, promotions: [] }),
  onForecastTraining: () => () => undefined
}))

const leaf = (value: number): FlatTree => ({ feature: [-1], threshold: [0], bin: [0], left: [-1], right: [-1], value: [value], cover: [0], gain: [0] })
const constantGbt = (base: number, loss: GbtModel['loss'] = { kind: 'l2' }): GbtModel => ({ kind: 'gbt', loss, base, features: 63, grown: 1, trees: [leaf(0)] })
const ridge = { kind: 'ridge' as const, mean: [0], scale: [1], coef: [0], intercept: 0, columns: [0] }
const RESIDUAL = [-1.28, -0.67, 0, 0.67, 1.28]
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

const CALIBRATION: RunCalibration = buildRunCalibration(
  new Map(HORIZONS.map((horizon, index) => [horizon, recordOf({ rows: 6000, seed: 50 + index, horizon })])),
  HORIZONS.flatMap((horizon) => promoted(horizon, ['persistence', 'gbt'])),
  'run-folds'
)
const MARKET = new Map(SYMBOLS.map((symbol, index) => [symbol, walk(11 + index * 17, [60_000, 2_500, 150, 0.6][index])]))
/** A close on the hour, thirty days in. */
const HOUR = T0 + 30 * 86_400

const dir = (): string => join(process.env.AI_TEST_USER_DATA as string, 'forecasts')
const lines = (name: string): Record<string, unknown>[] => {
  const path = join(dir(), name)
  return existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}
const month = '2026-08'

async function engine(options: { live?: LiveState } = {}) {
  const mod = await import('../electron/services/forecastService')
  mod.forecastForTest.reset()
  mod.startForecast(() => options.live ?? null)
  return mod
}

async function closeAt(mod: Awaited<ReturnType<typeof engine>>, closedAt: number): Promise<void> {
  fake.now = closedAt
  await mod.forecastForTest.pass(closedAt)
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-live-'))
  fake.market = MARKET
  fake.now = HOUR
  fake.gaps = new Map()
  fake.barListeners.length = 0
  fake.models = new Map(HORIZONS.map((horizon) => [horizon, tinyFitted(horizon)]))
  fake.calibration = CALIBRATION
  fake.current = { runId: 'run-models', fittedAt: HOUR - 3600, foldsRunId: 'run-folds' }
  fake.told = []
  fake.settings = {}
})

describe('a close', () => {
  it('forecasts every pair with its bars, once there are models and their calibration', async () => {
    fake.models = new Map()
    const live = await engine()
    await closeAt(live, HOUR)
    expect(live.getForecastEngineState()).toMatchObject({ status: 'waiting', waitingFor: 'models' })
    fake.models = new Map(HORIZONS.map((horizon) => [horizon, tinyFitted(horizon)]))
    fake.calibration = null
    await closeAt(live, HOUR)
    expect(live.getForecastEngineState().waitingFor).toBe('calibration')
    fake.calibration = CALIBRATION
    await closeAt(live, HOUR)
    const state = live.getForecastEngineState()
    expect(state).toMatchObject({ status: 'running', waitingFor: null, predictions: SYMBOLS.length, lastPassAt: HOUR })
    const sol = live.forecastOf('SOLUSDT')!
    expect(Object.keys(sol.horizons).sort()).toEqual([...HORIZONS].sort())
    expect(sol.barTime).toBe(HOUR)
    expect(sol.currentPrice).toBe(MARKET.get('SOLUSDT')!.find((bar) => bar.time === HOUR - 300)!.close)
    expect(sol.versions).toMatchObject({ run: 'run-models', foldsRun: 'run-folds' })
    expect(live.latestForecasts().map((prediction) => prediction.pair)).toEqual([...SYMBOLS].sort())
    // It is told on the onForecastBars listener it set at start.
    expect(fake.barListeners).toHaveLength(1)
  })

  it('forecasts from the close it is told, whatever later bars are held, and writes no outcome early', async () => {
    const live = await engine()
    fake.now = HOUR + 600
    await live.forecastForTest.pass(HOUR)
    expect(live.forecastOf('SOLUSDT')!.currentPrice).toBe(MARKET.get('SOLUSDT')!.find((bar) => bar.time === HOUR - 300)!.close)
    // The 5-minute horizon recorded at HOUR is due at HOUR + 300: not by HOUR, though its bars are held.
    await live.forecastForTest.pass(HOUR)
    expect(lines(`outcomes-${month}.jsonl`)).toHaveLength(0)
  })

  it('leaves out a pair whose bar at the close is not there', async () => {
    fake.gaps.set('XRPUSDT', [HOUR - 300, HOUR])
    const live = await engine()
    await closeAt(live, HOUR)
    expect(live.forecastOf('XRPUSDT')).toBeNull()
    expect(live.getForecastEngineState().predictions).toBe(3)
  })
})

describe('the trade', () => {
  it("is decided for every pair at its lead horizon after a pass, ranked, and kept apart from the forecast", async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    const ranking = live.forecastRanking()
    expect(ranking.at).toBe(HOUR)
    expect(ranking.ranked.map((entry) => entry.pair).sort()).toEqual([...SYMBOLS].sort())
    expect(ranking.top3).toHaveLength(3)
    expect(ranking.top10).toHaveLength(SYMBOLS.length)
    const sol = live.forecastDecision('SOLUSDT')!
    expect(sol.horizon).toBe(live.forecastOf('SOLUSDT')!.bestHorizon ?? 'hour1')
    // No skilful direction in this market, and no live book: no call, no live price.
    expect(sol).toMatchObject({ decision: 'NO_TRADE', side: null })
    expect(sol.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['NO_CALL', 'STALE_PRICE']))
    // The research's volumes give the liquidity; a pair it has none for is at the floor.
    const bySymbol = new Map(ranking.ranked.map((entry) => [entry.pair, entry]))
    expect(bySymbol.get('BTCUSDT')!.parts.liquidity).toBe(1)
    expect(bySymbol.get('XRPUSDT')!.parts.liquidity).toBe(0.2)
    expect(live.forecastDecision('NOPEUSDT')).toBeNull()
    // On record with the forecast: the decision at its lead horizon, and each horizon's quality.
    const line = lines(`predictions-${month}.jsonl`).find((entry) => entry.pair === 'SOLUSDT')!
    expect(line.trade).toMatchObject({ h: sol.horizon, side: null, ok: false })
    expect((line.trade as { why: string[] }).why).toEqual(sol.reasons.map((reason) => reason.code))
    expect(typeof (line.h as Record<string, { qual: number }>).hour1.qual).toBe('number')
  })
})

describe('the record', () => {
  it('holds every pair at the quarter-hours -- the short horizons, all five on the hour -- and nothing between', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    await closeAt(live, HOUR + 300)
    await closeAt(live, HOUR + 900)
    const recorded = lines(`predictions-${month}.jsonl`)
    expect(recorded.map((line) => line.t)).toEqual([...Array(4).fill(HOUR), ...Array(4).fill(HOUR + 900)])
    expect(Object.keys(recorded[0].h as object).sort()).toEqual([...HORIZONS].sort())
    expect(Object.keys(recorded[4].h as object).sort()).toEqual(['hour1', 'minutes15', 'minutes5'])
    expect(recorded.every((line) => line.why === 'grid')).toBe(true)
    // A close passed again does not record it twice.
    await closeAt(live, HOUR + 900)
    expect(lines(`predictions-${month}.jsonl`)).toHaveLength(8)
  })

  it('writes each horizon\'s outcome once when it is due, never before, and moves the adaptive levels once a moment', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    expect(lines(`outcomes-${month}.jsonl`)).toHaveLength(0)
    await closeAt(live, HOUR + 300)
    let outcomes = lines(`outcomes-${month}.jsonl`)
    expect(outcomes.map((line) => line.h)).toEqual(Array(4).fill('minutes5'))
    expect(outcomes.every((line) => line.t === HOUR && line.due === HOUR + 300)).toBe(true)
    const sol = outcomes.find((line) => line.pair === 'SOLUSDT')!
    const bars = MARKET.get('SOLUSDT')!
    const from = bars.find((bar) => bar.time === HOUR - 300)!.close
    expect(sol.move).toBeCloseTo((bars.find((bar) => bar.time === HOUR)!.close / from - 1) * 100, 4)
    const aci = JSON.parse(readFileSync(join(dir(), 'aci.json'), 'utf-8'))
    expect(aci.calibrationRun).toBe('run-folds')
    expect(aci.updatedAt).toBe(HOUR + 300)
    expect(Object.keys(aci.levels).sort()).toEqual(['minutes5/v1/pooled', 'minutes5/v2/pooled'])
    // One step for the moment, by the share of its four outcomes below each level.
    const share = [0, 1, 2, 3, 4].map((level) => outcomes.filter((line) => (line.below as string)[level] === '1').length / outcomes.length)
    expect(aci.levels['minutes5/v2/pooled']).toEqual(aciUpdate([0.1, 0.25, 0.5, 0.75, 0.9], share))
    // Passed again at the same close: nothing written twice, the levels not moved again.
    await closeAt(live, HOUR + 300)
    expect(lines(`outcomes-${month}.jsonl`)).toHaveLength(4)
    expect(JSON.parse(readFileSync(join(dir(), 'aci.json'), 'utf-8'))).toEqual(aci)
    await closeAt(live, HOUR + 900)
    outcomes = lines(`outcomes-${month}.jsonl`)
    expect(outcomes.filter((line) => line.h === 'minutes15')).toHaveLength(4)
    expect(live.getForecastEngineState()).toMatchObject({ outcomes: 8, missing: 0 })
  })

  it('reads each forecast at the levels the adaptive step keeps for its cell', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    const plain = live.forecastOf('SOLUSDT')!.horizons.hour1!.width80Pct
    live.forecastForTest.setAci({ calibrationRun: 'run-folds', levels: { 'hour1/v2/pooled': [0.02, 0.25, 0.5, 0.75, 0.98] }, updatedAt: HOUR })
    await closeAt(live, HOUR)
    expect(live.forecastOf('SOLUSDT')!.horizons.hour1!.width80Pct).toBeGreaterThan(plain)
  })

  it('writes a horizon whose bars never came as missing, an hour after it was due', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    fake.gaps.set('SOLUSDT', [HOUR, HOUR + 7200])
    await closeAt(live, HOUR + 300)
    expect(lines(`outcomes-${month}.jsonl`).some((line) => line.pair === 'SOLUSDT')).toBe(false)
    // An hour after the 5-minute horizon was due it is written missing; the others wait their hour.
    await closeAt(live, HOUR + 300 + 3600)
    const missingOf = (): unknown[] => lines(`outcomes-${month}.jsonl`).filter((line) => line.pair === 'SOLUSDT' && typeof line.missing === 'string').map((line) => line.h)
    expect(missingOf()).toEqual(['minutes5'])
    await closeAt(live, HOUR + 7200)
    expect((missingOf() as string[]).sort()).toEqual(['hour1', 'minutes15', 'minutes5'])
    expect(live.getForecastEngineState().missing).toBe(3)
  })

  it('is read back at a restart for the outcomes still owed', async () => {
    const first = await engine()
    await closeAt(first, HOUR)
    await closeAt(first, HOUR + 300)
    vi.resetModules()
    const again = await import('../electron/services/forecastService')
    again.forecastForTest.reset()
    await again.forecastForTest.readOwed(HOUR + 600)
    const owed = again.forecastForTest.owed
    expect(owed.size).toBe(4)
    expect([...owed.values()].every((entry) => !entry.horizons.has('minutes5') && entry.horizons.has('hours24'))).toBe(true)
    expect(again.getForecastEngineState().pending).toBe(16)
    // A day and more later, what was recorded then is no longer owed.
    again.forecastForTest.reset()
    await again.forecastForTest.readOwed(HOUR + 27 * 3600)
    expect(again.forecastForTest.owed.size).toBe(0)
  })
})

describe('between closes', () => {
  it('forecasts a coin again for a story of impact 70 naming it, once a story and once a minute, naming the one it replaced', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    const before = live.forecastOf('SOLUSDT')!
    const now = before.generatedAt + 10_000
    const story = (id: string, impact: number, ticker = 'SOL'): { id: string; seenAt: number; impact: number; assets: { ticker: string; relationship: string }[] } => ({ id, seenAt: now / 1000, impact, assets: [{ ticker, relationship: 'DIRECT' }] })
    await live.forecastNewsSignal({ stories: [story('a', 69)] }, now)
    expect(live.getForecastEngineState().refreshes).toBe(0)
    await live.forecastNewsSignal({ stories: [story('b', 80)] }, now)
    expect(live.getForecastEngineState().refreshes).toBe(1)
    const refreshed = lines(`predictions-${month}.jsonl`).filter((line) => line.why === 'refresh')
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]).toMatchObject({ pair: 'SOLUSDT', reasons: ['news'], previous: before.id })
    expect(live.forecastOf('SOLUSDT')!.id).not.toBe(before.id)
    // The same story again, or another inside the minute: nothing.
    await live.forecastNewsSignal({ stories: [story('b', 80), story('c', 90)] }, now + 30_000)
    expect(live.getForecastEngineState().refreshes).toBe(1)
    await live.forecastNewsSignal({ stories: [story('d', 90)] }, now + 61_000)
    expect(live.getForecastEngineState().refreshes).toBe(2)
    // A story already read, a minute and more later: nothing.
    await live.forecastNewsSignal({ stories: [story('b', 80)] }, now + 130_000)
    expect(live.getForecastEngineState().refreshes).toBe(2)
    // A story seen before the forecast was made is in it already: nothing.
    await live.forecastNewsSignal({ stories: [{ ...story('g', 95), seenAt: before.generatedAt / 1000 - 60 }] }, now + 400_000)
    expect(live.getForecastEngineState().refreshes).toBe(2)
    // An indirect mention, or a coin not forecast: nothing.
    await live.forecastNewsSignal({ stories: [{ ...story('e', 95, 'ETH'), assets: [{ ticker: 'ETH', relationship: 'INDIRECT' }] }, story('f', 95, 'NOPE')] }, now + 200_000)
    expect(live.getForecastEngineState().refreshes).toBe(2)
    // A story seen after the forecast moves it once; told of it again, nothing.
    const late = { ...story('h', 90), seenAt: (now + 500_000) / 1000 }
    await live.forecastNewsSignal({ stories: [late] }, now + 500_000)
    expect(live.getForecastEngineState().refreshes).toBe(3)
    await live.forecastNewsSignal({ stories: [late] }, now + 600_000)
    expect(live.getForecastEngineState().refreshes).toBe(3)
  })

  it('forecasts a coin again for an event the scanner raised, and for a live price out of its range', async () => {
    const live: LiveState = emptyLiveState()
    const mod = await engine({ live })
    await closeAt(mod, HOUR)
    const now = mod.forecastOf('ETHUSDT')!.generatedAt + 1000
    await mod.forecastScannerSignal({ recentEvents: [{ id: 'binance:ETHUSDT:1', symbol: 'ETHUSDT' }] }, now)
    expect(lines(`predictions-${month}.jsonl`).filter((line) => line.why === 'refresh').map((line) => [line.pair, line.reasons])).toEqual([['ETHUSDT', ['event']]])
    // BTC's live price far above its range: forecast again; one inside it: not.
    const btc = mod.forecastOf('BTCUSDT')!
    const lead = btc.horizons[btc.bestHorizon ?? 'hour1']!
    const high = lead.quantilePrices[4] * 1.01
    live.books.BTCUSDT = { symbol: 'BTCUSDT', bid: high, bidQty: 1, ask: high, askQty: 1, updatedAt: now, source: 'stream' }
    live.books.SOLUSDT = { symbol: 'SOLUSDT', bid: mod.forecastOf('SOLUSDT')!.horizons.hour1!.quantilePrices[2], bidQty: 1, ask: mod.forecastOf('SOLUSDT')!.horizons.hour1!.quantilePrices[2], askQty: 1, updatedAt: now, source: 'stream' }
    await mod.forecastLiveSignal(live, now)
    const reasons = lines(`predictions-${month}.jsonl`).filter((line) => line.why === 'refresh').map((line) => [line.pair, line.reasons])
    expect(reasons).toEqual([
      ['ETHUSDT', ['event']],
      ['BTCUSDT', ['band']]
    ])
  })
})

describe('the news', () => {
  it("moves a coin's forecast by a story naming it, records the news-moved levels, and learns them from their outcomes", async () => {
    // The forecasts are stamped with the clock: it is set, so that the story comes after the first.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((HOUR + 10) * 1000)
    const live = await engine()
    await closeAt(live, HOUR)
    const before = live.forecastOf('SOLUSDT')!
    const seen = before.generatedAt / 1000 + 5
    const library = [{ eventType: 'LISTING', enough: true, medianPct: { m1: 0.2, m5: 1.1, m15: 2.2, h1: 3.4, h4: 3 }, excursions: { best1hPct: 5, worst1hPct: -1, best4hPct: 7, worst4hPct: -3 } }]
    live.setForecastReadings({ s1: { ticker: 'SOL', relationship: 'DIRECT', direction: 'up', impact: 90, pricedIn: false, at: seen + 1 } })
    await live.forecastNewsSignal(
      {
        stories: [
          {
            id: 's1',
            title: 'Binance lists a Solana product',
            sourceName: 'Binance',
            eventType: 'LISTING',
            publishedAt: seen - 30,
            seenAt: seen,
            impact: 80,
            assets: [
              { ticker: 'SOL', relationship: 'DIRECT' },
              { ticker: 'ETH', relationship: 'INDIRECT' }
            ]
          }
        ],
        reactions: {},
        impact: library
      },
      seen * 1000 + 2000
    )
    const after = live.forecastOf('SOLUSDT')!
    expect(after.id).not.toBe(before.id)
    expect(after.horizons.minutes5!.news.v3!.storyId).toBe('s1')
    expect(after.horizons.minutes5!.news.v4!.impact).toBe(90)
    expect(after.mainCatalyst).toBe('Binance lists a Solana product')
    const refreshed = lines(`predictions-${month}.jsonl`).find((line) => line.why === 'refresh')!
    const recorded = (refreshed.h as Record<string, { news?: Record<string, { story: string }> }>).minutes5
    expect(recorded.news?.v3?.story).toBe('s1')
    expect(recorded.news?.v4?.story).toBe('s1')
    // Its 5-minute outcome, when due: where the close fell against V3's and V4's levels, and their own
    // adaptive levels moved by it alone.
    vi.setSystemTime((HOUR + 310) * 1000)
    await closeAt(live, HOUR + 300)
    const outcome = lines(`outcomes-${month}.jsonl`).find((line) => line.id === refreshed.id && line.h === 'minutes5')!
    expect(outcome.v3below).toMatch(/^[01]{5}$/)
    expect(outcome.v4below).toMatch(/^[01]{5}$/)
    expect(typeof outcome.newsPUp).toBe('number')
    const others = lines(`outcomes-${month}.jsonl`).filter((line) => line.id !== refreshed.id)
    expect(others.every((line) => line.v3below === undefined)).toBe(true)
    const aci = JSON.parse(readFileSync(join(dir(), 'aci.json'), 'utf-8'))
    expect(Object.keys(aci.levels)).toEqual(expect.arrayContaining(['minutes5/v3/pooled', 'minutes5/v4/pooled']))
    expect(lines('news-outcomes.jsonl')).toEqual([{ h: 'minutes5', due: HOUR + 300, pUp: outcome.newsPUp, up: outcome.up }])
    // At that close the story still moves Solana's forecast, and not ether's, which it only mentions.
    expect(live.forecastOf('SOLUSDT')!.horizons.minutes5!.news.v3).not.toBeNull()
    expect(live.forecastOf('ETHUSDT')!.horizons.minutes5!.news.v3).toBeNull()
  })
})

describe('the record read for a pair', () => {
  it('is its forecasts and outcomes since a moment', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    await closeAt(live, HOUR + 300)
    const history = await live.forecastHistory('SOLUSDT', HOUR - 60)
    expect(history.predictions.map((line) => line.pair)).toEqual(['SOLUSDT'])
    expect(history.outcomes.map((line) => line.h)).toEqual(['minutes5'])
    expect((await live.forecastHistory('SOLUSDT', HOUR + 60)).predictions).toEqual([])
    expect(await live.forecastHistory(42, HOUR)).toEqual({ predictions: [], outcomes: [] })
  })
})

describe('the record on disk', () => {
  it('sweeps month files older than 180 days at start, and keeps the rest', async () => {
    mkdirSync(dir(), { recursive: true })
    writeFileSync(join(dir(), 'predictions-2025-12.jsonl'), '')
    writeFileSync(join(dir(), 'outcomes-2026-09.jsonl'), '')
    writeFileSync(join(dir(), 'notes.txt'), '')
    await engine()
    await vi.waitFor(() => expect(existsSync(join(dir(), 'predictions-2025-12.jsonl'))).toBe(false))
    expect(existsSync(join(dir(), 'outcomes-2026-09.jsonl'))).toBe(true)
    expect(existsSync(join(dir(), 'notes.txt'))).toBe(true)
  })
})

describe('a watched coin whose call turns (§71)', () => {
  /** A pass's forecast of a pair, its call at its best horizon set. */
  const called = (live: Awaited<ReturnType<typeof engine>>, pair: string, direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL') => {
    const made = live.forecastOf(pair)!
    const hour = made.horizons.hour1!
    return { ...made, bestHorizon: 'hour1' as const, horizons: { ...made.horizons, hour1: { ...hour, direction } } }
  }

  it('is told once the new call has held two passes, for the top ten, a pair held and a pair an active executor trades only', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    fake.settings = { heldPositions: [{ symbol: 'XRPUSDT' }], executors: [{ symbol: 'ETHUSDT', status: 'active' }, { symbol: 'SOLUSDT', status: 'stopped' }] }
    const pass = (direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL') =>
      live.forecastForTest.follow(
        SYMBOLS.map((pair) => called(live, pair, direction)),
        ['BTCUSDT']
      )
    // The close's own pass held every call NEUTRAL; two passes make BULLISH the call.
    await pass('BULLISH')
    await pass('BULLISH')
    await pass('BEARISH')
    // One close's turn is not a change, and NEUTRAL to BULLISH was none.
    expect(fake.told).toEqual([])
    await pass('BEARISH')
    expect(fake.told.map((notice) => notice.extra?.thread).sort()).toEqual(['prediction:BTCUSDT', 'prediction:ETHUSDT', 'prediction:XRPUSDT'])
    expect(fake.told.every((notice) => notice.extra?.kind === 'PREDICTION_CHANGED' && notice.extra?.threadSeconds === 3600)).toBe(true)
    expect(fake.told.find((notice) => notice.extra?.thread === 'prediction:BTCUSDT')!.title).toBe('PREDICTION CHANGED: BTC/USDT BULLISH → BEARISH')
    // Held, it is not told again.
    await pass('BEARISH')
    expect(fake.told).toHaveLength(3)
  })

  it('tells the top ten alone when the settings cannot be read', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    fake.settings = null as unknown as Record<string, unknown>
    for (const direction of ['BULLISH', 'BULLISH', 'BEARISH', 'BEARISH'] as const) await live.forecastForTest.follow(SYMBOLS.map((pair) => called(live, pair, direction)), ['SOLUSDT'])
    expect(fake.told.map((notice) => notice.extra?.thread)).toEqual(['prediction:SOLUSDT'])
  })
})

describe('why the range (§36)', () => {
  // A size model that reads the hour's volatility: every row's lies above zero, so it widens by 0.1.
  const RV1H = FEATURE_NAMES.indexOf('rv_1h')
  const split: FlatTree = { feature: [RV1H, -1, -1], threshold: [0, 0, 0], bin: [0, 0, 0], left: [1, -1, -1], right: [2, -1, -1], value: [0, -0.1, 0.1], cover: [2, 1, 1], gain: [1, 0, 0] }
  const sized = (horizon: Horizon): FittedHorizon => {
    const fitted = tinyFitted(horizon)
    return { ...fitted, gbt: { ...fitted.gbt, size: { ...constantGbt(0), trees: [split] } } }
  }

  it('gives the drivers of the boosted size model the calibration weighs, and none where it weighs no boosted model', async () => {
    fake.models = new Map(HORIZONS.map((horizon) => [horizon, sized(horizon)]))
    const live = await engine()
    await closeAt(live, HOUR)
    const drivers = live.forecastOf('SOLUSDT')!.horizons.hour1!.rangeDrivers
    expect(drivers).toHaveLength(1)
    expect(drivers[0]).toMatchObject({ model: 'gbt', feature: 'rv_1h' })
    expect(drivers[0].effect).toBeCloseTo(0.1, 12)
    expect(drivers[0].text).toMatch(/^its last hour's volatility was \d+\.\d\d%, which widened the range$/)
    // A calibration weighing persistence alone: no boosted model's reading to explain.
    fake.calibration = buildRunCalibration(
      new Map(HORIZONS.map((horizon, index) => [horizon, recordOf({ rows: 6000, seed: 50 + index, horizon })])),
      HORIZONS.flatMap((horizon) => promoted(horizon, ['persistence'])),
      'run-folds'
    )
    await closeAt(live, HOUR + 300)
    expect(HORIZONS.map((horizon) => live.forecastOf('SOLUSDT')!.horizons[horizon]?.rangeDrivers)).toEqual(HORIZONS.map(() => []))
  })
})

describe('from the forecast to a trade (V6 Stage 12)', () => {
  it("reads the five-minute ATR at the close, for a trade plan's zone and nearest stop", async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    const atr = live.forecastOf('SOLUSDT')!.market?.atr5mPct
    // The walk's five-minute moves are about 0.2%, its bars a tenth of that wider either way.
    expect(atr).toBeGreaterThan(0.05)
    expect(atr).toBeLessThan(1)
  })

  it("judges each decision's opportunity class by the verdicts handed in, and none before they are", async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    // Every forecast here is NEUTRAL: no side, so no class is read, whatever the verdicts.
    live.setForecastClassVerdicts(() => 'APPROVED')
    await closeAt(live, HOUR + 300)
    expect(live.forecastDecision('SOLUSDT')).toMatchObject({ classKey: null, classVerdict: null })
    // A forecast calling a way: its class -- its coin, the horizon and its setup -- judged by the verdicts.
    const sol = live.forecastOf('SOLUSDT')!
    const bull = { ...sol, horizons: { ...sol.horizons, hour1: { ...sol.horizons.hour1!, direction: 'BULLISH' as const } }, bestHorizon: 'hour1' as const }
    const asked: string[] = []
    live.setForecastClassVerdicts((key) => {
      asked.push(key)
      return 'DISABLED'
    })
    const judged = live.forecastForTest.decide(bull, (HOUR + 300) * 1000)
    expect(asked).toEqual([`${sol.pairClass}/hour1/other`])
    expect(judged).toMatchObject({ classKey: `${sol.pairClass}/hour1/other`, classVerdict: 'DISABLED' })
    expect(judged.reasons.map((reason) => reason.code)).toContain('CLASS_NOT_APPROVED')
    // A story about the coin makes it a news setup.
    const story = { variant: 'v4' as const, storyId: 's', title: 'A listing', source: 'CoinDesk', kind: 'LISTING', impact: 80, ageSec: 60, novelty: 1, pricedIn: false, fromLibrary: true, shiftPct: 0.5, widenPct: 0, widenShare: 0 }
    const withNews = { ...bull, horizons: { ...bull.horizons, hour1: { ...bull.horizons.hour1, news: { v3: null, v4: story } } } }
    expect(live.forecastForTest.decide(withNews, (HOUR + 300) * 1000).classKey).toBe(`${sol.pairClass}/hour1/news`)
    // Before the verdicts are handed in, no class is judged.
    live.setForecastClassVerdicts(null)
    expect(live.forecastForTest.decide(bull, (HOUR + 300) * 1000)).toMatchObject({ classKey: null, classVerdict: null })
  })
})
