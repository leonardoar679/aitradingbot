import { HORIZONS, type Horizon } from './features'
import type { RunCalibration } from './runCalibration'

// CHAMPION AND CHALLENGER (V7.1 Stage 13, 16 October 2026). Until now the newest fit's models were put in
// use as soon as they were read back, and the newest walk forward's verdicts the moment it ended: a refit
// that fitted worse replaced one that fitted better, and nothing said so. Now the run in use is the
// CHAMPION and a refit the CHALLENGER: its walk forward's honest figures -- the forecast shown (V2), every
// class together, each week scored by a calibration made only from the weeks before it -- are set beside
// the champion's, horizon by horizon, and the challenger is adopted only where at no horizon it is worse
// beyond the lines below: its pooled pinball loss no more than a hundredth above the champion's, its 80%
// coverage no more than two points farther from 80%, its direction skill no more than a hundredth lower.
// A horizon the champion has no figures for is nothing to beat; one the challenger lost is a failure. A
// rejected run is written to the training log with the comparison and kept on file for the Lab; the
// champion's models and verdicts stay as they were, and a person may roll back to the run before the
// champion from the Lab. The two walk forwards cover much the same weeks a day apart, which is what makes
// the figures comparable; they are not the same rows, and the lines carry a tolerance for that.
//
// IT IS ARITHMETIC on two calibrations. No key, no model, no order.

export const CHALLENGER_VERSION = 'challenger-v1'

export const CHALLENGER_LINES = {
  /** The challenger's pooled honest pinball loss may be at most this share above the champion's. */
  pinballTolerance: 0.01,
  /** Its 80% coverage may be at most this much farther from 80% than the champion's. */
  coverageTolerance: 0.02,
  /** Its direction skill may be at most this much lower than the champion's. */
  directionTolerance: 0.01
} as const

export interface ChallengeFigure {
  champion: number
  challenger: number
  ok: boolean
}

export interface HorizonChallenge {
  ok: boolean
  /** The horizon is in the champion's calibration and not in the challenger's. */
  missing: boolean
  /** Null where one side holds no honest score: nothing to compare, and nothing held against. */
  pinball: ChallengeFigure | null
  coverage80: ChallengeFigure | null
  directionSkill: ChallengeFigure | null
}

export interface ChallengeVerdict {
  version: string
  adopted: boolean
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

/** The challenger against the champion, horizon by horizon; adopted where no horizon fails. */
export function compareRuns(champion: RunCalibration, challenger: RunCalibration, lines: typeof CHALLENGER_LINES = CHALLENGER_LINES): ChallengeVerdict {
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
    horizons[horizon] = { ok, missing: false, pinball, coverage80, directionSkill }
  }
  return { version: CHALLENGER_VERSION, adopted: Object.values(horizons).every((entry) => entry.ok), horizons }
}

/** The horizons a verdict failed at, in words for the log and the page. */
export function challengeRefusals(verdict: ChallengeVerdict): string[] {
  const out: string[] = []
  for (const horizon of HORIZONS) {
    const entry = verdict.horizons[horizon]
    if (entry === undefined || entry.ok) continue
    const why: string[] = []
    if (entry.missing) why.push('no figures')
    else if (entry.pinball === null && entry.coverage80 === null && entry.directionSkill === null) why.push('not scored')
    if (entry.pinball !== null && !entry.pinball.ok) why.push(`pinball ${entry.pinball.challenger.toFixed(4)} against ${entry.pinball.champion.toFixed(4)}`)
    if (entry.coverage80 !== null && !entry.coverage80.ok) why.push(`80% range held ${(entry.coverage80.challenger * 100).toFixed(1)}% against ${(entry.coverage80.champion * 100).toFixed(1)}%`)
    if (entry.directionSkill !== null && !entry.directionSkill.ok) why.push(`direction skill ${Number.isFinite(entry.directionSkill.challenger) ? (entry.directionSkill.challenger * 100).toFixed(2) : '-'}% against ${(entry.directionSkill.champion * 100).toFixed(2)}%`)
    out.push(`${horizon}: ${why.join(', ')}`)
  }
  return out
}
