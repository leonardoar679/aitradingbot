import { buildEventContext } from '../../shared/aiContext'
import type { AiBenchmarkCostModel } from '../../shared/aiCost'
import {
  EVENT_BENCHMARK_SETTLE_SEC,
  eventBenchmarkWindow,
  sampleEvents,
  type EventBenchmarkAnswers
} from '../../shared/aiEventBenchmark'
import type { AiOpportunityPeek, AiOpportunityPeekRequest } from '../../shared/aiOpportunity'
import { dailyQuoteVolumeOf } from '../../shared/aiOpportunityOutcome'
import type { Candle, SymbolInfo } from '../../shared/ipc'
import type { MarketEvent } from '../../shared/marketEvent'
import type { ScanHistoryRequest, ScanHistoryResult } from '../../shared/marketScanner'
import { fetchEventQuestion, type CandleFetch, type EventQuestionCandles } from './opportunities'

// The free half of a benchmark on events (shared/aiEventBenchmark.ts): finding the events,
// choosing the sample, fetching each one's question, reading what is already held, and fetching
// the candles that score the answers. The paid half is runBenchmark in ./benchmark.ts, the same
// loop the clock benchmark uses, asking one event of one model at a time.
//
// NOTHING IN THIS FILE ASKS A MODEL. Every function here reads public candles, a scan the main
// process makes from them, or the answers already in the cache.

/** Requests in the air at once while fetching questions and outcomes. Public candles, so the
 * limit is the exchange's patience rather than anyone's money. */
const FETCH_CONCURRENCY = 4

export interface EventBenchmarkDeps {
  pickUniverse: (size: number) => Promise<SymbolInfo[]>
  scanHistory: (request: ScanHistoryRequest) => Promise<ScanHistoryResult>
  fetchCandles: CandleFetch
  peek: (request: AiOpportunityPeekRequest) => Promise<AiOpportunityPeek>
}

export interface EventDataset {
  startSec: number
  endSec: number
  pairs: number
  /** Events the scan found in the period, before sampling. */
  found: number
  /** Of the sample, those whose candles could not be fetched or did not make a question. They
   * are left out: a model cannot be asked about them. */
  unaskable: number
  /** Pairs whose history could not be read, each with why. */
  failedPairs: { symbol: string; error: string }[]
  /** The sample, oldest first, and the candles each one's question is built from. */
  events: MarketEvent[]
  questions: EventQuestionCandles[]
  /** Each event's pair's traded value a day at the time, from its own question's candles. */
  dailyVolume: Record<string, number | null>
}

export interface DatasetProgress {
  step: 'pairs' | 'scan' | 'questions'
  done: number
  total: number
}

async function inBatches<T>(items: T[], concurrency: number, shouldStop: (() => boolean) | undefined, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (shouldStop?.()) return
      const index = next++
      if (index >= items.length) return
      await work(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
}

/** Finds the events of a period, takes a sample, and fetches each sampled event's question.
 *
 * A sampled event whose candles do not make a question -- a pair listed too recently to have
 * seven days behind it, a hole in the exchange's history -- is dropped and counted. The check is
 * the one the main process makes before it will ask, run here first so that nobody agrees to a
 * price for calls that would be refused. */
export async function buildEventDataset(
  input: { nowSec: number; days: number; pairCount: number; maxEvents: number; requestId: string; shouldStop?: () => boolean; onProgress?: (progress: DatasetProgress) => void },
  deps: EventBenchmarkDeps
): Promise<EventDataset> {
  const { startSec, endSec } = eventBenchmarkWindow(input.nowSec, input.days)
  input.onProgress?.({ step: 'pairs', done: 0, total: 1 })
  const pairs = await deps.pickUniverse(input.pairCount)
  input.onProgress?.({ step: 'scan', done: 0, total: pairs.length })
  const scan = await deps.scanHistory({
    requestId: input.requestId,
    pairs: pairs.map((pair) => ({ symbol: pair.symbol, baseAsset: pair.baseAsset, quoteAsset: pair.quoteAsset })),
    startSec,
    endSec
  })
  const sample = scan.cancelled ? [] : sampleEvents(scan.events, input.maxEvents)

  const fetched: (EventQuestionCandles | null)[] = sample.map(() => null)
  let done = 0
  await inBatches(sample, FETCH_CONCURRENCY, input.shouldStop, async (event, index) => {
    try {
      const question = await fetchEventQuestion(event, deps.fetchCandles)
      // The same test the main process applies before it will ask.
      if (buildEventContext(question.candles15m, question.candles1m, { exchange: event.exchange, symbol: event.symbol })?.event?.time === event.time) {
        fetched[index] = question
      }
    } catch {
      fetched[index] = null
    }
    input.onProgress?.({ step: 'questions', done: ++done, total: sample.length })
  })

  const events: MarketEvent[] = []
  const questions: EventQuestionCandles[] = []
  const dailyVolume: Record<string, number | null> = {}
  sample.forEach((event, index) => {
    const question = fetched[index]
    if (question === null) return
    events.push(event)
    questions.push(question)
    dailyVolume[event.id] = dailyQuoteVolumeOf(question.candles1m)
  })
  return {
    startSec,
    endSec,
    pairs: pairs.length,
    found: scan.events.length,
    unaskable: sample.length - events.length,
    failedPairs: scan.failed,
    events,
    questions,
    dailyVolume
  }
}

export interface EventPeek {
  /** `known[model][i]` is the answer already held for `events[i]`, or null. */
  known: EventBenchmarkAnswers
  /** One per model: how many answers are held, how many are to ask, and what one call costs. */
  models: AiBenchmarkCostModel[]
  budgetRemainingUsd: number
}

/** What a benchmark already holds and what the rest would cost. One free request an event. */
export async function peekEventBenchmark(
  dataset: EventDataset,
  models: string[],
  deps: Pick<EventBenchmarkDeps, 'peek'>,
  options: { shouldStop?: () => boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<EventPeek> {
  const known: EventBenchmarkAnswers = {}
  for (const model of models) known[model] = dataset.events.map(() => null)
  const costs = new Map<string, Pick<AiBenchmarkCostModel, 'perCallCostUsd' | 'costBasis' | 'perCallLatencyMs'>>()
  let budgetRemainingUsd = 0
  let done = 0
  await inBatches(dataset.events, FETCH_CONCURRENCY, options.shouldStop, async (event, index) => {
    const peek = await deps.peek({ exchange: event.exchange, symbol: event.symbol, ...dataset.questions[index], models })
    budgetRemainingUsd = peek.budgetRemainingUsd
    for (const entry of peek.models) {
      known[entry.model][index] = entry.decision
      // What one call to a model costs does not depend on which event it is asked about.
      if (!costs.has(entry.model)) costs.set(entry.model, { perCallCostUsd: entry.perCallCostUsd, costBasis: entry.costBasis, perCallLatencyMs: entry.perCallLatencyMs })
    }
    options.onProgress?.(++done, dataset.events.length)
  })
  return {
    known,
    models: models.map((model) => {
      const cached = known[model].filter((decision) => decision !== null).length
      const cost = costs.get(model) ?? { perCallCostUsd: null, costBasis: 'unknown' as const, perCallLatencyMs: null }
      return { model, cached, toAsk: dataset.events.length - cached, ...cost }
    }),
    budgetRemainingUsd
  }
}

/** The minute candles from each event on, for as long as a recommendation on it can still be
 * changing, by event id. An event whose candles could not be fetched comes back with none, and
 * its trades are counted as unsettled rather than as anything else. */
export async function loadOutcomeBars(
  events: MarketEvent[],
  nowSec: number,
  fetchCandles: CandleFetch,
  options: { shouldStop?: () => boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<Record<string, Candle[]>> {
  const bars: Record<string, Candle[]> = {}
  let done = 0
  await inBatches(events, FETCH_CONCURRENCY, options.shouldStop, async (event) => {
    try {
      const fetched = await fetchCandles(event.exchange, event.symbol, '1m', event.time, Math.min(nowSec, event.time + EVENT_BENCHMARK_SETTLE_SEC))
      // Completed bars only: a forming one has a close that is not yet a fact.
      bars[event.id] = fetched.filter((bar) => bar.time >= event.time && bar.time + 60 <= nowSec)
    } catch {
      bars[event.id] = []
    }
    options.onProgress?.(++done, events.length)
  })
  return bars
}
