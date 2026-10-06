import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LiveState } from '../shared/liveMarket'

// electron/services/liveMarketService.ts, driven with its socket, its data source and settings
// faked: which streams it asks for and when, what it makes of each message, what it keeps of a
// quiet or closed socket, and where a book comes from when the stream has none fresh.

const rig = vi.hoisted(() => ({
  urls: [] as string[],
  handlers: null as null | { onOpen?: (socket: unknown) => void; onMessage: (raw: Buffer) => void },
  sent: [] as { method: string; params: string[] }[],
  onClose: null as null | (() => void),
  settings: { executors: [] as unknown[] },
  fetched: [] as string[],
  rest: { ok: true, row: {} as Record<string, unknown> }
}))

vi.mock('../electron/services/exchanges/reconnectingSocket', () => ({
  createReconnectingSocket: (url: string, handlers: { onOpen?: (socket: unknown) => void; onMessage: (raw: Buffer) => void }) => {
    rig.urls.push(url)
    rig.handlers = handlers
    return () => undefined
  }
}))
vi.mock('../electron/services/exchanges/binance', () => {
  const endpoint = { name: 'data-api.binance.vision', restRoot: 'https://data-api.binance.vision/api/v3', wsBase: 'wss://data-stream.binance.vision/ws' }
  return {
    resolveEndpoint: async () => endpoint,
    fetchMarketData: async (path: string) => ({ response: await fetch(`${endpoint.restRoot}${path}`), endpoint })
  }
})
vi.mock('../electron/services/marketService', () => ({ scanSourceFor: () => ({ fetchRecentCandles: async () => [] }) }))
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => rig.settings }))

import { getLiveState, liveBook, onLiveUpdate, setLiveInterest, startLiveMarket } from '../electron/services/liveMarketService'

const NOW_MS = Date.parse('2026-10-06T12:00:00Z')
const message = (stream: string, data: unknown): Buffer => Buffer.from(JSON.stringify({ stream, data }))
const socket = {
  readyState: 1,
  send: (text: string) => rig.sent.push(JSON.parse(text) as { method: string; params: string[] }),
  on: (event: string, listener: () => void) => {
    if (event === 'close') rig.onClose = listener
  }
}
const pushed: LiveState[] = []

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('fetch', async (url: string) => {
    rig.fetched.push(url)
    return { ok: rig.rest.ok, json: async () => rig.rest.row }
  })
  onLiveUpdate((state) => pushed.push(state))
  startLiveMarket()
  await vi.waitFor(() => expect(rig.handlers).not.toBeNull())
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the live market', () => {
  it("opens one socket on the data host with Bitcoin's and ether's minutes, and asks for nothing more until a pair is shown", () => {
    expect(rig.urls).toEqual(['wss://data-stream.binance.vision/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m'])
    rig.handlers?.onOpen?.(socket)
    expect(getLiveState().connection).toMatchObject({ open: true, connects: 1, drops: 0 })
    expect(rig.sent).toEqual([])
  })

  it("streams a shown pair's book, minutes and five best levels, and drops what is no longer shown", async () => {
    await setLiveInterest(['SOLUSDT', 'not a pair', 'SOLUSDT', 42])
    expect(rig.sent).toEqual([{ method: 'SUBSCRIBE', params: ['solusdt@bookTicker', 'solusdt@kline_1m', 'solusdt@depth5'], id: 1 }])
    rig.handlers?.onMessage(message('solusdt@bookTicker', { s: 'SOLUSDT', b: '99.99', B: '50', a: '100.01', A: '40' }))
    rig.handlers?.onMessage(message('btcusdt@kline_1m', { s: 'BTCUSDT', k: { t: NOW_MS - 60_000, o: '100', h: '101', l: '99', c: '100.5', v: '3', x: true } }))
    rig.handlers?.onMessage(message('solusdt@depth5', { lastUpdateId: 1, bids: [['99.99', '50'], ['99.98', '1']], asks: [['100.01', '40']] }))
    rig.handlers?.onMessage(Buffer.from('not json'))
    rig.handlers?.onMessage(message('solusdt@bookTicker', { s: 'SOLUSDT', b: 'x', B: '1', a: '1', A: '1' }))
    const state = getLiveState()
    expect(state.books.SOLUSDT).toEqual({ symbol: 'SOLUSDT', bid: 99.99, bidQty: 50, ask: 100.01, askQty: 40, updatedAt: Date.now(), source: 'stream' })
    expect(state.btcMinutes).toEqual([{ time: NOW_MS / 1000 - 60, open: 100, high: 101, low: 99, close: 100.5, volume: 3, closed: true }])
    expect(state.depth.SOLUSDT).toMatchObject({ bids: [[99.99, 50], [99.98, 1]], asks: [[100.01, 40]] })
    // The window is sent it, four times a second at most.
    await vi.advanceTimersByTimeAsync(250)
    expect(pushed[pushed.length - 1].books.SOLUSDT?.bid).toBe(99.99)
    rig.sent.length = 0
    await setLiveInterest([])
    expect(rig.sent).toEqual([{ method: 'UNSUBSCRIBE', params: ['solusdt@bookTicker', 'solusdt@kline_1m', 'solusdt@depth5'], id: 2 }])
    expect(getLiveState().books.SOLUSDT).toBeUndefined()
  })

  it("streams the book of a pair the app's own paper trades are open on, whatever is shown", async () => {
    rig.sent.length = 0
    rig.settings.executors = [
      { status: 'active', mode: 'paper', type: 'position', symbol: 'XRPUSDT', watch: { eventId: 'e', eventTime: 1, model: 'm', confidence: 0.8 } },
      { status: 'active', mode: 'paper', type: 'position', symbol: 'ADAUSDT' },
      { status: 'stopped', mode: 'paper', type: 'position', symbol: 'DOGEUSDT', watch: { eventId: 'f', eventTime: 1, model: 'm', confidence: 0.8 } }
    ]
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.sent).toEqual([{ method: 'SUBSCRIBE', params: ['xrpusdt@bookTicker', 'xrpusdt@kline_1m'], id: 3 }])
  })

  it('writes down a quiet minute as a gap, closed by the next message, and a closed socket as a drop', async () => {
    await vi.advanceTimersByTimeAsync(61_000)
    const open = getLiveState().connection.gaps
    expect(open).toHaveLength(1)
    expect(open[0].to).toBeNull()
    expect(Date.now() / 1000 - open[0].from).toBeGreaterThanOrEqual(60)
    rig.handlers?.onMessage(message('btcusdt@kline_1m', { s: 'BTCUSDT', k: { t: NOW_MS, o: '100', h: '100', l: '100', c: '100', v: '1', x: false } }))
    const closed = getLiveState().connection.gaps
    expect(closed).toHaveLength(1)
    expect(closed[0].to).toBe(Math.floor(Date.now() / 1000))
    rig.onClose?.()
    expect(getLiveState().connection).toMatchObject({ open: false, drops: 1 })
  })

  it("gives a pair's book from the stream while fresh, else reads it once, else none", async () => {
    rig.handlers?.onOpen?.(socket)
    await setLiveInterest(['SOLUSDT'])
    rig.handlers?.onMessage(message('solusdt@bookTicker', { s: 'SOLUSDT', b: '99.99', B: '50', a: '100.01', A: '40' }))
    expect((await liveBook('SOLUSDT'))?.source).toBe('stream')
    expect(rig.fetched).toEqual([])
    await vi.advanceTimersByTimeAsync(11_000)
    rig.rest.row = { symbol: 'SOLUSDT', bidPrice: '99.5', bidQty: '10', askPrice: '99.6', askQty: '12' }
    expect(await liveBook('SOLUSDT')).toEqual({ symbol: 'SOLUSDT', bid: 99.5, bidQty: 10, ask: 99.6, askQty: 12, updatedAt: Date.now(), source: 'rest' })
    expect(rig.fetched).toEqual(['https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=SOLUSDT'])
    rig.rest.ok = false
    expect(await liveBook('SOLUSDT')).toBeNull()
    expect(await liveBook('not a pair')).toBeNull()
  })
})
