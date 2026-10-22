import { describe, expect, it } from 'vitest'
import { CHALLENGER_LINES, CHALLENGER_VERSION, challengeRefusals, challengeSummary, compareRuns, pairedChallengeOf, pairedHorizonOf } from '../shared/forecast/challenger'
import { DRIFT_LINES, DRIFT_VERSION, driftOf, pruneDrift } from '../shared/forecast/drift'
import type { Horizon } from '../shared/forecast/features'
import type { ForecastModelId } from '../shared/forecast/models'
import { buildRunCalibration, rowsOf, scoreOutOfSample, type HonestScore, type RunCalibration, type ScoredRow } from '../shared/forecast/runCalibration'
import { promoted, recordOf } from './forecastRecords'

// CHAMPION AND CHALLENGER, AND THE LIVE DRIFT GATE (shared/forecast/{challenger,drift}.ts; V7.1 Stage 13, 16
// October 2026): a refit adopted only where its walk forward's honest figures are no worse beyond the lines
// at any horizon; and a horizon whose last day of outcomes missed its 80% ranges too often closed to trading.
// Since V7.2 Stage 3 the two walk forwards are paired on the hours both tested, and the refit is adopted only
// beyond noise, or a week newer and no worse beyond it; within noise the champion stays.

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
    expect(CHALLENGER_LINES).toEqual({ pinballTolerance: 0.01, coverageTolerance: 0.02, directionTolerance: 0.01, newerDays: 7, level: 0.9 })
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
    expect(compareRuns({ ...BASE, horizons: {} }, { ...BASE, horizons: {}, runId: 'x' })).toEqual({ version: CHALLENGER_VERSION, adopted: true, why: 'unpaired', newerDays: null, horizons: {} })
  })
})

describe('beyond noise (V7.2 Stage 3)', () => {
  const record = recordOf({ rows: 6000, seed: 61, horizon: 'hour1' })
  const shown = scoreOutOfSample(rowsOf(record), 'v2', new Set<ForecastModelId>(['persistence', 'gbt']))
  /** The same forecasts with every level pulled a share of the way towards what came (sharper), or pushed away. */
  const towards = (rows: readonly ScoredRow[], share: number): ScoredRow[] => rows.map((entry) => ({ ...entry, quantiles: entry.quantiles.map((q) => q + share * (entry.z - q)) }))
  const challenger: RunCalibration = { ...BASE, runId: 'run-challenger' }
  const paired = (rows: readonly ScoredRow[]): ReturnType<typeof pairedChallengeOf> => pairedChallengeOf(new Map([['hour1', shown]]), new Map([['hour1', rows]]))

  // Unhurried: the fixture's rows are hours of their own, so every pair resamples thousands of hours a figure.
  it('pairs two walk forwards on the hours both tested, and reads a difference as better or worse only beyond the interval and beyond the floor', { timeout: 60_000 }, () => {
    const same = pairedHorizonOf(shown, shown, 'hour1')!
    expect(same.hours).toBeGreaterThan(1000)
    expect(same.blocks).toBe(same.hours)
    expect(same.pinball).toEqual({ difference: 0, low: 0, high: 0, better: false, worse: false })
    expect(same.coverageDistance.difference).toBe(0)
    expect(same.directionSkill).not.toBeNull()
    expect(same.directionSkill!.difference).toBe(0)
    const sharper = pairedHorizonOf(shown, towards(shown, 0.5), 'hour1')!
    expect(sharper.pinball.high).toBeLessThan(0)
    expect(sharper.pinball).toMatchObject({ better: true, worse: false })
    const duller = pairedHorizonOf(shown, towards(shown, -0.5), 'hour1')!
    expect(duller.pinball.low).toBeGreaterThan(0)
    expect(duller.pinball).toMatchObject({ better: false, worse: true })
    // A difference beyond a narrow interval but under the floor is neither: every row a hair sharper.
    const hair = pairedHorizonOf(shown, towards(shown, 0.001), 'hour1')!
    expect(hair.pinball.high).toBeLessThan(0)
    expect(hair.pinball).toMatchObject({ better: false, worse: false })
    // Beyond the floor by its point but not by its interval -- a few hours, some much sharper, more a little
    // duller -- is neither: the side is read from the interval, not the point.
    const few = shown.slice(0, 30)
    const mixed = few.map((entry, at) => ({ ...entry, quantiles: entry.quantiles.map((q) => q + (at % 4 === 0 ? 0.6 : -0.15) * (entry.z - q)) }))
    const noisy = pairedHorizonOf(few, mixed, 'hour1')!
    expect(noisy.pinball.difference).toBeLessThan(-CHALLENGER_LINES.pinballTolerance * 0.3)
    expect(noisy.pinball.low).toBeLessThan(0)
    expect(noisy.pinball.high).toBeGreaterThan(0)
    expect(noisy.pinball).toMatchObject({ better: false, worse: false })
    // The pinball floor is a share of the champion's loss, not an absolute: two percent sharper on a loss of
    // about 0.3 is beyond a hundredth of it and under a hundredth outright.
    const twoPercent = pairedHorizonOf(shown, towards(shown, 0.02), 'hour1')!
    expect(Math.abs(twoPercent.pinball.difference)).toBeLessThan(CHALLENGER_LINES.pinballTolerance)
    expect(twoPercent.pinball).toMatchObject({ better: true, worse: false })
    // The intervals are at the lines' level: the default is the 90% one, a 95% one wider.
    const at90 = pairedHorizonOf(shown, towards(shown, 0.02), 'hour1', { ...CHALLENGER_LINES, level: 0.9 })!
    const at95 = pairedHorizonOf(shown, towards(shown, 0.02), 'hour1', { ...CHALLENGER_LINES, level: 0.95 })!
    expect(at90.pinball).toEqual(twoPercent.pinball)
    expect(at95.pinball.low).toBeLessThan(twoPercent.pinball.low)
    expect(at95.pinball.high).toBeGreaterThan(twoPercent.pinball.high)
    // Too few shared hours, or none: nothing to pair.
    expect(pairedHorizonOf(shown.slice(0, 1), shown.slice(0, 1), 'hour1')).toBeNull()
    expect(pairedHorizonOf(shown, shown.filter((entry) => entry.t! > 1e12), 'hour1')).toBeNull()
    expect(Object.keys(pairedChallengeOf(new Map([['hour1', shown]]), new Map([['hours4', shown]])))).toEqual([])
  })

  it('adopts a challenger better beyond noise, or a week newer and no worse; keeps the champion within noise; refuses one worse beyond noise', { timeout: 60_000 }, () => {
    const within = compareRuns(BASE, challenger, paired(shown), 0.5)
    expect(within).toMatchObject({ version: CHALLENGER_VERSION, adopted: false, why: 'within-noise', newerDays: 0.5 })
    expect(within.horizons.hour1!.paired).toBeDefined()
    expect(within.horizons.hours4!.paired).toBeUndefined()
    expect(challengeRefusals(within)).toEqual(['within noise at every horizon, 0.5 days newer (7 needed)'])
    expect(challengeSummary(within)).toMatch(/^kept the champion: within noise \(hour1 pinball/)
    const newer = compareRuns(BASE, challenger, paired(shown), CHALLENGER_LINES.newerDays)
    expect(newer).toMatchObject({ adopted: true, why: 'newer' })
    expect(challengeSummary(newer)).toMatch(/^cleared the champion: within noise and 7.0 days newer/)
    expect(compareRuns(BASE, challenger, paired(shown), CHALLENGER_LINES.newerDays - 0.1).why).toBe('within-noise')
    const better = compareRuns(BASE, challenger, paired(towards(shown, 0.5)), 0.5)
    expect(better).toMatchObject({ adopted: true, why: 'better' })
    expect(challengeSummary(better)).toMatch(/^cleared the champion: better beyond noise/)
    const worse = compareRuns(BASE, challenger, paired(towards(shown, -0.5)), 30)
    expect(worse).toMatchObject({ adopted: false, why: 'worse' })
    expect(challengeRefusals(worse)[0]).toMatch(/^hour1: pinball .* worse beyond noise/)
    expect(challengeSummary(worse)).toMatch(/^refused: hour1: pinball/)
    // No paired horizon at all: the tolerances alone judge each horizon, and a week of newer rows adopts.
    expect(compareRuns(BASE, challenger, {}, 30)).toMatchObject({ adopted: true, why: 'newer' })
    expect(compareRuns(BASE, challenger, {}, 1)).toMatchObject({ adopted: false, why: 'within-noise' })
    expect(compareRuns(BASE, challenger)).toMatchObject({ adopted: true, why: 'unpaired' })
    expect(challengeSummary(compareRuns(BASE, challenger))).toMatch(/^cleared the champion by the tolerances alone/)
    // A horizon dropped, or worse by the tolerances where it could not be paired, is a loss whatever the pairs say.
    const narrow: RunCalibration = { ...BASE, runId: 'run-challenger', horizons: { hour1: BASE.horizons.hour1! } }
    expect(compareRuns(BASE, narrow, paired(towards(shown, 0.5)), 30)).toMatchObject({ adopted: false, why: 'worse' })
    const held = pooled(BASE, 'hours4')
    expect(compareRuns(BASE, withScore(challenger, 'hours4', { pinball: held.pinball * 1.05 }), paired(towards(shown, 0.5)), 30)).toMatchObject({ adopted: false, why: 'worse' })
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
