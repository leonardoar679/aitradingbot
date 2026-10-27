import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BinanceBudget, GapBudget, HTTP_PACING_LINES, RateLimitedError, WeightBudget, retryAfterMs, type PacingClock } from '../shared/httpPacing'

// ONE BUDGET PER HOST (shared/httpPacing.ts; V8 Stage 1): Binance's used weight read from its answers, a reader
// that can wait held back when it is high, a 429 or a 418 holding every read until its Retry-After; Hyperliquid's
// weight costed before a request; OKX's endpoints one request a half second each.

/** A clock a test moves: sleeping moves it. */
function fakeClock(start = Date.UTC(2026, 9, 26, 12, 0, 10)): PacingClock & { slept: number[] } {
  let now = start
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms)
      now += ms
    }
  }
}

const answer = (status: number, headers: Record<string, string> = {}): { status: number; headers: Headers } => ({ status, headers: new Headers(headers) })

describe('Retry-After', () => {
  it('reads seconds and an HTTP date, and nothing else', () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0)
    expect(retryAfterMs('30', now)).toBe(30_000)
    expect(retryAfterMs(' 0 ', now)).toBe(0)
    expect(retryAfterMs('Mon, 26 Oct 2026 12:01:00 GMT', now)).toBe(60_000)
    expect(retryAfterMs('Mon, 26 Oct 2026 11:59:00 GMT', now)).toBe(0)
    for (const value of [null, undefined, '', 'soon', '-5', '1.5']) expect(retryAfterMs(value, now), String(value)).toBeNull()
  })
})

describe("Binance's budget", () => {
  it('lets a read that cannot wait go whatever the weight, and holds one that can until the next minute while it is high', async () => {
    const clock = fakeClock()
    const budget = new BinanceBudget(clock)
    budget.after(answer(200, { 'x-mbx-used-weight-1m': String(HTTP_PACING_LINES.binance.backgroundLine + 1) }))
    await budget.before('normal')
    expect(clock.slept).toEqual([])
    await budget.before('background')
    // Woken at the minute's turn: 12:00:10 to 12:01:00.
    expect(clock.slept).toEqual([50_000])
    // A new minute: Binance's count starts again, so nothing waits.
    await budget.before('background')
    expect(clock.slept).toHaveLength(1)
  })

  it('does not hold a read that can wait at the line itself, only above it', async () => {
    const clock = fakeClock()
    const budget = new BinanceBudget(clock)
    budget.after(answer(200, { 'x-mbx-used-weight-1m': String(HTTP_PACING_LINES.binance.backgroundLine) }))
    await budget.before('background')
    expect(clock.slept).toEqual([])
    expect(budget.state().usedWeight).toBe(HTTP_PACING_LINES.binance.backgroundLine)
  })

  it('holds every read after a 429 until its Retry-After, failing at once rather than waiting', async () => {
    const clock = fakeClock()
    const budget = new BinanceBudget(clock)
    budget.after(answer(429, { 'retry-after': '20' }))
    await expect(budget.before('normal')).rejects.toBeInstanceOf(RateLimitedError)
    await expect(budget.before('background')).rejects.toThrow(/rate-limited this address \(429\)/)
    expect(clock.slept).toEqual([])
    expect(budget.state().heldUntilMs).toBe(clock.now() + 20_000)
    await clock.sleep(20_000)
    await budget.before('normal')
    expect(budget.state().heldUntilMs).toBeNull()
  })

  it('holds a minute after a 429 that names no wait, and half an hour after a 418 that names none', async () => {
    const clock = fakeClock()
    const budget = new BinanceBudget(clock)
    budget.after(answer(429))
    expect(budget.state().heldUntilMs).toBe(clock.now() + HTTP_PACING_LINES.binance.holdOn429Ms)
    budget.after(answer(418))
    expect(budget.state().heldUntilMs).toBe(clock.now() + HTTP_PACING_LINES.binance.holdOn418Ms)
    await expect(budget.before()).rejects.toThrow(/banned this address/)
    // A shorter hold after it does not shorten the ban.
    budget.after(answer(429, { 'retry-after': '5' }))
    expect(budget.state().heldUntilMs).toBe(clock.now() + HTTP_PACING_LINES.binance.holdOn418Ms)
    await clock.sleep(HTTP_PACING_LINES.binance.holdOn418Ms - 1)
    await expect(budget.before()).rejects.toBeInstanceOf(RateLimitedError)
    await clock.sleep(1)
    await budget.before()
  })

  it('reads nothing from an answer without headers or with a figure that is not one', async () => {
    const clock = fakeClock()
    const budget = new BinanceBudget(clock)
    budget.after({ status: 200 })
    budget.after({ status: 200, headers: null })
    budget.after(answer(200, { 'x-mbx-used-weight-1m': 'lots' }))
    expect(budget.state()).toEqual({ heldUntilMs: null, usedWeight: 0, minuteStartMs: null })
    budget.after({ status: 500 })
    await budget.before('background')
    expect(clock.slept).toEqual([])
  })

  it("keeps the minute's highest count, so an answer read late does not lower it", () => {
    const clock = fakeClock()
    const budget = new BinanceBudget(clock)
    budget.after(answer(200, { 'x-mbx-used-weight-1m': '3000' }))
    budget.after(answer(200, { 'x-mbx-used-weight-1m': '1200' }))
    expect(budget.state().usedWeight).toBe(3000)
  })
})

describe("Hyperliquid's weight", () => {
  it('spends within the minute, waits for the next when a request would go over, and refuses one too heavy for any minute', async () => {
    const clock = fakeClock()
    const budget = new WeightBudget('Hyperliquid', 600, clock)
    await budget.spend(400)
    await budget.spend(200)
    expect(clock.slept).toEqual([])
    await budget.spend(2)
    expect(clock.slept).toEqual([50_000])
    await expect(budget.spend(601)).rejects.toThrow(/cannot be sent to Hyperliquid within 600 a minute/)
    await expect(budget.spend(0)).rejects.toThrow()
    // A refused request leaves the queue working.
    await budget.spend(10)
  })

  it('serves requests in the order they were asked', async () => {
    const clock = fakeClock()
    const budget = new WeightBudget('Hyperliquid', 600, clock)
    const order: number[] = []
    await Promise.all([budget.spend(500).then(() => order.push(1)), budget.spend(500).then(() => order.push(2)), budget.spend(50).then(() => order.push(3))])
    expect(order).toEqual([1, 2, 3])
  })
})

describe("OKX's endpoints", () => {
  it('asks one endpoint at most every half second, and each endpoint on its own', async () => {
    const clock = fakeClock()
    const budget = new GapBudget('OKX', HTTP_PACING_LINES.okx.minGapMs, clock)
    await budget.take('public-current-subpositions')
    await budget.take('public-subpositions-history')
    expect(clock.slept).toEqual([])
    await budget.take('public-current-subpositions')
    expect(clock.slept).toEqual([500])
    await clock.sleep(600)
    await budget.take('public-current-subpositions')
    expect(clock.slept).toEqual([500, 600])
  })
})

describe("the perpetuals' hosts (V8 Stage 6)", () => {
  it("spend half Binance futures' weight a minute, its funding history once a second, and Bitget's market once a tenth of a second", async () => {
    expect(HTTP_PACING_LINES.binanceFutures).toEqual({ weightPerMinute: 1200, fundingGapMs: 1000 })
    expect(HTTP_PACING_LINES.bitget).toEqual({ minGapMs: 100 })
    const clock = fakeClock()
    const futures = new WeightBudget('Binance futures', HTTP_PACING_LINES.binanceFutures.weightPerMinute, clock)
    await futures.spend(1000)
    await futures.spend(200)
    expect(clock.slept).toEqual([])
    await futures.spend(10)
    expect(clock.slept).toEqual([50_000])
    const bitget = new GapBudget('Bitget', HTTP_PACING_LINES.bitget.minGapMs, clock)
    await bitget.take('candles')
    await bitget.take('candles')
    expect(clock.slept).toEqual([50_000, 100])
  })
})

describe("Binance's reads, through the budget", () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it('stops asking after a 429, and says so at once', async () => {
    let asked = 0
    vi.stubGlobal('fetch', async () => {
      asked++
      // The host is resolved by its first read (one candle); every later read is answered with a rate limit.
      if (asked === 1) return new Response(JSON.stringify([[0, '1', '1', '1', '1', '1']]), { status: 200 })
      return new Response('{}', { status: 429, headers: { 'retry-after': '60', 'x-mbx-used-weight-1m': '6100' } })
    })
    const binance = await import('../electron/services/exchanges/binance')
    const pacing = await import('../electron/services/httpPacing')
    const first = await binance.fetchMarketData('/klines?symbol=BTCUSDT&interval=1m&limit=1')
    expect(first.response.status).toBe(429)
    const before = asked
    await expect(binance.fetchMarketData('/ticker/24hr?symbol=BTCUSDT')).rejects.toMatchObject({ name: 'RateLimitedError', message: expect.stringMatching(/^Binance is not asked until .*429/) })
    expect(asked).toBe(before)
    expect(pacing.binanceBudget.state().heldUntilMs).not.toBeNull()
  })

  it('never holds a signed request: no module that signs imports the budget', () => {
    const signed = ['binanceTrading.ts', 'binanceFuturesTrading.ts', 'binanceUserStream.ts', 'bitgetAuth.ts', 'bitgetOrders.ts', 'bitgetTrading.ts', 'bitgetDemoTrading.ts']
    for (const name of signed) expect(readFileSync(join(__dirname, '..', 'electron', 'services', 'exchanges', name), 'utf-8'), name).not.toMatch(/httpPacing/)
  })
})
