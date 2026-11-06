import { beforeEach, describe, expect, it, vi } from 'vitest'

// THE PERPETUALS' PUBLIC MARKET DATA (electron/services/perpMarketService.ts; V8 Stage 6): the USDT perpetuals each
// venue lists, bars a page at a time (Binance's costed by its size), the funding published, and the worse of a market
// buy's and sell's impact at a stake -- public reads only, each host through its budget.

vi.mock('../electron/services/httpPacing', () => ({ binanceFuturesBudget: { spend: async () => undefined }, binanceFundingBudget: { take: async () => undefined }, bitgetMarketBudget: { take: async () => undefined } }))

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status })

async function market(answer: (url: URL) => Response) {
  vi.resetModules()
  const module = await import('../electron/services/perpMarketService')
  const urls: URL[] = []
  const weights: number[] = []
  Object.assign(module.perpMarketSeam, {
    fetch: async (raw: string) => {
      const url = new URL(raw)
      urls.push(url)
      return answer(url)
    },
    spendBinance: async (weight: number) => void weights.push(weight),
    takeBinanceFunding: async () => undefined,
    takeBitget: async () => undefined
  })
  return { module, urls, weights }
}

const kline = (timeSec: number, close: number): unknown[] => [timeSec * 1000, String(close), String(close), String(close), String(close), '1', timeSec * 1000 + 59_999]

beforeEach(() => vi.restoreAllMocks())

describe('the perpetuals listed', () => {
  it("are Binance's USDT perpetuals trading now and Bitget's normal ones, read once in six hours", async () => {
    const { module, urls } = await market((url) =>
      url.host === 'fapi.binance.com'
        ? json({
            symbols: [
              { symbol: 'BTCUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING' },
              { symbol: 'BTCUSDT_261225', contractType: 'CURRENT_QUARTER', quoteAsset: 'USDT', status: 'TRADING' },
              { symbol: 'ETHBUSD', contractType: 'PERPETUAL', quoteAsset: 'BUSD', status: 'TRADING' },
              { symbol: 'OLDUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'SETTLING' }
            ]
          })
        : json({ code: '00000', data: [{ symbol: 'ABCUSDT', symbolStatus: 'normal' }, { symbol: 'GONEUSDT', symbolStatus: 'off' }] })
    )
    expect([...(await module.perpSymbols('binance'))]).toEqual(['BTCUSDT'])
    expect([...(await module.perpSymbols('bitget'))]).toEqual(['ABCUSDT'])
    await module.perpSymbols('binance')
    expect(urls).toHaveLength(2)
    expect(urls[1].searchParams.get('productType')).toBe('usdt-futures')
  })
})

describe('bars', () => {
  it("are read from Binance a page of up to 1,500 at a time, each page costed by its size, until a short page", async () => {
    const step = 60
    const from = 1_790_000_000 - (1_790_000_000 % 60)
    const { module, urls, weights } = await market((url) => {
      const start = Number(url.searchParams.get('startTime')) / 1000
      const limit = Number(url.searchParams.get('limit'))
      const end = Number(url.searchParams.get('endTime')) / 1000
      const rows: unknown[][] = []
      for (let t = start; t < Math.min(end, from + 2000 * step) && rows.length < limit; t += step) rows.push(kline(t, t))
      return json(rows)
    })
    // A span of 5,000 minutes, of which the venue has 2,000: a short page ends it.
    const bars = await module.perpBars('binance', 'BTCUSDT', '1m', from, from + 5000 * step)
    expect(bars).toHaveLength(2000)
    expect(bars[0]).toEqual({ time: from, open: from, high: from, low: from, close: from, volume: 1 })
    expect(urls.map((url) => [url.pathname, url.searchParams.get('limit')])).toEqual([
      ['/fapi/v1/klines', '1500'],
      ['/fapi/v1/klines', '1500']
    ])
    expect(weights).toEqual([10, 10])
    expect(module.binanceKlinesWeight(17)).toBe(1)
    expect(module.binanceKlinesWeight(200)).toBe(2)
    expect(module.binanceKlinesWeight(1000)).toBe(5)
  })

  it("are read from Binance once from a perpetual's listing where the span begins before it", async () => {
    const step = 60
    const from = 1_790_000_000 - (1_790_000_000 % 60)
    const listed = from + 4000 * step
    const { module, urls } = await market((url) => {
      const start = Number(url.searchParams.get('startTime')) / 1000
      const limit = Number(url.searchParams.get('limit'))
      const end = Number(url.searchParams.get('endTime')) / 1000
      // Binance gives the first bars at or after the start: from before the listing, those from the listing on.
      const rows: unknown[][] = []
      for (let t = Math.max(start, listed); t <= end && t < listed + 2000 * step && rows.length < limit; t += step) rows.push(kline(t, t))
      return json(rows)
    })
    const bars = await module.perpBars('binance', 'BTCUSDT', '1m', from, from + 9000 * step)
    expect(bars).toHaveLength(2000)
    expect(bars[0].time).toBe(listed)
    // The first page gives the listing's first 1,500 minutes, and the next starts past them.
    expect(urls.map((url) => Number(url.searchParams.get('startTime')) / 1000)).toEqual([from, listed + 1500 * step])
  })

  it('are read from Bitget 200 at a time over the whole span, in its granularity', async () => {
    const from = 1_790_000_000 - (1_790_000_000 % 3600)
    const { module, urls } = await market((url) => {
      const start = Number(url.searchParams.get('startTime')) / 1000
      return json({ code: '00000', data: Array.from({ length: 200 }, (_, k) => kline(start + k * 3600, 1 + k)) })
    })
    const bars = await module.perpBars('bitget', 'ABCUSDT', '1h', from, from + 450 * 3600)
    expect(bars).toHaveLength(450)
    expect(urls.map((url) => url.searchParams.get('granularity'))).toEqual(['1H', '1H', '1H'])
    expect(urls.map((url) => Number(url.searchParams.get('startTime')) / 1000 - from)).toEqual([0, 200 * 3600, 400 * 3600])
  })
})

describe('funding and the book', () => {
  it("reads Binance's funding a thousand at a time from the span's start, and Bitget's newest first until past it", async () => {
    const binance = await market((url) => {
      const start = Number(url.searchParams.get('startTime'))
      return json(start === 0 ? Array.from({ length: 1000 }, (_, k) => ({ fundingTime: (k + 1) * 1000, fundingRate: '0.0001' })) : [{ fundingTime: 1_001_000, fundingRate: '-0.0002' }])
    })
    const rates = await binance.module.perpFunding('binance', 'BTCUSDT', 0, 2000)
    expect(rates).toHaveLength(1001)
    expect(rates[1000]).toEqual({ timeSec: 1001, rate: -0.0002 })
    expect(binance.urls.map((url) => url.searchParams.get('startTime'))).toEqual(['0', '1000001'])
    const bitget = await market((url) => {
      const page = Number(url.searchParams.get('pageNo'))
      const newest = 100_000 - (page - 1) * 100 * 28_800
      return json({ code: '00000', data: Array.from({ length: 100 }, (_, k) => ({ fundingTime: String((newest - k * 28_800) * 1000), fundingRate: '0.0001' })) })
    })
    const back = await bitget.module.perpFunding('bitget', 'ABCUSDT', 100_000 - 150 * 28_800, 100_000)
    expect(bitget.urls).toHaveLength(2)
    expect(back.length).toBe(152)
  })

  it('reads the worse of a market buy and a market sell at the stake, and null where the book does not hold it', async () => {
    const { module } = await market(() =>
      json({
        bids: [
          ['99', '5'],
          ['98', '100']
        ],
        asks: [
          ['101', '2'],
          ['102', '100']
        ]
      })
    )
    // Buying 1,000: 202 at 101 and 798 at 102 -- an average about 0.82% over 101. Selling: 495 at 99 and 505 at 98, about
    // 0.51% under 99. The worse is the buy.
    const impact = (await module.perpBookImpact('binance', 'BTCUSDT', 1000)) as number
    expect(impact).toBeCloseTo((1000 / (2 + 798 / 102) / 101 - 1) * 100, 9)
    expect(await module.perpBookImpact('binance', 'BTCUSDT', 1_000_000)).toBeNull()
  })

  it("says what Bitget answered when it refuses, and what a host answered when it fails", async () => {
    const refused = await market(() => json({ code: '40034', msg: 'Parameter does not exist', data: null }))
    await expect(refused.module.perpSymbols('bitget')).rejects.toThrow('Bitget answered 40034: Parameter does not exist')
    const down = await market(() => json({}, 451))
    await expect(down.module.perpSymbols('binance')).rejects.toThrow('fapi.binance.com answered 451')
  })
})

describe("a perpetual's price (V8 Stage 8)", () => {
  it("is Binance's last price or Bitget's, asked once more a second later where the first asking fails", async () => {
    let calls = 0
    const { module, urls } = await market((url) => {
      calls++
      if (url.host === 'fapi.binance.com') return calls === 1 ? json({}, 503) : json({ price: '79621.5', symbol: 'BTCUSDT' })
      return json({ code: '00000', data: [{ symbol: 'ABCUSDT', lastPr: '1.25' }] })
    })
    const slept: number[] = []
    module.perpMarketSeam.sleep = async (ms: number) => void slept.push(ms)
    expect(await module.perpPrice('binance', 'BTCUSDT')).toBe(79_621.5)
    expect(slept).toEqual([module.PERP_PRICE_RETRY_MS])
    expect(urls.map((url) => url.pathname)).toEqual(['/fapi/v1/ticker/price', '/fapi/v1/ticker/price'])
    expect(await module.perpPrice('bitget', 'ABCUSDT')).toBe(1.25)
    expect(slept).toHaveLength(1)
  })

  it('fails where the second asking fails too, or no price is given', async () => {
    const { module } = await market(() => json({ price: '0' }))
    const slept: number[] = []
    module.perpMarketSeam.sleep = async (ms: number) => void slept.push(ms)
    await expect(module.perpPrice('binance', 'BTCUSDT')).rejects.toThrow('Binance gave no price for BTCUSDT')
    expect(slept).toEqual([module.PERP_PRICE_RETRY_MS])
  })
})
