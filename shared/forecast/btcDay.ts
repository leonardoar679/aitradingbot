import { FORECAST_BAR_SECONDS, type ForecastBar } from './bars'
import { normalQuantile } from './r2'

// BITCOIN'S DAY (V9 Stage 1, 6 November 2026; V9-BTC-DAY). How likely Bitcoin's UTC day is to be a big one -- a close 2%
// or 4% from the day's open, either way, or a fall to 4% below it -- read as the frequency of such days on past days in
// the same third of trailing volatility: the standard deviation of the 30 daily close-to-close returns before the day.
// One rule for the study (research/v9BtcDay.ts, on Binance's daily bars since 2017) and for Home, which reads the
// day's third from the forecast's own five-minute bars.

/** A UTC day of Bitcoin: its start (seconds), open, high, low and close. */
export interface DayBar {
  day: number
  open: number
  high: number
  low: number
  close: number
}

export const BTC_DAY_TARGETS = ['close2', 'close4', 'fall4'] as const
export type BtcDayTarget = (typeof BTC_DAY_TARGETS)[number]

export const BTC_DAY_LINES = {
  /** The daily returns the trailing volatility is read over. */
  volDays: 30,
  /** A big day: the close this far from the open either way, or the low this far below it, in percent. */
  close2Pct: 2,
  close4Pct: 4,
  fall4Pct: 4
} as const

/** Whether a day met a target. */
export function hitOf(bar: DayBar, target: BtcDayTarget, lines = BTC_DAY_LINES): boolean {
  const close = Math.abs(bar.close / bar.open - 1) * 100
  if (target === 'close2') return close >= lines.close2Pct
  if (target === 'close4') return close >= lines.close4Pct
  return (1 - bar.low / bar.open) * 100 >= lines.fall4Pct
}

/** The trailing volatility before day `index`: the standard deviation of the volDays close-to-close returns ending at
 * the day before's close; null without them, or where a day is missing among them. */
export function trailingVolOf(bars: readonly DayBar[], index: number, lines = BTC_DAY_LINES): number | null {
  if (index < lines.volDays + 1) return null
  const returns: number[] = []
  for (let i = index - lines.volDays; i < index; i++) {
    if (bars[i].day - bars[i - 1].day !== 86_400) return null
    returns.push(bars[i].close / bars[i - 1].close - 1)
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1))
}

/** Which third a volatility falls in, by two cut points: 0 calm, 1 usual, 2 wild. */
export const thirdOf = (vol: number, cuts: readonly [number, number]): 0 | 1 | 2 => (vol < cuts[0] ? 0 : vol < cuts[1] ? 1 : 2)

/** UTC days built from five-minute bars, each from a whole day of them only (288 bars): the forecast's own bars. */
export function dayBarsOf(bars: readonly ForecastBar[]): DayBar[] {
  const perDay = 86_400 / FORECAST_BAR_SECONDS
  const byDay = new Map<number, ForecastBar[]>()
  for (const bar of bars) {
    const day = Math.floor(bar.time / 86_400) * 86_400
    const list = byDay.get(day)
    if (list === undefined) byDay.set(day, [bar])
    else list.push(bar)
  }
  const out: DayBar[] = []
  for (const [day, list] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length !== perDay) continue
    list.sort((a, b) => a.time - b.time)
    out.push({ day, open: list[0].open, high: Math.max(...list.map((bar) => bar.high)), low: Math.min(...list.map((bar) => bar.low)), close: list[list.length - 1].close })
  }
  return out
}

/** A share's Wilson interval at a two-sided level. */
export function wilsonInterval(hits: number, n: number, level = 0.95): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 }
  const z = normalQuantile(1 - (1 - level) / 2)
  const p = hits / n
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n)
  const half = (z / (1 + (z * z) / n)) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}
