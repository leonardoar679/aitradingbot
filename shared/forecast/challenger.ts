import { HORIZONS, type Horizon } from './features'
import { meanPinball } from './ml/quantile'
import type { RunCalibration, ScoredRow } from './runCalibration'
import { UNCERTAINTY_LINES, blockHoursOf, hourOf, pairedBootstrap, type HourSample, type Statistic, type UncertaintyLines } from './uncertainty'

// CHAMPION AND CHALLENGER (V7.1 Stage 13, 16 October 2026). Until then the newest fit's models were put in
// use as soon as they were read back, and the newest walk forward's verdicts the moment it ended: a refit
// that fitted worse replaced one that fitted better, and nothing said so. Now the run in use is the
// CHAMPION and a refit the CHALLENGER: its walk forward's honest figures -- the forecast shown (V2), every
// class together, each week scored by a calibration made only from the weeks before it -- are set beside
// the champion's, horizon by horizon. A horizon the champion has no figures for is nothing to beat; one
// the challenger lost is a failure. A rejected run is written to the training log with the comparison and
// kept on file for the Lab; the champion's models and verdicts stay as they were, and a person may roll
// back to the run before the champion from the Lab.
//
// BEYOND NOISE (V7.2 Stage 3, 17 October 2026). Two walk forwards a day apart test much the same hours with
// much the same rows -- a nightly refit adds about one row in ninety -- so their figures differ by noise
// and by a day's rows, and the tolerances of V7.1 (a hundredth of the pinball loss, two points of
// coverage, a point of skill) compared that noise. Now the two are PAIRED on the hours both tested (every
// pair's row of an hour together, in blocks as long as the horizon, as every interval since V7.2 Stage 1):
// the difference of the pinball loss, of the 80% range's distance from 80% and of the direction skill,
// each with its 90% interval. The challenger is adopted where it is better beyond the interval at some
// horizon and worse beyond it at none, or where it carries at least a week of newer rows and is worse
// beyond it at none; otherwise the champion stays and the log says "within noise". The tolerances stay as
// a floor of materiality: a difference so small that even a narrow interval excludes zero is neither
// better nor worse. Where the champion's record cannot be read the tolerances alone decide, as before,
// and the verdict says so.
//
// IT IS ARITHMETIC on two calibrations and two records. No key, no model, no order.

export const CHALLENGER_VERSION = 'challenger-v2'

export const CHALLENGER_LINES = {
  /** The challenger's pooled honest pinball loss may be at most this share above the champion's; the floor
   * of materiality for the paired difference. */
  pinballTolerance: 0.01,
  /** Its 80% coverage may be at most this much farther from 80% than the champion's; the floor for the paired difference. */
  coverageTolerance: 0.02,
  /** Its direction skill may be at most this much lower than the champion's; the floor for the paired difference. */
  directionTolerance: 0.01,
  /** The newer rows a challenger within noise needs to be adopted, in days. */
  newerDays: 7,
  /** The paired intervals' level. */
  level: 0.9
} as const

export interface ChallengeFigure {
  champion: number
  challenger: number
  ok: boolean
}

/** One figure's paired difference, challenger less champion, over the hours both walk forwards tested: the
 * interval, and whether it is better or worse beyond the interval and beyond the floor. */
export interface PairedFigure {
  difference: number
  low: number
  high: number
  better: boolean
  worse: boolean
}

export interface PairedHorizon {
  hours: number
  blocks: number
  pinball: PairedFigure
  /** The 80% range's distance from 80%: lower is better. */
  coverageDistance: PairedFigure
  /** Null where neither walk forward scored a direction skill on the shared hours. */
  directionSkill: PairedFigure | null
}

export type PairedChallenge = Partial<Record<Horizon, PairedHorizon>>

export interface HorizonChallenge {
  ok: boolean
  /** The horizon is in the champion's calibration and not in the challenger's. */
  missing: boolean
  /** Null where one side holds no honest score: nothing to compare, and nothing held against. */
  pinball: ChallengeFigure | null
  coverage80: ChallengeFigure | null
  directionSkill: ChallengeFigure | null
  /** The paired figures (V7.2 Stage 3); absent on a verdict without them. */
  paired?: PairedHorizon
}

export type ChallengeWhy = 'better' | 'newer' | 'within-noise' | 'worse' | 'unpaired'

export interface ChallengeVerdict {
  version: string
  adopted: boolean
  /** Why (V7.2 Stage 3): better beyond noise, newer and no worse, within noise (kept), worse, or judged by the
   * tolerances alone without a paired record. Absent on a verdict from before. */
  why?: ChallengeWhy
  /** The days of rows the challenger carries past the champion's last; null where not read. */
  newerDays?: number | null
  horizons: Partial<Record<Horizon, HorizonChallenge>>
}

/** A challenge on record: which run challenged which, when, and the verdict. */
export interface ChallengeRecord {
  at: number
  runId: string
  championRunId: string
  adopted: boolean
  verdict: ChallengeVerdict
}

const finite = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value)

const P10 = 0
const P90 = 4

/** The rows of a walk forward's shown forecast as hour samples: inside the 80% range, the pinball loss, a
 * P(up) scored, its Brier square, the base rate's. */
function samplesOf(shown: readonly ScoredRow[]): HourSample[] {
  const out: HourSample[] = []
  for (const entry of shown) {
    if (entry.t === undefined) continue
    const scored = entry.pUp !== null && entry.base !== null
    const wentUp = entry.z > 0 ? 1 : 0
    out.push({
      hour: hourOf(entry.t),
      sample: [entry.z >= entry.quantiles[P10] && entry.z <= entry.quantiles[P90] ? 1 : 0, meanPinball(entry.z, entry.quantiles), scored ? 1 : 0, scored ? (entry.pUp! - wentUp) ** 2 : 0, scored ? (entry.base! - wentUp) ** 2 : 0]
    })
  }
  return out
}

const PINBALL: Statistic = (sums, n): number => sums[1] / n
const COVERAGE_DISTANCE: Statistic = (sums, n): number => Math.abs(sums[0] / n - 0.8)
const DIRECTION_SKILL: Statistic = (sums): number => (sums[2] > 0 ? 1 - sums[3] / Math.min(0.25 * sums[2], sums[4]) : Number.NaN)

/** A paired figure from its interval: better or worse where the interval excludes zero on that side and the
 * difference is beyond the floor; `lowerIsBetter` for the losses. */
function pairedFigure(made: { difference: { value: number; low: number; high: number } }, floor: number, lowerIsBetter: boolean): PairedFigure {
  const { value, low, high } = made.difference
  const beyond = Math.abs(value) > floor
  const up = low > 0 && beyond
  const down = high < 0 && beyond
  return { difference: value, low, high, better: lowerIsBetter ? down : up, worse: lowerIsBetter ? up : down }
}

/** The challenger's shown forecast paired with the champion's on the hours both tested, at one horizon; null
 * with fewer shared blocks than an interval needs. */
export function pairedHorizonOf(champion: readonly ScoredRow[], challenger: readonly ScoredRow[], horizon: Horizon, lines: typeof CHALLENGER_LINES = CHALLENGER_LINES): PairedHorizon | null {
  const a = samplesOf(champion)
  const b = samplesOf(challenger)
  const uncertainty: UncertaintyLines = { ...UNCERTAINTY_LINES, level: lines.level }
  const block = blockHoursOf(horizon)
  const pinball = pairedBootstrap(a, b, PINBALL, block, uncertainty)
  if (pinball === null) return null
  const coverage = pairedBootstrap(a, b, COVERAGE_DISTANCE, block, uncertainty)!
  const direction = pairedBootstrap(a, b, DIRECTION_SKILL, block, uncertainty)!
  const directionRead = Number.isFinite(direction.a) && Number.isFinite(direction.b)
  return {
    hours: pinball.hours,
    blocks: pinball.blocks,
    pinball: pairedFigure(pinball, lines.pinballTolerance * pinball.a, true),
    coverageDistance: pairedFigure(coverage, lines.coverageTolerance, true),
    directionSkill: directionRead ? pairedFigure(direction, lines.directionTolerance, false) : null
  }
}

/** Every horizon's paired figures from the two walk forwards' shown forecasts. */
export function pairedChallengeOf(champion: ReadonlyMap<Horizon, readonly ScoredRow[]>, challenger: ReadonlyMap<Horizon, readonly ScoredRow[]>, lines: typeof CHALLENGER_LINES = CHALLENGER_LINES): PairedChallenge {
  const out: PairedChallenge = {}
  for (const horizon of HORIZONS) {
    const a = champion.get(horizon)
    const b = challenger.get(horizon)
    if (a === undefined || b === undefined) continue
    const made = pairedHorizonOf(a, b, horizon, lines)
    if (made !== null) out[horizon] = made
  }
  return out
}

/** The challenger against the champion, horizon by horizon, by the tolerances; and, with the paired figures
 * (V7.2 Stage 3), adopted only beyond noise, or newer by a week and no worse beyond it. */
export function compareRuns(champion: RunCalibration, challenger: RunCalibration, paired: PairedChallenge | null = null, newerDays: number | null = null, lines: typeof CHALLENGER_LINES = CHALLENGER_LINES): ChallengeVerdict {
  const horizons: ChallengeVerdict['horizons'] = {}
  for (const horizon of HORIZONS) {
    const mine = champion.horizons[horizon]
    const theirs = challenger.horizons[horizon]
    if (mine === undefined && theirs === undefined) continue
    if (theirs === undefined) {
      horizons[horizon] = { ok: false, missing: true, pinball: null, coverage80: null, directionSkill: null }
      continue
    }
    const held = mine?.variants.v2.honest.pooled ?? null
    const offered = theirs.variants.v2.honest.pooled
    if (held === null || mine === undefined) {
      horizons[horizon] = { ok: true, missing: false, pinball: null, coverage80: null, directionSkill: null }
      continue
    }
    if (offered === null) {
      // The champion was scored and the challenger was not: nothing shown, nothing adopted.
      horizons[horizon] = { ok: false, missing: false, pinball: null, coverage80: null, directionSkill: null }
      continue
    }
    const pinball: ChallengeFigure | null = finite(held.pinball) && finite(offered.pinball) ? { champion: held.pinball, challenger: offered.pinball, ok: offered.pinball <= held.pinball * (1 + lines.pinballTolerance) } : null
    const coverage80: ChallengeFigure | null =
      finite(held.coverage80) && finite(offered.coverage80) ? { champion: held.coverage80, challenger: offered.coverage80, ok: Math.abs(offered.coverage80 - 0.8) <= Math.abs(held.coverage80 - 0.8) + lines.coverageTolerance } : null
    // A direction skill the champion could measure and the challenger could not is a loss.
    const directionSkill: ChallengeFigure | null = finite(held.directionSkill)
      ? { champion: held.directionSkill, challenger: finite(offered.directionSkill) ? offered.directionSkill : Number.NaN, ok: finite(offered.directionSkill) && offered.directionSkill >= held.directionSkill - lines.directionTolerance }
      : null
    const ok = (pinball?.ok ?? true) && (coverage80?.ok ?? true) && (directionSkill?.ok ?? true)
    const pairedHere = paired?.[horizon]
    horizons[horizon] = { ok, missing: false, pinball, coverage80, directionSkill, ...(pairedHere === undefined ? {} : { paired: pairedHere }) }
  }
  const entries = Object.values(horizons)
  if (paired === null) return { version: CHALLENGER_VERSION, adopted: entries.every((entry) => entry.ok), why: entries.every((entry) => entry.ok) ? 'unpaired' : 'worse', newerDays, horizons }
  // A horizon without paired figures -- dropped, unscored, or not on the champion's record -- is judged by
  // the tolerances alone: a loss there is a loss whatever the pairs say.
  const unpaired = entries.filter((entry) => entry.paired === undefined)
  const worse = unpaired.some((entry) => !entry.ok) || entries.some((entry) => entry.paired !== undefined && (entry.paired.pinball.worse || entry.paired.coverageDistance.worse || entry.paired.directionSkill?.worse === true))
  const better = entries.some((entry) => entry.paired !== undefined && (entry.paired.pinball.better || entry.paired.coverageDistance.better || entry.paired.directionSkill?.better === true))
  const why: ChallengeWhy = worse ? 'worse' : better ? 'better' : newerDays !== null && newerDays >= lines.newerDays ? 'newer' : 'within-noise'
  return { version: CHALLENGER_VERSION, adopted: why === 'better' || why === 'newer', why, newerDays, horizons }
}

const signedPct = (value: number, digits = 2): string => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`
const interval = (figure: PairedFigure, digits = 2, scale = 100): string => `${figure.difference >= 0 ? '+' : ''}${(figure.difference * scale).toFixed(digits)} [${figure.low >= 0 ? '+' : ''}${(figure.low * scale).toFixed(digits)}, ${figure.high >= 0 ? '+' : ''}${(figure.high * scale).toFixed(digits)}]`

/** The horizons a verdict failed at, in words for the log and the page; with the paired figures beyond
 * noise where the verdict carries them. */
export function challengeRefusals(verdict: ChallengeVerdict): string[] {
  const out: string[] = []
  for (const horizon of HORIZONS) {
    const entry = verdict.horizons[horizon]
    if (entry === undefined) continue
    const why: string[] = []
    if (entry.missing) why.push('no figures')
    else if (entry.pinball === null && entry.coverage80 === null && entry.directionSkill === null && !entry.ok) why.push('not scored')
    if (entry.paired !== undefined) {
      if (entry.paired.pinball.worse) why.push(`pinball ${interval(entry.paired.pinball, 4, 1)} worse beyond noise`)
      if (entry.paired.coverageDistance.worse) why.push(`the 80% range ${interval(entry.paired.coverageDistance, 1)} points farther from 80% beyond noise`)
      if (entry.paired.directionSkill?.worse) why.push(`direction skill ${interval(entry.paired.directionSkill)} lower beyond noise`)
    } else if (!entry.ok) {
      if (entry.pinball !== null && !entry.pinball.ok) why.push(`pinball ${entry.pinball.challenger.toFixed(4)} against ${entry.pinball.champion.toFixed(4)}`)
      if (entry.coverage80 !== null && !entry.coverage80.ok) why.push(`80% range held ${(entry.coverage80.challenger * 100).toFixed(1)}% against ${(entry.coverage80.champion * 100).toFixed(1)}%`)
      if (entry.directionSkill !== null && !entry.directionSkill.ok) why.push(`direction skill ${Number.isFinite(entry.directionSkill.challenger) ? signedPct(entry.directionSkill.challenger) : '-'} against ${signedPct(entry.directionSkill.champion)}`)
    }
    if (why.length > 0) out.push(`${horizon}: ${why.join(', ')}`)
  }
  if (verdict.why === 'within-noise' && out.length === 0) out.push(`within noise at every horizon${verdict.newerDays === null || verdict.newerDays === undefined ? '' : `, ${verdict.newerDays.toFixed(1)} days newer (${CHALLENGER_LINES.newerDays} needed)`}`)
  return out
}

/** A verdict in a line, for the page and the log. */
export function challengeSummary(verdict: ChallengeVerdict): string {
  const paired = (Object.entries(verdict.horizons) as [Horizon, HorizonChallenge][]).filter(([, entry]) => entry.paired !== undefined)
  const figures = paired.map(([horizon, entry]) => `${horizon} pinball ${interval(entry.paired!.pinball, 4, 1)}${entry.paired!.directionSkill === null ? '' : `, skill ${interval(entry.paired!.directionSkill)}`} on ${entry.paired!.blocks} blocks`).join('; ')
  switch (verdict.why) {
    case 'better':
      return `adopted: better beyond noise (${figures})`
    case 'newer':
      return `adopted: within noise and ${verdict.newerDays?.toFixed(1) ?? '?'} days newer (${figures})`
    case 'within-noise':
      return `kept the champion: within noise (${figures})`
    case 'worse':
      return `refused: ${challengeRefusals(verdict).join('; ')}`
    case 'unpaired':
      return 'adopted by the tolerances alone: no record of the champion to pair with'
    default:
      return verdict.adopted ? 'adopted' : `refused: ${challengeRefusals(verdict).join('; ')}`
  }
}
