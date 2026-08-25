import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two writes that put a stop on a real position and take it off again. What is checked here
// is what the exchange actually receives: a stop sent with a quantity instead of closePosition,
// or on the wrong side, is not a weaker version of protection -- it is an order that can make the
// position bigger.

describe('placing a protective stop', () => {
  const captured: { url: string; method: string }[] = []
  let respond: () => { ok: boolean; status: number; body: unknown }

  beforeEach(() => {
    captured.length = 0
    respond = () => ({ ok: true, status: 200, body: { orderId: 55, type: 'STOP_MARKET', stopPrice: '58000', closePosition: true } })
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
  async function place(symbol: string, positionAmt: number, stopPrice: number) {
    vi.resetModules()
    const mod = await import('../electron/services/exchanges/binanceFuturesTrading')
    return mod.placeProtectiveStop('k', 's', symbol, positionAmt, stopPrice)
  }

  async function cancel(symbol: string, orderId: number) {
    vi.resetModules()
    const mod = await import('../electron/services/exchanges/binanceFuturesTrading')
    return mod.cancelProtectiveStop('k', 's', symbol, orderId)
  }

  const orderRequest = () => captured.find((c) => c.url.includes('/fapi/v1/order'))

  it('sends a closePosition stop on the side that closes the position', async () => {
    await place('BTCUSDT', 0.01, 58_000)

    expect(orderRequest()?.method).toBe('POST')
    expect(orderRequest()?.url).toContain('side=SELL')
    expect(orderRequest()?.url).toContain('type=STOP_MARKET')
    expect(orderRequest()?.url).toContain('stopPrice=58000')
    expect(orderRequest()?.url).toContain('closePosition=true')
  })

  it('never sends a quantity or reduceOnly alongside closePosition', async () => {
    // Binance rejects the combination outright, but the reason to assert it is what a quantity
    // would mean if it were ever accepted: a stop sized at placement time can be outgrown by the
    // position, leaving a remainder open at whatever leverage it was carrying.
    await place('BTCUSDT', 0.01, 58_000)

    expect(orderRequest()?.url).not.toContain('quantity=')
    expect(orderRequest()?.url).not.toContain('reduceOnly=')
  })

  it('triggers on the mark price, the same number the exchange liquidates against', async () => {
    // On the last traded price instead, one wick on a thin book closes a position the exchange
    // itself was nowhere near touching.
    await place('BTCUSDT', 0.01, 58_000)

    expect(orderRequest()?.url).toContain('workingType=MARK_PRICE')
  })

  it('buys to protect a short', async () => {
    await place('ETHUSDT', -0.5, 3_100)

    expect(orderRequest()?.url).toContain('side=BUY')
  })

  it('refuses to place a stop on a position that is not there', async () => {
    for (const amount of [0, Number.NaN]) {
      await expect(place('BTCUSDT', amount, 58_000)).rejects.toThrow(/no open BTCUSDT position to protect/)
      expect(orderRequest()).toBeUndefined()
    }
  })

  it('refuses a stop price that is not a price', async () => {
    for (const bad of [0, -1, Number.NaN]) {
      await expect(place('BTCUSDT', 0.01, bad)).rejects.toThrow(/not a price this app will send/)
      expect(orderRequest()).toBeUndefined()
    }
  })

  it('reports the trigger the exchange recorded, not the one that was asked for', async () => {
    // Binance rounds to the symbol tick size. Reporting the requested price would show a stop at
    // a level that is not the level actually resting on the account.
    respond = () => ({ ok: true, status: 200, body: { orderId: 55, type: 'STOP_MARKET', stopPrice: '58000.5', closePosition: true } })
    const stop = await place('BTCUSDT', 0.01, 58_000.51)

    expect(stop.stopPrice).toBe(58_000.5)
  })

  it('falls back to the requested price when the echo cannot be read', async () => {
    // The order exists -- it came back with an id. An approximate price describes it better than
    // refusing to describe it at all.
    respond = () => ({ ok: true, status: 200, body: { orderId: 55, closePosition: true } })
    const stop = await place('BTCUSDT', 0.01, 58_000)

    expect(stop.stopPrice).toBe(58_000)
    expect(stop.type).toBe('STOP_MARKET')
  })

  it('refuses to call a 200 with no order a placed stop', async () => {
    // The worst outcome available here: someone believes a position is protected, stops watching
    // it, and nothing is guarding it at all.
    respond = () => ({ ok: true, status: 200, body: { msg: 'something else entirely' } })

    await expect(place('BTCUSDT', 0.01, 58_000)).rejects.toThrow(/unprotected/)
  })

  it('explains a rejected key rather than repeating the exchange at the user', async () => {
    respond = () => ({ ok: false, status: 401, body: { code: -2015, msg: 'Invalid API-key' } })

    await expect(place('BTCUSDT', 0.01, 58_000)).rejects.toThrow(/Enable Futures/)
  })

  it('passes an immediate-trigger rejection through so it can be acted on', async () => {
    respond = () => ({ ok: false, status: 400, body: { code: -2021, msg: 'Order would immediately trigger.' } })

    await expect(place('BTCUSDT', 0.01, 58_000)).rejects.toThrow(/immediately trigger/)
  })

  it('cancels by order id, with a DELETE', async () => {
    await cancel('BTCUSDT', 55)

    expect(orderRequest()?.method).toBe('DELETE')
    expect(orderRequest()?.url).toContain('orderId=55')
    expect(orderRequest()?.url).toContain('symbol=BTCUSDT')
  })

  it('treats a stop that is already gone as cancelled', async () => {
    // It triggered, or it was cancelled on the phone. The user asked for it not to be there and
    // it is not there; reporting a failure would send them looking for a problem that is not one.
    respond = () => ({ ok: false, status: 400, body: { code: -2011, msg: 'Unknown order sent.' } })

    await expect(cancel('BTCUSDT', 55)).resolves.toBeUndefined()
  })

  it('does not swallow any other cancellation failure', async () => {
    // Every other reason means the stop may well still be resting, and a silent success would
    // tell the user their protection was gone when it was not -- or the reverse.
    respond = () => ({ ok: false, status: 400, body: { code: -1102, msg: 'Mandatory parameter was not sent.' } })

    await expect(cancel('BTCUSDT', 55)).rejects.toThrow(/Mandatory parameter/)
  })

  it('refuses an order id that is not one, without sending anything', async () => {
    await expect(cancel('BTCUSDT', Number.NaN)).rejects.toThrow(/not an order id/)
    expect(orderRequest()).toBeUndefined()
  })

  it('never puts the key or secret in the URL beyond the signature Binance requires', async () => {
    await place('BTCUSDT', 0.01, 58_000)

    expect(orderRequest()?.url).not.toContain('apiSecret')
    expect(orderRequest()?.url).toContain('signature=')
  })
})
