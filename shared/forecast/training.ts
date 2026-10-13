import type { Horizon, PairClass } from './features'
import { DEFAULT_FORECAST_TRADER, healForecastTrader, type ForecastTraderSettings } from './trader'
import type { ForecastModelId } from './models'
import { promotionChecklist, type CheckLine } from './promotion'
import type { ModelScore } from './walkForward'

// WHEN THE FORECAST IS FITTED, AND WHAT A FIT EARNS (the V6 document, §104; V6 Stage 5, 13 October 2026).
//
// THE FIRST FIT is made as soon as the forecast's bars are there for enough pairs, the walk forward
// after it in the background. THE NIGHTLY REFIT, at half past midnight UTC, fits again on the newest
// ninety days; a night the app was not running is made up at the next start. It is a setting
// (settings.json `forecast.refitNightly`, on unless switched off on Forecast Lab): public data, no
// spend, a few minutes of one core.
//
// WHAT A FIT EARNS: each model at each horizon weighs in the forecast only once the walk forward's
// out-of-sample record promotes it (shared/forecast/promotion.ts). The newest fit's models are the
// ones run; the newest walk forward's verdicts are the ones that say which of them weigh.

export const MIN_READY_PAIRS = 20
export const NIGHTLY_UTC = { hour: 0, minute: 30 } as const
/** A fit older than this at a start is made again, when the nightly refit is on. */
export const STALE_FIT_SECONDS = 26 * 3600
/** The runs kept on file: the one in use and the one before it. */
export const RUNS_KEPT = 2

export interface ForecastSettings {
  refitNightly: boolean
  /** The forecast trader (V6 Stage 12; shared/forecast/trader.ts): off until switched on. */
  trader: ForecastTraderSettings
}

export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = { refitNightly: true, trader: DEFAULT_FORECAST_TRADER }

/** A stored setting, read as one: only `false` switches the nightly refit off, and the trader is healed
 * as its own. */
export function healForecastSettings(value: unknown): ForecastSettings {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  return { refitNightly: raw.refitNightly !== false, trader: healForecastTrader(raw.trader) }
}

/** The next half past midnight UTC after `nowSec`. */
export function nextNightlyAt(nowSec: number): number {
  const day = Math.floor(nowSec / 86_400) * 86_400
  const today = day + NIGHTLY_UTC.hour * 3600 + NIGHTLY_UTC.minute * 60
  return nowSec < today ? today : today + 86_400
}

/** Whether a fit is due at a start: none was ever made, or the last is stale and the refit is on. */
export function fitDueAtStart(lastFittedAt: number | null, nowSec: number, settings: ForecastSettings): boolean {
  if (lastFittedAt === null) return true
  return settings.refitNightly && nowSec - lastFittedAt >= STALE_FIT_SECONDS
}

/** A run's name from its moment, e.g. run-20261013-0230. */
export function runIdAt(nowSec: number): string {
  const iso = new Date(nowSec * 1000).toISOString()
  return `run-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 13)}${iso.slice(14, 16)}`
}

export const RUN_PATTERN = /^run-\d{8}-\d{4}$/

/** Of the runs on file, those to delete: all but the RUNS_KEPT newest, and never one in use. */
export function runsToSweep(runIds: readonly string[], inUse: readonly string[]): string[] {
  const runs = runIds.filter((id) => RUN_PATTERN.test(id)).sort()
  const keep = new Set([...runs.slice(-RUNS_KEPT), ...inUse])
  return runs.filter((id) => !keep.has(id))
}

export interface ScoredModel {
  model: ForecastModelId
  overall: ModelScore
  byClass: Partial<Record<PairClass, ModelScore>>
}

export interface Promotion {
  horizon: Horizon
  model: ForecastModelId
  promoted: boolean
  lines: CheckLine[]
}

/** Each model's verdict at each horizon from a walk forward's scores. Persistence is the floor: always
 * weighing, never judged against itself. */
export function promotionsOf(horizons: readonly { horizon: Horizon; scores: readonly ScoredModel[] }[]): Promotion[] {
  const out: Promotion[] = []
  for (const { horizon, scores } of horizons) {
    const floor = scores.find((score) => score.model === 'persistence')
    if (floor === undefined) continue
    for (const score of scores) {
      if (score.model === 'persistence') {
        out.push({ horizon, model: 'persistence', promoted: true, lines: [{ id: 'outcomes', ok: true, text: 'the floor every model is judged against' }] })
        continue
      }
      const verdict = promotionChecklist(score.overall, floor.overall, null)
      out.push({ horizon, model: score.model, promoted: verdict.promoted, lines: verdict.lines })
    }
  }
  return out
}
