import { HORIZONS, type Horizon } from './features'
import type { PricePrediction } from './prediction'

// THE FORECAST AS THE PRICE MOVES (the V6 document, §38-41; V6 Stage 7, 13 October 2026). A forecast
// is read from a close; between closes the price goes on moving, and the forecast is not shown as if
// it had not (§41: "15:00 SOL = $180, +2% ~ +5%; at 15:07 SOL = $184 -- do not go on showing $180 and
// +2% ~ +5%").
//
// So the forecast's PRICE LEVELS stay where they are -- what it said the price would be at each
// horizon's close -- and its percentages are re-expressed from the live price: at $184 the same
// forecast reads -0.2% ~ +2.7%. A horizon whose close has passed has EXPIRED (§38) and is shown as
// such until the next forecast replaces it; one whose 80% range the live price has already left is
// INVALIDATED (§39), and the engine forecasts the pair again.

export interface HorizonView {
  horizon: Horizon
  /** From the live price, in percent: the likely range, the median, the bear and bull cases. */
  lowPct: number
  highPct: number
  medianPct: number
  bearPct: number
  bullPct: number
  /** Milliseconds before its close is reached; 0 once it has. */
  timeLeftMs: number
  expired: boolean
  /** The live price outside P10-P90's prices. */
  invalidated: boolean
}

export interface PredictionView {
  pair: string
  /** The price the percentages are from: the live one, or the close the forecast was read at where
   * there is no live price. */
  price: number
  priceFrom: 'live' | 'close'
  /** How far the price has moved since that close, in percent. */
  movedPct: number
  /** Milliseconds since the forecast was made. */
  ageMs: number
  horizons: Partial<Record<Horizon, HorizonView>>
  /** Every horizon expired: the forecast is shown as FORECAST EXPIRED. */
  expired: boolean
}

const fromPrice = (level: number, price: number): number => (level / price - 1) * 100

export function forecastView(prediction: PricePrediction, livePrice: number | null, nowMs: number): PredictionView {
  const live = livePrice !== null && Number.isFinite(livePrice) && livePrice > 0
  const price = live ? livePrice : prediction.currentPrice
  const horizons: Partial<Record<Horizon, HorizonView>> = {}
  for (const horizon of HORIZONS) {
    const range = prediction.horizons[horizon]
    if (range === undefined) continue
    const [p10, p25, p50, p75, p90] = range.quantilePrices
    const timeLeftMs = Math.max(0, range.expiresAt - nowMs)
    horizons[horizon] = {
      horizon,
      lowPct: fromPrice(p25, price),
      highPct: fromPrice(p75, price),
      medianPct: fromPrice(p50, price),
      bearPct: fromPrice(p10, price),
      bullPct: fromPrice(p90, price),
      timeLeftMs,
      expired: timeLeftMs === 0,
      invalidated: live && (price < p10 || price > p90)
    }
  }
  const views = Object.values(horizons)
  return {
    pair: prediction.pair,
    price,
    priceFrom: live ? 'live' : 'close',
    movedPct: fromPrice(price, prediction.currentPrice),
    ageMs: Math.max(0, nowMs - prediction.generatedAt),
    horizons,
    expired: views.length > 0 && views.every((view) => view.expired)
  }
}
