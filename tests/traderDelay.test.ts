import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import type { RoundTrip } from '../shared/traders/roundTrips'
import { DELAY_LINES, delayOf, followableAt, fundingPaidPct, openAtOrAfter, type DelayCosts, type FundingRate } from '../shared/traders/delay'

// COULD IT BE FOLLOWED (shared/traders/delay.ts; V8-S6-DELAY): a trader's recent trips copied 2, 5 and 15 minutes late
// at the next minute's open, charged the taker's fee and the book's impact each way (at least 2 bps), once and twice,
// and the funding the copy's hold crosses; each row's mean with its interval by trading day; followable only at a delay
// a follow has measured live.

const MIN = 60
const DAY = 86_400
const NOW = 1_790_000_000 - (1_790_000_000 % DAY)

/** One-minute bars over a span whose open is `price(sec)`. */
function bars(fromSec: number, toSec: number, price: (sec: number) => number): Candle[] {
  const out: Candle[] = []
  for (let t = fromSec - (fromSec % MIN); t < toSec; t += MIN) {
    const open = price(t)
    out.push({ time: t, open, high: open, low: open, close: open, volume: 1 })
  }
  return out
}

const tripAt = (openSec: number, holdMin: number, side: 'long' | 'short' = 'long', coin = 'ABC'): RoundTrip => ({
  coin,
  side,
  openedAtMs: openSec * 1000,
  closedAtMs: (openSec + holdMin * MIN) * 1000,
  entryPx: 100,
  exitPx: 101,
  maxSize: 1,
  entryNotional: 100,
  realizedPnl: 1,
  fees: 0,
  rebates: 0,
  funding: 0,
  net: 1,
  movePct: 1,
  fills: 2
})

describe('the prices and the funding a copy pays', () => {
  const series = bars(NOW, NOW + 10 * MIN, (sec) => 100 + (sec - NOW) / MIN)
  it("reads the open of the first minute starting at or after a moment, and nothing past the gap", () => {
    expect(openAtOrAfter(series, NOW)).toBe(100)
    expect(openAtOrAfter(series, NOW + 1)).toBe(101)
    expect(openAtOrAfter(series, NOW + 9 * MIN)).toBe(109)
    expect(openAtOrAfter(series, NOW + 9 * MIN + 1)).toBeNull()
    expect(openAtOrAfter([series[0], series[5]], NOW + 1)).toBeNull()
    expect(openAtOrAfter([series[0], series[5]], NOW + 1, 300)).toBe(105)
    expect(openAtOrAfter([], NOW)).toBeNull()
  })
  it('charges a long a positive rate and pays a short it, for the times a hold crosses, and knows no span beyond the rates', () => {
    const rates: FundingRate[] = [
      { timeSec: NOW, rate: 0.0001 },
      { timeSec: NOW + 8 * 3600, rate: 0.0003 },
      { timeSec: NOW + 16 * 3600, rate: -0.0002 }
    ]
    expect(fundingPaidPct(rates, 'long', NOW - 60, NOW + 9 * 3600)).toBeCloseTo(0.04, 12)
    expect(fundingPaidPct(rates, 'short', NOW - 60, NOW + 9 * 3600)).toBeCloseTo(-0.04, 12)
    // A hold that crosses no funding time pays none; one that starts on a funding time does not pay it.
    expect(fundingPaidPct(rates, 'long', NOW + 60, NOW + 3600)).toBe(0)
    expect(fundingPaidPct(rates, 'long', NOW, NOW + 3600)).toBe(0)
    expect(fundingPaidPct(rates, 'long', NOW + 16 * 3600 + 1, NOW + 30 * 3600)).toBeNull()
    expect(fundingPaidPct([], 'long', NOW, NOW + 1)).toBeNull()
    expect(fundingPaidPct(undefined, 'long', NOW, NOW + 1)).toBeNull()
  })
})

describe('V8-S6-DELAY', () => {
  // A coin that rises 0.1% a minute for an hour after each trip's entry, then stays: the later a copy enters, the less
  // of the move it gets.
  const days = 20
  const entries = Array.from({ length: days }, (_, k) => NOW - (days - k) * DAY + 3600)
  const priceAt = (sec: number): number => {
    let level = 100
    for (const entry of entries) if (sec > entry) level *= 1 + 0.001 * Math.min(60, (sec - entry) / MIN)
    return level
  }
  const ABC = entries.flatMap((entry) => bars(entry - 5 * MIN, entry + 140 * MIN, priceAt))
  const trips = entries.map((entry) => tripAt(entry, 60))
  const costs = new Map<string, DelayCosts>([['ABC', { venue: 'binance', symbol: 'ABCUSDT', takerFeePct: 0.05, impactPct: null }]])
  const funding = new Map<string, FundingRate[]>([['ABC', [{ timeSec: NOW - 40 * DAY, rate: 0.0001 }, { timeSec: NOW, rate: 0.0001 }]]])
  const result = delayOf({ trips, costs, bars: new Map([['ABC', ABC]]), funding, nowMs: NOW * 1000 })

  it('copies each trip late at each delay and cost, the later the less of the move, twice the costs the less again', () => {
    expect(result.rows.map((row) => [row.delayMin, row.costMultiplier, row.n, row.missing])).toEqual([
      [2, 1, 20, 0],
      [2, 2, 20, 0],
      [5, 1, 20, 0],
      [5, 2, 20, 0],
      [15, 1, 20, 0],
      [15, 2, 20, 0]
    ])
    const mean = (delayMin: number, costMultiplier: number): number => result.rows.find((row) => row.delayMin === delayMin && row.costMultiplier === costMultiplier)?.meanNetPct as number
    // Two minutes late: in at the 2-minute open, out two minutes after the trader at 62 minutes -- the whole hour's rise
    // from minute 2, i.e. 1.001^58 compounded on the levels, less 2 x 0.05% fees and 2 x 0.02% impact.
    const gross2 = (priceAt(entries[19] + 62 * MIN) / priceAt(entries[19] + 2 * MIN) - 1) * 100
    expect(mean(2, 1)).toBeCloseTo(gross2 - 0.14, 6)
    expect(mean(2, 2)).toBeCloseTo(gross2 - 0.28, 6)
    expect(mean(5, 1)).toBeLessThan(mean(2, 1))
    expect(mean(15, 1)).toBeLessThan(mean(5, 1))
    for (const row of result.rows) expect(row.aboveZero, `${row.delayMin}/${row.costMultiplier}`).toBe((row.interval as { low: number }).low > 0)
    expect(result).toMatchObject({ trips: 20, noVenue: 0, impactAssumed: ['ABC'], fundingAssumed: 0 })
  })

  it('charges the book impact where it was read, and the assumed funding against the position where none was published', () => {
    const read = delayOf({ trips, costs: new Map([['ABC', { venue: 'binance', symbol: 'ABCUSDT', takerFeePct: 0.05, impactPct: 0.1 }]]), bars: new Map([['ABC', ABC]]), funding, nowMs: NOW * 1000 })
    expect(read.impactAssumed).toEqual([])
    expect(read.fundingAssumed).toBe(0)
    const at2 = (r: typeof read): number => r.rows[0].meanNetPct as number
    // 0.1% impact each way, not 0.02%: 0.16 more.
    expect(at2(result) - at2(read)).toBeCloseTo(0.16, 6)
    // An hour's hold crossing an 8-hour mark pays the assumed rate against it.
    const late = entries.map((entry) => entry - (entry % (8 * 3600)) + 8 * 3600 - 30 * MIN)
    const crossing = delayOf({ trips: late.map((entry) => tripAt(entry, 60)), costs, bars: new Map([['ABC', late.flatMap((entry) => bars(entry - 5 * MIN, entry + 80 * MIN, () => 100))]]), funding: new Map(), nowMs: NOW * 1000 })
    expect(crossing.fundingAssumed).toBe(20)
    expect(crossing.rows[0].meanNetPct).toBeCloseTo(-0.14 - 0.01, 9)
  })

  it('takes the last 90 days, the most recent 500, counts trips no venue covers and trips without bars', () => {
    const old = tripAt(NOW - 120 * DAY, 60)
    const elsewhere = tripAt(entries[3], 60, 'long', 'XYZ')
    const gap = tripAt(NOW - 3 * DAY, 60)
    const mixed = delayOf({ trips: [...trips, old, elsewhere, gap], costs, bars: new Map([['ABC', ABC]]), funding, nowMs: NOW * 1000 })
    expect(mixed.trips).toBe(21)
    expect(mixed.noVenue).toBe(1)
    expect(mixed.rows[0].missing).toBe(1)
    expect(mixed.rows[0].n).toBe(20)
    const many = Array.from({ length: 600 }, (_, k) => tripAt(NOW - DAY + k * MIN, 1))
    expect(delayOf({ trips: many, costs, bars: new Map([['ABC', bars(NOW - DAY, NOW, () => 100)]]), funding, nowMs: NOW * 1000 }).trips).toBe(DELAY_LINES.maxTrips)
  })

  it('calls no one followable until a follow has measured its delay, then reads the row at or past it', () => {
    expect(followableAt(result, null)).toBeNull()
    expect(followableAt(result, 90)).toEqual({ followable: result.rows[0].aboveZero, delayMin: 2 })
    expect(followableAt(result, 121)).toEqual({ followable: result.rows[2].aboveZero, delayMin: 5 })
    // At a row's own delay, that row; and a row whose interval reaches 0 is not followable.
    expect(followableAt(result, 120)).toEqual({ followable: result.rows[0].aboveZero, delayMin: 2 })
    expect(followableAt({ ...result, rows: result.rows.map((row) => ({ ...row, aboveZero: false })) }, 90)).toEqual({ followable: false, delayMin: 2 })
    // Later than the latest row: not followable.
    expect(followableAt(result, 16 * MIN)).toEqual({ followable: false, delayMin: 15 })
  })
})
