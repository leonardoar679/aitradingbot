import { describe, expect, it } from 'vitest'
import { rngOf } from '../shared/forecast/ml/bins'
import type { RoundTrip } from '../shared/traders/roundTrips'
import { SKILL_LINES, betaBefore, closeAt, skillOf, type CloseSeries } from '../shared/traders/skill'

// IS IT SKILL (shared/traders/skill.ts; V8-S6-SKILL): on markets made up here, a trader who sees the next four hours is
// SKILL; one who picks sides by a coin toss is not; one who is merely long through a rise the record's own days hold is
// not either -- the shifted schedule does as well -- though the sides by a coin toss alone would have passed them; and a
// short record is TOO FEW, with each line it misses.

const STEP = 900
const DAY = 86_400
const START = 1_780_000_000 - (1_780_000_000 % DAY)

/** Fifteen-minute closes from returns made by `ret`, from 30 days before START to `days` after. */
function series(days: number, ret: (k: number, sec: number) => number): CloseSeries {
  const n = ((days + 31) * DAY) / STEP
  const closes = new Float64Array(n)
  let price = 100
  for (let k = 0; k < n; k++) {
    price *= Math.exp(ret(k, START - 30 * DAY + k * STEP))
    closes[k] = price
  }
  return { startSec: START - 30 * DAY, stepSec: STEP, closes }
}

/** Hourly closes from a fifteen-minute series: every fourth. */
function hourly(fine: CloseSeries): CloseSeries {
  const closes = new Float64Array(Math.floor(fine.closes.length / 4))
  for (let k = 0; k < closes.length; k++) closes[k] = fine.closes[4 * k + 3]
  return { startSec: fine.startSec, stepSec: 3600, closes }
}

const noise = (seed: number, sd: number): ((k: number) => number) => {
  const rng = rngOf(seed)
  const draws: number[] = []
  return (k) => {
    while (draws.length <= k) {
      // A normal draw from two uniforms.
      const u = Math.max(1e-12, rng())
      draws.push(sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()))
    }
    return draws[k]
  }
}

const trip = (coin: string, openSec: number, holdSec: number, side: 'long' | 'short', fine: CloseSeries): RoundTrip => {
  const entryPx = closeAt(fine, openSec) as number
  const exitPx = closeAt(fine, openSec + holdSec) as number
  return {
    coin,
    side,
    openedAtMs: openSec * 1000,
    closedAtMs: (openSec + holdSec) * 1000,
    entryPx,
    exitPx,
    maxSize: 1,
    entryNotional: entryPx,
    realizedPnl: 0,
    fees: 0,
    rebates: 0,
    funding: 0,
    net: 0,
    movePct: (side === 'long' ? exitPx / entryPx - 1 : 1 - exitPx / entryPx) * 100,
    fills: 2
  }
}

const btcSteps = noise(1, 0.003)
const BTC = series(60, (k) => btcSteps(k))
const coinSteps = noise(2, 0.002)
const ABC = series(60, (k) => 1.5 * btcSteps(k) + coinSteps(k))
const MARKET = { bars: new Map([['ABC', ABC], ['BTC', BTC]]), hourly: new Map([['ABC', hourly(ABC)], ['BTC', hourly(BTC)]]) }

/** One trip a day, opened at a time drawn per day, held four hours, its side by `sideOf`. */
function trips(days: number, sideOf: (openSec: number, move: number, rng: () => number) => 'long' | 'short', seed = 3, market: CloseSeries = ABC): RoundTrip[] {
  const rng = rngOf(seed)
  const out: RoundTrip[] = []
  for (let day = 0; day < days; day++) {
    const openSec = START + day * DAY + Math.floor(rng() * 80) * STEP
    const move = (closeAt(market, openSec + 4 * 3600) as number) / (closeAt(market, openSec) as number) - 1
    out.push(trip('ABC', openSec, 4 * 3600, sideOf(openSec, move, rng), market))
  }
  return out
}

describe('the market made up here', () => {
  it('reads a close at the end of the bar that held it, and a beta from the hours before a day', () => {
    expect(closeAt(BTC, BTC.startSec)).toBeNull()
    expect(closeAt(BTC, BTC.startSec + STEP)).toBe(BTC.closes[0])
    expect(closeAt(BTC, BTC.startSec + STEP + 899)).toBe(BTC.closes[0])
    expect(closeAt(BTC, BTC.startSec + 2 * STEP)).toBe(BTC.closes[1])
    const twice = series(60, (k) => 2 * btcSteps(k))
    expect(betaBefore(hourly(twice), hourly(BTC), START + 10 * DAY)?.beta).toBeCloseTo(2, 6)
    expect(betaBefore(hourly(BTC), hourly(BTC), START + 10 * DAY)?.beta).toBeCloseTo(1, 9)
    // Too few hours before the series begins: no beta.
    expect(betaBefore(hourly(ABC), hourly(BTC), START - 20 * DAY)).toBeNull()
  })
})

describe('V8-S6-SKILL', () => {
  it('calls a trader who knows the next four hours SKILL: every line met', () => {
    const result = skillOf({ trips: trips(50, (_open, move) => (move >= 0 ? 'long' : 'short')), ...MARKET, key: 'seer' })
    expect(result.verdict).toBe('SKILL')
    expect(result.reasons).toEqual([])
    expect(result).toMatchObject({ trips: 50, withoutBars: 0, tradingDays: 50, draws: SKILL_LINES.draws })
    expect(result.pFlip as number).toBeLessThanOrEqual(0.01)
    expect(result.pShift as number).toBeLessThanOrEqual(0.01)
    expect((result.interval as { low: number }).low).toBeGreaterThan(0)
    expect((result.halvesPct as [number, number])[0]).toBeGreaterThan(0)
    expect((result.halvesPct as [number, number])[1]).toBeGreaterThan(0)
  })

  it('calls a trader who picks sides by a coin toss MARKET OR LUCK', () => {
    const result = skillOf({ trips: trips(50, (_open, _move, rng) => (rng() < 0.5 ? 'long' : 'short'), 7), ...MARKET, key: 'toss' })
    expect(result.verdict).toBe('MARKET OR LUCK')
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it('calls a trader merely long through a rise in the record MARKET OR LUCK: the shifted schedule does as well, though the coin toss alone would pass them', () => {
    // A market that only starts rising when the record does: the days before it hold no drift for a beta to remove.
    const flat = noise(11, 0.002)
    const rising = series(60, (k, sec) => flat(k) + (sec >= START ? 0.0008 : 0))
    const market = { bars: new Map([['ABC', rising], ['BTC', BTC]]), hourly: new Map([['ABC', hourly(rising)], ['BTC', hourly(BTC)]]) }
    const result = skillOf({ trips: trips(50, () => 'long', 5, rising), ...market, key: 'always-long' })
    expect(result.pFlip).toBeLessThanOrEqual(0.01)
    expect(result.pShift as number).toBeGreaterThan(0.01)
    expect(result.verdict).toBe('MARKET OR LUCK')
    expect(result.reasons.some((reason) => reason.startsWith('the shifted schedule does as well'))).toBe(true)
  })

  it('calls a short record TOO FEW, naming each line it misses, and asks neither null', () => {
    const result = skillOf({ trips: trips(20, (_open, move) => (move >= 0 ? 'long' : 'short')), ...MARKET, key: 'short' })
    expect(result.verdict).toBe('TOO FEW')
    // Twenty trips on twenty days: under 30 trips and under 30 calendar days, but not under 15 trading days.
    expect(result.reasons).toHaveLength(2)
    expect(result.reasons[0]).toBe('20 completed round trips, under 30')
    expect(result.reasons[1]).toMatch(/^19\.\d calendar days, under 30$/)
    expect(skillOf({ trips: trips(40, () => 'long').filter((_, k) => k % 4 === 0), ...MARKET, key: 'sparse' }).reasons).toEqual(expect.arrayContaining(['10 trading days, under 15']))
    expect(result.pFlip).toBeNull()
    expect(result.pShift).toBeNull()
  })

  it('leaves out a trip whose coin has no bars at its times, and draws the same for the same record', () => {
    const record = trips(40, (_open, move) => (move >= 0 ? 'long' : 'short'))
    const lost = { ...record[0], coin: 'XYZ' }
    const once = skillOf({ trips: [...record, lost], ...MARKET, key: 'k' })
    const again = skillOf({ trips: [...record, lost], ...MARKET, key: 'k' })
    expect(once.withoutBars).toBe(1)
    expect(once.trips).toBe(40)
    expect(again).toEqual(once)
    // Another key draws other offsets and signs.
    const other = skillOf({ trips: record, ...MARKET, key: 'another' })
    expect(other.pFlip).not.toBeNull()
  })
})
