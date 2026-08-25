import { createHmac } from 'crypto'
import type { FuturesCloseResult } from '../../../shared/futuresPositions'
import type { ProtectiveStop } from '../../../shared/futuresStops'

/** Everything this app can WRITE to a futures account, and it is all one thing: getting OUT.
 *
 * Three operations, no more. Close a position at market; place a stop that closes it if the price
 * reaches a level; cancel that stop. None of them can open a position or make one larger --
 * closing orders are sized from the position itself and marked reduce-only or closePosition, so
 * the exchange itself refuses to let any of them turn into an opening trade.
 *
 * Deliberately its own file. binanceFutures.ts is structurally read-only and stays that way; this
 * is the narrow exception, kept apart so the separation is something a reader can check in a
 * directory listing rather than a claim in a comment.
 *
 * Opening a leveraged position is NOT here, and its absence is a decision rather than a gap. A
 * spot buy this app cannot manage afterwards simply leaves the user holding an asset. A 10x long
 * this app cannot manage afterwards gets liquidated. An open path is only responsible alongside
 * the exit that protects it -- so until this app can do the whole job, it can help someone OUT of
 * a leveraged position and cannot put them into one.
 *
 * That asymmetry is also why closing is gated by canCloseLivePosition rather than
 * canPlaceLiveOrder: the size, daily-cap and loss-limit gates all bound new exposure, and none of
 * them should ever be able to trap someone inside a position they are trying to leave.
 *
 * Never log `apiSecret`, `apiKey` or the computed signature. */

const FUTURES_REST_ROOT = 'https://fapi.binance.com'

interface BinanceErrorResponse {
  code: number
  msg: string
}

interface BinanceServerTimeResponse {
  serverTime: number
}

interface FuturesOrderResponse {
  orderId?: number
  status?: string
  executedQty?: string
  avgPrice?: string
  stopPrice?: string
  type?: string
  closePosition?: boolean
}

let serverTimeOffsetMs = 0
let serverTimeOffsetResolvedAt = 0
const SERVER_TIME_TTL_MS = 5 * 60 * 1000

async function futuresTimeOffset(): Promise<number> {
  const now = Date.now()
  if (now - serverTimeOffsetResolvedAt < SERVER_TIME_TTL_MS) return serverTimeOffsetMs
  const response = await fetch(`${FUTURES_REST_ROOT}/fapi/v1/time`)
  if (!response.ok) {
    throw new Error(`Binance futures time request failed: ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as BinanceServerTimeResponse
  serverTimeOffsetMs = data.serverTime - Date.now()
  serverTimeOffsetResolvedAt = Date.now()
  return serverTimeOffsetMs
}

async function signedQuery(apiSecret: string, params: Record<string, string>): Promise<string> {
  const offset = await futuresTimeOffset()
  const query = new URLSearchParams({ ...params, timestamp: String(Date.now() + offset) })
  query.set('signature', createHmac('sha256', apiSecret).update(query.toString()).digest('hex'))
  return query.toString()
}

async function readFuturesResponse(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'msg' in body ? (body as BinanceErrorResponse).msg : response.statusText
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Binance futures rejected this key (${message}). A spot API key does not automatically have futures permission — check "Enable Futures" on the key, and that this machine's IP is allowlisted.`
      )
    }
    throw new Error(`Binance futures API error: ${message}`)
  }
  return body
}

async function signedPost(apiKey: string, apiSecret: string, path: string, params: Record<string, string>): Promise<unknown> {
  const response = await fetch(`${FUTURES_REST_ROOT}${path}?${await signedQuery(apiSecret, params)}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': apiKey }
  })
  return readFuturesResponse(response)
}

/** Its own function rather than a `method` parameter on signedPost, and the duplication is the
 * point: a helper that takes its verb as an argument is a helper that can be handed the wrong one
 * by an edit that meant well. Cancelling is the only DELETE this app makes. */
async function signedDelete(apiKey: string, apiSecret: string, path: string, params: Record<string, string>): Promise<unknown> {
  const response = await fetch(`${FUTURES_REST_ROOT}${path}?${await signedQuery(apiSecret, params)}`, {
    method: 'DELETE',
    headers: { 'X-MBX-APIKEY': apiKey }
  })
  return readFuturesResponse(response)
}

/** The side that closes a position, given its signed size.
 *
 * A long (positive size) is closed by selling and a short by buying, so this is the inverse of
 * the side that opened it. Getting it backwards would DOUBLE the position rather than close it,
 * which on a leveraged position is the difference between exiting and being liquidated twice as
 * fast -- worth its own function and its own test rather than an inline ternary. */
export function closingSide(positionAmt: number): 'BUY' | 'SELL' {
  return positionAmt > 0 ? 'SELL' : 'BUY'
}

/** Closes an open futures position at market, reduce-only.
 *
 * `reduceOnly` is belt and braces on top of sizing it exactly: even if the position moved between
 * being read and this order arriving, the exchange itself will not let this order open anything
 * in the other direction. Without it, closing a position that had already closed would silently
 * open the opposite one.
 *
 * The quantity is the position's own size, so it needs no step-size rounding -- whatever the
 * exchange opened is by definition a tradable increment. It is sent as an absolute value because
 * direction is carried by the side, not by the sign. */
export async function closeFuturesPosition(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  positionAmt: number
): Promise<FuturesCloseResult> {
  if (!Number.isFinite(positionAmt) || positionAmt === 0) {
    throw new Error(`There is no open ${symbol} position to close (size reported as ${positionAmt}).`)
  }

  const data = (await signedPost(apiKey, apiSecret, '/fapi/v1/order', {
    symbol,
    side: closingSide(positionAmt),
    type: 'MARKET',
    quantity: String(Math.abs(positionAmt)),
    reduceOnly: 'true'
  })) as FuturesOrderResponse

  if (typeof data?.orderId !== 'number') {
    // A 200 whose body is not the documented shape must not be reported as a successful close:
    // the user would believe they were out of a position that is still open and still leveraged.
    throw new Error('Binance futures accepted the request but did not return an order — treat this position as still open and check on Binance.')
  }

  const avgPrice = Number(data.avgPrice)
  return {
    orderId: data.orderId,
    status: typeof data.status === 'string' ? data.status : 'UNKNOWN',
    closedQty: Number(data.executedQty),
    // Binance reports "0" for a price it has not filled at yet. Reporting that as a fill price of
    // zero would show the user a close at nothing, and a P&L to match.
    avgPrice: Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : null
  }
}

/** Places a stop that closes this position if the price reaches `stopPrice`.
 *
 * The whole reason this is an exchange-side order rather than a timer in this app: Binance holds
 * it, triggers it and cancels it when the position closes, whether this app is running, asleep or
 * uninstalled. A stop that only works while a desktop app happens to be open is the kind of
 * protection that fails precisely when someone has stopped watching, which is when they were
 * relying on it most.
 *
 * `closePosition=true` rather than a quantity: it always closes whatever the position has grown
 * to, it can never leave a remainder open, and it can never become an opening order. Binance
 * forbids sending `quantity` or `reduceOnly` alongside it, which is why neither appears here.
 *
 * `workingType=MARK_PRICE` because liquidation is measured against the mark, so a stop meant to
 * fire *before* liquidation has to be reading the same number. Triggering on the last traded
 * price instead would let a single wick on a thin book close a position the exchange itself was
 * nowhere near touching.
 *
 * What this does NOT promise: a fill at `stopPrice`. A triggered STOP_MARKET is a market order,
 * so the exit can be worse in a fast move. Nothing here or in the UI calls it a guaranteed price. */
export async function placeProtectiveStop(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  positionAmt: number,
  stopPrice: number
): Promise<ProtectiveStop> {
  if (!Number.isFinite(positionAmt) || positionAmt === 0) {
    throw new Error(`There is no open ${symbol} position to protect (size reported as ${positionAmt}).`)
  }
  if (!(stopPrice > 0)) {
    throw new Error(`A stop price of ${stopPrice} is not a price this app will send to an exchange.`)
  }

  const side = closingSide(positionAmt)
  const data = (await signedPost(apiKey, apiSecret, '/fapi/v1/order', {
    symbol,
    side,
    type: 'STOP_MARKET',
    stopPrice: String(stopPrice),
    closePosition: 'true',
    workingType: 'MARK_PRICE'
  })) as FuturesOrderResponse

  if (typeof data?.orderId !== 'number') {
    // Same rule as closing: a 200 that is not the documented shape must never be reported as
    // success. Here the failure would be worse than useless -- someone would believe a position
    // was protected and stop watching it.
    throw new Error('Binance futures accepted the request but did not return an order — treat this position as unprotected and check on Binance.')
  }

  // The exchange echoes the trigger it actually recorded; that is the number worth reporting.
  // Falling back to the requested one only when it cannot be read, because an order that exists
  // is better described by an approximate price than by nothing.
  const echoed = Number(data.stopPrice)
  return {
    symbol,
    orderId: data.orderId,
    stopPrice: Number.isFinite(echoed) && echoed > 0 ? echoed : stopPrice,
    side,
    type: typeof data.type === 'string' ? data.type : 'STOP_MARKET',
    closesWholePosition: data.closePosition === true
  }
}

/** Cancels a resting stop.
 *
 * The one write here that makes a position MORE exposed, which is why it exists at all: a stop
 * this app can place and not remove is a trap of its own kind, and someone who wants to move
 * their stop closer has to be able to take the old one off. It is gated exactly like the others,
 * so a disarmed session or an engaged kill switch stops it too.
 *
 * A stop that has already triggered or been cancelled is reported as gone rather than as a
 * failure -- the user asked for it to not be there, and it is not there. */
export async function cancelProtectiveStop(apiKey: string, apiSecret: string, symbol: string, orderId: number): Promise<void> {
  if (!Number.isInteger(orderId)) {
    throw new Error(`${orderId} is not an order id this app will send to an exchange.`)
  }
  try {
    await signedDelete(apiKey, apiSecret, '/fapi/v1/order', { symbol, orderId: String(orderId) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // -2011 "Unknown order sent": already filled, already cancelled, or never there.
    if (/unknown order/i.test(message)) return
    throw error
  }
}
