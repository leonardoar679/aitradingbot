import { createHmac } from 'crypto'
import type { Commissions } from '../../../shared/observedFee'
import { resolveEndpoint, resolveTradingEndpoint } from './binance'
import type { SymbolTradingRules } from '../../../shared/exchangeMinimums'

// Live SPOT trading on Binance: reading the account, and placing, querying and cancelling real
// orders. Futures is a separate host and a separate pair of modules (binanceFutures.ts, which is
// read-only, and binanceFuturesTrading.ts, which can only close).
//
// Nothing in this file checks a safety gate. Every caller must pass through liveTradingService
// immediately before the network call -- canPlaceLiveOrder for anything that opens exposure,
// canCloseLivePosition for anything that reduces it.

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
  // Trading resolver, not the data one: the data list includes a market-data-only mirror with no
  // signed routes, and sending a real signed order there would 404 in a way that reads like a bad
  // API key rather than like a wrong host.
  const endpoint = await resolveTradingEndpoint()
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

/** Reads the account: proves a key/secret pair is valid, and is also what Live Trading shows.
 * Places no order.
 *
 * Every balance arrives as a decimal string and is converted here without a guard, deliberately:
 * a value that will not parse becomes NaN and is reported as unreadable by readableBalances,
 * which is information the user can act on. Silently substituting 0 would tell them they hold
 * nothing. */
export async function fetchAccountBalance(apiKey: string, apiSecret: string): Promise<AccountBalance[]> {
  const data = (await signedRequest(apiKey, apiSecret, '/account', {}, 'GET')) as BinanceAccountResponse
  // A 200 whose body is not the documented shape used to fail as "Cannot read properties of
  // undefined (reading 'map')", which reaches the user as the reason their API key was rejected
  // and points them at the wrong thing entirely.
  if (!Array.isArray(data?.balances)) {
    throw new Error('Binance returned an account response without a balance list')
  }
  return data.balances.map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
}

export interface LiveOrderResult {
  orderId: number
  status: string
  filledQty: number
  avgFillPrice: number
  cummulativeQuoteQty: number
  /** What the exchange actually charged for this order, keyed by the asset it was taken in.
   * Binance reports it per fill and the app used to drop it on the floor, then model the cost
   * with a hardcoded FEE_RATE instead -- an assumption standing in for a number already in hand.
   * Empty for a response that carried no fills (a resting order, or a query rather than a place). */
  commissions: Commissions
}

interface BinanceOrderFill {
  price: string
  qty: string
  /** Present on a fill; absent on responses that report no fills. The asset varies -- base on a
   * buy, quote on a sell, or BNB when the BNB discount is on. */
  commission?: string
  commissionAsset?: string
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

  const commissions: Commissions = {}
  for (const fill of fills) {
    const amount = Number(fill.commission)
    const asset = fill.commissionAsset
    if (asset === undefined || !Number.isFinite(amount) || amount === 0) continue
    commissions[asset] = (commissions[asset] ?? 0) + amount
  }

  return { orderId: data.orderId, status: data.status, filledQty, avgFillPrice, cummulativeQuoteQty, commissions }
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
  /** The step a QUOTE amount has to land on, derived from the symbol's quote-asset precision.
   * Binance rejects an over-precise quoteOrderQty outright (-1111), and a quote amount is very
   * often a division -- a 10 USDT TWAP over three slices is 3.3333333333333335. */
  quoteStep: string
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

/** The step a quote amount must land on, from a symbol's quote-asset precision.
 *
 * Eight decimals is the fallback and the ceiling: it is what every Binance quote asset uses
 * today, so an unreadable or absurd precision lands somewhere the exchange accepts rather than
 * somewhere it rejects. Anything that is not a plain non-negative integer -- absent, NaN, 2.5,
 * negative -- takes the fallback, because `toFixed` of any of those throws, and a crash inside
 * an order path is a far worse failure than eight decimals of precision. */
export function quoteStepFor(precision: number | undefined): string {
  const usable = Number.isInteger(precision) && (precision as number) >= 0 && (precision as number) <= 8 ? (precision as number) : 8
  return (1 / 10 ** usable).toFixed(usable)
}

async function getSymbolFilters(symbol: string): Promise<SymbolFilters> {
  const cached = symbolFiltersCache.get(symbol)
  if (cached && Date.now() - cached.fetchedAt < SYMBOL_FILTERS_TTL_MS) return cached.filters

  const endpoint = await resolveEndpoint()
  const response = await fetch(`${endpoint.restRoot}/exchangeInfo?symbol=${symbol.toUpperCase()}`)
  if (!response.ok) throw new Error(`Could not load trading rules for ${symbol}: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as { symbols?: { filters: BinanceFilter[]; quoteAssetPrecision?: number; quotePrecision?: number }[] }
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
    minNotional: Number(notional?.minNotional ?? 0),
    quoteStep: quoteStepFor(entry.quoteAssetPrecision ?? entry.quotePrecision)
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
  // An unusable step (the exchange returned "0", an empty string, or something unparseable)
  // must not reach `value / stepNum` -- that yields NaN, and "NaN" is what would then be sent
  // as the order quantity. Falling back to plain toFixed was the wrong way out of it: toFixed
  // ROUNDS, so a 1.5 quantity with no usable step became "2", which is precisely the
  // rounded-up-past-the-balance case this function exists to avoid. Floor to the precision
  // instead, so the fallback still honours the rule the rest of the function follows.
  const factor = 10 ** precision
  if (!(stepNum > 0)) return (Math.floor(value * factor) / factor).toFixed(precision)
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
  if (!(quoteAmount > 0)) {
    throw new Error(`A quote amount of ${quoteAmount} is not an order this app will send to an exchange.`)
  }

  // The rules are looked up so the amount can be floored to the precision this quote asset
  // actually accepts. A quote amount is very often a division -- a 10 USDT TWAP over three
  // slices is 3.3333333333333335 -- and String() of that is sixteen decimal places, which
  // Binance rejects outright with -1111 rather than rounding for us.
  //
  // A failed lookup does NOT block the order: it falls back to eight decimals, which every
  // Binance quote asset accepts. This path also carries closing sells, and a rules request that
  // times out must never be able to trap someone inside a position.
  let filters: SymbolFilters | null = null
  try {
    filters = await getSymbolFilters(symbol)
  } catch {
    filters = null
  }

  const roundedQuote = floorToStep(quoteAmount, filters?.quoteStep ?? '0.00000001')
  if (!(Number(roundedQuote) > 0)) {
    throw new Error(`${quoteAmount} is smaller than the smallest amount ${symbol} can be traded in and cannot be sent as an order.`)
  }
  // Named here rather than left to come back as "Filter failure: NOTIONAL", which tells someone
  // nothing about what to change. Skipped when the rules could not be read -- the exchange still
  // enforces it, this is only the part that explains it.
  if (filters !== null && filters.minNotional > 0 && Number(roundedQuote) < filters.minNotional) {
    throw new Error(
      `Order value too small for ${symbol}: ${roundedQuote} is below the exchange minimum of ${filters.minNotional}. Increase the amount per order.`
    )
  }

  const data = (await signedRequest(
    apiKey,
    apiSecret,
    '/order',
    { symbol, side, type: 'MARKET', quoteOrderQty: roundedQuote },
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

/** The trading rules for one symbol, for the UI to check a strategy against BEFORE it is created.
 *
 * Same cached lookup the order path uses, so the numbers a form warns about are the numbers the
 * order will actually be measured against. Reading rules is not trading: this is an unsigned,
 * public endpoint and needs no key. */
export async function fetchSymbolRules(symbol: string): Promise<SymbolTradingRules> {
  const filters = await getSymbolFilters(symbol)
  return {
    minNotional: filters.minNotional,
    minQty: filters.minQty,
    stepSize: filters.stepSize,
    tickSize: filters.tickSize
  }
}
