import { describe, expect, it } from 'vitest'
import { CHALLENGER_LINES, CHALLENGER_VERSION, challengeRefusals, compareRuns } from '../shared/forecast/challenger'
import { DRIFT_LINES, DRIFT_VERSION, driftOf, pruneDrift } from '../shared/forecast/drift'
import type { Horizon } from '../shared/forecast/features'
import { buildRunCalibration, type HonestScore, type RunCalibration } from '../shared/forecast/runCalibration'
import { promoted, recordOf } from './forecastRecords'

// CHAMPION AND CHALLENGER, AND THE LIVE DRIFT GATE (shared/forecast/{challenger,drift}.ts; V7.1 Stage 13, 16
// October 2026): a refit adopted only where its walk forward's honest figures are no worse beyond the lines
// at any horizon; and a horizon whose last day of outcomes missed its 80% ranges too often closed to trading.

const BASE: RunCalibration = buildRunCalibration(
  new Map([
    ['hour1', recordOf({ rows: 6000, seed: 61, horizon: 'hour1' })],
    ['hours4', recordOf({ rows: 6000, seed: 62, horizon: 'hours4' })]
  ]),
  [...promoted('hour1', ['persistence', 'gbt']), ...promoted('hours4', ['persistence', 'gbt'])],
  'run-champion'
)

/** The calibration with a horizon's pooled honest score patched. */
function withScore(calibration: RunCalibration, horizon: Horizon, patch: Partial<HonestScore> | null, runId = 'run-challenger'): RunCalibration {
  const entry = calibration.horizons[horizon]!
  const pooled = patch === null ? null : { ...entry.variants.v2.honest.pooled!, ...patch }
  return { ...calibration, runId, horizons: { ...calibration.horizons, [horizon]: { ...entry, variants: { ...entry.variants, v2: { ...entry.variants.v2, honest: { ...entry.variants.v2.honest, pooled } } } } } }
}

const pooled = (calibration: RunCalibration, horizon: Horizon): HonestScore => calibration.horizons[horizon]!.variants.v2.honest.pooled!

describe('the challenger against the champion', () => {
  it('is adopted where every horizon is no worse beyond the lines, each figure read', () => {
    expect(CHALLENGER_LINES).toEqual({ pinballTolerance: 0.01, coverageTolerance: 0.02, directionTolerance: 0.01 })
    const same = compareRuns(BASE, { ...BASE, runId: 'run-challenger' })
    expect(same.version).toBe(CHALLENGER_VERSION)
    expect(same.adopted).toBe(true)
    expect(Object.keys(same.horizons).sort()).toEqual(['hour1', 'hours4'])
    const hour = same.horizons.hour1!
    expect(hour.ok).toBe(true)
    expect(hour.missing).toBe(false)
    expect(hour.pinball).toEqual({ champion: pooled(BASE, 'hour1').pinball, challenger: pooled(BASE, 'hour1').pinball, ok: true })
    expect(hour.coverage80!.ok).toBe(true)
    expect(hour.directionSkill!.ok).toBe(true)
    expect(challengeRefusals(same)).toEqual([])
  })

  it('refuses a pinball loss more than a hundredth above, an 80% range more than two points farther from 80%, or a direction skill more than a hundredth lower', () => {
    const held = pooled(BASE, 'hour1')
    const worsePinball = compareRuns(BASE, withScore(BASE, 'hour1', { pinball: held.pinball * 1.0101 }))
    expect(worsePinball.adopted).toBe(false)
    expect(worsePinball.horizons.hour1!.pinball!.ok).toBe(false)
    expect(worsePinball.horizons.hours4!.ok).toBe(true)
    expect(challengeRefusals(worsePinball)).toEqual([`hour1: pinball ${(held.pinball * 1.0101).toFixed(4)} against ${held.pinball.toFixed(4)}`])
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { pinball: held.pinball * 1.0099 })).adopted).toBe(true)
    // At the line itself: no worse.
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { pinball: held.pinball * (1 + CHALLENGER_LINES.pinballTolerance) })).adopted).toBe(true)
    // Coverage: the distance from 80% is what counts, either side.
    const farther = Math.abs(held.coverage80 - 0.8) + 0.0201
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { coverage80: 0.8 - farther })).adopted).toBe(false)
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { coverage80: 0.8 + farther })).adopted).toBe(false)
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { coverage80: 0.8 - (Math.abs(held.coverage80 - 0.8) + 0.0199) })).adopted).toBe(true)
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { coverage80: 0.8 })).adopted).toBe(true)
    // Direction skill.
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { directionSkill: held.directionSkill - 0.0101 })).adopted).toBe(false)
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { directionSkill: held.directionSkill - 0.0099 })).adopted).toBe(true)
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { directionSkill: held.directionSkill + 1 })).adopted).toBe(true)
    // Two things wrong at once: both said.
    const both = compareRuns(BASE, withScore(BASE, 'hour1', { pinball: held.pinball * 2, directionSkill: held.directionSkill - 1 }))
    expect(challengeRefusals(both)[0]).toMatch(/^hour1: pinball .* against .*, direction skill .* against .*$/)
  })

  it('has nothing to beat where the champion holds no horizon or no score, and loses a horizon it dropped or did not score', () => {
    // The champion without the four-hour horizon: the challenger's is nothing to beat.
    const narrow: RunCalibration = { ...BASE, horizons: { hour1: BASE.horizons.hour1! } }
    const wider = compareRuns(narrow, { ...BASE, runId: 'run-challenger' })
    expect(wider.adopted).toBe(true)
    expect(wider.horizons.hours4).toEqual({ ok: true, missing: false, pinball: null, coverage80: null, directionSkill: null })
    // The champion's horizon unscored: nothing held against the challenger there.
    expect(compareRuns(withScore(BASE, 'hour1', null, 'run-champion'), { ...BASE, runId: 'run-challenger' }).horizons.hour1).toEqual({ ok: true, missing: false, pinball: null, coverage80: null, directionSkill: null })
    // The challenger dropped a horizon the champion has: refused.
    const dropped = compareRuns(BASE, { ...narrow, runId: 'run-challenger' })
    expect(dropped.adopted).toBe(false)
    expect(dropped.horizons.hours4).toEqual({ ok: false, missing: true, pinball: null, coverage80: null, directionSkill: null })
    expect(challengeRefusals(dropped)).toEqual(['hours4: no figures'])
    // The challenger's horizon unscored where the champion's was: refused.
    const unscored = compareRuns(BASE, withScore(BASE, 'hour1', null))
    expect(unscored.adopted).toBe(false)
    expect(challengeRefusals(unscored)).toEqual(['hour1: not scored'])
    // A direction skill the champion measured and the challenger could not: a loss; one neither measured: nothing.
    expect(compareRuns(BASE, withScore(BASE, 'hour1', { directionSkill: Number.NaN })).horizons.hour1!.directionSkill!.ok).toBe(false)
    expect(compareRuns(withScore(BASE, 'hour1', { directionSkill: Number.NaN }, 'run-champion'), withScore(BASE, 'hour1', { directionSkill: Number.NaN })).horizons.hour1!.directionSkill).toBeNull()
    expect(compareRuns({ ...BASE, horizons: {} }, { ...BASE, horizons: {}, runId: 'x' })).toEqual({ version: CHALLENGER_VERSION, adopted: true, horizons: {} })
  })
})

describe('the live drift gate', () => {
  const T = 1_800_000_000
  const outcomes = (n: number, held: number, due = T - 3600): { due: number; in80: boolean }[] => Array.from({ length: n }, (_, k) => ({ due, in80: k < held }))

  it("closes a horizon whose last day's outcomes, fifty or more, held under three in five of their 80% ranges", () => {
    expect(DRIFT_VERSION).toBe('drift-v1')
    expect(DRIFT_LINES).toEqual({ windowSec: 86_400, minOutcomes: 50, minCoverage80: 0.6 })
    expect(driftOf(outcomes(50, 29), T)).toEqual({ outcomes: 50, coverage80: 0.58, drifted: true })
    expect(driftOf(outcomes(50, 30), T)).toEqual({ outcomes: 50, coverage80: 0.6, drifted: false })
    expect(driftOf(outcomes(49, 0), T)).toEqual({ outcomes: 49, coverage80: 0, drifted: false })
    expect(driftOf(outcomes(100, 40), T)).toMatchObject({ outcomes: 100, coverage80: 0.4, drifted: true })
    expect(driftOf([], T)).toEqual({ outcomes: 0, coverage80: Number.NaN, drifted: false })
  })

  it('reads the outcomes due within the day before now and none older, nor any due after', () => {
    const old = outcomes(60, 0, T - 86_400 - 1)
    const edge = outcomes(60, 0, T - 86_400)
    const later = outcomes(60, 0, T + 1)
    expect(driftOf(old, T).outcomes).toBe(0)
    expect(driftOf(edge, T)).toEqual({ outcomes: 60, coverage80: 0, drifted: true })
    expect(driftOf(later, T).outcomes).toBe(0)
    expect(driftOf([...old, ...outcomes(60, 60)], T)).toEqual({ outcomes: 60, coverage80: 1, drifted: false })
    // Pruning keeps the window's outcomes and drops the older.
    expect(pruneDrift([...old, ...edge], T)).toEqual(edge)
    expect(pruneDrift([], T)).toEqual([])
  })
})
