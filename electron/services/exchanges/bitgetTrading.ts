import type { AccountBalance, LiveOrderResult } from './binanceTrading'
import type { OpenOrderOnExchange } from '../../../shared/reconcileLive'
import type { SymbolTradingRules } from '../../../shared/exchangeMinimums'
import { bitgetSigned, type BitgetCredentials, type BitgetRequest } from './bitgetAuth'
import { readBitgetAccount, readBitgetAccountSettings, readBitgetAssets, type BitgetAccountRead, type BitgetAccountSettings } from './bitgetAccount'
import * as orders from './bitgetOrders'

// BITGET, THE REAL ACCOUNT (V7.1 Stages 7 and 9, 16 October 2026): reading it over the user's own
// key, and placing, querying and cancelling REAL spot orders on it. Every request here is signed as
// a real request (bitgetAuth.ts): nothing in this file can reach the demo account, and a test pins
// that. Nothing in this file checks a safety gate: every caller goes through liveTradingService
// first, as Binance's do (liveExecutionService.ts, the real book's venue in exchanges/venues.ts),
// and an order is placed only by a person from the form -- the paper laboratory and every AI path
// are held off this file by tests/aiNoLivePath.test.ts. The order's shape is bitgetOrders.ts's, the
// account's reads bitgetAccount.ts's -- which read a CLASSIC account (one not upgraded to the unified
// account) over its own endpoint, while the orders below are the unified account's alone: a real order
// on a Classic account is refused before it is sent (liveExecutionService.ts assertAccountCanTrade).
//
// Never log a key, a secret or a passphrase.

/** The real signer: every request from this module. */
const realSend =
  (credentials: BitgetCredentials): orders.BitgetSend =>
  <T,>(request: BitgetRequest): Promise<T> =>
    bitgetSigned<T>(credentials, request, false)

/** Reads the real account: proves a key, its secret and its passphrase, and is what Live Trading
 * shows for Bitget. The unified account's balances, or a Classic account's over its own endpoint
 * (bitgetAccount.ts). Places no order. */
export async function fetchBitgetAssets(credentials: BitgetCredentials): Promise<AccountBalance[]> {
  return readBitgetAssets(realSend(credentials), 'account read')
}

/** The same read, saying whether the balances came from the Classic endpoint: what the key store
 * keeps of the account. */
export async function fetchBitgetAccount(credentials: BitgetCredentials): Promise<BitgetAccountRead> {
  return readBitgetAccount(realSend(credentials), 'account read')
}

/** The real account's settings: its mode, which says whether it is a unified account at all; a
 * Classic account, which refuses the read as such, is said to be CLASSIC. */
export async function fetchBitgetAccountSettings(credentials: BitgetCredentials): Promise<BitgetAccountSettings> {
  return readBitgetAccountSettings(realSend(credentials), 'account settings')
}

// REAL SPOT ORDERS (V7.1 Stage 9). Real money: every one of these is reached through the live gates
// alone (liveExecutionService.ts), never from this file's own initiative.

/** A real buy of about `quoteAmount` in the quote currency, or a real sell worth about it, filled at
 * the book's price or within a fifth of a percent of it, immediate or cancel. */
export async function placeBitgetMarketOrder(credentials: BitgetCredentials, symbol: string, side: 'BUY' | 'SELL', quoteAmount: number): Promise<LiveOrderResult> {
  return orders.placeMarketOrder(realSend(credentials), symbol, side, quoteAmount)
}

export async function placeBitgetMarketSellByQuantity(credentials: BitgetCredentials, symbol: string, quantity: number): Promise<LiveOrderResult> {
  return orders.placeMarketSellByQuantity(realSend(credentials), symbol, quantity)
}

export async function placeBitgetLimitOrder(credentials: BitgetCredentials, symbol: string, side: 'BUY' | 'SELL', quantity: number, price: number): Promise<LiveOrderResult> {
  return orders.placeLimitOrder(realSend(credentials), symbol, side === 'SELL' ? 'sell' : 'buy', quantity, price)
}

export async function queryBitgetOrder(credentials: BitgetCredentials, orderId: string | number): Promise<LiveOrderResult> {
  return orders.queryOrder(realSend(credentials), orderId)
}

export async function cancelBitgetOrder(credentials: BitgetCredentials, symbol: string, orderId: string | number): Promise<LiveOrderResult> {
  return orders.cancelOrder(realSend(credentials), symbol, orderId)
}

export async function fetchBitgetOpenOrders(credentials: BitgetCredentials): Promise<OpenOrderOnExchange[]> {
  return orders.fetchOpenOrders(realSend(credentials))
}

/** The pair's rules, public data, in the app's own shape (shared/exchangeMinimums.ts). */
export async function fetchBitgetTradingRules(symbol: string): Promise<SymbolTradingRules> {
  const rules = await orders.symbolRules(symbol)
  return { minNotional: rules.minNotional, minQty: rules.minQty, stepSize: rules.stepSize, tickSize: rules.tickSize }
}
