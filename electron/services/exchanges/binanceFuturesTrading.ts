import { createHmac } from 'crypto'
import type { FuturesCloseResult } from '../../../shared/futuresPositions'

/** The one thing this app can WRITE to a futures account: closing a position that already exists.
 *
 * Deliberately its own file, and deliberately only half of "trading". binanceFutures.ts is
 * structurally read-only and stays that way; this is the single, narrow exception, kept apart so
 * that the separation means something a reader can check rather than a claim in a comment.
 *
 * Opening a leveraged position is NOT here, and its absence is a decision rather than a gap. A
 * spot buy this app cannot manage afterwards simply leaves the user holding an asset. A 10x long
 * this app cannot manage afterwards gets liquidated. An open path is only responsible alongside
 * the watcher that exits it, and that is a larger piece of work than this file -- so until it
 * exists, this app can help someone OUT of a leveraged position and cannot put them into one.
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

async function signedPost(apiKey: string, apiSecret: string, path: string, params: Record<string, string>): Promise<unknown> {
  const offset = await futuresTimeOffset()
  const query = new URLSearchParams({ ...params, timestamp: String(Date.now() + offset) })
  query.set('signature', createHmac('sha256', apiSecret).update(query.toString()).digest('hex'))

  const response = await fetch(`${FUTURES_REST_ROOT}${path}?${query.toString()}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': apiKey }
  })
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
