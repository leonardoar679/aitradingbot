/** A protective stop on a real futures position: the exit half of holding one.
 *
 * binanceFuturesTrading.ts says an open path is only responsible alongside the watcher that
 * exits it. This is that watcher, and it is deliberately NOT a timer inside this app.
 *
 * An app-side watcher only protects while the app is open. Closing a laptop, losing wifi or
 * quitting the app would remove the protection silently, and the person most likely to trust it
 * is exactly the one who would never find out it had stopped -- until the position was
 * liquidated. So the stop is placed AT the exchange as a real reduce-only STOP_MARKET order:
 * Binance holds it, triggers it, and cancels it when the position closes, whether this app is
 * running or not.
 *
 * It also cannot increase exposure. closePosition orders only ever close, so this stays inside
 * the same line the close path draws: this app can help someone OUT of a leveraged position and
 * cannot put them into one. */

import type { FuturesPosition } from './futuresPositions'

export interface ProtectiveStop {
  symbol: string
  orderId: number
  /** The trigger. Not the fill: a STOP_MARKET becomes a market order when touched, so the actual
   * exit can be worse -- which is why nothing here calls it a guaranteed price. */
  stopPrice: number
  side: 'BUY' | 'SELL'
  /** Binance's own type string, kept so the UI can distinguish a market stop (fills at whatever
   * the market pays) from a stop-limit (which can fail to fill at all in a fast move). */
  type: string
  /** True for closePosition orders, which always close the whole position however large it has
   * since grown. False for a reduce-only order sized at placement time, which can leave a
   * remainder open if the position was added to afterwards. */
  closesWholePosition: boolean
}

/** The raw shape of one Binance /fapi/v1/openOrders row. Numeric fields arrive as strings. */
export interface RawFuturesOrder {
  symbol?: string
  orderId?: number
  side?: string
  type?: string
  stopPrice?: string
  reduceOnly?: boolean
  closePosition?: boolean
}

/** The stop orders among whatever is resting on the futures account.
 *
 * Narrow on purpose. An order counts as protection only if it triggers on a price moving against
 * the position AND cannot do anything but reduce it. A take-profit order also rests and also has
 * a stopPrice, and calling one of those "protected" would tell someone their downside was covered
 * when the only thing waiting for them was an exit into profit. */
export function readableProtectiveStops(rows: readonly RawFuturesOrder[]): ProtectiveStop[] {
  const stops: ProtectiveStop[] = []

  for (const row of rows) {
    const symbol = typeof row.symbol === 'string' ? row.symbol : ''
    const type = typeof row.type === 'string' ? row.type : ''
    if (symbol === '' || typeof row.orderId !== 'number') continue
    // TAKE_PROFIT and TAKE_PROFIT_MARKET also rest on a trigger price, hence a prefix test rather
    // than a bare "contains STOP".
    if (!type.startsWith('STOP')) continue
    if (row.closePosition !== true && row.reduceOnly !== true) continue

    const stopPrice = Number(row.stopPrice)
    // A stop whose trigger cannot be read is not reported as a stop at all. A row reading
    // "protected at NaN" is worse than no row, because "protected" is the part people act on.
    if (!(stopPrice > 0)) continue

    const side = row.side === 'BUY' ? 'BUY' : row.side === 'SELL' ? 'SELL' : null
    if (side === null) continue

    stops.push({ symbol, orderId: row.orderId, stopPrice, side, type, closesWholePosition: row.closePosition === true })
  }

  return stops
}

/** The stop covering a position, if there is one.
 *
 * Matched on side as well as symbol: a stop that would BUY does not protect a long, it protects a
 * short. On a one-way-mode account only one of the two can exist, but reading the side is what
 * makes that a fact this code checks rather than one it assumes. */
export function stopForPosition(position: FuturesPosition, stops: readonly ProtectiveStop[]): ProtectiveStop | null {
  const closing = position.positionAmt > 0 ? 'SELL' : 'BUY'
  return stops.find((s) => s.symbol === position.symbol && s.side === closing) ?? null
}

/** Roughly what triggering this stop would cost, in quote currency.
 *
 * The number a beginner actually needs, and the one no exchange screen shows them: not "your stop
 * is at 58500" but "if it triggers you lose about 15 dollars". Approximate by construction -- a
 * market stop fills at whatever is there, and fees are not in it -- so every caller words it as
 * "about".
 *
 * Negative when the stop sits in profit (moved up above entry on a long), which is a real and
 * useful thing to see: the position is locked into a gain rather than a loss. */
export function stopRiskQuote(position: FuturesPosition, stopPrice: number): number | null {
  if (!(stopPrice > 0)) return null
  if (!Number.isFinite(position.entryPrice) || !Number.isFinite(position.positionAmt)) return null
  const perUnit = position.positionAmt > 0 ? position.entryPrice - stopPrice : stopPrice - position.entryPrice
  const risk = perUnit * Math.abs(position.positionAmt)
  return Number.isFinite(risk) ? risk : null
}

/** How far the price has to move from the mark to reach the stop, as a percentage of the mark.
 *
 * Unsigned, like distanceToLiquidationPct and for the same reason: it is a distance, and the
 * direction is already known from the side. */
export function stopDistancePct(position: FuturesPosition, stopPrice: number): number | null {
  if (!(stopPrice > 0)) return null
  if (!(position.markPrice > 0)) return null
  const distance = (Math.abs(position.markPrice - stopPrice) / position.markPrice) * 100
  return Number.isFinite(distance) ? distance : null
}

/** Why this stop price cannot be placed on this position, or null if it can.
 *
 * Every branch is written so an unreadable number falls INTO it rather than through it: the tests
 * are `!(a > b)`, not `a <= b`, because every comparison against NaN is false and a one-sided
 * test is how a validation gate silently turns itself off. Checked here as well as at the
 * exchange so the reason arrives as a sentence about this position rather than as Binance's
 * "-2021 Order would immediately trigger". */
export function describeStopPlacementError(position: FuturesPosition, stopPrice: number): string | null {
  if (!(stopPrice > 0)) return 'Enter the price this position should be closed at.'
  if (!(position.markPrice > 0)) {
    return 'Binance is not reporting a current price for this position, so this app cannot tell whether that stop is above or below it.'
  }

  const isLong = position.positionAmt > 0
  const wrongSide = isLong ? !(stopPrice < position.markPrice) : !(stopPrice > position.markPrice)
  if (wrongSide) {
    return isLong
      ? `A stop for a long has to be BELOW the current price (${position.markPrice}). Placed above it, it would trigger straight away and close the position at once.`
      : `A stop for a short has to be ABOVE the current price (${position.markPrice}). Placed below it, it would trigger straight away and close the position at once.`
  }

  if (position.liquidationPrice !== null) {
    const beyondLiquidation = isLong
      ? !(stopPrice > position.liquidationPrice)
      : !(stopPrice < position.liquidationPrice)
    if (beyondLiquidation) {
      return `The exchange liquidates this position at ${position.liquidationPrice}, so a stop at ${stopPrice} would never be reached — the position would already be gone. Choose a price on this side of ${position.liquidationPrice}.`
    }
  }

  return null
}

/** What a resting stop means, in one sentence, for someone who has not used one before. */
export function describeProtectiveStop(position: FuturesPosition, stop: ProtectiveStop, quoteAsset = 'USDT'): string {
  const distance = stopDistancePct(position, stop.stopPrice)
  const risk = stopRiskQuote(position, stop.stopPrice)
  const reach = distance === null ? '' : ` — ${distance.toFixed(2)}% from here`
  if (risk === null) {
    return `Closes this position if the price reaches ${stop.stopPrice}${reach}.`
  }
  if (risk === 0) {
    // A stop moved to the entry price. Worth its own sentence: it is the specific thing a
    // beginner is told to do once a trade is going their way, and describing it as a loss of
    // 0.00 would hide the only interesting fact about it.
    return `Closes this position at your entry price, ${stop.stopPrice}${reach} — roughly break even, before fees.`
  }
  if (risk > 0) {
    return `Closes this position if the price reaches ${stop.stopPrice}${reach}, for a loss of about ${risk.toFixed(2)} ${quoteAsset}.`
  }
  return `Closes this position if the price falls back to ${stop.stopPrice}${reach}, keeping about ${Math.abs(risk).toFixed(2)} ${quoteAsset} of the gain.`
}
