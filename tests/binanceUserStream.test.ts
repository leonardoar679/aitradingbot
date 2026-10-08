import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The listen key (electron/services/exchanges/binanceUserStream.ts; the V5 document, §101), with
// the transport faked: what is sent to Binance to open, keep and close the account's own stream,
// and where the stream is addressed. Nothing here places, signs or sizes anything.

vi.mock('../electron/services/exchanges/binance', () => ({
  resolveTradingEndpoint: async () => ({ name: 'binance.com', restRoot: 'https://api.binance.com/api/v3', wsBase: 'wss://stream.binance.com:9443/ws' })
}))

import { closeListenKey, createListenKey, keepAliveListenKey, userStreamAddress } from '../electron/services/exchanges/binanceUserStream'

const calls: { url: string; method: string; headers: Record<string, string> }[] = []
let answer: { status: number; body: unknown } = { status: 200, body: { listenKey: 'abc' } }

beforeEach(() => {
  calls.length = 0
  answer = { status: 200, body: { listenKey: 'abc' } }
  vi.stubGlobal('fetch', async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, headers: init.headers })
    return { ok: answer.status < 300, status: answer.status, statusText: answer.status < 300 ? 'OK' : 'Unauthorized', json: async () => answer.body }
  })
  delete process.env.USER_STREAM_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.USER_STREAM_URL
})

describe('the listen key', () => {
  it('is asked for with the API key in a header and nothing else: no signature, no timestamp, no secret', async () => {
    expect(await createListenKey('the-key')).toBe('abc')
    expect(calls).toEqual([{ url: 'https://api.binance.com/api/v3/userDataStream', method: 'POST', headers: { 'X-MBX-APIKEY': 'the-key' } }])
    expect(calls[0].url).not.toMatch(/signature|timestamp|secret/)
  })

  it('is kept alive with PUT and closed with DELETE, each naming the key', async () => {
    await keepAliveListenKey('the-key', 'abc')
    await closeListenKey('the-key', 'abc')
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['PUT', 'https://api.binance.com/api/v3/userDataStream?listenKey=abc'],
      ['DELETE', 'https://api.binance.com/api/v3/userDataStream?listenKey=abc']
    ])
    expect(calls.every((call) => call.headers['X-MBX-APIKEY'] === 'the-key')).toBe(true)
  })

  it('refuses an answer without a key, and says what Binance said when it refused', async () => {
    answer = { status: 200, body: {} }
    await expect(createListenKey('the-key')).rejects.toThrow('Binance listen key request answered with no key.')
    answer = { status: 401, body: { msg: 'Invalid API-key, IP, or permissions for action.' } }
    await expect(createListenKey('the-key')).rejects.toThrow('Binance listen key request failed: Invalid API-key, IP, or permissions for action.')
    answer = { status: 500, body: null }
    await expect(keepAliveListenKey('the-key', 'abc')).rejects.toThrow('Binance listen key keep-alive failed: 500 Unauthorized')
  })
})

describe('where the stream is addressed', () => {
  it('is the trading host\'s socket base and the key, or the seam a check names', async () => {
    expect(await userStreamAddress('abc')).toBe('wss://stream.binance.com:9443/ws/abc')
    process.env.USER_STREAM_URL = 'ws://127.0.0.1:9/ws'
    expect(await userStreamAddress('abc')).toBe('ws://127.0.0.1:9/ws/abc')
    process.env.USER_STREAM_URL = 'ws://127.0.0.1:9'
    expect(await userStreamAddress('abc')).toBe('ws://127.0.0.1:9/ws/abc')
    process.env.USER_STREAM_URL = ''
    expect(await userStreamAddress('abc')).toBe('wss://stream.binance.com:9443/ws/abc')
  })
})
