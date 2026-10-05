import { EVENT_BENCHMARK_SETTLE_SEC, type EventBenchmarkAnswers } from '../../shared/aiEventBenchmark'
import type { AiCallFilter, AiCallPage } from '../../shared/aiLedger'
import { AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS } from '../../shared/aiOpportunity'
import type { Candle } from '../../shared/ipc'
import type { MarketEvent } from '../../shared/marketEvent'
import type { MarketEventFilter, MarketEventPage } from '../../shared/marketScanner'
import { loadOutcomeBars } from './eventBenchmark'
import { decisionOfCall, type CandleFetch } from './opportunities'

// The leaderboard of what the watch asked live (shared/aiWatch.ts), in the benchmark's own tables
// (shared/aiEventBenchmark.ts): the same events for every model, the same scoring, the same rows
// that are not models.
//
// WHAT IS DIFFERENT FROM A BENCHMARK IS WHAT A BENCHMARK HAS TO ASSUME. A replayed answer is
// taken to have arrived ten seconds after the event plus the model's latency; an answer here is
// scored from the second its call finished. A replayed event's slippage is a rate for its
// liquidity; an event here also carries the spread that was on the book when it was raised. Set
// beside a benchmark of the same models, the difference between the two is what those assumptions
// were worth.
//
// ONLY THE WATCH'S OWN ANSWERS. An answer bought by pressing Ask an hour after an event arrived
// when a person got round to it, which says nothing about the model.
//
// NOTHING HERE ASKS A MODEL, AND NOTHING IS STORED. It reads the ledger, the scanner's events and
// public candles, each time it is looked at.

export const LIVE_BOARD_DAYS = 30
/** The most rows read from each file. A month of the watch at its highest limit is more answers
 * than this; then the newest are the ones compared. */
const ROWS_READ = 5000

export interface LiveBoardDeps {
  listCalls: (filter: AiCallFilter) => Promise<AiCallPage>
  listEvents: (filter: MarketEventFilter) => Promise<MarketEventPage>
  fetchCandles: CandleFetch
}

export interface LiveAnswers {
  /** The events the watch put to at least one of the models, oldest first. */
  events: MarketEvent[]
  /** `answers[model][i]` is that model's answer for `events[i]`, or null. */
  answers: EventBenchmarkAnswers
  /** `answeredAt[model][i]` is when it arrived. */
  answeredAt: Record<string, (number | null)[]>
  /** Events the watch asked about whose record is no longer on file. They cannot be scored. */
  missing: number
}

/** The watch's answers from `models` over the last LIVE_BOARD_DAYS, joined to the events they
 * were about. Free: it reads two files. */
export async function readLiveAnswers(models: string[], nowSec: number, deps: Pick<LiveBoardDeps, 'listCalls' | 'listEvents'>): Promise<LiveAnswers> {
  const sinceSec = nowSec - LIVE_BOARD_DAYS * 86_400
  const [calls, onFile] = await Promise.all([
    deps.listCalls({ source: 'watch', promptVersions: AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS, sinceSec, limit: ROWS_READ }),
    // An answer inside the period can be about an event raised a few minutes before it began.
    deps.listEvents({ sinceSec: sinceSec - 3600, limit: ROWS_READ })
  ])
  const eventById = new Map(onFile.rows.map((event) => [event.id, event]))

  // Oldest first, so the first answer a model gave for an event is the one kept -- the rule the
  // feed follows too. A call that never reached a model has nothing to score.
  const kept = new Map<string, Map<string, { decision: ReturnType<typeof decisionOfCall>; at: number }>>()
  for (const row of [...calls.rows].sort((a, b) => a.at - b.at)) {
    if (row.eventId === undefined || row.status === 'failed' || !models.includes(row.model)) continue
    const byModel = kept.get(row.eventId) ?? new Map<string, { decision: ReturnType<typeof decisionOfCall>; at: number }>()
    if (!byModel.has(row.model)) byModel.set(row.model, { decision: decisionOfCall(row), at: row.at })
    kept.set(row.eventId, byModel)
  }

  const events = [...kept.keys()]
    .map((id) => eventById.get(id))
    .filter((event): event is MarketEvent => event !== undefined)
    .sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol))
  const answers: EventBenchmarkAnswers = {}
  const answeredAt: Record<string, (number | null)[]> = {}
  for (const model of models) {
    answers[model] = events.map((event) => kept.get(event.id)?.get(model)?.decision ?? null)
    answeredAt[model] = events.map((event) => kept.get(event.id)?.get(model)?.at ?? null)
  }
  return { events, answers, answeredAt, missing: kept.size - events.length }
}

/** Candles already fetched for an event whose recommendations can no longer change. A month of
 * events is a request each, and none of them needs making twice in a session. */
const settledBars = new Map<string, Candle[]>()

/** The minute candles that score each event, by event id. One request an event not already held. */
export async function loadLiveBars(
  events: MarketEvent[],
  nowSec: number,
  fetchCandles: CandleFetch,
  options: { shouldStop?: () => boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<Record<string, Candle[]>> {
  const bars: Record<string, Candle[]> = {}
  const toFetch: MarketEvent[] = []
  for (const event of events) {
    const held = settledBars.get(event.id)
    if (held) bars[event.id] = held
    else toFetch.push(event)
  }
  const fetched = await loadOutcomeBars(toFetch, nowSec, fetchCandles, options)
  for (const event of toFetch) {
    const list = fetched[event.id] ?? []
    bars[event.id] = list
    // Kept only once nothing more can happen to it, and only if there was something to keep: an
    // empty list is a fetch that failed, which the next look should try again.
    if (list.length > 0 && nowSec >= event.time + EVENT_BENCHMARK_SETTLE_SEC + 60) settledBars.set(event.id, list)
  }
  return bars
}

/** Test seam. */
export function clearLiveBars(): void {
  settledBars.clear()
}
