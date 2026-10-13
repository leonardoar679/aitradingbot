import { BollingerBands, RSI } from 'technicalindicators'
import { computeAtr } from '../atr'
import { computeEma, wilderAdx } from '../indicators'
import type { Candle } from '../ipc'
import { marketRegimeOf, type MarketRegime } from '../marketResearch'
import { COARSE_SECONDS, FORECAST_BAR_SECONDS, coarseBars, type CoarseBar, type ForecastBar } from './bars'
import { usualMove } from './targets'

// WHAT THE FORECAST READS AT A MOMENT (the V6 document, §15-17 and §53; V6 Stage 3, 13 October 2026).
//
// A pair's state at T as one row of numbers: its moves over five minutes to a week, how far it has
// gone against how far it usually goes, its trend, where it stands in its day's and week's range,
// its volume and who pressed it, the indicators the strategies and the chart already compute (the
// same functions: shared/indicators.ts, shared/atr.ts, and RSI and Bollinger from technicalindicators,
// as shared/aiContext.ts uses them), Bitcoin's and ether's moves, the market's breadth and the alts
// against Bitcoin, the market's regime in its six words (shared/marketResearch.ts), the pair's class,
// and the hour and the weekday. News and the models' readings are not here: they enter afterwards,
// as adjusters (the document's §11).
//
// THREE PROPERTIES, EACH PINNED BY A TEST:
// 1. NOTHING AFTER T. Every figure is read from the bars that had closed by T (shared/forecast/bars.ts
//    barsUpTo), so a bar added or changed after T leaves the row at T the same to the byte.
// 2. THE SAME ROW HOWEVER MUCH HISTORY WAS HANDED IN. Every indicator is computed over a fixed window
//    ending at T -- an EMA, a Wilder average or an RSI carries memory of all it was given -- so a row
//    read in training, from ninety days, is the row read live, from the days the app holds.
// 3. A ROW OR NONE. Without the history a figure needs, there is no row: a figure is never guessed.
//
// IT IS ARITHMETIC. No key, no model, no order, nothing read from anywhere.

export const FEATURES_VERSION = 'features-v1'

/** The five horizons the forecast is made at, in five-minute bars. */
export const HORIZON_BARS = { minutes5: 1, minutes15: 3, hour1: 12, hours4: 48, hours24: 288 } as const
export type Horizon = keyof typeof HORIZON_BARS
export const HORIZONS = Object.keys(HORIZON_BARS) as Horizon[]

/** The windows each reading is computed over, fixed (property 2). */
const WINDOW = {
  /** Hours the hourly EMAs, RSI and ATR read: EMA200's seed weighs (1 - 2/201)^600, a quarter percent. */
  hourly: 600,
  /** Quarter-hours the quarter-hourly RSI and ATR read: two days. */
  quarterly: 192,
  /** Hours the beta to Bitcoin reads: a week. */
  beta: 168
} as const
const DAY_BARS = 288
const HOUR_BARS = 12
/** What wilderAdx(…, 14) reads: 2 x 14 + 1 bars, and one before the first for its first move. */
const ADX_BARS = 2 * 14 + 2
/** Of the two days of quarter-hours the quarter-hourly readings take, the share that must be there. */
const MIN_QUARTER_SHARE = 0.75

/** The history a row needs: the hours of the longest window and a week, and two days of minutes. */
export const NEED = { m5: 2 * DAY_BARS + 1, h1: WINDOW.hourly + 1 } as const

export const PAIR_CLASSES = ['btc', 'eth', 'large', 'mid', 'high-vol', 'other'] as const
export type PairClass = (typeof PAIR_CLASSES)[number]
export const MARKET_REGIMES: readonly MarketRegime[] = ['panic', 'high-vol', 'recovery', 'bull', 'bear', 'sideways']

/** The row's figures, in order: the PRICE set first, which is the first PRICE_FEATURES of them. */
export const FEATURE_NAMES = [
  // PRICE: moves, and how far it usually goes.
  'r_5m',
  'r_15m',
  'r_30m',
  'r_1h',
  'r_4h',
  'r_24h',
  'r_7d',
  'rv_1h',
  'rv_4h',
  'rv_24h',
  'rv_ratio',
  'z_15m',
  'z_1h',
  'z_4h',
  'z_24h',
  // TECH: the trend and the range.
  'acc_15m',
  'slope_1h',
  'slope_4h',
  'pos_24h',
  'pos_7d',
  'from_high_24h',
  'from_low_24h',
  'atr_15m',
  'atr_1h',
  'range_exp',
  // Volume, and who pressed it.
  'vol_ratio_1h',
  'vol_acc_15m',
  'taker_1h',
  'taker_4h',
  // The indicators the strategies and the chart compute.
  'ema20_1h',
  'ema50_1h',
  'ema200_1h',
  'rsi_15m',
  'rsi_1h',
  'bb_pos_1h',
  'bb_width_1h',
  'adx_1h',
  // Bitcoin, ether and the market (§16).
  'btc_r_1h',
  'btc_r_4h',
  'btc_r_24h',
  'eth_r_1h',
  'eth_r_4h',
  'breadth_1h',
  'breadth_24h',
  'alt_strength',
  'beta_btc',
  'idio_1h',
  // The market's regime (§17), the pair's class (§100), and the clock.
  ...MARKET_REGIMES.map((regime) => `regime_${regime}`),
  ...PAIR_CLASSES.map((cls) => `class_${cls}`),
  'hour_sin',
  'hour_cos',
  'dow_sin',
  'dow_cos'
] as const
export type FeatureName = (typeof FEATURE_NAMES)[number]
export const FEATURE_COUNT = FEATURE_NAMES.length
/** The PRICE set (§49's "price only"): the first this many figures. */
export const PRICE_FEATURES = FEATURE_NAMES.indexOf('acc_15m')

/** A pair's bars as the forecast holds them: five-minute bars, and hours built from them. */
export interface PairSeries {
  m5: readonly ForecastBar[]
  h1: readonly CoarseBar[]
}

/** The market at T, across the universe (§16): read from every pair's row inputs at T. */
export interface CrossSection {
  btc: { r1h: number; r4h: number; r24h: number }
  eth: { r1h: number; r4h: number }
  /** Shares of the pairs that rose over the hour and over the day. */
  breadth1h: number
  breadth24h: number
  /** The other pairs' median day, less Bitcoin's. */
  altStrength: number
  regime: MarketRegime
  /** Each pair's class at T. */
  classes: ReadonlyMap<string, PairClass>
}

const ln = Math.log

/** The index just past the last bar that had closed by `tSec` (bars oldest first). */
function closedEnd(bars: readonly { time: number }[], width: number, tSec: number): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (bars[middle].time + width <= tSec) low = middle + 1
    else high = middle
  }
  return low
}

/** The index of the first bar opening at or after `time`, bars oldest first. */
function firstFrom(bars: readonly { time: number }[], time: number): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (bars[middle].time < time) low = middle + 1
    else high = middle
  }
  return low
}

/** How many bars of either series had closed by T: every figure is read from bars before these
 * ends, and nothing at or after them (property 1). Indices, not copies: a row is read at every
 * moment of ninety days in training. */
export function endsAt(series: PairSeries, tSec: number): { m5: number; h1: number } {
  return { m5: closedEnd(series.m5, FORECAST_BAR_SECONDS, tSec), h1: closedEnd(series.h1, COARSE_SECONDS['1h'], tSec) }
}

/** The quick reads every pair needs for the cross-section: its moves, its day's volume and its day's
 * realized volatility at T. Null without the history. */
export interface PairQuick {
  close: number
  r1h: number
  r4h: number
  r24h: number
  quoteVolume24h: number
  rv24h: number
}

export function quickAt(series: PairSeries, tSec: number): PairQuick | null {
  const m5 = series.m5
  const n = endsAt(series, tSec).m5
  // The bar that closed at T, and the day before it whole; and not a pegged coin.
  if (n < DAY_BARS + 1 || m5[n - 1].time + FORECAST_BAR_SECONDS !== tSec) return null
  if (m5[n - 1 - DAY_BARS].time !== m5[n - 1].time - DAY_BARS * FORECAST_BAR_SECONDS) return null
  if (isPegged(series, tSec)) return null
  const close = m5[n - 1].close
  let quoteVolume24h = 0
  let squares = 0
  for (let index = n - DAY_BARS; index < n; index++) {
    quoteVolume24h += m5[index].quoteVolume
    const move = ln(m5[index].close / m5[index - 1].close)
    squares += move * move
  }
  return {
    close,
    r1h: ln(close / m5[n - 1 - HOUR_BARS].close),
    r4h: ln(close / m5[n - 1 - 4 * HOUR_BARS].close),
    r24h: ln(close / m5[n - 1 - DAY_BARS].close),
    quoteVolume24h,
    rv24h: Math.sqrt(squares)
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** A pair whose last week's hours stayed within this share of their low is pegged to something -- a
 * stablecoin the scanner's list does not know yet -- and has no row, and no part in the market at T:
 * its moves are its peg's. Drawn before any result was looked at. */
export const PEG_RANGE = 0.01
const WEEK_HOURS = 168

/** Whether a pair's week, by its whole hours before T, stayed within PEG_RANGE. */
export function isPegged(series: PairSeries, tSec: number): boolean {
  const end = endsAt(series, tSec).h1
  if (end < WEEK_HOURS) return false
  let high = -Infinity
  let low = Infinity
  for (let index = end - WEEK_HOURS; index < end; index++) {
    high = Math.max(high, series.h1[index].high)
    low = Math.min(low, series.h1[index].low)
  }
  return low > 0 && high / low - 1 < PEG_RANGE
}

/** The lines a pair's class is drawn at (§100): the ten most traded after Bitcoin and ether are large,
 * the next twenty mid, the rest other; and a pair in the top fifth by its day's realized volatility
 * is high-vol, whatever its size. Written before any result was looked at. */
export const CLASS_LINES = { large: 10, mid: 30, highVolShare: 0.2 } as const

/** Each pair's class at T, from the quick reads of the universe. */
export function pairClasses(quick: ReadonlyMap<string, PairQuick>): Map<string, PairClass> {
  const out = new Map<string, PairClass>()
  const others = [...quick.entries()].filter(([symbol]) => symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT')
  const byVolume = [...others].sort((a, b) => b[1].quoteVolume24h - a[1].quoteVolume24h || a[0].localeCompare(b[0]))
  const byVol = [...others].sort((a, b) => b[1].rv24h - a[1].rv24h || a[0].localeCompare(b[0]))
  const volatile = new Set(byVol.slice(0, Math.floor(others.length * CLASS_LINES.highVolShare)).map(([symbol]) => symbol))
  byVolume.forEach(([symbol], rank) => {
    out.set(symbol, volatile.has(symbol) ? 'high-vol' : rank < CLASS_LINES.large ? 'large' : rank < CLASS_LINES.mid ? 'mid' : 'other')
  })
  if (quick.has('BTCUSDT')) out.set('BTCUSDT', 'btc')
  if (quick.has('ETHUSDT')) out.set('ETHUSDT', 'eth')
  return out
}

/** The market at T from every pair's quick reads. Null without Bitcoin's and ether's. */
export function crossSectionAt(quick: ReadonlyMap<string, PairQuick>): CrossSection | null {
  const btc = quick.get('BTCUSDT')
  const eth = quick.get('ETHUSDT')
  if (btc === undefined || eth === undefined) return null
  const all = [...quick.values()]
  const alts = [...quick.entries()].filter(([symbol]) => symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT').map(([, read]) => read.r24h)
  const pct = (value: number): number => (Math.exp(value) - 1) * 100
  const regime = marketRegimeOf({ h1: pct(btc.r1h), h4: pct(btc.r4h), h24: pct(btc.r24h) }) ?? 'sideways'
  return {
    btc: { r1h: btc.r1h, r4h: btc.r4h, r24h: btc.r24h },
    eth: { r1h: eth.r1h, r4h: eth.r4h },
    breadth1h: all.filter((read) => read.r1h > 0).length / all.length,
    breadth24h: all.filter((read) => read.r24h > 0).length / all.length,
    altStrength: alts.length === 0 ? 0 : median(alts) - btc.r24h,
    regime,
    classes: pairClasses(quick)
  }
}

/** A least-squares slope of log closes against the bar index, in log return a bar. */
function logSlope(closes: readonly number[]): number {
  const n = closes.length
  const meanX = (n - 1) / 2
  let meanY = 0
  for (const close of closes) meanY += ln(close)
  meanY /= n
  let covariance = 0
  let variance = 0
  for (let index = 0; index < n; index++) {
    const dx = index - meanX
    covariance += dx * (ln(closes[index]) - meanY)
    variance += dx * dx
  }
  return variance > 0 ? covariance / variance : 0
}

const asCandle = (bar: ForecastBar): Candle => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })

/** The row at T for a pair, or null when its history is too short, its last bar is not the one that
 * closed at T, or a figure cannot be read. `btcH1` is Bitcoin's hours, for the beta. */
export function featuresAt(input: { symbol: string; series: PairSeries; btcH1: readonly CoarseBar[]; cross: CrossSection; tSec: number }): Float64Array | null {
  const { m5, h1 } = input.series
  const ends = endsAt(input.series, input.tSec)
  const n = ends.m5
  const nh = ends.h1
  if (n < NEED.m5 || nh < NEED.h1) return null
  // The bar that closed at T there, and the day before it whole: the pair's own quick read's rules
  // (quickAt), in that one place. Every move below is read a fixed number of bars back, and a gap in
  // the day would stretch it; a gap further back is borne, as the windows that reach it are averages.
  if (quickAt(input.series, input.tSec) === null) return null
  const cls = input.cross.classes.get(input.symbol)
  if (cls === undefined) return null
  const close = m5[n - 1].close
  const back = (bars: number): number => ln(close / m5[n - 1 - bars].close)
  const realized = (bars: number): number => {
    let squares = 0
    for (let index = n - bars; index < n; index++) {
      const move = ln(m5[index].close / m5[index - 1].close)
      squares += move * move
    }
    return Math.sqrt(squares)
  }
  const rv1h = realized(HOUR_BARS)
  const rv4h = realized(4 * HOUR_BARS)
  // A day without a move is a day the row cannot measure moves against: the row is not finite, and none.
  const rv24h = realized(DAY_BARS)
  // A horizon's usual move, from the day's: what each move is measured against (as targets.ts does).
  const usual = (bars: number): number => usualMove(rv24h, bars)
  const r15 = back(3)
  const r15Before = ln(m5[n - 4].close / m5[n - 7].close)

  // The day's and the week's range.
  let high24 = -Infinity
  let low24 = Infinity
  for (let index = n - DAY_BARS; index < n; index++) {
    high24 = Math.max(high24, m5[index].high)
    low24 = Math.min(low24, m5[index].low)
  }
  // The week: the 168 hours that ended with the last whole hour, by time, gaps and all.
  const lastHour = h1[nh - 1].time
  const weekFrom = firstFrom(h1, lastHour - 167 * 3600)
  let high7 = -Infinity
  let low7 = Infinity
  for (let index = weekFrom; index < nh; index++) {
    high7 = Math.max(high7, h1[index].high)
    low7 = Math.min(low7, h1[index].low)
  }
  // The close a week before the last whole hour: that hour's, or the last before it where it is missing.
  const weekAgo = firstFrom(h1, lastHour - 168 * 3600 + 1) - 1
  if (weekAgo < 0) return null
  // The last hour's range against the day's mean hourly range.
  let hourHigh = -Infinity
  let hourLow = Infinity
  for (let index = n - HOUR_BARS; index < n; index++) {
    hourHigh = Math.max(hourHigh, m5[index].high)
    hourLow = Math.min(hourLow, m5[index].low)
  }
  let rangeSum = 0
  for (let index = nh - 24; index < nh; index++) rangeSum += h1[index].high - h1[index].low
  const meanHourRange = rangeSum / 24

  // Volume and the taker's share.
  const sum = (from: number, to: number, pick: (bar: ForecastBar) => number): number => {
    let total = 0
    for (let index = from; index < to; index++) total += pick(m5[index])
    return total
  }
  const volumeHour = sum(n - HOUR_BARS, n, (bar) => bar.volume)
  const volumeDay = sum(n - DAY_BARS, n, (bar) => bar.volume)
  const volume15 = sum(n - 3, n, (bar) => bar.volume)
  const volume15Before = sum(n - 6, n - 3, (bar) => bar.volume)
  const takerShare = (bars: number): number => {
    const volume = sum(n - bars, n, (bar) => bar.volume)
    return volume > 0 ? sum(n - bars, n, (bar) => bar.takerBuyVolume) / volume - 0.5 : 0
  }

  // The indicators, each over its fixed span.
  const hours = h1.slice(nh - WINDOW.hourly, nh)
  const hourCloses = hours.map((bar) => bar.close)
  const emaGap = (period: number): number => ln(close / computeEma(hourCloses, period)[hourCloses.length - 1]) / usual(DAY_BARS)
  // The quarter-hours of the two days before T, by time: a gap in them is fewer quarters, not older ones.
  const quarters = coarseBars(m5.slice(firstFrom(m5, input.tSec - WINDOW.quarterly * 900), n), '15m', input.tSec)
  // Three quarters of the two days there, for the quarter-hourly RSI and ATR.
  if (quarters.length < WINDOW.quarterly * MIN_QUARTER_SHARE) return null
  const quarterCloses = quarters.map((bar) => bar.close)
  const rsiLast = (values: number[]): number => {
    const out = RSI.calculate({ period: 14, values })
    return out.length === 0 ? NaN : out[out.length - 1]
  }
  const atrPct = (bars: Candle[]): number => {
    const atr = computeAtr(bars, 14)
    return (atr[atr.length - 1] / bars[bars.length - 1].close) * 100
  }
  const band = BollingerBands.calculate({ period: 20, stdDev: 2, values: hourCloses.slice(-20) })
  const lastBand = band[band.length - 1]
  if (lastBand === undefined || !(lastBand.upper > lastBand.lower)) return null

  // The beta to Bitcoin over the week, on hourly moves; Bitcoin's own is one.
  let beta = 1
  if (input.symbol !== 'BTCUSDT') {
    const btcEnd = closedEnd(input.btcH1, COARSE_SECONDS['1h'], input.tSec)
    if (btcEnd < WINDOW.beta + 1) return null
    const btcByTime = new Map<number, number>()
    for (let index = btcEnd - WINDOW.beta - 1; index < btcEnd; index++) btcByTime.set(input.btcH1[index].time, input.btcH1[index].close)
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    let count = 0
    for (let index = nh - WINDOW.beta; index < nh; index++) {
      const now = btcByTime.get(h1[index].time)
      const before = btcByTime.get(h1[index - 1].time)
      if (now === undefined || before === undefined) continue
      const x = ln(now / before)
      const y = ln(h1[index].close / h1[index - 1].close)
      sx += x
      sy += y
      sxx += x * x
      sxy += x * y
      count++
    }
    const variance = count > 1 ? sxx / count - (sx / count) ** 2 : 0
    beta = variance > 0 ? (sxy / count - (sx / count) * (sy / count)) / variance : 1
  }

  const date = new Date(input.tSec * 1000)
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  const weekday = date.getUTCDay()
  const r1h = back(HOUR_BARS)
  const values: number[] = [
    back(1),
    r15,
    back(6),
    r1h,
    back(4 * HOUR_BARS),
    back(DAY_BARS),
    ln(close / h1[weekAgo].close),
    rv1h,
    rv4h,
    rv24h,
    rv1h / usual(HOUR_BARS),
    r15 / usual(3),
    r1h / usual(HOUR_BARS),
    back(4 * HOUR_BARS) / usual(4 * HOUR_BARS),
    back(DAY_BARS) / usual(DAY_BARS),
    (r15 - r15Before) / usual(3),
    (logSlope(m5.slice(n - HOUR_BARS, n).map((bar) => bar.close)) * HOUR_BARS) / usual(HOUR_BARS),
    (logSlope(m5.slice(n - 4 * HOUR_BARS, n).map((bar) => bar.close)) * 4 * HOUR_BARS) / usual(4 * HOUR_BARS),
    high24 > low24 ? (close - low24) / (high24 - low24) : 0.5,
    high7 > low7 ? (close - low7) / (high7 - low7) : 0.5,
    ln(close / high24) / usual(DAY_BARS),
    ln(close / low24) / usual(DAY_BARS),
    atrPct(quarters),
    atrPct(hours.slice(-WINDOW.beta)),
    meanHourRange > 0 ? (hourHigh - hourLow) / meanHourRange : 1,
    volumeDay > 0 ? volumeHour / (volumeDay / 24) : 1,
    volume15Before > 0 && volume15 > 0 ? ln(volume15 / volume15Before) : 0,
    takerShare(HOUR_BARS),
    takerShare(4 * HOUR_BARS),
    emaGap(20),
    emaGap(50),
    emaGap(200),
    rsiLast(quarterCloses),
    rsiLast(hourCloses.slice(-WINDOW.beta)),
    (close - lastBand.lower) / (lastBand.upper - lastBand.lower),
    (lastBand.upper - lastBand.lower) / lastBand.middle,
    // wilderAdx reads the last 2 x 14 + 1 bars and nothing before them: those are what it is handed.
    wilderAdx(hours.slice(-ADX_BARS).map(asCandle), 14),
    input.cross.btc.r1h,
    input.cross.btc.r4h,
    input.cross.btc.r24h,
    input.cross.eth.r1h,
    input.cross.eth.r4h,
    input.cross.breadth1h,
    input.cross.breadth24h,
    input.cross.altStrength,
    beta,
    r1h - beta * input.cross.btc.r1h,
    ...MARKET_REGIMES.map((regime) => (input.cross.regime === regime ? 1 : 0)),
    ...PAIR_CLASSES.map((one) => (cls === one ? 1 : 0)),
    Math.sin((2 * Math.PI * hour) / 24),
    Math.cos((2 * Math.PI * hour) / 24),
    Math.sin((2 * Math.PI * weekday) / 7),
    Math.cos((2 * Math.PI * weekday) / 7)
  ]
  if (values.length !== FEATURE_COUNT || !values.every(Number.isFinite)) return null
  return Float64Array.from(values)
}
