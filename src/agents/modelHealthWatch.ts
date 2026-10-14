import { ENGLISH, type I18n } from '../../shared/i18n/translate'
import type { AiConfig } from '../../shared/aiCost'
import { summarizeEventBenchmark } from '../../shared/aiEventBenchmark'
import { describeModelHealth, modelHealth, type ModelHealth } from '../../shared/modelHealth'
import { breakerNotice, type NoticeExtra } from '../../shared/notices'
import { loadLiveBars, readLiveAnswers, type LiveBoardDeps } from './liveBoard'

// THE DAILY LOOK AT EACH MODEL'S HEALTH (shared/modelHealth.ts): the watch's models, each scored
// on its own answers of the last thirty days as the live board scores them, and marked DEGRADED
// where its last thirty closed trades say so. One notice a day a model, on its own thread; the mark
// for the registry and the Watch card is published here for the session and stored nowhere.
//
// IT READS: the setting (which models), the ledger, the scanner's events and public candles, one
// request an event not already held. It asks no model and switches nothing off: the models the
// watch asks are chosen by a person on Opportunities.

/** The newest events read for the look: thirty closed trades need fewer, and more is more
 * requests for the same thirty. */
export const HEALTH_EVENTS_READ = 150

export interface ModelHealthDeps extends LiveBoardDeps {
  getConfig: () => Promise<AiConfig>
  notify: (title: string, body: string, extra?: NoticeExtra) => void
  nowSec: () => number
  /** The language its notice is said in (V6 Stage 14); English where absent. */
  i18n?: () => I18n
}

export interface ModelHealthReport {
  /** When it was read, in seconds. */
  at: number
  models: Record<string, ModelHealth>
}

let report: ModelHealthReport | null = null
const listeners = new Set<(report: ModelHealthReport) => void>()

export function getModelHealthReport(): ModelHealthReport | null {
  return report
}

export function subscribeModelHealth(listener: (report: ModelHealthReport) => void): () => void {
  listeners.add(listener)
  return (): void => {
    listeners.delete(listener)
  }
}

/** Test seam. */
export function resetModelHealth(): void {
  report = null
  listeners.clear()
}

export async function lookAtModelHealth(deps: ModelHealthDeps): Promise<ModelHealthReport> {
  const nowSec = deps.nowSec()
  const models = (await deps.getConfig()).watch.models
  const next: ModelHealthReport = { at: nowSec, models: {} }
  if (models.length > 0) {
    const live = await readLiveAnswers(models, nowSec, deps)
    const from = Math.max(0, live.events.length - HEALTH_EVENTS_READ)
    const events = live.events.slice(from)
    const bars = await loadLiveBars(events, nowSec, deps.fetchCandles)
    for (const model of models) {
      // Each on its own answers: a row compared across models covers only the events every one
      // of them answered, and a model's health is its own.
      const row = summarizeEventBenchmark({
        events,
        models: [model],
        answers: { [model]: (live.answers[model] ?? []).slice(from) },
        answeredAt: { [model]: (live.answeredAt[model] ?? []).slice(from) },
        bars,
        nowSec
      }).models[0]
      const health = modelHealth(row)
      next.models[model] = health
      if (health.degraded) {
        const say = deps.i18n?.() ?? ENGLISH
        const notice = breakerNotice('degraded', describeModelHealth(model, health, say), `degraded:${model}`, say)
        deps.notify(notice.title, notice.body, notice.extra)
      }
    }
  }
  report = next
  for (const listener of listeners) listener(next)
  return next
}
