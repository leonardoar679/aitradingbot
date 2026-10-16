import type { LiveOrderResult } from './binanceTrading'
import type { OpenOrderOnExchange } from '../../../shared/reconcileLive'
import type { Commissions } from '../../../shared/observedFee'
import type { BitgetRequest } from './bitgetAuth'
import { fetchBitgetBook, fetchBitgetSymbolRules, type BitgetSymbolRules } from './bitget'

// BITGET SPOT ORDERS, THE SHAPE OF THEM (V7.1 Stage 8, 16 October 2026): how an order is placed,
// asked about and cancelled on the unified account (UTA, v3), and how its answers are read into
// what the app's ledgers keep -- written once here and used by both the demo module and the real
// one, each of which brings its own signer (`send`). This file signs nothing and chooses no
// account: it builds requests and reads answers.
//
// A "MARKET" ORDER IS A MARKETABLE LIMIT ORDER THAT FILLS OR DIES. Bitget's own market order is
// sized in a currency that differs by side and by venue, and its documentation could not be read
// from here on 16 October 2026; a limit order a fifth of a percent through the book, immediate or
// cancel, is sized in the base coin on either side, fills at the book's price like a market order,
// and can never fill further from the book than the cap -- which a market order into a thin book
// can. What did not fill at the cap is cancelled by the exchange, not left resting.

export const BITGET_ORDER_PATHS = {
  place: '/api/v3/trade/place-order',
  cancel: '/api/v3/trade/cancel-order',
  detail: '/api/v3/trade/order-info',
  open: '/api/v3/trade/unfilled-orders',
  fills: '/api/v3/trade/fills'
} as const

/** How far through the book a marketable order may fill, as a share of the best price. */
export const MARKETABLE_CAP = 0.002
/** How many times a just-placed immediate-or-cancel order is asked about before it is taken as
 * still open: the exchange answers the placement before the match is written. */
const SETTLE_READS = 4
const SETTLE_WAIT_MS = 300

export type BitgetSend = <T>(request: BitgetRequest) => Promise<T>

export interface OrderRef {
  orderId: string
  clientOid: string
}

/** Bitget's order as /api/v3/trade/order-info and unfilled-orders give it (strings throughout). */
export interface BitgetOrder {
  orderId: string
  clientOid?: string
  symbol: string
  side: string
  orderType?: string
  price?: string
  qty?: string
  cumExecQty?: string
  cumExecValue?: string
  avgPrice?: string
  orderStatus: string
  feeDetail?: { feeCoin: string; fee: string }[] | null
  createdTime?: string
  updatedTime?: string
}

/** Bitget's status in Binance's words, which the ledgers' resolution reads
 * (shared/userStream.ts resolvedOrderStatus): live and new rest, partially_filled rests with a
 * fill, filled is done, cancelled is done with what filled. */
export function binanceStatusOf(orderStatus: string): string {
  switch (orderStatus.toLowerCase()) {
    case 'filled':
      return 'FILLED'
    case 'cancelled':
    case 'canceled':
      return 'CANCELED'
    case 'partially_filled':
      return 'PARTIALLY_FILLED'
    case 'live':
    case 'new':
      return 'NEW'
    default:
      return orderStatus.toUpperCase()
  }
}

/** The fees as the app keeps them: by coin, as positive amounts. */
export function commissionsOf(feeDetail: BitgetOrder['feeDetail']): Commissions {
  const out: Commissions = {}
  for (const entry of feeDetail ?? []) {
    const fee = Math.abs(Number(entry.fee))
    if (!Number.isFinite(fee) || fee === 0) continue
    out[entry.feeCoin] = (out[entry.feeCoin] ?? 0) + fee
  }
  return out
}

/** An order's answer in the ledgers' shape. The average price is read as given, else as the value
 * over the quantity; a fill that cannot be read becomes NaN, which the ledger refuses by name. */
export function orderResultOf(order: BitgetOrder): LiveOrderResult {
  const filledQty = Number(order.cumExecQty ?? '0')
  const value = Number(order.cumExecValue ?? '0')
  const given = Number(order.avgPrice ?? '')
  const avgFillPrice = filledQty > 0 ? (Number.isFinite(given) && given > 0 ? given : value / filledQty) : 0
  return {
    orderId: String(order.orderId),
    status: binanceStatusOf(order.orderStatus),
    filledQty,
    avgFillPrice,
    cummulativeQuoteQty: Number.isFinite(value) ? value : filledQty * avgFillPrice,
    commissions: commissionsOf(order.feeDetail)
  }
}

export function openOrderOf(order: BitgetOrder): OpenOrderOnExchange {
  return {
    orderId: String(order.orderId),
    symbol: String(order.symbol),
    side: String(order.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
    status: binanceStatusOf(order.orderStatus),
    origQty: Number(order.qty ?? '0'),
    executedQty: Number(order.cumExecQty ?? '0'),
    price: Number(order.price ?? '0'),
    placedAt: Math.floor(Number(order.createdTime ?? '0') / 1000)
  }
}

/** The order-info answer is one order, given as an object or as a list of one. */
function oneOrder(data: unknown): BitgetOrder | null {
  if (Array.isArray(data)) return (data[0] as BitgetOrder | undefined) ?? null
  if (data !== null && typeof data === 'object' && 'orderId' in (data as Record<string, unknown>)) return data as BitgetOrder
  return null
}

const decimalsOf = (step: string): number => (step.includes('.') ? step.split('.')[1].length : 0)

/** A quantity floored onto its step, as a string the exchange reads. Floored, never rounded up: a
 * sell of more than the ledger holds is refused by the exchange, and a buy of more than the money
 * covers is too. */
export function floorToStep(value: number, step: string): string {
  const places = decimalsOf(step)
  const factor = 10 ** places
  // A hair added before the floor: 0.1 * 3 is 0.30000000000000004 and 0.29 * 100 is 28.999999999999996.
  return (Math.floor(value * factor + 1e-9) / factor).toFixed(places)
}

export function ceilToStep(value: number, step: string): string {
  const places = decimalsOf(step)
  const factor = 10 ** places
  return (Math.ceil(value * factor - 1e-9) / factor).toFixed(places)
}

/** A client order id of this app's, unique to the attempt: what a placement that timed out is
 * asked about by, so that one order is never placed twice. */
export function clientOidOf(now = Date.now()): string {
  return `ts${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

interface PlaceBody {
  category: 'SPOT'
  symbol: string
  side: 'buy' | 'sell'
  orderType: 'limit' | 'market'
  qty: string
  price?: string
  timeInForce: 'gtc' | 'ioc'
  clientOid: string
}

async function placeAndRead(send: BitgetSend, body: PlaceBody): Promise<LiveOrderResult> {
  let ref: OrderRef
  try {
    ref = await send<OrderRef>({ method: 'POST', path: BITGET_ORDER_PATHS.place, body: { ...body }, what: `place ${body.side} ${body.symbol}` })
  } catch (error) {
    // The placement may have reached the exchange and its answer not reached here: the order is
    // asked about by the client id before the attempt is given up as a failure.
    const found = await queryOrderByClientOid(send, body.clientOid).catch(() => null)
    if (found === null) throw error
    return found
  }
  return settledResult(send, ref.orderId, body.timeInForce === 'ioc')
}

/** The order as it stands once the exchange has written its match: an immediate-or-cancel order
 * is read again a few times while the exchange still shows it open. */
async function settledResult(send: BitgetSend, orderId: string, immediate: boolean): Promise<LiveOrderResult> {
  let result = await queryOrder(send, orderId)
  for (let read = 1; immediate && read < SETTLE_READS && (result.status === 'NEW' || result.status === 'PARTIALLY_FILLED'); read++) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
    result = await queryOrder(send, orderId)
  }
  return result
}

/** A buy of about `quoteAmount` in the quote currency, filled at the book's price or within the
 * cap of it, immediate or cancel. Refused where nothing filled: a market that moved past the cap,
 * a book too thin, an amount under the pair's minimum. */
export async function placeMarketBuy(send: BitgetSend, symbol: string, quoteAmount: number): Promise<LiveOrderResult> {
  if (!(quoteAmount > 0)) throw new Error(`A quote amount of ${quoteAmount} is not an order this app will send to an exchange.`)
  const upper = symbol.toUpperCase()
  const [rules, book] = await Promise.all([fetchBitgetSymbolRules(upper), fetchBitgetBook(upper, 5)])
  const ask = book.asks[0]?.[0]
  if (!(ask !== undefined && ask > 0)) throw new Error(`Bitget shows no ask on ${upper}: nothing to buy against.`)
  if (rules.minNotional > 0 && quoteAmount < rules.minNotional) throw new Error(`Bitget will not accept a ${upper} order below ${rules.minNotional} in the quote currency; ${quoteAmount} is less.`)
  const cap = Number(ceilToStep(ask * (1 + MARKETABLE_CAP), rules.tickSize))
  const qty = floorToStep(quoteAmount / cap, rules.stepSize)
  if (!(Number(qty) > 0)) throw new Error(`${quoteAmount} buys less than one step (${rules.stepSize}) of ${upper} at ${cap}.`)
  const result = await placeAndRead(send, { category: 'SPOT', symbol: upper, side: 'buy', orderType: 'limit', qty, price: String(cap), timeInForce: 'ioc', clientOid: clientOidOf() })
  if (!(result.filledQty > 0)) throw new Error(`The ${upper} buy did not fill within ${(MARKETABLE_CAP * 100).toFixed(1)}% of the book (${result.status}): nothing was bought.`)
  return result
}

/** A sell of `quantity` in the base coin at the book's price or within the cap of it, immediate
 * or cancel. Refused where nothing filled. */
export async function placeMarketSellByQuantity(send: BitgetSend, symbol: string, quantity: number): Promise<LiveOrderResult> {
  const upper = symbol.toUpperCase()
  const [rules, book] = await Promise.all([fetchBitgetSymbolRules(upper), fetchBitgetBook(upper, 5)])
  const bid = book.bids[0]?.[0]
  if (!(bid !== undefined && bid > 0)) throw new Error(`Bitget shows no bid on ${upper}: nothing to sell into.`)
  const qty = floorToStep(quantity, rules.stepSize)
  if (!(Number(qty) > 0)) throw new Error(`Position size ${quantity} is below ${upper}'s minimum tradable increment (${rules.stepSize}) and cannot be sold.`)
  const floor = Number(floorToStep(bid * (1 - MARKETABLE_CAP), rules.tickSize))
  const result = await placeAndRead(send, { category: 'SPOT', symbol: upper, side: 'sell', orderType: 'limit', qty, price: String(floor), timeInForce: 'ioc', clientOid: clientOidOf() })
  if (!(result.filledQty > 0)) throw new Error(`The ${upper} sell did not fill within ${(MARKETABLE_CAP * 100).toFixed(1)}% of the book (${result.status}): nothing was sold.`)
  return result
}

/** A buy of about `quoteAmount`, or a sell worth about it at the book's bid: the app's market order
 * is sized in the quote currency on either side (binanceTrading.ts placeMarketOrder). */
export async function placeMarketOrder(send: BitgetSend, symbol: string, side: 'BUY' | 'SELL', quoteAmount: number): Promise<LiveOrderResult> {
  if (side === 'BUY') return placeMarketBuy(send, symbol, quoteAmount)
  if (!(quoteAmount > 0)) throw new Error(`A quote amount of ${quoteAmount} is not an order this app will send to an exchange.`)
  const book = await fetchBitgetBook(symbol.toUpperCase(), 5)
  const bid = book.bids[0]?.[0]
  if (!(bid !== undefined && bid > 0)) throw new Error(`Bitget shows no bid on ${symbol.toUpperCase()}: nothing to sell into.`)
  return placeMarketSellByQuantity(send, symbol, quoteAmount / bid)
}

/** A resting limit order, good till cancelled. */
export async function placeLimitOrder(send: BitgetSend, symbol: string, side: 'buy' | 'sell', quantity: number, price: number): Promise<LiveOrderResult> {
  const upper = symbol.toUpperCase()
  const rules = await fetchBitgetSymbolRules(upper)
  const qty = floorToStep(quantity, rules.stepSize)
  const limit = floorToStep(price, rules.tickSize)
  if (!(Number(qty) > 0)) throw new Error(`Quantity ${quantity} is below ${upper}'s minimum tradable increment (${rules.stepSize}).`)
  if (!(Number(limit) > 0)) throw new Error(`Price ${price} is below ${upper}'s tick (${rules.tickSize}).`)
  if (rules.minNotional > 0 && Number(qty) * Number(limit) < rules.minNotional) throw new Error(`Bitget will not accept a ${upper} order below ${rules.minNotional} in the quote currency.`)
  return placeAndRead(send, { category: 'SPOT', symbol: upper, side, orderType: 'limit', qty, price: limit, timeInForce: 'gtc', clientOid: clientOidOf() })
}

export async function queryOrder(send: BitgetSend, orderId: string | number): Promise<LiveOrderResult> {
  const data = await send<unknown>({ method: 'GET', path: BITGET_ORDER_PATHS.detail, query: { category: 'SPOT', orderId: String(orderId) }, what: `order ${orderId}` })
  const order = oneOrder(data)
  if (order === null) throw new Error(`Bitget returned no order for ${orderId}`)
  return orderResultOf(order)
}

export async function queryOrderByClientOid(send: BitgetSend, clientOid: string): Promise<LiveOrderResult | null> {
  const data = await send<unknown>({ method: 'GET', path: BITGET_ORDER_PATHS.detail, query: { category: 'SPOT', clientOid }, what: `order ${clientOid}` })
  const order = oneOrder(data)
  return order === null ? null : orderResultOf(order)
}

/** Cancels a resting order and reads what had filled before: the cancel's own answer names the
 * order and nothing more. An order already done is read as it is, not refused. */
export async function cancelOrder(send: BitgetSend, symbol: string, orderId: string | number): Promise<LiveOrderResult> {
  try {
    await send<OrderRef>({ method: 'POST', path: BITGET_ORDER_PATHS.cancel, body: { category: 'SPOT', symbol: symbol.toUpperCase(), orderId: String(orderId) }, what: `cancel ${orderId}` })
  } catch (error) {
    const current = await queryOrder(send, orderId).catch(() => null)
    if (current === null || current.status === 'NEW' || current.status === 'PARTIALLY_FILLED') throw error
    return current
  }
  return queryOrder(send, orderId)
}

export async function fetchOpenOrders(send: BitgetSend): Promise<OpenOrderOnExchange[]> {
  const data = await send<{ list?: BitgetOrder[] } | BitgetOrder[]>({ method: 'GET', path: BITGET_ORDER_PATHS.open, query: { category: 'SPOT' }, what: 'open orders' })
  const rows = Array.isArray(data) ? data : (data?.list ?? [])
  return rows.map(openOrderOf)
}

/** The rules in the app's own shape (shared/exchangeMinimums.ts). */
export async function symbolRules(symbol: string): Promise<BitgetSymbolRules> {
  return fetchBitgetSymbolRules(symbol)
}
