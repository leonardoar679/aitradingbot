import type { ForecastRunSection } from '../../shared/forecast/runSection'
import { LAB_STRATEGIES, labStatsOf } from '../../shared/forecast/labTrader'
import type { AppSettings, ExecutorConfig } from '../../shared/ipc'
import type { ResearchStatus } from '../../shared/research'
import { experimentReportBrowserDeps, forecastOver, type ExperimentReportDeps } from '../ai-benchmark/experimentReport'
import { buildDailyReport, dailyReportBrowserDeps, type DailyReportDeps } from './dailyReport'
import { buildSessionReport, sessionReportBrowserDeps, type SessionReportDeps } from './sessionReport'

// THE RESEARCH FOLDER'S REPORTS (V7.2-R Stage 2, 20 October 2026; electron/services/researchFolderService.ts):
// the hour's and the day's, built in the window from what the Performance page and a run's report already
// build -- the session report over the span, the forecast's section over it, and the paper laboratory's, the
// forecast trader's and the account's standing -- and handed to the main process to keep. Each look writes the
// last completed hour once it is due and the day before once 00:10 UTC has passed, where the folder does not
// hold them yet. An hour the app was closed for is not built later: the records hold it, and the export packs
// them. It reads, and asks no model.

export interface ResearchReportDeps {
  nowSec: () => number
  status: () => Promise<ResearchStatus>
  write: (request: { kind: 'hour' | 'day'; stamp: string; report: unknown }) => Promise<unknown>
  settings: () => Promise<AppSettings>
  session: SessionReportDeps
  experiment: ExperimentReportDeps
  daily: DailyReportDeps
}

/** How often the window looks. */
export const RESEARCH_REPORT_LOOK_MS = 5 * 60_000
/** A completed hour's report is built this long after the hour, so that its records are written. */
const HOUR_SETTLE_SEC = 3 * 60
/** The day before's, from this long after midnight UTC. */
const DAY_SETTLE_SEC = 10 * 60

/** The last completed hour, settled: its stamp (YYYY-MM-DD-HH, its start) and its span. */
export function dueHour(nowSec: number): { stamp: string; fromSec: number; toSec: number } {
  const toSec = Math.floor((nowSec - HOUR_SETTLE_SEC) / 3600) * 3600
  const fromSec = toSec - 3600
  const iso = new Date(fromSec * 1000).toISOString()
  return { stamp: `${iso.slice(0, 10)}-${iso.slice(11, 13)}`, fromSec, toSec }
}

/** The day before, once settled: its stamp (YYYY-MM-DD) and its span. Before 00:10 UTC it is the day before
 * that, already kept, so nothing is built until the day has settled. */
export function dueDay(nowSec: number): { stamp: string; fromSec: number; toSec: number } {
  const toSec = Math.floor((nowSec - DAY_SETTLE_SEC) / 86_400) * 86_400
  const fromSec = toSec - 86_400
  return { stamp: new Date(fromSec * 1000).toISOString().slice(0, 10), fromSec, toSec }
}

/** The paper side over a span: the account, each laboratory strategy, and the forecast trader's trades. */
export function paperPerformanceOf(settings: Pick<AppSettings, 'executors' | 'paperAccount'>, fromSec: number, toSec: number): Record<string, unknown> {
  const executors: ExecutorConfig[] = settings.executors ?? []
  const equity = settings.paperAccount?.balances?.USDT ?? null
  const forecastTrades = executors.filter((executor) => executor.forecast !== undefined)
  const closedInSpan = forecastTrades.filter((executor) => executor.forecast?.result !== undefined && executor.forecast.result.closedAt >= fromSec && executor.forecast.result.closedAt < toSec)
  return {
    account: settings.paperAccount === null || settings.paperAccount === undefined ? null : { balances: settings.paperAccount.balances, initialBalances: settings.paperAccount.initialBalances },
    lab: LAB_STRATEGIES.map((strategy) => labStatsOf(executors, strategy, equity)),
    forecastTrader: {
      opened: forecastTrades.filter((executor) => executor.forecast!.openedAt >= fromSec && executor.forecast!.openedAt < toSec).length,
      closed: closedInSpan.length,
      netQuote: closedInSpan.reduce((sum, executor) => sum + (executor.forecast?.result?.pnlQuote ?? 0), 0),
      open: forecastTrades.filter((executor) => executor.status === 'active').length
    },
    openPaper: executors.filter((executor) => executor.mode === 'paper' && executor.status === 'active').length
  }
}

async function forecastOf(fromSec: number, toSec: number, settings: AppSettings, deps: ResearchReportDeps): Promise<ForecastRunSection | null> {
  return forecastOver({ fromSec, toSec }, settings.executors ?? [], deps.experiment).catch(() => null)
}

/** One look: the hour's report and the day's, each where it is due and not yet kept. What was written. */
export async function lookAtResearchReports(deps: ResearchReportDeps): Promise<{ hour: string | null; day: string | null }> {
  const nowSec = deps.nowSec()
  const status = await deps.status()
  const written: { hour: string | null; day: string | null } = { hour: null, day: null }
  const hour = dueHour(nowSec)
  if (status.latestHour === null || status.latestHour < hour.stamp) {
    const settings = await deps.settings()
    const [session, forecast] = await Promise.all([buildSessionReport('hour', hour.fromSec, deps.session, hour.toSec), forecastOf(hour.fromSec, hour.toSec, settings, deps)])
    await deps.write({ kind: 'hour', stamp: hour.stamp, report: { fromSec: hour.fromSec, toSec: hour.toSec, session, forecast, paper: paperPerformanceOf(settings, hour.fromSec, hour.toSec) } })
    written.hour = hour.stamp
  }
  const day = dueDay(nowSec)
  if (status.latestDay === null || status.latestDay < day.stamp) {
    const settings = await deps.settings()
    const [daily, forecast] = await Promise.all([buildDailyReport(day.stamp, deps.daily).catch(() => null), forecastOf(day.fromSec, day.toSec, settings, deps)])
    await deps.write({ kind: 'day', stamp: day.stamp, report: { fromSec: day.fromSec, toSec: day.toSec, daily, forecast, paper: paperPerformanceOf(settings, day.fromSec, day.toSec) } })
    written.day = day.stamp
  }
  return written
}

/** Against the running app. */
export const researchReportBrowserDeps: ResearchReportDeps = {
  nowSec: () => Math.floor(Date.now() / 1000),
  status: () => window.api.researchFolder.status(),
  write: (request) => window.api.researchFolder.writeReport(request),
  settings: () => window.api.settings.get(),
  session: sessionReportBrowserDeps,
  experiment: experimentReportBrowserDeps,
  daily: dailyReportBrowserDeps
}
