import { fitIsotonic, predictIsotonic } from './ml/isotonic'
import { UNCERTAINTY_LINES, bootstrapOverHours, effectiveSampleSize, shareVariance, type Figure, type UncertaintyLines } from './uncertainty'

// V8 R1 -- WHERE A COIN IS LIKELY TO MOVE A LOT (V8 Stage 11, 2 November 2026). The two lines registered on 26 October
// 2026 before either was measured (research/preregistered.jsonl V8-R1-SIZE, V8-R1-EITHER), read on the long walk
// forward's saved record of its expanding mode (March to September 2026): does the forecast's P10-P90 width, and then
// its either-way odds, rank the coin-hours whose close moves at least 1% at an hour, 2% at four hours and 5% at a day
// better than the coin's own trailing ninety-day rate of such moves; and are its either-way odds of 1% and 2% at an hour
// and four hours honest as stated.
//
// What the registrations leave to the code, fixed here before the first measurement:
// - A ranker's probability: its value mapped by an isotonic fit on the scored rows of the UTC months before the row's
//   own; the first scored month has none and is left out of every figure.
// - The base: the coin's trailing ninety-day rate of the target from its own five-minute bars at the row's hour
//   (shared/forecast/moveRates.ts, as the live big-mover list reads it); a row without one (under thirty days of hours
//   on file) is left out of every figure, and counted.
// - Blocks: hours at an hour, four hours at four hours, whole UTC days at a day.
// - A tenth's effective outcomes: its share's variance over its resampled spread squared (effectiveSampleSize); a tenth
//   with fewer than 100 is not judged, and a line with no tenth judged is not read.
// - The top decile: the tenth of the rows a probability ranks highest, ties at its floor kept. A ranker's top decile's
//   hit rate, at its lower bound, is set against the hit rate of the base's own top decile.
// - The either-way odds as stated: min(1, up + down) read off the five shown levels (closeOdds), not mapped.

export const R1_LINES = {
  version: 'r1-v1',
  /** The targets: a close at least this far away, either way, in percent. */
  targetsPct: { hour1: 1, hours4: 2, hours24: 5 },
  /** V8-R1-SIZE: the Brier skill's lower bound above this, every judged tenth within this of its share, the top
   * decile's hit rate's lower bound at least this times the base's. */
  minSkill: 0.01,
  tenthTolerance: 0.02,
  minEffective: 100,
  topShare: 0.1,
  topLift: 1.25,
  /** V8-R1-EITHER: the horizons and moves read. */
  either: { horizons: ['hour1', 'hours4'] as const, movesPct: [1, 2] as const },
  draws: 10_000
} as const

/** A row's month (UTC), a ranker's value at it, and whether the target came. */
export interface R1Point {
  month: string
  x: number
  y: 0 | 1
}

/** Each point's probability: an isotonic fit on the points of the months before its own; null in the first month, and
 * where its value cannot be read. */
export function isotonicByMonth(points: readonly R1Point[]): (number | null)[] {
  const months = [...new Set(points.map((point) => point.month))].sort()
  const out: (number | null)[] = new Array(points.length).fill(null)
  for (let k = 1; k < months.length; k++) {
    const before = points.filter((point) => point.month < months[k] && Number.isFinite(point.x)).map((point) => ({ x: point.x, y: point.y }))
    if (before.length === 0) continue
    const model = fitIsotonic(before)
    points.forEach((point, at) => {
      if (point.month === months[k] && Number.isFinite(point.x)) out[at] = predictIsotonic(model, point.x)
    })
  }
  return out
}

/** A scored row: its block (an hour, or a day at a day's horizon), a probability, the base's, and whether the target
 * came. */
export interface R1Row {
  block: number
  p: number
  base: number
  y: 0 | 1
}

const lines95 = (draws: number): UncertaintyLines => ({ ...UNCERTAINTY_LINES, draws, level: 0.95 })

/** The Brier skill over the base, 1 - sum (p - y)^2 / sum (base - y)^2, with its 95% interval by blocks. */
export function brierSkillOf(rows: readonly R1Row[], blockHours: number, lines = R1_LINES): Figure | null {
  if (rows.length === 0) return null
  const samples = rows.map((row) => ({ hour: row.block, sample: [(row.p - row.y) ** 2, (row.base - row.y) ** 2] }))
  const made = bootstrapOverHours(samples, [(sums: Float64Array): number => (sums[1] > 0 ? 1 - sums[0] / sums[1] : Number.NaN)], blockHours, lines95(lines.draws))
  return made === null ? null : made.figures[0]
}

/** The Brier score of a probability over rows: the mean of (p - y)^2. */
export const brierOf = (rows: readonly { p: number; y: 0 | 1 }[]): number => (rows.length === 0 ? Number.NaN : rows.reduce((sum, row) => sum + (row.p - row.y) ** 2, 0) / rows.length)

export interface Tenth {
  /** 0 for [0, 0.1), ... 9 for [0.9, 1]. */
  tenth: number
  n: number
  stated: number
  share: number
  /** Its effective outcomes; null where they cannot be read. */
  effective: number | null
  /** Within the tolerance of its share; null where the tenth is not judged (under the effective outcomes needed). */
  within: boolean | null
}

/** Each tenth of a probability: how many rows, the mean stated, the share that came, the effective outcomes, and
 * whether a judged tenth is within the tolerance. */
export function tenthsOf(rows: readonly { block: number; p: number; y: 0 | 1 }[], blockHours: number, lines = R1_LINES): Tenth[] {
  const out: Tenth[] = []
  for (let tenth = 0; tenth < 10; tenth++) {
    const mine = rows.filter((row) => Math.min(9, Math.floor(row.p * 10)) === tenth)
    if (mine.length === 0) continue
    const stated = mine.reduce((sum, row) => sum + row.p, 0) / mine.length
    const share = mine.reduce((sum, row) => sum + row.y, 0) / mine.length
    const made = bootstrapOverHours(
      mine.map((row) => ({ hour: row.block, sample: [row.y, 1] })),
      [(sums: Float64Array): number => (sums[1] > 0 ? sums[0] / sums[1] : Number.NaN)],
      blockHours,
      lines95(lines.draws)
    )
    const effectiveRead = made === null ? Number.NaN : effectiveSampleSize(shareVariance(share), made.figures[0].sd)
    const effective = Number.isFinite(effectiveRead) ? effectiveRead : null
    out.push({ tenth, n: mine.length, stated, share, effective, within: effective !== null && effective >= lines.minEffective ? Math.abs(stated - share) <= lines.tenthTolerance : null })
  }
  return out
}

/** The tenth of the rows a score ranks highest (ties at its floor kept): how many, and their hit rate with its 95%
 * interval by blocks. */
export function topTenthOf(rows: readonly { block: number; score: number; y: 0 | 1 }[], blockHours: number, lines = R1_LINES): { rows: number; hits: Figure | null } {
  if (rows.length === 0) return { rows: 0, hits: null }
  const scores = rows.map((row) => row.score).sort((a, b) => b - a)
  const floor = scores[Math.max(0, Math.ceil(rows.length * lines.topShare) - 1)]
  const mine = rows.filter((row) => row.score >= floor)
  const made = bootstrapOverHours(
    mine.map((row) => ({ hour: row.block, sample: [row.y, 1] })),
    [(sums: Float64Array): number => (sums[1] > 0 ? sums[0] / sums[1] : Number.NaN)],
    blockHours,
    lines95(lines.draws)
  )
  return { rows: mine.length, hits: made === null ? null : made.figures[0] }
}

export interface R1SizeVerdict {
  rows: number
  /** The base rate of the target over the rows. */
  rate: number
  skill: Figure | null
  tenths: Tenth[]
  top: { rows: number; hits: Figure | null }
  baseTop: { rows: number; hits: Figure | null }
  lines: { skill: boolean | null; tenths: boolean | null; top: boolean | null }
  passed: boolean
}

/** V8-R1-SIZE at a horizon for one ranker: its Brier skill over the base, its tenths, and its top decile against the
 * base's own. */
export function r1SizeVerdictOf(rows: readonly R1Row[], blockHours: number, lines = R1_LINES): R1SizeVerdict {
  const skill = brierSkillOf(rows, blockHours, lines)
  const tenths = tenthsOf(rows, blockHours, lines)
  const top = topTenthOf(
    rows.map((row) => ({ block: row.block, score: row.p, y: row.y })),
    blockHours,
    lines
  )
  const baseTop = topTenthOf(
    rows.map((row) => ({ block: row.block, score: row.base, y: row.y })),
    blockHours,
    lines
  )
  const judged = tenths.filter((tenth) => tenth.within !== null)
  const verdicts = {
    skill: skill === null ? null : skill.low > lines.minSkill,
    tenths: judged.length === 0 ? null : judged.every((tenth) => tenth.within === true),
    top: top.hits === null || baseTop.hits === null ? null : top.hits.low >= lines.topLift * baseTop.hits.value
  }
  return {
    rows: rows.length,
    rate: rows.length === 0 ? Number.NaN : rows.reduce((sum, row) => sum + row.y, 0) / rows.length,
    skill,
    tenths,
    top,
    baseTop,
    lines: verdicts,
    passed: verdicts.skill === true && verdicts.tenths === true && verdicts.top === true
  }
}

export interface R1EitherVerdict {
  rows: number
  rate: number
  tenths: Tenth[]
  brier: number
  baseBrier: number
  lines: { tenths: boolean | null; brier: boolean | null }
  passed: boolean
}

/** V8-R1-EITHER at a horizon and move: every judged tenth of the stated either-way chance within two points of its
 * share, and its Brier score below the trailing ninety-day rate's. */
export function r1EitherVerdictOf(rows: readonly R1Row[], blockHours: number, lines = R1_LINES): R1EitherVerdict {
  const tenths = tenthsOf(rows, blockHours, lines)
  const judged = tenths.filter((tenth) => tenth.within !== null)
  const brier = brierOf(rows)
  const baseBrier = brierOf(rows.map((row) => ({ p: row.base, y: row.y })))
  const verdicts = { tenths: judged.length === 0 ? null : judged.every((tenth) => tenth.within === true), brier: rows.length === 0 ? null : brier < baseBrier }
  return { rows: rows.length, rate: rows.length === 0 ? Number.NaN : rows.reduce((sum, row) => sum + row.y, 0) / rows.length, tenths, brier, baseBrier, lines: verdicts, passed: verdicts.tenths === true && verdicts.brier === true }
}
