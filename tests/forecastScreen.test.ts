import { describe, expect, it } from 'vitest'
import { FEATURE_COUNT, FEATURE_NAMES, PRICE_FEATURES } from '../shared/forecast/features'
import { binMatrix, fitCuts, rngOf } from '../shared/forecast/ml/bins'
import { fitGbt, gbtContributions, predictGbt } from '../shared/forecast/ml/gbt'
import { CHANGE_LINES, predictionChangedNotice, stepCall, type CallTrack } from '../shared/forecast/predictionChange'
import type { ForecastRange, PricePrediction } from '../shared/forecast/prediction'
import type { ForecastRanking, RankedForecast } from '../shared/forecast/ranking'
import { describeFeature, rangeDriversFor, rangeDriversOf } from '../shared/forecast/rangeDrivers'
import type { TradeDecision } from '../shared/forecast/tradeDecision'
import { forecastView } from '../shared/forecast/view'
import type { ForecastState } from '../shared/ipc'
import {
  aiConsensusWord,
  callLabel,
  decisionWords,
  forecastStatusText,
  leadHorizon,
  momentumWord,
  newsWord,
  predictionCardRows,
  rangeText,
  signedPct,
  timeLeftText,
  volumeWord
} from '../src/forecast/forecastWords'
import { NO_FILTERS, predictionRows, rowDecision } from '../src/forecast/predictionRows'
import { emptyLiveState } from '../shared/liveMarket'

// THE FORECAST ON SCREEN (src/forecast/, shared/forecast/{predictionChange,rangeDrivers}.ts; the V6
// document, §3, §34-37, §70-71 and §118): the words a forecast reads in, the best prediction's card row
// by row, the Predictions table's filters, when a watched coin's turned call is told, and what moved
// the boosted model's reading of a range's size.

const T = Date.parse('2026-10-13T15:00:00Z') / 1000

function range(patch: Partial<ForecastRange> = {}): ForecastRange {
  const quantilesPct = [-2, -1, 0.5, 2, 3]
  return {
    lowPct: -1,
    highPct: 2,
    lowerPrice: 178.2,
    upperPrice: 183.6,
    medianPct: 0.5,
    confidenceLevel: 50,
    quantilesPct,
    quantilePrices: quantilesPct.map((pct) => 180 * (1 + pct / 100)),
    bearPct: -2,
    bullPct: 3,
    pUp: 0.55,
    pUpMapped: 0.55,
    direction: 'NEUTRAL',
    strong: false,
    uncertain: false,
    confidence: 55,
    reliability: 'HIGH',
    reliabilityReasons: [],
    quality: { score: 55, parts: { direction: 0, range: 80, calibration: 90, news: null, confirmation: null, agreement: 100, freshness: 100 } },
    width80Pct: 5,
    usualWidth80Pct: 4,
    skill: 0.01,
    directionSkill: -0.01,
    ownClass: true,
    expiresAt: (T + 3600) * 1000,
    contributions: [
      { model: 'gbt', weight: 0.6, medianLogPct: 0.5 },
      { model: 'technical', weight: 0.4, medianLogPct: 0.2 }
    ],
    calibrationShiftLogPct: 0,
    newsShiftLogPct: 0,
    news: { v3: null, v4: null },
    spreadStretch: 1,
    variants: {},
    rangeDrivers: [],
    ...patch
  }
}

/** A range's levels from its five quantiles, in percent from the close at 180. */
function levels(quantilesPct: number[]): Partial<ForecastRange> {
  const prices = quantilesPct.map((pct) => 180 * (1 + pct / 100))
  return { quantilesPct, quantilePrices: prices, lowPct: quantilesPct[1], highPct: quantilesPct[3], lowerPrice: prices[1], upperPrice: prices[3], medianPct: quantilesPct[2], bearPct: quantilesPct[0], bullPct: quantilesPct[4] }
}

function prediction(pair: string, patch: Partial<PricePrediction> = {}, hour: Partial<ForecastRange> = {}): PricePrediction {
  return {
    pair,
    generatedAt: T * 1000 + 7000,
    direction: 'NEUTRAL',
    horizons: {
      minutes15: range({ ...levels([-1, -0.5, 0.1, 0.7, 1.2]), expiresAt: (T + 900) * 1000 }),
      hour1: range(hour),
      hours4: range({ ...levels([-3, -2, 0.5, 3, 4]), expiresAt: (T + 14_400) * 1000 })
    },
    currentPrice: 180,
    confidence: 55,
    reliability: 'HIGH',
    invalidationConditions: [],
    modelVersion: 'models-v1 run-x',
    id: `${pair}:${T}`,
    strong: false,
    uncertain: false,
    bestHorizon: 'hour1',
    pairClass: 'large',
    regime: 'sideways',
    barTime: T,
    market: { z1h: 1.4, breadth1h: 0.6, volRatio1h: 3.7 },
    versions: { prediction: 'prediction-v1', models: 'models-v1', features: 'features-v1', ensemble: 'ensemble-v1', calibration: 'calibration-v1', runCalibration: 'run-calibration-v2', news: 'news-effect-v1', quality: 'quality-v1', run: 'run-x', foldsRun: 'run-y' },
    ...patch
  }
}

function decision(pair: string, patch: Partial<TradeDecision> = {}): TradeDecision {
  return { version: 'decision-v1', pair, horizon: 'hour1', side: null, decision: 'NO_TRADE', reasons: [{ code: 'NO_CALL', text: 'The forecast calls no way.' }], edge: null, quality: 55, at: T * 1000, ...patch }
}

describe('the words a forecast reads in', () => {
  it('says a call, a move, a range and the time left as the card shows them', () => {
    expect(callLabel({ direction: 'NEUTRAL', strong: false, uncertain: true })).toBe('NEUTRAL / UNCERTAIN')
    expect(callLabel({ direction: 'BULLISH', strong: true, uncertain: false })).toBe('STRONG BULLISH')
    expect(callLabel({ direction: 'BEARISH', strong: false, uncertain: false })).toBe('BEARISH')
    // No sign on a move that rounds to nothing: Intl's rule, the same in every language (V6 Stage 14).
    expect([0.8, -1.2, 0, -0.001, Number.NaN].map((value) => signedPct(value))).toEqual(['+0.80%', '-1.20%', '0.00%', '0.00%', '—'])
    expect(rangeText(0.8, 2.1)).toBe('+0.80% ~ +2.10%')
    expect([0, -5, 59_001, 3_540_001, 3_600_000, 36_000_000].map((ms) => timeLeftText(ms))).toEqual(['FORECAST EXPIRED', 'FORECAST EXPIRED', 'valid 1 min', 'valid 1.0 h', 'valid 1.0 h', 'valid 10 h'])
  })

  it('reads momentum in usual moves and volume against the usual hour, at fixed lines', () => {
    expect([2, 1.99, 1, 0.99, -0.99, -1, -1.99, -2, null, Number.NaN].map((z) => momentumWord(z))).toEqual(['STRONG UP', 'UP', 'UP', 'FLAT', 'FLAT', 'DOWN', 'DOWN', 'STRONG DOWN', '—', '—'])
    expect(volumeWord(3.74)).toBe('3.7× its usual hour')
    expect(volumeWord(null)).toBe('—')
  })

  it('weighs the story moving it at 70 and 40', () => {
    expect(newsWord({})).toBe('none')
    expect(newsWord({ mainCatalyst: 'A listing', newsImpact: 70 })).toBe('HIGH IMPACT · A listing')
    expect(newsWord({ mainCatalyst: 'A listing', newsImpact: 69 })).toBe('MODERATE IMPACT · A listing')
    expect(newsWord({ mainCatalyst: 'A listing', newsImpact: 40 })).toBe('MODERATE IMPACT · A listing')
    expect(newsWord({ mainCatalyst: 'A listing', newsImpact: 39 })).toBe('LOW IMPACT · A listing')
  })

  it('says the decision, a SELL as paper only, and every reason against a trade', () => {
    expect(decisionWords(null)).toEqual({ label: 'NO DECISION YET', detail: '', trade: false })
    expect(decisionWords(decision('SOLUSDT', { decision: 'TRADE', side: 'BUY', reasons: [] }))).toEqual({ label: 'TRADE: BUY', detail: '', trade: true })
    expect(decisionWords(decision('SOLUSDT', { decision: 'TRADE', side: 'SELL', reasons: [] })).detail).toBe('A sell is a paper trade only.')
    const no = decisionWords(decision('SOLUSDT', { reasons: [{ code: 'NO_CALL', text: 'No way called.' }, { code: 'STALE_PRICE', text: 'No live price.' }] }))
    expect(no).toEqual({ label: 'NO TRADE', detail: 'No way called. No live price.', trade: false })
  })

  it('counts the models the watch asked, a split as a split', () => {
    expect(aiConsensusWord([])).toBeNull()
    expect(aiConsensusWord(['long', 'long', 'short'])).toBe('2 / 3 bullish')
    expect(aiConsensusWord(['short', 'short', null])).toBe('2 / 3 bearish')
    expect(aiConsensusWord(['long', 'short', null])).toBe('split: 1 bullish, 1 bearish of 3')
    expect(aiConsensusWord([null, null])).toBe('0 / 2: no trade')
  })

  it('leads with the best horizon, else the hour, else the first there is', () => {
    expect(leadHorizon(prediction('SOLUSDT', { bestHorizon: 'hours4' }))).toBe('hours4')
    expect(leadHorizon(prediction('SOLUSDT', { bestHorizon: null }))).toBe('hour1')
    expect(leadHorizon(prediction('SOLUSDT', { bestHorizon: null, horizons: { hours24: range() } }))).toBe('hours24')
    expect(leadHorizon(prediction('SOLUSDT', { bestHorizon: null, horizons: {} }))).toBeNull()
  })
})

describe('the best prediction card (§3, §118)', () => {
  it('has every field, the percentages from the live price where there is one', () => {
    const sol = prediction('SOLUSDT', { mainCatalyst: 'Exchange lists SOL perpetuals', newsImpact: 82 })
    const fromClose = predictionCardRows(sol, forecastView(sol, null, T * 1000 + 600_000), '3 / 3 bullish')
    const shown = (rows: { name: string; value: string }[]): { name: string; value: string }[] => rows.map(({ name, value }) => ({ name, value }))
    expect(shown(fromClose.left)).toEqual([
      { name: 'Current', value: '$180 (last close)' },
      { name: 'Next 15 min', value: '-0.50% ~ +0.70%' },
      { name: 'Next 1 hour', value: '-1.00% ~ +2.00%' },
      { name: 'Next 4 hours', value: '-2.00% ~ +3.00%' },
      { name: 'Bull case', value: '+3.00%' },
      { name: 'Bear case', value: '-2.00%' }
    ])
    expect(shown(fromClose.right)).toEqual([
      { name: 'Forecast quality', value: '55 / 100' },
      { name: 'Reliability', value: 'HIGH' },
      { name: 'Best horizon', value: '1 hour' },
      { name: 'News catalyst', value: 'HIGH IMPACT · Exchange lists SOL perpetuals' },
      { name: 'Volume', value: '3.7× its usual hour' },
      { name: 'Momentum', value: 'UP' },
      { name: 'AI consensus', value: '3 / 3 bullish' }
    ])
    // From a live $183.60 the same levels read lower (§41); the 15 minutes past its close have expired.
    const live = predictionCardRows(sol, forecastView(sol, 183.6, (T + 1200) * 1000), null)
    expect(shown(live.left)[0]).toEqual({ name: 'Current', value: '$183.6' })
    expect(live.left[1].value).toBe('-2.45% ~ -1.27% (expired)')
    expect(live.left[2].value).toBe('-2.94% ~ 0.00%')
    expect(shown(live.right)[6]).toEqual({ name: 'AI consensus', value: 'not asked' })
    // No best horizon: the hour leads, and says none beat a plain range.
    expect(predictionCardRows(prediction('SOLUSDT', { bestHorizon: null }), forecastView(sol, null, T * 1000), null).right[2].value).toBe('none beat a plain range')
  })
})

describe('the Predictions table', () => {
  const pairs = ['BTCUSDT', 'SOLUSDT', 'PEPEUSDT', 'XRPUSDT']
  const predictions = new Map<string, PricePrediction>([
    ['BTCUSDT', prediction('BTCUSDT', { pairClass: 'btc' })],
    ['SOLUSDT', prediction('SOLUSDT', { mainCatalyst: 'A listing', newsImpact: 80 }, { direction: 'BULLISH' })],
    ['PEPEUSDT', prediction('PEPEUSDT', { pairClass: 'high-vol' }, { direction: 'BEARISH' })],
    ['XRPUSDT', prediction('XRPUSDT', { horizons: { hour1: range() } })]
  ])
  const ranked: RankedForecast[] = pairs.map((pair, index) => ({
    pair,
    horizon: 'hour1',
    score: 10 - index,
    quality: 55,
    quoteVolume24h: 1e8,
    parts: { edge: 0, reliability: 1, news: 1, liquidity: 1, execution: 1, uncertainty: 0, marketRisk: 0, cost: 5 },
    decision:
      pair === 'SOLUSDT'
        ? decision(pair, { decision: 'TRADE', side: 'BUY', reasons: [] })
        : // A call the pass held back by the live price alone (V6 Stage 16): tradable on a live price.
          pair === 'PEPEUSDT'
          ? decision(pair, { side: 'SELL', reasons: [{ code: 'STALE_PRICE', text: 'There is no live price newer than ten seconds.' }] })
          : // And one held back by more.
            pair === 'XRPUSDT'
            ? decision(pair, { side: 'BUY', reasons: [{ code: 'QUALITY_LOW', text: 'Its quality is 55, under 60.' }, { code: 'STALE_PRICE', text: 'There is no live price newer than ten seconds.' }] })
            : decision(pair)
  }))
  // A pair ranked with no forecast in hand is left out.
  const ranking: ForecastRanking = { at: T, ranked: [...ranked, { ...ranked[0], pair: 'DOGEUSDT' }], top10: pairs, top3: pairs.slice(0, 3) }
  const shown = (filters: Partial<typeof NO_FILTERS>): string[] => predictionRows(ranking, predictions, { ...NO_FILTERS, ...filters }).map((row) => `${row.rank}:${row.ranked.pair}:${row.horizon}`)

  it('lists the ranking best first, each row keeping its place in the whole', () => {
    expect(shown({})).toEqual(['1:BTCUSDT:hour1', '2:SOLUSDT:hour1', '3:PEPEUSDT:hour1', '4:XRPUSDT:hour1'])
    expect(predictionRows(null, predictions, NO_FILTERS)).toEqual([])
  })

  it('filters by a pair typed any way, the call, the kind of coin, tradable and news', () => {
    expect(shown({ query: 'sol/usdt' })).toEqual(['2:SOLUSDT:hour1'])
    expect(shown({ query: ' pe ' })).toEqual(['3:PEPEUSDT:hour1'])
    expect(shown({ call: 'BEARISH' })).toEqual(['3:PEPEUSDT:hour1'])
    expect(shown({ call: 'NEUTRAL' })).toEqual(['1:BTCUSDT:hour1', '4:XRPUSDT:hour1'])
    expect(shown({ pairClass: 'high-vol' })).toEqual(['3:PEPEUSDT:hour1'])
    expect(shown({ tradeOnly: true })).toEqual(['2:SOLUSDT:hour1', '3:PEPEUSDT:hour1'])
    expect(shown({ newsOnly: true })).toEqual(['2:SOLUSDT:hour1'])
    expect(shown({ call: 'BULLISH', pairClass: 'btc' })).toEqual([])
  })

  it('decides a row again on the book the stream holds for its pair, and leaves one it holds none for as the pass made it', () => {
    const pepe = predictionRows(ranking, predictions, NO_FILTERS).find((row) => row.ranked.pair === 'PEPEUSDT')!
    const book = { symbol: 'PEPEUSDT', bid: 99.99, bidQty: 1, ask: 100.01, askQty: 1, updatedAt: T * 1000 + 1000, source: 'stream' as const }
    expect(rowDecision(pepe, null, T * 1000 + 2000)).toBe(pepe.ranked.decision)
    expect(rowDecision(pepe, { ...emptyLiveState(), books: { BTCUSDT: { ...book, symbol: 'BTCUSDT' } } }, T * 1000 + 2000)).toBe(pepe.ranked.decision)
    const decided = rowDecision(pepe, { ...emptyLiveState(), books: { PEPEUSDT: book } }, T * 1000 + 2000)
    expect(decided.at).toBe(T * 1000 + 2000)
    expect(decided.reasons.map((reason) => reason.code)).not.toContain('STALE_PRICE')
  })

  it('reads every pair at one horizon when one is chosen, leaving out a pair without it', () => {
    expect(shown({ horizon: 'hours4' })).toEqual(['1:BTCUSDT:hours4', '2:SOLUSDT:hours4', '3:PEPEUSDT:hours4'])
    // The call filter reads the chosen horizon's call: SOL is bullish at the hour, not at four.
    expect(shown({ horizon: 'hours4', call: 'BULLISH' })).toEqual([])
  })
})

describe('a watched coin whose call turns (§71)', () => {
  const at = (direction: ForecastRange['direction'], patch: Partial<PricePrediction> = {}, hour: Partial<ForecastRange> = {}): PricePrediction => prediction('SOLUSDT', patch, { direction, ...hour })
  const run = (passes: PricePrediction[], from?: CallTrack): { track: CallTrack; changes: string[] } => {
    let track = from
    const changes: string[] = []
    for (const pass of passes) {
      const step = stepCall(track, pass)
      track = step.track
      if (step.change !== null) changes.push(`${step.change.from.direction}>${step.change.to.direction}`)
    }
    return { track: track!, changes }
  }

  it('holds the first call it reads, and tells a turn to the other way once it has held two passes', () => {
    expect(CHANGE_LINES.holdPasses).toBe(2)
    expect(run([at('BULLISH')]).changes).toEqual([])
    expect(run([at('BULLISH'), at('BEARISH')]).changes).toEqual([])
    expect(run([at('BULLISH'), at('BEARISH'), at('BEARISH')]).changes).toEqual(['BULLISH>BEARISH'])
    expect(run([at('BEARISH'), at('BULLISH'), at('BULLISH'), at('BULLISH')]).changes).toEqual(['BEARISH>BULLISH'])
    // One close's wobble the other way and back is nothing.
    expect(run([at('BULLISH'), at('BEARISH'), at('BULLISH'), at('BEARISH')]).changes).toEqual([])
  })

  it('never tells a NEUTRAL, and starts the count over when one comes between', () => {
    expect(run([at('BULLISH'), at('NEUTRAL'), at('NEUTRAL')]).changes).toEqual([])
    // NEUTRAL held, then BEARISH held: neither is a turn from BULLISH to BEARISH.
    expect(run([at('BULLISH'), at('NEUTRAL'), at('NEUTRAL'), at('BEARISH'), at('BEARISH')]).changes).toEqual([])
    // A NEUTRAL between two BEARISH passes resets their count: two more are needed.
    expect(run([at('BULLISH'), at('BEARISH'), at('NEUTRAL'), at('BEARISH')]).changes).toEqual([])
    expect(run([at('BULLISH'), at('BEARISH'), at('NEUTRAL'), at('BEARISH'), at('BEARISH')]).changes).toEqual(['BULLISH>BEARISH'])
  })

  it('leaves the track as it was for a forecast with no best horizon', () => {
    const held = run([at('BULLISH')]).track
    expect(stepCall(held, at('BEARISH', { bestHorizon: null }))).toEqual({ track: held, change: null })
  })

  it('says why it turned: the model whose median moved most, the story now moving it, the regime', () => {
    const from = run([at('BULLISH')]).track
    const story = { variant: 'v4' as const, storyId: 's1', title: 'Exploit drains a bridge', source: 'CoinDesk', kind: 'EXPLOIT' as const, impact: 90, ageSec: 120, novelty: 1, pricedIn: false, fromLibrary: true, shiftPct: -1.2, widenPct: 0.4, widenShare: 0 }
    const turned = at(
      'BEARISH',
      { regime: 'bear' },
      {
        lowPct: -3,
        highPct: -0.5,
        contributions: [
          { model: 'gbt', weight: 0.6, medianLogPct: -1.3 },
          { model: 'technical', weight: 0.4, medianLogPct: 0.1 }
        ],
        news: { v3: null, v4: story }
      }
    )
    const step = stepCall(stepCall(from, turned).track, turned)
    expect(step.change?.reasons).toEqual(['the gbt model\'s median moved -1.80%', 'a exploit story: Exploit drains a bridge', 'the market turned from sideways to bear'])
    const notice = predictionChangedNotice(step.change!)
    expect(notice.title).toBe('PREDICTION CHANGED: SOL/USDT BULLISH → BEARISH')
    expect(notice.body).toBe(
      "Previous: -1.00% ~ +2.00% (1-hour). Current: -3.00% ~ -0.50% (1-hour). Reason: the gbt model's median moved -1.80%; a exploit story: Exploit drains a bridge; the market turned from sideways to bear. Nothing was placed or sold."
    )
    expect(notice.extra).toEqual({ kind: 'PREDICTION_CHANGED', severity: 'high', thread: 'prediction:SOLUSDT', threadSeconds: 3600 })
    // With nothing to name, it says the market moved.
    const plain = run([at('BULLISH'), at('BEARISH'), at('BEARISH')])
    expect(plain.changes).toEqual(['BULLISH>BEARISH'])
  })
})

describe('what moved the range (§36)', () => {
  // Rows of the forecast's 63 figures, a move's size driven by the hour's volatility and the volume.
  const RV1H = FEATURE_NAMES.indexOf('rv_1h')
  const VOL = FEATURE_NAMES.indexOf('vol_ratio_1h')
  const random = rngOf(7)
  const rows = 2000
  const data = new Float64Array(rows * FEATURE_COUNT)
  const y = new Float64Array(rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < FEATURE_COUNT; col++) data[row * FEATURE_COUNT + col] = random()
    y[row] = 2 * data[row * FEATURE_COUNT + RV1H] + data[row * FEATURE_COUNT + VOL] + 0.05 * random()
  }
  const matrix = { rows, cols: FEATURE_COUNT, data }
  const cuts = fitCuts(matrix)
  const binned = binMatrix(matrix, cuts)
  const model = fitGbt(binned, y, binned, y, { kind: 'l2' }, { trees: 40, learningRate: 0.2, maxDepth: 3, minLeafRows: 20, minLeafHessian: 1, lambda: 1, minGain: 0, featureFraction: 1, featureSampling: 'tree', subsample: 1, patience: 40, seed: 5 })

  it('names the three figures that moved its size most, by the trees\' own paths, which add up to the reading', () => {
    const row = Float64Array.from({ length: FEATURE_COUNT }, () => 0.5)
    row[RV1H] = 0.95
    row[VOL] = 0.05
    const { base, contributions } = gbtContributions(model, row)
    expect(base + contributions.reduce((sum, value) => sum + value, 0)).toBeCloseTo(predictGbt(model, row, 0), 10)
    const drivers = rangeDriversOf(model, row)
    expect(drivers).toHaveLength(3)
    expect(drivers.map((driver) => Math.abs(driver.effect))).toEqual([...drivers.map((driver) => Math.abs(driver.effect))].sort((a, b) => b - a))
    const largest = [...contributions].map(Math.abs).sort((a, b) => b - a).slice(0, 3)
    expect(drivers.map((driver) => Math.abs(driver.effect))).toEqual(largest)
    // A hot hour widened it; a thin hour's volume narrowed it.
    expect(drivers[0]).toMatchObject({ feature: 'rv_1h', value: 0.95 })
    expect(drivers[0].effect).toBeGreaterThan(0)
    expect(drivers[0].text).toBe("its last hour's volatility was 95.00%, which widened the range")
    expect(drivers[1]).toMatchObject({ feature: 'vol_ratio_1h' })
    expect(drivers[1].effect).toBeLessThan(0)
    expect(drivers[1].text).toBe('volume is 0.05× its usual hour, which narrowed it')
    expect(rangeDriversOf(model, row, 1)).toHaveLength(1)
    expect(drivers.every((driver) => driver.model === 'gbt')).toBe(true)
  })

  it('explains the boosted size model weighing more at the horizon, the price-only one on its own figures, and none where neither weighs', () => {
    // The price-only size model reads the PRICE figures alone, the first of the row: here the hour's move.
    const R1H = FEATURE_NAMES.indexOf('r_1h')
    const priceData = new Float64Array(rows * PRICE_FEATURES)
    const priceY = new Float64Array(rows)
    for (let k = 0; k < rows; k++) {
      for (let col = 0; col < PRICE_FEATURES; col++) priceData[k * PRICE_FEATURES + col] = data[k * FEATURE_COUNT + col]
      priceY[k] = 3 * priceData[k * PRICE_FEATURES + R1H] + 0.05 * random()
    }
    const priceMatrix = { rows, cols: PRICE_FEATURES, data: priceData }
    const priceBinned = binMatrix(priceMatrix, fitCuts(priceMatrix))
    const priceModel = fitGbt(priceBinned, priceY, priceBinned, priceY, { kind: 'l2' }, { trees: 30, learningRate: 0.2, maxDepth: 3, minLeafRows: 20, minLeafHessian: 1, lambda: 1, minGain: 0, featureFraction: 1, featureSampling: 'tree', subsample: 1, patience: 30, seed: 6 })
    const fitted = { gbt: { size: model }, gbtPrice: { size: priceModel } } as unknown as Parameters<typeof rangeDriversFor>[0]
    const row = Float64Array.from({ length: FEATURE_COUNT }, () => 0.5)
    row[R1H] = 0.9
    row[RV1H] = 0.95
    expect(rangeDriversFor(fitted, [{ model: 'gbt', weight: 0.6 }, { model: 'gbt-price', weight: 0.4 }], row).map((driver) => driver.model)).toEqual(['gbt', 'gbt', 'gbt'])
    // Even weights: the model on every figure.
    expect(rangeDriversFor(fitted, [{ model: 'gbt', weight: 0.5 }, { model: 'gbt-price', weight: 0.5 }], row)[0].model).toBe('gbt')
    const price = rangeDriversFor(fitted, [{ model: 'gbt-price', weight: 1 }], row)
    expect(price[0]).toMatchObject({ model: 'gbt-price', feature: 'r_1h' })
    expect(price.every((driver) => FEATURE_NAMES.indexOf(driver.feature as (typeof FEATURE_NAMES)[number]) < PRICE_FEATURES)).toBe(true)
    expect(rangeDriversFor(fitted, [{ model: 'persistence', weight: 0.7 }, { model: 'technical', weight: 0.3 }], row)).toEqual([])
    expect(rangeDriversFor(fitted, [], row)).toEqual([])
  })

  it('says each figure in its own units', () => {
    expect(describeFeature('r_1h', 0.0123)).toBe('the last hour moved +1.23%')
    expect(describeFeature('rv_1h', 0.0123)).toBe("its last hour's volatility was 1.23%")
    expect(describeFeature('atr_15m', 0.52)).toBe('its fifteen-minute true range is 0.52%')
    expect(describeFeature('taker_1h', 0.1)).toBe("buyers took 60% of the last hour's volume")
    expect(describeFeature('vol_acc_15m', Math.log(2))).toBe('volume in the last fifteen minutes is 2× the fifteen before')
    expect(describeFeature('z_1h', -2.04)).toBe('its last hour went down 2 times its usual move')
    expect(describeFeature('z_4h', 1.26)).toBe('its last four hours went up 1.3 times its usual move')
    expect(describeFeature('bb_width_1h', 0.034)).toBe('its hourly Bollinger band is 3.40% wide')
    expect(describeFeature('breadth_1h', 0.62)).toBe('62% of the coins rose in the last hour')
    expect(describeFeature('regime_panic', 1)).toBe('the market is in panic')
    expect(describeFeature('regime_high-vol', 0)).toBe('the market is not highly volatile')
    expect(describeFeature('class_mid', 0)).toBe('it is not a mid-sized coin')
    expect(describeFeature('class_btc', 1)).toBe('it is Bitcoin')
    expect(describeFeature('hour_sin', 0.3)).toBe('the time of day and week')
    expect(describeFeature('adx_1h', 31.4159)).toBe('its hourly trend strength (ADX) is 31')
    expect(describeFeature('acc_15m', -1.26)).toBe('its last fifteen minutes ran 1.3 usual moves below the fifteen before')
    expect(describeFeature('pos_24h', 0.873)).toBe("it stands at 87% of its day's range, from the low")
    expect(describeFeature('from_high_24h', -0.42)).toBe("it is 0.4 usual days' moves below its day's high")
    expect(describeFeature('ema200_1h', -1.04)).toBe("it is 1 usual days' moves below its 200-hour average")
    expect(describeFeature('alt_strength', -0.0649)).toBe("the other coins' median day ran -6.49% against Bitcoin's")
    expect(describeFeature('idio_1h', 0.004)).toBe("its own last hour, beyond what Bitcoin's explains, was +0.40%")
    expect(describeFeature('a_new_figure', 0.123456)).toBe('a new figure is 0.123')
  })

  it('has words for every figure the forecast reads', () => {
    // A figure without them would read as its code name to a person.
    for (const feature of FEATURE_NAMES) {
      const words = describeFeature(feature, 0.5)
      expect(words, feature).not.toBe(`${feature.replace(/_/g, ' ')} is 0.5`)
      expect(words, feature).not.toMatch(/_/)
    }
  })
})

describe("the forecast's status line", () => {
  const state = (engine: Partial<ForecastState['engine']>, training: Partial<ForecastState['training']> = {}, data: Partial<ForecastState['data']> = {}): ForecastState => ({
    engine: { status: 'running', waitingFor: null, lastPassAt: T, lastPassMs: 31, predictions: 34, recorded: 120, outcomes: 80, missing: 0, refreshes: 3, pending: 40, lastError: null, ...engine },
    training: { status: 'ready', current: null, calibratedRunId: null, progress: null, lastError: null, nextRefitAt: null, promotions: [], ...training },
    data: { version: 'data-v1', pairs: 34, ready: 34, requests: 0, weight: 0, failures: 0, barsWritten: 0, lastPassAt: null, lastError: null, rateLimitedUntil: null, refusedHost: null, monthsSwept: 0, ...data }
  })

  it('says what it forecasts and what it has on record, or what it waits for', () => {
    expect(forecastStatusText(null)).toBe('Reading the forecast…')
    expect(forecastStatusText(state({}))).toBe(
      'Forecasting 34 pairs at every 5-minute close. The last pass read the 15:00 UTC close in 31 ms. Since the app started: 120 forecasts recorded, 80 outcomes written, 3 forecasts made again between closes.'
    )
    expect(forecastStatusText(state({ missing: 2, lastError: 'a bar was late' }))).toMatch(/80 outcomes written \(2 with no price to judge by\), .* Last error: a bar was late$/)
    expect(forecastStatusText(state({ status: 'waiting', waitingFor: 'models' }, { status: 'fitting', progress: { step: 'fitting gbt', done: 2, total: 5 } }, { ready: 20 }))).toBe(
      "No forecast yet. It is fitting its first models (fitting gbt, 2 of 5). 20 of 34 pairs' bars are up to date."
    )
    expect(forecastStatusText(state({ status: 'waiting', waitingFor: 'models' }, { status: 'failed', lastError: 'out of rows' }))).toBe(
      'No forecast yet. Its first fit failed; it is tried again at the next start or the nightly refit. Last error: out of rows'
    )
    expect(forecastStatusText(state({ status: 'waiting', waitingFor: 'calibration' }))).toBe('No forecast yet. Its models are fitted; the walk forward its ranges are calibrated on is running.')
    expect(forecastStatusText(state({ status: 'waiting', waitingFor: 'bars' }))).toBe('No forecast yet. It waits for the bars of the close.')
  })
})
