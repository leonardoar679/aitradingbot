import type { Candle, ArbitrageExecutorParams, XemmExecutorParams } from '../../shared/ipc'
import { spreadCaptureFee } from '../../shared/fees'
import type { SpreadCapture, SpreadExecutorState } from './types'

export interface AlignedPoint {
  time: number
  priceA: number
  priceB: number
}

/** Inner-join two candle series on shared 1m timestamps — both markets are fetched at the same
 * interval, so times line up except for exchange-specific gaps (which are simply dropped). */
export function alignByTime(candlesA: Candle[], candlesB: Candle[]): AlignedPoint[] {
  const mapB = new Map(candlesB.map((c) => [c.time, c.close]))
  const points: AlignedPoint[] = []
  for (const a of candlesA) {
    const priceB = mapB.get(a.time)
    if (priceB !== undefined) points.push({ time: a.time, priceA: a.close, priceB })
  }
  return points
}

export function spreadPct(priceA: number, priceB: number): number {
  return ((priceB - priceA) / priceA) * 100
}

/** XEMM: buy on buyingMarket, sell on sellingMarket, profit from `sellingMarket` pricing higher.
 * There's no real order book here, so "capturing" a spread is edge-triggered (armed → captured →
 * re-armed once the spread retreats) rather than firing on every candle the spread stays wide —
 * otherwise a spread that stays open for hours would produce thousands of unrealistic captures. */
export function simulateXemm(aligned: AlignedPoint[], params: XemmExecutorParams): SpreadExecutorState {
  const captures: SpreadCapture[] = []
  let realizedPnl = 0
  let lastSpreadPct: number | null = null
  let armed = true

  for (const point of aligned) {
    const pct = spreadPct(point.priceA, point.priceB)
    lastSpreadPct = pct

    if (armed && pct >= params.minProfitabilityPct) {
      const profitQuote = params.orderAmountQuote * (pct / 100) - spreadCaptureFee(params.orderAmountQuote, pct)
      captures.push({ time: point.time, spreadPct: pct, profitQuote })
      realizedPnl += profitQuote
      armed = false
    } else if (!armed && pct < params.minProfitabilityPct / 2) {
      armed = true
    }
  }

  return { kind: 'xemm', captures, realizedPnl, lastSpreadPct }
}

/** Arbitrage: profits from the spread in either direction (buy the cheaper market, sell the
 * pricier one), unlike XEMM which is directional (buyingMarket → sellingMarket only). */
export function simulateArbitrage(aligned: AlignedPoint[], params: ArbitrageExecutorParams): SpreadExecutorState {
  const captures: SpreadCapture[] = []
  let realizedPnl = 0
  let lastSpreadPct: number | null = null
  let armed = true

  for (const point of aligned) {
    const pct = spreadPct(point.priceA, point.priceB)
    lastSpreadPct = pct
    const absPct = Math.abs(pct)

    if (armed && absPct >= params.minProfitabilityPct) {
      const profitQuote = params.orderAmountQuote * (absPct / 100) - spreadCaptureFee(params.orderAmountQuote, absPct)
      captures.push({ time: point.time, spreadPct: pct, profitQuote })
      realizedPnl += profitQuote
      armed = false
    } else if (!armed && absPct < params.minProfitabilityPct / 2) {
      armed = true
    }
  }

  return { kind: 'arbitrage', captures, realizedPnl, lastSpreadPct }
}
