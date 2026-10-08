import { AI_ADDITION_PROMPT_VERSIONS, dailySubjectId, type DailySummary, type DailySummaryRequest } from '../../shared/aiAdditions'
import { dailySummaryQuestionOf, daysBack, type DailyReport } from '../../shared/dailyReport'
import { buildDailyReport, dailyReportBrowserDeps } from './dailyReport'

// THE DAILY SUMMARY, ASKED BY ITSELF (the fifth AI addition, shared/aiAdditions.ts; the user's
// choice of 7 October 2026: on by default, inside the $5 day). Once a day, after 00:05 UTC, while
// the watch is on: the day before's report is built (./dailyReport.ts) and its figures put to the
// model the additions ask, which writes one paragraph. The main process holds it to the addition's
// limit of one call a day, the budget and the watch, like every addition; this look only avoids
// building a report for nothing. The paragraph is shown on Performance beside the report.
//
// IT READS, BUILDS AND ASKS. It writes nothing, and nothing is opened, closed or sized by it.

/** Seconds after midnight UTC before the day before is asked about: 00:05. */
export const DAILY_SUMMARY_AFTER_SEC = 5 * 60
export const DAILY_SUMMARY_LOOK_MS = 5 * 60_000
const DAY = 86_400

export interface DailySummaryDeps {
  watchOn: () => Promise<boolean>
  /** Whether the addition has already been asked about `day` since `sinceSec`, answered or not. */
  askedSince: (day: string, sinceSec: number) => Promise<boolean>
  report: (day: string) => Promise<DailyReport>
  summarize: (request: DailySummaryRequest, automatic: boolean) => Promise<DailySummary>
  nowSec: () => number
}

export interface DailySummaryLook {
  day: string | null
  asked: boolean
  reason: string
}

/** Days this session has tried: one try a day, whatever came of it. */
const tried = new Set<string>()

export async function lookAtDailySummary(deps: DailySummaryDeps): Promise<DailySummaryLook> {
  const nowSec = deps.nowSec()
  const midnight = Math.floor(nowSec / DAY) * DAY
  if (nowSec - midnight < DAILY_SUMMARY_AFTER_SEC) return { day: null, asked: false, reason: 'It is not 00:05 UTC yet.' }
  const day = daysBack(nowSec, 1)[0]
  if (tried.has(day)) return { day, asked: false, reason: 'It was tried this session.' }
  if (!(await deps.watchOn())) return { day, asked: false, reason: 'The watch is off.' }
  if (await deps.askedSince(day, midnight)) {
    tried.add(day)
    return { day, asked: false, reason: 'It was asked today.' }
  }
  tried.add(day)
  const report = await deps.report(day)
  await deps.summarize({ day, question: dailySummaryQuestionOf(report) }, true)
  return { day, asked: true, reason: 'Asked.' }
}

/** Test seam. */
export function resetDailySummaryLook(): void {
  tried.clear()
}

/** The same, against the running app. */
export const dailySummaryBrowserDeps: DailySummaryDeps = {
  watchOn: async () => (await window.api.ai.getConfig()).watch.enabled,
  askedSince: async (day, sinceSec) =>
    (await window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.daily, sinceSec, limit: 50 })).rows.some((row) => row.subjectId === dailySubjectId(day)),
  report: (day) => buildDailyReport(day, dailyReportBrowserDeps),
  summarize: (request, automatic) => window.api.ai.summarizeDay(request, automatic),
  nowSec: () => Math.floor(Date.now() / 1000)
}
