import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const { ENDPOINTS_FOR_TEST, resolveEndpoint, resolveTradingEndpoint, resetResolvedEndpoints } = await import(
  '../electron/services/exchanges/binance'
)

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
})

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
