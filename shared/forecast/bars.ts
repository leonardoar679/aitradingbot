import { bucketTimeFor } from '../aggregateCandles'
import type { Interval } from '../ipc'

// THE FORECAST'S OWN BARS (the V6 document, §15 and §40; V6 Stage 2, 13 October 2026).
//
// The price forecast learns from five-minute bars of the liquid USDT pairs over ninety days, and
// predicts from the same bars as they close. It keeps its own: the app's Candle carries open, high,
// low, close and volume, and the forecast also needs what each bar's buyers did -- the taker-buy
// volume Binance's klines carry, the document's "buy/sell pressure" -- and its number of trades.
// So these bars are their own type, kept in their own files (forecastData/, the main process's
// forecastDataService.ts), and nothing else in the app changes for them: not the Candle, not the
// intervals a chart offers.
//
// WHAT A BAR IS. Binance's five-minute kline, as it closed: opened at `time`, closed
// FORECAST_BAR_SECONDS later. A bar still forming is never stored and never read.
//
// NOTHING AFTER T. Everything the forecast reads at a moment T goes through barsUpTo: the bars that
// had closed by T, and nothing else (the document's §53). The coarser bars are built from the
// five-minute ones by the same bucket rule the app uses everywhere (shared/aggregateCandles.ts), so
// an hour reads the same in training and live, and an hour that had not ended by T is not one.
//
// IT READS PUBLIC DATA. No key, no model, no order.

export const FORECAST_DATA_VERSION = 'forecast-bars-v1'
export const FORECAST_BAR_SECONDS = 300
/** How far back the forecast's bars reach: what it trains on. */
export const FORECAST_HISTORY_DAYS = 90
/** Binance's most klines in one request. */
export const KLINES_PAGE = 1000
/** What one klines request weighs against Binance's per-minute budget. */
export const KLINES_WEIGHT = 2

export interface ForecastBar {
  /** When the bar opened, Unix seconds; it closed FORECAST_BAR_SECONDS later. */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** In the base asset. */
  volume: number
  /** In USDT. */
  quoteVolume: number
  /** Of `volume`, what market buyers took: above half of it, buyers pressed. */
  takerBuyVolume: number
  trades: number
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A bar from its parts, or null when one is missing, not a number, or does not make a bar: a high
 * under the low, a price at or under zero, a negative volume, or a taker volume above the volume. */
function barOf(parts: unknown[]): ForecastBar | null {
  const [time, open, high, low, close, volume, quoteVolume, takerBuyVolume, trades] = parts
  if (![time, open, high, low, close, volume, quoteVolume, takerBuyVolume, trades].every(finite)) return null
  const bar = { time, open, high, low, close, volume, quoteVolume, takerBuyVolume, trades } as ForecastBar
  // Off a five-minute boundary is off a whole second too.
  if (bar.time % FORECAST_BAR_SECONDS !== 0) return null
  if (!(bar.low > 0) || bar.open < bar.low || bar.open > bar.high || bar.close < bar.low || bar.close > bar.high) return null
  // A volume under zero is under its taker part, which is not.
  if (bar.quoteVolume < 0 || bar.trades < 0 || bar.takerBuyVolume < 0 || bar.takerBuyVolume > bar.volume * (1 + 1e-9)) return null
  return bar
}

/** One of Binance's kline rows -- [open time ms, open, high, low, close, volume, close time ms,
 * quote volume, trades, taker-buy base volume, taker-buy quote volume, ignore] -- as a bar; null
 * when it is not one. */
export function barFromKline(row: unknown): ForecastBar | null {
  if (!Array.isArray(row)) return null
  return barOf([Number(row[0]) / 1000, Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5]), Number(row[7]), Number(row[9]), Number(row[8])])
}

/** A bar as one line on file: its nine figures, in order. */
export function barToLine(bar: ForecastBar): number[] {
  return [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.takerBuyVolume, bar.trades]
}

/** A line on file as a bar; null for one that is not (a short one is missing a figure). */
export function barFromLine(value: unknown): ForecastBar | null {
  return Array.isArray(value) ? barOf(value) : null
}

/** The month a bar's file is named for, `YYYY-MM`, in UTC. */
export function barMonthKey(timeSec: number): string {
  return new Date(timeSec * 1000).toISOString().slice(0, 7)
}

/** The start of the five-minute bar a moment falls in. */
export function barStart(timeSec: number): number {
  return Math.floor(timeSec / FORECAST_BAR_SECONDS) * FORECAST_BAR_SECONDS
}

/** The last bar that had closed by `nowSec`: the one that opened a whole bar before the current one. */
export function lastClosedBarTime(nowSec: number): number {
  return barStart(nowSec) - FORECAST_BAR_SECONDS
}

/** Bars oldest first, each time once: a bar read again (a repair) replaces the one held. */
export function mergeBars(existing: readonly ForecastBar[], incoming: readonly ForecastBar[]): ForecastBar[] {
  const byTime = new Map<number, ForecastBar>()
  for (const bar of existing) byTime.set(bar.time, bar)
  for (const bar of incoming) byTime.set(bar.time, bar)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

/** The stretches of missing bars between `fromSec` and `toSec` (both bar opens, inclusive), given
 * bars oldest first: each as the first and the last missing bar's open. */
export function missingSpans(bars: readonly ForecastBar[], fromSec: number, toSec: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let expected = barStart(fromSec)
  const last = barStart(toSec)
  for (const bar of bars) {
    if (bar.time < expected) continue
    if (bar.time > last) break
    if (bar.time > expected) out.push({ from: expected, to: bar.time - FORECAST_BAR_SECONDS })
    expected = bar.time + FORECAST_BAR_SECONDS
  }
  if (expected <= last) out.push({ from: expected, to: last })
  return out
}

/** The index of the first bar that had NOT closed by `tSec`, in bars oldest first. */
function closedCount(bars: readonly ForecastBar[], tSec: number): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (bars[middle].time + FORECAST_BAR_SECONDS <= tSec) low = middle + 1
    else high = middle
  }
  return low
}

/** The bars that had closed by `tSec` (§53): nothing that closed after it, oldest first. */
export function barsUpTo(bars: readonly ForecastBar[], tSec: number): ForecastBar[] {
  return bars.slice(0, closedCount(bars, tSec))
}

/** The coarser bars the forecast reads. */
export type CoarseWidth = Extract<Interval, '15m' | '1h' | '4h' | '1d'>
export const COARSE_SECONDS: Record<CoarseWidth, number> = { '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 }

export interface CoarseBar extends ForecastBar {
  /** The five-minute bars it was built from: fewer than a full bucket's where the exchange had a gap. */
  parts: number
}

/** Five-minute bars, oldest first, merged into `width` buckets by the app's bucket rule: the open of
 * the first, the close of the last, the high and the low of all, the volumes and trades summed. Only
 * a bucket that had ended by `tSec` is one; a leading bucket the bars start partway into is left
 * out, as aggregateCandles leaves it out, because its open and its range never saw its start. */
export function coarseBars(bars: readonly ForecastBar[], width: CoarseWidth, tSec: number): CoarseBar[] {
  const seconds = COARSE_SECONDS[width]
  const out: CoarseBar[] = []
  const closed = barsUpTo(bars, tSec)
  if (closed.length === 0) return out
  // The bars start partway into their first bucket: it is not whole at its front, and is left out.
  const firstBucket = bucketTimeFor(closed[0].time, width)
  const skipFirst = closed[0].time !== firstBucket
  for (const bar of closed) {
    const bucket = bucketTimeFor(bar.time, width)
    if (skipFirst && bucket === firstBucket) continue
    if (bucket + seconds > tSec) break
    const current = out[out.length - 1]
    if (current !== undefined && current.time === bucket) {
      current.high = Math.max(current.high, bar.high)
      current.low = Math.min(current.low, bar.low)
      current.close = bar.close
      current.volume += bar.volume
      current.quoteVolume += bar.quoteVolume
      current.takerBuyVolume += bar.takerBuyVolume
      current.trades += bar.trades
      current.parts++
    } else {
      out.push({ ...bar, time: bucket, parts: 1 })
    }
  }
  return out
}

/** The coarse bars of a series built once (coarseBars at the end of the data) that had ended by
 * `tSec`: the same bars coarseBars builds at `tSec` from the same five-minute bars, without building
 * them again for every moment a model is trained at. */
export function coarseUpTo(series: readonly CoarseBar[], width: CoarseWidth, tSec: number): CoarseBar[] {
  const seconds = COARSE_SECONDS[width]
  let low = 0
  let high = series.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (series[middle].time + seconds <= tSec) low = middle + 1
    else high = middle
  }
  return series.slice(0, low)
}

/** Whether a month file (`YYYY-MM`) holds nothing the forecast keeps: its month ended before the
 * history began. A name that is not a month is never stale. */
export function staleMonth(month: string, nowSec: number, days: number = FORECAST_HISTORY_DAYS): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (match === null) return false
  const monthEnd = Date.UTC(Number(match[1]), Number(match[2]), 1) / 1000
  return monthEnd <= nowSec - days * 86_400
}

/** What the forecast's data stands at, for its card and the log. */
export interface ForecastDataStatus {
  version: string
  /** Pairs in the forecast's universe. */
  pairs: number
  /** Of them, brought up to date this session. */
  ready: number
  /** Requests made this session, and the weight they carried against the exchange's budget. */
  requests: number
  weight: number
  failures: number
  barsWritten: number
  lastPassAt: number | null
  lastError: string | null
  /** Seconds: a rate limit's wait, while it lasts. */
  rateLimitedUntil: number | null
  /** The data host whose bars were refused, while it serves another market than binance.com's. */
  refusedHost: string | null
  /** Month files deleted at start, past the history kept. */
  monthsSwept: number
}

/** Where the next page of a backfill starts: at the bar after `lastStored`, or FORECAST_HISTORY_DAYS
 * back when nothing is stored or what is stored is older than that; null once the last bar closed by
 * `nowSec` is stored. Each page starts after the one before it ended, never at a start worked out in
 * advance: a page that spans a gap the exchange left reaches further than a thousand bars' time. */
export function nextPageStart(lastStored: number | null, nowSec: number, days: number = FORECAST_HISTORY_DAYS): number | null {
  const earliest = barStart(nowSec - days * 86_400)
  const from = lastStored === null ? earliest : Math.max(earliest, lastStored + FORECAST_BAR_SECONDS)
  return from <= lastClosedBarTime(nowSec) ? from : null
}
