import type { CredentialSlot, Exchange, TradingBook } from '../../../shared/ipc'
import type { SymbolTradingRules } from '../../../shared/exchangeMinimums'
import type { OpenOrderOnExchange } from '../../../shared/reconcileLive'
import * as binance from './binanceTrading'
import * as bitget from './bitgetTrading'
import * as bitgetDemo from './bitgetDemoTrading'
import type { LiveOrderResult } from './binanceTrading'

// THE VENUES (V7.1 Stages 8-9, 16 October 2026): where an order on an exchange goes, by the exchange
// and the book -- Binance's real account, Bitget's real account (Stage 9), Bitget's demo account --
// each with the same handful of calls, so that the ledgers, the watchers, the poll and the
// reconciliation (liveExecutionService.ts and its neighbours) are written once and the book they
// act on is a parameter. A venue does not check a gate: the real book's callers do, before the
// call, as they always have; the demo book has none, being play money.

export interface VenueCredentials {
  apiKey: string
  apiSecret: string
  /** Empty where the exchange sets none. */
  passphrase: string
}

export interface TradingVenue {
  exchange: Exchange
  book: TradingBook
  /** Which stored key signs for it. */
  slot: CredentialSlot
  /** How a person reads it. */
  label: string
  placeMarketOrder(credentials: VenueCredentials, symbol: string, side: 'BUY' | 'SELL', quoteAmount: number): Promise<LiveOrderResult>
  placeMarketSellByQuantity(credentials: VenueCredentials, symbol: string, quantity: number): Promise<LiveOrderResult>
  placeLimitOrder(credentials: VenueCredentials, symbol: string, side: 'BUY' | 'SELL', quantity: number, price: number): Promise<LiveOrderResult>
  queryOrder(credentials: VenueCredentials, symbol: string, orderId: number | string): Promise<LiveOrderResult>
  cancelOrder(credentials: VenueCredentials, symbol: string, orderId: number | string): Promise<LiveOrderResult>
  fetchOpenOrders(credentials: VenueCredentials): Promise<OpenOrderOnExchange[]>
  fetchSymbolRules(symbol: string): Promise<SymbolTradingRules>
}

const binanceReal: TradingVenue = {
  exchange: 'binance',
  book: 'real',
  slot: 'real',
  label: 'Binance',
  placeMarketOrder: (c, symbol, side, quoteAmount) => binance.placeMarketOrder(c.apiKey, c.apiSecret, symbol, side, quoteAmount),
  placeMarketSellByQuantity: (c, symbol, quantity) => binance.placeMarketSellByQuantity(c.apiKey, c.apiSecret, symbol, quantity),
  placeLimitOrder: (c, symbol, side, quantity, price) => binance.placeLimitOrder(c.apiKey, c.apiSecret, symbol, side, quantity, price),
  queryOrder: (c, symbol, orderId) => binance.queryOrder(c.apiKey, c.apiSecret, symbol, Number(orderId)),
  cancelOrder: (c, symbol, orderId) => binance.cancelOrder(c.apiKey, c.apiSecret, symbol, Number(orderId)),
  fetchOpenOrders: (c) => binance.fetchOpenOrders(c.apiKey, c.apiSecret),
  fetchSymbolRules: (symbol) => binance.fetchSymbolRules(symbol)
}

/** Bitget's real account (Stage 9): real money, under every live gate, as Binance's. */
const bitgetReal: TradingVenue = {
  exchange: 'bitget',
  book: 'real',
  slot: 'real',
  label: 'Bitget',
  placeMarketOrder: (c, symbol, side, quoteAmount) => bitget.placeBitgetMarketOrder(c, symbol, side, quoteAmount),
  placeMarketSellByQuantity: (c, symbol, quantity) => bitget.placeBitgetMarketSellByQuantity(c, symbol, quantity),
  placeLimitOrder: (c, symbol, side, quantity, price) => bitget.placeBitgetLimitOrder(c, symbol, side, quantity, price),
  queryOrder: (c, _symbol, orderId) => bitget.queryBitgetOrder(c, orderId),
  cancelOrder: (c, symbol, orderId) => bitget.cancelBitgetOrder(c, symbol, orderId),
  fetchOpenOrders: (c) => bitget.fetchBitgetOpenOrders(c),
  fetchSymbolRules: (symbol) => bitget.fetchBitgetTradingRules(symbol)
}

const bitgetDemoVenue: TradingVenue = {
  exchange: 'bitget',
  book: 'demo',
  slot: 'demo',
  label: 'Bitget demo',
  placeMarketOrder: (c, symbol, side, quoteAmount) => bitgetDemo.placeDemoMarketOrder(c, symbol, side, quoteAmount),
  placeMarketSellByQuantity: (c, symbol, quantity) => bitgetDemo.placeDemoMarketSellByQuantity(c, symbol, quantity),
  placeLimitOrder: (c, symbol, side, quantity, price) => bitgetDemo.placeDemoLimitOrder(c, symbol, side, quantity, price),
  queryOrder: (c, _symbol, orderId) => bitgetDemo.queryDemoOrder(c, orderId),
  cancelOrder: (c, symbol, orderId) => bitgetDemo.cancelDemoOrder(c, symbol, orderId),
  fetchOpenOrders: (c) => bitgetDemo.fetchDemoOpenOrders(c),
  fetchSymbolRules: (symbol) => bitgetDemo.fetchDemoSymbolRules(symbol)
}

const VENUES: TradingVenue[] = [binanceReal, bitgetReal, bitgetDemoVenue]

/** The venue for an exchange and a book, or null where this app has none: Binance's demo (it has
 * no demo account), every other exchange. */
export function venueFor(exchange: Exchange, book: TradingBook): TradingVenue | null {
  return VENUES.find((venue) => venue.exchange === exchange && venue.book === book) ?? null
}

/** The venues of a book, for the loops that look at every ledger of it. */
export function venuesOf(book: TradingBook): TradingVenue[] {
  return VENUES.filter((venue) => venue.book === book)
}
