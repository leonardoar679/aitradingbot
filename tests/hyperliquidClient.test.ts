import { beforeEach, describe, expect, it, vi } from 'vitest'

// HYPERLIQUID'S PUBLIC INFO API (electron/services/hyperliquidClient.ts; V8 Stage 6): each question costed before it is
// sent and asked as a POST of JSON, a dropped connection or a busy host asked again twice, a refused question not; a
// list read page by page from a start time, a millisecond shared across pages read again and kept once, capped at the
// fills Hyperliquid gives.

vi.mock('../electron/services/httpPacing', () => ({ hyperliquidBudget: { spend: async () => undefined } }))

const ADDRESS = '0x0b4b6beaca45fce66ca818fbd867ec3761ed2143'

type Asked = { type: string; body: Record<string, unknown> }

async function client(answer: (asked: Asked, call: number) => Response | Promise<Response>) {
  vi.resetModules()
  const module = await import('../electron/services/hyperliquidClient')
  const asked: Asked[] = []
  const spent: number[] = []
  const slept: number[] = []
  Object.assign(module.hyperliquidSeam, {
    fetch: async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.hyperliquid.xyz/info')
      expect(init.method).toBe('POST')
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const entry = { type: String(body.type), body }
      asked.push(entry)
      return answer(entry, asked.length)
    },
    spend: async (weight: number) => void spent.push(weight),
    sleep: async (ms: number) => void slept.push(ms)
  })
  return { module, asked, spent, slept }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const fills = (from: number, count: number, step = 1): unknown[] => Array.from({ length: count }, (_, k) => ({ coin: 'BTC', px: '1', sz: '1', side: 'B', time: from + k * step, startPosition: '0', dir: 'Open Long', closedPnl: '0', fee: '0', tid: from + k, oid: 1 }))

beforeEach(() => vi.restoreAllMocks())

describe('a question', () => {
  it('is costed at its weight before it is sent, and answered', async () => {
    const { module, asked, spent } = await client(() => json({ marginSummary: {} }))
    expect(await module.hyperliquidInfo('clearinghouseState', { user: ADDRESS })).toEqual({ marginSummary: {} })
    expect(asked).toEqual([{ type: 'clearinghouseState', body: { type: 'clearinghouseState', user: ADDRESS } }])
    expect(spent).toEqual([2])
  })

  it('is asked again twice after a dropped connection or a busy host, a little later each time', async () => {
    const { module, asked, slept, spent } = await client((_asked, call) => {
      if (call === 1) throw new TypeError('fetch failed')
      if (call === 2) return json({ error: 'busy' }, 429)
      return json([])
    })
    expect(await module.hyperliquidInfo('portfolio', { user: ADDRESS })).toEqual([])
    expect(asked).toHaveLength(3)
    expect(slept).toEqual([2000, 6000])
    // Each asking is costed.
    expect(spent).toEqual([20, 20, 20])
  })

  it('is not asked again when refused as a question, and fails after its last try', async () => {
    const refused = await client(() => json({ error: 'bad user' }, 422))
    await expect(refused.module.hyperliquidInfo('portfolio', { user: 'x' })).rejects.toThrow('Hyperliquid answered 422')
    expect(refused.asked).toHaveLength(1)
    const down = await client(() => json({}, 502))
    await expect(down.module.hyperliquidInfo('portfolio', { user: ADDRESS })).rejects.toThrow('Hyperliquid could not be read: Hyperliquid answered 502')
    expect(down.asked).toHaveLength(3)
  })
})

describe("an address's record", () => {
  it('reads fills page by page from the start, again from the last millisecond read, each kept once, and funding from the first fill on', async () => {
    const pages: Record<number, unknown[]> = { 0: fills(1000, 2000), 2999: [...fills(2999, 1).map((fill) => ({ ...(fill as object), tid: 2999 })), ...fills(3000, 10)] }
    const { module, asked } = await client(({ type, body }) => {
      if (type === 'userFillsByTime') return json(pages[body.startTime as number] ?? [])
      if (type === 'userFunding') return json([{ time: 1500, delta: { type: 'funding', coin: 'BTC', usdc: '-1', szi: '1', fundingRate: '0.0001' } }])
      if (type === 'userNonFundingLedgerUpdates') return json([{ time: 10, hash: '0x1', delta: { type: 'deposit', usdc: '5' } }])
      return json({ type })
    })
    const steps: string[] = []
    const record = await module.fetchHyperliquidRecord(ADDRESS, (step) => steps.push(step))
    expect(steps).toEqual(['account', 'fills', 'funding', 'ledger'])
    // 2,000 from the first page, the shared millisecond's fill once, and ten more.
    expect(record.fills).toHaveLength(2010)
    expect(record.fillsCapped).toBe(false)
    expect(asked.filter((entry) => entry.type === 'userFillsByTime').map((entry) => entry.body.startTime)).toEqual([0, 2999])
    expect(asked.find((entry) => entry.type === 'userFunding')?.body.startTime).toBe(1000)
    expect(record.funding).toHaveLength(1)
    expect(record.ledger).toHaveLength(1)
    expect(record.state).toEqual({ type: 'clearinghouseState' })
  })

  it('steps past a page whose fills share one millisecond, and says when the fills it gives run past its cap', async () => {
    let page = 0
    const { module } = await client(({ type, body }) => {
      if (type !== 'userFillsByTime') return json([])
      page++
      // Every page full, every fill in the millisecond it was asked from.
      return json(fills(body.startTime as number, 2000, 0).map((fill, k) => ({ ...(fill as object), tid: page * 100_000 + k })))
    })
    const record = await module.fetchHyperliquidRecord(ADDRESS)
    expect(page).toBe(15)
    expect(record.fillsCapped).toBe(true)
    expect(record.fills).toHaveLength(30_000)
  })

  it("reads a busy address's window to its newest fill, past the 10,000 Hyperliquid's documents name, and calls it cut", async () => {
    // Seven full pages and a short one: 14,500 fills, the window's start to its end.
    const window = fills(1000, 14_500)
    const { module, asked } = await client(({ type, body }) => {
      if (type !== 'userFillsByTime') return json([])
      const start = body.startTime as number
      return json(window.filter((fill) => (fill as { time: number }).time >= start).slice(0, 2000))
    })
    const record = await module.fetchHyperliquidRecord(ADDRESS)
    expect(asked.filter((entry) => entry.type === 'userFillsByTime')).toHaveLength(8)
    expect(record.fills).toHaveLength(14_500)
    expect(Math.max(...record.fills.map((fill) => (fill as { time: number }).time))).toBe(1000 + 14_499)
    expect(record.fillsCapped).toBe(true)
    // Under 10,000, a whole record: not cut.
    const small = await client(({ type }) => json(type === 'userFillsByTime' ? fills(1000, 120) : []))
    expect((await small.module.fetchHyperliquidRecord(ADDRESS)).fillsCapped).toBe(false)
  })
})
