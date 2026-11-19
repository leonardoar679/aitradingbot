import type { Horizon } from '../forecast/features'
import type { OutcomeLine } from '../forecast/forecastRecord'

// THE ACCURACY BOARD (V10 Stage 2, 19 November 2026). The person asked to be shown, a day or a few days after each
// prediction, how accurate it was: whether its direction was right, and what share of the predicted move happened.
// This reads the price forecast's settled outcomes that way, horizon by horizon and day by day:
//   - THE WAY IT POINTED. A forecast's middle (P50) points up or down, or nowhere. Of the outcomes that rose, how many
//     had a forecast pointing up; of those that fell, how many pointing down. Their mean is the balanced share: always
//     pointing one way scores 50% exactly, so a falling week cannot pass for skill (in the seven-day run of 9-16
//     November every 24-hour middle pointed down while Bitcoin fell 14%: right on 100% of the falls and 0% of the
//     rises, 50% balanced). The way the app CALLED (UP or DOWN, rarely) is counted the same, apart.
//   - THE SIZE. The real move's size against the size the forecast expected either way (shared/forecast/size.ts), as a
//     ratio of their sums: 1 is a forecast that knew how far.
//   - THE RANGE. How often the close fell inside the 80% range, under its P10 and over its P90.
// Its intervals resample whole UTC days (coins move together, so a day's outcomes are one piece of evidence, not sixty).
// It reads what is recorded and decides nothing.

export const ACCURACY_BOARD_VERSION = 'accuracy-board-v1'

export const BOARD_LINES = {
  version: ACCURACY_BOARD_VERSION,
  /** The days kept and shown. */
  days: 30,
  /** A middle this close to no move, in percent, points nowhere. */
  pointsFromPct: 0.0001,
  /** The latest settled outcomes kept for the forecast-by-forecast list. */
  recentKept: 240,
  draws: 2000,
  seed: 20261119,
  level: 0.95
} as const

/** One UTC day's settled outcomes at one horizon, counted. */
export interface BoardTally {
  n: number
  /** Outcomes that rose and fell (a close at no move is neither). */
  ups: number
  downs: number
  /** Of those, the ones whose middle pointed a way, and the ones it pointed the right way. */
  upPointed: number
  upPointedRight: number
  downPointed: number
  downPointedRight: number
  /** Of those, the ones the app called UP or DOWN, and the ones it called right. */
  upCalled: number
  upCalledRight: number
  downCalled: number
  downCalledRight: number
  /** Outcomes with the forecast's expected size, its sum and the sum of the real moves' sizes, in percent. */
  sized: number
  sizeSum: number
  moveSum: number
  /** Inside the 80% range, under its P10, over its P90. */
  in80: number
  belowP10: number
  aboveP90: number
}

export interface BoardDay {
  day: number
  h: Horizon
  tally: BoardTally
}

export const emptyTally = (): BoardTally => ({ n: 0, ups: 0, downs: 0, upPointed: 0, upPointedRight: 0, downPointed: 0, downPointedRight: 0, upCalled: 0, upCalledRight: 0, downCalled: 0, downCalledRight: 0, sized: 0, sizeSum: 0, moveSum: 0, in80: 0, belowP10: 0, aboveP90: 0 })

/** The UTC day an outcome is counted on: the close it was settled at, else its due moment. */
export const boardDayOf = (outcome: Pick<OutcomeLine, 'at' | 'due'>): number => Math.floor((outcome.at ?? outcome.due) / 86_400) * 86_400

/** Where a forecast's middle points: up, down or nowhere. */
export function pointsOf(mid: number | undefined): 'up' | 'down' | null {
  if (mid === undefined || !Number.isFinite(mid) || Math.abs(mid) < BOARD_LINES.pointsFromPct) return null
  return mid > 0 ? 'up' : 'down'
}

/** A settled outcome counted into a tally (in place). An outcome without its middle (one written before V10) counts in
 * the range alone, and in the size where it has one. */
export function addToTally(tally: BoardTally, outcome: Pick<OutcomeLine, 'move' | 'below' | 'in80' | 'dir' | 'mid' | 'size'>): void {
  tally.n++
  if (outcome.in80) tally.in80++
  if (outcome.below[0] === '1') tally.belowP10++
  if (outcome.below[4] === '0') tally.aboveP90++
  if (typeof outcome.size === 'number' && Number.isFinite(outcome.size) && outcome.size > 0) {
    tally.sized++
    tally.sizeSum += outcome.size
    tally.moveSum += Math.abs(outcome.move)
  }
  if (outcome.move === 0) return
  const rose = outcome.move > 0
  if (rose) tally.ups++
  else tally.downs++
  const points = pointsOf(outcome.mid)
  if (points !== null) {
    if (rose) {
      tally.upPointed++
      if (points === 'up') tally.upPointedRight++
    } else {
      tally.downPointed++
      if (points === 'down') tally.downPointedRight++
    }
  }
  const called = outcome.dir === 'BULLISH' ? 'up' : outcome.dir === 'BEARISH' ? 'down' : null
  if (called !== null) {
    if (rose) {
      tally.upCalled++
      if (called === 'up') tally.upCalledRight++
    } else {
      tally.downCalled++
      if (called === 'down') tally.downCalledRight++
    }
  }
}

/** Tallies summed. */
export function sumTallies(tallies: readonly BoardTally[]): BoardTally {
  const total = emptyTally()
  for (const tally of tallies) for (const key of Object.keys(total) as (keyof BoardTally)[]) total[key] += tally[key]
  return total
}

/** A figure with its interval from resampling whole days; null where it cannot be read. */
export interface BoardFigure {
  value: number
  low: number | null
  high: number | null
}

/** A way read on the rises and the falls apart, and their mean. */
export interface WayFigures {
  /** How many outcomes the way was read on (those it pointed or called on). */
  n: number
  rightOnRising: BoardFigure | null
  rightOnFalling: BoardFigure | null
  balanced: BoardFigure | null
}

export interface BoardHorizon {
  h: Horizon
  days: number
  n: number
  /** The share of the outcomes whose middle pointed a way, and that way read. */
  pointedShare: number | null
  pointed: WayFigures
  /** The app's own UP and DOWN calls. */
  called: WayFigures
  /** The real moves' size over the expected size. */
  sizeRatio: BoardFigure | null
  in80: BoardFigure | null
  belowP10: BoardFigure | null
  aboveP90: BoardFigure | null
}

type Statistic = (tally: BoardTally) => number | null

const ratio = (top: number, bottom: number): number | null => (bottom > 0 ? top / bottom : null)

const STATISTICS: Record<string, Statistic> = {
  pointedRising: (t) => ratio(t.upPointedRight, t.upPointed),
  pointedFalling: (t) => ratio(t.downPointedRight, t.downPointed),
  pointedBalanced: (t) => (t.upPointed > 0 && t.downPointed > 0 ? (t.upPointedRight / t.upPointed + t.downPointedRight / t.downPointed) / 2 : null),
  calledRising: (t) => ratio(t.upCalledRight, t.upCalled),
  calledFalling: (t) => ratio(t.downCalledRight, t.downCalled),
  calledBalanced: (t) => (t.upCalled > 0 && t.downCalled > 0 ? (t.upCalledRight / t.upCalled + t.downCalledRight / t.downCalled) / 2 : null),
  sizeRatio: (t) => ratio(t.moveSum, t.sizeSum),
  in80: (t) => ratio(t.in80, t.n),
  belowP10: (t) => ratio(t.belowP10, t.n),
  aboveP90: (t) => ratio(t.aboveP90, t.n)
}

/** A seeded generator (mulberry32), so a board reads the same each time it is read. */
function rngOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Each statistic over the days' tallies summed, with a percentile interval from resampling the days (with replacement);
 * no interval with fewer than two days. */
function figuresOverDays(days: readonly BoardTally[], names: readonly string[]): Record<string, BoardFigure | null> {
  const total = sumTallies(days)
  const out: Record<string, BoardFigure | null> = {}
  const draws: Record<string, number[]> = Object.fromEntries(names.map((name) => [name, []]))
  if (days.length >= 2) {
    const random = rngOf(BOARD_LINES.seed)
    for (let draw = 0; draw < BOARD_LINES.draws; draw++) {
      const picked = sumTallies(Array.from({ length: days.length }, () => days[Math.floor(random() * days.length)]))
      for (const name of names) {
        const value = STATISTICS[name](picked)
        if (value !== null) draws[name].push(value)
      }
    }
  }
  const tail = (1 - BOARD_LINES.level) / 2
  for (const name of names) {
    const value = STATISTICS[name](total)
    if (value === null) {
      out[name] = null
      continue
    }
    const sorted = draws[name].sort((a, b) => a - b)
    // An interval only where most draws could read the figure.
    const enough = sorted.length >= BOARD_LINES.draws * 0.9
    out[name] = { value, low: enough ? sorted[Math.floor(tail * (sorted.length - 1))] : null, high: enough ? sorted[Math.ceil((1 - tail) * (sorted.length - 1))] : null }
  }
  return out
}

/** A horizon's board over the days given (each day's tally once). */
export function boardHorizonOf(h: Horizon, days: readonly BoardTally[]): BoardHorizon {
  const total = sumTallies(days)
  const figures = figuresOverDays(days, Object.keys(STATISTICS))
  const way = (prefix: 'pointed' | 'called', n: number): WayFigures => ({ n, rightOnRising: figures[`${prefix}Rising`], rightOnFalling: figures[`${prefix}Falling`], balanced: figures[`${prefix}Balanced`] })
  const moved = total.ups + total.downs
  return {
    h,
    days: days.length,
    n: total.n,
    pointedShare: moved > 0 ? (total.upPointed + total.downPointed) / moved : null,
    pointed: way('pointed', total.upPointed + total.downPointed),
    called: way('called', total.upCalled + total.downCalled),
    sizeRatio: figures.sizeRatio,
    in80: figures.in80,
    belowP10: figures.belowP10,
    aboveP90: figures.aboveP90
  }
}

/** One settled forecast as the board lists it: what it expected, and what came. */
export interface BoardEntry {
  pair: string
  h: Horizon
  /** When it was forecast and when settled, in seconds. */
  t: number
  at: number
  /** The middle, the size expected either way, and the real move, in percent; whether it fell inside the 80% range. */
  mid: number | null
  size: number | null
  move: number
  in80: boolean
  /** The way the app called, or null where it called none. */
  called: 'up' | 'down' | null
}

export function boardEntryOf(outcome: OutcomeLine): BoardEntry {
  return {
    pair: outcome.pair,
    h: outcome.h,
    t: outcome.t,
    at: outcome.at ?? outcome.due,
    mid: typeof outcome.mid === 'number' ? outcome.mid : null,
    size: typeof outcome.size === 'number' ? outcome.size : null,
    move: outcome.move,
    in80: outcome.in80,
    called: outcome.dir === 'BULLISH' ? 'up' : outcome.dir === 'BEARISH' ? 'down' : null
  }
}

/** What the window is told: each horizon over the kept days and over the last day, and the latest settled forecasts. */
export interface AccuracyBoard {
  version: typeof ACCURACY_BOARD_VERSION
  /** When it was last added to, in seconds; null before any outcome. */
  updatedAt: number | null
  /** The first and last day counted. */
  from: number | null
  to: number | null
  /** Over the kept days, and over the newest day alone. */
  horizons: BoardHorizon[]
  lastDay: BoardHorizon[]
  recent: BoardEntry[]
  /** Where the days before this build are still being read from the record. */
  filling: boolean
}

/** The board from its days and latest entries. */
export function accuracyBoardOf(days: readonly BoardDay[], recent: readonly BoardEntry[], horizons: readonly Horizon[], updatedAt: number | null, filling = false): AccuracyBoard {
  const kept = days.filter((entry) => entry.tally.n > 0)
  const dayStarts = [...new Set(kept.map((entry) => entry.day))].sort((a, b) => a - b)
  const newest = dayStarts.length === 0 ? null : dayStarts[dayStarts.length - 1]
  const byHorizon = (h: Horizon, only?: number): BoardHorizon => boardHorizonOf(h, kept.filter((entry) => entry.h === h && (only === undefined || entry.day === only)).map((entry) => entry.tally))
  return {
    version: ACCURACY_BOARD_VERSION,
    updatedAt,
    from: dayStarts[0] ?? null,
    to: newest,
    horizons: horizons.map((h) => byHorizon(h)),
    lastDay: newest === null ? [] : horizons.map((h) => byHorizon(h, newest)),
    recent: [...recent].sort((a, b) => b.at - a.at || a.pair.localeCompare(b.pair)),
    filling
  }
}
