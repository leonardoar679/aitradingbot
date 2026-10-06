import type { AiConfig } from '../../shared/aiCost'
import type { AiCallRecord } from '../../shared/aiLedger'
import { isActionableOpportunity, opportunityWindow } from '../../shared/aiOpportunity'
import type { AlertSeverity } from '../../shared/alerts'
import { roundTripFee } from '../../shared/fees'
import type { AppSettings, Candle, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import type { LiveConnection } from '../../shared/liveMarket'
import type { MarketEvent } from '../../shared/marketEvent'
import { healPaperRisk } from '../../shared/paperRisk'
import { sessionReportOf, type ReportRecommendation, type ReportSpan, type ReportTradeReading, type SessionReport } from '../../shared/shadowReport'
import { assembleFeed, loadFeedBars, scoreAnswer, type CandleFetch } from '../agents/opportunities'
import { paperRefusals, SESSION_STARTED_SEC, type PaperRefusal } from '../agents/paperRefusals'
import { runExecutorSimulation } from '../executors/engine'
import { subscribeAlerts } from '../news/alertStore'

// WHAT THE SESSION REPORT READS (shared/shadowReport.ts has what it makes of it).
//
// The events, the call ledger and the executors, as far back as the span goes; the stream's log,
// the alerts and the refusals, as far back as this session goes; the news feed's stories; and the
// minute candles of each of the app's own paper trades the span touched, and of each recommendation
// it could act on, to see how far each trade went and whether each recommendation has its outcome.
//
// IT READS AND WRITES NOTHING. It asks no model, opens and closes nothing, and keeps nothing: the
// report is worked out again each time it is asked for.

/** Rows read before the span begins: an event, or an answer, a little older than the span. */
const LEAD_SECONDS = 3600
const ROWS_READ = 5000

export interface SessionReportDeps {
  listEvents: (sinceSec: number) => Promise<MarketEvent[]>
  listCalls: (sinceSec: number) => Promise<AiCallRecord[]>
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperRisk'>>
  getConfig: () => Promise<Pick<AiConfig, 'watchPaper'>>
  /** Null when the stream's log cannot be read. */
  liveConnection: () => Promise<LiveConnection | null>
  stories: () => Promise<{ url: string; publishedAt: number }[]>
  fetchCandles: CandleFetch
  alerts: () => readonly { at: number; severity: AlertSeverity }[]
  refusals: () => readonly PaperRefusal[]
  appStartedSec: number
  nowSec: () => number
}

/** How a trade went on its minutes: where the engine says it entered and left, how far the price
 * went for it and against it while it was held, and what it made before fees and what they were. */
export function readTrade(executor: ExecutorConfig, minutes: Candle[], nowSec: number): ReportTradeReading {
  const none: ReportTradeReading = { executorId: executor.id, entryPrice: null, enteredAt: null, exitPrice: null, bestPct: null, worstPct: null, grossQuote: null, feesQuote: null }
  // Its own minutes, as the settle loops read them: from when it was opened, and closed.
  const own = minutes.filter((bar) => bar.time >= executor.createdAt && bar.time + 60 <= nowSec)
  if (own.length === 0) return none
  const state = runExecutorSimulation(own, executor, own[0].close)
  if (state.kind !== 'position' || state.entryPrice === null || state.enteredAt === null) return none
  const entry = state.entryPrice
  const held = own.filter((bar) => bar.time >= (state.enteredAt as number) && (state.closedAt === null || bar.time <= state.closedAt))
  const high = Math.max(...held.map((bar) => bar.high))
  const low = Math.min(...held.map((bar) => bar.low))
  const long = state.side === 'buy'
  const params = executor.params as PositionExecutorParams
  const quantity = (params.amountQuote * (params.leverage ?? 1)) / entry
  const exit = state.status === 'closed' ? state.exitPrice : null
  return {
    executorId: executor.id,
    entryPrice: entry,
    enteredAt: state.enteredAt,
    exitPrice: exit,
    bestPct: held.length === 0 ? null : long ? (high / entry - 1) * 100 : (1 - low / entry) * 100,
    worstPct: held.length === 0 ? null : long ? (low / entry - 1) * 100 : (1 - high / entry) * 100,
    grossQuote: exit === null ? null : quantity * (exit - entry) * (long ? 1 : -1),
    feesQuote: exit === null ? null : roundTripFee(quantity, entry, exit)
  }
}

/** The report over `span`, from `fromSec` to now. Never throws for one trade or recommendation whose
 * minutes cannot be read: that one reads as not measured, and the report says so. */
export async function buildSessionReport(span: ReportSpan, fromSec: number, deps: SessionReportDeps): Promise<SessionReport> {
  const nowSec = deps.nowSec()
  const [events, calls, settings, config, connection, stories] = await Promise.all([
    deps.listEvents(fromSec - LEAD_SECONDS),
    deps.listCalls(fromSec - LEAD_SECONDS),
    deps.getSettings(),
    deps.getConfig(),
    deps.liveConnection().catch(() => null),
    deps.stories().catch(() => [])
  ])

  // The app's own paper trades the span touched: opened in it, ended in it, or open now.
  const touched = settings.executors.filter((executor) => {
    if (executor.mode !== 'paper' || executor.type !== 'position' || (executor.watch === undefined && executor.newsRule === undefined)) return false
    const result = executor.watch?.result ?? executor.newsRule?.result
    return executor.createdAt >= fromSec || executor.status === 'active' || (result !== undefined && result.closedAt >= fromSec)
  })
  const trades = await Promise.all(
    touched.map(async (executor): Promise<ReportTradeReading> => {
      const result = executor.watch?.result ?? executor.newsRule?.result
      const endSec = Math.min(nowSec, result !== undefined ? result.closedAt + 60 : (executor.stoppedAt ?? nowSec))
      try {
        return readTrade(executor, await deps.fetchCandles(executor.exchange, executor.symbol, '1m', executor.createdAt, endSec), nowSec)
      } catch {
        return { executorId: executor.id, entryPrice: null, enteredAt: null, exitPrice: null, bestPct: null, worstPct: null, grossQuote: null, feesQuote: null }
      }
    })
  )

  // Each recommendation the watch could have acted on, for an event in the span, scored on its minutes.
  const feed = assembleFeed(
    events.filter((event) => event.time >= fromSec && event.time <= nowSec),
    calls.filter((row) => row.source === 'watch')
  ).filter((item) => item.answers.some((answer) => isActionableOpportunity(answer.decision)))
  const bars = await loadFeedBars(feed, nowSec, deps.fetchCandles)
  const recommendations: ReportRecommendation[] = []
  for (const item of feed) {
    const minutes = bars.get(item.event.id) ?? []
    for (const answer of item.answers) {
      if (!isActionableOpportunity(answer.decision)) continue
      const window = opportunityWindow(item.event.time, answer.decision.detail)
      if (window === null) continue
      const outcome = minutes.length === 0 ? null : scoreAnswer(item, answer, minutes, nowSec)
      recommendations.push({
        eventId: item.event.id,
        model: answer.model,
        endsAt: window.expiresAt + window.holdSeconds + 60,
        status: outcome === null ? 'unscored' : outcome.status
      })
    }
  }

  return sessionReportOf({
    span,
    fromSec,
    toSec: nowSec,
    appStartedSec: deps.appStartedSec,
    events,
    calls,
    executors: settings.executors,
    watchPaper: { maxOpen: config.watchPaper.maxOpen, maxSameSide: config.watchPaper.maxSameSide },
    maxOutQuote: healPaperRisk(settings.paperRisk).maxOutQuote,
    connection,
    alerts: [...deps.alerts()],
    refusals: [...deps.refusals()],
    recommendations,
    trades,
    stories
  })
}

/** The same, against the running app. Every call reads. */
export const sessionReportBrowserDeps: SessionReportDeps = {
  listEvents: async (sinceSec) => (await window.api.scanner.listEvents({ sinceSec, limit: ROWS_READ })).rows,
  listCalls: async (sinceSec) => (await window.api.ai.listCalls({ sinceSec, limit: ROWS_READ })).rows,
  getSettings: () => window.api.settings.get(),
  getConfig: () => window.api.ai.getConfig(),
  liveConnection: async () => (await window.api.market.liveState()).connection,
  stories: async () => (await window.api.feed.getState()).stories.map((story) => ({ url: story.url, publishedAt: story.publishedAt })),
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles,
  alerts: () => {
    let held: readonly { at: number; severity: AlertSeverity }[] = []
    subscribeAlerts((alerts) => {
      held = alerts
    })()
    return held
  },
  refusals: () => paperRefusals(),
  appStartedSec: SESSION_STARTED_SEC,
  nowSec: () => Math.floor(Date.now() / 1000)
}

/** The span a choice names: the last hour, the last twelve hours, or since the session began. */
export function spanStart(span: ReportSpan, nowSec: number, sessionStartedSec: number | null): number {
  if (span === 'hour') return nowSec - 3600
  if (span === 'twelve') return nowSec - 43_200
  return sessionStartedSec ?? SESSION_STARTED_SEC
}
