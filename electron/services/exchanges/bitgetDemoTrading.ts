import type { AccountBalance, LiveOrderResult } from './binanceTrading'
import type { OpenOrderOnExchange } from '../../../shared/reconcileLive'
import type { SymbolTradingRules } from '../../../shared/exchangeMinimums'
import { bitgetSigned, type BitgetCredentials, type BitgetRequest } from './bitgetAuth'
import { readBitgetAccount, readBitgetAccountSettings, readBitgetAssets, type BitgetAccountRead, type BitgetAccountSettings } from './bitgetAccount'
import * as orders from './bitgetOrders'

// BITGET, THE DEMO ACCOUNT (V7.1 Stages 7-8, 16 October 2026): the only module whose requests carry
// the demo header (bitgetAuth.ts, `demo: true`), and the only one that may, which a test pins.
// Bitget refuses a real key sent with it and a demo key sent without it, so a demo request from
// here can reach nothing real, and a real order can never come from this file. The paper
// laboratory and a person's demo executor place, query and cancel DEMO orders through here, in the
// demo book's own ledgers (electron/services/liveExecutionService.ts, book 'demo'); the order's
// shape is bitgetOrders.ts's, which signs nothing itself.
//
// Never log a key, a secret or a passphrase.

/** The demo signer: every request from this module. */
const demoSend =
  (credentials: BitgetCredentials): orders.BitgetSend =>
  <T,>(request: BitgetRequest): Promise<T> =>
    bitgetSigned<T>(credentials, request, true)

/** Reads the demo account: proves a demo key, its secret and its passphrase (bitgetAccount.ts, over
 * the demo signer). Places no order. */
export async function fetchBitgetDemoAssets(credentials: BitgetCredentials): Promise<AccountBalance[]> {
  return readBitgetAssets(demoSend(credentials), 'demo account read')
}

/** The same read, saying whether the balances came from the Classic endpoint. */
export async function fetchBitgetDemoAccount(credentials: BitgetCredentials): Promise<BitgetAccountRead> {
  return readBitgetAccount(demoSend(credentials), 'demo account read')
}

/** The demo account's settings: its mode. */
export async function fetchBitgetDemoAccountSettings(credentials: BitgetCredentials): Promise<BitgetAccountSettings> {
  return readBitgetAccountSettings(demoSend(credentials), 'demo account settings')
}

/** A demo buy of about `quoteAmount` in the quote currency, or a demo sell worth about it. */
export async function placeDemoMarketOrder(credentials: BitgetCredentials, symbol: string, side: 'BUY' | 'SELL', quoteAmount: number): Promise<LiveOrderResult> {
  return orders.placeMarketOrder(demoSend(credentials), symbol, side, quoteAmount)
}

export async function placeDemoMarketSellByQuantity(credentials: BitgetCredentials, symbol: string, quantity: number): Promise<LiveOrderResult> {
  return orders.placeMarketSellByQuantity(demoSend(credentials), symbol, quantity)
}

export async function placeDemoLimitOrder(credentials: BitgetCredentials, symbol: string, side: 'BUY' | 'SELL', quantity: number, price: number): Promise<LiveOrderResult> {
  return orders.placeLimitOrder(demoSend(credentials), symbol, side === 'SELL' ? 'sell' : 'buy', quantity, price)
}

export async function queryDemoOrder(credentials: BitgetCredentials, orderId: string | number): Promise<LiveOrderResult> {
  return orders.queryOrder(demoSend(credentials), orderId)
}

export async function cancelDemoOrder(credentials: BitgetCredentials, symbol: string, orderId: string | number): Promise<LiveOrderResult> {
  return orders.cancelOrder(demoSend(credentials), symbol, orderId)
}

export async function fetchDemoOpenOrders(credentials: BitgetCredentials): Promise<OpenOrderOnExchange[]> {
  return orders.fetchOpenOrders(demoSend(credentials))
}

/** The pair's rules, public data: the same on the demo account as on the real one. */
export async function fetchDemoSymbolRules(symbol: string): Promise<SymbolTradingRules> {
  const rules = await orders.symbolRules(symbol)
  return { minNotional: rules.minNotional, minQty: rules.minQty, stepSize: rules.stepSize, tickSize: rules.tickSize }
}
