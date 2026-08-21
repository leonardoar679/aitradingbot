import { createHmac } from 'crypto'
import { resolveEndpoint } from './binance'

// Live-trading groundwork for Binance only (see live-trading design plan — Phase A is limited to
// this one authenticated, read-only call, used solely to verify a newly-entered API key/secret
// before it's ever persisted). No order placement exists yet.

export interface AccountBalance {
  asset: string
  free: number
  locked: number
}

interface BinanceAccountResponse {
  balances: { asset: string; free: string; locked: string }[]
}

interface BinanceErrorResponse {
  code: number
  msg: string
}

interface BinanceServerTimeResponse {
  serverTime: number
}

let serverTimeOffsetMs = 0
let serverTimeOffsetResolvedAt = 0
const SERVER_TIME_TTL_MS = 5 * 60 * 1000

// Binance rejects signed requests whose `timestamp` drifts too far from its own clock (error
// -1021), so the offset from the local clock is measured against Binance's own `/time` endpoint
// rather than trusting the machine's clock to be accurate.
async function getServerTimeOffset(restRoot: string): Promise<number> {
  const now = Date.now()
  if (now - serverTimeOffsetResolvedAt < SERVER_TIME_TTL_MS) return serverTimeOffsetMs
  const response = await fetch(`${restRoot}/time`)
  if (!response.ok) throw new Error(`Binance time request failed: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as BinanceServerTimeResponse
  serverTimeOffsetMs = data.serverTime - Date.now()
  serverTimeOffsetResolvedAt = Date.now()
  return serverTimeOffsetMs
}

// Never log `apiSecret`, `apiKey`, or the computed `signature` — an invariant enforced across
// this whole module, since a leaked API secret is equivalent to a leaked key.
async function signedRequest(
  apiKey: string,
  apiSecret: string,
  path: string,
  params: Record<string, string>,
  method: 'GET' | 'POST' | 'DELETE'
): Promise<unknown> {
  const endpoint = await resolveEndpoint()
  const offset = await getServerTimeOffset(endpoint.restRoot)
  const timestamp = Date.now() + offset

  const query = new URLSearchParams({ ...params, timestamp: String(timestamp) })
  const signature = createHmac('sha256', apiSecret).update(query.toString()).digest('hex')
  query.set('signature', signature)

  const response = await fetch(`${endpoint.restRoot}${path}?${query.toString()}`, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey }
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'msg' in body ? (body as BinanceErrorResponse).msg : response.statusText
    throw new Error(`Binance API error: ${message}`)
  }
  return body
}

/** The one authenticated call Phase A needs: proves a key/secret pair is valid and can read the
 * account, without placing any order. */
export async function fetchAccountBalance(apiKey: string, apiSecret: string): Promise<AccountBalance[]> {
  const data = (await signedRequest(apiKey, apiSecret, '/account', {}, 'GET')) as BinanceAccountResponse
  return data.balances.map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
}

export interface LiveOrderResult {
  orderId: number
  status: string
  filledQty: number
  avgFillPrice: number
  cummulativeQuoteQty: number
}

interface BinanceOrderFill {
  price: string
  qty: string
}

interface BinanceOrderResponse {
  orderId: number
  status: string
  executedQty: string
  cummulativeQuoteQty: string
  fills?: BinanceOrderFill[]
}

function parseOrderResponse(data: BinanceOrderResponse): LiveOrderResult {
  const fills = data.fills ?? []
  const filledQty = Number(data.executedQty)
  const cummulativeQuoteQty = Number(data.cummulativeQuoteQty)
  const avgFillPrice =
    fills.length > 0
      ? fills.reduce((sum, f) => sum + Number(f.price) * Number(f.qty), 0) / fills.reduce((sum, f) => sum + Number(f.qty), 0)
      : filledQty > 0
        ? cummulativeQuoteQty / filledQty
        : 0

  return { orderId: data.orderId, status: data.status, filledQty, avgFillPrice, cummulativeQuoteQty }
}

// Binance rejects any order whose quantity isn't an exact multiple of the symbol's LOT_SIZE
// stepSize, whose price isn't a multiple of PRICE_FILTER tickSize, or whose notional is under
// the symbol's minimum -- with terse errors like "Filter failure: LOT_SIZE". Sizes here are
// derived from a quote amount (amountQuote / limitPrice), which essentially never lands on a
// valid step, so every live limit order was being sent in a form the exchange would refuse.
// Fetched per symbol and cached: these filters change very rarely, and an order path should not
// pay for a full /exchangeInfo download on every placement.
interface SymbolFilters {
  stepSize: string
  minQty: number
  tickSize: string
  minNotional: number
}

interface BinanceFilter {
  filterType: string
  stepSize?: string
  minQty?: string
  tickSize?: string
  minNotional?: string
}

const symbolFiltersCache = new Map<string, { filters: SymbolFilters; fetchedAt: number }>()
const SYMBOL_FILTERS_TTL_MS = 24 * 60 * 60 * 1000

async function getSymbolFilters(symbol: string): Promise<SymbolFilters> {
  const cached = symbolFiltersCache.get(symbol)
  if (cached && Date.now() - cached.fetchedAt < SYMBOL_FILTERS_TTL_MS) return cached.filters

  const endpoint = await resolveEndpoint()
  const response = await fetch(`${endpoint.restRoot}/exchangeInfo?symbol=${symbol.toUpperCase()}`)
  if (!response.ok) throw new Error(`Could not load trading rules for ${symbol}: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as { symbols?: { filters: BinanceFilter[] }[] }
  const entry = data.symbols?.[0]
  if (!entry) throw new Error(`Could not load trading rules for ${symbol}: symbol not found on the exchange`)

  const lotSize = entry.filters.find((f) => f.filterType === 'LOT_SIZE')
  const priceFilter = entry.filters.find((f) => f.filterType === 'PRICE_FILTER')
  // Binance has used both names for this filter; newer symbols report NOTIONAL.
  const notional = entry.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL')

  const filters: SymbolFilters = {
    stepSize: lotSize?.stepSize ?? '0.00000001',
    minQty: Number(lotSize?.minQty ?? 0),
    tickSize: priceFilter?.tickSize ?? '0.00000001',
    minNotional: Number(notional?.minNotional ?? 0)
  }
  symbolFiltersCache.set(symbol, { filters, fetchedAt: Date.now() })
  return filters
}

/** Decimal places implied by a Binance step/tick string ("0.00001000" -> 5, "1.00000000" -> 0). */
export function stepPrecision(step: string): number {
  const trimmed = step.replace(/0+$/, '')
  const dot = trimmed.indexOf('.')
  return dot === -1 ? 0 : trimmed.length - dot - 1
}

/** Floors `value` onto the given step and renders it as a plain decimal string.
 *
 * Always floors, never rounds up: a quantity rounded up can exceed the balance actually held
 * (rejected as insufficient funds when closing), and a price rounded up makes a limit order more
 * aggressive than the user asked for. Flooring is the conservative direction on both.
 *
 * toFixed also avoids String()'s exponential notation -- String(1e-7) is "1e-7", which Binance
 * rejects outright, and small-quantity orders on high-priced pairs land in exactly that range. */
export function floorToStep(value: number, step: string): string {
  const precision = stepPrecision(step)
  const stepNum = Number(step)
  if (!(stepNum > 0)) return value.toFixed(precision)
  const floored = Math.floor(value / stepNum) * stepNum
  return floored.toFixed(precision)
}

/** Phase B: the first real write. Market order sized in quote currency (quoteOrderQty), matching
 * every `orderAmountQuote` field already used throughout this app's paper executors. A market
 * order can cross multiple price levels, so the average fill price is derived from `fills[]`
 * (notional-weighted) rather than assumed to be a single price. This function does not check any
 * safety gate itself — the caller (the ExecutorPlaceLiveOrder IPC handler) must call
 * liveTradingService.canPlaceLiveOrder immediately before invoking this, every time. */
export async function placeMarketOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  quoteAmount: number
): Promise<LiveOrderResult> {
  const data = (await signedRequest(
    apiKey,
    apiSecret,
    '/order',
    { symbol, side, type: 'MARKET', quoteOrderQty: String(quoteAmount) },
    'POST'
  )) as BinanceOrderResponse
  return parseOrderResponse(data)
}

/** Phase 2b: closing a live position. Sized in base-asset quantity (not quote), so it sells
 * exactly the tracked position qty rather than "however much $X buys" — avoids leaving dust or
 * drifting from the ledger. Gate with liveTradingService.canCloseLivePosition, not
 * canPlaceLiveOrder — closing a position is never subject to the size/cap/loss-limit gates that
 * bound *new* exposure. */
export async function placeMarketSellByQuantity(apiKey: string, apiSecret: string, symbol: string, quantity: number): Promise<LiveOrderResult> {
  const filters = await getSymbolFilters(symbol)
  // Floored, never rounded up: selling more than the ledger tracks would be rejected for
  // insufficient balance, which would leave a position the user is trying to exit stuck open.
  const roundedQty = floorToStep(quantity, filters.stepSize)
  if (Number(roundedQty) <= 0) {
    throw new Error(`Position size ${quantity} is below ${symbol}'s minimum tradable increment (${filters.stepSize}) and cannot be sold.`)
  }

  const data = (await signedRequest(
    apiKey,
    apiSecret,
    '/order',
    { symbol, side: 'SELL', type: 'MARKET', quantity: roundedQty },
    'POST'
  )) as BinanceOrderResponse
  return parseOrderResponse(data)
}

/** Phase 2c: a real resting limit order. GTC (good-till-cancelled) only — this app doesn't
 * support limit_maker (post-only) or limit_chaser (continuous re-quoting) live, since the paper
 * simulator doesn't meaningfully distinguish either from plain limit/market (see engine.ts's
 * simulateOrder comment). Binance can return FILLED synchronously if the price already crosses
 * the book when placed — the caller treats that the same as a resting order that fills later,
 * just immediately. */
export async function placeLimitOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  price: number
): Promise<LiveOrderResult> {
  const filters = await getSymbolFilters(symbol)
  const roundedQty = floorToStep(quantity, filters.stepSize)
  const roundedPrice = floorToStep(price, filters.tickSize)

  // Fail here, with a message naming the actual constraint, rather than sending an order the
  // exchange will bounce with "Filter failure: LOT_SIZE" / "NOTIONAL".
  if (Number(roundedQty) <= 0 || Number(roundedQty) < filters.minQty) {
    throw new Error(
      `Order size too small for ${symbol}: ${quantity} rounds to ${roundedQty}, below the exchange minimum of ${filters.minQty}. Increase the amount per level.`
    )
  }
  const notional = Number(roundedQty) * Number(roundedPrice)
  if (filters.minNotional > 0 && notional < filters.minNotional) {
    throw new Error(
      `Order value too small for ${symbol}: ${notional.toFixed(2)} is below the exchange minimum of ${filters.minNotional}. Increase the amount per level, or use fewer levels.`
    )
  }

  const data = (await signedRequest(
    apiKey,
    apiSecret,
    '/order',
    { symbol, side, type: 'LIMIT', timeInForce: 'GTC', quantity: roundedQty, price: roundedPrice },
    'POST'
  )) as BinanceOrderResponse
  return parseOrderResponse(data)
}

/** Polled by LiveOrderScheduler every few seconds for every open LiveOrder — deliberately
 * polling rather than an authenticated user-data-stream websocket (listenKey lifecycle,
 * keep-alive renewal, reconnect handling); see the Phase 2c plan for why that's disproportionate
 * here. */
export async function queryOrder(apiKey: string, apiSecret: string, symbol: string, orderId: number): Promise<LiveOrderResult> {
  const data = (await signedRequest(apiKey, apiSecret, '/order', { symbol, orderId: String(orderId) }, 'GET')) as BinanceOrderResponse
  return parseOrderResponse(data)
}

/** Cancels a resting order. Binance's cancel response already includes `executedQty` for
 * whatever partially filled before cancellation, so no follow-up query is needed. Deliberately
 * has no gate check anywhere in this app — see liveTradingService.ts: cancellation only ever
 * reduces risk, so it's never blocked by session-arm, the kill switch, or any cap. */
export async function cancelOrder(apiKey: string, apiSecret: string, symbol: string, orderId: number): Promise<LiveOrderResult> {
  const data = (await signedRequest(apiKey, apiSecret, '/order', { symbol, orderId: String(orderId) }, 'DELETE')) as BinanceOrderResponse
  return parseOrderResponse(data)
}
