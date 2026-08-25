import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closingSide } from '../electron/services/exchanges/binanceFuturesTrading'

// The only write this app can make to a futures account. Everything here is about the two ways it
// could go wrong that cost real money: sending the wrong side, which DOUBLES a leveraged position
// instead of closing it, and reporting a close that did not happen, which leaves someone believing
// they are out of a position that is still open and still leveraged.

describe('the side that closes a position', () => {
  it('sells to close a long and buys to close a short', () => {
    // Backwards, this doubles the position rather than closing it -- on a leveraged position that
    // is the difference between exiting and reaching liquidation twice as fast.
    expect(closingSide(0.01)).toBe('SELL')
    expect(closingSide(-0.01)).toBe('BUY')
  })

  it('reads a tiny position the same way as a large one', () => {
    expect(closingSide(0.000_001)).toBe('SELL')
    expect(closingSide(-0.000_001)).toBe('BUY')
  })
})

describe('closing a position', () => {
  const captured: { url: string; method: string }[] = []
  let respond: () => { ok: boolean; status: number; body: unknown }

  beforeEach(() => {
    captured.length = 0
    respond = () => ({ ok: true, status: 200, body: { orderId: 1, status: 'FILLED', executedQty: '0.01', avgPrice: '59000' } })
    vi.stubGlobal('fetch', (url: string, init?: { method?: string }) => {
      const u = String(url)
      captured.push({ url: u, method: init?.method ?? 'GET' })
      if (u.includes('/fapi/v1/time')) {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve({ serverTime: Date.now() }) })
      }
      const r = respond()
      return Promise.resolve({ ok: r.ok, status: r.status, statusText: 'x', json: () => Promise.resolve(r.body) })
    })
  })

  /** Re-imported per test so the module's cached server-time offset cannot carry between them. */
  async function close(symbol: string, positionAmt: number) {
    vi.resetModules()
    const mod = await import('../electron/services/exchanges/binanceFuturesTrading')
    return mod.closeFuturesPosition('k', 's', symbol, positionAmt)
  }

  it('sends a reduce-only market order for the exact position size', async () => {
    await close('BTCUSDT', 0.01)
    const order = captured.find((c) => c.url.includes('/fapi/v1/order'))

    expect(order?.method).toBe('POST')
    expect(order?.url).toContain('side=SELL')
    expect(order?.url).toContain('type=MARKET')
    expect(order?.url).toContain('quantity=0.01')
    // Belt and braces on top of the exact size: if the position moved between being read and this
    // arriving, the exchange itself refuses to open the opposite one.
    expect(order?.url).toContain('reduceOnly=true')
  })

  it('sends the size without its sign, because direction is the side', async () => {
    await close('BTCUSDT', -0.01)
    const order = captured.find((c) => c.url.includes('/fapi/v1/order'))

    expect(order?.url).toContain('side=BUY')
    expect(order?.url).toContain('quantity=0.01')
    expect(order?.url).not.toContain('quantity=-0.01')
  })

  it('never puts the secret or the key in the URL beyond the signature Binance requires', async () => {
    await close('BTCUSDT', 0.01)
    const order = captured.find((c) => c.url.includes('/fapi/v1/order'))

    expect(order?.url).not.toContain('apiSecret')
    expect(order?.url).not.toContain('=s&')
    expect(order?.url).toContain('signature=')
  })

  it('refuses to send anything for a position that is not there', async () => {
    // A zero-size "close" would be an order to open, and reduceOnly is not something to rely on
    // for a mistake this app can catch itself.
    for (const amount of [0, Number.NaN]) {
      await expect(close('BTCUSDT', amount)).rejects.toThrow(/no open BTCUSDT position/)
      expect(captured.some((c) => c.url.includes('/fapi/v1/order'))).toBe(false)
    }
  })

  it('reports what actually filled', async () => {
    const result = await close('BTCUSDT', 0.01)

    expect(result).toEqual({ orderId: 1, status: 'FILLED', closedQty: 0.01, avgPrice: 59_000 })
  })

  it('reports no fill price rather than a price of zero', async () => {
    // Binance sends "0" before a fill price is known. Passed through, it shows a close at nothing.
    respond = () => ({ ok: true, status: 200, body: { orderId: 2, status: 'NEW', executedQty: '0', avgPrice: '0' } })
    const result = await close('BTCUSDT', 0.01)

    expect(result.avgPrice).toBeNull()
  })

  it('refuses to call a 200 with no order a successful close', async () => {
    // The worst possible outcome here is a false success: the user stops worrying about a
    // position that is still open and still leveraged.
    respond = () => ({ ok: true, status: 200, body: { msg: 'something else entirely' } })

    await expect(close('BTCUSDT', 0.01)).rejects.toThrow(/still open/)
  })

  it('explains a rejected key rather than repeating the exchange at the user', async () => {
    // A spot key without futures permission is the overwhelmingly likely cause, and sending
    // someone to regenerate a perfectly good key is the wrong advice.
    respond = () => ({ ok: false, status: 401, body: { code: -2015, msg: 'Invalid API-key' } })

    await expect(close('BTCUSDT', 0.01)).rejects.toThrow(/Enable Futures/)
  })

  it('passes an ordinary exchange error through so it can be acted on', async () => {
    respond = () => ({ ok: false, status: 400, body: { code: -2022, msg: 'ReduceOnly Order is rejected.' } })

    await expect(close('BTCUSDT', 0.01)).rejects.toThrow(/ReduceOnly Order is rejected/)
  })
})
