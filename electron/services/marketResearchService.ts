import type { SymbolInfo, Ticker24h } from '../../shared/ipc'
import { msg } from '../../shared/i18n/translate'
import {
  RISK_DETAIL,
  RESEARCH_DAILY_BARS,
  RESEARCH_MARKET_BARS,
  RESEARCH_REFRESH_MS,
  TRENDING_REFRESH_MS,
  TRENDING_URL,
  candidatesOf,
  emptyResearchState,
  marketStatusOf,
  markTrending,
  parseTrending,
  readResearchPair,
  researchUniverse,
  withScores,
  withStep,
  type ResearchPair,
  type ResearchState
} from '../../shared/marketResearch'
import { listSymbols, scanSourceFor } from './marketService'
import { singleFlight } from './singleFlight'

// THE MARKET RESEARCH THE APP DOES WHEN IT OPENS, and every ten minutes after (the second V3
// document's §4 and §9; the arithmetic is shared/marketResearch.ts).
//
// It reads the same public market data the scanner reads, from the same data host -- never the host
// that trades -- and CoinGecko's free trending list. No key, no model, no order, and nothing
// written: what it found is held in memory and shown, and read again at the next launch.

/** How many pairs' daily bars are read at once: fifty pairs, a dozen requests a second at most. */
const CONCURRENCY = 4
const TRENDING_TIMEOUT_MS = 10_000

let state: ResearchState = emptyResearchState()
const listeners = new Set<(state: ResearchState) => void>()
let started = false

function publish(next: ResearchState): void {
  state = next
  for (const listener of listeners) {
    try {
      listener(state)
    } catch (error) {
      console.error('A market research listener failed:', error)
    }
  }
}

export function onResearchUpdate(listener: (state: ResearchState) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function getResearchState(): ResearchState {
  return state
}

const describeFailure = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Runs `work` over `items`, `limit` at a time, keeping what each one returned or threw. */
async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<({ ok: true; value: R } | { ok: false; error: unknown })[]> {
  const out: ({ ok: true; value: R } | { ok: false; error: unknown })[] = new Array(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      try {
        out[index] = { ok: true, value: await work(items[index]) }
      } catch (error) {
        out[index] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return out
}

let symbols: SymbolInfo[] = []

const pass = singleFlight(async (): Promise<void> => {
  publish({ ...withStep(state, 'universe', 'running', null), running: true })
  const source = scanSourceFor('binance')
  let tickers: Ticker24h[]
  try {
    symbols = await listSymbols('binance')
    tickers = await source.fetchAllTickers24h()
  } catch (error) {
    publish({ ...withStep(state, 'universe', 'failed', describeFailure(error)), running: false })
    return
  }
  const universe = researchUniverse(symbols, tickers)
  const tickerOf = new Map(tickers.map((ticker) => [ticker.symbol, ticker]))
  publish(
    withStep(
      withStep(state, 'universe', 'done', `${universe.length} USDT pairs trading at least $20M a day`, { key: msg('{count} USDT pairs trading at least $20M a day'), values: { count: universe.length } }),
      'movers',
      'running',
      null
    )
  )

  const nowSec = Math.floor(Date.now() / 1000)
  const read = await inBatches(universe, CONCURRENCY, async (pair) => {
    const ticker = tickerOf.get(pair.symbol)
    if (ticker === undefined) throw new Error(`no ticker for ${pair.symbol}`)
    return readResearchPair(pair, ticker, await source.fetchRecentCandles(pair.symbol, '1d', RESEARCH_DAILY_BARS), nowSec)
  })
  // Scored against each other (the V5 document, §15-17), and the funnel's candidates named.
  const pairs = withScores(read.filter((result): result is { ok: true; value: ResearchPair } => result.ok).map((result) => result.value))
  const candidates = candidatesOf(pairs).map((pair) => pair.symbol)
  const missed = read.length - pairs.length
  publish(
    withStep(
      withStep(
        { ...state, pairs: markTrending(pairs, state.trending), candidates },
        'movers',
        'done',
        `${pairs.length} read${missed > 0 ? `, ${missed} could not be` : ''}, ${candidates.length} candidates`,
        missed > 0
          ? { key: msg('{read} read, {missed} could not be, {count} candidates'), values: { read: pairs.length, missed, count: candidates.length } }
          : { key: msg('{read} read, {count} candidates'), values: { read: pairs.length, count: candidates.length } }
      ),
      'market',
      'running',
      null
    )
  )

  try {
    const [btc15m, eth15m] = await Promise.all([
      source.fetchRecentCandles('BTCUSDT', '15m', RESEARCH_MARKET_BARS),
      source.fetchRecentCandles('ETHUSDT', '15m', RESEARCH_MARKET_BARS)
    ])
    const market = marketStatusOf({ btc15m, eth15m, pairs, nowSec: Math.floor(Date.now() / 1000) })
    publish({ ...withStep({ ...state, market }, 'market', 'done', `risk ${market.risk}`, { key: RISK_DETAIL[market.risk], values: {} }), running: false, finishedAt: Math.floor(Date.now() / 1000) })
  } catch (error) {
    publish({ ...withStep(state, 'market', 'failed', describeFailure(error)), running: false, finishedAt: Math.floor(Date.now() / 1000) })
  }
}, () => undefined)

const readTrending = singleFlight(async (): Promise<void> => {
  publish(withStep(state, 'trending', 'running', null))
  try {
    const response = await fetch(TRENDING_URL, { signal: AbortSignal.timeout(TRENDING_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`CoinGecko answered ${response.status}`)
    // Read before anything else is awaited: once the request's timeout fires, Electron's fetch can no
    // longer read the body ("Body is unusable"), and the first listing of the symbols, at a busy start
    // beside the pass's own, has taken longer than that (V6 Stage 14's check).
    const body: unknown = await response.json()
    if (symbols.length === 0) symbols = await listSymbols('binance')
    const trending = parseTrending(body, symbols)
    const matched = trending.filter((coin) => coin.pair !== null).length
    publish({
      ...withStep(state, 'trending', 'done', `${trending.length} ${trending.length === 1 ? 'coin' : 'coins'}, ${matched} with a USDT pair on Binance`, {
        key: msg('{count} coins, {matched} with a USDT pair on Binance'),
        values: { count: trending.length, matched }
      }),
      trending,
      trendingAt: Math.floor(Date.now() / 1000),
      pairs: markTrending(state.pairs, trending)
    })
  } catch (error) {
    // Unavailable is said, and the last list read, if any, is kept with its time.
    publish(
      withStep(state, 'trending', 'failed', `CoinGecko's trending list could not be read: ${describeFailure(error)}`, {
        key: msg("CoinGecko's trending list could not be read: {error}"),
        values: { error: describeFailure(error) }
      })
    )
  }
}, () => undefined)

/** Reads the market now, unless a pass is already reading. */
export async function refreshResearch(): Promise<ResearchState> {
  await Promise.all([pass(), readTrending()])
  return state
}

/** Starts the research at launch, and its clocks. Called once, from electron/main.ts. */
export function startMarketResearch(): void {
  if (started) return
  started = true
  void pass().catch((error) => console.error('Market research failed:', error))
  void readTrending().catch((error) => console.error('Trending could not be read:', error))
  setInterval(() => void pass().catch((error) => console.error('Market research failed:', error)), RESEARCH_REFRESH_MS)
  setInterval(() => void readTrending().catch((error) => console.error('Trending could not be read:', error)), TRENDING_REFRESH_MS)
}
