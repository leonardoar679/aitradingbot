import { summarizeEventBenchmark } from '../../shared/aiEventBenchmark'
import type { AiCallRecord } from '../../shared/aiLedger'
import { dailyReport, dayBounds, type DailyReport, type DailyReportInput } from '../../shared/dailyReport'
import type { Candle, Exchange, Interval } from '../../shared/ipc'
import { FEED_KEEP_SECONDS, type ReadStory, type StoryReaction } from '../../shared/newsFeed'
import { healPaperPause } from '../../shared/paperPause'
import type { SessionReport } from '../../shared/shadowReport'
import { loadLiveBars, readLiveAnswers, type LiveBoardDeps } from '../agents/liveBoard'
import { buildSessionReport, sessionReportBrowserDeps } from './sessionReport'

// WHAT THE DAILY REPORT READS (shared/dailyReport.ts has what it makes of it).
//
// The session report over the day (./sessionReport.ts: the events, the calls, the executors, the
// alerts and the refusals on file, and the minutes of each of the app's own paper trades the day
// touched); the daily bars of the scanner's pairs and the hours of Bitcoin and ether, public
// candles; the feed's stories and their reactions; the watch's answers of the last thirty days,
// scored as the live board scores them (src/agents/liveBoard.ts); the ledger for the day's spend;
// the paper pause, the AI budget, and the health pauses on file.
//
// IT READS AND WRITES NOTHING. It asks no model: the summary is asked elsewhere, once a day
// (./dailySummary.ts), and shown beside the report.

export type DayCandleFetch = (exchange: Exchange, symbol: string, interval: Interval, startSec: number, endSec: number) => Promise<Candle[]>

export interface DailyReportDeps {
  session: (fromSec: number, toSec: number) => Promise<SessionReport>
  scannerSymbols: () => Promise<string[]>
  fetchCandles: DayCandleFetch
  feed: () => Promise<{ stories: ReadStory[]; reactions: Record<string, StoryReaction> }>
  watchModels: () => Promise<string[]>
  live: Pick<LiveBoardDeps, 'listCalls' | 'listEvents' | 'fetchCandles'>
  listCalls: (sinceSec: number) => Promise<AiCallRecord[]>
  pause: () => Promise<DailyReportInput['pause']>
  aiCapUsd: () => Promise<number>
  healthPauses: (fromSec: number, toSec: number) => Promise<number>
  nowSec: () => number
}

/** Pairs whose day is read, at most: the scanner's, in its order. */
export const DAILY_PAIRS_READ = 100
const FETCH_AT_ONCE = 4
const ROWS_READ = 5000
const DAY = 86_400

export async function buildDailyReport(day: string, deps: DailyReportDeps, options: { onProgress?: (text: string) => void } = {}): Promise<DailyReport> {
  const { fromSec, toSec } = dayBounds(day)
  const nowSec = deps.nowSec()
  if (toSec > nowSec) throw new Error(`${day} is not over yet (UTC).`)
  options.onProgress?.("Reading the day's records…")
  const [session, symbols, feed, models, calls, pause, aiCapUsd, healthPauses] = await Promise.all([
    deps.session(fromSec, toSec),
    deps.scannerSymbols().catch(() => []),
    deps.feed().catch(() => ({ stories: [], reactions: {} })),
    deps.watchModels().catch(() => []),
    deps.listCalls(fromSec).catch(() => []),
    deps.pause(),
    deps.aiCapUsd().catch(() => 0),
    deps.healthPauses(fromSec, toSec).catch(() => 0)
  ])
  options.onProgress?.("Reading Bitcoin's and ether's hours…")
  const [btcHours, ethHours] = await Promise.all([
    deps.fetchCandles('binance', 'BTCUSDT', '1h', fromSec - DAY, toSec).catch(() => []),
    deps.fetchCandles('binance', 'ETHUSDT', '1h', fromSec - DAY, toSec).catch(() => [])
  ])
  const dailyBars: Record<string, Candle[]> = {}
  const pairs = symbols.slice(0, DAILY_PAIRS_READ)
  let done = 0
  for (let index = 0; index < pairs.length; index += FETCH_AT_ONCE) {
    await Promise.all(
      pairs.slice(index, index + FETCH_AT_ONCE).map(async (symbol) => {
        try {
          dailyBars[symbol] = await deps.fetchCandles('binance', symbol, '1d', fromSec - DAY, toSec)
        } catch {
          // A pair whose day could not be read is not among the movers.
        }
        options.onProgress?.(`Reading the pairs' days: ${++done} of ${pairs.length}…`)
      })
    )
  }
  let modelRows: DailyReportInput['modelRows'] = []
  if (models.length > 0) {
    options.onProgress?.("Scoring the models' last thirty days…")
    const live = await readLiveAnswers(models, nowSec, deps.live)
    const bars = await loadLiveBars(live.events, nowSec, deps.live.fetchCandles)
    modelRows = summarizeEventBenchmark({ events: live.events, models, answers: live.answers, answeredAt: live.answeredAt, bars, nowSec }).models
  }
  return dailyReport({
    day,
    nowSec,
    session,
    dailyBars,
    btcHours,
    ethHours,
    stories: feed.stories,
    reactions: feed.reactions,
    storiesKept: nowSec - toSec <= FEED_KEEP_SECONDS,
    modelRows,
    calls,
    pause,
    aiCapUsd,
    healthPauses
  })
}

/** The same, against the running app. Every call reads. */
export const dailyReportBrowserDeps: DailyReportDeps = {
  session: (fromSec, toSec) => buildSessionReport('day', fromSec, sessionReportBrowserDeps, toSec),
  scannerSymbols: async () => (await window.api.scanner.getState()).pairs.map((pair) => pair.symbol),
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles,
  feed: async () => {
    const state = await window.api.feed.getState()
    return { stories: state.stories, reactions: state.reactions }
  },
  watchModels: async () => (await window.api.ai.getConfig()).watch.models,
  live: {
    listCalls: (filter) => window.api.ai.listCalls(filter),
    listEvents: (filter) => window.api.scanner.listEvents(filter),
    fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles
  },
  listCalls: async (sinceSec) => (await window.api.ai.listCalls({ sinceSec, limit: ROWS_READ })).rows,
  pause: async () => healPaperPause((await window.api.settings.get()).paperPause),
  aiCapUsd: async () => (await window.api.ai.getConfig()).dailyCapUsd,
  // LIVE TRADING PAUSED by the exchange's health, as the notices on file have it (shared/records.ts).
  healthPauses: async (fromSec, toSec) => (await window.api.records.alerts({ sinceSec: fromSec })).rows.filter((row) => row.at < toSec && row.kind === 'CIRCUIT_BREAKER' && row.thread === 'health').length,
  nowSec: () => Math.floor(Date.now() / 1000)
}
