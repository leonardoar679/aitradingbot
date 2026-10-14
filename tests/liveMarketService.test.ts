import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LiveState } from '../shared/liveMarket'

// electron/services/liveMarketService.ts, driven with its socket, its data source and settings
// faked: which streams it asks for and when, what it makes of each message, what it keeps of a
// quiet or closed socket, and where a book comes from when the stream has none fresh.

const rig = vi.hoisted(() => {
  const MIRROR = { name: 'data-api.binance.vision', restRoot: 'https://data-api.binance.vision/api/v3', wsBase: 'wss://data-stream.binance.vision/ws' }
  const COM = { name: 'binance.com', restRoot: 'https://api.binance.com/api/v3', wsBase: 'wss://stream.binance.com:9443/ws' }
  type Endpoint = typeof MIRROR
  return {
    MIRROR,
    COM,
    urls: [] as string[],
    handlers: null as null | { onOpen?: (socket: unknown) => void; onMessage: (raw: Buffer) => void; onConnectFailed?: (consecutive: number) => void },
    sent: [] as { method: string; params: string[] }[],
    onClose: null as null | (() => void),
    settings: { executors: [] as unknown[] },
    fetched: [] as string[],
    /** Pairs whose recent minutes were read over REST. */
    seeded: [] as string[],
    rest: { ok: true, row: {} as Record<string, unknown> },
    /** Sockets stopped for good: a move stops the old one. */
    stops: 0,
    /** The data host as binance.ts would have it, and what a probe of its partner answers. */
    hosts: { current: MIRROR as Endpoint, listeners: [] as ((to: Endpoint, from: Endpoint) => void)[], probeAnswer: null as Endpoint | null, probes: 0, switches: 0 }
  }
})

vi.mock('../electron/services/exchanges/reconnectingSocket', () => ({
  createReconnectingSocket: (url: string, handlers: NonNullable<typeof rig.handlers>) => {
    rig.urls.push(url)
    rig.handlers = handlers
    return () => {
      rig.stops += 1
    }
  }
}))
vi.mock('../electron/services/exchanges/binance', () => ({
  resolveEndpoint: async () => rig.hosts.current,
  currentDataEndpoint: () => rig.hosts.current,
  dataHostSwitchCount: () => rig.hosts.switches,
  onDataHostChange: (listener: (to: typeof rig.MIRROR, from: typeof rig.MIRROR) => void) => {
    rig.hosts.listeners.push(listener)
    return () => undefined
  },
  probeDataPartner: async () => {
    rig.hosts.probes += 1
    const answer = rig.hosts.probeAnswer
    if (answer !== null && answer.name !== rig.hosts.current.name) {
      const from = rig.hosts.current
      rig.hosts.current = answer
      rig.hosts.switches += 1
      for (const listener of rig.hosts.listeners) listener(answer, from)
    }
    return answer
  },
  fetchMarketData: async (path: string) => ({ response: await fetch(`${rig.hosts.current.restRoot}${path}`), endpoint: rig.hosts.current })
}))
/** What the main process told: the stream dead (the V4 document, §48). */
const told = vi.hoisted(() => [] as { title: string; body: string; extra: { kind: string; thread?: string } }[])
// A notice the main process builds in the person's language (V6 Stage 14) is handed as a builder:
// built here in English, as the language of a profile that chose none.
vi.mock('../electron/services/noticeService', async () => {
  const { ENGLISH } = await import('../shared/i18n/translate')
  type Told = { title: string; body: string; extra: { kind: string; thread?: string } }
  return {
    tell: (notice: Told | ((i18n: typeof ENGLISH) => Told)) => void told.push(typeof notice === 'function' ? notice(ENGLISH) : notice),
    tellNotice: async () => true
  }
})
vi.mock('../electron/services/marketService', () => ({
  scanSourceFor: () => ({
    fetchRecentCandles: async (symbol: string) => {
      rig.seeded.push(symbol)
      return []
    }
  })
}))
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
    expect(getLiveState().connection).toMatchObject({ open: true, connects: 1, drops: 0, host: 'data-api.binance.vision', hostSwitches: 0, dataHostSwitches: 0 })
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
      { status: 'stopped', mode: 'paper', type: 'position', symbol: 'DOGEUSDT', watch: { eventId: 'f', eventTime: 1, model: 'm', confidence: 0.8 } },
      // The forecast trader's own (V6 Stage 16).
      { status: 'active', mode: 'paper', type: 'position', symbol: 'LINKUSDT', forecast: { predictionId: 'LINKUSDT:1', side: 'BUY' } }
    ]
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.sent).toEqual([{ method: 'SUBSCRIBE', params: ['linkusdt@bookTicker', 'linkusdt@kline_1m', 'xrpusdt@bookTicker', 'xrpusdt@kline_1m'], id: 3 }])
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

  // THE HOST RULE: a healthy socket stays where it is, whatever REST does; a socket that cannot
  // connect three times in a row goes to the host that answers. In a 24-hour run on 7 October 2026
  // the socket kept dialling binance.com every fifteen seconds after REST had moved to the mirror.
  it('moves to the host that answers after three connects in a row failed, and asks again for what is shown', async () => {
    // On the mirror, showing SOLUSDT: the socket closes and then cannot connect; binance.com answers.
    rig.handlers?.onOpen?.(socket)
    await setLiveInterest(['SOLUSDT'])
    rig.onClose?.()
    const before = rig.urls.length
    rig.hosts.probeAnswer = rig.COM
    rig.handlers?.onConnectFailed?.(1)
    rig.handlers?.onConnectFailed?.(2)
    expect(rig.hosts.probes).toBe(0)
    rig.handlers?.onConnectFailed?.(3)
    await vi.waitFor(() => expect(rig.urls.length).toBe(before + 1))
    expect(rig.hosts.probes).toBe(1)
    expect(rig.stops).toBe(1)
    expect(rig.urls[before]).toBe('wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m')
    expect(getLiveState().connection).toMatchObject({ open: false, host: 'binance.com', hostSwitches: 1, dataHostSwitches: 1 })
    // As the new socket opens, the shown pair's streams are asked for again.
    rig.sent.length = 0
    rig.handlers?.onOpen?.(socket)
    expect(rig.sent).toHaveLength(1)
    expect(rig.sent[0].method).toBe('SUBSCRIBE')
    expect(rig.sent[0].params).toEqual(expect.arrayContaining(['solusdt@bookTicker', 'solusdt@kline_1m', 'solusdt@depth5']))
    expect(getLiveState().connection).toMatchObject({ open: true, host: 'binance.com' })
  })

  it('stays where it is when the data host moves while it is open, and follows at once while it is closed', () => {
    const before = rig.urls.length
    const tell = (to: typeof rig.MIRROR, from: typeof rig.MIRROR): void => {
      rig.hosts.current = to
      rig.hosts.switches += 1
      for (const listener of rig.hosts.listeners) listener(to, from)
    }
    // Open on binance.com; REST moves to the mirror: nothing happens to a socket that is receiving.
    tell(rig.MIRROR, rig.COM)
    expect(rig.urls.length).toBe(before)
    expect(rig.stops).toBe(1)
    expect(getLiveState().connection).toMatchObject({ open: true, host: 'binance.com', hostSwitches: 1, dataHostSwitches: 2 })
    // Closed, and REST moves to the host it is on: nothing to do. Then away from it: it follows.
    rig.onClose?.()
    tell(rig.COM, rig.MIRROR)
    expect(rig.urls.length).toBe(before)
    tell(rig.MIRROR, rig.COM)
    expect(rig.urls.length).toBe(before + 1)
    expect(rig.urls[before]).toBe('wss://data-stream.binance.vision/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m')
    expect(rig.stops).toBe(2)
    expect(getLiveState().connection).toMatchObject({ open: false, host: 'data-api.binance.vision', hostSwitches: 2, dataHostSwitches: 4 })
  })

  it('stays on a host whose partner does not answer either', async () => {
    const before = rig.urls.length
    rig.hosts.probeAnswer = null
    rig.handlers?.onConnectFailed?.(3)
    await vi.waitFor(() => expect(rig.hosts.probes).toBe(2))
    expect(rig.urls.length).toBe(before)
    expect(rig.stops).toBe(2)
    expect(getLiveState().connection).toMatchObject({ host: 'data-api.binance.vision', hostSwitches: 2 })
  })
})

// THE CONNECTION, RENEWED AND READ AGAIN (the V4 document, §12): a socket reopened after a drop reads
// every streamed pair's minutes again, a renewal before the lifetime does not, a frame that is not a
// stream's is the socket alive, and a gap closing reads the minutes again, at most once in thirty
// seconds.
describe('the connection, renewed and read again', () => {
  it("reads every streamed pair's minutes again when the socket reopens after a drop, and not on a planned renewal", async () => {
    await vi.advanceTimersByTimeAsync(31_000)
    rig.seeded.length = 0
    const openedAt = Date.now()
    rig.handlers?.onOpen?.(socket)
    await vi.waitFor(() => expect(rig.seeded).toEqual(expect.arrayContaining(['BTCUSDT', 'ETHUSDT'])))
    expect(getLiveState().connection).toMatchObject({ open: true, connectedAt: openedAt, planned: 0 })
    // A renewal half a minute later, past the guard that spares a flapping socket: it reads nothing
    // again, since the socket it replaced was open until it was.
    rig.handlers?.onMessage(message('btcusdt@kline_1m', { s: 'BTCUSDT', k: { t: NOW_MS, o: '1', h: '1', l: '1', c: '1', v: '1', x: false } }))
    await vi.advanceTimersByTimeAsync(31_000)
    rig.seeded.length = 0
    rig.handlers?.onOpen?.(socket, true)
    await vi.advanceTimersByTimeAsync(10)
    expect(rig.seeded).toEqual([])
    expect(getLiveState().connection).toMatchObject({ open: true, planned: 1 })
  })

  it('counts a request the stream refused, and takes its answers as the socket alive', () => {
    const before = getLiveState().connection
    rig.handlers?.onMessage(Buffer.from(JSON.stringify({ error: { code: 2, msg: 'Invalid request' }, id: 9 })))
    rig.handlers?.onMessage(Buffer.from(JSON.stringify({ result: null, id: 10 })))
    const after = getLiveState().connection
    expect(after.subscribeErrors).toBe(before.subscribeErrors + 1)
    expect(after.lastMessageAt).toBe(Date.now())
  })

  it('reads the minutes again when a gap closes, and not again within thirty seconds', async () => {
    // The gap clock looks every five seconds, from the app's start: a minute and a tick.
    await vi.advanceTimersByTimeAsync(66_000)
    expect(getLiveState().connection.gaps.at(-1)?.to).toBeNull()
    rig.seeded.length = 0
    rig.handlers?.onMessage(message('btcusdt@kline_1m', { s: 'BTCUSDT', k: { t: NOW_MS, o: '1', h: '1', l: '1', c: '1', v: '1', x: false } }))
    expect(getLiveState().connection.gaps.at(-1)?.to).toBe(Math.floor(Date.now() / 1000))
    await vi.waitFor(() => expect(rig.seeded).toContain('BTCUSDT'))
    // A drop and a reopening seconds later read nothing again: once in thirty seconds.
    rig.seeded.length = 0
    rig.onClose?.()
    expect(getLiveState().connection).toMatchObject({ open: false, connectedAt: null })
    rig.handlers?.onOpen?.(socket)
    await vi.advanceTimersByTimeAsync(10)
    expect(rig.seeded).toEqual([])
  })
})

describe('the stream dead', () => {
  it('is told once a gap has been open three minutes, once per gap, and again for the next gap', async () => {
    told.length = 0
    rig.handlers?.onMessage(message('btcusdt@kline_1m', { s: 'BTCUSDT', k: { t: NOW_MS, o: '1', h: '1', l: '1', c: '1', v: '1', x: false } }))
    await vi.advanceTimersByTimeAsync(66_000)
    expect(getLiveState().connection.gaps.at(-1)?.to).toBeNull()
    expect(told).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ title: 'The live stream is dead', extra: { kind: 'SYSTEM_FAILURE', thread: 'stream' } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(told).toHaveLength(1)
    // The next frame closes the gap; a gap after that is told again.
    rig.handlers?.onMessage(message('btcusdt@kline_1m', { s: 'BTCUSDT', k: { t: NOW_MS, o: '1', h: '1', l: '1', c: '1', v: '1', x: false } }))
    await vi.advanceTimersByTimeAsync(190_000)
    expect(told).toHaveLength(2)
  })
})
