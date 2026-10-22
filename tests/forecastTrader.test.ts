import { describe, expect, it } from 'vitest'
import { FORECAST_PROPOSAL_MODEL, aiProposalPositionParams, describeAiProposal, forecastProposal } from '../shared/aiProposal'
import { ROUND_TRIP_PCT } from '../shared/forecast/edge'
import type { ForecastBar } from '../shared/forecast/bars'
import { CLASS_LINES, breakoutAt, classKeyOf, classTable, classTradable, classVerdict, setupOf } from '../shared/forecast/opportunityClass'
import type { ForecastRange, PricePrediction } from '../shared/forecast/prediction'
import type { ForecastRanking, RankedForecast } from '../shared/forecast/ranking'
import { PLAN_LINES, levelPct, planValid, tradePlanOf } from '../shared/forecast/tradePlan'
import type { TradeDecision } from '../shared/forecast/tradeDecision'
import { DEFAULT_PAPER_PAUSE, paperPauseBlock, paperRun } from '../shared/paperPause'
import { CORRELATED_SHARE, correlatedCap, correlatedShareOf } from '../shared/paperExposure'
import { DEFAULT_PAPER_RISK, paperOut } from '../shared/paperRisk'
import { DEFAULT_FORECAST_TRADER } from '../shared/forecast/trader'
import type { Candle, ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import type { LiveBook } from '../shared/liveMarket'
import { forecastPaperExecutors, openForecastTrades, settleForecastTrades, type ForecastTraderDeps } from '../src/forecast/forecastTrader'
import { tradeThisOf } from '../src/forecast/tradeThis'

// FROM A FORECAST TO A TRADE (shared/forecast/{tradePlan,opportunityClass,trader}.ts, shared/aiProposal.ts,
// src/forecast/{tradeThis,forecastTrader}.ts; the V6 document, §29-30, §62, §66-68, §99 and §106-108):
// a TRADE decision's plan from the live price, each opportunity class judged by its lines, TRADE THIS
// filling in the Position form, and the forecast trader opening a PAPER position on a seeded TRADE --
// and not, for each thing that stands in its way -- then settling it once it has closed.

const T = Date.parse('2026-10-13T12:00:00Z') / 1000

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

function prediction(pair = 'SOLUSDT', hour: Partial<ForecastRange> = {}, patch: Partial<PricePrediction> = {}): PricePrediction {
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
    versions: { prediction: 'p', models: 'm', features: 'f', ensemble: 'e', calibration: 'c', runCalibration: 'r', news: 'n', quality: 'q', run: 'run', foldsRun: 'folds' },
    ...patch
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

describe('the trade plan', () => {
  it('enters in half a five-minute ATR either side of the live price, until the next close', () => {
    const plan = tradePlanOf({ decision: decision(), prediction: prediction(), livePrice: 100, atr5mPct: 0.2, targetLevel: 'P75' })!
    expect(plan.entryPrice).toBe(100)
    expect(plan.entryMin).toBeCloseTo(100 * (1 - 0.001), 12)
    expect(plan.entryMax).toBeCloseTo(100 * (1 + 0.001), 12)
    expect(plan.validUntil).toBe(T + 300)
    expect(plan.holdSec).toBe(3600)
    // Without an ATR, 0.1% either side.
    expect(tradePlanOf({ decision: decision(), prediction: prediction(), livePrice: 100, atr5mPct: null, targetLevel: 'P75' })!.entryMin).toBeCloseTo(100 * (1 - PLAN_LINES.zoneWithoutAtrPct / 100), 12)
  })

  it("stops at the forecast's P10 level, never nearer than one and a half ATRs nor 0.2%, and takes the mode's level", () => {
    // P10 is -1% from the close at 100: from a live 100, a 1% stop.
    const plan = tradePlanOf({ decision: decision(), prediction: prediction(), livePrice: 100, atr5mPct: 0.2, targetLevel: 'P75' })!
    expect(plan.stopPct).toBeCloseTo(1, 12)
    expect(plan.stopPrice).toBeCloseTo(99, 12)
    expect(plan.targetPct).toBeCloseTo(2.5, 12)
    expect(plan.targetPrice).toBeCloseTo(102.5, 12)
    // A P10 nearer than 1.5 ATRs (1.5 x 0.8% = 1.2%) stops at the ATR.
    expect(tradePlanOf({ decision: decision(), prediction: prediction(), livePrice: 100, atr5mPct: 0.8, targetLevel: 'P75' })!.stopPct).toBeCloseTo(1.2, 12)
    // And never nearer than 0.2%.
    expect(tradePlanOf({ decision: decision(), prediction: prediction('SOLUSDT', { quantilesPct: [-0.1, 0.5, 1.5, 2.5, 4] }), livePrice: 100, atr5mPct: 0.05, targetLevel: 'P75' })!.stopPct).toBeCloseTo(0.2, 12)
    // P80 is read a third of the way from P75 to P90; P90 is P90.
    expect(levelPct([-1, 0.5, 1.5, 2.5, 4], 'P80', 'BUY')).toBeCloseTo(3, 12)
    expect(tradePlanOf({ decision: decision(), prediction: prediction(), livePrice: 100, atr5mPct: 0.2, targetLevel: 'P90' })!.targetPct).toBeCloseTo(4, 12)
    // From a live price above the close, the levels are the close's: the move left is less.
    expect(tradePlanOf({ decision: decision(), prediction: prediction(), livePrice: 101, atr5mPct: 0.2, targetLevel: 'P75' })!.targetPct).toBeCloseTo((102.5 / 101 - 1) * 100, 12)
  })

  it('mirrors a sell, and has no plan where the target does not clear a round trip or there is no TRADE', () => {
    const bear = prediction('SOLUSDT', { direction: 'BEARISH', quantilesPct: [-4, -2.5, -1.5, -0.5, 1] })
    const sell = tradePlanOf({ decision: decision('SOLUSDT', { side: 'SELL' }), prediction: bear, livePrice: 100, atr5mPct: 0.2, targetLevel: 'P75' })!
    expect(sell.side).toBe('SELL')
    expect(sell.stopPct).toBeCloseTo(1, 12)
    expect(sell.stopPrice).toBeCloseTo(101, 12)
    expect(sell.targetPct).toBeCloseTo(2.5, 12)
    expect(levelPct([-4, -2.5, -1.5, -0.5, 1], 'P80', 'SELL')).toBeCloseTo(-3, 12)
    // A live price at 102.4: the P75 target of 102.5 is 0.1% away, under a round trip's 0.24%.
    expect(tradePlanOf({ decision: decision(), prediction: prediction(), livePrice: 102.4, atr5mPct: 0.2, targetLevel: 'P75' })).toBeNull()
    // At 101.8 it is 0.69% away: over a round trip, under the hour's line of a move worth its costs (V7.2-R Stage 3).
    expect(tradePlanOf({ decision: decision(), prediction: prediction(), livePrice: 101.8, atr5mPct: 0.2, targetLevel: 'P75' })).toBeNull()
    expect(tradePlanOf({ decision: decision(), prediction: prediction(), livePrice: 101.4, atr5mPct: 0.2, targetLevel: 'P75' })!.targetPct).toBeGreaterThanOrEqual(1)
    expect(tradePlanOf({ decision: decision('SOLUSDT', { decision: 'NO_TRADE' }), prediction: prediction(), livePrice: 100, atr5mPct: 0.2, targetLevel: 'P75' })).toBeNull()
    expect(ROUND_TRIP_PCT).toBeCloseTo(0.24, 12)
  })

  it('holds before the next close with the price in its zone, and not after', () => {
    const plan = { entryMin: 99.9, entryMax: 100.1, validUntil: T + 300 }
    expect(planValid(plan, 100, T + 299)).toBe(true)
    expect(planValid(plan, 100, T + 300)).toBe(false)
    expect(planValid(plan, 100.2, T + 10)).toBe(false)
    expect(planValid(plan, 99.89, T + 10)).toBe(false)
  })
})

describe('opportunity classes (§99)', () => {
  it("names a setup by the first that holds: a story, a break, a reversal, the market's way, or none", () => {
    const base = { side: 'BUY' as const, story: false, breakout: false, prior: 0.5, regime: 'sideways' as const }
    expect(setupOf({ ...base, story: true, breakout: true })).toBe('news')
    expect(setupOf({ ...base, breakout: true, prior: -3 })).toBe('breakout')
    expect(setupOf({ ...base, prior: -2 })).toBe('reversal')
    expect(setupOf({ ...base, prior: -1.99 })).toBe('other')
    // A buy after a pump is not a reversal.
    expect(setupOf({ ...base, prior: 2.5 })).toBe('other')
    expect(setupOf({ ...base, side: 'SELL', prior: 2 })).toBe('reversal')
    expect(setupOf({ ...base, regime: 'bull' })).toBe('trend')
    expect(setupOf({ ...base, side: 'SELL', regime: 'bull' })).toBe('other')
    expect(setupOf({ ...base, side: 'SELL', regime: 'bear' })).toBe('trend')
    expect(classKeyOf('large', 'hour1', 'trend')).toBe('large/hour1/trend')
  })

  it("reads a break of the day before's range from five-minute bars", () => {
    const bar = (time: number, close: number, high = close, low = close): ForecastBar => ({ time, open: close, high, low, close, volume: 1, quoteVolume: close, takerBuyVolume: 0.5, trades: 1 })
    const day: ForecastBar[] = []
    for (let time = T - 300 - 86_400; time < T - 300; time += 300) day.push(bar(time, 100, 100.5, 99.5))
    expect(breakoutAt([...day, bar(T - 300, 100.6)], T)).toBe(true)
    expect(breakoutAt([...day, bar(T - 300, 99.4)], T)).toBe(true)
    expect(breakoutAt([...day, bar(T - 300, 100.4)], T)).toBe(false)
    expect(breakoutAt(day, T)).toBe(false)
    expect(breakoutAt(undefined, T)).toBe(false)
  })

  it('judges a class by its lines: not enough under 30 replayed trades, disabled where either lost, approved where both made money', () => {
    expect(CLASS_LINES).toEqual({ minHistoryTrades: 30, minLiveTrades: 10, shock: 2 })
    expect(classVerdict({ trades: 29, netPct: 50 }, { trades: 20, netPct: 10 })).toBe('NOT_ENOUGH')
    expect(classVerdict({ trades: 30, netPct: 0 }, { trades: 0, netPct: 0 })).toBe('DISABLED')
    expect(classVerdict({ trades: 30, netPct: 5 }, { trades: 9, netPct: -20 })).toBe('PROBATION')
    expect(classVerdict({ trades: 30, netPct: 5 }, { trades: 10, netPct: -0.1 })).toBe('DISABLED')
    expect(classVerdict({ trades: 30, netPct: 5 }, { trades: 10, netPct: 0.1 })).toBe('APPROVED')
    expect(['APPROVED', 'PROBATION', 'DISABLED', 'NOT_ENOUGH'].map((verdict) => classTradable(verdict as 'APPROVED'))).toEqual([true, true, false, false])
    const history = Array.from({ length: 30 }, () => ({ classKey: 'large/hour1/trend', netPct: 0.5 }))
    const table = classTable([...history, { classKey: 'mid/hours4/news', netPct: 1 }], [{ classKey: 'large/hour1/trend', netPct: -1 }])
    expect(table.map((record) => [record.key, record.history.trades, record.live.trades, record.verdict])).toEqual([
      ['large/hour1/trend', 30, 1, 'PROBATION'],
      ['mid/hours4/news', 1, 0, 'NOT_ENOUGH']
    ])
  })
})

describe('TRADE THIS', () => {
  it('fills in the Position form from the plan, paper until a person makes it otherwise, a sell paper only', () => {
    const made = tradeThisOf({ prediction: prediction(), decision: decision(), livePrice: 100, targetLevel: 'P75', nowSec: T + 60 })
    if (!('proposal' in made)) throw new Error(made.problem)
    const proposal = made.proposal
    expect(proposal).toMatchObject({ exchange: 'binance', model: FORECAST_PROPOSAL_MODEL, side: 'buy', entryPrice: null, stopLossPct: 1, takeProfitPct: 2.5, timeLimitSec: 3600, expiresAt: T + 300, confidence: 0.7 })
    expect(proposal.pair).toEqual({ symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' })
    expect(proposal.entryRange?.min).toBeCloseTo(99.9, 9)
    // No amount and no mode: the form's own.
    expect(Object.keys(proposal)).not.toContain('amountQuote')
    expect(Object.keys(proposal)).not.toContain('mode')
    const params = aiProposalPositionParams(proposal, { side: 'buy', entryPrice: null, amountQuote: 50, takeProfitPct: 3, stopLossPct: 2, timeLimitSec: null, trailingStop: null })
    expect(params).toMatchObject({ side: 'buy', amountQuote: 50, stopLossPct: 1, takeProfitPct: 2.5, timeLimitSec: 3600 })
    const words = describeAiProposal(proposal)
    expect(words[0]).toBe('Filled in from the price forecast: BUY SOLUSDT, its forecast read at the 12:00 UTC close, 70% the way it calls.')
    expect(words[words.length - 1]).toMatch(/real money still needs Live Trading ticked below and its phrase typed/)
    const bear = prediction('SOLUSDT', { direction: 'BEARISH', pUp: 0.3, quantilesPct: [-4, -2.5, -1.5, -0.5, 1] })
    const sell = tradeThisOf({ prediction: bear, decision: decision('SOLUSDT', { side: 'SELL' }), livePrice: 100, targetLevel: 'P75', nowSec: T + 60 })
    if (!('proposal' in sell)) throw new Error(sell.problem)
    expect(sell.proposal.side).toBe('sell')
    expect(sell.proposal.confidence).toBeCloseTo(0.7, 12)
    expect(describeAiProposal(sell.proposal).at(-1)).toMatch(/A short is paper only/)
    expect(forecastProposal({ plan: made.plan, confidence: 0.7, barTime: T }).model).toBe('price-forecast')
  })

  it('offers nothing, and says why, without a TRADE, a live price, a plan or its time', () => {
    const problem = (input: Partial<Parameters<typeof tradeThisOf>[0]>): string => {
      const made = tradeThisOf({ prediction: prediction(), decision: decision(), livePrice: 100, targetLevel: 'P75', nowSec: T + 60, ...input })
      return 'problem' in made ? made.problem : 'a proposal'
    }
    expect(problem({ decision: null })).toBe('No decision yet.')
    expect(problem({ decision: decision('SOLUSDT', { decision: 'NO_TRADE', reasons: [{ code: 'NO_CALL', text: 'It calls no way.' }] }) })).toBe('NO TRADE: It calls no way.')
    expect(problem({ livePrice: null })).toBe('No live price: the plan is read from it.')
    expect(problem({ livePrice: 102.4 })).toBe('From the live price its P75 target does not clear a round trip.')
    expect(problem({ nowSec: T + 300 })).toBe('Its plan no longer holds: the next close has come, or the price has left its zone.')
  })
})

describe('the forecast trader (§66-68)', () => {
  const book = (pair: string, nowSec: number, patch: Partial<LiveBook> = {}): LiveBook => ({ symbol: pair, bid: 99.99, bidQty: 1000, ask: 100.01, askQty: 1000, updatedAt: nowSec * 1000, source: 'stream', ...patch })
  const ranked = (pair: string, patch: Partial<TradeDecision> = {}): RankedForecast => ({
    pair,
    horizon: 'hour1',
    score: 10,
    quality: 80,
    quoteVolume24h: 1e8,
    parts: { edge: 1, reliability: 1, news: 1, liquidity: 1, execution: 1, uncertainty: 0, marketRisk: 0, cost: 5 },
    decision: decision(pair, patch)
  })

  function world(patch: { enabled?: boolean; executors?: ExecutorConfig[]; ranked?: RankedForecast[]; pause?: typeof DEFAULT_PAPER_PAUSE; book?: Partial<LiveBook> | null; maxOutQuote?: number | null; correlation?: number | null; trader?: Record<string, unknown>; barTime?: number; prediction?: Partial<PricePrediction> } = {}) {
    const nowSec = T + 60
    const store = {
      executors: patch.executors ?? [],
      paperAccount: null,
      paperRisk: { ...DEFAULT_PAPER_RISK, maxOutQuote: patch.maxOutQuote === undefined ? DEFAULT_PAPER_RISK.maxOutQuote : patch.maxOutQuote },
      paperPause: patch.pause ?? DEFAULT_PAPER_PAUSE,
      forecast: { refitNightly: true, trader: { enabled: patch.enabled ?? true, stakeQuote: 100, maxOpen: 2, maxSameSide: 1, ...patch.trader } }
    }
    const told: string[] = []
    const settled: string[] = []
    const ranking: ForecastRanking = { at: T, ranked: patch.ranked ?? [ranked('SOLUSDT')], top10: [], top3: [] }
    const deps: ForecastTraderDeps = {
      getSettings: async () => store as never,
      setExecutors: async (executors) => {
        store.executors = executors
      },
      ranking: async () => ranking,
      predictions: async () => ranking.ranked.map((entry) => prediction(entry.pair, {}, { ...(patch.barTime === undefined ? {} : { barTime: patch.barTime }), ...patch.prediction })),
      liveBook: async (pair) => (patch.book === null ? null : book(pair, nowSec, patch.book ?? {})),
      btcCorrelation: async () => (patch.correlation === undefined ? 0.2 : patch.correlation),
      fetchCandles: async () => [],
      settle: async (executor) => void settled.push(executor.id),
      notify: (title) => void told.push(title),
      nowSec: () => nowSec,
      newId: () => `id-${store.executors.length + 1}`,
      queue: (work) => work()
    }
    return { store, deps, told, settled }
  }

  it('opens nothing while switched off, which it is until a person switches it on', async () => {
    expect(DEFAULT_FORECAST_TRADER.enabled).toBe(false)
    const { deps, store } = world({ enabled: false })
    expect(await openForecastTrades(deps)).toEqual({ opened: [], refused: [] })
    expect(store.executors).toEqual([])
  })

  it("opens a PAPER position on a seeded TRADE: the plan's entry zone, stop, target and horizon, sized by the risk mode", async () => {
    const { deps, store, told } = world()
    const result = await openForecastTrades(deps)
    expect(result).toEqual({ opened: ['SOLUSDT'], refused: [] })
    expect(store.executors).toHaveLength(1)
    const [trade] = store.executors
    expect(trade).toMatchObject({ mode: 'paper', type: 'position', symbol: 'SOLUSDT', status: 'active', keepPosition: false, liveOrder: null })
    const params = trade.params as PositionExecutorParams
    expect(params).toMatchObject({ side: 'buy', entryPrice: null, timeLimitSec: 3600, entryExpiresAt: T + 300, slippageRate: 0.0002 })
    expect(params.stopLossPct).toBeCloseTo(1, 1)
    expect(params.entryRange?.min).toBeLessThan(100)
    // Without a paper account, sized at Conservative's 1 at the stop: about 1 / (1% + fees and slippage).
    expect(params.amountQuote).toBeCloseTo(Math.floor((1 / (params.stopLossPct! / 100 + 2 * 0.001 + 2 * 0.0002)) * 100) / 100, 2)
    expect(trade.forecast).toMatchObject({ predictionId: `SOLUSDT:${T}`, horizon: 'hour1', side: 'BUY', classKey: 'large/hour1/other', verdict: 'PROBATION', plan: { targetLevel: 'P75' }, btcCorrelation: 0.2 })
    expect(forecastPaperExecutors(store.executors)).toHaveLength(1)
    expect(told).toEqual(['Forecast paper trade: BUY SOLUSDT'])
  })

  it('refuses a TRADE whose class has not earned it, without a fresh live price, or whose plan no longer holds', async () => {
    const notEnough = world({ ranked: [ranked('SOLUSDT', { classVerdict: 'NOT_ENOUGH' })] })
    expect((await openForecastTrades(notEnough.deps)).refused[0].why).toMatch(/is not approved or on probation/)
    const unjudged = world({ ranked: [ranked('SOLUSDT', { classVerdict: null, classKey: null })] })
    expect((await openForecastTrades(unjudged.deps)).refused[0].why).toMatch(/not read\) is not approved/)
    const stale = world({ book: { updatedAt: (T + 60 - 30) * 1000 } })
    expect((await openForecastTrades(stale.deps)).refused[0].why).toMatch(/seconds old/)
    const wide = world({ book: { bid: 99.8, ask: 100.2 } })
    expect((await openForecastTrades(wide.deps)).refused[0].why).toMatch(/spread/)
    const gone = world({ book: { bid: 102.39, ask: 102.41 } })
    expect((await openForecastTrades(gone.deps)).refused[0].why).toMatch(/plan does not hold/)
    // A forecast read at the close before: its plan was good until this close, which has come.
    const late = world({ barTime: T - 300 })
    expect((await openForecastTrades(late.deps)).refused[0].why).toMatch(/plan does not hold/)
    for (const case_ of [notEnough, unjudged, stale, wide, gone, late]) expect(case_.store.executors).toEqual([])
  })

  // Found by V6 Stage 16's 12-hour run: the pass decides on the books the stream holds, those of the
  // pairs on screen, so a pair off screen was never decided TRADE.
  it('decides again, on the book it reads, a call the pass held back by the live price alone, and reads none for one held back by more', async () => {
    const stale: Partial<TradeDecision> = { decision: 'NO_TRADE', reasons: [{ code: 'STALE_PRICE', text: 'There is no live price newer than ten seconds.' }] }
    const held = world({ ranked: [ranked('SOLUSDT', stale)] })
    expect(await openForecastTrades(held.deps)).toEqual({ opened: ['SOLUSDT'], refused: [] })
    expect(held.store.executors[0]).toMatchObject({ mode: 'paper', symbol: 'SOLUSDT', forecast: { side: 'BUY', classKey: 'large/hour1/other', verdict: 'PROBATION' } })
    // Decided again, another line holds it back: refused, saying which.
    const against = world({ ranked: [ranked('SOLUSDT', stale)], prediction: { regime: 'bear' } })
    expect((await openForecastTrades(against.deps)).refused).toEqual([{ pair: 'SOLUSDT', why: 'A BUY against a bear market.' }])
    // Held back by more than the price: no book is read for it, and nothing is said.
    const more = world({ ranked: [ranked('SOLUSDT', { decision: 'NO_TRADE', reasons: [{ code: 'QUALITY_LOW', text: 'Its quality is 50, under 60.' }, ...stale.reasons!] })] })
    expect(await openForecastTrades(more.deps)).toEqual({ opened: [], refused: [] })
    for (const case_ of [against, more]) expect(case_.store.executors).toEqual([])
  })

  it('keeps one trade a pair, as many open and on one side as the risk mode keeps, and pauses on its own losing run', async () => {
    const two = world({ ranked: [ranked('SOLUSDT'), ranked('ETHUSDT'), ranked('XRPUSDT')], trader: { maxOpen: 2, maxSameSide: 1 } })
    const result = await openForecastTrades(two.deps)
    expect(result.opened).toEqual(['SOLUSDT'])
    // One is said as one since V6 Stage 14 (en.json's singular).
    expect(result.refused.map((entry) => entry.why)).toEqual([expect.stringMatching(/1 paper BUY open, the most the risk mode keeps on one side/), expect.stringMatching(/1 paper BUY open/)])
    const again = await openForecastTrades(two.deps)
    expect(again.refused[0].why).toBe('It already has a paper trade open on the pair.')
    const wider = world({ ranked: [ranked('SOLUSDT'), ranked('ETHUSDT'), ranked('XRPUSDT')], trader: { maxOpen: 2, maxSameSide: 3 } })
    const opened = await openForecastTrades(wider.deps)
    expect(opened.opened).toEqual(['SOLUSDT', 'ETHUSDT'])
    expect(opened.refused[0].why).toBe('It has 2 paper trades open, the most the risk mode keeps.')
    const paused = world({ pause: { ...DEFAULT_PAPER_PAUSE, forecast: { countFrom: null, paused: { at: T, r: -5.2, trades: 6 } } } })
    expect((await openForecastTrades(paused.deps)).refused[0].why).toMatch(/^The forecast trader's last 6 closed paper trades had lost 5.20 R together/)
    expect(paused.store.executors).toEqual([])
  })

  it("is held to what the app's own paper trades stake together, and on one side on coins that move with Bitcoin", async () => {
    const capped = world({ maxOutQuote: 250, executors: [{ id: 'w', mode: 'paper', type: 'position', status: 'active', quoteAsset: 'USDT', symbol: 'BTCUSDT', watch: { btcCorrelation: 0.9 }, params: { side: 'buy', amountQuote: 240 } } as unknown as ExecutorConfig] })
    expect((await openForecastTrades(capped.deps)).refused[0].why).toMatch(/^The app's own open paper trades stake 240 USDT together/)
    const correlated = world({ maxOutQuote: 1000, correlation: 0.9, executors: [{ id: 'w', mode: 'paper', type: 'position', status: 'active', quoteAsset: 'USDT', symbol: 'BTCUSDT', watch: { btcCorrelation: 0.9 }, params: { side: 'buy', amountQuote: 140 } } as unknown as ExecutorConfig] })
    expect((await openForecastTrades(correlated.deps)).refused[0].why).toMatch(/move with Bitcoin|moves with Bitcoin/)
    // Its own open trades count among the app's own: what they stake is out too.
    const own = { id: 'f', mode: 'paper', type: 'position', status: 'active', quoteAsset: 'USDT', symbol: 'ETHUSDT', forecast: { side: 'BUY' }, params: { side: 'buy', amountQuote: 240 } } as unknown as ExecutorConfig
    expect(paperOut([own], 'USDT')).toBe(240)
    const ownCapped = world({ maxOutQuote: 250, trader: { maxSameSide: 3 }, executors: [own] })
    expect((await openForecastTrades(ownCapped.deps)).refused[0].why).toMatch(/^The app's own open paper trades stake 240 USDT together/)
  })

  it('settles a trade of its own that has closed, writing how it ended on its mark', async () => {
    const { deps, store, settled, told } = world()
    await openForecastTrades(deps)
    const trade = store.executors[0]
    const params = trade.params as PositionExecutorParams
    // A minute inside the zone, then one that reaches the target.
    const at = T + 120
    const target = 100.01 * (1 + (params.takeProfitPct as number) / 100)
    const candles: Candle[] = [
      { time: at, open: 100, high: 100.05, low: 99.95, close: 100, volume: 10 },
      { time: at + 60, open: 100, high: target * 1.001, low: 99.99, close: target, volume: 10 }
    ]
    const later: ForecastTraderDeps = { ...deps, fetchCandles: async () => candles, nowSec: () => at + 180 }
    expect(await settleForecastTrades(later)).toEqual([trade.name])
    expect(store.executors[0]).toMatchObject({ status: 'stopped', forecast: { result: { exit: 'take_profit' } } })
    expect(store.executors[0].forecast?.result?.pnlQuote).toBeGreaterThan(0)
    expect(settled).toEqual([trade.id])
    expect(told.at(-1)).toMatch(/SOLUSDT/)
    // Stopped, it is not settled again.
    expect(await settleForecastTrades(later)).toEqual([])
  })

  it('leaves a trade stopped by hand between its read and its settling as it was', async () => {
    const { deps, store, settled } = world()
    await openForecastTrades(deps)
    const trade = store.executors[0]
    const params = trade.params as PositionExecutorParams
    const target = 100.01 * (1 + (params.takeProfitPct as number) / 100)
    const candles: Candle[] = [
      { time: T + 120, open: 100, high: 100.05, low: 99.95, close: 100, volume: 10 },
      { time: T + 180, open: 100, high: target * 1.001, low: 99.99, close: target, volume: 10 }
    ]
    // The pass reads it open; by the time its write runs, a person has stopped it.
    const byHand: ExecutorConfig = { ...trade, status: 'stopped', stoppedAt: T + 150 }
    let reads = 0
    const racing: ForecastTraderDeps = {
      ...deps,
      getSettings: async () => (reads++ === 0 ? (store as never) : ({ ...store, executors: [byHand] } as never)),
      fetchCandles: async () => candles,
      nowSec: () => T + 240
    }
    expect(await settleForecastTrades(racing)).toEqual([])
    expect(settled).toEqual([])
    expect(store.executors[0].forecast?.result).toBeUndefined()
  })
})

describe('what the risk mode sets for every paper trade the app opens by itself', () => {
  it("holds those on one side on coins that move with Bitcoin to the mode's share, 15% as it was before the modes", () => {
    expect(correlatedShareOf({})).toBe(CORRELATED_SHARE)
    expect(CORRELATED_SHARE).toBe(0.15)
    expect(correlatedShareOf({ correlatedShare: 0.35 })).toBe(0.35)
    expect(correlatedShareOf({ correlatedShare: 2 })).toBe(0.15)
    expect(correlatedCap({ account: null, risk: { ...DEFAULT_PAPER_RISK, maxOutQuote: 5000, correlatedShare: 0.35 }, quoteAsset: 'USDT' })).toBeCloseTo(1750, 9)
    expect(correlatedCap({ account: { initialBalances: { USDT: 10_000 } } as never, risk: { ...DEFAULT_PAPER_RISK, correlatedShare: 0.25 }, quoteAsset: 'USDT' })).toBeCloseTo(2500, 9)
  })

  it("pauses the forecast trader on its own losing run, apart from the watch's and the news rules'", () => {
    const lost = (id: string, closedAt: number): ExecutorConfig =>
      ({ id, mode: 'paper', type: 'position', status: 'stopped', params: { side: 'buy', amountQuote: 100, stopLossPct: 1, slippageRate: 0 }, forecast: { classKey: 'k', result: { exit: 'stop_loss', pnlQuote: -1.2, closedAt } } }) as unknown as ExecutorConfig
    const executors = Array.from({ length: 6 }, (_, k) => lost(`f${k}`, T + k))
    expect(paperRun(executors, 'forecast', DEFAULT_PAPER_PAUSE).trades).toBe(6)
    expect(paperRun(executors, 'watch', DEFAULT_PAPER_PAUSE).trades).toBe(0)
    expect(paperPauseBlock({ setting: DEFAULT_PAPER_PAUSE, executors, source: 'forecast' })).toMatch(/^The forecast trader's last 6 closed paper trades lost/)
    expect(paperPauseBlock({ setting: DEFAULT_PAPER_PAUSE, executors, source: 'watch' })).toBeNull()
  })
})
