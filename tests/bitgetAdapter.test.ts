import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The sockets the adapter opens, faked: their address, their handlers, and whether each was stopped. */
const sockets = vi.hoisted(() => ({
  made: [] as { url: string; handlers: { onOpen?: (socket: unknown, renewed: boolean) => void; onMessage: (raw: Buffer) => void; onError?: (error: Error) => void }; stopped: boolean }[]
}))
vi.mock('../electron/services/exchanges/reconnectingSocket', () => ({
  createReconnectingSocket: (url: string, handlers: (typeof sockets.made)[number]['handlers']) => {
    const made = { url, handlers, stopped: false }
    sockets.made.push(made)
    return () => {
      made.stopped = true
    }
  }
}))

const { BITGET, BITGET_INTERVAL, BITGET_PAGE, bitgetAdapter, fetchBitgetBook, fetchBitgetFills, fetchBitgetTime } = await import('../electron/services/exchanges/bitget')

// BITGET'S PUBLIC MARKET DATA (electron/services/exchanges/bitget.ts; V7.1 Stage 6). The answers below
// are the shapes Bitget gave on 16 October 2026, cut to what is read: the v3 instruments, candles,
// tickers, book and fills, the v2 whole-market tickers, and the v3 stream's pushes.

const ok = (data: unknown): Promise<Response> => Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve({ code: '00000', msg: 'success', requestTime: 1792125707077, data }) } as Response)
const refused = (status: number, code: string, msg: string): Promise<Response> => Promise.resolve({ ok: status < 400, status, statusText: 'Bad Request', json: () => Promise.resolve({ code, msg, requestTime: 1, data: null }) } as Response)

const INSTRUMENTS = [
  { symbol: 'BTCUSDT', category: 'SPOT', baseCoin: 'BTC', quoteCoin: 'USDT', symbolType: 'crypto', status: 'online', pricePrecision: '2', quantityPrecision: '6', minOrderAmount: '1' },
  { symbol: 'RNNNNUSDT', category: 'SPOT', baseCoin: 'rNNNN', quoteCoin: 'USDT', symbolType: 'stock', fullName: 'Anbio Biotechnology', status: 'online' },
  { symbol: 'NEWUSDT', category: 'SPOT', baseCoin: 'NEW', quoteCoin: 'USDT', symbolType: 'crypto', status: 'limit_open' },
  { symbol: 'XAUTUSDT', category: 'SPOT', baseCoin: 'XAUT', quoteCoin: 'USDT', symbolType: 'metal', status: 'online' },
  { symbol: 'ETHUSDC', category: 'SPOT', baseCoin: 'ETH', quoteCoin: 'USDC', status: 'online' }
]

/** Three five-minute bars as /api/v3/market/candles gives them: [ts, open, high, low, close, base volume, turnover]. */
const CANDLES = [
  ['1792125300000', '82098.19', '82122.7', '82041', '82058.36', '5.432234', '445878.15338648'],
  ['1792125600000', '82058.36', '82062.2', '82026.55', '82062.2', '2.307566', '189325.76375019'],
  ['1792125900000', '82062.2', '82086.53', '82050.17', '82050.17', '1.51481', '124320.49866809']
]

const TICKER = {
  category: 'SPOT',
  symbol: 'BTCUSDT',
  ts: '1792125755406',
  lastPrice: '82060.85',
  openPrice24h: '81585.33',
  highPrice24h: '82632.37',
  lowPrice24h: '79793.43',
  ask1Price: '82060.85',
  bid1Price: '82060.84',
  bid1Size: '0.026707',
  ask1Size: '0.607563',
  price24hPcnt: '0.00583',
  volume24h: '4465.78287',
  turnover24h: '364016029.399466',
  platformTurnover24h: ''
}

const MARKET_TICKERS = [
  { open: '0.33119', symbol: 'TRXUSDT', high24h: '0.33595', low24h: '0.32952', lastPr: '0.33548', quoteVolume: '2076459.2723', baseVolume: '6258194.6489', usdtVolume: '2076459.27', ts: '1792126125256', bidPr: '0.33547', askPr: '0.33548', bidSz: '1331.25', askSz: '5628.3403', openUtc: '0.33259', changeUtc24h: '0.00869', change24h: '0.01295' },
  { open: '81592.43', symbol: 'BTCUSDT', high24h: '82632.37', low24h: '79793.43', lastPr: '82027', quoteVolume: '364003631.172763', baseVolume: '4465.6365', usdtVolume: '364003631.17', ts: '1792125705767', bidPr: '82026.55', askPr: '82026.56', bidSz: '0.287351', askSz: '0.617361', openUtc: '82232.69', changeUtc24h: '-0.0025', change24h: '0.00533' }
]

const asked: string[] = []

beforeEach(() => {
  asked.length = 0
  sockets.made.length = 0
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', (url: string) => {
    const u = String(url)
    asked.push(u)
    if (u.includes('/api/v3/market/instruments')) return ok(INSTRUMENTS)
    if (u.includes('/api/v3/market/candles')) return ok([...CANDLES].reverse())
    if (u.includes('/api/v3/market/tickers')) return u.includes('symbol=NOPEUSDT') ? refused(400, '40034', 'Parameter NOPEUSDT does not exist') : ok([TICKER])
    if (u.includes('/api/v2/spot/market/tickers')) return ok(MARKET_TICKERS)
    if (u.includes('/api/v3/market/orderbook')) return ok({ a: [[82041.72, 0.171702], [82043.22, 0.048756]], b: [[82041.71, 0.316084], [82041.0, 0.000033]], ts: '1792125772115' })
    if (u.includes('/api/v3/market/fills')) return ok([{ execId: '1', price: '82052.21', size: '0.00374', side: 'buy', ts: '1792125772389' }, { execId: '2', price: '82052.2', size: '0.1', side: 'sell', ts: '1792125772364' }])
    if (u.includes('/api/v3/market/time')) return ok({ serverTime: '1792125706044', serverTimeMicros: '1792125706044262' })
    return Promise.reject(new Error(`unexpected ${u}`))
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("Bitget's pins", () => {
  it('names one REST root, one public stream, the v3 market paths and v2 for the whole market, and spells each interval as Bitget does', () => {
    expect(BITGET.restRoot).toBe('https://api.bitget.com')
    expect(BITGET.wsPublic).toBe('wss://ws.bitget.com/v3/ws/public')
    expect(BITGET.paths).toEqual({
      time: '/api/v3/market/time',
      instruments: '/api/v3/market/instruments?category=SPOT',
      tickers: '/api/v3/market/tickers?category=SPOT',
      candles: '/api/v3/market/candles?category=SPOT',
      orderbook: '/api/v3/market/orderbook?category=SPOT',
      fills: '/api/v3/market/fills?category=SPOT',
      marketTickers: '/api/v2/spot/market/tickers'
    })
    expect(BITGET_INTERVAL).toEqual({ '1m': '1m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' })
    expect(BITGET_PAGE).toBe(1000)
  })
})

describe("Bitget's pairs, candles and tickers", () => {
  it('lists the pairs trading, a tokenized stock marked as Binance\'s are, a metal and a pair not yet open left as they are', async () => {
    expect(await bitgetAdapter.listSymbols()).toEqual([
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
      { symbol: 'RNNNNUSDT', baseAsset: 'rNNNN', quoteAsset: 'USDT', stockToken: true },
      { symbol: 'XAUTUSDT', baseAsset: 'XAUT', quoteAsset: 'USDT' },
      { symbol: 'ETHUSDC', baseAsset: 'ETH', quoteAsset: 'USDC' }
    ])
    expect(asked).toEqual(['https://api.bitget.com/api/v3/market/instruments?category=SPOT'])
  })

  it('reads candles as numbers in seconds, oldest first whatever order they came in, at most a page', async () => {
    const candles = await bitgetAdapter.fetchHistoricalCandles('btcusdt', '15m', 5000)
    expect(candles).toEqual([
      { time: 1792125300, open: 82098.19, high: 82122.7, low: 82041, close: 82058.36, volume: 5.432234 },
      { time: 1792125600, open: 82058.36, high: 82062.2, low: 82026.55, close: 82062.2, volume: 2.307566 },
      { time: 1792125900, open: 82062.2, high: 82086.53, low: 82050.17, close: 82050.17, volume: 1.51481 }
    ])
    expect(asked).toEqual(['https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=BTCUSDT&interval=15m&limit=1000'])
  })

  it("reads a pair's day: the change from the day's open, the percent from Bitget's fraction, the turnover as the quote volume", async () => {
    const ticker = await bitgetAdapter.fetchTicker24h('BTCUSDT')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT', lastPrice: 82060.85, priceChangePercent: 0.583, highPrice: 82632.37, lowPrice: 79793.43, volume: 4465.78287, quoteVolume: 364016029.399466 })
    expect(ticker.priceChange).toBeCloseTo(82060.85 - 81585.33, 6)
    expect(asked).toEqual(['https://api.bitget.com/api/v3/market/tickers?category=SPOT&symbol=BTCUSDT'])
  })

  it("refuses with Bitget's own code and message where it answers with one, and where it answers no rows", async () => {
    await expect(bitgetAdapter.fetchTicker24h('NOPEUSDT')).rejects.toThrow('Bitget ticker NOPEUSDT failed: 400 40034 Parameter NOPEUSDT does not exist')
    vi.stubGlobal('fetch', () => ok([]))
    await expect(bitgetAdapter.fetchTicker24h('BTCUSDT')).rejects.toThrow('Bitget ticker returned no data for BTCUSDT')
    // A 200 whose code is not success is a refusal too.
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: '40001', msg: 'rate limit', data: null }) }))
    await expect(bitgetAdapter.listSymbols()).rejects.toThrow('Bitget instruments failed: 200 40001 rate limit')
  })

  it('reads the whole market from the v2 ticker list, the day and the best bid and ask alike, and recent candles with a deadline', async () => {
    const scan = bitgetAdapter.scan!
    const tickers = await scan.fetchAllTickers24h()
    expect(tickers[1]).toMatchObject({ symbol: 'BTCUSDT', lastPrice: 82027, highPrice: 82632.37, lowPrice: 79793.43, volume: 4465.6365, quoteVolume: 364003631.172763 })
    expect(tickers[1].priceChange).toBeCloseTo(82027 - 81592.43, 6)
    expect(tickers[1].priceChangePercent).toBeCloseTo(0.533, 9)
    expect(await scan.fetchBookTickers()).toEqual([
      { symbol: 'TRXUSDT', bidPrice: 0.33547, askPrice: 0.33548 },
      { symbol: 'BTCUSDT', bidPrice: 82026.55, askPrice: 82026.56 }
    ])
    expect(await scan.fetchRecentCandles('BTCUSDT', '1m', 30)).toHaveLength(3)
    expect(asked).toEqual([
      'https://api.bitget.com/api/v2/spot/market/tickers',
      'https://api.bitget.com/api/v2/spot/market/tickers',
      'https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=BTCUSDT&interval=1m&limit=30'
    ])
  })

  it('reads the book, the fills and the clock as numbers', async () => {
    expect(await fetchBitgetBook('BTCUSDT', 2)).toEqual({ bids: [[82041.71, 0.316084], [82041, 0.000033]], asks: [[82041.72, 0.171702], [82043.22, 0.048756]], ts: 1792125772115 })
    expect(await fetchBitgetFills('BTCUSDT', 2)).toEqual([
      { price: 82052.21, size: 0.00374, side: 'buy', ts: 1792125772389 },
      { price: 82052.2, size: 0.1, side: 'sell', ts: 1792125772364 }
    ])
    const time = await fetchBitgetTime()
    expect(time.serverTime).toBe(1792125706044)
    expect(time.latencyMs).toBeGreaterThanOrEqual(0)
    expect(asked[0]).toBe('https://api.bitget.com/api/v3/market/orderbook?category=SPOT&symbol=BTCUSDT&limit=2')
    expect(asked[1]).toBe('https://api.bitget.com/api/v3/market/fills?category=SPOT&symbol=BTCUSDT&limit=2')
  })
})

describe('a range of candles', () => {
  /** Bitget as measured on 16 October 2026: the newest `limit` bars inside (startTime, endTime] -- the
   * bar opening at startTime left out, the one at endTime counted in -- ascending. */
  function serveMinutes(gapFrom: number, gapTo: number): void {
    vi.stubGlobal('fetch', (url: string) => {
      const u = String(url)
      asked.push(u)
      const start = Number(new URL(u).searchParams.get('startTime'))
      const end = Number(new URL(u).searchParams.get('endTime'))
      const limit = Number(new URL(u).searchParams.get('limit'))
      const rows: string[][] = []
      for (let t = Math.floor(start / 60_000) * 60_000; t <= end; t += 60_000) {
        if (t <= start || (t >= gapFrom && t < gapTo)) continue
        rows.push([String(t), '1', '2', '0.5', '1.5', '3', '4'])
      }
      return ok(rows.slice(-limit))
    })
  }
  const MINUTE = 60

  it('reads it in windows a page holds whole, each from the millisecond before its first bar, oldest first, no bar lost or counted twice', async () => {
    // Minutes 100 to 2600: windows of 999 minutes.
    serveMinutes(0, 0)
    const progress: [number, number][] = []
    const candles = await bitgetAdapter.fetchHistoricalRange('BTCUSDT', '1m', 100 * MINUTE, 2600 * MINUTE, (done, total) => void progress.push([done, total]), () => false)
    expect(asked).toEqual([
      'https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=BTCUSDT&interval=1m&startTime=5999999&endTime=65940000&limit=1000',
      'https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=BTCUSDT&interval=1m&startTime=65939999&endTime=125880000&limit=1000',
      'https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=BTCUSDT&interval=1m&startTime=125879999&endTime=156000000&limit=1000'
    ])
    expect(candles.map((candle) => candle.time)).toEqual(Array.from({ length: 2500 }, (_, at) => (100 + at) * MINUTE))
    expect(progress).toEqual([
      [999, 2500],
      [1998, 2500],
      [2500, 2500]
    ])
  })

  it('steps over an empty window and keeps what the windows around it hold', async () => {
    // The bars from minute 1000 to 2199 are missing: the second window (minutes 1099 to 2097) answers
    // nothing at all, and the third still has its bars from minute 2200.
    serveMinutes(1000 * MINUTE * 1000, 2200 * MINUTE * 1000)
    const candles = await bitgetAdapter.fetchHistoricalRange('BTCUSDT', '1m', 100 * MINUTE, 2600 * MINUTE, () => undefined, () => false)
    expect(asked).toHaveLength(3)
    expect(candles).toHaveLength(900 + 400)
    expect(candles[899].time).toBe(999 * MINUTE)
    expect(candles[900].time).toBe(2200 * MINUTE)
    expect(candles[candles.length - 1].time).toBe(2599 * MINUTE)
    expect(new Set(candles.map((candle) => candle.time)).size).toBe(1300)
  })

  it('never asks for a window a page of bars could not hold whole', async () => {
    // Minutes 100 to 1100 are 1,001 bars; one window of a thousand would have Bitget answer the newest
    // thousand and the first minute would be lost. The second window holds the last two.
    serveMinutes(0, 0)
    const candles = await bitgetAdapter.fetchHistoricalRange('BTCUSDT', '1m', 100 * MINUTE, 1101 * MINUTE, () => undefined, () => false)
    expect(asked).toHaveLength(2)
    expect(candles.map((candle) => candle.time)).toEqual(Array.from({ length: 1001 }, (_, at) => (100 + at) * MINUTE))
  })

  it('stops at the first window after it is cancelled, with what it has', async () => {
    serveMinutes(0, 0)
    let pages = 0
    const candles = await bitgetAdapter.fetchHistoricalRange('BTCUSDT', '1m', 100 * MINUTE, 2600 * MINUTE, () => void pages++, () => pages >= 1)
    expect(asked).toHaveLength(1)
    expect(candles).toHaveLength(999)
  })
})

describe("Bitget's stream", () => {
  function fakeSocket(): { send: ReturnType<typeof vi.fn>; readyState: number; on: ReturnType<typeof vi.fn>; OPEN: number } {
    return { send: vi.fn(), readyState: 1, on: vi.fn(), OPEN: 1 }
  }

  it('subscribes to a pair\'s kline at each open, pings in words every thirty seconds while open, and hands on the bar forming', async () => {
    vi.useFakeTimers()
    const seen: unknown[] = []
    const stop = await bitgetAdapter.subscribeCandles('btcusdt', '4h', (candle) => void seen.push(candle))
    expect(sockets.made).toHaveLength(1)
    expect(sockets.made[0].url).toBe('wss://ws.bitget.com/v3/ws/public')
    const socket = fakeSocket()
    sockets.made[0].handlers.onOpen?.(socket, false)
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ op: 'subscribe', args: [{ instType: 'spot', topic: 'kline', symbol: 'BTCUSDT', interval: '4H' }] }))
    vi.advanceTimersByTime(30_000)
    expect(socket.send).toHaveBeenLastCalledWith('ping')
    vi.advanceTimersByTime(30_000)
    expect(socket.send.mock.calls.filter((call) => call[0] === 'ping')).toHaveLength(2)
    const push = (message: unknown): void => sockets.made[0].handlers.onMessage(Buffer.from(typeof message === 'string' ? message : JSON.stringify(message)))
    push('pong')
    push({ event: 'subscribe', arg: { instType: 'spot', topic: 'kline', symbol: 'BTCUSDT', interval: '4H' }, connId: 'x' })
    push({
      action: 'snapshot',
      arg: { instType: 'spot', topic: 'kline', symbol: 'BTCUSDT', interval: '4H' },
      data: [
        { start: '1792108800000', open: '82232.69', close: '82120.49', high: '82533.79', low: '81690', volume: '393.284425', turnover: '32318341.11' },
        { start: '1792123200000', open: '82120.49', close: '82111.38', high: '82157.25', low: '82022.44', volume: '12.1', turnover: '993000' }
      ],
      ts: 1792126484221
    })
    push({ action: 'update', arg: { instType: 'spot', topic: 'kline', symbol: 'BTCUSDT', interval: '4H' }, data: [{ start: '1792123200000', open: '82120.49', close: '82113.53', high: '82157.25', low: '82022.44', volume: '12.2', turnover: '1001000' }], ts: 1792126487211 })
    push({ event: 'error', code: 30001, msg: "{\"topic\":\"candle5m\"} doesn't exist", connId: 'x' })
    push('not json')
    expect(seen).toEqual([
      { time: 1792123200, open: 82120.49, high: 82157.25, low: 82022.44, close: 82111.38, volume: 12.1 },
      { time: 1792123200, open: 82120.49, high: 82157.25, low: 82022.44, close: 82113.53, volume: 12.2 }
    ])
    // Stopped: the socket is, and so is the ping.
    stop()
    expect(sockets.made[0].stopped).toBe(true)
    const sends = socket.send.mock.calls.length
    vi.advanceTimersByTime(90_000)
    expect(socket.send.mock.calls.length).toBe(sends)
  })

  it("subscribes to a pair's ticker and hands each push on as the day's figures", async () => {
    const seen: unknown[] = []
    await bitgetAdapter.subscribeTicker('BTCUSDT', (ticker) => void seen.push(ticker))
    const socket = fakeSocket()
    sockets.made[0].handlers.onOpen?.(socket, false)
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ op: 'subscribe', args: [{ instType: 'spot', topic: 'ticker', symbol: 'BTCUSDT' }] }))
    sockets.made[0].handlers.onMessage(
      Buffer.from(
        JSON.stringify({
          action: 'snapshot',
          arg: { instType: 'spot', topic: 'ticker', symbol: 'BTCUSDT' },
          data: [{ highPrice24h: '82632.37', lowPrice24h: '79793.43', openPrice24h: '82413.03', lastPrice: '82111.38', turnover24h: '362450902.496027', volume24h: '4446.594036', bid1Price: '82111.37', ask1Price: '82111.38', bid1Size: '0.3887', ask1Size: '0.477498', price24hPcnt: '0.00545' }],
          ts: 1792126484221
        })
      )
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ symbol: 'BTCUSDT', lastPrice: 82111.38, highPrice: 82632.37, lowPrice: 79793.43, volume: 4446.594036, quoteVolume: 362450902.496027 })
    expect((seen[0] as { priceChange: number }).priceChange).toBeCloseTo(82111.38 - 82413.03, 6)
    expect((seen[0] as { priceChangePercent: number }).priceChangePercent).toBeCloseTo(0.545, 9)
  })
})
