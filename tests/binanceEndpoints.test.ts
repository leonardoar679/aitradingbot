import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The sockets the adapter opens, faked: their address, their handlers, and whether each was stopped. */
const sockets = vi.hoisted(() => ({
  made: [] as { url: string; handlers: { onOpen?: (socket: { on: () => void }) => void; onConnectFailed?: (consecutive: number) => void }; stopped: boolean }[]
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

// Which Binance host each kind of request is allowed to reach.
//
// This exists because of a real failure with a tempting one-line fix. In this region binance.com
// answers 451 (geo-blocked) and binance.us does not answer at all, so every market-data call in the
// app failed with "No reachable Binance endpoint" -- backtests, and the bot dry runs that were
// supposed to be producing forward paper evidence. data-api.binance.vision is reachable, serves the
// full TRADING symbol universe, and is where every candle file in .candles/ came from.
//
// The tempting fix is to append it to the one shared endpoint list. That would also have routed
// SIGNED requests there, because a single resolver memoises one host for everything -- and the data
// mirror has no signed routes at all. A real order would then be signed, sent, and 404, in a region
// where the user cannot reach a trading host anyway. The failure would read like a bad API key.
//
// So the lists are split, and these tests pin the split rather than the wiring that implements it.

const { ENDPOINTS_FOR_TEST, fetchMarketData, resolveEndpoint, resolveTradingEndpoint, resetResolvedEndpoints, onDataHostChange, currentDataEndpoint, dataHostSwitchCount, probeDataPartner, binanceAdapter } =
  await import('../electron/services/exchanges/binance')

const KLINE = [[1, '1', '1', '1', '1', '1']]

/** Answers only for the hosts named, exactly as the real probe would: a 451 body that is not an
 * array for the geo-blocked host, a thrown connection error for the unreachable one. */
function stubHosts(reachable: string[]): string[] {
  const tried: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    const u = String(url)
    tried.push(u)
    if (reachable.some((h) => u.includes(h))) {
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(KLINE) })
    }
    if (u.includes('api.binance.com')) {
      return Promise.resolve({
        ok: false,
        status: 451,
        statusText: 'Unavailable For Legal Reasons',
        json: () => Promise.resolve({ code: 0, msg: 'restricted location' })
      })
    }
    return Promise.reject(new Error('ECONNRESET'))
  })
  return tried
}

beforeEach(() => {
  resetResolvedEndpoints()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** What a host does, and can be changed mid-test: answers with data, does not answer at all, or
 * answers with a status. */
type Behaviour = 'answers' | 'silent' | number

function stubBehaviour(hosts: Record<string, Behaviour>): string[] {
  const tried: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    const u = String(url)
    tried.push(u)
    const host = Object.keys(hosts).find((name) => u.includes(name))
    const what = host === undefined ? 'silent' : hosts[host]
    if (what === 'answers') return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(KLINE) })
    if (what === 'silent') return Promise.reject(new TypeError('fetch failed'))
    return Promise.resolve({ ok: false, status: what, statusText: 'Refused', json: () => Promise.resolve({ code: what }) })
  })
  return tried
}

describe('the endpoint lists', () => {
  it('offers the data mirror for market data and never for trading', () => {
    const data = ENDPOINTS_FOR_TEST.DATA_ENDPOINTS.map((e) => e.name)
    const trading = ENDPOINTS_FOR_TEST.TRADING_ENDPOINTS.map((e) => e.name)

    expect(data).toContain('data-api.binance.vision')
    // The invariant this whole file exists for. Stated against the list rather than against a
    // resolved value, so it holds even for a host added later by someone who did not read the
    // comment above.
    expect(trading).not.toContain('data-api.binance.vision')
  })

  it('probes the data mirror BEFORE binance.us, which is load-bearing and not cosmetic', () => {
    // Measured in the running app: attempting api.binance.us does not just time out after ~10s, it
    // makes every subsequent HTTPS request from that process fail too -- binance.com went from
    // answering 451 in 1.2s to failing outright in 10.6s once binance.us had been tried. So a list
    // that reaches binance.us before the host it needs can never fail over. Appending the mirror to
    // the end, the obvious placement, is the broken one.
    const names = ENDPOINTS_FOR_TEST.DATA_ENDPOINTS.map((e) => e.name)
    expect(names.indexOf('data-api.binance.vision')).toBeLessThan(names.indexOf('binance.us'))
  })

  it('never offers a host to trading that is not also offered to data', () => {
    // Trading is the stricter list, so it must be a subset. A trading-only host would be a host
    // the app would place orders against without ever having read a price from it.
    const data = new Set(ENDPOINTS_FOR_TEST.DATA_ENDPOINTS.map((e) => e.name))
    for (const e of ENDPOINTS_FOR_TEST.TRADING_ENDPOINTS) expect(data.has(e.name)).toBe(true)
  })

  it('gives every host a REST root and a websocket base on the same origin family', () => {
    for (const e of ENDPOINTS_FOR_TEST.DATA_ENDPOINTS) {
      expect(e.restRoot.startsWith('https://')).toBe(true)
      expect(e.wsBase.startsWith('wss://')).toBe(true)
    }
  })
})

describe('resolving in a region where only the data mirror is reachable', () => {
  it('falls through the geo-blocked and unreachable hosts to the data mirror', async () => {
    stubHosts(['data-api.binance.vision'])
    const endpoint = await resolveEndpoint()
    expect(endpoint.name).toBe('data-api.binance.vision')
  })

  it('tries the primary hosts FIRST, so a working binance.com is still preferred', async () => {
    const tried = stubHosts(['api.binance.com'])
    const endpoint = await resolveEndpoint()
    expect(endpoint.name).toBe('binance.com')
    // One probe only -- it must not walk the rest of the list after a success.
    expect(tried).toHaveLength(1)
  })

  it('REFUSES to resolve a trading host, rather than handing back the data mirror', async () => {
    stubHosts(['data-api.binance.vision'])
    // The whole point. An order in this region must fail here, loudly, before anything is signed.
    await expect(resolveTradingEndpoint()).rejects.toThrow(/No reachable Binance trading endpoint/)
  })

  it('names only the trading hosts when it refuses, so the message is not misleading', async () => {
    stubHosts(['data-api.binance.vision'])
    await expect(resolveTradingEndpoint()).rejects.toThrow(/binance\.com, binance\.us/)
    await expect(resolveTradingEndpoint()).rejects.not.toThrow(/vision/)
  })
})

describe('the two resolvers do not contaminate each other', () => {
  it('resolving data to the mirror leaves trading still refusing', async () => {
    stubHosts(['data-api.binance.vision'])
    expect((await resolveEndpoint()).name).toBe('data-api.binance.vision')
    // A single shared memo was the actual hazard: data resolves first (the app fetches candles long
    // before it places an order), and trading would then inherit the mirror without ever probing.
    await expect(resolveTradingEndpoint()).rejects.toThrow()
  })

  it('resolves them independently when both are available', async () => {
    stubHosts(['api.binance.com', 'data-api.binance.vision'])
    expect((await resolveEndpoint()).name).toBe('binance.com')
    expect((await resolveTradingEndpoint()).name).toBe('binance.com')
  })
})

// In a one-hour run of the app on 6 October 2026 api.binance.com stopped accepting connections for six
// minutes, and every candle request in them failed: the data host is chosen once and kept.
describe('when the data host stops answering mid-session', () => {
  const PATH = '/klines?symbol=SOLUSDT&interval=1m&limit=2'
  const COM = `https://api.binance.com/api/v3${PATH}`
  const MIRROR = `https://data-api.binance.vision/api/v3${PATH}`

  it('asks the mirror the same, and uses it from then on', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'data-api.binance.vision': 'answers' }
    const tried = stubBehaviour(hosts)
    expect((await resolveEndpoint()).name).toBe('binance.com')
    hosts['api.binance.com'] = 'silent'
    tried.length = 0
    const { response, endpoint } = await fetchMarketData(PATH)
    expect(response.ok).toBe(true)
    expect(endpoint.name).toBe('data-api.binance.vision')
    expect(tried).toEqual([COM, MIRROR])
    expect((await resolveEndpoint()).name).toBe('data-api.binance.vision')
    tried.length = 0
    await fetchMarketData(PATH)
    expect(tried).toEqual([MIRROR])
  })

  it("does the same on a server error, and not on the host's own refusal", async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'data-api.binance.vision': 'answers' }
    const tried = stubBehaviour(hosts)
    await resolveEndpoint()
    hosts['api.binance.com'] = 503
    expect((await fetchMarketData(PATH)).endpoint.name).toBe('data-api.binance.vision')

    // A rate limit is the host's answer: it is not asked again elsewhere.
    resetResolvedEndpoints()
    hosts['api.binance.com'] = 'answers'
    await resolveEndpoint()
    hosts['api.binance.com'] = 429
    tried.length = 0
    const { response, endpoint } = await fetchMarketData(PATH)
    expect(response.status).toBe(429)
    expect(endpoint.name).toBe('binance.com')
    expect(tried).toEqual([COM])
    expect((await resolveEndpoint()).name).toBe('binance.com')
  })

  it('moves only to a host that answers with data: never to a binance.com that refuses the region', async () => {
    // binance.com refuses the region, so the session began on the mirror; the mirror then goes silent.
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 451, 'data-api.binance.vision': 'answers' }
    stubBehaviour(hosts)
    expect((await resolveEndpoint()).name).toBe('data-api.binance.vision')
    hosts['data-api.binance.vision'] = 'silent'
    await expect(fetchMarketData(PATH)).rejects.toThrow('fetch failed')
    expect((await resolveEndpoint()).name).toBe('data-api.binance.vision')
    // And a server error the partner could not cover is handed back as it came.
    hosts['data-api.binance.vision'] = 502
    expect((await fetchMarketData(PATH)).response.status).toBe(502)
  })

  it('never tries binance.us once a session has begun, nor anything else for it', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.us': 'answers' }
    const tried = stubBehaviour(hosts)
    expect((await resolveEndpoint()).name).toBe('binance.us')
    hosts['api.binance.us'] = 'silent'
    tried.length = 0
    await expect(fetchMarketData(PATH)).rejects.toThrow('fetch failed')
    expect(tried).toEqual([`https://api.binance.us/api/v3${PATH}`])
    // And a session on binance.com never moves to binance.us, whatever fails.
    resetResolvedEndpoints()
    const com: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'api.binance.us': 'answers' }
    const comTried = stubBehaviour(com)
    await resolveEndpoint()
    com['api.binance.com'] = 'silent'
    comTried.length = 0
    await expect(fetchMarketData(PATH)).rejects.toThrow('fetch failed')
    expect(comTried.some((url) => url.includes('binance.us'))).toBe(false)
  })

  it('asks the partner once a minute while both are down, and hands back the first failure', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'data-api.binance.vision': 'answers' }
    const tried = stubBehaviour(hosts)
    await resolveEndpoint()
    hosts['api.binance.com'] = 'silent'
    hosts['data-api.binance.vision'] = 'silent'
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    tried.length = 0
    await expect(fetchMarketData(PATH)).rejects.toThrow('fetch failed')
    expect(tried).toEqual([COM, MIRROR])
    // Within the minute: the data host alone.
    now.mockReturnValue(1_000_000 + 59_999)
    tried.length = 0
    await expect(fetchMarketData(PATH)).rejects.toThrow('fetch failed')
    expect(tried).toEqual([COM])
    // A minute on, and the mirror back: it is asked, and used.
    now.mockReturnValue(1_000_000 + 60_000)
    hosts['data-api.binance.vision'] = 'answers'
    tried.length = 0
    expect((await fetchMarketData(PATH)).endpoint.name).toBe('data-api.binance.vision')
    expect(tried).toEqual([COM, MIRROR])
  })

  it('leaves the trading host where it was: data moving to the mirror moves nothing signed', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'data-api.binance.vision': 'answers' }
    stubBehaviour(hosts)
    await resolveEndpoint()
    hosts['api.binance.com'] = 'silent'
    expect((await fetchMarketData(PATH)).endpoint.name).toBe('data-api.binance.vision')
    hosts['api.binance.com'] = 'answers'
    expect((await resolveTradingEndpoint()).name).toBe('binance.com')
  })
})

// In a 24-hour run on 7 October 2026 REST moved to the mirror at 15:44 UTC while the live-price
// socket kept dialling stream.binance.com for the rest of the run. So a move is told to whoever
// listens, and a socket that cannot connect can ask for the partner to be probed.
describe('when the data host moves it is told, and a failing socket can ask for the partner', () => {
  const PATH = '/klines?symbol=SOLUSDT&interval=1m&limit=2'
  const PROBE = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1'

  it('tells a listener once per move, with the host moved to and from, and counts the moves', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'data-api.binance.vision': 'answers' }
    stubBehaviour(hosts)
    expect(currentDataEndpoint()).toBeNull()
    await resolveEndpoint()
    const heard: string[] = []
    const off = onDataHostChange((to, from) => heard.push(`${from.name} -> ${to.name}`))
    expect(currentDataEndpoint()?.name).toBe('binance.com')
    expect(dataHostSwitchCount()).toBe(0)
    hosts['api.binance.com'] = 'silent'
    await fetchMarketData(PATH)
    await fetchMarketData(PATH)
    expect(heard).toEqual(['binance.com -> data-api.binance.vision'])
    expect(dataHostSwitchCount()).toBe(1)
    expect(currentDataEndpoint()?.name).toBe('data-api.binance.vision')
    // And back, once the mirror goes silent and binance.com answers again.
    hosts['api.binance.com'] = 'answers'
    hosts['data-api.binance.vision'] = 'silent'
    await fetchMarketData(PATH)
    expect(heard).toEqual(['binance.com -> data-api.binance.vision', 'data-api.binance.vision -> binance.com'])
    expect(dataHostSwitchCount()).toBe(2)
    // A listener that left hears nothing more; the count goes on.
    off()
    hosts['api.binance.com'] = 'silent'
    hosts['data-api.binance.vision'] = 'answers'
    await fetchMarketData(PATH)
    expect(heard).toHaveLength(2)
    expect(dataHostSwitchCount()).toBe(3)
  })

  it('probes the partner once for a socket that cannot connect, moves when it answers, and tells the listener', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'data-api.binance.vision': 'answers' }
    const tried = stubBehaviour(hosts)
    await resolveEndpoint()
    const heard: string[] = []
    onDataHostChange((to) => heard.push(to.name))
    tried.length = 0
    const partner = await probeDataPartner('the live market socket could not connect')
    expect(partner?.name).toBe('data-api.binance.vision')
    expect(tried).toEqual([PROBE])
    expect(currentDataEndpoint()?.name).toBe('data-api.binance.vision')
    expect(heard).toEqual(['data-api.binance.vision'])
    expect(dataHostSwitchCount()).toBe(1)
  })

  it('answers null when the partner is silent, and does not ask it again within the minute', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'data-api.binance.vision': 'silent' }
    const tried = stubBehaviour(hosts)
    await resolveEndpoint()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    tried.length = 0
    expect(await probeDataPartner('why')).toBeNull()
    expect(tried).toEqual([PROBE])
    expect(currentDataEndpoint()?.name).toBe('binance.com')
    expect(dataHostSwitchCount()).toBe(0)
    now.mockReturnValue(1_000_000 + 59_999)
    tried.length = 0
    expect(await probeDataPartner('why')).toBeNull()
    expect(tried).toEqual([])
    now.mockReturnValue(1_000_000 + 60_000)
    hosts['data-api.binance.vision'] = 'answers'
    expect((await probeDataPartner('why'))?.name).toBe('data-api.binance.vision')
    expect(dataHostSwitchCount()).toBe(1)
  })

  it('never probes binance.us, nor anything for a session on it', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.us': 'answers' }
    const tried = stubBehaviour(hosts)
    expect((await resolveEndpoint()).name).toBe('binance.us')
    tried.length = 0
    expect(await probeDataPartner('why')).toBeNull()
    expect(tried).toEqual([])
    resetResolvedEndpoints()
    const com: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'api.binance.us': 'answers' }
    const comTried = stubBehaviour(com)
    await resolveEndpoint()
    comTried.length = 0
    expect(await probeDataPartner('why')).toBeNull()
    expect(comTried).toEqual([PROBE])
  })

  it('forgets the listeners and the count with the memos', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'data-api.binance.vision': 'answers' }
    stubBehaviour(hosts)
    await resolveEndpoint()
    const heard: string[] = []
    onDataHostChange((to) => heard.push(to.name))
    resetResolvedEndpoints()
    expect(dataHostSwitchCount()).toBe(0)
    await resolveEndpoint()
    hosts['api.binance.com'] = 'silent'
    await fetchMarketData(PATH)
    expect(heard).toEqual([])
    expect(dataHostSwitchCount()).toBe(1)
  })
})

// THE CHART'S OWN SOCKETS FOLLOW THE DATA HOST (the V4 document, §12), by the rule the live-price
// socket keeps: open and receiving, it stays whatever REST does; closed, it follows a REST move at
// once; failing to connect three times in a row, it goes to the host that answers.
describe("a chart's socket", () => {
  const PATH = '/klines?symbol=SOLUSDT&interval=1m&limit=2'

  it('stays while open, follows a REST move while closed, and moves to the host that answers after three failed connects', async () => {
    const hosts: Record<string, Behaviour> = { 'api.binance.com': 'answers', 'data-api.binance.vision': 'answers' }
    stubBehaviour(hosts)
    sockets.made.length = 0
    const stop = await binanceAdapter.subscribeCandles('SOLUSDT', '1m', () => {})
    expect(sockets.made.map((made) => made.url)).toEqual(['wss://stream.binance.com:9443/ws/solusdt@kline_1m'])
    const first = sockets.made[0]
    let closeListener: (() => void) | null = null
    first.handlers.onOpen?.({ on: ((event: string, listener: () => void) => void (event === 'close' && (closeListener = listener))) as () => void })

    // Open and receiving: REST moving to the mirror leaves it where it is.
    hosts['api.binance.com'] = 'silent'
    await fetchMarketData(PATH)
    expect(currentDataEndpoint()?.name).toBe('data-api.binance.vision')
    expect(first.stopped).toBe(false)
    expect(sockets.made).toHaveLength(1)

    // Three connects in a row failed: the host REST is on now is taken, and the old socket stopped.
    first.handlers.onConnectFailed?.(2)
    expect(sockets.made).toHaveLength(1)
    first.handlers.onConnectFailed?.(3)
    await vi.waitFor(() => expect(sockets.made).toHaveLength(2))
    expect(first.stopped).toBe(true)
    expect(sockets.made[1].url).toBe('wss://data-stream.binance.vision/ws/solusdt@kline_1m')

    // Closed, and REST moves back to binance.com: it follows at once.
    const second = sockets.made[1]
    let secondClose: (() => void) | null = null
    second.handlers.onOpen?.({ on: ((event: string, listener: () => void) => void (event === 'close' && (secondClose = listener))) as () => void })
    secondClose?.()
    hosts['api.binance.com'] = 'answers'
    hosts['data-api.binance.vision'] = 'silent'
    await fetchMarketData(PATH)
    expect(currentDataEndpoint()?.name).toBe('binance.com')
    expect(second.stopped).toBe(true)
    expect(sockets.made).toHaveLength(3)
    expect(sockets.made[2].url).toBe('wss://stream.binance.com:9443/ws/solusdt@kline_1m')

    // Stopped for good: nothing follows any more.
    stop()
    expect(sockets.made[2].stopped).toBe(true)
    hosts['api.binance.com'] = 'silent'
    hosts['data-api.binance.vision'] = 'answers'
    await fetchMarketData(PATH)
    expect(sockets.made).toHaveLength(3)
    expect(closeListener).not.toBeNull()
  })

  it('opens the ticker the same way, on the data host of the moment', async () => {
    stubBehaviour({ 'api.binance.com': 451, 'data-api.binance.vision': 'answers' })
    sockets.made.length = 0
    const stop = await binanceAdapter.subscribeTicker('SOLUSDT', () => {})
    expect(sockets.made.map((made) => made.url)).toEqual(['wss://data-stream.binance.vision/ws/solusdt@ticker'])
    stop()
    expect(sockets.made[0].stopped).toBe(true)
  })
})

// On 13 October 2026 the first requests of a session each ran a probe of their own, and the last to
// finish set the host: one whose request to the mirror timed out went on to binance.us and set it
// after the others had chosen the mirror. The forecast's bars for the session came from another
// market (found by V6 Stage 2's check: a bar of BTCUSDT with no volume at all, as binance.us has it).
describe('the first resolution of a session', () => {
  const PROBE = 'klines?symbol=BTCUSDT&interval=1m&limit=1'

  it('is one probe, shared by every request that arrives while it is under way', async () => {
    const tried = stubBehaviour({ 'api.binance.com': 451, 'data-api.binance.vision': 'answers' })
    const all = await Promise.all(Array.from({ length: 5 }, () => resolveEndpoint()))
    expect(new Set(all.map((endpoint) => endpoint.name))).toEqual(new Set(['data-api.binance.vision']))
    expect(tried.filter((url) => url.includes(PROBE))).toEqual([
      `https://api.binance.com/api/v3/${PROBE}`,
      `https://data-api.binance.vision/api/v3/${PROBE}`
    ])
  })

  it('gives binance.com and the mirror a second round before binance.us', async () => {
    let mirrorAsked = 0
    const tried: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      const u = String(url)
      tried.push(u)
      if (u.includes('api.binance.com')) return Promise.resolve({ ok: false, status: 451, statusText: 'Refused', json: () => Promise.resolve({ code: 0 }) })
      if (u.includes('data-api.binance.vision')) {
        mirrorAsked++
        // The mirror's first request times out; the next answers.
        if (mirrorAsked === 1) return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(KLINE) })
      }
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(KLINE) })
    })
    expect((await resolveEndpoint()).name).toBe('data-api.binance.vision')
    expect(tried.some((url) => url.includes('api.binance.us'))).toBe(false)
  })

  it('goes to binance.us only after both rounds failed, and names each host once when none answers', async () => {
    const tried = stubBehaviour({ 'api.binance.com': 451, 'api.binance.us': 'answers' })
    expect((await resolveEndpoint()).name).toBe('binance.us')
    expect(tried.filter((url) => url.includes(PROBE)).map((url) => new URL(url).host)).toEqual([
      'api.binance.com',
      'data-api.binance.vision',
      'api.binance.com',
      'data-api.binance.vision',
      'api.binance.us'
    ])
    resetResolvedEndpoints()
    stubBehaviour({})
    await expect(resolveEndpoint()).rejects.toThrow('(tried: binance.com, data-api.binance.vision, binance.us)')
  })

  it('resolves the trading host once for every request that arrives while it is under way', async () => {
    const tried = stubBehaviour({ 'api.binance.com': 'answers' })
    const all = await Promise.all(Array.from({ length: 4 }, () => resolveTradingEndpoint()))
    expect(all.every((endpoint) => endpoint.name === 'binance.com')).toBe(true)
    expect(tried.filter((url) => url.includes(PROBE))).toHaveLength(1)
  })

  it('tells which hosts serve binance.com\'s market', async () => {
    const { servesBinanceComMarket } = await import('../electron/services/exchanges/binance')
    expect(servesBinanceComMarket({ name: 'binance.com' })).toBe(true)
    expect(servesBinanceComMarket({ name: 'data-api.binance.vision' })).toBe(true)
    expect(servesBinanceComMarket({ name: 'binance.us' })).toBe(false)
  })
})

describe('a range read (V8 Stage 1)', () => {
  it("reads binance.com's market or nothing: a session on binance.us is refused, not scored as Binance's prices", async () => {
    stubHosts(['api.binance.us'])
    expect((await resolveEndpoint()).name).toBe('binance.us')
    await expect(binanceAdapter.fetchHistoricalRange('BTCUSDT', '1m', 1_700_000_000, 1_700_003_600, () => undefined, () => false)).rejects.toThrow(
      "binance.us serves another market's prices: a range is read from binance.com or its mirror only."
    )
  })

  it('reads the mirror, page by page, behind the reads that cannot wait', async () => {
    const tried = stubHosts(['data-api.binance.vision'])
    const candles = await binanceAdapter.fetchHistoricalRange('BTCUSDT', '1m', 0, 60, () => undefined, () => false)
    expect(candles).toHaveLength(1)
    expect(tried.at(-1)).toMatch(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines\?symbol=BTCUSDT&interval=1m&startTime=0&endTime=60000&limit=1000$/)
  })
})
