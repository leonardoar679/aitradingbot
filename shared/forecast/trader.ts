import type { Horizon } from './features'

// THE FORECAST TRADER'S SETTINGS AND WHAT ITS TRADES CARRY (the V6 document, §66-68 and §106-108; V6
// Stage 12, 13 October 2026). START AI TRADING: on a TRADE decision whose opportunity class has earned
// it (shared/forecast/opportunityClass.ts), the forecast trader opens a PAPER Position by itself, sized
// and capped as every paper trade the app opens by itself is (shared/paperRisk.ts, paperExposure.ts,
// paperPause.ts), and at most so many at once and so many on one side, which the risk mode sets. OFF
// until a person switches it on. It is paper: the one file that writes its trades
// (src/forecast/forecastTrader.ts) spells paper as a literal and reaches no bridge to a real order.

export const FORECAST_TRADER_STAKES = [25, 50, 100, 250, 500] as const
export const FORECAST_TRADER_OPEN = [2, 4, 6] as const
export const FORECAST_TRADER_SAME_SIDE = [1, 2, 3] as const

export interface ForecastTraderSettings {
  /** Opens paper trades by itself: false until a person switches it on. */
  enabled: boolean
  /** The most a trade stakes, before sizing by risk; in the pair's quote asset. */
  stakeQuote: number
  /** Its open paper trades at once, and on one side. */
  maxOpen: number
  maxSameSide: number
}

export const DEFAULT_FORECAST_TRADER: ForecastTraderSettings = { enabled: false, stakeQuote: 100, maxOpen: 2, maxSameSide: 1 }

const isChoice = (choices: readonly number[], value: unknown): value is number => typeof value === 'number' && choices.includes(value)

/** A stored setting, read as one: anything that is not one of its choices takes its default, and only
 * a stored `true` switches it on. */
export function healForecastTrader(value: unknown): ForecastTraderSettings {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Partial<Record<keyof ForecastTraderSettings, unknown>>
  return {
    enabled: raw.enabled === true,
    stakeQuote: isChoice(FORECAST_TRADER_STAKES, raw.stakeQuote) ? raw.stakeQuote : DEFAULT_FORECAST_TRADER.stakeQuote,
    maxOpen: isChoice(FORECAST_TRADER_OPEN, raw.maxOpen) ? raw.maxOpen : DEFAULT_FORECAST_TRADER.maxOpen,
    maxSameSide: isChoice(FORECAST_TRADER_SAME_SIDE, raw.maxSameSide) ? raw.maxSameSide : DEFAULT_FORECAST_TRADER.maxSameSide
  }
}

/** What a paper trade of the forecast trader carries: the forecast and the decision it was opened on,
 * the plan it followed, the live book it was opened against, and, once stopped, how it ended. A
 * record: nothing reads it in order to act, but its own settling and the class's live record. */
export interface ForecastTradeMark {
  predictionId: string
  /** Unix seconds: the close the forecast was read at; when the trade was opened. */
  barTime: number
  openedAt: number
  horizon: Horizon
  side: 'BUY' | 'SELL'
  /** Its opportunity class (shared/forecast/opportunityClass.ts) and how the class stood. */
  classKey: string
  verdict: string
  /** The forecast's five levels as moves from the close, its P(up), and the decision's edge. */
  quantilesPct: number[]
  pUp: number
  edgePct: number
  pProfit: number
  /** The plan (shared/forecast/tradePlan.ts): the entry zone, the stop and target from the entry, the
   * level the target was set at, and how long it is held. */
  plan: { entryMin: number; entryMax: number; stopPct: number; targetPct: number; targetLevel: string; holdSec: number; validUntil: number }
  book?: { bid: number; ask: number; spreadPct: number }
  btcCorrelation?: number | null
  result?: { exit: string; pnlQuote: number; closedAt: number }
}
