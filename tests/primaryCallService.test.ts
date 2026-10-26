import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DELISTING_STUDY } from '../shared/delistingStudy'
import { DELIST_LIVE_LINES, delistingFiguresOf, type CardStateLine } from '../shared/forecast/primaryCall'
import type { SourcePrediction } from '../shared/evaluation/predictionRecord'
import type { LiquidityVerdict } from '../shared/liquidityGate'
import type { NewsItem } from '../shared/news'
import type { PricePrediction } from '../shared/forecast/prediction'

// THE PRIMARY CALL, WEIGHED (electron/services/primaryCallService.ts; V8 Stage 3): a Binance delisting's coins weighed
// within the rule's five minutes into a card, recorded once; past them on the late list with their move since; a coin
// with no pair refused; the live check able to withdraw the card; a direction model counted where a range reads one;
// each coin's card state written once an hour.

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('../electron/services/forecastService', () => ({ latestForecasts: () => [] }))
vi.mock('../electron/services/forecastTrainingService', () => ({ currentForecastCalibration: () => null }))
vi.mock('../electron/services/effectiveConfigService', () => ({ getEffectiveConfig: async () => ({ engineVersion: 'e', configVersion: 'c' }) }))
vi.mock('../electron/services/marketService', () => ({ listSymbols: async () => [], fetchHistoricalRange: async () => ({ candles: [], cancelled: false }) }))
vi.mock('../electron/services/newsRecordService', () => ({ getNewsRecord: async () => ({ since: 0, listedAt: null, error: null, rows: [] }) }))
vi.mock('../electron/services/newsService', () => ({ getNewsState: async () => ({ config: { enabled: false } }), onNewsUpdate: () => () => undefined }))
vi.mock('../electron/services/predictionLedgerService', () => ({ recordCardStates: async () => 0, recordSourcePrediction: async () => undefined }))
vi.mock('../electron/services/venueQuotesService', () => ({
  EVENT_PAIRS_MAX: 5,
  readEventBooksNow: async () => false,
  setEventPairs: () => undefined,
  venueGateOf: () => ({ ok: false, code: 'no-book', reason: '', trip: null, depthQuote: null }),
  venueMidOf: () => null
}))

const NOW = 1_793_030_400 + 90 // 16:01:30 UTC
const passing: LiquidityVerdict = { ok: true, trip: { venue: 'binance', feePct: 0.1, spreadPct: 0.3, impactPct: 0.2, totalPct: 0.7, basis: 'book' }, depthQuote: 5_000 }
const item = (over: Partial<NewsItem> = {}): NewsItem => ({ id: 77, catalog: 161, title: 'Binance Will Delist ABC, DEFI on 2026-11-02', releaseSec: NOW - 60, seenAt: NOW - 50, category: 'DELISTING', tickers: ['ABC', 'DEFI'], ...over })

let recorded: SourcePrediction[] = []
let states: { at: number; lines: readonly CardStateLine[] }[] = []
let lane: string[] = []

beforeEach(() => {
  vi.resetModules()
  recorded = []
  states = []
  lane = []
})

async function service(items: NewsItem[], over: Partial<Record<string, unknown>> = {}) {
  const module = await import('../electron/services/primaryCallService')
  module.resetPrimaryCall()
  Object.assign(module.primaryCallSeam, {
    now: () => NOW,
    news: async () => ({ on: true, stakeQuote: 100, items }),
    symbols: async () => [{ symbol: 'ABCUSDT', baseAsset: 'ABC', quoteAsset: 'USDT' }],
    newsRecord: async () => ({ since: 0, listedAt: null, error: null, rows: [] }),
    readBook: async () => true,
    setLane: (pairs: readonly string[]) => (lane = [...pairs]),
    mid: () => 2,
    gate: () => passing,
    openAt: async () => 2.5,
    forecasts: () => [],
    calibration: () => null,
    versions: async () => ({ engine: 'e', config: 'c' }),
    recordPrediction: async (prediction: SourcePrediction) => void recorded.push(prediction),
    recordStates: async (at: number, lines: readonly CardStateLine[]) => {
      states.push({ at, lines })
      return lines.length
    },
    ...over
  })
  return module
}

describe('a delisting weighed', () => {
  it("makes the card within the rule's five minutes, records it once, and refuses a coin with no pair", async () => {
    const calls = await service([item()])
    const state = await calls.weighPrimaryCall()
    expect(state.readerOn).toBe(true)
    expect(lane).toEqual(['ABCUSDT'])
    expect(state.cards).toHaveLength(1)
    const [card] = state.cards
    expect(card).toMatchObject({ pair: 'ABCUSDT', side: 'down', source: 'delisting-rule', refPrice: 2, eventAt: NOW - 60, predictionId: `delisting-rule:ABCUSDT:${NOW - 60}` })
    expect(card.movePct).toBeCloseTo(delistingFiguresOf(DELISTING_STUDY.coins).medianGrossPct, 12)
    expect(state.refused).toEqual([{ refused: 'no-pair', source: 'delisting-rule', pair: 'DEFIUSDT', eventAt: NOW - 60, expectedNet: null }])
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ id: card.predictionId, source: 'delisting-rule', kind: 'direction', side: 'down', pair: 'ABCUSDT', refPrice: 2, versions: { engine: 'e', config: 'c' } })
    expect(recorded[0].horizonSec).toBe(card.exitAt - card.madeAt)
    expect(recorded[0].unit).toBe(Math.floor((NOW - 60) / 3600))
    expect(recorded[0].dist.pRight).toBeCloseTo(DELISTING_STUDY.coins.filter((coin) => coin.grossPct > 0).length / 87, 12)
    expect(recorded[0].cost).toEqual({ roundTripPct: card.cost.totalPct, basis: 'book', stakeQuote: 100 })
    await calls.weighPrimaryCall()
    expect(recorded).toHaveLength(1)
  })

  it('puts a coin past the window on the late list with its move since the announcement', async () => {
    const calls = await service([item({ releaseSec: NOW - 600, tickers: ['ABC'] })])
    const state = await calls.weighPrimaryCall()
    expect(state.cards).toEqual([])
    expect(state.late).toEqual([{ pair: 'ABCUSDT', ticker: 'ABC', eventAt: NOW - 600, exitAt: Math.floor((NOW - 600) / 60) * 60 + 240 * 60, movedSincePct: (2 / 2.5 - 1) * 100 }])
    expect(state.refused).toMatchObject([{ refused: 'late', pair: 'ABCUSDT' }])
    expect(recorded).toEqual([])
  })

  it('lets go of a delisting once its hold is over, and reads nothing but delistings', async () => {
    const calls = await service([item({ releaseSec: NOW - 240 * 60 - 1 }), item({ id: 78, category: 'MONITORING_TAG' }), item({ id: 79, category: null })])
    const state = await calls.weighPrimaryCall()
    expect(state.cards).toEqual([])
    expect(state.late).toEqual([])
    expect(state.refused).toEqual([])
    expect(lane).toEqual([])
  })

  it('is withdrawn by the live check on the delistings since 1 October', async () => {
    const rows = Array.from({ length: 6 }, (_, k) => ({ key: `${k}`, articleId: k, category: 'DELISTING', rule: 'DELISTING_HOLD', ticker: 'X', releaseSec: DELIST_LIVE_LINES.sinceSec + k * 86_400, title: '', status: 'scored', netPct: -4 + (k % 2), symbol: 'XUSDT', note: null }))
    const calls = await service([item({ tickers: ['ABC'] })], { newsRecord: async () => ({ since: 0, listedAt: null, error: null, rows }) })
    const state = await calls.weighPrimaryCall()
    expect(state.delistLive).toMatchObject({ hours: 6, state: 'withdrawn' })
    expect(state.cards).toEqual([])
    expect(state.refused).toMatchObject([{ refused: 'withdrawn', pair: 'ABCUSDT' }])
  })

  it('says the reader is off, and that no card or source spoke', async () => {
    const calls = await service([], { news: async () => ({ on: false, stakeQuote: 100, items: [] }) })
    const state = await calls.weighPrimaryCall()
    expect(state).toMatchObject({ readerOn: false, cards: [], late: [], refused: [], modelSources: 0, delistLive: null })
  })
})

describe("each coin's card state", () => {
  it('is written once an hour, a card for the coin that has one and no-source for every other', async () => {
    const forecasts = [{ pair: 'BTCUSDT', horizons: {} }, { pair: 'ETHUSDT', horizons: {} }] as unknown as PricePrediction[]
    const calls = await service([item({ tickers: ['ABC'] })], { forecasts: () => forecasts })
    await calls.weighPrimaryCall()
    await calls.weighPrimaryCall()
    expect(states).toHaveLength(1)
    expect(states[0].at).toBe(Math.floor(NOW / 3600) * 3600)
    expect(states[0].lines.map((line) => [line.pair, line.state, line.why])).toEqual([
      ['ABCUSDT', 'card', null],
      ['BTCUSDT', 'none', 'no-source'],
      ['ETHUSDT', 'none', 'no-source']
    ])
  })
})

describe('a direction model', () => {
  it('is counted where a range reads its P(up) from one, and refused without a record behind it', async () => {
    const forecasts = [
      {
        pair: 'BTCUSDT',
        pairClass: 'btc',
        barTime: NOW - 90,
        currentPrice: 100,
        horizons: { hour1: { pUpSource: 'dir-gbt', direction: 'BULLISH', quantilesPct: [-1, -0.4, 0.3, 0.9, 1.6] }, hours4: { pUpSource: 'distribution', direction: 'BEARISH', quantilesPct: [-3, -2, -1, 0, 1] } }
      }
    ] as unknown as PricePrediction[]
    const calls = await service([], { forecasts: () => forecasts })
    const state = await calls.weighPrimaryCall()
    expect(state.modelSources).toBe(1)
    expect(state.cards).toEqual([])
    expect(state.refused).toEqual([{ refused: 'no-evidence', source: 'direction-model', pair: 'BTCUSDT', eventAt: null, expectedNet: null }])
  })
})

describe("each coin's card state, at a start", () => {
  it('is not spent on a weighing before the forecast has any pair, and is written once it has', async () => {
    let forecasts: PricePrediction[] = []
    const calls = await service([], { forecasts: () => forecasts })
    await calls.weighPrimaryCall()
    expect(states).toEqual([])
    forecasts = [{ pair: 'BTCUSDT', horizons: {} }] as unknown as PricePrediction[]
    await calls.weighPrimaryCall()
    await calls.weighPrimaryCall()
    expect(states).toHaveLength(1)
    expect(states[0].lines.map((line) => line.pair)).toEqual(['BTCUSDT'])
  })
})
