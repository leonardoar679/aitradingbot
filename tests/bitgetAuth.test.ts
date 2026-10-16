import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BITGET_DEMO_HEADER, BitgetRefusal, CLASSIC_ACCOUNT_CODE, bitgetHeaders, bitgetPreHash, bitgetSignature, bitgetSigned, describeBitgetRefusal, isClassicRefusal, resetBitgetClock } from '../electron/services/exchanges/bitgetAuth'
import { fetchBitgetAccount, fetchBitgetAccountSettings, fetchBitgetAssets } from '../electron/services/exchanges/bitgetTrading'
import { BITGET_ACCOUNT_PATHS, CLASSIC_MODE, balancesOf, bitgetAccountTypeOf, classicBalancesOf } from '../electron/services/exchanges/bitgetAccount'
import { fetchBitgetDemoAccount, fetchBitgetDemoAccountSettings, fetchBitgetDemoAssets } from '../electron/services/exchanges/bitgetDemoTrading'

// BITGET'S SIGNED REQUESTS (electron/services/exchanges/bitgetAuth.ts, bitgetAccount.ts,
// bitgetTrading.ts, bitgetDemoTrading.ts; V7.1 Stage 7): the string signed, the headers, the demo
// header on a demo request and on nothing else, the real account's reads, a CLASSIC account's reads
// over its own endpoint after the unified ones refuse it (16 October 2026), and the two modules kept
// apart.

const ROOT = join(__dirname, '..')
const CREDENTIALS = { apiKey: 'bg_key', apiSecret: 'bg_secret', passphrase: 'bg_pass' }
const ok = (data: unknown): Promise<Response> => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: '00000', msg: 'success', requestTime: 1, data }) } as Response)

describe('the string signed and the headers', () => {
  it("is the timestamp, the method in capitals, the path, the query after a question mark and the body, as Bitget's quick start gives it", () => {
    expect(bitgetPreHash('16273667805456', 'GET', '/api/v3/account/fee-rate', 'category=SPOT&symbol=BTCUSDT', '')).toBe('16273667805456GET/api/v3/account/fee-rate?category=SPOT&symbol=BTCUSDT')
    expect(bitgetPreHash('16273667805456', 'POST', '/api/v3/trade/place-order', '', '{"category":"SPOT"}')).toBe('16273667805456POST/api/v3/trade/place-order{"category":"SPOT"}')
    expect(bitgetPreHash('1', 'GET', '/api/v3/account/assets', '', '')).toBe('1GET/api/v3/account/assets')
  })

  it('signs with HMAC-SHA256 under the secret, written in base64', () => {
    const preHash = '16273667805456GET/api/v3/account/assets'
    expect(bitgetSignature('bg_secret', preHash)).toBe(createHmac('sha256', 'bg_secret').update(preHash).digest('base64'))
    expect(bitgetSignature('bg_secret', preHash)).not.toBe(bitgetSignature('other', preHash))
  })

  it('carries the key, the signature, the timestamp and the passphrase, and the demo header on a demo request alone', () => {
    const real = bitgetHeaders(CREDENTIALS, '1700000000000', 'GET', '/api/v3/account/assets', '', '', false)
    expect(real).toEqual({
      'ACCESS-KEY': 'bg_key',
      'ACCESS-SIGN': bitgetSignature('bg_secret', '1700000000000GET/api/v3/account/assets'),
      'ACCESS-TIMESTAMP': '1700000000000',
      'ACCESS-PASSPHRASE': 'bg_pass',
      'Content-Type': 'application/json',
      locale: 'en-US'
    })
    expect(Object.keys(real)).not.toContain('paptrading')
    const demo = bitgetHeaders(CREDENTIALS, '1700000000000', 'GET', '/api/v3/account/assets', '', '', true)
    expect(demo).toEqual({ ...real, paptrading: '1' })
    expect(BITGET_DEMO_HEADER).toEqual({ name: 'paptrading', value: '1' })
  })
})

describe('a signed request', () => {
  const asked: { url: string; init: RequestInit }[] = []

  beforeEach(() => {
    asked.length = 0
    resetBitgetClock()
    vi.unstubAllGlobals()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'))
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      asked.push({ url: String(url), init })
      // Bitget's clock stands two seconds ahead of this machine's.
      if (String(url).includes('/api/v3/market/time')) return ok({ serverTime: String(Date.now() + 2000) })
      if (String(url).includes('/api/v3/account/assets')) {
        return ok({ accountEquity: '1234.5', assets: [{ coin: 'USDT', available: '1000.5', locked: '200', equity: '1200.5' }, { coin: 'BTC', available: '0.01', locked: '0' }] })
      }
      if (String(url).includes('/api/v3/account/settings')) return ok({ uid: '1', accountMode: 'UNION', assetMode: 'single', holdMode: 'one_way_mode' })
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ code: '40404', msg: 'not found', data: null }) })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("reads the real account's balances and its mode over a real request, timed by Bitget's clock, with the headers and no demo header", async () => {
    expect(await fetchBitgetAssets(CREDENTIALS)).toEqual([
      { asset: 'USDT', free: 1000.5, locked: 200 },
      { asset: 'BTC', free: 0.01, locked: 0 }
    ])
    expect(asked.map((entry) => entry.url)).toEqual(['https://api.bitget.com/api/v3/market/time', 'https://api.bitget.com/api/v3/account/assets'])
    const headers = asked[1].init.headers as Record<string, string>
    expect(headers['ACCESS-KEY']).toBe('bg_key')
    expect(headers['ACCESS-PASSPHRASE']).toBe('bg_pass')
    expect(Number(headers['ACCESS-TIMESTAMP'])).toBe(Date.now() + 2000)
    expect(headers['ACCESS-SIGN']).toBe(bitgetSignature('bg_secret', `${headers['ACCESS-TIMESTAMP']}GET/api/v3/account/assets`))
    expect(headers).not.toHaveProperty('paptrading')
    expect(asked[1].init.method).toBe('GET')
    expect(asked[1].init.body).toBeUndefined()
    expect(await fetchBitgetAccountSettings(CREDENTIALS)).toEqual({ accountMode: 'UNION', assetMode: 'single', holdMode: 'one_way_mode' })
    // The clock is read once in five minutes, not for every request.
    expect(asked.filter((entry) => entry.url.includes('/market/time'))).toHaveLength(1)
    // The read whole: a unified account's balances, not the Classic endpoint's.
    expect(await fetchBitgetAccount(CREDENTIALS)).toEqual({
      balances: [
        { asset: 'USDT', free: 1000.5, locked: 200 },
        { asset: 'BTC', free: 0.01, locked: 0 }
      ],
      classic: false
    })
  })

  it('reads the demo account through the demo module alone, which sends the demo header', async () => {
    expect(await fetchBitgetDemoAssets(CREDENTIALS)).toEqual([
      { asset: 'USDT', free: 1000.5, locked: 200 },
      { asset: 'BTC', free: 0.01, locked: 0 }
    ])
    const headers = asked[1].init.headers as Record<string, string>
    expect(headers.paptrading).toBe('1')
  })

  it('signs the query it sends, and a body as sent', async () => {
    await bitgetSigned(CREDENTIALS, { method: 'GET', path: '/api/v3/account/assets', query: { category: 'SPOT', symbol: 'BTCUSDT' }, what: 'x' }, false)
    expect(asked[1].url).toBe('https://api.bitget.com/api/v3/account/assets?category=SPOT&symbol=BTCUSDT')
    const get = asked[1].init.headers as Record<string, string>
    expect(get['ACCESS-SIGN']).toBe(bitgetSignature('bg_secret', `${get['ACCESS-TIMESTAMP']}GET/api/v3/account/assets?category=SPOT&symbol=BTCUSDT`))
    await bitgetSigned(CREDENTIALS, { method: 'POST', path: '/api/v3/account/assets', body: { category: 'SPOT', qty: '1' }, what: 'x' }, false)
    const post = asked[2].init
    expect(post.method).toBe('POST')
    expect(post.body).toBe('{"category":"SPOT","qty":"1"}')
    expect((post.headers as Record<string, string>)['ACCESS-SIGN']).toBe(bitgetSignature('bg_secret', `${(post.headers as Record<string, string>)['ACCESS-TIMESTAMP']}POST/api/v3/account/assets{"category":"SPOT","qty":"1"}`))
  })

  it("refuses with Bitget's code and words, and says what a refusal of a key usually means, for the real and the demo account", async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).includes('/market/time')) return ok({ serverTime: String(Date.now()) })
      return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ code: '40037', msg: 'Apikey does not exist', data: null }) })
    })
    await expect(fetchBitgetAssets(CREDENTIALS)).rejects.toThrow("Bitget account read failed: 40037 Apikey does not exist. A real request needs a key made in the real account, not a demo one.")
    await expect(fetchBitgetDemoAssets(CREDENTIALS)).rejects.toThrow("Bitget demo account read failed: 40037 Apikey does not exist. A demo request needs a key made in Bitget's demo mode, not the real one.")
    expect(describeBitgetRefusal('account read', 400, { code: '40012', msg: 'Incorrect passphrase' }, false)).toBe('Bitget account read failed: 40012 Incorrect passphrase. The passphrase is the one set when the key was made.')
    expect(describeBitgetRefusal('account read', 400, { code: '40009', msg: 'sign signature error' }, false)).toBe("Bitget account read failed: 40009 sign signature error. The secret, or this machine's clock, does not match the key.")
    expect(describeBitgetRefusal('account read', 429, { code: '429', msg: 'Too Many Requests' }, false)).toBe('Bitget account read failed: too many requests (429 Too Many Requests).')
    expect(describeBitgetRefusal('account read', 502, null, false)).toBe('Bitget account read failed: 502')
    // A 200 whose code is not success is a refusal too.
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).includes('/market/time')) return ok({ serverTime: String(Date.now()) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: '40001', msg: 'request too frequent', data: null }) })
    })
    await expect(fetchBitgetAssets(CREDENTIALS)).rejects.toThrow('Bitget account read failed: 40001 request too frequent')
    // A clock that cannot be read is this machine's.
    vi.stubGlobal('fetch', (url: string) => (String(url).includes('/market/time') ? Promise.reject(new Error('down')) : ok({ assets: [] })))
    resetBitgetClock()
    expect(await fetchBitgetAssets(CREDENTIALS)).toEqual([])
  })
})

describe('a Classic account, which refuses the unified reads', () => {
  const asked: { url: string; init: RequestInit }[] = []
  const CLASSIC_MSG = 'You are in Classic Account mode, and the Unified Account API is not supported at this time'
  const classicRefusal = (): Promise<Response> => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ code: CLASSIC_ACCOUNT_CODE, msg: CLASSIC_MSG, requestTime: 1, data: null }) } as Response)
  /** The Classic spot account's rows, as its documentation gives them; the envelope's text key is `message` there. */
  const classicRows = (): Promise<Response> =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          code: '00000',
          message: 'success',
          requestTime: 1,
          data: [
            { coin: 'USDT', available: '150.5', frozen: '20', locked: '5', limitAvailable: '0', uTime: '1' },
            { coin: 'BTC', available: '0.01', frozen: '0', locked: '0', limitAvailable: '0', uTime: '1' }
          ]
        })
    } as Response)

  beforeEach(() => {
    asked.length = 0
    resetBitgetClock()
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      asked.push({ url: String(url), init })
      const u = String(url)
      if (u.includes('/api/v3/market/time')) return ok({ serverTime: String(Date.now()) })
      if (u.includes('/api/v3/account/') || u.includes('/api/v3/trade/')) return classicRefusal()
      if (u.includes('/api/v2/spot/account/assets')) return classicRows()
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ code: '40404', msg: 'not found', data: null }) })
    })
  })

  it("reads the balances over the Classic spot account's endpoint once the unified read refuses with 40084, signed as any request and with no demo header", async () => {
    expect(await fetchBitgetAssets(CREDENTIALS)).toEqual([
      { asset: 'USDT', free: 150.5, locked: 25 },
      { asset: 'BTC', free: 0.01, locked: 0 }
    ])
    expect(asked.map((entry) => entry.url)).toEqual(['https://api.bitget.com/api/v3/market/time', 'https://api.bitget.com/api/v3/account/assets', 'https://api.bitget.com/api/v2/spot/account/assets'])
    const headers = asked[2].init.headers as Record<string, string>
    expect(headers['ACCESS-KEY']).toBe('bg_key')
    expect(headers['ACCESS-PASSPHRASE']).toBe('bg_pass')
    expect(headers['ACCESS-SIGN']).toBe(bitgetSignature('bg_secret', `${headers['ACCESS-TIMESTAMP']}GET/api/v2/spot/account/assets`))
    expect(headers).not.toHaveProperty('paptrading')
    expect(asked[2].init.method).toBe('GET')
    expect(asked[2].init.body).toBeUndefined()
    expect(BITGET_ACCOUNT_PATHS).toEqual({ assets: '/api/v3/account/assets', settings: '/api/v3/account/settings', classicAssets: '/api/v2/spot/account/assets' })
    // The read whole says the balances came from the Classic endpoint: the proof the key store keeps.
    expect(await fetchBitgetAccount(CREDENTIALS)).toEqual({
      balances: [
        { asset: 'USDT', free: 150.5, locked: 25 },
        { asset: 'BTC', free: 0.01, locked: 0 }
      ],
      classic: true
    })
  })

  it('is said to be CLASSIC where its settings are refused as such, which the app reads as a classic account', async () => {
    expect(await fetchBitgetAccountSettings(CREDENTIALS)).toEqual({ accountMode: 'CLASSIC' })
    expect(CLASSIC_MODE).toBe('CLASSIC')
    expect(bitgetAccountTypeOf((await fetchBitgetAccountSettings(CREDENTIALS)).accountMode)).toBe('classic')
    expect(asked.filter((entry) => entry.url.includes('/api/v2/'))).toEqual([])
  })

  it('is read through the demo module the same way, every request with the demo header', async () => {
    expect(await fetchBitgetDemoAssets(CREDENTIALS)).toEqual([
      { asset: 'USDT', free: 150.5, locked: 25 },
      { asset: 'BTC', free: 0.01, locked: 0 }
    ])
    expect(asked.slice(1).map((entry) => (entry.init.headers as Record<string, string>).paptrading)).toEqual(['1', '1'])
    expect(await fetchBitgetDemoAccountSettings(CREDENTIALS)).toEqual({ accountMode: 'CLASSIC' })
    expect((await fetchBitgetDemoAccount(CREDENTIALS)).classic).toBe(true)
  })

  it('falls back on the Classic code alone: any other refusal of a unified read is thrown as it is and the Classic endpoint is not asked, and a Classic read that fails is refused in its own words', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      asked.push({ url: String(url), init: {} })
      if (String(url).includes('/market/time')) return ok({ serverTime: String(Date.now()) })
      return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ code: '40037', msg: 'Apikey does not exist', data: null }) })
    })
    await expect(fetchBitgetAssets(CREDENTIALS)).rejects.toThrow('Bitget account read failed: 40037 Apikey does not exist')
    await expect(fetchBitgetAccountSettings(CREDENTIALS)).rejects.toThrow('Bitget account settings failed: 40037 Apikey does not exist')
    expect(asked.some((entry) => entry.url.includes('/api/v2/'))).toBe(false)
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).includes('/market/time')) return ok({ serverTime: String(Date.now()) })
      if (String(url).includes('/api/v3/')) return classicRefusal()
      return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ code: '40014', msg: 'Incorrect permissions', data: null }) })
    })
    await expect(fetchBitgetAssets(CREDENTIALS)).rejects.toThrow('Bitget Classic account read failed: 40014 Incorrect permissions')
  })

  it("carries Bitget's code on every refusal, knows the Classic one by it, and says the way to the unified account in its words", async () => {
    const error = await bitgetSigned(CREDENTIALS, { method: 'POST', path: '/api/v3/trade/place-order', body: { category: 'SPOT' }, what: 'place buy BTCUSDT' }, false).then(
      () => null,
      (refusal: unknown) => refusal
    )
    expect(error).toBeInstanceOf(BitgetRefusal)
    expect(error).toMatchObject({ name: 'BitgetRefusal', code: '40084', status: 400 })
    expect(CLASSIC_ACCOUNT_CODE).toBe('40084')
    expect(isClassicRefusal(error)).toBe(true)
    expect(isClassicRefusal(new BitgetRefusal('x', '40037', 400))).toBe(false)
    expect(isClassicRefusal(new Error('40084'))).toBe(false)
    expect((error as Error).message).toBe(
      `Bitget place buy BTCUSDT failed: 40084 ${CLASSIC_MSG}. This key's account is in Classic mode: its balance is read, and an order needs the Unified Trading Account. Switch the account on Bitget (Assets, Upgrade to Unified Account), then test the key again on Connections.`
    )
    // A refusal of a key is still read as one, with its code beside the words.
    const other = await bitgetSigned(CREDENTIALS, { method: 'GET', path: '/api/v3/market/nothing', what: 'x' }, false).then(
      () => null,
      (refusal: unknown) => refusal
    )
    expect(other).toMatchObject({ name: 'BitgetRefusal', code: '40404', status: 404, message: 'Bitget x failed: 40404 not found' })
    // The words are read from `message` too, as the Classic documentation spells the key.
    expect(describeBitgetRefusal('x', 400, { code: '40014', message: 'Incorrect permissions' }, false)).toBe('Bitget x failed: 40014 Incorrect permissions')
  })
})

describe("the account's rows and its mode", () => {
  it('reads a coin\'s spendable amount and what its orders hold, a row that cannot be read becoming NaN by name, and refuses a response without the list', () => {
    expect(balancesOf({ assets: [{ coin: 'ETH', available: '2', locked: '0.5' }, { coin: 'X', available: 'n/a', locked: '0' }] })).toEqual([
      { asset: 'ETH', free: 2, locked: 0.5 },
      { asset: 'X', free: Number.NaN, locked: 0 }
    ])
    expect(() => balancesOf({})).toThrow('Bitget returned an account response without an asset list')
    expect(() => balancesOf(null)).toThrow('Bitget returned an account response without an asset list')
  })

  it("reads the Classic account's rows: available as spendable, frozen and locked together as held, a row that cannot be read becoming NaN by name, and refuses a response that is not a list", () => {
    expect(classicBalancesOf([{ coin: 'ETH', available: '2', frozen: '0.5', locked: '0.25' }, { coin: 'X', available: 'n/a', frozen: '0', locked: '0' }])).toEqual([
      { asset: 'ETH', free: 2, locked: 0.75 },
      { asset: 'X', free: Number.NaN, locked: 0 }
    ])
    expect(() => classicBalancesOf({ assets: [] } as unknown as never)).toThrow('Bitget returned a Classic account response without an asset list')
    expect(() => classicBalancesOf(null)).toThrow('Bitget returned a Classic account response without an asset list')
  })

  it('tells a unified account in either mode from a classic one, and knows neither from a word it has not seen', () => {
    expect(bitgetAccountTypeOf('UNION')).toBe('uta')
    expect(bitgetAccountTypeOf('isolated')).toBe('uta')
    expect(bitgetAccountTypeOf('CLASSIC')).toBe('classic')
    expect(bitgetAccountTypeOf('')).toBe('unknown')
    expect(bitgetAccountTypeOf(null)).toBe('unknown')
    expect(bitgetAccountTypeOf('PORTFOLIO')).toBe('unknown')
  })
})

describe('the real and the demo modules, kept apart', () => {
  const source = (name: string): string => readFileSync(join(ROOT, 'electron', 'services', 'exchanges', name), 'utf-8')

  it('the real module never sends a demo request, and the demo module never sends a real one', () => {
    const real = source('bitgetTrading.ts')
    expect(real).not.toMatch(/paptrading|demo: true|, true\)/)
    expect(real.match(/bitgetSigned</g)?.length ?? 0).toBeGreaterThan(0)
    for (const call of real.match(/bitgetSigned<[^\n]*\n?[^\n]*/g) ?? []) expect(call).toMatch(/false\)/)
    const demo = source('bitgetDemoTrading.ts')
    expect(demo).not.toMatch(/, false\)/)
    for (const call of demo.match(/bitgetSigned<[^\n]*\n?[^\n]*/g) ?? []) expect(call).toMatch(/true\)/)
    // The demo header is spelled in one place, and only the signer sends it.
    expect(source('bitgetAuth.ts').match(/'paptrading'/g)).toHaveLength(1)
    expect(source('bitget.ts')).not.toMatch(/paptrading|ACCESS-KEY|createHmac/)
    // The account's reads sign nothing and choose no account: each module brings its own signer.
    expect(source('bitgetAccount.ts')).not.toMatch(/paptrading|ACCESS-KEY|createHmac|bitgetSigned|, true\)|, false\)/)
    expect(source('bitgetAccount.ts')).toContain("classicAssets: '/api/v2/spot/account/assets'")
  })
})
