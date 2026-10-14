import { summarizeEventBenchmark } from '../../shared/aiEventBenchmark'
import { doesAiHelp, eventNewsOf } from '../../shared/aiHelp'
import { experimentReportOf, experimentSpan, type ExperimentReport, type ExperimentRun } from '../../shared/experimentRun'
import { forecastRunSectionOf, type ForecastRunSection } from '../../shared/forecast/runSection'
import type { ExecutorConfig, ForecastHistory } from '../../shared/ipc'
import { sessionReportOf } from '../../shared/shadowReport'
import { loadLiveBars, readLiveAnswers, withReviewer } from '../agents/liveBoard'
import { loadQuantData, type QuantFetch } from '../agents/quantState'
import { collectSessionReportInput, sessionReportBrowserDeps, type SessionReportDeps } from '../performance/sessionReport'

// AN EXPERIMENT'S REPORT (shared/experimentRun.ts; the V5 document, §58-62 and §124-126), built in
// the window once the run has ended, from what is on file: the session report over the run's span,
// the document's five further gates over the same input, "Does AI help?" over the span's events
// for each model the watch asked (the quant rows, holding, the model, the hybrids), the costs, the
// verdict by the pinned lines, and since V6 Stage 15 the price forecast over the span with its gates
// (shared/forecast/runSection.ts). It reads; it asks no model and opens nothing.

export interface ExperimentReportDeps {
  session: SessionReportDeps
  listCalls: Parameters<typeof readLiveAnswers>[2]['listCalls']
  listEvents: Parameters<typeof readLiveAnswers>[2]['listEvents']
  /** The two quant strategies' bars (src/agents/quantState.ts), on their own intervals. */
  fetchQuant: QuantFetch
  /** The stories' marks over the span, for the news verdict; null where they cannot be read. */
  storyMarks: (fromSec: number, toSec: number) => Promise<Parameters<typeof eventNewsOf>[1] | null>
  /** Every pair's forecasts made in the span and their outcomes on file. */
  forecastRecord: (fromSec: number, toSec: number) => Promise<ForecastHistory>
  /** The notices on file since a moment, with the sound each made. */
  alertsOnFile: (sinceSec: number) => Promise<readonly { at: number; sound?: string }[]>
}

/** "Does AI help?" over the span's events, one entry a model the watch asked. A model that answered
 * nothing in the span, or events whose candles could not be read, give an empty list. */
async function helpOver(run: ExperimentRun, deps: ExperimentReportDeps, nowSec: number): Promise<ExperimentReport['help']> {
  if (run.models.length === 0) return []
  const span = experimentSpan(run)
  try {
    const live = await readLiveAnswers(run.models, nowSec, deps, span)
    if (live.events.length === 0) return []
    const bars = await loadLiveBars(live.events, nowSec, deps.session.fetchCandles)
    const quant = await loadQuantData(live.events, { startSec: span.fromSec, endSec: span.toSec }, deps.fetchQuant)
    const summary = summarizeEventBenchmark({ events: live.events, ...withReviewer(live, run.models), bars, quant: quant.states, nowSec })
    const marks = await deps.storyMarks(span.fromSec - 3 * 3600, span.toSec).catch(() => null)
    const news = marks === null ? null : eventNewsOf(live.events, marks)
    return run.models.filter((model) => summary.models.some((row) => row.name === model)).map((model) => ({ model, ...doesAiHelp({ summary, model, events: live.events, news }) }))
  } catch {
    return []
  }
}

/** The price forecast over the span (V6 Stage 15); null where its record could not be read. */
async function forecastOver(span: { fromSec: number; toSec: number }, executors: readonly ExecutorConfig[], deps: ExperimentReportDeps): Promise<ForecastRunSection | null> {
  try {
    const [record, alerts] = await Promise.all([deps.forecastRecord(span.fromSec, span.toSec), deps.alertsOnFile(span.fromSec)])
    return forecastRunSectionOf({ fromSec: span.fromSec, toSec: span.toSec, predictions: record.predictions, outcomes: record.outcomes, executors, alerts })
  } catch {
    return null
  }
}

/** The report for an ended run. */
export async function buildExperimentReport(run: ExperimentRun, deps: ExperimentReportDeps): Promise<ExperimentReport> {
  const span = experimentSpan(run)
  const nowSec = deps.session.nowSec()
  const sessionInput = await collectSessionReportInput('session', span.fromSec, deps.session, span.toSec)
  const session = sessionReportOf(sessionInput)
  const help = await helpOver(run, deps, nowSec)
  const forecast = await forecastOver(span, sessionInput.executors, deps)
  return experimentReportOf({ session, sessionInput, help, forecast })
}

/** Against the running app. Every call reads. */
export const experimentReportBrowserDeps: ExperimentReportDeps = {
  session: sessionReportBrowserDeps,
  listCalls: (filter) => window.api.ai.listCalls(filter),
  listEvents: (filter) => window.api.scanner.listEvents(filter),
  fetchQuant: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles,
  storyMarks: (fromSec, toSec) => window.api.feed.history(fromSec, toSec),
  forecastRecord: (fromSec, toSec) => window.api.forecast.record(fromSec, toSec),
  alertsOnFile: async (sinceSec) => (await window.api.records.alerts({ sinceSec })).rows
}
