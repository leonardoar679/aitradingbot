import { beforeEach, describe, expect, it, vi } from 'vitest'

// OKX'S PUBLIC COPY-TRADING RECORD (electron/services/okxClient.ts; V8 Stage 7): GETs to www.okx.com alone, each through
// its endpoint's budget; a dropped connection or a busy host asked again twice, OKX's refusal not; the closed positions
// paged back by the last one's id until a short page or the cap; the instruments read once in six hours; each
// instrument's funding paged back past the trader's first opening on it.

vi.mock('../electron/services/httpPacing', () => ({ okxBudget: { take: async () => undefined } }))

const H = 3_600_000
const NOW = Date.UTC(2026, 9, 27, 12)
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status })
const ok = (data: unknown[]): Response => json({ code: '0', msg: '', data })

async function client(answer: (url: URL, call: number) => Response | Promise<Response>) {
  vi.resetModules()
  const module = await import('../electron/services/okxClient')
  module.resetOkxClient()
  const urls: URL[] = []
  const taken: string[] = []
  const slept: number[] = []
  Object.assign(module.okxSeam, {
    fetch: async (raw: string) => {
      const url = new URL(raw)
      urls.push(url)
      return answer(url, urls.length)
    },
    take: async (endpoint: string) => void taken.push(endpoint),
    sleep: async (ms: number) => void slept.push(ms),
    now: () => NOW
  })
  return { module, urls, taken, slept }
}

/** A page of closed positions, newest first, each a day apart from `newest` back. */
const positions = (from: number, count: number, instId = 'BTC-USDT-SWAP'): unknown[] =>
  Array.from({ length: count }, (_, k) => ({ subPosId: `s${from + k}`, instId, openTime: String(NOW - (from + k + 1) * 24 * H), closeTime: String(NOW - (from + k) * 24 * H) }))

beforeEach(() => vi.restoreAllMocks())

describe('a question to OKX', () => {
  it('is a GET to www.okx.com through its endpoint\'s budget, answered with its data', async () => {
    const { module, urls, taken } = await client(() => ok([{ a: 1 }]))
    expect(await module.okxGet('/api/v5/copytrading/public-stats', { instType: 'SWAP', uniqueCode: 'C', lastDays: '4' })).toEqual([{ a: 1 }])
    expect(urls[0].origin).toBe('https://www.okx.com')
    expect(urls[0].pathname).toBe('/api/v5/copytrading/public-stats')
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ instType: 'SWAP', uniqueCode: 'C', lastDays: '4' })
    expect(taken).toEqual(['/api/v5/copytrading/public-stats'])
  })

  it('is asked again twice after a dropped connection, a busy host or OKX\'s "too many requests", and not after a refusal', async () => {
    const flaky = await client((_url, call) => (call === 1 ? Promise.reject(new TypeError('fetch failed')) : call === 2 ? json({}, 503) : call === 3 ? json({ code: '50011', msg: 'Too Many Requests' }) : ok([])))
    await expect(flaky.module.okxGet('/p', {})).rejects.toThrow('OKX could not be read: OKX answered 50011: Too Many Requests')
    expect(flaky.urls).toHaveLength(3)
    expect(flaky.slept).toEqual([2000, 6000])
    const refused = await client(() => json({ code: '51001', msg: 'Instrument ID does not exist' }))
    await expect(refused.module.okxGet('/p', {})).rejects.toThrow('OKX answered 51001: Instrument ID does not exist')
    expect(refused.urls).toHaveLength(1)
    const missing = await client(() => json({}, 404))
    await expect(missing.module.okxGet('/p', {})).rejects.toThrow('OKX answered 404')
    expect(missing.urls).toHaveLength(1)
  })
})

describe("a lead trader's record", () => {
  it('pages the closed positions back by the last id, reads what is open, the year and the instruments, and each funding history back past the first opening', async () => {
    const { module, urls } = await client((url) => {
      const path = url.pathname
      const after = url.searchParams.get('after')
      if (path.endsWith('public-subpositions-history')) return ok(after === null ? positions(0, 100) : after === 's99' ? [...positions(100, 30), ...positions(130, 1, 'ETH-USDT-SWAP'), ...positions(131, 1, 'BTC-USD-SWAP')] : [])
      if (path.endsWith('public-instruments') || path === '/api/v5/public/instruments') return ok([{ instId: 'BTC-USDT-SWAP' }])
      if (path.endsWith('funding-rate-history')) {
        // Rates every 8 hours, 100 a page, newest first, back from the time asked.
        const before = after === null ? NOW : Number(after)
        return ok(Array.from({ length: 100 }, (_, k) => ({ instId: url.searchParams.get('instId'), fundingTime: String(before - (k + 1) * 8 * H) })))
      }
      return ok([{ path }])
    })
    const steps: string[] = []
    const record = await module.fetchOkxRecord('CODE', (step) => steps.push(step))
    expect(record.history).toHaveLength(132)
    expect(record.capped).toBe(false)
    expect(urls.filter((url) => url.pathname.endsWith('public-subpositions-history')).map((url) => url.searchParams.get('after'))).toEqual([null, 's99'])
    expect(record.current).toEqual([{ path: '/api/v5/copytrading/public-current-subpositions' }])
    expect(urls.find((url) => url.pathname.endsWith('public-pnl'))?.searchParams.get('lastDays')).toBe('4')
    // BTC's first opening 130 days back and ETH's 131: 100 rates a page cover 33 days, so four pages reach past each,
    // each page asked from the oldest time the last one gave.
    const funding = urls.filter((url) => url.pathname.endsWith('funding-rate-history'))
    expect([...new Set(funding.map((url) => url.searchParams.get('instId')))]).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP'])
    const btc = funding.filter((url) => url.searchParams.get('instId') === 'BTC-USDT-SWAP')
    expect(btc.map((url) => (url.searchParams.get('after') === null ? 0 : (NOW - Number(url.searchParams.get('after'))) / (800 * H)))).toEqual([0, 1, 2, 3])
    expect(record.funding['BTC-USDT-SWAP']).toHaveLength(400)
    expect(steps).toEqual(['positions', 'open positions', 'the year', 'instruments', 'funding of BTC-USDT-SWAP', 'funding of ETH-USDT-SWAP'])
    // The instruments are read once in six hours.
    await module.fetchOkxRecord('CODE')
    expect(urls.filter((url) => url.pathname === '/api/v5/public/instruments')).toHaveLength(1)
  })

  it('says where OKX holds more closed positions than the pages read', async () => {
    let page = 0
    const { module } = await client((url) => {
      if (url.pathname.endsWith('public-subpositions-history')) return ok(positions(100 * page++, 100))
      return ok([])
    })
    const record = await module.fetchOkxRecord('CODE')
    expect(page).toBe(30)
    expect(record.history).toHaveLength(3000)
    expect(record.capped).toBe(true)
  })
})
