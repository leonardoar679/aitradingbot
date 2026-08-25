import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchUpbitBalances } from '../electron/services/exchanges/upbitTrading'
import { readableBalances } from '../shared/liveBalances'

// The response side of the same call. What matters here is that a bad answer is reported as a bad
// answer: this is the only thing telling the user what they hold on Upbit, and every failure mode
// below has a plausible way of being mistaken for "your account is empty".

const realFetch = global.fetch

function answer(body: unknown, init: { ok?: boolean; status?: number } = {}): void {
  global.fetch = vi.fn(async () => {
    await Promise.resolve()
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: 'OK',
      json: async () => body
    }
  }) as unknown as typeof fetch
}

afterEach(() => {
  global.fetch = realFetch
})

describe('fetchUpbitBalances', () => {
  it('maps Upbit currency/balance/locked onto the shared balance shape', () => {
    answer([
      { currency: 'KRW', balance: '1250000.0', locked: '0.0' },
      { currency: 'BTC', balance: '0.015', locked: '0.005' }
    ])

    return expect(fetchUpbitBalances('a', 's')).resolves.toEqual([
      { asset: 'KRW', free: 1_250_000, locked: 0 },
      { asset: 'BTC', free: 0.015, locked: 0.005 }
    ])
  })

  it('sends the token as a Bearer header and asks for nothing else', async () => {
    answer([])
    await fetchUpbitBalances('a', 's')

    const [url, init] = (global.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('https://api.upbit.com/v1/accounts')
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    // No method given, so it is a GET. This call must never be anything else.
    expect(init.method).toBeUndefined()
  })

  it('leaves an unparseable amount as NaN so it is reported rather than shown as zero', async () => {
    // The whole point of not defaulting to 0 here: readableBalances names it as unreadable, and
    // the user is told the list is incomplete instead of being told they hold nothing.
    answer([{ currency: 'BTC', balance: 'not-a-number', locked: '0' }])
    const readout = readableBalances(await fetchUpbitBalances('a', 's'))

    expect(readout.rows).toEqual([])
    expect(readout.unreadable).toEqual(['BTC'])
  })

  it('refuses a 200 whose body is not a list of balances', async () => {
    // Otherwise this fails as "body.map is not a function", which reaches the user as the reason
    // their API key was rejected and points them at entirely the wrong thing.
    answer({ unexpected: true })

    await expect(fetchUpbitBalances('a', 's')).rejects.toThrow(/not a list of balances/)
  })

  it('reports Upbit own words for a rejection, which name the actual cause', async () => {
    answer({ error: { name: 'invalid_access_key', message: 'Invalid access key' } }, { ok: false, status: 401 })

    await expect(fetchUpbitBalances('a', 's')).rejects.toThrow(/Invalid access key.*invalid_access_key/)
  })

  it('explains the IP allowlist on a bare 401, which is the usual cause and is invisible otherwise', async () => {
    // Upbit refuses a perfectly valid key from an IP that is not on its allowlist. Without this,
    // the user re-creates a key that was never the problem.
    answer(null, { ok: false, status: 401 })

    await expect(fetchUpbitBalances('a', 's')).rejects.toThrow(/allowlist/)
  })

  it('still says something useful when the body explains nothing', async () => {
    answer(null, { ok: false, status: 500 })

    await expect(fetchUpbitBalances('a', 's')).rejects.toThrow(/500/)
  })

  it('does not swallow a body that fails to parse as JSON', async () => {
    global.fetch = vi.fn(async () => {
      await Promise.resolve()
      return {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new Error('not json')
        }
      }
    }) as unknown as typeof fetch

    await expect(fetchUpbitBalances('a', 's')).rejects.toThrow(/502/)
  })
})
