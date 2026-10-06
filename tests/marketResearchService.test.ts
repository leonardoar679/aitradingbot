import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Candle, SymbolInfo, Ticker24h } from '../shared/ipc'
import { TRENDING_URL, type ResearchState } from '../shared/marketResearch'

// electron/services/marketResearchService.ts, driven with the market data source faked: what a pass
// reads, in what order it says so, and what it keeps when a part of it fails. It reads the data
// host's methods only -- the fake has nothing else to offer -- and CoinGecko's free list.

const rig = vi.hoisted(() => ({
  symbols: [] as SymbolInfo[],
  tickers: [] as Ticker24h[],
  failSymbols: new Set<string>(),
  failList: false,
  requests: [] as string[],
  daily: [] as Candle[],
  fifteen: [] as Candle[],
  fetched: [] as string[],
  trending: { ok: true, body: {} as unknown }
}))

vi.mock('../electron/services/marketService', () => ({
  listSymbols: async () => {
    if (rig.failList) throw new Error('451 geo-blocked')
    return rig.symbols
  },
  scanSourceFor: () => ({
    fetchAllTickers24h: async () => rig.tickers,
    fetchBookTickers: async () => [],
    fetchRecentCandles: async (symbol: string, interval: string, limit: number) => {
      rig.requests.push(`${symbol} ${interval} ${limit}`)
      if (rig.failSymbols.has(symbol)) throw new Error('timeout')
      return interval === '1d' ? rig.daily : rig.fifteen
    }
  })
}))

import { getResearchState, onResearchUpdate, refreshResearch } from '../electron/services/marketResearchService'

const NOW = Date.parse('2026-10-06T12:00:00Z') / 1000
const DAY = 86_400
const TODAY = Math.floor(NOW / DAY) * DAY
const info = (base: string): SymbolInfo => ({ symbol: `${base}USDT`, baseAsset: base, quoteAsset: 'USDT' })
const ticker = (symbol: string, quoteVolume: number): Ticker24h => ({
  symbol,
  lastPrice: 100,
  priceChange: 0,
  priceChangePercent: 1,
  highPrice: 0,
  lowPrice: 0,
  volume: 100,
  quoteVolume
})
const bar = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 100 })

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
  vi.stubGlobal('fetch', async (url: string) => {
    rig.fetched.push(url)
    if (!rig.trending.ok) throw new Error('network down')
    return { ok: true, status: 200, json: async () => rig.trending.body }
  })
  rig.symbols = [info('BTC'), info('ETH'), info('SOL'), info('PEPE')]
  rig.tickers = [ticker('BTCUSDT', 5e9), ticker('ETHUSDT', 3e9), ticker('SOLUSDT', 1e9), ticker('PEPEUSDT', 25e6)]
  rig.daily = [...Array.from({ length: 8 }, (_, k) => bar(TODAY - (8 - k) * DAY, 90)), bar(TODAY, 100)]
  const lastOpen = Math.floor(NOW / 900) * 900 - 900
  rig.fifteen = Array.from({ length: 98 }, (_, k) => bar(lastOpen - (97 - k) * 900, 100))
  rig.trending.body = { coins: [{ item: { symbol: 'SOL', name: 'Solana', market_cap_rank: 5 } }] }
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a pass', () => {
  it('reads the pairs, their days, Bitcoin and ether, and the trending list, and says each step as it ends', async () => {
    const seen: ResearchState[] = []
    const stop = onResearchUpdate((state) => seen.push(state))
    rig.failSymbols = new Set(['PEPEUSDT'])
    const state = await refreshResearch()
    stop()
    expect(state.running).toBe(false)
    expect(state.finishedAt).toBe(NOW)
    expect(state.steps.map((step) => [step.id, step.status, step.detail])).toEqual([
      ['universe', 'done', '4 USDT pairs trading at least $20M a day'],
      ['movers', 'done', '3 read, 1 could not be'],
      ['market', 'done', 'risk normal'],
      ['trending', 'done', '1 coin, 1 with a USDT pair on Binance']
    ])
    expect(state.pairs.map((pair) => [pair.symbol, pair.trending])).toEqual([
      ['BTCUSDT', false],
      ['ETHUSDT', false],
      ['SOLUSDT', true]
    ])
    expect(state.pairs[0].change7dPct).toBeCloseTo((100 / 90 - 1) * 100, 10)
    expect(state.market?.btc?.regime).toBe('flat')
    // The days of each pair, and a day of Bitcoin's and ether's fifteen minutes. Nothing else.
    expect([...rig.requests].sort()).toEqual(['BTCUSDT 15m 98', 'BTCUSDT 1d 9', 'ETHUSDT 15m 98', 'ETHUSDT 1d 9', 'PEPEUSDT 1d 9', 'SOLUSDT 1d 9'])
    expect(rig.fetched).toEqual([TRENDING_URL])
    // It said so as it went: running first, done last.
    expect(seen[0].running || seen[0].steps.some((step) => step.status === 'running')).toBe(true)
    expect(seen[seen.length - 1]).toEqual(getResearchState())
  })

  it('keeps the last trending list when CoinGecko cannot be read, and says why', async () => {
    rig.trending.ok = false
    const state = await refreshResearch()
    rig.trending.ok = true
    const step = state.steps.find((entry) => entry.id === 'trending')
    expect(step).toMatchObject({ status: 'failed', detail: "CoinGecko's trending list could not be read: network down" })
    expect(state.trending?.map((coin) => coin.symbol)).toEqual(['SOL'])
    expect(state.pairs.find((pair) => pair.symbol === 'SOLUSDT')?.trending).toBe(true)
  })

  it('keeps what it had when the market cannot be read, and says why', async () => {
    const before = getResearchState().pairs
    rig.failList = true
    const state = await refreshResearch()
    rig.failList = false
    expect(state.steps[0]).toMatchObject({ id: 'universe', status: 'failed', detail: '451 geo-blocked' })
    expect(state.running).toBe(false)
    expect(state.pairs).toEqual(before)
  })
})
