import { describe, expect, it, vi } from 'vitest'
import { TRADING_EXCHANGES, DEMO_EXCHANGES, canTradeDemoOn, canTradeOn } from '../shared/ipc'

// THE VENUES (electron/services/exchanges/venues.ts; V7.1 Stages 8-9): where an order goes by the
// exchange and the book, each venue bound to its own module and its own key slot -- Binance's real
// account, Bitget's real account, Bitget's demo account -- and nothing else.

const calls = vi.hoisted(() => ({ made: [] as string[] }))
vi.mock('../electron/services/exchanges/binanceTrading', () => ({
  placeMarketOrder: async (...args: unknown[]) => void calls.made.push(`binance.place ${args.slice(2).join(' ')}`),
  placeMarketSellByQuantity: async (...args: unknown[]) => void calls.made.push(`binance.sell ${args.slice(2).join(' ')}`),
  placeLimitOrder: async (...args: unknown[]) => void calls.made.push(`binance.limit ${args.slice(2).join(' ')}`),
  queryOrder: async (...args: unknown[]) => void calls.made.push(`binance.query ${args.slice(2).join(' ')}`),
  cancelOrder: async (...args: unknown[]) => void calls.made.push(`binance.cancel ${args.slice(2).join(' ')}`),
  fetchOpenOrders: async () => void calls.made.push('binance.open'),
  fetchSymbolRules: async (symbol: string) => void calls.made.push(`binance.rules ${symbol}`)
}))
vi.mock('../electron/services/exchanges/bitgetTrading', () => ({
  placeBitgetMarketOrder: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`bitget.place ${c.apiKey} ${args.join(' ')}`),
  placeBitgetMarketSellByQuantity: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`bitget.sell ${c.apiKey} ${args.join(' ')}`),
  placeBitgetLimitOrder: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`bitget.limit ${c.apiKey} ${args.join(' ')}`),
  queryBitgetOrder: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`bitget.query ${c.apiKey} ${args.join(' ')}`),
  cancelBitgetOrder: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`bitget.cancel ${c.apiKey} ${args.join(' ')}`),
  fetchBitgetOpenOrders: async (c: { apiKey: string }) => void calls.made.push(`bitget.open ${c.apiKey}`),
  fetchBitgetTradingRules: async (symbol: string) => void calls.made.push(`bitget.rules ${symbol}`)
}))
vi.mock('../electron/services/exchanges/bitgetDemoTrading', () => ({
  placeDemoMarketOrder: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`demo.place ${c.apiKey} ${args.join(' ')}`),
  placeDemoMarketSellByQuantity: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`demo.sell ${c.apiKey} ${args.join(' ')}`),
  placeDemoLimitOrder: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`demo.limit ${c.apiKey} ${args.join(' ')}`),
  queryDemoOrder: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`demo.query ${c.apiKey} ${args.join(' ')}`),
  cancelDemoOrder: async (c: { apiKey: string }, ...args: unknown[]) => void calls.made.push(`demo.cancel ${c.apiKey} ${args.join(' ')}`),
  fetchDemoOpenOrders: async (c: { apiKey: string }) => void calls.made.push(`demo.open ${c.apiKey}`),
  fetchDemoSymbolRules: async (symbol: string) => void calls.made.push(`demo.rules ${symbol}`)
}))

const { venueFor, venuesOf } = await import('../electron/services/exchanges/venues')

describe('the venues', () => {
  it("are Binance's real account, Bitget's real account and Bitget's demo account, each on its own key slot, and no other", () => {
    expect(venueFor('binance', 'real')).toMatchObject({ exchange: 'binance', book: 'real', slot: 'real', label: 'Binance' })
    expect(venueFor('bitget', 'real')).toMatchObject({ exchange: 'bitget', book: 'real', slot: 'real', label: 'Bitget' })
    expect(venueFor('bitget', 'demo')).toMatchObject({ exchange: 'bitget', book: 'demo', slot: 'demo', label: 'Bitget demo' })
    expect(venueFor('binance', 'demo')).toBeNull()
    expect(venueFor('upbit', 'real')).toBeNull()
    expect(venuesOf('real').map((venue) => venue.exchange)).toEqual(['binance', 'bitget'])
    expect(venuesOf('demo').map((venue) => venue.exchange)).toEqual(['bitget'])
    // The lists the gates read agree with the venues.
    expect(TRADING_EXCHANGES).toEqual(['binance', 'bitget'])
    expect(DEMO_EXCHANGES).toEqual(['bitget'])
    expect(canTradeOn('bitget')).toBe(true)
    expect(canTradeOn('upbit')).toBe(false)
    expect(canTradeDemoOn('binance')).toBe(false)
  })

  it('hands each call to its own module with the key it was given, the real one never to the demo module nor the demo one to the real', async () => {
    const credentials = { apiKey: 'k', apiSecret: 's', passphrase: 'p' }
    const real = venueFor('bitget', 'real')!
    await real.placeMarketOrder(credentials, 'BTCUSDT', 'BUY', 25)
    await real.placeMarketSellByQuantity(credentials, 'BTCUSDT', 0.001)
    await real.placeLimitOrder(credentials, 'BTCUSDT', 'SELL', 0.001, 90000)
    await real.queryOrder(credentials, 'BTCUSDT', '77')
    await real.cancelOrder(credentials, 'BTCUSDT', '77')
    await real.fetchOpenOrders(credentials)
    await real.fetchSymbolRules('BTCUSDT')
    const demo = venueFor('bitget', 'demo')!
    await demo.placeMarketOrder({ ...credentials, apiKey: 'dk' }, 'ETHUSDT', 'BUY', 10)
    await demo.queryOrder({ ...credentials, apiKey: 'dk' }, 'ETHUSDT', '9')
    const binance = venueFor('binance', 'real')!
    await binance.placeMarketOrder(credentials, 'SOLUSDT', 'BUY', 30)
    await binance.queryOrder(credentials, 'SOLUSDT', '12345')
    expect(calls.made).toEqual([
      'bitget.place k BTCUSDT BUY 25',
      'bitget.sell k BTCUSDT 0.001',
      'bitget.limit k BTCUSDT SELL 0.001 90000',
      'bitget.query k 77',
      'bitget.cancel k BTCUSDT 77',
      'bitget.open k',
      'bitget.rules BTCUSDT',
      'demo.place dk ETHUSDT BUY 10',
      'demo.query dk 9',
      'binance.place SOLUSDT BUY 30',
      // Binance numbers its orders: the id goes over as a number.
      'binance.query SOLUSDT 12345'
    ])
  })
})
