import { describe, expect, it } from 'vitest'
import { DEFAULT_LAB_SETTINGS, LAB_RISK, LAB_STRATEGIES, classOnly, healLabSettings, labDailyNet, labDayOf, labPaperExecutors, labStatsOf, labStopReached, labStrategiesOf, sensitivityCounts, type LabTradeMark } from '../shared/forecast/labTrader'
import type { ForecastRange, PricePrediction } from '../shared/forecast/prediction'
import type { ForecastRanking, RankedForecast } from '../shared/forecast/ranking'
import { forecastRunSectionOf } from '../shared/forecast/runSection'
import type { TradeDecision } from '../shared/forecast/tradeDecision'
import { healForecastSettings } from '../shared/forecast/training'
import type { Candle, ExecutorConfig, PaperAccount, PositionExecutorParams } from '../shared/ipc'
import type { LiveBook } from '../shared/liveMarket'
import { DEFAULT_PAPER_PAUSE } from '../shared/paperPause'
import { DEFAULT_PAPER_RISK, ownOpenPaperTrades } from '../shared/paperRisk'
import { fundLab, labPaperExecutor, openLabTrades, settleLabTrades, type LabTraderDeps } from '../src/forecast/labTrader'

// THE PAPER LABORATORY (shared/forecast/labTrader.ts, src/forecast/labTrader.ts; V7.1 Stage 4): four
// candidate strategies on a $10,000 paper account, each a paper trader off until switched on -- which
// forecasts each takes up, what it stakes, how many it keeps open, the daily stop, what each made -- and
// FUND, a click that fills the account. Every trade here is paper, and nothing reaches an order.

const T = Date.parse('2026-10-16T12:00:00Z') / 1000

function range(patch: Partial<ForecastRange> = {}): ForecastRange {
  const quantilesPct = [-1, 0.5, 1.5, 2.5, 4]
  return {
    lowPct: 0.5,
    highPct: 2.5,
    lowerPrice: 100.5,
    upperPrice: 102.5,
    medianPct: 1.5,
    confidenceLevel: 50,
    quantilesPct,
    quantilePrices: quantilesPct.map((pct) => 100 * (1 + pct / 100)),
    bearPct: -1,
    bullPct: 4,
    pUp: 0.7,
    pUpMapped: 0.7,
    pUpSource: 'distribution',
    direction: 'BULLISH',
    strong: false,
    uncertain: false,
    confidence: 70,
    reliability: 'HIGH',
    reliabilityReasons: [],
    quality: { score: 80, parts: { direction: 100, range: 80, calibration: 90, news: null, confirmation: 70, agreement: 100, freshness: 100 } },
    width80Pct: 5,
    usualWidth80Pct: 4,
    skill: 0.02,
    directionSkill: 0.03,
    ownClass: true,
    expiresAt: (T + 3600) * 1000,
    contributions: [],
    calibrationShiftLogPct: 0,
    newsShiftLogPct: 0,
    news: { v3: null, v4: null },
    spreadStretch: 1,
    variants: {},
    rangeDrivers: [],
    ...patch
  }
}

function prediction(pair = 'SOLUSDT', hour: Partial<ForecastRange> = {}): PricePrediction {
  return {
    pair,
    generatedAt: T * 1000,
    direction: hour.direction ?? 'BULLISH',
    horizons: { hour1: range(hour) },
    currentPrice: 100,
    confidence: 70,
    reliability: 'HIGH',
    invalidationConditions: [],
    modelVersion: 'm',
    id: `${pair}:${T}`,
    strong: false,
    uncertain: false,
    bestHorizon: 'hour1',
    pairClass: 'large',
    regime: 'sideways',
    barTime: T,
    market: { z1h: 0.5, breadth1h: 0.6, volRatio1h: 1.2, atr5mPct: 0.2 },
    versions: { prediction: 'p', models: 'm', features: 'f', ensemble: 'e', calibration: 'c', runCalibration: 'r', news: 'n', quality: 'q', run: 'run', foldsRun: 'folds' }
  }
}

function decision(pair = 'SOLUSDT', patch: Partial<TradeDecision> = {}): TradeDecision {
  return {
    version: 'decision-v2',
    pair,
    horizon: 'hour1',
    side: 'BUY',
    decision: 'TRADE',
    reasons: [],
    edge: { side: 'BUY', costPct: 0.24, expectedPct: 1.5, edgePct: 1.26, pProfit: 0.8 },
    quality: 80,
    classKey: 'large/hour1/other',
    classVerdict: 'PROBATION',
    at: T * 1000,
    ...patch
  }
}

/** A decision held back by its opportunity class alone: the candidates' case. */
const classHeld = (pair = 'SOLUSDT', patch: Partial<TradeDecision> = {}): TradeDecision =>
  decision(pair, { decision: 'NO_TRADE', reasons: [{ code: 'CLASS_NOT_APPROVED', text: 'Its kind of opportunity has not been traded enough.' }], classVerdict: 'NOT_ENOUGH', ...patch })

const story = { variant: 'v4' as const, storyId: 's1', title: 'A listing', source: 'CoinDesk', kind: 'LISTING', impact: 80, ageSec: 600, novelty: 1, pricedIn: false, fromLibrary: true, shiftPct: 1, widenPct: 0, widenShare: 0 }

describe('the rules', () => {
  it('read the settings as stored, every strategy off unless a stored true, and a stop only whole', () => {
    expect(healLabSettings(undefined)).toEqual(DEFAULT_LAB_SETTINGS)
    expect(DEFAULT_LAB_SETTINGS.strategies).toEqual({ strict: false, direction: false, news: false, hybrid: false })
    expect(healLabSettings({ strategies: { strict: true, news: 'yes' }, stopped: { day: '2026-10-16', at: T, lossQuote: 150, equityQuote: 10_000 } })).toEqual({ strategies: { strict: true, direction: false, news: false, hybrid: false }, stopped: { day: '2026-10-16', at: T, lossQuote: 150, equityQuote: 10_000 } })
    expect(healLabSettings({ stopped: { day: '2026-10-16' } }).stopped).toBeNull()
    // The forecast's settings carry it, so every writer that spreads the healed whole keeps it.
    expect(healForecastSettings({ lab: { strategies: { hybrid: true } } }).lab.strategies.hybrid).toBe(true)
    expect(LAB_RISK).toEqual({ fundQuote: 10_000, riskPct: 0.25, maxPositionPct: 10, maxOpen: 3, dailyStopPct: 1.5, sensitivity: [0.55, 0.52] })
  })

  it("take a forecast up by its decision: STRICT on a TRADE in a tradable class, the others only where the class alone held it back", () => {
    expect(labStrategiesOf(decision(), prediction(), null)).toEqual(['strict'])
    // A TRADE whose class reads as not tradable (a stale decision's) is no STRICT candidate.
    expect(labStrategiesOf(decision('SOLUSDT', { classVerdict: 'DISABLED' }), prediction(), null)).toEqual([])
    expect(labStrategiesOf(decision('SOLUSDT', { classVerdict: null }), prediction(), null)).toEqual([])
    // A TRADE whose P(up) came from a direction model qualifies for DIRECTION too; it is opened under STRICT.
    expect(labStrategiesOf(decision(), prediction('SOLUSDT', { pUpSource: 'dir-gbt' }), 'long')).toEqual(['strict', 'direction', 'hybrid'])
    expect(classOnly(classHeld())).toBe(true)
    expect(labStrategiesOf(classHeld(), prediction(), null)).toEqual([])
    expect(labStrategiesOf(classHeld(), prediction('SOLUSDT', { pUpSource: 'dir-logistic' }), null)).toEqual(['direction'])
    expect(labStrategiesOf(classHeld(), prediction('SOLUSDT', { pUpSource: 'distribution' }), null)).toEqual([])
    expect(labStrategiesOf(classHeld(), prediction('SOLUSDT', { news: { v3: null, v4: story } }), null)).toEqual(['news'])
    // A story that moved it the other way, or one with no library behind it, is no NEWS EVENT.
    expect(labStrategiesOf(classHeld(), prediction('SOLUSDT', { news: { v3: null, v4: { ...story, shiftPct: -1 } } }), null)).toEqual([])
    expect(labStrategiesOf(classHeld(), prediction('SOLUSDT', { news: { v3: null, v4: { ...story, fromLibrary: false } } }), null)).toEqual([])
    expect(labStrategiesOf(classHeld(), prediction(), 'long')).toEqual(['hybrid'])
    expect(labStrategiesOf(classHeld(), prediction(), 'short')).toEqual([])
    expect(labStrategiesOf(classHeld('SOLUSDT', { side: 'SELL' }), prediction('SOLUSDT', { direction: 'BEARISH' }), 'short')).toEqual(['hybrid'])
    // Held back by anything else -- its quality, the spread -- it is no candidate at all.
    expect(labStrategiesOf(classHeld('SOLUSDT', { reasons: [{ code: 'CLASS_NOT_APPROVED', text: '' }, { code: 'QUALITY_LOW', text: '' }] }), prediction('SOLUSDT', { pUpSource: 'dir-gbt' }), 'long')).toEqual([])
    expect(labStrategiesOf(decision('SOLUSDT', { side: null, decision: 'NO_TRADE', reasons: [{ code: 'NO_CALL', text: '' }] }), prediction(), 'long')).toEqual([])
  })

  it('count the sensitivity at the lines, from the direction models alone, with the median on its side, and never trade on it', () => {
    const predictions = [
      prediction('A', { pUpSource: 'dir-gbt', pUp: 0.56, medianPct: 0.3 }),
      prediction('B', { pUpSource: 'dir-gbt', pUp: 0.53, medianPct: 0.3 }),
      prediction('C', { pUpSource: 'dir-logistic', pUp: 0.45, medianPct: -0.3 }),
      prediction('D', { pUpSource: 'dir-gbt', pUp: 0.6, medianPct: -0.3 }),
      prediction('E', { pUpSource: 'distribution', pUp: 0.7, medianPct: 0.3 }),
      prediction('F', { pUpSource: 'dir-gbt', pUp: 0.59, medianPct: 0.3 })
    ]
    expect(sensitivityCounts(predictions)).toEqual({ '0.58': 1, '0.55': 3, '0.52': 4 })
    expect(sensitivityCounts([])).toEqual({ '0.58': 0, '0.55': 0, '0.52': 0 })
  })

  const trade = (id: string, strategy: 'strict' | 'direction', result: { exit: string; pnlQuote: number; closedAt: number } | undefined, amountQuote = 1000, status: 'active' | 'stopped' = result === undefined ? 'active' : 'stopped'): ExecutorConfig =>
    ({ id, mode: 'paper', type: 'position', status, quoteAsset: 'USDT', symbol: `${id}USDT`, lab: { strategy, qualified: [strategy], side: 'BUY', result }, params: { side: 'buy', amountQuote, stopLossPct: 1, slippageRate: 0.0002 } }) as unknown as ExecutorConfig

  it("add up the day's closed trades, reach the stop at the line, and leave another day's and an expired entry out", () => {
    const executors = [trade('a', 'strict', { exit: 'stop_loss', pnlQuote: -100, closedAt: T }), trade('b', 'direction', { exit: 'take_profit', pnlQuote: 40, closedAt: T + 60 }), trade('c', 'strict', { exit: 'stop_loss', pnlQuote: -90, closedAt: T - 86_400 }), trade('d', 'strict', { exit: 'entry_expired', pnlQuote: 0, closedAt: T }), trade('e', 'strict', undefined)]
    expect(labDayOf(T)).toBe('2026-10-16')
    expect(labDailyNet(executors, T + 3600, 'USDT')).toEqual({ netQuote: -60, closed: 2 })
    expect(labDailyNet(executors, T + 86_400, 'USDT')).toEqual({ netQuote: 0, closed: 0 })
    expect(labStopReached(-60, 10_000)).toBe(false)
    expect(labStopReached(-150, 10_000)).toBe(true)
    expect(labStopReached(-149.99, 10_000)).toBe(false)
    expect(labStopReached(-150, null)).toBe(false)
    // The laboratory's open trades count among the app's own, as the forecast trader's do.
    expect(ownOpenPaperTrades(executors).map((executor) => executor.id)).toEqual(['e'])
    expect(labPaperExecutors(executors, 'direction').map((executor) => executor.id)).toEqual(['b'])
  })

  it('give each strategy its record: trades, net, profit factor, win rate, expectancy, drawdown, costs and utilization', () => {
    const executors = [
      trade('a', 'strict', { exit: 'take_profit', pnlQuote: 30, closedAt: T }),
      trade('b', 'strict', { exit: 'stop_loss', pnlQuote: -20, closedAt: T + 60 }),
      trade('c', 'strict', { exit: 'stop_loss', pnlQuote: -25, closedAt: T + 120 }),
      trade('d', 'strict', { exit: 'take_profit', pnlQuote: 45, closedAt: T + 180 }),
      trade('e', 'strict', { exit: 'entry_expired', pnlQuote: 0, closedAt: T + 240 }),
      trade('f', 'strict', undefined, 800),
      trade('g', 'direction', { exit: 'take_profit', pnlQuote: 10, closedAt: T })
    ]
    const strict = labStatsOf(executors, 'strict', 10_000)
    expect(strict).toMatchObject({ strategy: 'strict', opened: 6, closed: 4, open: 1, wins: 2, netQuote: 30 })
    expect(strict.profitFactor).toBeCloseTo(75 / 45, 9)
    expect(strict.winRate).toBe(0.5)
    expect(strict.expectancyQuote).toBe(7.5)
    // 30, then -20 and -25: 45 down from the peak of 30.
    expect(strict.maxDrawdownQuote).toBe(45)
    expect(strict.feesQuote).toBeCloseTo(4 * 2 * 1000 * 0.001, 9)
    expect(strict.slippageQuote).toBeCloseTo(4 * 2 * 1000 * 0.0002, 9)
    expect(strict.utilizationPct).toBeCloseTo(8, 9)
    expect(labStatsOf(executors, 'news', 10_000)).toMatchObject({ opened: 0, closed: 0, open: 0, netQuote: 0, profitFactor: null, winRate: null, expectancyQuote: null, utilizationPct: 0 })
    expect(labStatsOf(executors, 'direction', null).utilizationPct).toBeNull()
    expect(LAB_STRATEGIES).toEqual(['strict', 'direction', 'news', 'hybrid'])
  })
})

describe('the laboratory', () => {
  const book = (pair: string, nowSec: number, patch: Partial<LiveBook> = {}): LiveBook => ({ symbol: pair, bid: 99.99, bidQty: 1000, ask: 100.01, askQty: 1000, updatedAt: nowSec * 1000, source: 'stream', ...patch })
  const ranked = (pair: string, decided: TradeDecision = decision(pair)): RankedForecast => ({
    pair,
    horizon: 'hour1',
    score: 10,
    quality: 80,
    quoteVolume24h: 1e8,
    parts: { edge: 1, reliability: 1, news: 1, liquidity: 1, execution: 1, uncertainty: 0, marketRisk: 0, cost: 5 },
    decision: decided
  })
  const funded = (usdt: number): PaperAccount => ({ balances: { USDT: usdt }, initialBalances: { USDT: usdt }, createdAt: T - 86_400, ledger: [] })

  function world(patch: { strategies?: Partial<Record<'strict' | 'direction' | 'news' | 'hybrid', boolean>>; executors?: ExecutorConfig[]; ranked?: RankedForecast[]; predictions?: PricePrediction[]; account?: PaperAccount | null; quant?: 'long' | 'short' | null; stopped?: { day: string; at: number; lossQuote: number; equityQuote: number } | null; book?: Partial<LiveBook> | null } = {}) {
    const nowSec = T + 60
    const store = {
      executors: patch.executors ?? [],
      paperAccount: patch.account === undefined ? funded(10_000) : patch.account,
      paperRisk: { ...DEFAULT_PAPER_RISK, maxOutQuote: null },
      paperPause: DEFAULT_PAPER_PAUSE,
      forecast: { refitNightly: true, trader: { enabled: false, stakeQuote: 100, maxOpen: 2, maxSameSide: 1 }, lab: { strategies: { strict: true, ...patch.strategies }, stopped: patch.stopped ?? null } }
    }
    const told: string[] = []
    const settled: string[] = []
    const asked: string[] = []
    const ranking: ForecastRanking = { at: T, ranked: patch.ranked ?? [ranked('SOLUSDT')], top10: [], top3: [] }
    const predictions = patch.predictions ?? ranking.ranked.map((entry) => prediction(entry.pair))
    const deps: LabTraderDeps = {
      getSettings: async () => store as never,
      setSettings: async (next) => {
        Object.assign(store, next)
      },
      ranking: async () => ranking,
      predictions: async () => predictions,
      liveBook: async (pair) => (patch.book === null ? null : book(pair, nowSec, patch.book ?? {})),
      btcCorrelation: async () => 0.2,
      quantSide: async (pair) => {
        asked.push(pair)
        return patch.quant === undefined ? null : patch.quant
      },
      fetchCandles: async () => [],
      settle: async (executor) => void settled.push(executor.id),
      notify: (title) => void told.push(title),
      nowSec: () => nowSec,
      newId: () => `lab-${store.executors.length + 1}`,
      queue: (work) => work()
    }
    return { store, deps, told, settled, asked, nowSec }
  }

  it('opens nothing while every strategy is off, which they are until a person switches one on', async () => {
    const { deps, store } = world({ strategies: { strict: false } })
    expect(await openLabTrades(deps)).toEqual({ opened: [], refused: [], sensitivity: {}, held: null })
    expect(store.executors).toEqual([])
  })

  it("opens a PAPER position under STRICT on a TRADE, staked at a tenth of the equity at most and risked at a quarter of a percent", async () => {
    const { deps, store, told } = world()
    const result = await openLabTrades(deps)
    expect(result.opened).toEqual([{ pair: 'SOLUSDT', strategy: 'strict' }])
    expect(result.refused).toEqual([])
    expect(result.held).toBeNull()
    expect(result.sensitivity).toEqual({ '0.58': 0, '0.55': 0, '0.52': 0 })
    const [trade] = store.executors
    expect(trade).toMatchObject({ mode: 'paper', type: 'position', symbol: 'SOLUSDT', status: 'active', keepPosition: false, liveOrder: null, name: 'Lab strict BUY SOLUSDT' })
    expect(trade.forecast).toBeUndefined()
    expect(trade.lab).toMatchObject({ strategy: 'strict', qualified: ['strict'], predictionId: `SOLUSDT:${T}`, horizon: 'hour1', side: 'BUY', classKey: 'large/hour1/other', verdict: 'PROBATION', btcCorrelation: 0.2 })
    const params = trade.params as PositionExecutorParams
    expect(params).toMatchObject({ side: 'buy', entryPrice: null, timeLimitSec: 3600, entryExpiresAt: T + 300, slippageRate: 0.0002 })
    // A quarter of a percent of 10,000 is 25 at a stop about 1% away: about 2,000, held to the tenth: 1,000.
    expect(params.amountQuote).toBe(1000)
    expect(told).toEqual(['Laboratory paper trade: BUY SOLUSDT'])
  })

  it('stakes less where the stop is far: what risks a quarter of a percent there', async () => {
    const far = world({ predictions: [prediction('SOLUSDT', { quantilesPct: [-5, 0.5, 1.5, 2.5, 4], quantilePrices: [95, 100.5, 101.5, 102.5, 104], bearPct: -5 })] })
    await openLabTrades(far.deps)
    const params = far.store.executors[0].params as PositionExecutorParams
    expect(params.stopLossPct).toBeCloseTo(5, 1)
    expect(params.amountQuote).toBeCloseTo(Math.floor((25 / (params.stopLossPct! / 100 + 2 * 0.001 + 2 * 0.0002)) * 100) / 100, 2)
    expect(params.amountQuote).toBeLessThan(1000)
  })

  it('takes up the candidates by their strategy, DIRECTION, NEWS EVENT and HYBRID each where the class alone held the call back', async () => {
    const direction = world({ strategies: { strict: false, direction: true }, ranked: [ranked('SOLUSDT', classHeld())], predictions: [prediction('SOLUSDT', { pUpSource: 'dir-gbt' })] })
    expect((await openLabTrades(direction.deps)).opened).toEqual([{ pair: 'SOLUSDT', strategy: 'direction' }])
    expect(direction.store.executors[0].lab?.qualified).toEqual(['direction'])
    const notTheSource = world({ strategies: { strict: false, direction: true }, ranked: [ranked('SOLUSDT', classHeld())] })
    expect((await openLabTrades(notTheSource.deps)).opened).toEqual([])
    const news = world({ strategies: { strict: false, news: true }, ranked: [ranked('SOLUSDT', classHeld())], predictions: [prediction('SOLUSDT', { news: { v3: null, v4: story } })] })
    expect((await openLabTrades(news.deps)).opened).toEqual([{ pair: 'SOLUSDT', strategy: 'news' }])
    const hybrid = world({ strategies: { strict: false, hybrid: true }, ranked: [ranked('SOLUSDT', classHeld())], quant: 'long' })
    expect((await openLabTrades(hybrid.deps)).opened).toEqual([{ pair: 'SOLUSDT', strategy: 'hybrid' }])
    expect(hybrid.asked).toEqual(['SOLUSDT'])
    const against = world({ strategies: { strict: false, hybrid: true }, ranked: [ranked('SOLUSDT', classHeld())], quant: 'short' })
    expect((await openLabTrades(against.deps)).opened).toEqual([])
    // With HYBRID off the strategy's reading is not asked for; a strategy switched off takes nothing up.
    const off = world({ strategies: { strict: false, direction: true }, ranked: [ranked('SOLUSDT', classHeld())], quant: 'long' })
    expect((await openLabTrades(off.deps)).opened).toEqual([])
    expect(off.asked).toEqual([])
    // A TRADE with STRICT off is opened under the next strategy it qualifies for, STRICT not written on it.
    const strictOff = world({ strategies: { strict: false, direction: true }, predictions: [prediction('SOLUSDT', { pUpSource: 'dir-gbt' })] })
    expect((await openLabTrades(strictOff.deps)).opened).toEqual([{ pair: 'SOLUSDT', strategy: 'direction' }])
    expect(strictOff.store.executors[0].lab?.qualified).toEqual(['direction'])
    // A TRADE that qualifies for several is opened under the first, the others written on it.
    const both = world({ strategies: { strict: true, direction: true, hybrid: true }, predictions: [prediction('SOLUSDT', { pUpSource: 'dir-gbt' })], quant: 'long' })
    await openLabTrades(both.deps)
    expect(both.store.executors[0].lab).toMatchObject({ strategy: 'strict', qualified: ['strict', 'direction', 'hybrid'] })
    expect(both.store.executors).toHaveLength(1)
  })

  it('decides again, on the book it reads, a call the pass held back for want of a live price', async () => {
    // The pass decides on the books the stream holds then; a pair off screen is held back STALE_PRICE.
    const stale = decision('SOLUSDT', { decision: 'NO_TRADE', reasons: [{ code: 'STALE_PRICE', text: 'No live price newer than ten seconds.' }] })
    const again = world({ ranked: [ranked('SOLUSDT', stale)] })
    expect((await openLabTrades(again.deps)).opened).toEqual([{ pair: 'SOLUSDT', strategy: 'strict' }])
    // Held back by anything else, it stays held back.
    const quality = world({ ranked: [ranked('SOLUSDT', decision('SOLUSDT', { decision: 'NO_TRADE', reasons: [{ code: 'STALE_PRICE', text: '' }, { code: 'QUALITY_LOW', text: '' }] }))] })
    expect((await openLabTrades(quality.deps)).opened).toEqual([])
  })

  it('is held to one trade a pair, three open, a fresh live price, and a paper account funded in USDT', async () => {
    const open = (id: string, symbol: string): ExecutorConfig => labPaperExecutor({ id, plan: { version: 'trade-plan-v1', pair: symbol, side: 'BUY', horizon: 'hour1', entryPrice: 100, entryMin: 99.9, entryMax: 100.1, stopPct: 1, stopPrice: 99, targetPct: 2.5, targetPrice: 102.5, targetLevel: 'P75', holdSec: 3600, validUntil: T + 300 }, mark: { strategy: 'strict', qualified: ['strict'], predictionId: 'x', barTime: T, openedAt: T, horizon: 'hour1', side: 'BUY', classKey: 'k', verdict: 'PROBATION', quantilesPct: [], pUp: 0.6, edgePct: 1, pProfit: 0.6, plan: { entryMin: 99.9, entryMax: 100.1, stopPct: 1, targetPct: 2.5, targetLevel: 'P75', holdSec: 3600, validUntil: T + 300 } } as LabTradeMark, amountQuote: 500, nowSec: T })
    const same = world({ executors: [open('o1', 'SOLUSDT')] })
    expect((await openLabTrades(same.deps)).refused[0].why).toBe('The laboratory already has a paper trade open on the pair.')
    const full = world({ executors: [open('o1', 'AUSDT'), open('o2', 'BUSDT'), open('o3', 'CUSDT')] })
    expect((await openLabTrades(full.deps)).refused[0].why).toBe('The laboratory has 3 paper trades open, the most it keeps.')
    const stale = world({ book: { updatedAt: (T + 60 - 20) * 1000 } })
    expect((await openLabTrades(stale.deps)).refused[0].why).toMatch(/seconds old/)
    const unfunded = world({ account: null })
    const held = await openLabTrades(unfunded.deps)
    expect(held.held).toBe('The laboratory has no paper account funded in USDT: fund it on the Forecast Lab.')
    expect(held.opened).toEqual([])
    expect(unfunded.store.executors).toEqual([])
  })

  it("stops for the day once the day's closed trades have lost 1.5% of the equity, says so once, and opens nothing until the next day", async () => {
    const lost = { id: 'l', mode: 'paper', type: 'position', status: 'stopped', quoteAsset: 'USDT', symbol: 'ETHUSDT', lab: { strategy: 'strict', qualified: ['strict'], side: 'BUY', result: { exit: 'stop_loss', pnlQuote: -150, closedAt: T } }, params: { side: 'buy', amountQuote: 1000, stopLossPct: 1 } } as unknown as ExecutorConfig
    const { deps, store, told } = world({ executors: [lost] })
    const first = await openLabTrades(deps)
    expect(first.held).toBe('The laboratory stopped for the day.')
    expect(first.opened).toEqual([])
    expect(healForecastSettings(store.forecast).lab.stopped).toEqual({ day: '2026-10-16', at: T + 60, lossQuote: 150, equityQuote: 10_000 })
    expect(told).toEqual(['The paper laboratory stopped for the day'])
    const second = await openLabTrades(deps)
    expect(second.held).toBe('The laboratory stopped for the day.')
    expect(told).toHaveLength(1)
    // The next UTC day it trades again; a loss short of the line never stops it.
    const tomorrow: LabTraderDeps = { ...deps, nowSec: () => T + 86_400 }
    expect((await openLabTrades(tomorrow)).held).toBeNull()
    const short = world({ executors: [{ ...lost, lab: { ...(lost.lab as object), result: { exit: 'stop_loss', pnlQuote: -149, closedAt: T } } } as ExecutorConfig] })
    expect((await openLabTrades(short.deps)).held).toBeNull()
    // A stop written for today holds the pass by itself, told no second time, whatever the trades on file.
    const written = world({ stopped: { day: '2026-10-16', at: T, lossQuote: 150, equityQuote: 10_000 } })
    const heldByStop = await openLabTrades(written.deps)
    expect(heldByStop.held).toBe('The laboratory stopped for the day.')
    expect(heldByStop.opened).toEqual([])
    expect(written.told).toEqual([])
    expect(written.store.executors).toEqual([])
  })

  it('settles a trade of its own that has closed, writing how it ended on its mark', async () => {
    const { deps, store, settled, told } = world()
    await openLabTrades(deps)
    const trade = store.executors[0]
    const params = trade.params as PositionExecutorParams
    const at = T + 120
    const target = 100.01 * (1 + (params.takeProfitPct as number) / 100)
    const candles: Candle[] = [
      { time: at, open: 100, high: 100.05, low: 99.95, close: 100, volume: 10 },
      { time: at + 60, open: 100, high: target * 1.001, low: 99.99, close: target, volume: 10 }
    ]
    const later: LabTraderDeps = { ...deps, fetchCandles: async () => candles, nowSec: () => at + 180 }
    expect(await settleLabTrades(later)).toEqual([trade.name])
    expect(store.executors[0]).toMatchObject({ status: 'stopped', lab: { strategy: 'strict', result: { exit: 'take_profit' } } })
    expect(store.executors[0].lab?.result?.pnlQuote).toBeGreaterThan(0)
    expect(settled).toEqual([trade.id])
    expect(told.at(-1)).toMatch(/SOLUSDT/)
    expect(await settleLabTrades(later)).toEqual([])
    // What it made is on the laboratory's record, and the run's report counts it by strategy.
    expect(labStatsOf(store.executors, 'strict', 10_000)).toMatchObject({ opened: 1, closed: 1, open: 0, wins: 1 })
    const section = forecastRunSectionOf({ fromSec: T - 60, toSec: at + 600, predictions: [], outcomes: [], executors: store.executors, alerts: [] })
    expect(section.lab).toEqual({ strict: { opened: 1, closed: 1, netQuote: store.executors[0].lab!.result!.pnlQuote } })
  })

  it('FUND fills the paper account to 10,000 USDT on a click: made where there is none, topped up, left alone', async () => {
    const none = world({ account: null })
    expect(await fundLab(none.deps)).toEqual({ added: 10_000, balance: 10_000 })
    expect(none.store.paperAccount).toMatchObject({ balances: { USDT: 10_000 }, initialBalances: { USDT: 10_000 } })
    expect(none.store.paperAccount!.ledger).toHaveLength(1)
    const some = world({ account: funded(4_000) })
    expect(await fundLab(some.deps)).toEqual({ added: 6_000, balance: 10_000 })
    expect(some.store.paperAccount!.initialBalances.USDT).toBe(10_000)
    const plenty = world({ account: funded(12_000) })
    const before = plenty.store.paperAccount
    expect(await fundLab(plenty.deps)).toEqual({ added: 0, balance: 12_000 })
    expect(plenty.store.paperAccount).toBe(before)
  })
})
