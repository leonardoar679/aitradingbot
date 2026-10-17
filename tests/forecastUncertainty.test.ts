import { describe, expect, it } from 'vitest'
import { parseRunCalibration, serializeRunCalibration } from '../shared/forecast/calibrationFile'
import { HORIZONS } from '../shared/forecast/features'
import { labMetrics, type LabCase } from '../shared/forecast/lab'
import { buildRunCalibration, directionReportOf, directionScore, honestScore, rowsOf, scoreOutOfSample, type ScoredRow } from '../shared/forecast/runCalibration'
import {
  BLOCK_HOURS,
  SHARE,
  UNCERTAINTY_LINES,
  blockHoursOf,
  bootstrapOverHours,
  dependenceFactor,
  detectableSkill,
  effectiveSampleSize,
  hourOf,
  intervalOf,
  pairedBootstrap,
  shareVariance,
  smallSampleFactor,
  type HourSample,
  type Statistic
} from '../shared/forecast/uncertainty'
import { N, gaussOf, promoted, recordOf, rng, scaled } from './forecastRecords'

// WHAT A FIGURE IS WORTH (shared/forecast/uncertainty.ts; V7.2 Stage 1, 17 October 2026): the circular
// block bootstrap over the hours, its interval's coverage on panels whose truth is known -- the registered
// line, 93-97% at every horizon -- the corrections for overlapping outcomes and few blocks, the effective
// sample, the detectable skill, the paired difference, and the figures carried by the honest score, the
// direction score, the Lab's figures and the calibration file.

/** A panel of pairs over hours whose true 80% coverage is 0.8 and 50% coverage 0.5: each pair's move is a
 * share of the hour's market factor and its own noise, each a moving sum over `overlap` hours (an outcome
 * overlapping the next hours' outcomes), scaled to unit variance; the forecast's levels are the standard
 * normal's. */
function panel(options: { pairs: number; hours: number; overlap: number; correlation: number; seed: number }): HourSample[] {
  const random = rng(options.seed)
  const gauss = gaussOf(random)
  const { pairs, hours, overlap, correlation } = options
  const market = Float64Array.from({ length: hours + overlap }, gauss)
  const own = Array.from({ length: pairs }, () => Float64Array.from({ length: hours + overlap }, gauss))
  const out: HourSample[] = []
  for (let hour = 0; hour < hours; hour++) {
    for (let pair = 0; pair < pairs; pair++) {
      let m = 0
      let e = 0
      for (let j = 0; j < overlap; j++) {
        m += market[hour + j]
        e += own[pair][hour + j]
      }
      const z = (Math.sqrt(correlation) * m + Math.sqrt(1 - correlation) * e) / Math.sqrt(overlap)
      out.push({ hour, sample: [z >= N[0] && z <= N[4] ? 1 : 0, z >= N[1] && z <= N[3] ? 1 : 0] })
    }
  }
  return out
}

const COVERAGE: Statistic[] = [(sums, n): number => sums[0] / n, (sums, n): number => sums[1] / n]
/** Fewer draws than the app's, where a demonstration needs no more. */
const QUICK = { ...UNCERTAINTY_LINES, draws: 200 }

/** The share of panels whose 95% intervals hold the truth, for the 80% coverage and the 50%. */
function held(options: { panels: number; overlap: number; block: number; hours: number; correlation: number; draws?: number }): { in80: number; in50: number } {
  let in80 = 0
  let in50 = 0
  const lines = options.draws === undefined ? UNCERTAINTY_LINES : { ...UNCERTAINTY_LINES, draws: options.draws }
  for (let seed = 1; seed <= options.panels; seed++) {
    const made = bootstrapOverHours(panel({ pairs: 10, hours: options.hours, overlap: options.overlap, correlation: options.correlation, seed }), COVERAGE, options.block, lines)!
    if (made.figures[0].low <= 0.8 && 0.8 <= made.figures[0].high) in80++
    if (made.figures[1].low <= 0.5 && 0.5 <= made.figures[1].high) in50++
  }
  return { in80: in80 / options.panels, in50: in50 / options.panels }
}

describe('the interval', () => {
  // The registered success line of V7.2 Stage 1: a thousand panels a horizon, resampled in blocks as long
  // as the horizon (the outcomes' overlap) with the app's own thousand draws, with the corrections for the
  // overlap and for few blocks. Measured 17 October 2026: 96.1% / 96.1% / 96.1% / 96.9% / 94.0% for the 80%
  // coverage by horizon (without the corrections 91.4% at four hours and 85.7% at a day).
  it('holds the truth in 93-97% of simulated panels at every horizon', { timeout: 180_000 }, () => {
    for (const horizon of HORIZONS) {
      const overlap = BLOCK_HOURS[horizon]
      const share = held({ panels: 1000, overlap, block: blockHoursOf(horizon), hours: overlap === 1 ? 336 : 504, correlation: 0.5 })
      expect(share.in80, `${horizon} 80%`).toBeGreaterThanOrEqual(0.93)
      expect(share.in80, `${horizon} 80%`).toBeLessThanOrEqual(0.97)
      expect(share.in50, `${horizon} 50%`).toBeGreaterThanOrEqual(0.93)
      expect(share.in50, `${horizon} 50%`).toBeLessThanOrEqual(0.97)
    }
  })

  it("is too narrow with blocks of an hour on a day's overlap: why the block is the horizon's length", { timeout: 60_000 }, () => {
    expect(held({ panels: 200, overlap: 24, block: 1, hours: 504, correlation: 0.5, draws: QUICK.draws }).in80).toBeLessThan(0.85)
  })

  it('widens for the overlap of the outcomes and for few blocks, by fixed arithmetic', () => {
    // Nothing overlaps: nothing to widen. A day's outcomes in blocks of a day: the blocks capture sixteen of
    // the twenty-four units of long-run variance; four hours in blocks of four, 2.75 of 4.
    expect(dependenceFactor(1, 1)).toBe(1)
    expect(dependenceFactor(24, 24)).toBeCloseTo(Math.sqrt(24 / (1 + (2 * 4324) / 576)), 9)
    expect(dependenceFactor(4, 4)).toBeCloseTo(Math.sqrt(4 / 2.75), 9)
    // Longer blocks capture more, never less; a block shorter than the overlap is read as the overlap.
    expect(dependenceFactor(24, 48)).toBeLessThan(dependenceFactor(24, 24))
    expect(dependenceFactor(24, 12)).toBe(dependenceFactor(24, 24))
    // Student's t over the normal: 2.086 at twenty degrees, 2.228 at ten, 2.571 at five; one from a block.
    expect(smallSampleFactor(21) * 1.959964).toBeCloseTo(2.086, 2)
    expect(smallSampleFactor(11) * 1.959964).toBeCloseTo(2.228, 2)
    expect(smallSampleFactor(6) * 1.959964).toBeCloseTo(2.571, 2)
    expect(smallSampleFactor(1001)).toBeCloseTo(1, 2)
    expect(smallSampleFactor(1)).toBeNaN()
  })

  it('wraps a block past the last hour round to the first: the hours are a circle', () => {
    // Six hours, the last one marked, in blocks of three: a draw takes two blocks, each holding the last hour
    // half the time, so the draws' count of it runs 0, 1 or 2 and never 3 -- which blocks cut off at the end,
    // more than two a draw, would give the 97.5th percentile.
    const rows = Array.from({ length: 6 }, (_, hour) => ({ hour, sample: [hour === 5 ? 6 : 0] }))
    const made = bootstrapOverHours(rows, [(sums, n): number => sums[0] / n], 3)!
    expect(made.blocks).toBe(2)
    const factor = dependenceFactor(3, 3) * smallSampleFactor(2)
    expect(made.figures[0].value).toBe(1)
    expect(made.figures[0].low).toBeCloseTo(1 - factor, 9)
    expect(made.figures[0].high).toBeCloseTo(1 + factor, 9)
  })

  it('is the same from the same rows, holds its point, and counts the blocks a resample drew', () => {
    const rows = panel({ pairs: 5, hours: 100, overlap: 4, correlation: 0.3, seed: 7 })
    const a = bootstrapOverHours(rows, COVERAGE, 4)!
    const b = bootstrapOverHours(rows, COVERAGE, 4)!
    expect(b).toEqual(a)
    expect(a.n).toBe(500)
    expect(a.hours).toBe(100)
    expect(a.blocks).toBe(25)
    expect(a.draws).toBe(UNCERTAINTY_LINES.draws)
    const point = rows.reduce((sum, row) => sum + row.sample[0], 0) / rows.length
    expect(a.figures[0].value).toBe(point)
    expect(a.figures[0].low).toBeLessThan(point)
    expect(a.figures[0].high).toBeGreaterThan(point)
    expect(a.figures[0].sd).toBeGreaterThan(0)
    // Blocks of seven over a hundred hours: fifteen, the last one short.
    expect(bootstrapOverHours(rows, COVERAGE, 7)!.blocks).toBe(15)
    // Nothing to resample: no row, no statistic, or one block.
    expect(bootstrapOverHours([], COVERAGE, 1)).toBeNull()
    expect(bootstrapOverHours(rows, [], 1)).toBeNull()
    expect(bootstrapOverHours(rows.filter((row) => row.hour < 24), COVERAGE, 24)).toBeNull()
    expect(bootstrapOverHours(rows.filter((row) => row.hour < 25), COVERAGE, 24)).not.toBeNull()
    // A row with another width is refused, not summed.
    expect(() => bootstrapOverHours([...rows, { hour: 3, sample: [1] }], COVERAGE, 1)).toThrow(/figures/)
  })

  it('reads the effective sample from how the hours spread: the rows themselves where they are independent, far fewer where they move together', () => {
    const independent = bootstrapOverHours(panel({ pairs: 10, hours: 500, overlap: 1, correlation: 0, seed: 3 }), COVERAGE, 1)!
    const nEff = effectiveSampleSize(shareVariance(independent.figures[0].value), independent.figures[0].sd)
    expect(nEff).toBeGreaterThan(0.7 * 5000)
    expect(nEff).toBeLessThan(1.3 * 5000)
    const together = bootstrapOverHours(panel({ pairs: 10, hours: 500, overlap: 1, correlation: 0.8, seed: 3 }), COVERAGE, 1)!
    expect(effectiveSampleSize(shareVariance(together.figures[0].value), together.figures[0].sd)).toBeLessThan(0.6 * 5000)
    expect(effectiveSampleSize(0, 0.01)).toBeNaN()
    expect(effectiveSampleSize(0.16, 0)).toBeNaN()
    expect(shareVariance(0.8)).toBeCloseTo(0.16, 12)
    // The detectable skill is 2.8 of the draws' standard deviations; none from no spread.
    expect(detectableSkill(0.01)).toBeCloseTo(0.028, 12)
    expect(detectableSkill(0)).toBeNaN()
    expect(intervalOf(independent.figures[0])).toEqual({ low: independent.figures[0].low, high: independent.figures[0].high })
    expect(intervalOf({ value: 1, low: Number.NaN, high: 2, sd: 1 })).toBeNull()
    expect(intervalOf(undefined)).toBeNull()
    // A share's interval, widened past its bounds, is held inside them.
    expect(intervalOf({ value: 0.9, low: -0.1, high: 1.3, sd: 1 }, SHARE)).toEqual({ low: 0, high: 1 })
    expect(intervalOf({ value: 0.9, low: 0.7, high: 0.95, sd: 1 }, SHARE)).toEqual({ low: 0.7, high: 0.95 })
    expect(hourOf(3600 * 7 + 1799)).toBe(7)
  })

  it('pairs two scorings on the hours both hold: a scoring made better by a fixed amount reads so beyond noise, the same scoring reads zero', () => {
    const a = panel({ pairs: 10, hours: 300, overlap: 1, correlation: 0.5, seed: 11 })
    // B: every hour's first pair inside the 80% range, two points more than A.
    const b = a.map((row, at) => (at % 10 === 0 ? { hour: row.hour, sample: [1, row.sample[1]] } : row))
    const made = pairedBootstrap(a, b, COVERAGE[0], 1)!
    expect(made.hours).toBe(300)
    expect(made.blocks).toBe(300)
    expect(made.b - made.a).toBeCloseTo(made.difference.value, 12)
    expect(made.difference.value).toBeGreaterThan(0)
    expect(made.difference.low).toBeGreaterThan(0)
    expect(made.difference.high).toBeLessThan(0.05)
    const same = pairedBootstrap(a, a, COVERAGE[0], 1)!
    expect(same.difference).toEqual({ value: 0, low: 0, high: 0, sd: 0 })
    // Hours only one holds are left out; too few shared is nothing.
    expect(pairedBootstrap(a, b.filter((row) => row.hour >= 100), COVERAGE[0], 1)!.hours).toBe(200)
    expect(pairedBootstrap(a, b.filter((row) => row.hour >= 299), COVERAGE[0], 1)).toBeNull()
    expect(pairedBootstrap([], a, COVERAGE[0], 1)).toBeNull()
  })
})

describe('the figures that carry it', () => {
  const row = (patch: Partial<ScoredRow>): ScoredRow => ({ cls: 'mid', regime: 'sideways', week: 2, quantiles: scaled(1), floor: scaled(1.2), z: 0.3, raw: 0.5, pUp: 0.6, base: 0.5, ...patch })
  const hours = (count: number, each: number): ScoredRow[] => Array.from({ length: count * each }, (_, at) => row({ t: Math.floor(at / each) * 3600, z: at % 3 === 0 ? -2 : at % 5 === 0 ? 0 : 0.2, pUp: at % 2 === 0 ? 0.7 : 0.4 }))

  it('is on the honest score where the rows carry their hour and a horizon is given, and not otherwise', () => {
    const scored = honestScore(hours(12, 4), 'hour1')!
    expect(scored.ci).toBeDefined()
    expect(scored.blocks).toBe(12)
    expect(scored.nEff).toBeGreaterThan(0)
    expect(scored.ci!.coverage80!.low).toBeLessThanOrEqual(scored.coverage80)
    expect(scored.ci!.coverage80!.high).toBeGreaterThanOrEqual(scored.coverage80)
    expect(scored.ci!.skill!.low).toBeLessThanOrEqual(scored.skill)
    expect(scored.ci!.directionSkill!.high).toBeGreaterThanOrEqual(scored.directionSkill)
    // Blocks as long as the horizon: twelve hours in blocks of four are three.
    expect(honestScore(hours(12, 4), 'hours4')!.blocks).toBe(3)
    // No horizon, or rows without an hour, or a row among them without one: the point alone.
    expect(honestScore(hours(12, 4))!.ci).toBeUndefined()
    expect(honestScore(hours(12, 4).map((entry) => ({ ...entry, t: undefined })), 'hour1')!.ci).toBeUndefined()
    expect(honestScore([...hours(12, 4), row({})], 'hour1')!.ci).toBeUndefined()
    // One block alone is nothing to resample.
    expect(honestScore(hours(12, 4), 'hours24')!.ci).toBeUndefined()
  })

  it('is on the direction score the same way, with the skill the sample could tell from zero', () => {
    const entries = Array.from({ length: 48 }, (_, at) => ({ cls: 'mid' as const, week: 2, pUp: at % 2 === 0 ? 0.7 : 0.3, base: 0.5, z: at % 3 === 0 ? -1 : 1, t: Math.floor(at / 4) * 3600 }))
    const score = directionScore(entries, 'hour1')!
    expect(score.ci).toBeDefined()
    expect(score.blocks).toBe(12)
    expect(score.detectable).toBeGreaterThan(0)
    expect(score.nEff).toBeGreaterThan(0)
    expect(score.ci!.directionSkill!.low).toBeLessThanOrEqual(score.directionSkill)
    expect(score.ci!.precision!.high).toBeGreaterThanOrEqual(score.precision)
    // No call anywhere: the precision's interval is null, the skill's stands.
    const silent = directionScore(entries.map((entry) => ({ ...entry, pUp: 0.52 })), 'hour1')!
    expect(silent.calls).toBe(0)
    expect(silent.ci!.precision).toBeNull()
    expect(silent.ci!.directionSkill).not.toBeNull()
    expect(directionScore(entries)!.ci).toBeUndefined()
  })

  it("is on the Lab's figures from the cases' closes, in blocks as long as the longest horizon among them", () => {
    const labCase = (patch: Partial<LabCase>): LabCase => ({ pair: 'SOLUSDT', t: 0, horizon: 'hour1', cls: 'large', q: [-2, -1, 0.5, 2, 3], dir: 'NEUTRAL', pUp: 0.55, uncertain: false, width: 5, usualWidth: 4, move: 1, best: 1.5, worst: -0.5, pinballZ: 0.3, floorPinballZ: 0.4, ...patch })
    const cases = Array.from({ length: 40 }, (_, at) => labCase({ t: Math.floor(at / 2) * 900, move: at % 5 === 0 ? -3 : 1, dir: at % 3 === 0 ? 'BULLISH' : 'NEUTRAL' }))
    const metrics = labMetrics(cases)
    expect(metrics.ci).toBeDefined()
    // Forty cases at twenty quarter-hour closes: five hours, blocks of an hour.
    expect(metrics.blocks).toBe(5)
    expect(metrics.nEff).toBeGreaterThan(0)
    expect(metrics.ci!.coverage80!.low).toBeLessThanOrEqual(metrics.coverage80!)
    expect(metrics.ci!.skill).not.toBeNull()
    expect(metrics.ci!.callsRight).not.toBeNull()
    expect(labMetrics([...cases, labCase({ t: 4 * 3600, horizon: 'hours4' })]).blocks).toBe(2)
    // Without persistence beside every case the skill has no interval either; one hour is nothing to resample.
    expect(labMetrics(cases.map((entry) => ({ ...entry, floorPinballZ: undefined }))).ci!.skill).toBeNull()
    expect(labMetrics(cases.filter((entry) => entry.t < 3600)).ci).toBeUndefined()
    expect(labMetrics([]).ci).toBeUndefined()
  })

  it("is written into the run's calibration and read back from its file, refused part-made", { timeout: 60_000 }, () => {
    const record = recordOf({ rows: 12_000, seed: 51, direction: { 'dir-gbt': 0.9 } })
    const calibration = buildRunCalibration(new Map([['hour1', record]]), promoted('hour1', ['persistence', 'gbt']), 'run-worth')
    const honest = calibration.horizons.hour1!.variants.v2.honest.pooled!
    expect(honest.ci).toBeDefined()
    expect(honest.blocks).toBeGreaterThan(1000)
    // The fixture's rows are hours of their own: about as many independent outcomes as rows.
    expect(honest.nEff).toBeGreaterThan(0.6 * honest.n)
    expect(honest.nEff).toBeLessThan(1.4 * honest.n)
    const knowing = calibration.horizons.hour1!.direction!.models['dir-gbt']!.honest.pooled!
    expect(knowing.ci!.directionSkill!.low).toBeGreaterThan(0)
    expect(knowing.detectable).toBeGreaterThan(0)
    expect(knowing.detectable).toBeLessThan(knowing.directionSkill)
    // The report alone, given the horizon, carries the same.
    const rows = rowsOf(record)
    const report = directionReportOf(rows, scoreOutOfSample(rows, 'v2', new Set(['persistence', 'gbt'])), 'hour1')!
    expect(report.baseline.pooled!.ci).toBeDefined()
    expect(report.models['dir-gbt']!.honest.byClass.mid!.ci).toBeDefined()
    // On file and back.
    const text = serializeRunCalibration(calibration)
    const back = parseRunCalibration(text)!
    expect(back.horizons.hour1!.variants.v2.honest.pooled!.ci!.coverage80!.low).toBeCloseTo(honest.ci!.coverage80!.low, 6)
    expect(back.horizons.hour1!.variants.v2.honest.pooled!.blocks).toBe(honest.blocks)
    expect(back.horizons.hour1!.direction!.models['dir-gbt']!.honest.pooled!.detectable).toBeCloseTo(knowing.detectable!, 6)
    const raw = JSON.parse(text)
    const damage = (edit: (copy: typeof raw) => void): unknown => {
      const copy = structuredClone(raw)
      edit(copy)
      return parseRunCalibration(JSON.stringify(copy))
    }
    expect(damage((copy) => (copy.horizons.hour1.variants.v2.honest.pooled.ci.coverage80 = { low: 0.9 }))).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.variants.v2.honest.pooled.ci.skill = { low: 0.9, high: 0.1 }))).toBeNull()
    expect(damage((copy) => delete copy.horizons.hour1.variants.v2.honest.pooled.ci)).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.direction.models['dir-gbt'].honest.pooled.detectable = 'x'))).toBeNull()
    // A score from before carries none, and reads.
    const before = damage((copy) => {
      const score = copy.horizons.hour1.variants.v2.honest.pooled
      delete score.ci
      delete score.nEff
      delete score.blocks
    }) as ReturnType<typeof parseRunCalibration>
    expect(before!.horizons.hour1!.variants.v2.honest.pooled!.ci).toBeUndefined()
  })
})
