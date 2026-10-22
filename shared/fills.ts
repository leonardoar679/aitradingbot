import type { Candle } from './ipc'

// HOW A RESTING ORDER AND A STOP FILL ON A BAR (moved here from src/executors/engine.ts in V7.2-R Stage 5, 22 October
// 2026, so that the replay out of sample, which runs where the engine's file cannot be read, fills its orders by the same
// two rules the paper engine does). The engine imports both from here and hands them on unchanged.

/** Fill price for a stop that the candle traded through. A stop order becomes a market order
 * when triggered, so a candle that *opens* beyond the stop never trades at the stop price at all
 * — the fill is the open, and it is worse. Reporting the stop price there invents protection the
 * position did not have, and it does so only on losing exits.
 *
 * src/backtest/engine.ts has always modelled this (Math.min(open, stopPrice) on its ATR stop);
 * the executor simulations did not, so the same gap produced two different answers depending on
 * which engine you asked. Measured on live 1m data: Binance BTCUSDT opens ≥0.1% from the prior
 * close on 1.8% of candles, but thin Korean pairs are far worse — GOPAX BTC-KRW had 16 of 23
 * slots missing entirely, 18% of candles opening ≥0.1% away and 4.5% opening ≥0.5% away. */
export function stopFillPrice(candleOpen: number, stopPrice: number, isBuy: boolean): number {
  return isBuy ? Math.min(candleOpen, stopPrice) : Math.max(candleOpen, stopPrice)
}

/** What a resting limit order at `price` fills at on this candle, or null if it does not fill.
 *
 * A limit order is not "did this candle print exactly at my price". It is a standing bid or offer,
 * and the straddle test `low <= price && price <= high` gets two cases wrong -- both of which
 * leave the order pending for good:
 *
 *   marketable on arrival   a buy limit above the market is filled at once, at the market
 *   gapped clean through    a buy at 95 and a candle spanning 88-91 is taken at 95 on the way past
 *
 * simulateOrder was fixed for exactly this and says so at length. Grid levels, DCA levels and a
 * position's entry price all still required the straddle, so the same order filled or sat pending
 * depending on which executor was holding it -- and a Position whose entry price was above the
 * market reported "the entry price was never reached" forever.
 *
 * The fill is the limit price whenever the candle reaches it from the correct side, and the
 * candle's open when the order was already marketable as the candle opened: you are filled at the
 * market, not at a price you were merely willing to pay. That is the opposite of a stop, which
 * triggers into a market order and takes whatever the gap leaves (see stopFillPrice). */
export function limitFillPrice(candle: Pick<Candle, 'open' | 'high' | 'low'>, price: number, isBuy: boolean): number | null {
  const reached = isBuy ? candle.low <= price : candle.high >= price
  if (!reached) return null
  const marketableAtOpen = isBuy ? candle.open <= price : candle.open >= price
  return marketableAtOpen ? candle.open : price
}
