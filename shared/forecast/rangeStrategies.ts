import { FEE_RATE, SLIPPAGE_RATE } from '../fees'
import { stopFillPrice } from '../fills'
import { FORECAST_BAR_SECONDS, type ForecastBar } from './bars'
import { ROUND_TRIP_PCT } from './edge'
import { HORIZON_BARS, type Horizon } from './features'
import { EXCURSION_LEVELS } from './models'
import type { PricePrediction } from './prediction'

// TWO PAPER STRATEGIES THAT NEED NO WAY (V7.2-R Stage 5, 22 October 2026). The forecast's ranges held (80% of moves
// inside the 80% range at every horizon) and its way did not (no direction source has beaten the base rate), so these
// two trade the range alone, long only, as spot can:
// - BAND_REVERSION: at each quarter-hour forecast, a resting bid at the horizon's P10 price -- the close a horizon on
//   falls under one time in ten -- sold at the median if the price comes back to it, stopped at the path's likely low
//   at its nine-in-ten level (the excursion stop), and sold at the horizon's end otherwise; one at a time a pair and a
//   horizon, at an hour, four hours and a day;
// - RANGE_GRID: at a day's forecast, bids between the day's P10 and P90 prices, a step apart, each sold a step up and
//   bid again when sold; the step at least twice the flat round trip; whatever is held at the day's end sold then;
//   one grid at a time a pair.
// Both are measured on the replay out of sample (shared/forecast/replay.ts) from five-minute bars, and offered on
// paper only where their registered line held (V72R-S5-BAND, V72R-S5-GRID): the mean net a trade after costs above
// zero beyond noise.
//
// HOW AN ORDER FILLS ON A BAR, written here before any trade was replayed, each choice the one that flatters less:
// - a resting order fills only where a later bar trades THROUGH its price by RANGE_LINES.throughPct, and at its own
//   price, never better: a resting bid on a continuous book is taken at its price, and a place at the back of the
//   queue fills only once the price trades past it;
// - a stop is a market order once touched: filled at the stop, or at the bar's open where the bar opened past it
//   (shared/fills.ts, as the paper engine's), with the slippage of a market fill;
// - within one bar the order of the high and the low is not known: a bar that reaches both the stop and the target
//   is a stop; a position is not sold at its target in the bar it was bought in; a grid's rung sold in a bar is not
//   bought again in it;
// - a resting order pays the maker fee, a market fill the taker fee and the slippage (shared/fees.ts).
//
// IT IS PAPER. Nothing here reaches an order.

export const RANGE_STRATEGIES_VERSION = 'range-strategies-v1'

export const RANGE_STRATEGIES = ['band', 'grid'] as const
export type RangeStrategy = (typeof RANGE_STRATEGIES)[number]

export const RANGE_LINES = {
  band: {
    /** The horizons a band is bid at, each its own cell, measured apart. */
    horizons: ['hour1', 'hours4', 'hours24'] as readonly Horizon[],
    /** The excursion level the stop is read at: the low the path's lowest stays above nine times in ten. */
    stopLevel: 0.9
  },
  grid: {
    /** The horizon whose range the grid spans, and its life. */
    horizon: 'hours24' as Horizon,
    /** The least step, in flat round trips (shared/forecast/edge.ts ROUND_TRIP_PCT). */
    minStepRoundTrips: 2,
    /** The fewest and the most steps a grid holds: a range too narrow for two steps is no grid, and one wider than the
     * most takes wider steps. */
    minSteps: 2,
    maxSteps: 40
  },
  /** How far past its price a later bar must trade for a resting order to count as filled, in percent. */
  throughPct: 0.02,
  /** A fill's fee and a market fill's slippage, in percent of its value (shared/fees.ts). */
  makerFeePct: FEE_RATE * 100,
  takerFeePct: FEE_RATE * 100,
  slippagePct: SLIPPAGE_RATE * 100
} as const

/** A band's bid: placed at the forecast's close, resting until its horizon ends. */
export interface BandOrder {
  pair: string
  predictionId: string
  /** The forecast's close, Unix seconds, and its horizon. */
  t: number
  horizon: Horizon
  /** The close's price; the bid (P10), the target (the median) and the stop (the excursion's likely low), as prices. */
  price: number
  entry: number
  target: number
  stop: number
  /** When the bid is taken down, and a filled trade sold at the latest. */
  until: number
}

/** A grid: its range's two ends, its steps and their size, its life. */
export interface GridOrder {
  pair: string
  predictionId: string
  t: number
  horizon: Horizon
  price: number
  lower: number
  upper: number
  steps: number
  /** One step, in percent: the rungs are lower x (1 + step)^i. */
  stepPct: number
  until: number
}

export type RangeExit = 'target' | 'stop' | 'time' | 'unfilled'

/** How a band ended. */
export interface BandResult {
  exit: RangeExit
  /** The fill bar's open and the price taken; null where the bid was never reached. */
  filledAt: number | null
  fillPrice: number | null
  /** The exit bar's open and the price, after slippage on a market fill; null where unfilled. */
  exitAt: number | null
  exitPrice: number | null
  /** In percent of the stake: the move from fill to exit, what the fills cost, and the two together. Zero where unfilled. */
  grossPct: number
  costPct: number
  netPct: number
  /** When the order ended: its exit bar's close, or its horizon's end. */
  endedAt: number
}

/** How a grid ended: the rungs sold a step up, those held at its end, and the stake's net. */
export interface GridResult {
  /** Rungs bought and sold a step up; rungs still held at the end, sold then; the most held at once. */
  cycles: number
  heldAtEnd: number
  maxHeld: number
  /** In percent of the whole stake, every rung's share of it held whether bid, bought or idle. */
  grossPct: number
  costPct: number
  netPct: number
  endedAt: number
}

/** The first bar opening at or after `time`, by binary search; bars.length where none. */
export function barIndexFrom(bars: readonly ForecastBar[], time: number): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (bars[middle].time < time) low = middle + 1
    else high = middle
  }
  return low
}

/** The bars inside an order's life: opening at or after its close and closing by its end. Null where the bars on file
 * stop before its end, so that an order the data cannot settle is not counted either way. */
function lifeOf(bars: readonly ForecastBar[], t: number, until: number): { from: number; to: number } | null {
  const from = barIndexFrom(bars, t)
  const to = barIndexFrom(bars, until)
  // The last bar of the life opens a bar before its end; without it on file the end is not known.
  const last = to - 1
  if (last < from || bars[last].time + FORECAST_BAR_SECONDS !== until) return null
  return { from, to }
}

const through = (price: number, below: boolean): number => price * (below ? 1 - RANGE_LINES.throughPct / 100 : 1 + RANGE_LINES.throughPct / 100)

/** A band's bid from a forecast at a horizon: null where the horizon is not forecast, the bid would not be under the
 * price, the median would not clear a round trip from it, or the excursion's likely low cannot be read under it. */
export function bandOrderOf(prediction: PricePrediction, horizon: Horizon): BandOrder | null {
  const range = prediction.horizons[horizon]
  if (range === undefined) return null
  const price = prediction.currentPrice
  const entry = range.quantilePrices[0]
  const target = range.quantilePrices[2]
  const lowPct = range.excursion?.lowPct[EXCURSION_LEVELS.indexOf(RANGE_LINES.band.stopLevel as (typeof EXCURSION_LEVELS)[number])]
  if (!(price > 0) || !(entry > 0) || !(entry < price) || !(target > entry) || lowPct === undefined || !Number.isFinite(lowPct)) return null
  const stop = price * (1 + lowPct / 100)
  if (!(stop > 0) || !(stop < entry)) return null
  if (!((target / entry - 1) * 100 > ROUND_TRIP_PCT)) return null
  return { pair: prediction.pair, predictionId: prediction.id, t: prediction.barTime, horizon, price, entry, target, stop, until: prediction.barTime + HORIZON_BARS[horizon] * FORECAST_BAR_SECONDS }
}

/** A grid from a day's forecast: null where the day is not forecast, the price is not inside its 80% range, or the
 * range is too narrow for the fewest steps at the least step. */
export function gridOrderOf(prediction: PricePrediction): GridOrder | null {
  const horizon = RANGE_LINES.grid.horizon
  const range = prediction.horizons[horizon]
  if (range === undefined) return null
  const price = prediction.currentPrice
  const lower = range.quantilePrices[0]
  const upper = range.quantilePrices[4]
  if (!(lower > 0) || !(upper > lower) || !(lower < price && price < upper)) return null
  const least = (RANGE_LINES.grid.minStepRoundTrips * ROUND_TRIP_PCT) / 100
  const fit = Math.floor(Math.log(upper / lower) / Math.log(1 + least) + 1e-9)
  const steps = Math.min(RANGE_LINES.grid.maxSteps, fit)
  if (steps < RANGE_LINES.grid.minSteps) return null
  const stepPct = ((upper / lower) ** (1 / steps) - 1) * 100
  return { pair: prediction.pair, predictionId: prediction.id, t: prediction.barTime, horizon, price, lower, upper, steps, stepPct, until: prediction.barTime + HORIZON_BARS[horizon] * FORECAST_BAR_SECONDS }
}

/** What a quote's worth bought at `buy` and sold at `sell` nets, in percent: each leg's fee on its own value. */
function netOfLegs(buy: number, sell: number, buyFeePct: number, sellFeePct: number): number {
  const value = sell / buy
  return (value * (1 - sellFeePct / 100) - 1 - buyFeePct / 100) * 100
}

/** A market sell's price after its slippage. */
const marketSell = (price: number): number => price * (1 - RANGE_LINES.slippagePct / 100)

/** A band's bid played on the bars: null where the bars on file stop before its horizon ends. */
export function resolveBand(order: BandOrder, bars: readonly ForecastBar[]): BandResult | null {
  const life = lifeOf(bars, order.t, order.until)
  if (life === null) return null
  let at = life.from
  for (; at < life.to; at++) if (bars[at].low <= through(order.entry, true)) break
  if (at >= life.to) return { exit: 'unfilled', filledAt: null, fillPrice: null, exitAt: null, exitPrice: null, grossPct: 0, costPct: 0, netPct: 0, endedAt: order.until }
  const fill = order.entry
  const filledAt = bars[at].time
  const ended = (exit: RangeExit, bar: ForecastBar, price: number, maker: boolean): BandResult => {
    // The move is the price's; the costs are the fees and, on a market fill, the slippage.
    const exitPrice = maker ? price : marketSell(price)
    const grossPct = (price / fill - 1) * 100
    const netPct = netOfLegs(fill, exitPrice, RANGE_LINES.makerFeePct, maker ? RANGE_LINES.makerFeePct : RANGE_LINES.takerFeePct)
    return { exit, filledAt, fillPrice: fill, exitAt: bar.time, exitPrice, grossPct, costPct: grossPct - netPct, netPct, endedAt: bar.time + FORECAST_BAR_SECONDS }
  }
  // The fill bar: the price came down through the bid, and may have gone on down through the stop; it is not sold at
  // its target in the same bar.
  if (bars[at].low <= order.stop) return ended('stop', bars[at], stopFillPrice(bars[at].open, order.stop, true), false)
  for (let next = at + 1; next < life.to; next++) {
    const bar = bars[next]
    if (bar.low <= order.stop) return ended('stop', bar, stopFillPrice(bar.open, order.stop, true), false)
    if (bar.high >= through(order.target, false)) return ended('target', bar, order.target, true)
  }
  const last = bars[life.to - 1]
  return ended('time', last, last.close, false)
}

/** A grid played on the bars: null where the bars on file stop before its day ends. Each rung holds an equal share of
 * the stake; a rung is bid once a bar has opened at or above it (a buy grid bids under the market, never over it),
 * bought where a later bar trades through it, sold a step up where a later bar trades through that, and bid again. */
export function resolveGrid(order: GridOrder, bars: readonly ForecastBar[]): GridResult | null {
  const life = lifeOf(bars, order.t, order.until)
  if (life === null) return null
  const step = 1 + order.stepPct / 100
  const rungs = Array.from({ length: order.steps }, (_, i) => order.lower * step ** i)
  const share = 1 / order.steps
  const armed = rungs.map(() => false)
  const held = rungs.map(() => false)
  let net = 0
  let gross = 0
  let cycles = 0
  let maxHeld = 0
  for (let at = life.from; at < life.to; at++) {
    const bar = bars[at]
    // Sold a step up: rungs bought in an earlier bar, whose step up this bar traded through.
    const soldNow = rungs.map(() => false)
    for (let i = 0; i < rungs.length; i++) {
      const up = rungs[i] * step
      if (!held[i] || bar.high < through(up, false)) continue
      held[i] = false
      soldNow[i] = true
      cycles++
      gross += share * (up / rungs[i] - 1) * 100
      net += share * netOfLegs(rungs[i], up, RANGE_LINES.makerFeePct, RANGE_LINES.makerFeePct)
    }
    for (let i = 0; i < rungs.length; i++) if (!armed[i] && bar.open >= rungs[i]) armed[i] = true
    for (let i = 0; i < rungs.length; i++) {
      if (!armed[i] || held[i] || soldNow[i] || bar.low > through(rungs[i], true)) continue
      held[i] = true
    }
    maxHeld = Math.max(maxHeld, held.filter(Boolean).length)
  }
  // The day's end: every rung still held sold at the last bar's close, at market.
  const close = bars[life.to - 1].close
  let heldAtEnd = 0
  for (let i = 0; i < rungs.length; i++) {
    if (!held[i]) continue
    heldAtEnd++
    gross += share * (close / rungs[i] - 1) * 100
    net += share * netOfLegs(rungs[i], marketSell(close), RANGE_LINES.makerFeePct, RANGE_LINES.takerFeePct)
  }
  return { cycles, heldAtEnd, maxHeld, grossPct: gross, costPct: gross - net, netPct: net, endedAt: order.until }
}
