import { DAILY_HORIZONS, DAILY_HORIZON_DAYS, DAILY_SIZE_LINES, bandFactors, dailyQuantilesPct, dailySigma, logMove, type DailyHorizon, type DayBar } from './dailySize'
import { expectedMove } from '../size'

// THE DAILY FORECAST'S RECORD (V10 Stage 4, 19 November 2026; V10-DAILY-SIZE held). Each UTC day, a little after it opens,
// each coin of the forecast's universe gets its five levels over one, three and seven days from its day's open
// (shared/forecast/daily/dailySize.ts), kept as a line of forecasts/daily-predictions-YYYY.jsonl; when the days are up,
// its outcome, a line of forecasts/daily-outcomes-YYYY.jsonl, counted on the accuracy board like the five-minute
// forecast's. The ranges' widths are read each day from the thousand days of moves before it, every coin's, on the
// horizon's own days (every day for one, every third day for three, each Monday for seven), as the study read them.

export const DAILY_RECORD_VERSION = 'daily-forecast-v1'

const DAY = 86_400
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

export interface DailyLevels {
  /** The five levels in percent from the day's open, and the move expected either way. */
  q: number[]
  size: number
}

export interface DailyPredictionLine {
  v: typeof DAILY_RECORD_VERSION
  id: string
  pair: string
  /** The UTC day it forecasts from, in seconds, and when it was made. */
  day: number
  at: number
  /** The day's open: the price the moves are measured from. */
  price: number
  /** The daily spread it read. */
  sigma: number
  h: Partial<Record<DailyHorizon, DailyLevels>>
}

export interface DailyOutcomeLine {
  v: typeof DAILY_RECORD_VERSION
  id: string
  pair: string
  h: DailyHorizon
  day: number
  /** When the horizon's last day closed, and when the outcome was settled. */
  due: number
  at: number
  /** The move from the day's open to the close of the horizon's last day, in percent; where it fell against the five
   * levels (1: at or under); whether inside the 80% range; the middle (no move) and the size expected. */
  move: number
  below: string
  in80: boolean
  mid: number
  size: number
}

/** Today's daily forecasts as the window shows them. */
export interface DailyForecastView {
  /** The UTC day the forecasts are from, and when they were made; null before the first. */
  day: number | null
  at: number | null
  rows: { pair: string; price: number; h: DailyPredictionLine['h'] }[]
  /** Why there is none today, where there is none. */
  problem: string | null
}

/** The days a horizon's widths are read on (as research/v10DailySize.ts and v10Direction.mjs call). */
export function onHorizonGrid(day: number, h: number): boolean {
  if (h === 3) return (day / DAY) % 3 === 0
  if (h === 7) return new Date(day * 1000).getUTCDay() === 1
  return true
}

/** Each horizon's widths from every coin's moves on its days over the thousand days before `day`, whose horizon had
 * ended by then; null for a horizon with too few. */
export function dailyFactorsOf(bars: ReadonlyMap<string, ReadonlyMap<number, DayBar>>, day: number): Partial<Record<DailyHorizon, [number, number]>> {
  const out: Partial<Record<DailyHorizon, [number, number]>> = {}
  for (const horizon of DAILY_HORIZONS) {
    const h = DAILY_HORIZON_DAYS[horizon]
    const zs: number[] = []
    for (const byDay of bars.values()) {
      for (let at = day - DAILY_SIZE_LINES.fitDays * DAY; at + h * DAY <= day; at += DAY) {
        if (!onHorizonGrid(at, h)) continue
        const sigma = dailySigma(byDay, at)
        const move = logMove(byDay, at, h)
        if (sigma !== null && move !== null) zs.push(move / (sigma * Math.sqrt(h)))
      }
    }
    const factors = bandFactors(zs)
    if (factors !== null) out[horizon] = factors
  }
  return out
}

/** A coin's forecast for the day starting at `day`, from its bars before it and its day's open; null where its spread
 * cannot be read or no horizon has widths. */
export function dailyPredictionOf(pair: string, byDay: ReadonlyMap<number, DayBar>, day: number, open: number, factors: Partial<Record<DailyHorizon, [number, number]>>, atSec: number): DailyPredictionLine | null {
  const sigma = dailySigma(byDay, day)
  if (sigma === null || !(open > 0)) return null
  const h: Partial<Record<DailyHorizon, DailyLevels>> = {}
  for (const horizon of DAILY_HORIZONS) {
    const fitted = factors[horizon]
    if (fitted === undefined) continue
    const q = dailyQuantilesPct(sigma, DAILY_HORIZON_DAYS[horizon], fitted).map(round4)
    h[horizon] = { q, size: round4(expectedMove(q)) }
  }
  if (Object.keys(h).length === 0) return null
  return { v: DAILY_RECORD_VERSION, id: `${pair}:${day}`, pair, day, at: atSec, price: open, sigma: Math.round(sigma * 1e7) / 1e7, h }
}

/** A forecast's outcome at a horizon from the coin's bars, once the horizon's last day has closed; null before, or where
 * a bar is missing. */
export function dailyOutcomeOf(line: DailyPredictionLine, horizon: DailyHorizon, byDay: ReadonlyMap<number, DayBar>, atSec: number): DailyOutcomeLine | null {
  const levels = line.h[horizon]
  const h = DAILY_HORIZON_DAYS[horizon]
  if (levels === undefined) return null
  const lastClose = byDay.get(line.day + (h - 1) * DAY)?.close
  if (lastClose === undefined || !(lastClose > 0)) return null
  for (let k = 0; k < h; k++) if (!byDay.has(line.day + k * DAY)) return null
  const move = (lastClose / line.price - 1) * 100
  return {
    v: DAILY_RECORD_VERSION,
    id: line.id,
    pair: line.pair,
    h: horizon,
    day: line.day,
    due: line.day + h * DAY,
    at: atSec,
    move: round4(move),
    below: levels.q.map((level) => (move <= level ? '1' : '0')).join(''),
    in80: move >= levels.q[0] && move <= levels.q[4],
    mid: levels.q[2],
    size: levels.size
  }
}

export function parseDailyPrediction(value: unknown): DailyPredictionLine | null {
  const raw = value as Partial<DailyPredictionLine> | null
  if (typeof raw !== 'object' || raw === null || raw.v !== DAILY_RECORD_VERSION || typeof raw.id !== 'string' || typeof raw.pair !== 'string') return null
  if (typeof raw.day !== 'number' || typeof raw.price !== 'number' || !(raw.price > 0) || typeof raw.h !== 'object' || raw.h === null) return null
  for (const [horizon, levels] of Object.entries(raw.h)) {
    if (!(DAILY_HORIZONS as readonly string[]).includes(horizon)) return null
    const entry = levels as Partial<DailyLevels> | undefined
    if (entry === undefined || !Array.isArray(entry.q) || entry.q.length !== 5 || !entry.q.every(Number.isFinite) || typeof entry.size !== 'number') return null
  }
  return raw as DailyPredictionLine
}

export function parseDailyOutcome(value: unknown): DailyOutcomeLine | null {
  const raw = value as Partial<DailyOutcomeLine> | null
  if (typeof raw !== 'object' || raw === null || raw.v !== DAILY_RECORD_VERSION || typeof raw.id !== 'string' || !(DAILY_HORIZONS as readonly string[]).includes(raw.h as string)) return null
  if (typeof raw.move !== 'number' || typeof raw.below !== 'string' || !/^[01]{5}$/.test(raw.below)) return null
  return raw as DailyOutcomeLine
}
