import type { AiBenchmarkAnswers } from '../../shared/aiBenchmark'
import { GPT_INTRADAY_INTERVAL, GPT_LOOKBACK_BARS, type AiSignalDecision, type AiSignalTapeRequest } from '../../shared/aiSignal'
import type { Candle, Exchange } from '../../shared/ipc'
import { describeError } from '../utils/ipcError'

// The paid half of a benchmark (shared/aiBenchmark.ts): every answer not already held, asked a
// few at a time.
//
// THE LOOP LIVES HERE, IN THE RENDERER, for the reason an entry review's does. The main process
// sees nothing but ordinary one-decision requests, each guarded exactly as it always was -- the
// cache, the in-flight join, the validator, the ledger, the daily budget -- so a benchmark adds no
// new way to spend. And the spending is tied to the page that shows it: when that page goes away
// the loop stops asking, and whatever was answered is in the cache for the next run.

/** Calls in the air at once. A benchmark is hundreds of independent questions -- none of them
 * waits on another's answer, unlike a tape -- so asking them one at a time only makes it slow.
 * Kept small because the daily budget is checked before each call, not reserved: a run can pass
 * the budget by at most the calls already in the air when it is reached. */
export const BENCHMARK_CONCURRENCY = 4
/** A model that fails this many calls running is not asked again in this run. The others carry
 * on: one provider being down should not cost the answers the rest would have given. */
export const BENCHMARK_MAX_CONSECUTIVE_FAILURES = 3
/** A model whose answers are refused this many times running is not asked again either. A
 * refused answer is not a failure: the model was reached, answered and was BILLED, and the answer
 * is kept. So a model that cannot fill the schema would otherwise be paid for every question of
 * the run before anyone saw a table of refusals. */
export const BENCHMARK_MAX_CONSECUTIVE_REFUSALS = 5

export interface BenchmarkMarket {
  exchange: Exchange
  symbol: string
}

/** The candles a peek is sent: the lookback before the first sampled candle, through the last
 * sampled candle itself. The benchmark holds later candles too -- it has to, to score the calls --
 * and none of them is needed to ask the question, so none of them travels with it. */
export function benchmarkPeekCandles(candles: Candle[], times: number[]): Candle[] {
  if (times.length === 0) return []
  const first = candles.findIndex((candle) => candle.time === times[0])
  const last = candles.findIndex((candle) => candle.time === times[times.length - 1])
  if (first < GPT_LOOKBACK_BARS || last < first) return []
  return candles.slice(first - GPT_LOOKBACK_BARS, last + 1)
}

/** The one-decision tape that asks one model about one sampled candle.
 *
 * It carries the lookback, the execution candle, and NOTHING AFTER IT. A benchmark is the one
 * caller that is holding the future of every question it asks, so this slice is the only thing
 * standing between a model and the answer. */
export function benchmarkAskRequest(market: BenchmarkMarket, candles: Candle[], index: number, model: string): AiSignalTapeRequest {
  if (index < GPT_LOOKBACK_BARS || index >= candles.length) {
    throw new Error('A benchmark decision needs a full lookback of candles before it')
  }
  return {
    requestId: crypto.randomUUID(),
    exchange: market.exchange,
    symbol: market.symbol,
    interval: GPT_INTRADAY_INTERVAL,
    candles: candles.slice(index - GPT_LOOKBACK_BARS, index + 1),
    startIndex: GPT_LOOKBACK_BARS,
    maxDecisions: 1,
    model,
    source: 'benchmark'
  }
}

export interface BenchmarkProgress {
  /** Calls this run has finished, answered or not. */
  asked: number
  /** Calls this run set out to make. */
  toAsk: number
  /** What this run's own calls have cost so far. */
  costUsd: number
}

export interface BenchmarkStop {
  /** `cancelled`: the caller said stop. `refused`: the main process would not go on. */
  reason: 'cancelled' | 'refused'
  /** The main process's own words for it: the budget reached, the key rejected, no credit. */
  message: string | null
}

export interface BenchmarkRunInput {
  times: number[]
  models: string[]
  /** What is already held, from the free pass. Nothing in it is asked for again. */
  known: AiBenchmarkAnswers
  /** One paid decision for `times[timeIndex]`. A decision carrying `error` means the model was not
   * reached and the run goes on; a rejection means nothing will be answered and the run stops. */
  ask: (model: string, timeIndex: number) => Promise<AiSignalDecision>
  shouldStop?: () => boolean
  onProgress?: (progress: BenchmarkProgress, answers: AiBenchmarkAnswers) => void
  concurrency?: number
}

export interface BenchmarkRunResult {
  answers: AiBenchmarkAnswers
  asked: number
  /** Of the calls made, the ones a model answered -- usably or not. */
  answered: number
  costUsd: number
  /** Models this run gave up asking, with the error that kept coming back. `refused` marks one
   * that was reached and answered every time, in a shape the validator would not take. */
  dropped: { model: string; error: string; refused?: boolean }[]
  /** Why the run ended before everything was asked, or null when it did not. */
  stopped: BenchmarkStop | null
}

/** Asks for every answer that is missing, and returns what is held afterwards.
 *
 * CANDLE BY CANDLE, NOT MODEL BY MODEL. A run can end early -- the budget runs out, someone stops
 * it -- and only decisions that every model answered can be compared. Finishing one candle for
 * all the models before starting the next means whatever was bought before the stop is nearly all
 * comparable; finishing one model before starting the next would leave a complete column for the
 * first model and nothing to set beside it.
 *
 * A CALL THAT DID NOT COME BACK IS NOT AN ANSWER. It is left as missing, to be asked for again
 * next time, exactly as the main process leaves it out of the cache. */
export async function runBenchmark(input: BenchmarkRunInput): Promise<BenchmarkRunResult> {
  const answers: AiBenchmarkAnswers = {}
  for (const model of input.models) answers[model] = input.times.map((_, index) => input.known[model]?.[index] ?? null)

  const queue: { model: string; index: number }[] = []
  input.times.forEach((_, index) => {
    for (const model of input.models) if (answers[model][index] === null) queue.push({ model, index })
  })

  const failures = new Map<string, number>()
  const refusals = new Map<string, number>()
  const dropped = new Map<string, { error: string; refused: boolean }>()
  const run = { next: 0, asked: 0, answered: 0, costUsd: 0, stopped: null as BenchmarkStop | null }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (run.stopped !== null) return
      if (input.shouldStop?.()) {
        run.stopped = { reason: 'cancelled', message: null }
        return
      }
      const job = queue[run.next++]
      if (job === undefined) return
      if (dropped.has(job.model)) continue

      let decision: AiSignalDecision
      try {
        decision = await input.ask(job.model, job.index)
      } catch (error) {
        // The first refusal is the reason; the workers still in the air may each bring back the
        // same one, and it does not need saying four times.
        run.stopped ??= { reason: 'refused', message: describeError(error) }
        return
      }

      run.asked++
      if (decision.error !== null) {
        const count = (failures.get(job.model) ?? 0) + 1
        failures.set(job.model, count)
        if (count >= BENCHMARK_MAX_CONSECUTIVE_FAILURES) dropped.set(job.model, { error: decision.error, refused: false })
      } else {
        failures.set(job.model, 0)
        answers[job.model][job.index] = decision
        run.answered++
        // A refused answer is still an answer -- kept, shown and paid for -- but a run of them
        // is a model that cannot be asked this question, and asking on only buys more of them.
        if (decision.rejected) {
          const count = (refusals.get(job.model) ?? 0) + 1
          refusals.set(job.model, count)
          if (count >= BENCHMARK_MAX_CONSECUTIVE_REFUSALS) dropped.set(job.model, { error: decision.rejected, refused: true })
        } else {
          refusals.set(job.model, 0)
        }
        // An answer joined from another caller's request in the air was not this run's spend.
        if (!decision.cached) run.costUsd += decision.usage?.costUsd ?? 0
      }
      input.onProgress?.({ asked: run.asked, toAsk: queue.length, costUsd: run.costUsd }, answers)
    }
  }

  const workers = Math.min(Math.max(1, input.concurrency ?? BENCHMARK_CONCURRENCY), queue.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))

  return {
    answers,
    asked: run.asked,
    answered: run.answered,
    costUsd: run.costUsd,
    dropped: [...dropped].map(([model, why]) => ({ model, error: why.error, ...(why.refused ? { refused: true } : {}) })),
    stopped: run.stopped
  }
}
