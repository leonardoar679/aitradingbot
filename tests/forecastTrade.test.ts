import { describe, expect, it } from 'vitest'
import { DIRECTION_LINES } from '../shared/forecast/direction'
import { ROUND_TRIP_PCT, edgeOf, roundTripCostPct } from '../shared/forecast/edge'
import type { NewsEffect } from '../shared/forecast/newsEffect'
import type { ForecastRange, PricePrediction } from '../shared/forecast/prediction'
import { QUALITY_LINES, qualityOf, type QualityInput } from '../shared/forecast/quality'
import { RANK_LINES, funnel, rankOf } from '../shared/forecast/ranking'
import { DECISION_LINES, OPPORTUNITY_LINES, decideOnBook, decideTrade, heldBackByPrice, likelyMovePct, liveOfBook, reasonText, type DecisionInput } from '../shared/forecast/tradeDecision'
import type { LiveBook } from '../shared/liveMarket'
import { decisionFor } from '../shared/forecast/pass'

// THE FORECAST AGAINST THE TRADE (shared/forecast/{quality,edge,ranking,tradeDecision}.ts; the V6
// document, §29-33, §62-63 and §69): how good a forecast is, what it is worth after costs, where it
// ranks, and whether it is worth trading -- every reason it is not.

const T = Date.parse('2026-10-13T15:00:00Z') / 1000

describe('the quality', () => {
  const base: QualityInput = { pUp: 0.65, directionSkill: 0.02, width80Pct: 3, usualWidth80Pct: 4, coverage80: 0.8, disagreement: 0, news: null, market: { z1h: 0, breadth1h: 0.5 }, ageSec: 10 }
  const q = (patch: Partial<QualityInput> = {}): ReturnType<typeof qualityOf> => qualityOf({ ...base, ...patch })

  it('reads its direction from P(up) only where the direction was skilful, full at fifteen points', () => {
    expect(q().parts.direction).toBe(100)
    expect(q({ pUp: 0.575 }).parts.direction).toBeCloseTo(50, 9)
    expect(q({ pUp: 0.35 }).parts.direction).toBe(100)
    expect(q({ directionSkill: DIRECTION_LINES.minDirectionSkill - 0.001 }).parts.direction).toBe(0)
    expect(q({ directionSkill: null }).parts.direction).toBe(0)
  })

  it('reads its range against its class\'s usual, its calibration, its agreement and its freshness by their lines', () => {
    expect(q({ width80Pct: 3 }).parts.range).toBe(100)
    expect(q({ width80Pct: 8 }).parts.range).toBe(0)
    // 5.5 against 4 is 1.375 of it: halfway from three quarters to twice.
    expect(q({ width80Pct: 5.5 }).parts.range).toBeCloseTo(50, 9)
    expect(q({ usualWidth80Pct: 0 }).parts.range).toBe(50)
    expect(q({ coverage80: 0.75 }).parts.calibration).toBeCloseTo(50, 9)
    expect(q({ coverage80: 0.91 }).parts.calibration).toBe(0)
    expect(q({ coverage80: Number.NaN }).parts.calibration).toBe(0)
    expect(q({ disagreement: 0.15 }).parts.agreement).toBeCloseTo(50, 9)
    expect(q({ disagreement: QUALITY_LINES.agreementNone }).parts.agreement).toBe(0)
    expect(q({ ageSec: 60 }).parts.freshness).toBe(100)
    expect(q({ ageSec: 180 }).parts.freshness).toBeCloseTo(50, 9)
    expect(q({ ageSec: 300 }).parts.freshness).toBe(0)
  })

  it('reads a story by its impact and novelty, halved without a library, and as nothing against the forecast\'s way', () => {
    const story = { impact: 80, novelty: 1, fromLibrary: true, shiftPct: 1 }
    expect(q().parts.news).toBeNull()
    expect(q({ news: story }).parts.news).toBeCloseTo(80, 9)
    expect(q({ news: { ...story, novelty: 0.5 } }).parts.news).toBeCloseTo(40, 9)
    expect(q({ news: { ...story, fromLibrary: false } }).parts.news).toBeCloseTo(40, 9)
    expect(q({ news: { ...story, shiftPct: -1 } }).parts.news).toBe(0)
    // Without a skilful direction there is no way for it to go against.
    expect(q({ directionSkill: null, news: { ...story, shiftPct: -1 } }).parts.news).toBeCloseTo(80, 9)
  })

  it('reads the market\'s confirmation of the way it leans, and none where it leans no skilful way', () => {
    expect(q().parts.confirmation).toBeCloseTo(50, 9)
    expect(q({ market: { z1h: 1, breadth1h: 1 } }).parts.confirmation).toBeCloseTo(50 + 30 * Math.tanh(1) + 20, 9)
    expect(q({ pUp: 0.35, market: { z1h: 1, breadth1h: 1 } }).parts.confirmation).toBeCloseTo(50 - 30 * Math.tanh(1) - 20, 9)
    expect(q({ directionSkill: null }).parts.confirmation).toBeNull()
    expect(q({ market: null }).parts.confirmation).toBeNull()
  })

  it('is the weighted mean of what can be read, and under 75 without a skilful direction', () => {
    const all = q({ news: { impact: 100, novelty: 1, fromLibrary: true, shiftPct: 1 }, market: { z1h: 10, breadth1h: 1 } })
    expect(all.score).toBe(100)
    // Without a story and with a neutral market, the news is left out of the mean.
    const parts = q().parts
    const w = QUALITY_LINES.weights
    const expected = (w.direction * parts.direction + w.range * parts.range + w.calibration * parts.calibration + w.confirmation * parts.confirmation! + w.agreement * parts.agreement + w.freshness * parts.freshness) / (w.direction + w.range + w.calibration + w.confirmation + w.agreement + w.freshness)
    expect(q().score).toBe(Math.round(expected))
    expect(q({ directionSkill: null }).score).toBeLessThan(75)
  })
})

describe('the edge', () => {
  it('costs a round trip of fee and slippage both ways, and the spread crossed', () => {
    expect(ROUND_TRIP_PCT).toBeCloseTo(0.24, 12)
    expect(roundTripCostPct(null)).toBeCloseTo(0.24, 12)
    expect(roundTripCostPct(0.05)).toBeCloseTo(0.29, 12)
    expect(roundTripCostPct(-1)).toBeCloseTo(0.24, 12)
  })

  it('expects the move by three tenths of each tail and four of the median, and clears the cost on its side', () => {
    const q = [-1, 0.5, 2, 3.5, 5]
    const buy = edgeOf(q, 'BUY', null)
    expect(buy.expectedPct).toBeCloseTo(0.3 * -1 + 0.4 * 2 + 0.3 * 5, 12)
    expect(buy.edgePct).toBeCloseTo(buy.expectedPct - 0.24, 12)
    // The cost, 0.24%, lies between P10 (-1%) and P25 (+0.5%): the share below it is read straight between.
    expect(buy.pProfit).toBeCloseTo(1 - (0.1 + (0.15 * 1.24) / 1.5), 9)
    const sell = edgeOf(q, 'SELL', 0.1)
    expect(sell.costPct).toBeCloseTo(0.34, 12)
    expect(sell.edgePct).toBeCloseTo(-sell.expectedPct - 0.34, 12)
    expect(sell.pProfit).toBeLessThan(0.2)
  })
})

function range(patch: Partial<ForecastRange> = {}): ForecastRange {
  const quantilesPct = [-1, 0.5, 2, 3.5, 5]
  return {
    lowPct: 0.5,
    highPct: 3.5,
    lowerPrice: 100.5,
    upperPrice: 103.5,
    medianPct: 2,
    confidenceLevel: 50,
    quantilesPct,
    quantilePrices: quantilesPct.map((pct) => 100 * (1 + pct / 100)),
    bearPct: -1,
    bullPct: 5,
    pUp: 0.7,
    pUpMapped: 0.7,
    direction: 'BULLISH',
    strong: false,
    uncertain: false,
    confidence: 70,
    reliability: 'HIGH',
    reliabilityReasons: ['tested on 5000 outcomes'],
    quality: { score: 80, parts: { direction: 100, range: 80, calibration: 90, news: null, confirmation: 70, agreement: 100, freshness: 100 } },
    width80Pct: 6,
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
    ...patch
  }
}

function prediction(pair: string, hour: ForecastRange, patch: Partial<PricePrediction> = {}): PricePrediction {
  return {
    pair,
    generatedAt: T * 1000 + 5000,
    direction: hour.direction,
    horizons: { hour1: hour },
    currentPrice: 100,
    confidence: hour.confidence,
    reliability: hour.reliability,
    invalidationConditions: [],
    modelVersion: 'models-v1 run-x',
    id: `${pair}:${T}`,
    strong: false,
    uncertain: hour.uncertain,
    bestHorizon: 'hour1',
    pairClass: 'mid',
    regime: 'sideways',
    barTime: T,
    versions: { prediction: 'prediction-v1', models: 'models-v1', features: 'features-v1', ensemble: 'ensemble-v1', calibration: 'calibration-v1', runCalibration: 'run-calibration-v2', news: 'news-effect-v1', quality: 'quality-v1', run: 'run-x', foldsRun: 'run-y' },
    ...patch
  }
}

const story = (shiftPct: number): NewsEffect => ({ variant: 'v4', storyId: 's', title: 'A story', source: 'CoinDesk', kind: 'LISTING', impact: 80, ageSec: 60, novelty: 1, pricedIn: false, fromLibrary: true, shiftPct, widenPct: 0.5, widenShare: 0 })

describe('the ranking', () => {
  const ranked = (hour: ForecastRange, patch: Partial<PricePrediction> = {}, volume: number | null = 1e8, execution: number | null = null) => {
    const p = prediction('SOLUSDT', hour, patch)
    return rankOf({ prediction: p, horizon: 'hour1', edge: hour.direction === 'NEUTRAL' ? null : edgeOf(hour.quantilesPct, hour.direction === 'BULLISH' ? 'BUY' : 'SELL', null), quoteVolume24h: volume, execution })
  }

  it('multiplies the edge, the reliability, the news, the liquidity and the execution, less uncertainty, risk and cost', () => {
    const plain = ranked(range())
    const edge = Math.min(1, edgeOf(range().quantilesPct, 'BUY', null).edgePct / RANK_LINES.edgeFullPct)
    const liquidity = Math.log10(1e8 / 1e6) / Math.log10(1e3)
    const uncertainty = RANK_LINES.uncertaintyMax * ((6 / 4 - 1) / 2)
    expect(plain.parts).toMatchObject({ edge, reliability: 1, news: 1, liquidity, execution: RANK_LINES.executionUnknown, marketRisk: 0 })
    expect(plain.parts.uncertainty).toBeCloseTo(uncertainty, 9)
    expect(plain.parts.cost).toBeCloseTo(RANK_LINES.costPerRoundTrip, 9)
    expect(plain.score).toBeCloseTo(100 * edge * liquidity * RANK_LINES.executionUnknown - uncertainty - RANK_LINES.costPerRoundTrip, 9)
    // An edge under the full line counts by how far it clears its costs, not by the move before them.
    const small = edgeOf([-1, -0.2, 0.6, 1.4, 2.2], 'BUY', null)
    expect(ranked(range({ quantilesPct: [-1, -0.2, 0.6, 1.4, 2.2] })).parts.edge).toBeCloseTo(small.edgePct / RANK_LINES.edgeFullPct, 9)
    expect(small.edgePct).toBeLessThan(small.expectedPct)
    expect(ranked(range({ reliability: 'MEDIUM' })).parts.reliability).toBe(0.7)
    expect(ranked(range({ reliability: 'LOW' })).parts.reliability).toBe(0.4)
    expect(ranked(range({ news: { v3: null, v4: story(1) } })).parts.news).toBe(RANK_LINES.news.aligned)
    expect(ranked(range({ news: { v3: null, v4: story(-1) } })).parts.news).toBe(RANK_LINES.news.against)
    expect(ranked(range(), {}, 1e9).parts.liquidity).toBe(1)
    expect(ranked(range(), {}, 1e5).parts.liquidity).toBe(RANK_LINES.liquidity.floor)
    expect(ranked(range(), {}, null).parts.liquidity).toBe(RANK_LINES.liquidity.floor)
    expect(ranked(range(), {}, 1e8, 50).parts.execution).toBe(0.5)
    expect(ranked(range(), { regime: 'panic' }).parts.marketRisk).toBe(RANK_LINES.panic)
    expect(ranked(range(), { regime: 'high-vol' }).parts.marketRisk).toBe(RANK_LINES.highVol)
    expect(ranked(range({ width80Pct: 4 })).parts.uncertainty).toBe(0)
    expect(ranked(range({ width80Pct: 20 })).parts.uncertainty).toBe(RANK_LINES.uncertaintyMax)
    expect(ranked(range({ direction: 'NEUTRAL' })).score).toBe(0)
  })

  it('puts a coin up 7% whose forecast clears its costs above one up 25% with a flat forecast (§33)', () => {
    // Coin A: +25% today, its forecast -1% ~ +1%. Coin B: +7%, volume up threefold, strong news, its
    // forecast +2% ~ +6%.
    const flat = range({ quantilesPct: [-1.6, -1, 0, 1, 1.6], direction: 'NEUTRAL', pUp: 0.5, quality: { score: 70, parts: { direction: 0, range: 90, calibration: 90, news: null, confirmation: null, agreement: 100, freshness: 100 } } })
    const strong = range({ quantilesPct: [0.8, 2, 4, 6, 7.2], news: { v3: null, v4: story(1.5) } })
    const a = rankOf({ prediction: prediction('AUSDT', flat), horizon: 'hour1', edge: null, quoteVolume24h: 3e8, execution: null })
    const b = rankOf({ prediction: prediction('BUSDT', strong), horizon: 'hour1', edge: edgeOf(strong.quantilesPct, 'BUY', null), quoteVolume24h: 6e7, execution: null })
    expect(funnel([a, b]).ranked.map((entry) => entry.pair)).toEqual(['BUSDT', 'AUSDT'])
  })

  it('goes, without an edge, by quality and then volume; and keeps the first ten and three', () => {
    const neutral = (pair: string, quality: number, volume: number) =>
      rankOf({ prediction: prediction(pair, range({ direction: 'NEUTRAL', quality: { score: quality, parts: range().quality.parts } })), horizon: 'hour1', edge: null, quoteVolume24h: volume, execution: null })
    const list = funnel([neutral('X1USDT', 50, 1e8), neutral('X2USDT', 60, 1e7), neutral('X3USDT', 50, 1e9)])
    expect(list.ranked.map((entry) => entry.pair)).toEqual(['X2USDT', 'X3USDT', 'X1USDT'])
    const many = funnel(Array.from({ length: 14 }, (_, k) => neutral(`P${k}USDT`, k, 1e8)))
    expect(many.top10).toHaveLength(RANK_LINES.top)
    expect(many.top3.map((entry) => entry.pair)).toEqual(['P13USDT', 'P12USDT', 'P11USDT'])
  })
})

describe('the trade decision', () => {
  const live = { price: 100, updatedAt: T * 1000 + 4000, spreadPct: 0.02 }
  const decide = (hour: ForecastRange, patch: Partial<DecisionInput> = {}, predictionPatch: Partial<PricePrediction> = {}) =>
    decideTrade({ prediction: prediction('SOLUSDT', hour, predictionPatch), horizon: 'hour1', nowMs: T * 1000 + 5000, live, classOf: null, ...patch })
  const codes = (decision: ReturnType<typeof decideTrade>): string[] => decision.reasons.map((reason) => reason.code)

  it('is TRADE where nothing holds it back, a BUY for a bull and a SELL for a bear', () => {
    const buy = decide(range())
    expect(buy).toMatchObject({ decision: 'TRADE', side: 'BUY', reasons: [], quality: 80 })
    expect(buy.edge!.edgePct).toBeGreaterThan(0)
    const bear = range({ direction: 'BEARISH', quantilesPct: [-5, -3.5, -2, -0.5, 1] })
    expect(decide(bear)).toMatchObject({ decision: 'TRADE', side: 'SELL' })
  })

  it('costs a trade at the cheaper venue where its books are held, and keeps the round trip on the decision (V7.2-R Stage 4)', () => {
    const trip = { venue: 'bitget' as const, feePct: 0.1, spreadPct: 0.02, impactPct: 0.03, totalPct: 0.25, basis: 'book' as const }
    const made = decide(range(), { costOf: (side) => (side === 'BUY' ? trip : null) })
    expect(made.edge!.costPct).toBe(0.25)
    expect(made.cost).toEqual(trip)
    // Where no venue's book is held: the flat round trip and the live spread, and no cost on the decision.
    const flat = decide(range())
    expect(flat.cost).toBeUndefined()
    expect(flat.edge!.costPct).toBeCloseTo(roundTripCostPct(0.02), 12)
    // No way called: no side, so nothing is costed.
    expect(decide(range({ direction: 'NEUTRAL' }), { costOf: () => trip }).cost).toBeUndefined()
    // Made again on a book read since: the round trip as the pass read it.
    const book: LiveBook = { symbol: 'SOLUSDT', bid: 99.99, ask: 100.01, bidQty: 50, askQty: 50, updatedAt: T * 1000 + 6000, source: 'stream' }
    expect(decideOnBook(made, prediction('SOLUSDT', range()), book, T * 1000 + 7000).cost).toEqual(trip)
  })

  it('is costed by the pass at the venue its sources name for the pair and the side (V7.2-R Stage 4)', () => {
    const trip = { venue: 'bitget' as const, feePct: 0.1, spreadPct: 0.02, impactPct: 0.03, totalPct: 0.25, basis: 'book' as const }
    const sources = { book: (): undefined => undefined, classVerdict: (): null => null, venueCost: (pair: string, side: 'BUY' | 'SELL') => (pair === 'SOLUSDT' && side === 'BUY' ? trip : null) }
    const made = decisionFor({ inputs: new Map(), driftOutcomes: new Map() }, sources, prediction('SOLUSDT', range()), T * 1000 + 5000)
    expect(made.cost).toEqual(trip)
    expect(made.edge!.costPct).toBe(0.25)
    expect(decisionFor({ inputs: new Map(), driftOutcomes: new Map() }, { ...sources, venueCost: undefined }, prediction('SOLUSDT', range()), T * 1000 + 5000).cost).toBeUndefined()
  })

  it('is NO TRADE where the likely move is under the line of a move worth its costs: 1% up to four hours, 2% at a day', () => {
    expect(OPPORTUNITY_LINES.minMovePct).toEqual({ minutes5: 1, minutes15: 1, hour1: 1, hours4: 1, hours24: 2 })
    // A buy's likely move is its P75; a sell's, its P25 as a fall.
    expect(likelyMovePct([-1, 0.5, 2, 3.5, 5], 'BUY')).toBe(3.5)
    expect(likelyMovePct([-5, -3.5, -2, -0.5, 1], 'SELL')).toBe(3.5)
    const at = (p75: number, horizon: 'hour1' | 'hours24' = 'hour1'): string[] => {
      const levels = range({ quantilesPct: [-2, 0.4, p75 - 0.3, p75, p75 + 3] })
      const made = prediction('SOLUSDT', levels)
      return codes(decideTrade({ prediction: { ...made, horizons: { [horizon]: levels } }, horizon, nowMs: T * 1000 + 5000, live, classOf: null }))
    }
    expect(at(0.99)).toContain('MOVE_UNDER_LINE')
    expect(at(1)).not.toContain('MOVE_UNDER_LINE')
    expect(at(1.5, 'hours24')).toContain('MOVE_UNDER_LINE')
    expect(at(2, 'hours24')).not.toContain('MOVE_UNDER_LINE')
    // A sell's line is read on its own side.
    const sell = decide(range({ direction: 'BEARISH', quantilesPct: [-3, -0.9, -0.5, 0.2, 1] }))
    expect(codes(sell)).toContain('MOVE_UNDER_LINE')
    const reason = sell.reasons.find((entry) => entry.code === 'MOVE_UNDER_LINE')!
    expect(reason.values).toEqual({ movePct: 0.9, linePct: 1 })
    expect(reasonText(reason, 'hour1')).toBe('Its likely move (0.90%) is under the 1% a 1-hour trade needs: no move worth its costs is forecast now.')
  })

  it('is NO TRADE for each thing that holds it back, saying each', () => {
    expect(codes(decide(range({ direction: 'NEUTRAL' })))).toEqual(['NO_CALL'])
    // One reason is enough to be NO TRADE.
    expect(decide(range({ reliability: 'LOW' })).decision).toBe('NO_TRADE')
    expect(decide(range(), { classOf: () => ({ key: 'mid/hour1/other', verdict: 'NOT_ENOUGH' }) }).decision).toBe('NO_TRADE')
    expect(codes(decide(range({ uncertain: true })))).toEqual(['UNCERTAIN'])
    // A likely move of 0.6% is under the hour's 1% too.
    expect(codes(decide(range({ quantilesPct: [-1, -0.5, 0.2, 0.6, 1] })))).toEqual(['MOVE_UNDER_LINE', 'EDGE_UNDER_COSTS'])
    expect(codes(decide(range({ quantilesPct: [-4, -1, 0.1, 2, 6] })))).toEqual(['UNLIKELY_PROFIT'])
    expect(codes(decide(range(), {}, { regime: 'bear' }))).toEqual(['REGIME_AGAINST'])
    expect(codes(decide(range(), {}, { regime: 'panic' }))).toEqual(['REGIME_AGAINST'])
    expect(codes(decide(range({ direction: 'BEARISH', quantilesPct: [-5, -3.5, -2, -0.5, 1] }), {}, { regime: 'bull' }))).toEqual(['REGIME_AGAINST'])
    expect(codes(decide(range({ reliability: 'LOW' })))).toEqual(['RELIABILITY_LOW'])
    expect(codes(decide(range({ quality: { ...range().quality, score: DECISION_LINES.minQuality - 1 } })))).toEqual(['QUALITY_LOW'])
    expect(codes(decide(range(), { live: null }))).toEqual(['STALE_PRICE'])
    expect(codes(decide(range(), { live: { ...live, updatedAt: T * 1000 - 10_000 } }))).toEqual(['STALE_PRICE'])
    expect(codes(decide(range(), { live: { ...live, spreadPct: DECISION_LINES.maxSpreadPct + 0.01 } }))).toEqual(['SPREAD'])
    expect(codes(decide(range(), { nowMs: (T + DECISION_LINES.staleBarsSec + 1) * 1000, live: { ...live, updatedAt: (T + DECISION_LINES.staleBarsSec) * 1000 } }))).toEqual(['STALE_BARS'])
    // Its opportunity class (V6 Stage 12): traded where approved or on probation; not where it lost or
    // was not traded enough on the replayed weeks; not judged where no class is read.
    const judged = (verdict: 'APPROVED' | 'PROBATION' | 'DISABLED' | 'NOT_ENOUGH') => decide(range(), { classOf: (side: 'BUY' | 'SELL') => ({ key: `mid/hour1/${side}`, verdict }) })
    expect(codes(judged('DISABLED'))).toEqual(['CLASS_NOT_APPROVED'])
    expect(codes(judged('NOT_ENOUGH'))).toEqual(['CLASS_NOT_APPROVED'])
    expect(judged('NOT_ENOUGH').reasons[0].text).toBe('Its kind of opportunity (mid/hour1/BUY) has not been traded enough on the replayed weeks to be judged.')
    expect(codes(judged('APPROVED'))).toEqual([])
    expect(codes(judged('PROBATION'))).toEqual([])
    expect(judged('PROBATION')).toMatchObject({ classKey: 'mid/hour1/BUY', classVerdict: 'PROBATION' })
    expect(decide(range(), { classOf: null })).toMatchObject({ classKey: null, classVerdict: null })
    // No way called: no class is read.
    expect(decide(range({ direction: 'NEUTRAL' }), { classOf: () => ({ key: 'x', verdict: 'DISABLED' }) }).classKey).toBeNull()
    // Several at once, every one said.
    expect(codes(decide(range({ direction: 'NEUTRAL', reliability: 'LOW' }), { live: null }))).toEqual(['NO_CALL', 'RELIABILITY_LOW', 'STALE_PRICE'])
    expect(decide(range({ uncertain: true })).reasons[0].text).toMatch(/does not know enough/)
    // The live drift gate (V7.1 Stage 13): the horizon's last day of outcomes missing, nothing is traded at it.
    const drifted = decide(range(), { drift: { outcomes: 60, coverage80: 0.5, drifted: true } })
    expect(codes(drifted)).toEqual(['ENGINE_DRIFT'])
    expect(drifted.reasons[0].text).toBe('The 1-hour forecasts of the last day held 50% of their 80% ranges, under 60%: the engine has drifted, and nothing is traded at this horizon.')
    expect(drifted.reasons[0].values).toEqual({ outcomes: 60, coverage80: 0.5 })
    expect(codes(decide(range(), { drift: { outcomes: 60, coverage80: 0.9, drifted: false } }))).toEqual([])
    expect(codes(decide(range(), { drift: null }))).toEqual([])
  })

  // Found by V6 Stage 16's 12-hour run: the pass decides on the books the stream holds, those of the
  // pairs on screen, so Home said "no live price" beside the live price it showed, and the forecast
  // trader could have traded no pair off screen.
  it('is made again on a book read after the pass, with its class as judged; without one it stands as made', () => {
    const judged = (verdict: 'PROBATION' | 'NOT_ENOUGH') => () => ({ key: 'large/hour1/other', verdict })
    const atPass = decide(range(), { live: null, classOf: judged('PROBATION') })
    expect(codes(atPass)).toEqual(['STALE_PRICE'])
    expect(heldBackByPrice(atPass)).toBe(true)
    const book: LiveBook = { symbol: 'SOLUSDT', bid: 99.99, bidQty: 10, ask: 100.01, askQty: 10, updatedAt: T * 1000 + 6000, source: 'rest' }
    const p = prediction('SOLUSDT', range())
    const nowMs = T * 1000 + 7000
    expect(decideOnBook(atPass, p, book, nowMs)).toMatchObject({ decision: 'TRADE', side: 'BUY', reasons: [], classKey: 'large/hour1/other', classVerdict: 'PROBATION', at: nowMs })
    // A book too old, or too wide, holds it back again; the spread is the book's.
    expect(codes(decideOnBook(atPass, p, { ...book, updatedAt: nowMs - 10_001 }, nowMs))).toEqual(['STALE_PRICE'])
    expect(codes(decideOnBook(atPass, p, { ...book, bid: 99.8, ask: 100.2 }, nowMs))).toEqual(['SPREAD'])
    expect(heldBackByPrice(decide(range(), { live: { ...live, spreadPct: DECISION_LINES.maxSpreadPct + 0.01 } }))).toBe(true)
    expect(liveOfBook(book)).toEqual({ price: 100, updatedAt: book.updatedAt, spreadPct: expect.closeTo(0.02, 9) })
    // Without a book, a one-sided one, or for another pair's forecast, it stands as made.
    expect(decideOnBook(atPass, p, null, nowMs)).toBe(atPass)
    expect(decideOnBook(atPass, p, undefined, nowMs)).toBe(atPass)
    expect(decideOnBook(atPass, p, { ...book, bid: 0 }, nowMs)).toBe(atPass)
    expect(decideOnBook(atPass, prediction('ETHUSDT', range()), book, nowMs)).toBe(atPass)
    // Its class as judged at the pass: one that had not earned it still has not, and is not held back
    // by the price alone.
    const unearned = decide(range(), { live: null, classOf: judged('NOT_ENOUGH') })
    expect(heldBackByPrice(unearned)).toBe(false)
    expect(codes(decideOnBook(unearned, p, book, nowMs))).toEqual(['CLASS_NOT_APPROVED'])
    // Not judged at the pass: not judged now.
    expect(decideOnBook(decide(range(), { live: null }), p, book, nowMs)).toMatchObject({ decision: 'TRADE', classKey: null, classVerdict: null })
    // The drift gate as the pass read it (V7.1 Stage 13) stands on a book read since; a decision made without
    // the gate closed stays open.
    const drifted = decide(range(), { live: null, drift: { outcomes: 60, coverage80: 0.5, drifted: true } })
    expect(codes(drifted)).toEqual(['STALE_PRICE', 'ENGINE_DRIFT'])
    expect(heldBackByPrice(drifted)).toBe(false)
    const onBook = decideOnBook(drifted, p, book, nowMs)
    expect(codes(onBook)).toEqual(['ENGINE_DRIFT'])
    expect(onBook.reasons[0].values).toEqual({ outcomes: 60, coverage80: 0.5 })
    expect(codes(decideOnBook(decide(range(), { live: null, drift: { outcomes: 60, coverage80: 0.9, drifted: false } }), p, book, nowMs))).toEqual([])
    // No way called is no call, whatever the price; and a TRADE is not held back.
    const neutral = decide(range({ direction: 'NEUTRAL' }), { live: null })
    expect(heldBackByPrice(neutral)).toBe(false)
    expect(codes(decideOnBook(neutral, prediction('SOLUSDT', range({ direction: 'NEUTRAL' })), book, nowMs))).toEqual(['NO_CALL'])
    expect(heldBackByPrice(decide(range()))).toBe(false)
  })
})
