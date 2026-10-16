import type { AccountBalance, LiveOrderResult } from './binanceTrading'
import type { OpenOrderOnExchange } from '../../../shared/reconcileLive'
import type { SymbolTradingRules } from '../../../shared/exchangeMinimums'
import { bitgetSigned, type BitgetCredentials, type BitgetRequest } from './bitgetAuth'
import * as orders from './bitgetOrders'

// BITGET, THE REAL ACCOUNT (V7.1 Stages 7 and 9, 16 October 2026): reading it over the user's own
// key, and placing, querying and cancelling REAL spot orders on it. Every request here is signed as
// a real request (bitgetAuth.ts): nothing in this file can reach the demo account, and a test pins
// that. Nothing in this file checks a safety gate: every caller goes through liveTradingService
// first, as Binance's do (liveExecutionService.ts, the real book's venue in exchanges/venues.ts),
// and an order is placed only by a person from the form -- the paper laboratory and every AI path
// are held off this file by tests/aiNoLivePath.test.ts. The order's shape is bitgetOrders.ts's.
//
// Never log a key, a secret or a passphrase.

/** The real signer: every request from this module. */
const realSend =
  (credentials: BitgetCredentials): orders.BitgetSend =>
  <T,>(request: BitgetRequest): Promise<T> =>
    bitgetSigned<T>(credentials, request, false)

/** One coin's row in the unified account, as /api/v3/account/assets gives it. */
interface CoinAsset {
  coin: string
  available: string
  locked: string
  equity?: string
  usdValue?: string
}

interface AccountAssets {
  accountEquity?: string
  usdtEquity?: string
  assets?: CoinAsset[]
}

/** The unified account's settings; `accountMode` is UNION or ISOLATED on a unified account and
 * CLASSIC on one not upgraded. */
export interface BitgetAccountSettings {
  accountMode: string
  assetMode?: string
  holdMode?: string
}

export type BitgetAccountType = 'uta' | 'classic' | 'unknown'

/** What an account's mode says it is: a unified account in either of its modes, a classic one, or
 * a mode this app does not know. A classic account is read-only in this app: its orders would go to
 * another API. */
export function bitgetAccountTypeOf(accountMode: string | null | undefined): BitgetAccountType {
  const mode = (accountMode ?? '').toUpperCase()
  if (mode === 'UNION' || mode === 'ISOLATED') return 'uta'
  if (mode === 'CLASSIC') return 'classic'
  return 'unknown'
}

/** The balances as the app shows them: a coin's spendable amount and what its resting orders hold.
 * A row that cannot be read becomes NaN and is reported by name (readableBalances), never as nought. */
export function balancesOf(data: AccountAssets | null | undefined): AccountBalance[] {
  if (!Array.isArray(data?.assets)) throw new Error('Bitget returned an account response without an asset list')
  return data.assets.map((row) => ({ asset: row.coin, free: Number(row.available), locked: Number(row.locked) }))
}

/** Reads the real account: proves a key, its secret and its passphrase, and is what Live Trading
 * shows for Bitget. Places no order. */
export async function fetchBitgetAssets(credentials: BitgetCredentials): Promise<AccountBalance[]> {
  return balancesOf(await realSend(credentials)<AccountAssets>({ method: 'GET', path: '/api/v3/account/assets', what: 'account read' }))
}

/** The real account's settings: its mode, which says whether it is a unified account at all. */
export async function fetchBitgetAccountSettings(credentials: BitgetCredentials): Promise<BitgetAccountSettings> {
  const data = await realSend(credentials)<BitgetAccountSettings>({ method: 'GET', path: '/api/v3/account/settings', what: 'account settings' })
  return { accountMode: String(data?.accountMode ?? ''), ...(data?.assetMode === undefined ? {} : { assetMode: data.assetMode }), ...(data?.holdMode === undefined ? {} : { holdMode: data.holdMode }) }
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
