import {
  GPT_INTRADAY_INTERVAL,
  GPT_LOOKBACK_BARS,
  type AiCallSource,
  type AiSignalDecision,
  type AiSignalEstimate,
  type AiSignalTapeRequest
} from '../../shared/aiSignal'
import { INTERVAL_SECONDS, type Candle, type Exchange } from '../../shared/ipc'
import { fetchRangeCached } from '../bots/candleCache'

export interface AiSignal {
  symbol: string
  confidence: number
  recommendation: 'buy' | 'sell' | 'hold'
  rationale?: string
  /** The full decision behind the three fields above. Null when no model was asked. */
  decision: AiSignalDecision | null
}

/** Extra bars fetched beyond the lookback, so a missing candle or two on the exchange's side does
 * not leave the window one bar short and the request refused. */
const FETCH_SLACK_BARS = 16

export interface AiSignalQuery {
  exchange: Exchange
  /** Open time of the candle the decision executes on. Absent means the one forming now. */
  executionTime?: number
  model?: string
  source?: AiCallSource
}

/** Candles covering one decision, and the request that asks for it.
 *
 * FETCHES ITS OWN WINDOW rather than reading whatever the caller has on screen. The chart keeps
 * about 500 bars and a decision needs 672 completed ones before it, so a request built from the
 * chart's candles would be refused for too little history -- no arrow drawn, no error raised, and
 * nothing to tell that apart from a model that keeps saying hold. The fetch goes through the
 * shared candle cache, so after the first call each one costs the tail of the series. */
export async function prepareAiSignalRequest(
  symbol: string,
  query: AiSignalQuery
): Promise<{ request: AiSignalTapeRequest; candles: Candle[]; executionIndex: number } | null> {
  const interval = GPT_INTRADAY_INTERVAL
  const barSec = INTERVAL_SECONDS[interval]
  const nowSec = Math.floor(Date.now() / 1000)
  const executionTime = query.executionTime ?? Math.floor(nowSec / barSec) * barSec
  const candles = await fetchRangeCached(
    (ex, sym, iv, from, to) => window.api.market.fetchHistoricalRange(ex, sym, iv, from, to),
    query.exchange,
    symbol,
    interval,
    executionTime - (GPT_LOOKBACK_BARS + FETCH_SLACK_BARS) * barSec,
    executionTime + barSec
  )
  const executionIndex = candles.findIndex((candle) => candle.time >= executionTime)
  if (executionIndex < GPT_LOOKBACK_BARS) return null
  return {
    candles,
    executionIndex,
    request: {
      requestId: crypto.randomUUID(),
      exchange: query.exchange,
      symbol,
      interval,
      // Nothing after the execution candle is sent, so nothing after it can be read.
      candles: candles.slice(0, executionIndex + 1),
      startIndex: executionIndex,
      maxDecisions: 1,
      model: query.model,
      source: query.source
    }
  }
}

/** What asking would cost, without asking. Free: it reads the cache and a price list. */
export async function estimateAiSignal(symbol: string, query: AiSignalQuery): Promise<AiSignalEstimate | null> {
  const prepared = await prepareAiSignalRequest(symbol, query)
  return prepared ? window.api.ai.estimateSignalTape(prepared.request) : null
}

/** One decision for one candle. Billed unless it is already cached. */
export async function requestAiSignal(symbol: string, query: AiSignalQuery = { exchange: 'binance' }): Promise<AiSignal> {
  const prepared = await prepareAiSignalRequest(symbol, query)
  if (!prepared) {
    return {
      symbol,
      confidence: 0,
      recommendation: 'hold',
      rationale: 'Not enough completed candles, or the exchange has not published this one yet.',
      decision: null
    }
  }
  const tape = await window.api.ai.generateSignalTape(prepared.request)
  const decision: AiSignalDecision | undefined = tape.decisions[0]
  return decision
    ? {
        symbol,
        confidence: decision.confidence,
        recommendation: decision.recommendation,
        rationale: decision.rationale,
        decision
      }
    : { symbol, confidence: 0, recommendation: 'hold', rationale: 'No signal returned.', decision: null }
}
