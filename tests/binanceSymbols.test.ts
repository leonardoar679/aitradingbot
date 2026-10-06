import { beforeEach, describe, expect, it, vi } from 'vitest'

// What the app takes from Binance's list of pairs.

const { binanceAdapter, resetResolvedEndpoints } = await import('../electron/services/exchanges/binance')

/** The listing as Binance serves it, cut to what is read. The tokens that track a stock are kept in
 * a trading group of their own; a coin's name can end in "B" as theirs all do. */
const LISTING = {
  symbols: [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', permissionSets: [['SPOT', 'MARGIN', 'TRD_GRP_004', 'TRD_GRP_015']] },
    { symbol: 'SNDKBUSDT', baseAsset: 'SNDKB', quoteAsset: 'USDT', status: 'TRADING', permissionSets: [['SPOT', 'MARGIN', 'TRD_GRP_004', 'TRD_GRP_261']] },
    { symbol: 'SHIBUSDT', baseAsset: 'SHIB', quoteAsset: 'USDT', status: 'TRADING', permissionSets: [['SPOT', 'MARGIN', 'TRD_GRP_004']] },
    { symbol: 'HALTBUSDT', baseAsset: 'HALTB', quoteAsset: 'USDT', status: 'BREAK', permissionSets: [['SPOT', 'TRD_GRP_261']] },
    // A listing served without the groups says nothing about them.
    { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' }
  ]
}

beforeEach(() => {
  resetResolvedEndpoints()
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', (url: string) => {
    const body = String(url).includes('/exchangeInfo') ? LISTING : [[1, '1', '1', '1', '1', '1']]
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) })
  })
})

describe("Binance's list of pairs", () => {
  it('marks a stock token by the trading group Binance keeps them in, and no other pair', async () => {
    expect(await binanceAdapter.listSymbols()).toEqual([
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
      { symbol: 'SNDKBUSDT', baseAsset: 'SNDKB', quoteAsset: 'USDT', stockToken: true },
      { symbol: 'SHIBUSDT', baseAsset: 'SHIB', quoteAsset: 'USDT' },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' }
    ])
  })
})
