import type { AiConfig } from '../../shared/aiCost'
import type { AiCallRecord } from '../../shared/aiLedger'
import { isActionableOpportunity, opportunityWindow } from '../../shared/aiOpportunity'
import type { AlertSeverity } from '../../shared/alerts'
import { roundTripFee } from '../../shared/fees'
import type { AppSettings, Candle, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import type { LiveConnection } from '../../shared/liveMarket'
import { EVENT_DETECTOR_VERSION, type MarketEvent } from '../../shared/marketEvent'
import { healPaperRisk } from '../../shared/paperRisk'
import { sessionReportOf, type ReportRecommendation, type ReportSpan, type ReportTradeReading, type SessionReport } from '../../shared/shadowReport'
import { assembleFeed, loadFeedBars, scoreAnswer, type CandleFetch } from '../agents/opportunities'
import { paperRefusals, SESSION_STARTED_SEC, type PaperRefusal } from '../agents/paperRefusals'
import { runExecutorSimulation } from '../executors/engine'
import { subscribeAlerts } from '../news/alertStore'

// WHAT THE SESSION REPORT READS (shared/shadowReport.ts has what it makes of it).
//
// The events, the call ledger, the executors and, since 8 October 2026, the alerts and the refusals
// (shared/records.ts), as far back as the span goes; the stream's log, as far back as this session
// goes; the news feed's stories; the configuration's versions (shared/appConfig.ts); and the
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
  /** The alerts told and the paper trades refused at or after `sinceSec`: this session's and the
   * file's together. */
  alerts: (sinceSec: number) => Promise<readonly { at: number; severity: AlertSeverity }[]>
  refusals: (sinceSec: number) => Promise<readonly PaperRefusal[]>
  /** The configuration's versions; null where they cannot be read. */
  effectiveConfig: () => Promise<{ configVersion: string; engineVersion: string } | null>
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
export async function buildSessionReport(span: ReportSpan, fromSec: number, deps: SessionReportDeps, toSec?: number): Promise<SessionReport> {
  const nowSec = deps.nowSec()
  // The span's end: now, or a past moment for a day that is over (the daily report, ./dailyReport.ts).
  const endSec = Math.min(toSec ?? nowSec, nowSec)
  const [events, calls, settings, config, connection, stories, alerts, refusals, versionsRead] = await Promise.all([
    deps.listEvents(fromSec - LEAD_SECONDS),
    deps.listCalls(fromSec - LEAD_SECONDS),
    deps.getSettings(),
    deps.getConfig(),
    deps.liveConnection().catch(() => null),
    deps.stories().catch(() => []),
    deps.alerts(fromSec).catch(() => []),
    deps.refusals(fromSec).catch(() => []),
    deps.effectiveConfig().catch(() => null)
  ])
  // The versions the span's calls were made under, and the configuration's now.
  const inSpan = calls.filter((row) => row.at >= fromSec && row.at <= endSec)
  const distinct = (values: string[]): string[] => [...new Set(values)].sort()
  const versions =
    versionsRead === null
      ? null
      : { config: versionsRead.configVersion, engine: versionsRead.engineVersion, detector: EVENT_DETECTOR_VERSION, prompts: distinct(inSpan.map((row) => row.promptVersion)), schemas: distinct(inSpan.map((row) => row.schemaVersion)) }

  // The app's own paper trades the span touched: opened in it, ended in it, or open now.
  const touched = settings.executors.filter((executor) => {
    if (executor.mode !== 'paper' || executor.type !== 'position' || (executor.watch === undefined && executor.newsRule === undefined)) return false
    const result = executor.watch?.result ?? executor.newsRule?.result
    const opened = executor.createdAt >= fromSec && executor.createdAt <= endSec
    const ended = result !== undefined && result.closedAt >= fromSec && result.closedAt <= endSec
    return opened || ended || (executor.status === 'active' && executor.createdAt <= endSec)
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
    events.filter((event) => event.time >= fromSec && event.time <= endSec),
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
    toSec: endSec,
    appStartedSec: deps.appStartedSec,
    events,
    calls,
    executors: settings.executors,
    watchPaper: { maxOpen: config.watchPaper.maxOpen, maxSameSide: config.watchPaper.maxSameSide },
    maxOutQuote: healPaperRisk(settings.paperRisk).maxOutQuote,
    connection,
    alerts: [...alerts],
    refusals: [...refusals],
    recommendations,
    trades,
    stories,
    versions
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
  // This session's, and the file's for the span, put together by id (shared/records.ts).
  alerts: async (sinceSec) => {
    let held: readonly { id: string; at: number; severity: AlertSeverity }[] = []
    subscribeAlerts((alerts) => {
      held = alerts
    })()
    const onFile = await window.api.records.alerts({ sinceSec }).catch(() => ({ rows: [] }))
    return [...held, ...onFile.rows.filter((row) => !held.some((entry) => entry.id === row.id))].map((entry) => ({ at: entry.at, severity: entry.severity }))
  },
  refusals: async (sinceSec) => {
    const session = paperRefusals()
    const onFile = await window.api.records.refusals({ sinceSec }).catch(() => ({ rows: [] }))
    return [...session, ...onFile.rows.filter((row) => !session.some((entry) => entry.id === row.id))]
  },
  effectiveConfig: async () => {
    const config = await window.api.effectiveConfig()
    return { configVersion: config.configVersion, engineVersion: config.engineVersion }
  },
  appStartedSec: SESSION_STARTED_SEC,
  nowSec: () => Math.floor(Date.now() / 1000)
}

/** The span a choice names: the last hour, the last twelve hours, the last day, or since the session
 * began. */
export function spanStart(span: ReportSpan, nowSec: number, sessionStartedSec: number | null): number {
  if (span === 'hour') return nowSec - 3600
  if (span === 'twelve') return nowSec - 43_200
  if (span === 'day') return nowSec - 86_400
  return sessionStartedSec ?? SESSION_STARTED_SEC
}
