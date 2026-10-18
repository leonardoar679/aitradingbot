import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coarseBars, type ForecastBar } from '../shared/forecast/bars'
import { aciUpdate } from '../shared/forecast/calibration'
import { FEATURE_NAMES, HORIZONS, type Horizon } from '../shared/forecast/features'
import type { FlatTree } from '../shared/forecast/ml/tree'
import type { FittedHorizon } from '../shared/forecast/models'
import { MARKET_SHOCK_VERSION } from '../shared/forecast/marketShock'
import { buildRunCalibration, type RunCalibration } from '../shared/forecast/runCalibration'
import { noShockRecord } from '../shared/forecast/shock'
import { emptyLiveState, type LiveState } from '../shared/liveMarket'
import { promoted, recordOf } from './forecastRecords'
import { CALIBRATION, HOUR, MARKET, SYMBOLS, constantGbt, tinyFitted } from './forecastServiceFixture'

// THE FORECAST, LIVE (electron/services/forecastService.ts; the V6 document, §38-43): every pair
// forecast at every close once there are models and a calibration; the quarter-hour's forecasts on
// record, and each horizon's outcome written once when due, never before; the adaptive levels moved
// once a moment; a forecast made again between closes for a story, an event or a price out of its
// range, at most once a minute; and the outcomes still owed read back at a restart. The bars, the
// models and the calibration are faked; the forecasting is the app's own.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

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
  settings: {} as Record<string, unknown>,
  /** What the engine handed the data, to read the pairs it still owes outcomes for. */
  owedReader: null as null | (() => readonly string[]),
  /** A scheduled release's moment (V7.1 Stage 12), or none. */
  releaseAt: null as number | null
}))

// A notice the main process builds in the person's language (V6 Stage 14) is handed as a builder: built
// here in English, as the language of a profile that chose none.
vi.mock('../electron/services/noticeService', async () => {
  const { ENGLISH } = await import('../shared/i18n/translate')
  type Told = { title: string; body: string; extra?: Record<string, unknown> }
  return {
    tell: (notice: Told | ((i18n: typeof ENGLISH) => Told)) => {
      fake.told.push(typeof notice === 'function' ? notice(ENGLISH) : notice)
    }
  }
})

vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => fake.settings }))

// The macro calendar (V7.1 Stage 12) as the test sets it: a release at `fake.releaseAt`, or none.
vi.mock('../shared/calendar/macro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/calendar/macro')>()
  return { ...actual, preEventAt: (tSec: number): boolean => fake.releaseAt !== null && tSec < fake.releaseAt && fake.releaseAt - tSec <= 3600 }
})

vi.mock('../electron/services/forecastDataService', () => ({
  setOwedPairs: (read: () => readonly string[]) => {
    fake.owedReader = read
  },
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

/** The calibration with an adopted rule on Bitcoin's sharp moves at the horizons given (V6.1). */
function withShockRule(horizons: Horizon[], k80 = 1.5, k50 = 1.25): RunCalibration {
  const rule = { ...noShockRecord(), adopted: true, refusal: null, k80, k50, moments: 12, rows: 400, before: { in80: 0.6, in50: 0.35, pinball: 0.5 }, after: { in80: 0.79, in50: 0.49, pinball: 0.47 } }
  return { ...CALIBRATION, horizons: Object.fromEntries(Object.entries(CALIBRATION.horizons).map(([horizon, entry]) => [horizon, horizons.includes(horizon as Horizon) ? { ...entry, shock: rule } : entry])) }
}

/** The market with Bitcoin's bars falling 3% over the fifteen minutes to `close` (V6.1). */
function btcFalling(close: number): Map<string, ForecastBar[]> {
  const scale = new Map([
    [close - 900, 0.99],
    [close - 600, 0.98],
    [close - 300, 0.97]
  ])
  const btc = MARKET.get('BTCUSDT')!.map((bar) => {
    const k = scale.get(bar.time)
    return k === undefined ? bar : { ...bar, open: bar.open * k, high: bar.high * k, low: bar.low * k, close: bar.close * k }
  })
  return new Map([...MARKET, ['BTCUSDT', btc]])
}

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
  fake.releaseAt = null
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

  it('leaves out a pair whose bar at the close is not there, its pass saying it held the pair', async () => {
    fake.gaps.set('XRPUSDT', [HOUR - 300, HOUR])
    const live = await engine()
    await closeAt(live, HOUR)
    expect(live.forecastOf('XRPUSDT')).toBeNull()
    expect(live.getForecastEngineState().predictions).toBe(3)
    // Held, and not forecast: what a run's history gate calls a skipped close (V6 Stage 16).
    expect(lines(`passes-${month}.jsonl`)).toEqual([{ v: 'forecast-record-v1', t: HOUR, held: [...SYMBOLS].sort() }])
    expect(lines(`predictions-${month}.jsonl`).map((line) => line.pair)).not.toContain('XRPUSDT')
  })
})

// V7.1 Stage 11: the market's shock state, read at every close from Bitcoin's row and the cross-section with
// the shock moments of the four hours before, goes on every forecast and every record line; the stream reads
// it again between closes, and a change of it makes every forecast again where a state's rule is in use.
describe("the market's state", () => {
  // The clock near the close, as the refresh tests below keep it: a forecast whose bars are a close behind is
  // never made again.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((HOUR + 10) * 1000)
  })

  /** The calibration widening by the states' rules at the hour: RECOVERY's adopted, the line's chosen away. */
  function withStateRules(): RunCalibration {
    const rule = { ...noShockRecord(), adopted: true, refusal: null, k80: 1.3, k50: 1.1, moments: 20, rows: 400, before: { in80: 0.7, in50: 0.4, pinball: 0.45 }, after: { in80: 0.81, in50: 0.5, pinball: 0.44 } }
    const marketShock = { version: MARKET_SHOCK_VERSION, byState: { RECOVERY: rule, POST_EVENT_SHOCK: rule, TRENDING_SHOCK: rule }, compared: null, chosen: 'states' as const }
    return { ...CALIBRATION, horizons: Object.fromEntries(Object.entries(CALIBRATION.horizons).map(([horizon, entry]) => [horizon, horizon === 'hour1' ? { ...entry, shock: rule, marketShock } : entry])) }
  }

  it('is NORMAL on a calm close and on every forecast and line of it, POST_EVENT_SHOCK on a sharp fall of Bitcoin', async () => {
    const calm = await engine()
    await closeAt(calm, HOUR)
    expect(calm.forecastOf('SOLUSDT')!.marketState).toBe('NORMAL')
    expect(calm.getForecastEngineState().market).toMatchObject({ state: 'NORMAL', readAt: HOUR })
    expect(lines(`predictions-${month}.jsonl`).every((line) => line.state === 'NORMAL')).toBe(true)
    // Bitcoin's bars falling 3% over the fifteen minutes to HOUR and staying there: a lasting drop, not a dip
    // whose rebound would be a shock of its own the other way.
    const lasting = MARKET.get('BTCUSDT')!.map((bar) => {
      const k = bar.time < HOUR - 900 ? 1 : bar.time === HOUR - 900 ? 0.99 : bar.time === HOUR - 600 ? 0.98 : 0.97
      return k === 1 ? bar : { ...bar, open: bar.open * k, high: bar.high * k, low: bar.low * k, close: bar.close * k }
    })
    fake.market = new Map([...MARKET, ['BTCUSDT', lasting]])
    process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-live-'))
    const fallen = await engine()
    await closeAt(fallen, HOUR)
    for (const symbol of SYMBOLS) expect(fallen.forecastOf(symbol)!.marketState).toBe('POST_EVENT_SHOCK')
    const market = fallen.getForecastEngineState().market!
    expect(market.state).toBe('POST_EVENT_SHOCK')
    expect(market.btc15).toBeLessThan(-2.5)
    expect(lines(`predictions-${month}.jsonl`).every((line) => line.state === 'POST_EVENT_SHOCK')).toBe(true)
    // Three hours on, Bitcoin's hour back up by more than a usual move: RECOVERY, from the shock on its bars.
    const recovered = fake.market.get('BTCUSDT')!.map((bar) => {
      if (bar.time < HOUR + 2 * 3600 || bar.time >= HOUR + 3 * 3600) return bar
      // The hour before HOUR + 3h rising a quarter of a percent a bar: twelve bars, 3%, past one usual hourly
      // move however the walk went, its last fifteen minutes under the sharp-move line.
      const k = 1 + 0.0025 * ((bar.time - (HOUR + 2 * 3600)) / 300 + 1)
      return { ...bar, open: bar.open * k, high: bar.high * k, low: bar.low * k, close: bar.close * k }
    })
    fake.market = new Map([...fake.market, ['BTCUSDT', recovered.map((bar) => (bar.time >= HOUR + 3 * 3600 ? { ...bar, open: bar.open * 1.03, high: bar.high * 1.03, low: bar.low * 1.03, close: bar.close * 1.03 } : bar))]])
    // The hour's rise is no shock of its own: its fifteen minutes stay under the line.
    await closeAt(fallen, HOUR + 3 * 3600)
    expect(Math.abs(fallen.getForecastEngineState().market!.btc15)).toBeLessThan(2.5)
    expect(fallen.getForecastEngineState().market!.btc1h).toBeGreaterThan(1)
    expect(fallen.forecastOf('SOLUSDT')!.marketState).toBe('RECOVERY')
    // Five hours on, the window past: NORMAL again.
    await closeAt(fallen, HOUR + 5 * 3600)
    expect(fallen.forecastOf('SOLUSDT')!.marketState).toBe('NORMAL')
  })

  // V7.1 Stage 12: the hour before a scheduled release is PRE_EVENT, on the forecast and its record line; a
  // shock outranks it; past the release it is over.
  it('is PRE_EVENT within the hour before a scheduled release, and a shock outranks it', async () => {
    fake.releaseAt = HOUR + 1800
    const live = await engine()
    await closeAt(live, HOUR)
    expect(live.forecastOf('SOLUSDT')!.marketState).toBe('PRE_EVENT')
    expect(live.getForecastEngineState().market!.state).toBe('PRE_EVENT')
    expect(lines(`predictions-${month}.jsonl`).every((line) => line.state === 'PRE_EVENT')).toBe(true)
    // The release passed: the next close is NORMAL.
    await closeAt(live, HOUR + 1800)
    expect(live.forecastOf('SOLUSDT')!.marketState).toBe('NORMAL')
    // The stream's reading between closes reads the calendar too: a release ahead again, PRE_EVENT.
    fake.releaseAt = HOUR + 1800 + 2400
    const stream = emptyLiveState()
    process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-live-'))
    const mod = await engine({ live: stream })
    await closeAt(mod, HOUR + 1800)
    expect(mod.forecastOf('SOLUSDT')!.marketState).toBe('PRE_EVENT')
    // Bitcoin falling sharply into the release's hour: a shock, whatever the calendar says.
    fake.market = btcFalling(HOUR)
    fake.releaseAt = HOUR + 1800
    process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-live-'))
    const shocked = await engine()
    await closeAt(shocked, HOUR)
    expect(shocked.forecastOf('SOLUSDT')!.marketState).toBe('POST_EVENT_SHOCK')
  })

  it("widens by the state's rule where the horizon chose the states', and records which state", async () => {
    fake.calibration = withStateRules()
    fake.market = btcFalling(HOUR)
    const live = await engine()
    await closeAt(live, HOUR)
    const hour1 = live.forecastOf('SOLUSDT')!.horizons.hour1!
    expect(hour1.shock).toMatchObject({ k80: 1.3, k50: 1.1, state: 'POST_EVENT_SHOCK' })
    expect(live.forecastOf('SOLUSDT')!.horizons.minutes15!.shock).toBeNull()
    const recorded = lines(`predictions-${month}.jsonl`).find((line) => line.pair === 'SOLUSDT')!
    expect(recorded.state).toBe('POST_EVENT_SHOCK')
    expect((recorded.h as Record<string, { shock?: number[] }>).hour1.shock).toHaveLength(3)
  })

  it("forecasts every pair again when the market's state changes on Bitcoin's live minutes, where a state's rule is in use", async () => {
    const minutes = (nowMs: number, lastClose: number, hourAgoClose = 60_000): LiveState['btcMinutes'] => {
      const last = Math.floor(nowMs / 60_000) * 60
      return Array.from({ length: 80 }, (_, k) => ({ time: last - (79 - k) * 60, open: 60_000, high: 60_000, low: 60_000, close: k === 79 ? lastClose : k < 19 ? hourAgoClose : 60_000, volume: 1, closed: k < 79 }))
    }
    const marketRefreshes = (): number => lines(`predictions-${month}.jsonl`).filter((line) => line.why === 'refresh' && (line.reasons as string[]).includes('market')).length
    // Without a state's rule in use (the line's chosen): a trending hour read live changes nothing.
    const live = emptyLiveState()
    const plain = await engine({ live })
    await closeAt(plain, HOUR)
    const at = plain.forecastOf('SOLUSDT')!.generatedAt + 1000
    live.btcMinutes = minutes(at, 61_000, 58_500)
    await plain.forecastLiveSignal(live, at)
    expect(marketRefreshes()).toBe(0)
    // With the states' rules in use: Bitcoin's hour up 2.5 usual moves on the stream, its minutes the same
    // way -- TRENDING_SHOCK from NORMAL -- makes every forecast again, with the state on each; the same
    // reading again, no change, nothing; back to calm, a change again.
    fake.calibration = withStateRules()
    process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-live-'))
    const stream = emptyLiveState()
    const mod = await engine({ live: stream })
    await closeAt(mod, HOUR)
    const now = mod.forecastOf('SOLUSDT')!.generatedAt + 1000
    expect(mod.forecastOf('SOLUSDT')!.marketState).toBe('NORMAL')
    stream.btcMinutes = minutes(now, 61_000, 58_500)
    await mod.forecastLiveSignal(stream, now)
    expect(marketRefreshes()).toBe(SYMBOLS.length)
    expect(mod.forecastOf('SOLUSDT')!.marketState).toBe('TRENDING_SHOCK')
    expect(mod.forecastOf('SOLUSDT')!.horizons.hour1!.shock).toMatchObject({ k80: 1.3, state: 'TRENDING_SHOCK' })
    expect(mod.getForecastEngineState().market!.state).toBe('TRENDING_SHOCK')
    await mod.forecastLiveSignal(stream, now + 61_000)
    expect(marketRefreshes()).toBe(SYMBOLS.length)
    stream.btcMinutes = minutes(now + 122_000, 60_000, 60_000)
    await mod.forecastLiveSignal(stream, now + 122_000)
    expect(marketRefreshes()).toBe(2 * SYMBOLS.length)
    expect(mod.forecastOf('SOLUSDT')!.marketState).toBe('NORMAL')
    // The states' rules chosen but none of them adopted: nothing is in use, and a change makes nothing again.
    const chosen = withStateRules()
    const hour1 = chosen.horizons.hour1!
    fake.calibration = { ...chosen, horizons: { ...chosen.horizons, hour1: { ...hour1, marketShock: { ...hour1.marketShock!, byState: Object.fromEntries(Object.entries(hour1.marketShock!.byState).map(([state, rule]) => [state, { ...rule, adopted: false, refusal: 'coverage' }])) } } } }
    process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-live-'))
    const idle = emptyLiveState()
    const none = await engine({ live: idle })
    await closeAt(none, HOUR)
    const later = none.forecastOf('SOLUSDT')!.generatedAt + 1000
    idle.btcMinutes = minutes(later, 61_000, 58_500)
    await none.forecastLiveSignal(idle, later)
    expect(marketRefreshes()).toBe(0)
    expect(none.forecastOf('SOLUSDT')!.marketState).toBe('NORMAL')
  })

  it("forecasts a pair again on a spread shock, and once when the live price crosses the median against its call", async () => {
    const live: LiveState = emptyLiveState()
    const mod = await engine({ live })
    const book = (symbol: string, mid: number, spreadPct: number, nowMs: number): LiveState['books'][string] => ({ symbol, bid: mid * (1 - spreadPct / 200), bidQty: 1, ask: mid * (1 + spreadPct / 200), askQty: 1, updatedAt: nowMs, source: 'stream' })
    const refreshes = (): unknown[] => lines(`predictions-${month}.jsonl`).filter((line) => line.why === 'refresh' && line.pair === 'SOLUSDT').map((line) => line.reasons)
    // Six closes with the book at a tenth of a percent: the pair's usual spread. After five, a spread at
    // three times that is no shock yet: the usual is not known from fewer than six closes.
    for (let k = 0; k < 6; k++) {
      const close = HOUR - (5 - k) * 300
      if (k === 5) {
        const early = mod.forecastOf('SOLUSDT')!
        const at = early.generatedAt + 1000
        live.books.SOLUSDT = book('SOLUSDT', early.horizons[early.bestHorizon ?? 'hour1']!.quantilePrices[2] * 0.999, 0.31, at)
        await mod.forecastLiveSignal(live, at)
        expect(refreshes()).toEqual([])
      }
      live.books.SOLUSDT = book('SOLUSDT', MARKET.get('SOLUSDT')!.find((bar) => bar.time === close - 300)!.close, 0.1, Date.now())
      await closeAt(mod, close)
    }
    const sol = mod.forecastOf('SOLUSDT')!
    const median = sol.horizons[sol.bestHorizon ?? 'hour1']!.quantilePrices[2]
    // The spread at three times the usual: made again; at under, not.
    let now = sol.generatedAt + 1000
    live.books.SOLUSDT = book('SOLUSDT', median * 0.999, 0.29, now)
    await mod.forecastLiveSignal(live, now)
    expect(refreshes()).toEqual([])
    now += 61_000
    live.books.SOLUSDT = book('SOLUSDT', median * 0.999, 0.31, now)
    await mod.forecastLiveSignal(live, now)
    expect(refreshes()).toEqual([['spread']])
    // The live price past the median: a crossing against a BULLISH call, told once; the next minute, still
    // across, nothing; back under and past again, told again. The call is set on the forecast the engine holds.
    const held = mod.forecastOf('SOLUSDT')!
    const lead = held.bestHorizon ?? 'hour1'
    mod.forecastForTest.setCall('SOLUSDT', lead, 'BULLISH')
    now += 61_000
    live.books.SOLUSDT = book('SOLUSDT', median * 1.001, 0.1, now)
    await mod.forecastLiveSignal(live, now)
    expect(refreshes()).toEqual([['spread'], ['direction']])
    now += 61_000
    mod.forecastForTest.setCall('SOLUSDT', lead, 'BULLISH')
    live.books.SOLUSDT = book('SOLUSDT', median * 1.002, 0.1, now)
    await mod.forecastLiveSignal(live, now)
    expect(refreshes()).toEqual([['spread'], ['direction']])
    now += 61_000
    live.books.SOLUSDT = book('SOLUSDT', median * 0.999, 0.1, now)
    await mod.forecastLiveSignal(live, now)
    now += 61_000
    mod.forecastForTest.setCall('SOLUSDT', lead, 'BULLISH')
    live.books.SOLUSDT = book('SOLUSDT', median * 1.001, 0.1, now)
    await mod.forecastLiveSignal(live, now)
    expect(refreshes()).toEqual([['spread'], ['direction'], ['direction']])
  })
})

// V7.1 Stage 13: the live drift gate. The last day's outcomes at a horizon, read back at a start and added as
// they are written, close the horizon to trading where under three in five held their 80% range.
describe('the live drift gate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((HOUR + 10) * 1000)
  })

  const outcome = (index: number, h: string, in80: boolean): Record<string, unknown> => ({ v: 'forecast-record-v1', id: `p${index}`, pair: 'SOLUSDT', h, t: HOUR - 7200 - index * 60, due: HOUR - 3600 - index * 60, move: 1, best: 1.2, worst: -0.2, below: '00011', v1below: '00011', in80, in50: false, up: true, dir: 'NEUTRAL', pUp: 0.5, cell: 'large', cls: 'large', errors: [] })

  it('closes a horizon whose last day of outcomes missed, on every decision at it, and leaves the others open', async () => {
    mkdirSync(dir(), { recursive: true })
    // Sixty outcomes of the last day at every horizon but the quarter-hour, half of them missing their range:
    // 50%, under the line; forty of the 15-minute horizon all held; and thirty more of the 5-minute horizon
    // that all missed would be too few on their own.
    const drifted: Horizon[] = ['minutes5', 'hour1', 'hours4']
    const written = [
      ...drifted.flatMap((horizon, at) => Array.from({ length: 60 }, (_, k) => outcome(at * 100 + k, horizon, k % 2 === 0))),
      ...Array.from({ length: 40 }, (_, k) => outcome(500 + k, 'minutes15', true)),
      // The day's only outcomes older than a day: not read, and the day's horizon not in the state at all.
      { ...outcome(600, 'hours24', false), due: HOUR - 86_400 - 7200 },
      { ...outcome(601, 'hour1', false), due: HOUR - 86_400 - 7200 }
    ]
    writeFileSync(join(dir(), `outcomes-${month}.jsonl`), written.map((line) => JSON.stringify(line)).join('\n') + '\n')
    const live = await engine()
    await vi.waitFor(() => expect(live.getForecastEngineState().drift?.hour1?.outcomes).toBe(60))
    expect(live.getForecastEngineState().drift).toEqual({
      minutes5: { outcomes: 60, coverage80: 0.5, drifted: true },
      minutes15: { outcomes: 40, coverage80: 1, drifted: false },
      hour1: { outcomes: 60, coverage80: 0.5, drifted: true },
      hours4: { outcomes: 60, coverage80: 0.5, drifted: true }
    })
    await closeAt(live, HOUR)
    // Every decision at a drifted horizon is NO TRADE for the drift, said so; one at the quarter-hour or the
    // day is not.
    for (const symbol of SYMBOLS) {
      const decision = live.forecastDecision(symbol)!
      const codes = decision.reasons.map((reason) => reason.code)
      if (decision.horizon === 'minutes15' || decision.horizon === 'hours24') expect(codes).not.toContain('ENGINE_DRIFT')
      else {
        expect(decision.decision).toBe('NO_TRADE')
        expect(codes).toContain('ENGINE_DRIFT')
        expect(decision.reasons.find((reason) => reason.code === 'ENGINE_DRIFT')!.values).toEqual({ outcomes: 60, coverage80: 0.5 })
      }
    }
    expect(SYMBOLS.some((symbol) => drifted.includes(live.forecastDecision(symbol)!.horizon))).toBe(true)
    // On the record line with the decision.
    const recorded = lines(`predictions-${month}.jsonl`) as { trade?: { h: Horizon; why: string[] } }[]
    expect(recorded.length).toBe(SYMBOLS.length)
    expect(recorded.every((line) => line.trade?.why.includes('ENGINE_DRIFT') === drifted.includes(line.trade!.h))).toBe(true)
    // The gate does not touch the forecasts: every pair forecast at every horizon.
    expect(live.getForecastEngineState().predictions).toBe(SYMBOLS.length)
  })

  it('opens again as the day turns over, and reads the outcomes it writes itself', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    expect(live.getForecastEngineState().drift).toEqual({})
    // The 5-minute outcomes written at the next close join the window.
    await closeAt(live, HOUR + 300)
    const drift = live.getForecastEngineState().drift!
    expect(drift.minutes5?.outcomes).toBe(SYMBOLS.length)
    expect(drift.minutes5?.drifted).toBe(false)
    expect(live.forecastDecision('SOLUSDT')!.reasons.map((reason) => reason.code)).not.toContain('ENGINE_DRIFT')
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
    // And at each of them the pairs its pass held bars for (V6 Stage 16); none between.
    expect(lines(`passes-${month}.jsonl`)).toEqual([HOUR, HOUR + 900].map((t) => ({ v: 'forecast-record-v1', t, held: [...SYMBOLS].sort() })))
    // A close passed again does not record it twice.
    await closeAt(live, HOUR + 900)
    expect(lines(`predictions-${month}.jsonl`)).toHaveLength(8)
    expect(lines(`passes-${month}.jsonl`)).toHaveLength(2)
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

  // V6.1: Bitcoin's own last fifteen minutes at the close widen the horizons whose rule is in use; the record
  // keeps V2's own levels, and the adaptive V2 levels learn from where the close fell against those.
  it("widens every pair's ranges past Bitcoin's line where a horizon's rule is in use, and teaches V2's levels from V2's own", async () => {
    fake.calibration = withShockRule(['hour1', 'minutes5'], 3, 3)
    const calm = await engine()
    await closeAt(calm, HOUR)
    expect(calm.forecastOf('SOLUSDT')!.horizons.hour1!.shock).toBeNull()
    fake.market = btcFalling(HOUR)
    process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-live-'))
    const live = await engine()
    await closeAt(live, HOUR)
    for (const symbol of SYMBOLS) {
      const hour1 = live.forecastOf(symbol)!.horizons.hour1!
      expect(hour1.shock).toMatchObject({ k80: 3, k50: 3 })
      expect(hour1.shock!.btc15).toBeLessThan(-2.5)
      expect(live.forecastOf(symbol)!.horizons.minutes15!.shock).toBeNull()
    }
    const recorded = lines(`predictions-${month}.jsonl`).find((line) => line.pair === 'SOLUSDT')!.h as Record<string, { v2?: number[]; shock?: number[] }>
    expect(recorded.hour1.v2).toHaveLength(5)
    expect(recorded.hour1.shock).toHaveLength(3)
    expect(recorded.minutes15.v2).toBeUndefined()
    await closeAt(live, HOUR + 300)
    const outcomes = lines(`outcomes-${month}.jsonl`).filter((line) => line.h === 'minutes5')
    expect(outcomes).toHaveLength(4)
    const shareOf = (key: 'below' | 'v2below'): number[] => [0, 1, 2, 3, 4].map((level) => outcomes.filter((line) => (line[key] as string)[level] === '1').length / outcomes.length)
    // The widening moved where the closes fell against the shown levels: V2's learn from V2's own.
    expect(shareOf('v2below')).not.toEqual(shareOf('below'))
    const aci = JSON.parse(readFileSync(join(dir(), 'aci.json'), 'utf-8'))
    expect(aci.levels['minutes5/v2/pooled']).toEqual(aciUpdate([0.1, 0.25, 0.5, 0.75, 0.9], shareOf('v2below')))
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
    // Fifty-five minutes after the 5-minute horizon was due: still waited for.
    const missingOf = (): unknown[] => lines(`outcomes-${month}.jsonl`).filter((line) => line.pair === 'SOLUSDT' && typeof line.missing === 'string').map((line) => line.h)
    await closeAt(live, HOUR + 300 + 3300)
    expect(missingOf()).toEqual([])
    // An hour after the 5-minute horizon was due it is written missing; the others wait their hour.
    await closeAt(live, HOUR + 300 + 3600)
    expect(missingOf()).toEqual(['minutes5'])
    await closeAt(live, HOUR + 7200)
    expect((missingOf() as string[]).sort()).toEqual(['hour1', 'minutes15', 'minutes5'])
    expect(live.getForecastEngineState().missing).toBe(3)
  })

  it('is read back at a restart for the outcomes still owed', async () => {
    const first = await engine()
    await closeAt(first, HOUR)
    // The pairs still owed outcomes are handed to the data, which keeps their bars coming until judged.
    expect(first.owedForecastPairs().sort()).toEqual([...SYMBOLS].sort())
    expect([...(fake.owedReader?.() ?? [])].sort()).toEqual([...SYMBOLS].sort())
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
  // The clock just after the close the bars are held to, as the engine runs: a forecast is made again
  // only from bars at most a close old (V6 Stage 16).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((HOUR + 10) * 1000)
  })

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

  it('makes no forecast again from bars more than a close old, as when the data stopped coming', async () => {
    const live = await engine()
    await closeAt(live, HOUR)
    const before = live.forecastOf('SOLUSDT')!
    expect(before.barTime).toBe(HOUR)
    const story = (id: string, atSec: number): { id: string; seenAt: number; impact: number; assets: { ticker: string; relationship: string }[] } => ({ id, seenAt: atSec, impact: 90, assets: [{ ticker: 'SOL', relationship: 'DIRECT' }] })
    // Two closes on, no pass since: the bars are stale, and nothing is made again.
    await live.forecastNewsSignal({ stories: [story('late', HOUR + 660)] }, (HOUR + 660) * 1000)
    expect(live.getForecastEngineState().refreshes).toBe(0)
    expect(live.forecastOf('SOLUSDT')!.id).toBe(before.id)
    // One close on, its pass not yet run: made again.
    await live.forecastNewsSignal({ stories: [story('soon', HOUR + 320)] }, (HOUR + 320) * 1000)
    expect(live.getForecastEngineState().refreshes).toBe(1)
  })

  it('makes no forecast again while a pass runs: the pure pass is told so (V7.2 Stage 5)', async () => {
    const { consider } = await import('../shared/forecast/pass')
    const live = await engine()
    await closeAt(live, HOUR)
    const now = live.forecastOf('ETHUSDT')!.generatedAt + 1000
    const { engine: state, sources } = live.forecastForTest
    expect(consider(state, sources, 'ETHUSDT', { newEvent: true }, now, true)).toEqual({ reasons: [], line: null })
    const made = consider(state, sources, 'ETHUSDT', { newEvent: true }, now, false)
    expect(made.reasons).toEqual(['event'])
    expect(made.line).toMatchObject({ pair: 'ETHUSDT', why: 'refresh', reasons: ['event'] })
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

  // V6.1: Bitcoin's minutes crossing the sharp-move line make every pair's forecast again, where a rule is
  // in use to widen them, once; without one, nothing.
  it("forecasts every pair again when Bitcoin's live minutes cross its sharp-move line, where a rule is in use", async () => {
    const sharp = (nowMs: number): LiveState['btcMinutes'] => {
      const last = Math.floor(nowMs / 60_000) * 60
      return Array.from({ length: 20 }, (_, k) => ({ time: last - (19 - k) * 60, open: 60_000, high: 60_000, low: 60_000, close: k === 19 ? 58_200 : 60_000, volume: 1, closed: k < 19 }))
    }
    const marketRefreshes = (): unknown[][] => lines(`predictions-${month}.jsonl`).filter((line) => line.why === 'refresh' && (line.reasons as string[]).includes('market')).map((line) => [line.pair])
    const without = emptyLiveState()
    const plain = await engine({ live: without })
    await closeAt(plain, HOUR)
    const at = plain.forecastOf('SOLUSDT')!.generatedAt + 1000
    without.btcMinutes = sharp(at)
    await plain.forecastLiveSignal(without, at)
    expect(marketRefreshes()).toEqual([])

    fake.calibration = withShockRule(['hour1'])
    process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-live-'))
    const live = emptyLiveState()
    const mod = await engine({ live })
    await closeAt(mod, HOUR)
    const now = mod.forecastOf('SOLUSDT')!.generatedAt + 1000
    expect(mod.forecastOf('SOLUSDT')!.horizons.hour1!.shock).toBeNull()
    live.btcMinutes = sharp(now)
    await mod.forecastLiveSignal(live, now)
    expect(marketRefreshes().sort()).toEqual([...SYMBOLS].sort().map((pair) => [pair]))
    expect(mod.forecastOf('SOLUSDT')!.horizons.hour1!.shock).toMatchObject({ k80: 1.5, k50: 1.25 })
    expect(mod.forecastOf('SOLUSDT')!.horizons.hour1!.shock!.btc15).toBeLessThan(-2.5)
    // A coin made again for another reason a minute on, the stream silent since: its reading is old, and the
    // close's, calm, is read.
    await mod.forecastScannerSignal({ recentEvents: [{ id: 'binance:SOLUSDT:9', symbol: 'SOLUSDT' }] }, now + 61_000)
    expect(lines(`predictions-${month}.jsonl`).filter((line) => line.why === 'refresh' && line.pair === 'SOLUSDT').map((line) => line.reasons)).toEqual([['market'], ['event']])
    expect(mod.forecastOf('SOLUSDT')!.horizons.hour1!.shock).toBeNull()
    // Still past the line a minute on, however long since the last reading: no crossing, nothing made again.
    await mod.forecastLiveSignal(live, now + 61_000)
    expect(marketRefreshes()).toHaveLength(SYMBOLS.length)
    // Back under it, and past it again: a crossing.
    live.btcMinutes = live.btcMinutes.map((minute) => ({ ...minute, close: 60_000 }))
    await mod.forecastLiveSignal(live, now + 62_000)
    live.btcMinutes = sharp(now + 123_000)
    await mod.forecastLiveSignal(live, now + 123_000)
    expect(marketRefreshes()).toHaveLength(2 * SYMBOLS.length)
    // The next close, the stream silent since: its reading is old, and Bitcoin's own bars, calm, say.
    vi.setSystemTime((HOUR + 310) * 1000)
    await closeAt(mod, HOUR + 300)
    expect(mod.forecastOf('SOLUSDT')!.barTime).toBe(HOUR + 300)
    expect(mod.forecastOf('SOLUSDT')!.horizons.hour1!.shock).toBeNull()
    // A close reads Bitcoin from its own bars, whatever the stream said a moment before; the stream past
    // the line after it is a crossing.
    vi.setSystemTime((HOUR + 605) * 1000)
    live.btcMinutes = sharp((HOUR + 605) * 1000)
    await mod.forecastLiveSignal(live, (HOUR + 605) * 1000)
    expect(marketRefreshes()).toHaveLength(3 * SYMBOLS.length)
    vi.setSystemTime((HOUR + 606) * 1000)
    await closeAt(mod, HOUR + 600)
    expect(mod.forecastOf('SOLUSDT')!.horizons.hour1!.shock).toBeNull()
    await mod.forecastLiveSignal(live, (HOUR + 607) * 1000)
    expect(marketRefreshes()).toHaveLength(4 * SYMBOLS.length)
    expect(mod.forecastOf('SOLUSDT')!.horizons.hour1!.shock).not.toBeNull()
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
    writeFileSync(join(dir(), 'passes-2025-12.jsonl'), '')
    writeFileSync(join(dir(), 'outcomes-2026-09.jsonl'), '')
    writeFileSync(join(dir(), 'notes.txt'), '')
    await engine()
    await vi.waitFor(() => expect(existsSync(join(dir(), 'predictions-2025-12.jsonl'))).toBe(false))
    await vi.waitFor(() => expect(existsSync(join(dir(), 'passes-2025-12.jsonl'))).toBe(false))
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
