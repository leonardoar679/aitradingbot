import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedCandleCount, clearCandleCache, fetchRangeCached } from '../src/bots/candleCache'
import type { Candle } from '../shared/ipc'

// The cache exists to cut network calls, so the only thing that must never change is the ANSWER.
// Every test below is a way that could quietly stop being true -- and the dangerous direction is a
// cache that returns something plausible but stale, because a bot would then trade on a price that
// stopped moving and nothing about it would look broken.

const BAR = 900
const T0 = 1_700_000_000

function world(count: number, closeAt: (i: number) => number = (i) => 100 + i): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: T0 + i * BAR,
    open: closeAt(i),
    high: closeAt(i) * 1.001,
    low: closeAt(i) * 0.999,
    close: closeAt(i),
    volume: 1
  }))
}

/** Stands in for the exchange: returns exactly the bars in [start, end], as the real paged fetch
 * does, and counts how many times it was asked. */
function exchangeOf(series: () => Candle[]): { fetch: ReturnType<typeof vi.fn>; calls: () => number } {
  const fetch = vi.fn(
    async (_e: string, _s: string, _i: string, start: number, end: number) => ({
      candles: series().filter((c) => c.time >= start && c.time <= end),
      cancelled: false
    })
  )
  return { fetch: fetch as never, calls: () => fetch.mock.calls.length }
}

const args = ['binance', 'BTCUSDT', '15m'] as const

describe('candleCache', () => {
  beforeEach(() => clearCandleCache())

  it('returns exactly what an uncached fetch would return, across repeated polls', async () => {
    // The whole point. If this ever differs, every backtest a bot displays is computed on different
    // data than the same request would have produced a moment earlier.
    let bars = world(50)
    const ex = exchangeOf(() => bars)
    const start = T0
    const first = await fetchRangeCached(ex.fetch, ...args, start, T0 + 49 * BAR)

    bars = world(60)
    const second = await fetchRangeCached(ex.fetch, ...args, start, T0 + 59 * BAR)

    const direct = bars.filter((c) => c.time >= start && c.time <= T0 + 59 * BAR)
    expect(first).toHaveLength(50)
    expect(second).toEqual(direct)
  })

  it('asks only for the tail on the second poll', async () => {
    const bars = world(100)
    const ex = exchangeOf(() => bars)
    await fetchRangeCached(ex.fetch, ...args, T0, T0 + 99 * BAR)
    await fetchRangeCached(ex.fetch, ...args, T0, T0 + 99 * BAR)

    const firstStart = (ex.fetch as unknown as { mock: { calls: number[][] } }).mock.calls[0][3]
    const secondStart = (ex.fetch as unknown as { mock: { calls: number[][] } }).mock.calls[1][3]
    expect(firstStart).toBe(T0)
    // At the last cached bar, not after it -- that overlap is what refreshes the forming candle.
    expect(secondStart).toBe(T0 + 99 * BAR)
    expect(secondStart).toBeGreaterThan(firstStart)
  })

  it('refreshes the still-forming last bar rather than freezing it', async () => {
    // The failure this pins is silent: append-after-last would keep the partial bar forever, and
    // the strategy would read a close that never moves again.
    let bars = world(30)
    const ex = exchangeOf(() => bars)
    await fetchRangeCached(ex.fetch, ...args, T0, T0 + 29 * BAR)

    const moved = world(30)
    moved[29] = { ...moved[29], close: 999, high: 1000 }
    bars = moved

    const after = await fetchRangeCached(ex.fetch, ...args, T0, T0 + 29 * BAR)
    expect(after[after.length - 1].close).toBe(999)
    expect(after).toHaveLength(30)
  })

  it('never returns the same bar twice after a merge', async () => {
    let bars = world(40)
    const ex = exchangeOf(() => bars)
    await fetchRangeCached(ex.fetch, ...args, T0, T0 + 39 * BAR)
    bars = world(45)
    const merged = await fetchRangeCached(ex.fetch, ...args, T0, T0 + 44 * BAR)

    const times = merged.map((c) => c.time)
    expect(new Set(times).size).toBe(times.length)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
  })

  it('refetches in full when asked for data older than it holds', async () => {
    // A bot enabled earlier than the cached window must not be served a short series, which would
    // silently drop its own oldest paper trades.
    const bars = world(100)
    const ex = exchangeOf(() => bars)
    await fetchRangeCached(ex.fetch, ...args, T0 + 50 * BAR, T0 + 99 * BAR)
    const wider = await fetchRangeCached(ex.fetch, ...args, T0, T0 + 99 * BAR)

    expect(wider).toHaveLength(100)
    expect((ex.fetch as unknown as { mock: { calls: number[][] } }).mock.calls[1][3]).toBe(T0)
  })

  it('keeps a cancelled partial result and extends from where it stopped', async () => {
    // fetchHistoricalRange pages forward and stops early when cancelled, so a cancelled result is a
    // contiguous prefix. Discarding it would throw away good bars; treating it as complete would be
    // fine too, because the next poll extends from the last one actually received.
    const bars = world(80)
    const partial = vi.fn(async (_e: string, _s: string, _i: string, start: number) => ({
      candles: bars.filter((c) => c.time >= start).slice(0, 20),
      cancelled: true
    }))
    const firstPass = await fetchRangeCached(partial as never, ...args, T0, T0 + 79 * BAR)
    expect(firstPass).toHaveLength(20)
    expect(cachedCandleCount(...args)).toBe(20)

    const full = exchangeOf(() => bars)
    const secondPass = await fetchRangeCached(full.fetch, ...args, T0, T0 + 79 * BAR)
    expect(secondPass).toEqual(bars)
    // Extended from bar 19, not from the beginning.
    expect((full.fetch as unknown as { mock: { calls: number[][] } }).mock.calls[0][3]).toBe(T0 + 19 * BAR)
  })

  it('keeps series for different symbols, intervals and exchanges apart', async () => {
    const btc = world(10, (i) => 100 + i)
    const eth = world(10, (i) => 5000 + i)
    const exBtc = exchangeOf(() => btc)
    const exEth = exchangeOf(() => eth)

    await fetchRangeCached(exBtc.fetch, 'binance', 'BTCUSDT', '15m', T0, T0 + 9 * BAR)
    await fetchRangeCached(exEth.fetch, 'binance', 'ETHUSDT', '15m', T0, T0 + 9 * BAR)
    await fetchRangeCached(exBtc.fetch, 'binance', 'BTCUSDT', '1h', T0, T0 + 9 * BAR)
    await fetchRangeCached(exBtc.fetch, 'upbit', 'BTCUSDT', '15m', T0, T0 + 9 * BAR)

    expect(cachedCandleCount('binance', 'BTCUSDT', '15m')).toBe(10)
    expect(cachedCandleCount('binance', 'ETHUSDT', '15m')).toBe(10)
    expect(cachedCandleCount('binance', 'BTCUSDT', '1h')).toBe(10)
    expect(cachedCandleCount('upbit', 'BTCUSDT', '15m')).toBe(10)
    // All four were misses, so all four fetched in full rather than one serving another.
    expect(exBtc.calls() + exEth.calls()).toBe(4)
  })

  it('is case-insensitive about the symbol, so one series is not cached twice', async () => {
    const bars = world(10)
    const ex = exchangeOf(() => bars)
    await fetchRangeCached(ex.fetch, 'binance', 'btcusdt', '15m', T0, T0 + 9 * BAR)
    await fetchRangeCached(ex.fetch, 'binance', 'BTCUSDT', '15m', T0, T0 + 9 * BAR)
    // Second call hit the cache and asked only for the tail.
    expect((ex.fetch as unknown as { mock: { calls: number[][] } }).mock.calls[1][3]).toBe(T0 + 9 * BAR)
  })

  it('survives an empty tail without losing what it holds', async () => {
    const bars = world(25)
    const ex = exchangeOf(() => bars)
    await fetchRangeCached(ex.fetch, ...args, T0, T0 + 24 * BAR)

    const empty = vi.fn(async () => ({ candles: [], cancelled: false }))
    const after = await fetchRangeCached(empty as never, ...args, T0, T0 + 24 * BAR)
    expect(after).toHaveLength(25)
    expect(after).toEqual(bars)
  })
})

// What the Live tab actually costs.
//
// LiveStrategyComparison mounts all three shipped strategies at once, each at its own measured
// bar. Two of them are 15m, so they share a cache key -- and the tempting conclusion is that the
// pair costs one fetch between them. These pin what sharing does and does not buy, because the
// answer differs entirely by whether the cache is cold, and the cold case is the one a user meets
// every time they open the tab.
//
// The three window sizes come from liveFetchCandles() against the real registry: 620 bars at 4h
// for Trend Regime, 909 and 7,820 at 15m for the two channel strategies.
describe('candleCache under the Live tab s three concurrent rows', () => {
  beforeEach(() => clearCandleCache())

  const NARROW = 909
  const WIDE = 7_820

  /** Start times as the hook computes them: endSec - fetchCandles * barSeconds. */
  const startOf = (bars: number, end: number): number => end - bars * BAR

  /** Bars that arithmetic actually yields. Both ends are inclusive, so asking for n bars back
   * from `end` returns n + 1 of them -- a fencepost worth naming rather than papering over. It
   * errs by one bar in the safe direction (more history than the warm-up needs), which is why it
   * has never mattered, but a test asserting `n` here would be asserting the wrong number. */
  const spanned = (bars: number): number => bars + 1

  it('costs THREE full fetches on a cold cache, not two -- concurrent rows cannot share', async () => {
    const bars = world(WIDE)
    const end = T0 + (WIDE - 1) * BAR
    const ex = exchangeOf(() => bars)

    // Mounted together, so both are in flight before either has stored anything.
    const [narrow, wide] = await Promise.all([
      fetchRangeCached(ex.fetch, ...args, startOf(NARROW, end), end),
      fetchRangeCached(ex.fetch, ...args, startOf(WIDE, end), end)
    ])

    // Both missed. Sharing a key does not serialise them, and nothing here pretends it does.
    expect(ex.calls()).toBe(2)
    // Each still got exactly the window it asked for -- the race costs requests, never answers.
    expect(narrow).toHaveLength(spanned(NARROW))
    // Capped by the world, which is exactly WIDE bars long -- the request reaches past its start.
    expect(wide).toHaveLength(WIDE)
  })

  it('leaves the cache correct whichever write lands last', async () => {
    const bars = world(WIDE)
    const end = T0 + (WIDE - 1) * BAR
    const ex = exchangeOf(() => bars)

    // Narrow resolving second is the bad ordering named in this module's header: its write drops
    // the wider history. That is a lost refetch, not a wrong answer, and the next poll repairs it.
    await fetchRangeCached(ex.fetch, ...args, startOf(WIDE, end), end)
    await fetchRangeCached(ex.fetch, ...args, startOf(NARROW, end), end)

    // The wide row asks again and gets its full window back regardless.
    const again = await fetchRangeCached(ex.fetch, ...args, startOf(WIDE, end), end)
    expect(again).toHaveLength(WIDE)
  })

  it('does share once warm: the narrow row then costs a tail, not a window', async () => {
    const bars = world(WIDE)
    const end = T0 + (WIDE - 1) * BAR
    const ex = exchangeOf(() => bars)

    await fetchRangeCached(ex.fetch, ...args, startOf(WIDE, end), end)
    const before = ex.calls()
    const narrow = await fetchRangeCached(ex.fetch, ...args, startOf(NARROW, end), end)

    expect(ex.calls()).toBe(before + 1)
    // A tail, not a window: it asked from the last held bar, not from its own start.
    const lastCall = (ex.fetch as unknown as { mock: { calls: number[][] } }).mock.calls[before]
    expect(lastCall[3]).toBe(end)
    expect(narrow).toHaveLength(spanned(NARROW))
  })
})
