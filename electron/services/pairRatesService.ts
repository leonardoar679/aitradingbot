import type { PairRates } from '../../shared/forecast/pairRates'
import { readForecastTexts } from './forecastDataService'
import { runInWorker } from './taskWorkerService'

// THE PAIRS' NINETY DAYS, ONCE AN HOUR (V8 Stage 10, 2 November 2026; shared/forecast/pairRates.ts). The forecast
// holds three days of five-minute bars live, too few for a pair's ninety-day move rates or its day moves, so at the
// first close of each hour every pair's files are read as text and handed to a worker of its own (task pairRates),
// one pair after another, and what it works out at the hour's close is kept for the pass and the Forecast Lab. A pair
// whose files cannot be read, or whose worker fails, keeps what it had; one refresh runs at a time.

/** A pair's rates as last worked out, and the hour's close they were read at. */
export interface HeldPairRates extends PairRates {
  atSec: number
}

/** How long a pair's worker may take, and its memory: ninety days of bars is about 26,000 lines. */
const PAIR_RATES_LIMITS = { timeoutMs: 30_000, maxOldGenerationSizeMb: 512 }

const held = new Map<string, HeldPairRates>()
let refreshing: Promise<void> | null = null
let lastHour = -1

/** Test seams: the files read and the worker run. */
export const pairRatesSeam = {
  texts: readForecastTexts,
  run: runInWorker
}

/** Reads every pair's rates again at the whole hour `closedAt` falls in, unless that hour's are read or being read. */
export function refreshPairRates(pairs: readonly string[], closedAt: number): Promise<void> {
  const hour = Math.floor(closedAt / 3600)
  if (refreshing !== null) return refreshing
  if (hour === lastHour) return Promise.resolve()
  lastHour = hour
  const atSec = hour * 3600
  refreshing = (async (): Promise<void> => {
    for (const pair of pairs) {
      const texts = await pairRatesSeam.texts(pair).catch((): string[] => [])
      if (texts.length === 0) continue
      const outcome = await pairRatesSeam.run('pairRates', { texts, atSec }, PAIR_RATES_LIMITS)
      if (outcome.ok) held.set(pair, { ...(outcome.result as PairRates), atSec })
      else console.error(`${pair}'s ninety-day rates could not be read (${outcome.reason}): ${outcome.message}`)
    }
    for (const pair of [...held.keys()]) if (!pairs.includes(pair)) held.delete(pair)
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

/** A pair's rates as last read; undefined before the first refresh has reached it. */
export function heldPairRates(pair: string): HeldPairRates | undefined {
  return held.get(pair)
}

/** Test seam. */
export function resetPairRates(): void {
  held.clear()
  refreshing = null
  lastHour = -1
}
