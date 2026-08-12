// Mock portfolio data. There is no wallet/exchange balance aggregation wired up yet, so the
// Portfolio page renders demo figures shaped like the reference design until that lands.

export interface Holding {
  symbol: string
  color: string
  value: number
}

export const MOCK_HOLDINGS: Holding[] = [
  { symbol: 'USD', color: '#d4a94a', value: 514.95 },
  { symbol: 'HYPE', color: '#3ecf6a', value: 62.82 },
  { symbol: 'USOL', color: '#6d5ff5', value: 43.05 },
  { symbol: 'USDC', color: '#ef4444', value: 22.19 }
]

export const TOTAL_VALUE = MOCK_HOLDINGS.reduce((sum, h) => sum + h.value, 0)
export const WEEKLY_CHANGE = -763.45

export type Timeframe = '1D' | '1W' | '1M' | '3M'

export const TIMEFRAMES: Timeframe[] = ['1D', '1W', '1M', '3M']

const TIMEFRAME_CONFIG: Record<Timeframe, { points: number; stepSeconds: number }> = {
  '1D': { points: 24, stepSeconds: 3600 },
  '1W': { points: 42, stepSeconds: 4 * 3600 },
  '1M': { points: 30, stepSeconds: 24 * 3600 },
  '3M': { points: 90, stepSeconds: 24 * 3600 }
}

export interface PortfolioPoint {
  time: number
  value: number
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic mock equity curve, walked backward from today's TOTAL_VALUE so the chart's
 * last point always matches the "Total Value" stat card. */
export function generatePortfolioSeries(timeframe: Timeframe): PortfolioPoint[] {
  const { points, stepSeconds } = TIMEFRAME_CONFIG[timeframe]
  const rand = mulberry32(1337 + points)
  const values: number[] = [TOTAL_VALUE]
  for (let i = 1; i < points; i++) {
    const prev = values[i - 1]
    const magnitude = rand() < 0.12 ? 0.85 : 0.16
    const shock = (rand() - 0.5) * prev * magnitude
    values.push(Math.max(20, prev + shock))
  }
  values.reverse()

  const nowSec = Math.floor(Date.now() / 1000)
  const startTime = nowSec - stepSeconds * (points - 1)
  return values.map((value, i) => ({ time: startTime + i * stepSeconds, value }))
}
