// THE SIZE OF A COIN'S MOVE OVER ONE, THREE AND SEVEN DAYS (V10 Stage 4, 19 November 2026; registered as V10-DAILY-SIZE).
// The person asked what a coin will do tomorrow, the day after, a few days later. The five-minute forecast reaches a day
// at most: it keeps three days of live bars and ninety of history. Days need daily bars and a rule of their own.
//
// THE RULE. A day's variance by Garman and Klass's range estimator, from its open, high, low and close -- crypto trades
// every hour, so a daily bar holds the whole day. The variance a coming day is expected to have: half the mean of the last
// seven days', half the last thirty's. Over h days, h times it. A move over h days, in that unit (its log move over the
// square root), is z; the ranges are symmetric about no move -- no way is measured at these horizons unless V10-TSMOM's
// test passes -- each range's half the size within which its share of the z of the last thousand days fell, pooled over
// the coins: half of them for the 50% range, eight in ten for the 80%. The middle is no move; the size expected either
// way is read off the five levels as the five-minute forecast's is (shared/forecast/size.ts).

export const DAILY_HORIZONS = ['day1', 'days3', 'days7'] as const
export type DailyHorizon = (typeof DAILY_HORIZONS)[number]
export const DAILY_HORIZON_DAYS: Readonly<Record<DailyHorizon, number>> = { day1: 1, days3: 3, days7: 7 }

export const DAILY_SIZE_LINES = {
  version: 'daily-size-v1',
  /** The days the expected variance mixes, half each. */
  shortDays: 7,
  longDays: 30,
  /** The days of past moves the ranges' widths are read from, pooled over the coins. */
  fitDays: 1000,
  /** At least this many past moves before a width is read. */
  minFitMoves: 500,
  /** The ranges' nominal misses: the 50% range's and the 80% range's. */
  misses: [0.5, 0.2]
} as const

export interface DayBar {
  /** The UTC day's start, in seconds. */
  time: number
  open: number
  high: number
  low: number
  close: number
}

const DAY = 86_400
const LN2 = Math.log(2)

/** A day's variance by Garman and Klass, in log terms; null for a bar that cannot be read. */
export function garmanKlass(bar: Pick<DayBar, 'open' | 'high' | 'low' | 'close'>): number | null {
  if (!(bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0) || bar.high < bar.low) return null
  const range = Math.log(bar.high / bar.low)
  const body = Math.log(bar.close / bar.open)
  return Math.max(0, 0.5 * range * range - (2 * LN2 - 1) * body * body)
}

/** The daily standard deviation expected for the day starting at `day`, from the bars before it (by their day); null
 * where the thirty days before are not all held. */
export function dailySigma(byDay: ReadonlyMap<number, DayBar>, day: number): number | null {
  const variances: number[] = []
  for (let k = 1; k <= DAILY_SIZE_LINES.longDays; k++) {
    const bar = byDay.get(day - k * DAY)
    const variance = bar === undefined ? null : garmanKlass(bar)
    if (variance === null) return null
    variances.push(variance)
  }
  const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = 0.5 * mean(variances.slice(0, DAILY_SIZE_LINES.shortDays)) + 0.5 * mean(variances)
  return variance > 0 ? Math.sqrt(variance) : null
}

/** A move over h days from `day`'s open to the close h days on, in log terms; null where a bar is missing. */
export function logMove(byDay: ReadonlyMap<number, DayBar>, day: number, h: number): number | null {
  const first = byDay.get(day)
  const last = byDay.get(day + (h - 1) * DAY)
  if (first === undefined || last === undefined || !(first.open > 0) || !(last.close > 0)) return null
  for (let k = 1; k < h - 1; k++) if (!byDay.has(day + k * DAY)) return null
  return Math.log(last.close / first.open)
}

/** The ranges' widths from past moves' z: the size within which half fell and eight in ten; null with too few. */
export function bandFactors(zs: readonly number[]): [number, number] | null {
  const sizes = zs.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b)
  if (sizes.length < DAILY_SIZE_LINES.minFitMoves) return null
  const at = (share: number): number => sizes[Math.min(sizes.length - 1, Math.max(0, Math.ceil(share * sizes.length) - 1))]
  return [at(1 - DAILY_SIZE_LINES.misses[0]), at(1 - DAILY_SIZE_LINES.misses[1])]
}

/** A forecast's five levels in percent from the open: no move in the middle, each range its width times the spread over h
 * days, symmetric in log terms. */
export function dailyQuantilesPct(sigma: number, h: number, factors: readonly [number, number]): number[] {
  const spread = sigma * Math.sqrt(h)
  const pct = (log: number): number => (Math.exp(log) - 1) * 100
  const [inner, outer] = factors
  return [pct(-outer * spread), pct(-inner * spread), 0, pct(inner * spread), pct(outer * spread)]
}
