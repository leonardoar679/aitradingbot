import { describe, expect, it } from 'vitest'
import { EVENT_BENCHMARK_SETTLE_SEC, eventBenchmarkWindow } from '../shared/aiEventBenchmark'
import type { AiOpportunityPeekRequest } from '../shared/aiOpportunity'
import { dailyQuoteVolumeOf } from '../shared/aiOpportunityOutcome'
import type { AiSignalDecision } from '../shared/aiSignal'
import type { Candle, SymbolInfo } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import type { ScanHistoryRequest } from '../shared/marketScanner'
import { buildEventDataset, datasetOfExperiment, loadOutcomeBars, peekEventBenchmark, type DatasetProgress, type EventBenchmarkDeps } from '../src/agents/eventBenchmark'
import type { CandleFetch } from '../src/agents/opportunities'
import { eventQuestionCandles } from './eventCandles'

// The free half of a benchmark on events, with the exchange and the main process faked at the
// seams this module reaches them through.

const QUESTION = eventQuestionCandles()
const CALM = eventQuestionCandles({ pct: 0.02 })
const NOW = QUESTION.eventTime + 40 * 86_400

const pair = (base: string): SymbolInfo => ({ symbol: `${base}USDT`, baseAsset: base, quoteAsset: 'USDT' })

function event(symbol: string, time = QUESTION.eventTime): MarketEvent {
  return {
    id: `binance:${symbol}:${time}`,
    exchange: 'binance',
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    time,
    type: 'breakout',
    direction: 'up',
    band: 'urgent',
    score: 95,
    components: { price: 95, volume: 95, volatility: 95, pressure: 95, breakout: 95 },
    price: 103,
    returnsPct: { m1: 0.2, m5: 1, m15: 3, h1: 3, h4: 3 },
    moveSigmas: 40,
    volumeRatio: 8,
    rangeRatio: 4,
    live: null
  }
}

/** GOOD has the candles of a real event at that minute; QUIET's candles are calm, so the detector
 * finds nothing there; DOWN cannot be fetched at all. */
const fetchCandles: CandleFetch = async (_exchange, symbol, interval) => {
  if (symbol === 'DOWNUSDT') throw new Error('exchange down')
  const source = symbol === 'QUIETUSDT' ? CALM : QUESTION
  return interval === '1m' ? source.candles1m : source.candles15m
}

function fakes(found: MarketEvent[]): { deps: EventBenchmarkDeps; scans: ScanHistoryRequest[]; peeks: AiOpportunityPeekRequest[] } {
  const scans: ScanHistoryRequest[] = []
  const peeks: AiOpportunityPeekRequest[] = []
  return {
    scans,
    peeks,
    deps: {
      pickUniverse: async (size) => [pair('GOOD'), pair('QUIET'), pair('DOWN')].slice(0, size),
      scanHistory: async (request) => {
        scans.push(request)
        return { events: found, cancelled: false, failed: [{ symbol: 'DOWNUSDT', error: 'exchange down' }] }
      },
      fetchCandles,
      peek: async (request) => {
        peeks.push(request)
        const held: AiSignalDecision = { candleTime: QUESTION.eventTime, recommendation: 'hold', confidence: 0.5, rationale: '', model: 'a/held', cached: true, error: null, rejected: null, detail: null }
        return {
          eventId: `binance:${request.symbol}:${QUESTION.eventTime}`,
          eventTime: QUESTION.eventTime,
          models: request.models.map((model) => ({
            model,
            decision: model === 'a/held' ? held : null,
            perCallCostUsd: model === 'a/held' ? 0.003 : null,
            costBasis: model === 'a/held' ? ('history' as const) : ('unknown' as const),
            perCallLatencyMs: model === 'a/held' ? 12_000 : null
          })),
          budgetRemainingUsd: 0.75
        }
      }
    }
  }
}

describe('buildEventDataset', () => {
  it('scans the period, samples, and keeps the events whose candles make a question', async () => {
    const { deps, scans } = fakes([event('GOODUSDT'), event('QUIETUSDT'), event('DOWNUSDT')])
    const steps: DatasetProgress[] = []
    const dataset = await buildEventDataset({ nowSec: NOW, days: 14, pairCount: 3, maxEvents: 100, requestId: 'scan-1', onProgress: (progress) => steps.push(progress) }, deps)

    const window = eventBenchmarkWindow(NOW, 14)
    expect(scans).toEqual([{ requestId: 'scan-1', pairs: [pair('GOOD'), pair('QUIET'), pair('DOWN')], startSec: window.startSec, endSec: window.endSec }])
    expect(dataset).toMatchObject({ startSec: window.startSec, endSec: window.endSec, pairs: 3, found: 3, unaskable: 2, failedPairs: [{ symbol: 'DOWNUSDT', error: 'exchange down' }] })
    // The pairs by name, for the record a run leaves, and no record yet: this sample was drawn.
    expect(dataset.symbols).toEqual(['GOODUSDT', 'QUIETUSDT', 'DOWNUSDT'])
    expect(dataset.experimentId).toBeNull()
    // One event survives: the one a model could actually be asked about.
    expect(dataset.events.map((entry) => entry.symbol)).toEqual(['GOODUSDT'])
    expect(dataset.questions).toHaveLength(1)
    expect(dataset.questions[0].candles1m[dataset.questions[0].candles1m.length - 1].time).toBe(QUESTION.eventTime - 60)
    expect(dataset.dailyVolume[dataset.events[0].id]).toBeCloseTo(dailyQuoteVolumeOf(dataset.questions[0].candles1m) ?? NaN, 6)
    expect(steps[0]).toEqual({ step: 'pairs', done: 0, total: 1 })
    expect(steps[steps.length - 1]).toEqual({ step: 'questions', done: 3, total: 3 })
  })

  it('takes no more events than it was told to', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...event('GOODUSDT'), id: `binance:GOODUSDT:${QUESTION.eventTime}:${i}` }))
    const { deps } = fakes(many)
    const dataset = await buildEventDataset({ nowSec: NOW, days: 7, pairCount: 1, maxEvents: 10, requestId: 'scan-2' }, deps)
    expect(dataset.found).toBe(30)
    expect(dataset.events).toHaveLength(10)
  })

  it('drops an event whose candles end in an event at some other minute', async () => {
    // The scan says the event was a minute later than the one these candles end in.
    const { deps } = fakes([event('GOODUSDT', QUESTION.eventTime + 60)])
    const dataset = await buildEventDataset({ nowSec: NOW, days: 7, pairCount: 1, maxEvents: 10, requestId: 'scan-3' }, deps)
    expect(dataset.events).toEqual([])
    expect(dataset.unaskable).toBe(1)
  })

  it('samples nothing from a scan that was cancelled', async () => {
    const { deps } = fakes([event('GOODUSDT')])
    const cancelled: EventBenchmarkDeps = { ...deps, scanHistory: async () => ({ events: [event('GOODUSDT')], cancelled: true, failed: [] }) }
    const dataset = await buildEventDataset({ nowSec: NOW, days: 7, pairCount: 1, maxEvents: 10, requestId: 'scan-4' }, cancelled)
    expect(dataset.events).toEqual([])
  })

  it('stops fetching when told to', async () => {
    const { deps } = fakes([event('GOODUSDT'), { ...event('GOODUSDT'), id: 'second' }])
    let calls = 0
    const counting: EventBenchmarkDeps = {
      ...deps,
      fetchCandles: async (...args) => {
        calls++
        return fetchCandles(...args)
      }
    }
    const dataset = await buildEventDataset({ nowSec: NOW, days: 7, pairCount: 1, maxEvents: 10, requestId: 'scan-5', shouldStop: () => true }, counting)
    expect(calls).toBe(0)
    expect(dataset.events).toEqual([])
  })
})

describe('datasetOfExperiment', () => {
  const recorded = {
    id: 'EXP-2026-1004-001',
    startSec: QUESTION.eventTime - 10 * 86_400,
    endSec: QUESTION.eventTime + 4 * 86_400,
    pairs: ['DOWNUSDT', 'GOODUSDT', 'QUIETUSDT', 'ZEROUSDT'],
    found: 214,
    events: [event('GOODUSDT'), event('QUIETUSDT'), event('DOWNUSDT')]
  }

  it('reads the recorded events and draws nothing', async () => {
    const { deps, scans } = fakes([event('OTHERUSDT')])
    const steps: DatasetProgress[] = []
    let ranked = 0
    const watching: EventBenchmarkDeps = {
      ...deps,
      pickUniverse: async (size) => {
        ranked++
        return deps.pickUniverse(size)
      }
    }
    const dataset = await datasetOfExperiment(recorded, watching, { onProgress: (progress) => steps.push(progress) })

    // Neither the most traded pairs nor their history is looked at: the sample is the record's.
    expect(ranked).toBe(0)
    expect(scans).toEqual([])
    expect(dataset).toMatchObject({
      startSec: recorded.startSec,
      endSec: recorded.endSec,
      pairs: 4,
      symbols: recorded.pairs,
      found: 214,
      unaskable: 2,
      failedPairs: [],
      experimentId: 'EXP-2026-1004-001'
    })
    expect(dataset.events).toEqual([recorded.events[0]])
    expect(dataset.questions).toHaveLength(1)
    expect(dataset.questions[0].candles1m[dataset.questions[0].candles1m.length - 1].time).toBe(QUESTION.eventTime - 60)
    expect(dataset.dailyVolume[recorded.events[0].id]).toBeCloseTo(dailyQuoteVolumeOf(dataset.questions[0].candles1m) ?? NaN, 6)
    expect(steps[steps.length - 1]).toEqual({ step: 'questions', done: 3, total: 3 })
  })

  it('keeps every recorded event whose candles still make its question, however many there are', async () => {
    const { deps } = fakes([])
    // More than a benchmark's sample could be told to hold: a record is not sampled again.
    const many = Array.from({ length: 12 }, (_, i) => ({ ...event('GOODUSDT'), id: `binance:GOODUSDT:${QUESTION.eventTime}:${i}` }))
    const dataset = await datasetOfExperiment({ ...recorded, events: many }, deps)
    expect(dataset.events).toEqual(many)
    expect(dataset.unaskable).toBe(0)
  })

  it('stops fetching when told to', async () => {
    const { deps } = fakes([])
    let calls = 0
    const counting: EventBenchmarkDeps = {
      ...deps,
      fetchCandles: async (...args) => {
        calls++
        return fetchCandles(...args)
      }
    }
    const dataset = await datasetOfExperiment(recorded, counting, { shouldStop: () => true })
    expect(calls).toBe(0)
    expect(dataset.events).toEqual([])
  })
})

describe('peekEventBenchmark', () => {
  it('reads what each model already holds for each event, and what the rest would cost', async () => {
    const { deps, peeks } = fakes([event('GOODUSDT')])
    const dataset = await buildEventDataset({ nowSec: NOW, days: 7, pairCount: 1, maxEvents: 10, requestId: 'scan-6' }, deps)
    const progress: number[] = []
    const peek = await peekEventBenchmark(dataset, ['a/held', 'b/new'], deps, { onProgress: (done) => progress.push(done) })
    expect(peeks).toHaveLength(1)
    expect(peeks[0]).toMatchObject({ exchange: 'binance', symbol: 'GOODUSDT', models: ['a/held', 'b/new'] })
    expect(peeks[0].candles1m).toBe(dataset.questions[0].candles1m)
    expect(peek.known['a/held'][0]).toMatchObject({ recommendation: 'hold', cached: true })
    expect(peek.known['b/new']).toEqual([null])
    expect(peek.models).toEqual([
      { model: 'a/held', cached: 1, toAsk: 0, perCallCostUsd: 0.003, costBasis: 'history', perCallLatencyMs: 12_000 },
      { model: 'b/new', cached: 0, toAsk: 1, perCallCostUsd: null, costBasis: 'unknown', perCallLatencyMs: null }
    ])
    expect(peek.budgetRemainingUsd).toBe(0.75)
    expect(progress).toEqual([1])
  })
})

describe('loadOutcomeBars', () => {
  const bar = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })

  it('fetches from each event on, for as long as a recommendation can still be changing', async () => {
    const asked: { symbol: string; startSec: number; endSec: number }[] = []
    const fetch: CandleFetch = async (_exchange, symbol, _interval, startSec, endSec) => {
      asked.push({ symbol, startSec, endSec })
      // One bar from before the event, and bars through to the end of the range.
      return [bar(startSec - 60), bar(startSec), bar(startSec + 60), bar(endSec)]
    }
    const T = QUESTION.eventTime
    const bars = await loadOutcomeBars([event('GOODUSDT')], NOW, fetch)
    expect(asked).toEqual([{ symbol: 'GOODUSDT', startSec: T, endSec: T + EVENT_BENCHMARK_SETTLE_SEC }])
    expect(bars[`binance:GOODUSDT:${T}`].map((entry) => entry.time)).toEqual([T, T + 60, T + EVENT_BENCHMARK_SETTLE_SEC])
  })

  it('leaves out a bar that has not closed, and never asks past now', async () => {
    const T = QUESTION.eventTime
    const now = T + 150
    const asked: number[] = []
    const fetch: CandleFetch = async (_exchange, _symbol, _interval, startSec, endSec) => {
      asked.push(endSec)
      return [bar(startSec), bar(startSec + 60), bar(startSec + 120)]
    }
    const bars = await loadOutcomeBars([event('GOODUSDT')], now, fetch)
    expect(asked).toEqual([now])
    // The bar that opened at T + 120 closes at T + 180: still forming.
    expect(bars[`binance:GOODUSDT:${T}`].map((entry) => entry.time)).toEqual([T, T + 60])
  })

  it('gives an event whose candles could not be fetched none, rather than leaving it out', async () => {
    const bars = await loadOutcomeBars([event('DOWNUSDT')], NOW, fetchCandles)
    expect(bars[`binance:DOWNUSDT:${QUESTION.eventTime}`]).toEqual([])
  })
})
