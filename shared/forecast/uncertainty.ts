import type { Horizon } from './features'
import { rngOf } from './ml/bins'

// WHAT A FIGURE IS WORTH (V7.2 Stage 1, 17 October 2026): an interval, an effective sample and a
// detectable skill on the walk forward's and the live record's figures.
//
// The record keeps one row an hour for every pair, and the pairs move together: fifteen thousand
// outcomes are far fewer independent observations than they look, and a figure read off them as a
// point says nothing of how far it could be off. Every figure here is resampled by the HOUR it was
// forecast at -- every pair's row of an hour together, since they share the hour's market move -- in
// circular blocks of consecutive hours as long as the horizon, so that outcomes which overlap in time
// are resampled together; a thousand times, seeded, so the same record gives the same interval. From
// the draws: the figure's 95% interval (the 2.5th and 97.5th percentiles of the draws), the effective
// sample behind it (how many independent outcomes would spread as much as these did), and the
// smallest skill the record could tell from zero (2.8 of the draws' standard deviations: 5% two-sided
// at 80% power). Two corrections, fixed on simulated panels before any record was read (17 October
// 2026): outcomes that overlap are the sums of their hours' moves, so rows k hours apart share
// (1 - k/overlap) of their variance and blocks as long as the overlap lose the dependence across their
// edges -- the draws' spread is widened by the root of the long-run variance over the part a block
// captures (1.21 at four hours, 1.22 at a day); and with few blocks -- a day's horizon over three
// weeks gives twenty-one -- the draws' spread is itself uncertain, so the interval is widened by
// Student's t over the normal's quantile for the blocks drawn. Without them the interval held the truth
// 91% of the time at four hours and 86% at a day on panels whose truth was known; with them 93-97% at
// every horizon, which is the line pinned in tests. The bootstrap measures sampling noise alone: not
// the choice among many cells, nor a market that changes; the blocks are printed beside every interval.
// Arithmetic on the seeded generator: it reads no key and places nothing.

export const UNCERTAINTY_VERSION = 'uncertainty-v1'

/** Blocks as long as the horizon, in hours: outcomes that overlap in time are resampled together. */
export const BLOCK_HOURS: Readonly<Record<Horizon, number>> = { minutes5: 1, minutes15: 1, hour1: 1, hours4: 4, hours24: 24 }

export interface UncertaintyLines {
  /** Resamples drawn for every interval. */
  draws: number
  /** The generator's seed: the same record gives the same interval. */
  seed: number
  blockHours: Readonly<Record<Horizon, number>>
  /** The interval's level. */
  level: number
  /** The standard deviations a skill must reach to be told from zero: 1.96 + 0.84, 5% two-sided at 80% power. */
  detectableSds: number
  /** The blocks an interval needs: from one block there is nothing to resample. */
  minBlocks: number
}

export const UNCERTAINTY_LINES: UncertaintyLines = { draws: 1000, seed: 20261016, blockHours: BLOCK_HOURS, level: 0.95, detectableSds: 2.8, minBlocks: 2 }

export interface Interval {
  low: number
  high: number
}

/** A figure's point, its interval, and the draws' standard deviation. */
export interface Figure extends Interval {
  value: number
  sd: number
}

/** One row's part of the figures: the hour it was forecast at, and its numbers, which are summed by hour. */
export interface HourSample {
  hour: number
  sample: readonly number[]
}

/** What a statistic reads: the sums of the rows drawn, and how many rows. */
export type Statistic = (sums: Float64Array, n: number) => number

export interface Resampled {
  n: number
  hours: number
  /** The blocks of consecutive hours one resample draws. */
  blocks: number
  draws: number
  /** Each statistic's figure, in the order given. */
  figures: Figure[]
}

interface HourSums {
  n: number
  sums: Float64Array
}

/** The hour a moment falls in: the unit resampled. */
export const hourOf = (seconds: number): number => Math.floor(seconds / 3600)

export function blockHoursOf(horizon: Horizon, lines: UncertaintyLines = UNCERTAINTY_LINES): number {
  return lines.blockHours[horizon]
}

/** Every row's numbers summed by hour. */
function summed(entries: readonly HourSample[], width: number): { hours: number[]; byHour: Map<number, HourSums> } {
  const byHour = new Map<number, HourSums>()
  for (const entry of entries) {
    if (entry.sample.length !== width) throw new Error(`a sample of ${entry.sample.length} figures among samples of ${width}`)
    let mine = byHour.get(entry.hour)
    if (mine === undefined) {
      mine = { n: 0, sums: new Float64Array(width) }
      byHour.set(entry.hour, mine)
    }
    mine.n++
    for (let k = 0; k < width; k++) mine.sums[k] += entry.sample[k]
  }
  return { hours: [...byHour.keys()].sort((a, b) => a - b), byHour }
}

function quantileOf(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) return Number.NaN
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(share * sorted.length)))]
}

/** The root of the long-run variance over the part a block bootstrap captures, where an outcome over
 * `overlap` hours is the sum of its hours' moves (rows k hours apart sharing 1 - k/overlap of their
 * variance) and the blocks are `block` hours long: 1 where nothing overlaps. */
export function dependenceFactor(overlap: number, block: number): number {
  const w = Math.max(1, Math.floor(overlap))
  const b = Math.max(w, Math.floor(block))
  let longRun = 1
  let captured = 1
  for (let k = 1; k < w; k++) {
    longRun += 2 * (1 - k / w)
    captured += 2 * (1 - k / w) * (1 - k / b)
  }
  return Math.sqrt(longRun / captured)
}

/** Student's t at 97.5% over the normal's 1.96 for the blocks drawn (the Cornish-Fisher expansion, within
 * 0.03 from three degrees of freedom on): what few blocks cost the interval. */
export function smallSampleFactor(blocks: number): number {
  const df = blocks - 1
  if (!(df >= 1)) return Number.NaN
  const z = 1.959964
  const t = z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3)
  return t / z
}

/** A figure from its draws: the percentile interval widened about the point by `factor`, and the draws'
 * standard deviation widened the same. */
function figureOf(point: number, draws: Float64Array, level: number, factor: number): Figure {
  const sorted = Array.from(draws)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
  const tail = (1 - level) / 2
  let sd = Number.NaN
  if (sorted.length >= 2) {
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
    sd = Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (sorted.length - 1))
  }
  return { value: point, low: point - factor * (point - quantileOf(sorted, tail)), high: point + factor * (quantileOf(sorted, 1 - tail) - point), sd: factor * sd }
}

/** The circular block bootstrap over the hours given, in their order: as many hours as there are, in
 * blocks of consecutive hours each starting anywhere, the last hour followed by the first. */
function resample(hours: readonly HourSums[], width: number, block: number, statistics: readonly Statistic[], lines: UncertaintyLines): Resampled {
  const m = hours.length
  const total = new Float64Array(width)
  let n = 0
  for (const hour of hours) {
    n += hour.n
    for (let k = 0; k < width; k++) total[k] += hour.sums[k]
  }
  const rng = rngOf(lines.seed)
  const draws = statistics.map(() => new Float64Array(lines.draws))
  const sums = new Float64Array(width)
  for (let draw = 0; draw < lines.draws; draw++) {
    sums.fill(0)
    let drawn = 0
    let taken = 0
    while (taken < m) {
      const start = Math.floor(rng() * m)
      for (let j = 0; j < block && taken < m; j++, taken++) {
        const hour = hours[(start + j) % m]
        drawn += hour.n
        for (let k = 0; k < width; k++) sums[k] += hour.sums[k]
      }
    }
    for (let s = 0; s < statistics.length; s++) draws[s][draw] = statistics[s](sums, drawn)
  }
  const blocks = Math.ceil(m / block)
  const factor = dependenceFactor(block, block) * smallSampleFactor(blocks)
  return { n, hours: m, blocks, draws: lines.draws, figures: statistics.map((statistic, s) => figureOf(statistic(total, n), draws[s], lines.level, factor)) }
}

/** Each statistic over the rows, with its interval from resampling their hours in blocks of `blockHours`
 * (the horizon's length, which is also how far the outcomes overlap); null with nothing to resample (no
 * row, no statistic, or fewer blocks than an interval needs). */
export function bootstrapOverHours(entries: readonly HourSample[], statistics: readonly Statistic[], blockHours: number, lines: UncertaintyLines = UNCERTAINTY_LINES): Resampled | null {
  if (entries.length === 0 || statistics.length === 0) return null
  const width = entries[0].sample.length
  const { hours, byHour } = summed(entries, width)
  const block = Math.max(1, Math.floor(blockHours))
  if (Math.ceil(hours.length / block) < lines.minBlocks) return null
  return resample(
    hours.map((hour) => byHour.get(hour)!),
    width,
    block,
    statistics,
    lines
  )
}

export interface PairedDifference {
  /** The statistic on B less the statistic on A, over the hours both hold. */
  difference: Figure
  a: number
  b: number
  hours: number
  blocks: number
  draws: number
}

/** Two scorings set against each other on the hours both hold, each draw taking an hour from both: the
 * interval of the difference B - A, for a change judged beyond noise. Null where fewer hours are shared
 * than an interval needs. */
export function pairedBootstrap(a: readonly HourSample[], b: readonly HourSample[], statistic: Statistic, blockHours: number, lines: UncertaintyLines = UNCERTAINTY_LINES): PairedDifference | null {
  if (a.length === 0 || b.length === 0) return null
  const width = a[0].sample.length
  const left = summed(a, width)
  const right = summed(b, width)
  const shared = left.hours.filter((hour) => right.byHour.has(hour))
  const block = Math.max(1, Math.floor(blockHours))
  if (Math.ceil(shared.length / block) < lines.minBlocks) return null
  // Both scorings' sums of an hour side by side, each with its own rows, so that a draw takes the hour from both.
  const hours: HourSums[] = shared.map((hour) => {
    const x = left.byHour.get(hour)!
    const y = right.byHour.get(hour)!
    const sums = new Float64Array(2 * width + 2)
    sums.set(x.sums, 0)
    sums.set(y.sums, width)
    sums[2 * width] = x.n
    sums[2 * width + 1] = y.n
    return { n: x.n + y.n, sums }
  })
  const ofA: Statistic = (sums): number => statistic(sums.subarray(0, width), sums[2 * width])
  const ofB: Statistic = (sums): number => statistic(sums.subarray(width, 2 * width), sums[2 * width + 1])
  const made = resample(hours, 2 * width + 2, block, [(sums, n): number => ofB(sums, n) - ofA(sums, n), ofA, ofB], lines)
  return { difference: made.figures[0], a: made.figures[1].value, b: made.figures[2].value, hours: made.hours, blocks: made.blocks, draws: made.draws }
}

/** How many independent outcomes would spread as these did: the rows' own variance over the draws'
 * variance of their mean. For a share p the rows' variance is p(1 - p). */
export function effectiveSampleSize(rowVariance: number, bootstrapSd: number): number {
  return Number.isFinite(rowVariance) && Number.isFinite(bootstrapSd) && rowVariance > 0 && bootstrapSd > 0 ? rowVariance / bootstrapSd ** 2 : Number.NaN
}

export const shareVariance = (share: number): number => share * (1 - share)

/** The smallest skill a sample could tell from zero: the detectable standard deviations times the draws'. */
export function detectableSkill(bootstrapSd: number, lines: UncertaintyLines = UNCERTAINTY_LINES): number {
  return Number.isFinite(bootstrapSd) && bootstrapSd > 0 ? lines.detectableSds * bootstrapSd : Number.NaN
}

/** A figure's interval, held inside `bounds` where the figure has them (a share lies in [0, 1]); null where
 * none could be read. */
export function intervalOf(figure: Figure | undefined, bounds?: readonly [number, number]): Interval | null {
  if (figure === undefined || !Number.isFinite(figure.low) || !Number.isFinite(figure.high)) return null
  if (bounds === undefined) return { low: figure.low, high: figure.high }
  return { low: Math.min(bounds[1], Math.max(bounds[0], figure.low)), high: Math.min(bounds[1], Math.max(bounds[0], figure.high)) }
}

/** The bounds of a share. */
export const SHARE: readonly [number, number] = [0, 1]
