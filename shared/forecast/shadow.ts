import { pairedHorizonOf, type PairedHorizon } from './challenger'
import { HORIZONS, type Horizon } from './features'
import { isMissing, type MissingOutcomeLine, type OutcomeLine, type PredictionLine } from './forecastRecord'
import type { ScoredRow } from './runCalibration'
import type { Promotion } from './training'

// A CHALLENGER PROVEN FORWARD (V7.2-R Stage 8, 22 October 2026; challenger-v3). A refit whose walk forward clears the
// run in use beyond noise (challenger-v2, shared/forecast/challenger.ts compareRuns) is no longer put in use at once: it
// forecasts beside the run in use for a week, at every close the same pairs from the same bars -- recorded in its own
// files, shown nowhere, traded on by nothing -- and is judged on what came. Each horizon's grid forecasts of the two are
// paired on the same pair and close, the realized move scored against each one's levels (the pinball loss, the share
// inside the 80% range) and its P(up) (the Brier score against an even chance), and the difference read with its 90%
// interval by hour blocks, as the walk forward pairs two runs (pairedHorizonOf). The challenger is adopted where no
// horizon read is worse beyond noise and its floor; where one is worse, it is dropped and the run in use stays; with too
// few paired outcomes at every horizon to read, it is dropped too, unread. Weeks on the hours a walk forward tested say
// how a refit would have done; a week live says how it does now, on the market the run in use faces.
//
// Arithmetic on the record: no key, no model of anyone else's, no order.

export const SHADOW_VERSION = 'shadow-v1'

export const SHADOW_LINES = {
  /** How long a challenger forecasts beside the run in use before it is judged. */
  days: 7,
  /** The paired live outcomes a horizon needs for its comparison to be read. */
  minPairs: 200
} as const

/** A challenger in its shadow week, as current.json keeps it. */
export interface ShadowRun {
  runId: string
  foldsRunId: string
  promotions: Promotion[]
  since: number
  until: number
  /** The run in use it was set against, and the walk forward's verdict in a line. */
  championRunId: string
  summary: string
}

export function healShadowRun(value: unknown): ShadowRun | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Partial<ShadowRun>
  if (typeof raw.runId !== 'string' || typeof raw.foldsRunId !== 'string' || !Array.isArray(raw.promotions) || typeof raw.since !== 'number' || typeof raw.until !== 'number' || typeof raw.championRunId !== 'string') return null
  return { runId: raw.runId, foldsRunId: raw.foldsRunId, promotions: raw.promotions, since: raw.since, until: raw.until, championRunId: raw.championRunId, summary: typeof raw.summary === 'string' ? raw.summary : '' }
}

/** A record's grid forecasts at a horizon, read at closes in [from, to), joined to their measured outcomes, as the
 * walk forward's scored rows are: the shown levels and the realized move in percent, the P(up), an even chance for
 * the base. Keyed by pair and close, so that two records can be paired. */
export function liveRowsOf(predictions: readonly PredictionLine[], outcomes: readonly (OutcomeLine | MissingOutcomeLine)[], horizon: Horizon, from: number, to: number): Map<string, ScoredRow> {
  const measured = new Map<string, OutcomeLine>()
  for (const line of outcomes) if (!isMissing(line) && line.h === horizon) measured.set(line.id, line)
  const out = new Map<string, ScoredRow>()
  for (const line of predictions) {
    if (line.why !== 'grid' || line.t < from || line.t >= to) continue
    const entry = line.h[horizon]
    const outcome = measured.get(line.id)
    if (entry === undefined || outcome === undefined || entry.q.length !== 5) continue
    out.set(`${line.pair}|${line.t}`, { t: line.t, pair: line.pair, cls: line.cls, regime: line.regime, week: 0, quantiles: entry.q, floor: [], z: outcome.move, raw: 0, pUp: entry.pUp, base: 0.5 })
  }
  return out
}

export interface ShadowHorizon {
  pairs: number
  /** Null where fewer than SHADOW_LINES.minPairs pairs, or too few hours for an interval, were there. */
  paired: PairedHorizon | null
  worse: boolean
  better: boolean
}

export interface ShadowVerdict {
  version: string
  adopted: boolean
  why: 'not-worse' | 'worse' | 'unread'
  horizons: Partial<Record<Horizon, ShadowHorizon>>
  summary: string
}

export interface LiveRecord {
  predictions: readonly PredictionLine[]
  outcomes: readonly (OutcomeLine | MissingOutcomeLine)[]
}

/** The shadow week's verdict: the two records paired at each horizon over [from, to). */
export function shadowVerdictOf(champion: LiveRecord, shadow: LiveRecord, from: number, to: number): ShadowVerdict {
  const horizons: ShadowVerdict['horizons'] = {}
  for (const horizon of HORIZONS) {
    const a = liveRowsOf(champion.predictions, champion.outcomes, horizon, from, to)
    const b = liveRowsOf(shadow.predictions, shadow.outcomes, horizon, from, to)
    const keys = [...a.keys()].filter((key) => b.has(key)).sort()
    const paired = keys.length < SHADOW_LINES.minPairs ? null : pairedHorizonOf(keys.map((key) => a.get(key)!), keys.map((key) => b.get(key)!), horizon)
    const worse = paired !== null && (paired.pinball.worse || paired.coverageDistance.worse || paired.directionSkill?.worse === true)
    const better = paired !== null && !worse && (paired.pinball.better || paired.coverageDistance.better || paired.directionSkill?.better === true)
    horizons[horizon] = { pairs: keys.length, paired, worse, better }
  }
  const read = Object.values(horizons).filter((entry) => entry!.paired !== null)
  const worseAt = HORIZONS.filter((horizon) => horizons[horizon]?.worse === true)
  const why: ShadowVerdict['why'] = read.length === 0 ? 'unread' : worseAt.length > 0 ? 'worse' : 'not-worse'
  const summary =
    why === 'unread'
      ? 'too few paired live outcomes at every horizon to judge it'
      : why === 'worse'
        ? `worse live than the run in use beyond noise at ${worseAt.join(', ')}`
        : `no worse live than the run in use at ${read.length} horizon${read.length === 1 ? '' : 's'} read${HORIZONS.some((horizon) => horizons[horizon]?.better === true) ? `, better at ${HORIZONS.filter((horizon) => horizons[horizon]?.better === true).join(', ')}` : ''}`
  return { version: SHADOW_VERSION, adopted: why === 'not-worse', why, horizons, summary }
}
