import { buildEventContext } from '../../shared/aiContext'
import type { AiBenchmarkCostModel } from '../../shared/aiCost'
import type { AiExperiment } from '../../shared/aiExperiment'
import {
  EVENT_BENCHMARK_SETTLE_SEC,
  eventBenchmarkWindow,
  sampleEvents,
  type EventBenchmarkAnswers,
  type EventLabels
} from '../../shared/aiEventBenchmark'
import { btcRegimeOf, eventCompanyOf, referenceReturns } from '../../shared/aiEventMarket'
import type { AiOpportunityPeek, AiOpportunityPeekRequest, AiOpportunityQuestion, AiOpportunityQuestionKind } from '../../shared/aiOpportunity'
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
// A SAMPLE COMES FROM ONE OF TWO PLACES. buildEventDataset draws one: it scans the period and
// picks. datasetOfExperiment reads one a run already recorded (shared/aiExperiment.ts), and picks
// nothing -- which is the only way to ask a later model about the events an earlier one was asked.
//
// AN EVENT CAN BE PUT AS ONE OF TWO QUESTIONS: the pair alone, or the pair with the market around
// it (shared/aiEventMarket.ts). A sample fetched with the market holds both, because the first is
// the second's candles without Bitcoin's and ether's: so the two can be set side by side on the
// same events, and each read from the cache under its own key.
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
  /** Those pairs, by symbol. */
  symbols: string[]
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
  /** The recorded experiment this sample was read from, or null for one just drawn. */
  experimentId: string | null
  /** The question its candles were fetched for. One fetched with the market holds the question
   * about the pair alone as well: the same candles without the reference. */
  question: AiOpportunityQuestionKind
  /** Bitcoin's four hours and the move's company at each event, by event id. Only on a sample
   * fetched with the market: they are worked out from Bitcoin's candles. */
  labels: Record<string, EventLabels>
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

/** What Bitcoin's four hours were doing at an event, and whether its move was made with it, from
 * the reference candles of its question. Null where they cannot say. Fixed rules, never a model. */
export function eventLabelsOf(event: Pick<MarketEvent, 'time' | 'returnsPct'>, question: EventQuestionCandles): EventLabels | null {
  if (question.reference === undefined) return null
  const btc = referenceReturns(question.reference.btc, event.time)
  return btc === null ? null : { btcRegime: btcRegimeOf({ btc }), company: eventCompanyOf(event.returnsPct.m15, { btc }) }
}

export interface QuestionOptions {
  /** The question the candles are fetched for. The pair alone when absent. */
  question?: AiOpportunityQuestionKind
  shouldStop?: () => boolean
  onProgress?: (progress: DatasetProgress) => void
}

/** Fetches each sampled event's question, and keeps the events that have one.
 *
 * A sampled event whose candles do not make a question -- a pair listed too recently to have
 * seven days behind it, a hole in the exchange's history, and, for the question with the market,
 * reference candles that stop short of its minute -- is dropped and counted. The check is the one
 * the main process makes before it will ask, run here first so that nobody agrees to a price for
 * calls that would be refused. */
async function askable(
  sample: MarketEvent[],
  fetchCandles: CandleFetch,
  options: QuestionOptions
): Promise<Pick<EventDataset, 'events' | 'questions' | 'dailyVolume' | 'unaskable' | 'question' | 'labels'>> {
  const kind = options.question ?? 'pair'
  const fetched: (EventQuestionCandles | null)[] = sample.map(() => null)
  let done = 0
  await inBatches(sample, FETCH_CONCURRENCY, options.shouldStop, async (event, index) => {
    try {
      // An event an announcement raised has a question of its own, with the announcement in it; a
      // benchmark compares models on the scanner's question, so it is left out like any unaskable one.
      if (event.news !== undefined) throw new Error('An announcement is not benchmarked')
      const question = await fetchEventQuestion(event, fetchCandles, { market: kind === 'market' })
      // The same test the main process applies before it will ask: an event, at this minute, and
      // for the question with the market, the market around it (no question is built without it).
      const built = buildEventContext(question.candles15m, question.candles1m, { exchange: event.exchange, symbol: event.symbol }, question.reference)
      if (built?.event?.time === event.time) fetched[index] = question
    } catch {
      fetched[index] = null
    }
    options.onProgress?.({ step: 'questions', done: ++done, total: sample.length })
  })

  const events: MarketEvent[] = []
  const questions: EventQuestionCandles[] = []
  const dailyVolume: Record<string, number | null> = {}
  const labels: Record<string, EventLabels> = {}
  sample.forEach((event, index) => {
    const question = fetched[index]
    if (question === null) return
    events.push(event)
    questions.push(question)
    dailyVolume[event.id] = dailyQuoteVolumeOf(question.candles1m)
    const label = eventLabelsOf(event, question)
    if (label !== null) labels[event.id] = label
  })
  return { events, questions, dailyVolume, unaskable: sample.length - events.length, question: kind, labels }
}

/** The question put to a model about one event of a sample, as the main process takes it. The
 * pair alone is the same candles without the reference, so a sample fetched with the market can
 * be asked, and read, either way. */
export function questionOf(dataset: Pick<EventDataset, 'events' | 'questions'>, index: number, kind: AiOpportunityQuestionKind): AiOpportunityQuestion {
  const event = dataset.events[index]
  const { candles15m, candles1m, reference } = dataset.questions[index]
  if (kind === 'market' && reference === undefined) throw new Error('This sample was fetched without the market around its events. Fetch it again with that question.')
  return { exchange: event.exchange, symbol: event.symbol, candles15m, candles1m, ...(kind === 'market' ? { reference } : {}) }
}

/** Finds the events of a period, takes a sample, and fetches each sampled event's question. */
export async function buildEventDataset(
  input: { nowSec: number; days: number; pairCount: number; maxEvents: number; requestId: string } & QuestionOptions,
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
  return {
    startSec,
    endSec,
    pairs: pairs.length,
    symbols: pairs.map((pair) => pair.symbol),
    found: scan.events.length,
    failedPairs: scan.failed,
    ...(await askable(sample, deps.fetchCandles, input)),
    experimentId: null
  }
}

/** A recorded run's sample, with each event's question fetched again.
 *
 * NOTHING IS DRAWN. The events are the record's, so a model asked now is asked about exactly the
 * events the run's own models were, whatever the most traded pairs are today. Their candles are
 * public and are read again; an event whose candles no longer make its question is left out and
 * counted, as in a sample just drawn. */
export async function datasetOfExperiment(
  experiment: Pick<AiExperiment, 'id' | 'startSec' | 'endSec' | 'pairs' | 'found' | 'events'>,
  deps: Pick<EventBenchmarkDeps, 'fetchCandles'>,
  options: QuestionOptions = {}
): Promise<EventDataset> {
  return {
    startSec: experiment.startSec,
    endSec: experiment.endSec,
    pairs: experiment.pairs.length,
    symbols: experiment.pairs,
    found: experiment.found,
    failedPairs: [],
    ...(await askable(experiment.events, deps.fetchCandles, options)),
    experimentId: experiment.id
  }
}

/** The same sample, its questions fetched again for another question. The events are kept and
 * nothing is drawn; an event the other question cannot be put about is left out and counted. */
export async function datasetForQuestion(dataset: EventDataset, deps: Pick<EventBenchmarkDeps, 'fetchCandles'>, options: QuestionOptions): Promise<EventDataset> {
  const refetched = await askable(dataset.events, deps.fetchCandles, options)
  return { ...dataset, ...refetched, unaskable: dataset.unaskable + refetched.unaskable }
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
  options: { question?: AiOpportunityQuestionKind; shouldStop?: () => boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<EventPeek> {
  const kind = options.question ?? dataset.question
  const known: EventBenchmarkAnswers = {}
  for (const model of models) known[model] = dataset.events.map(() => null)
  const costs = new Map<string, Pick<AiBenchmarkCostModel, 'perCallCostUsd' | 'costBasis' | 'perCallLatencyMs'>>()
  let budgetRemainingUsd = 0
  let done = 0
  await inBatches(dataset.events, FETCH_CONCURRENCY, options.shouldStop, async (_event, index) => {
    const peek = await deps.peek({ ...questionOf(dataset, index, kind), models })
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
