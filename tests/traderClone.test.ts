import { describe, expect, it } from 'vitest'
import { rngOf } from '../shared/forecast/ml/bins'
import { CLONE_FEATURES, CLONE_LINES, cloneOf, cloneTradesOf, cloneVerdictOf, featuresAt, fitRule, ruleHolds, type CloneCosts } from '../shared/traders/clone'
import type { RoundTrip } from '../shared/traders/roundTrips'
import { closeAt, type CloseSeries } from '../shared/traders/skill'

// CAN A RULE DO WHAT THE TRADER DOES (shared/traders/clone.ts; V8-S7-CLONE): the twelve features read at a moment from
// the bars before it; a rule fitted to tell entries from moved moments; and, on markets made up here, a momentum trader
// whose rule both finds their entries and makes money on its own (REPLICABLE), one whose timing a rule finds but who
// buys the top of every rise (PARTLY), one who trades by a coin toss (NOT REPLICABLE), and records too short to judge.

const BAR = 900
const DAY = 86_400
const START = 1_780_000_000 - (1_780_000_000 % DAY)

/** Fifteen-minute closes from 31 days before START to `days` after, bar k's log return `ret(k)`. */
function series(days: number, ret: (k: number) => number): CloseSeries {
  const n = ((days + 31) * DAY) / BAR
  const closes = new Float64Array(n)
  let price = 100
  for (let k = 0; k < n; k++) {
    price *= Math.exp(ret(k))
    closes[k] = price
  }
  return { startSec: START - 31 * DAY, stepSec: BAR, closes }
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

const btcSteps = noise(1, 0.002)
const BTC = series(120, (k) => btcSteps(k))
const BTC_HOURLY = hourly(BTC)
const COSTS = new Map<string, CloneCosts>([['ABC', { takerFeePct: 0.05, impactPct: null }]])

/** Bar k's place in a cycle of `length` bars, measured from START's bars. */
const phase = (k: number, length: number): number => (((k - (31 * DAY) / BAR) % length) + length) % length

describe('the features', () => {
  it('reads each of the twelve from the closes before a moment, and none where a close is missing', () => {
    // The coin rising 0.1% a bar, Bitcoin 0.2% an hour.
    const coin = series(10, () => 0.001)
    const btc: CloseSeries = { startSec: coin.startSec, stepSec: 3600, closes: Float64Array.from({ length: 41 * 24 }, (_, k) => 50 * Math.exp(0.002 * (k + 1))) }
    const sec = START + 2 * DAY + 13 * 3600 + 5 * 60
    const row = featuresAt(coin, btc, sec) as Float64Array
    const at = (name: (typeof CLONE_FEATURES)[number]): number => row[CLONE_FEATURES.indexOf(name)]
    expect(at('ret1h')).toBeCloseTo(0.004, 12)
    expect(at('ret4h')).toBeCloseTo(0.016, 12)
    expect(at('ret24h')).toBeCloseTo(0.096, 12)
    expect(at('vol24h')).toBeCloseTo(0, 12)
    expect(at('volRatio')).toBe(1)
    expect(at('rangePos24h')).toBe(1)
    const end = Math.floor((sec - coin.startSec) / BAR) - 1
    const window = Array.from(coin.closes.subarray(end - 96, end + 1))
    expect(at('fromMean24h')).toBeCloseTo(coin.closes[end] / (window.reduce((a, b) => a + b, 0) / 97) - 1, 12)
    expect(at('btcRet1h')).toBeCloseTo(0.002, 12)
    expect(at('btcRet24h')).toBeCloseTo(0.048, 12)
    expect(at('relRet24h')).toBeCloseTo(0.096 - 0.048, 12)
    // 13:05 UTC on a Saturday: START is a Thursday's midnight, and two days on.
    expect(at('hourUtc')).toBe(13)
    expect(at('weekdayUtc')).toBe(5)
    // A rough day: the last four hours' moves against the day's.
    const rough = series(10, (k) => (k % 2 === 0 ? 0.01 : -0.01) * (phase(k, 96) >= 80 ? 2 : 1))
    const roughRow = featuresAt(rough, btc, START + 3 * DAY) as Float64Array
    // The last four hours' moves of 2% against a day of eighty moves of 1% and sixteen of 2%.
    expect(roughRow[CLONE_FEATURES.indexOf('volRatio')]).toBeCloseTo(0.02 / Math.sqrt((80 * 0.0001 + 16 * 0.0004) / 96), 9)
    // Before a day of bars, without Bitcoin, or on bars of another size: nothing.
    expect(featuresAt(coin, btc, coin.startSec + 90 * BAR)).toBeNull()
    expect(featuresAt(coin, undefined, sec)).toBeNull()
    expect(featuresAt({ ...coin, stepSec: 3600 }, btc, sec)).toBeNull()
  })
})

describe('the rule', () => {
  it('finds the condition that tells entries from moved moments, holding at a fifth of the entries at least', () => {
    const rng = rngOf(5)
    const row = (ret4h: number): Float64Array => Float64Array.from(CLONE_FEATURES, (name) => (name === 'ret4h' ? ret4h : rng()))
    const positives = Array.from({ length: 60 }, () => row(0.03 + 0.01 * rng()))
    const negatives = Array.from({ length: 240 }, () => row(0.04 * rng() - 0.02))
    const rule = fitRule(positives, negatives) as NonNullable<ReturnType<typeof fitRule>>
    expect(rule.conditions.some((condition) => condition.feature === 'ret4h' && condition.op === '>=')).toBe(true)
    expect(rule.tpr).toBeGreaterThanOrEqual(CLONE_LINES.minSupport)
    expect(rule.tpr - rule.fpr).toBeGreaterThan(0.8)
    expect(positives.every((one) => ruleHolds(rule.conditions, one))).toBe(rule.tpr === 1)
    expect(rule.conditions.length).toBeLessThanOrEqual(2)
    expect(fitRule([], negatives)).toBeNull()
  })

  /** Rows whose every feature is 0 but those given. */
  const rowOf = (values: Partial<Record<(typeof CLONE_FEATURES)[number], number>>): Float64Array => Float64Array.from(CLONE_FEATURES, (name) => values[name] ?? 0)

  it('holds at a fifth of the entries at least, though a rarer condition would tell them apart a little better', () => {
    // A sixth of the entries, and a twelfth of the moved moments, at the top of ret1h; the rest spread evenly below.
    const positives = [...Array.from({ length: 10 }, () => rowOf({ ret1h: 3 })), ...Array.from({ length: 50 }, (_, k) => rowOf({ ret1h: k / 50 }))]
    const negatives = [...Array.from({ length: 20 }, () => rowOf({ ret1h: 3 })), ...Array.from({ length: 220 }, (_, k) => rowOf({ ret1h: k / 220 }))]
    const rule = fitRule(positives, negatives) as NonNullable<ReturnType<typeof fitRule>>
    expect(rule.tpr).toBeGreaterThanOrEqual(CLONE_LINES.minSupport)
  })

  it('sets two conditions on two different features, never a band of one', () => {
    // Entries in the middle of ret4h's range: a band would hold at all of them and a fifth of the moved moments.
    const positives = Array.from({ length: 60 }, (_, k) => rowOf({ ret4h: 0.4 + (0.2 * k) / 60 }))
    const negatives = Array.from({ length: 240 }, (_, k) => rowOf({ ret4h: k / 240 }))
    const rule = fitRule(positives, negatives) as NonNullable<ReturnType<typeof fitRule>>
    expect(new Set(rule.conditions.map((condition) => condition.feature)).size).toBe(rule.conditions.length)
    expect(rule.tpr - rule.fpr).toBeLessThan(0.5)
  })

  it('takes two conditions where it takes both to tell the entries apart', () => {
    const positives = Array.from({ length: 60 }, () => rowOf({ ret1h: 1, ret4h: 1 }))
    const negatives = [...Array.from({ length: 80 }, () => rowOf({ ret1h: 1 })), ...Array.from({ length: 80 }, () => rowOf({ ret4h: 1 })), ...Array.from({ length: 80 }, () => rowOf({}))]
    const rule = fitRule(positives, negatives) as NonNullable<ReturnType<typeof fitRule>>
    expect(rule.conditions.map((condition) => `${condition.feature} ${condition.op} ${condition.threshold}`)).toEqual(['ret1h >= 1', 'ret4h >= 1'])
    expect(rule).toMatchObject({ tpr: 1, fpr: 0 })
  })
})

describe("the clone's own trades, and the verdict", () => {
  it('trades wherever the rule holds, one trade a coin at a time, paying fees, impact and funding', () => {
    // A flat coin: each trade's net is its costs alone.
    const flat = series(10, () => 0)
    const input = { bars: new Map([['ABC', flat], ['DEF', flat]]), hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS }
    const always = { side: 'long' as const, conditions: [], holdBars: 8 }
    const trades = cloneTradesOf(always, ['ABC', 'DEF'], input, START + DAY, START + 2 * DAY)
    // DEF has no costs: not traded. ABC: in every two hours from the day's first close to its last, thirteen trades;
    // 0.05% fee and 0.02% impact each way, and 0.01% at each eight-hour mark a hold crosses -- the fourth, eighth and
    // twelfth, which open at 06:00, 14:00 and 22:00.
    expect(trades.map((trade) => trade.coin)).toEqual(Array(13).fill('ABC'))
    expect(trades.map((trade) => (trade.openSec - START - DAY) / 3600)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24])
    expect(trades.map((trade) => Number(trade.netPct.toFixed(10)))).toEqual([-0.14, -0.14, -0.14, -0.15, -0.14, -0.14, -0.14, -0.15, -0.14, -0.14, -0.14, -0.15, -0.14])
    // A book read at 0.1% is charged; a short pays the same; a rule that never holds trades nothing.
    const deep = cloneTradesOf({ ...always, side: 'short' }, ['ABC'], { ...input, costs: new Map([['ABC', { takerFeePct: 0.05, impactPct: 0.1 }]]) }, START + DAY, START + DAY + 3600)
    expect(deep.map((trade) => Number(trade.netPct.toFixed(10)))).toEqual([-0.3])
    // On a coin rising 0.1% a bar: in at the close where the rule holds, out eight closes later.
    const rising = cloneTradesOf(always, ['ABC'], { ...input, bars: new Map([['ABC', series(10, () => 0.001)]]) }, START + DAY, START + DAY + 3600)
    expect(rising).toHaveLength(1)
    expect(rising[0].netPct).toBeCloseTo((Math.exp(0.008) - 1) * 100 - 0.14, 9)
    expect(cloneTradesOf({ ...always, conditions: [{ feature: 'ret1h', op: '>=', threshold: 1 }] }, ['ABC'], input, START + DAY, START + 2 * DAY)).toEqual([])
  })

  it('is REPLICABLE where both lines hold, PARTLY where one does, NOT REPLICABLE where neither does', () => {
    const met = { interval: { low: 0.7, high: 0.9 } }
    const gained = { n: 30, interval: { low: 0.1, high: 0.5 } }
    expect(cloneVerdictOf(met, gained)).toEqual({ verdict: 'REPLICABLE', reasons: [] })
    expect(cloneVerdictOf(met, { ...gained, n: 29 })).toEqual({ verdict: 'PARTLY', reasons: ['the clone made 29 trades in the last third, under 30'] })
    expect(cloneVerdictOf({ interval: { low: 0.6, high: 0.9 } }, gained)).toEqual({ verdict: 'PARTLY', reasons: ["the last third's AUC reaches 0.6 or below"] })
    expect(cloneVerdictOf({ interval: null }, { n: 40, interval: { low: 0, high: 0.5 } })).toEqual({ verdict: 'NOT REPLICABLE', reasons: ["the last third's AUC has no interval", "the clone's mean net reaches 0 or below"] })
    expect(cloneVerdictOf(met, { n: 40, interval: null })).toEqual({ verdict: 'PARTLY', reasons: ["the clone's mean net has no interval"] })
  })
})

/** A trader on a market of 16-hour cycles -- 8 hours up 0.3% a bar, 8 hours down -- entering long 4 hours into each
 * rise and short 4 hours into each fall, each held 2 hours, over `days` days. */
function cycles(days: number, length = 64, longAt = 16, shortAt = 48, holdSec = 2 * 3600): { market: CloseSeries; trips: RoundTrip[] } {
  const wiggle = noise(9, 0.0005)
  const market = series(days, (k) => (phase(k, length) < length / 2 ? 0.003 : -0.003) + wiggle(k))
  const trips: RoundTrip[] = []
  for (let start = START; start + length * BAR < START + days * DAY; start += length * BAR) {
    trips.push(trip('ABC', start + longAt * BAR + 30, holdSec, 'long', market))
    if (shortAt >= 0) trips.push(trip('ABC', start + shortAt * BAR + 30, holdSec, 'short', market))
  }
  return { market, trips }
}

describe('V8-S7-CLONE', () => {
  it("calls a momentum trader REPLICABLE: a rule finds their entries in the last third, and makes money there on its own", () => {
    const { market, trips } = cycles(90)
    const result = cloneOf({ trips, bars: new Map([['ABC', market]]), hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS, key: 'momentum' })
    expect(result.verdict).toBe('REPLICABLE')
    expect(result.reasons).toEqual([])
    expect(result).toMatchObject({ withoutFeatures: 0, trainEntries: Math.floor(trips.length * (2 / 3)) })
    expect(result.rule?.holdBars).toBe(8)
    // The rule's side's entries in the last third, each against its four moved moments.
    expect(result.outOfTime).toMatchObject({ positives: 45, negatives: 180 })
    expect(result.outOfTime?.interval?.low as number).toBeGreaterThan(0.6)
    expect(result.trades?.n as number).toBeGreaterThanOrEqual(30)
    expect(result.trades?.interval?.low as number).toBeGreaterThan(0)
    // The same record draws the same, and another key other moved moments.
    expect(cloneOf({ trips, bars: new Map([['ABC', market]]), hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS, key: 'momentum' })).toEqual(result)
    expect(cloneOf({ trips, bars: new Map([['ABC', market]]), hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS, key: 'another' }).training).not.toEqual(result.training)
  })

  it('keeps the side whose rule tells its entries apart the better', () => {
    // The longs of the momentum trader, and as many shorts at times drawn by chance.
    const { market, trips } = cycles(90)
    const rng = rngOf(23)
    const longs = trips.filter((entry) => entry.side === 'long')
    const shorts = longs.map(() => trip('ABC', START + Math.floor(rng() * 88 * DAY), 2 * 3600, 'short', market))
    const result = cloneOf({ trips: [...longs, ...shorts], bars: new Map([['ABC', market]]), hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS, key: 'mixed' })
    expect(result.rule?.side).toBe('long')
  })

  it('calls a trader who buys the top of every rise PARTLY: a rule finds their timing, but loses money on its own', () => {
    // Cycles of 8 hours, 4 up and 4 down: in long at the top, held 2 hours and a minute into the fall -- nine bars, rounded
    // up.
    const { market, trips } = cycles(90, 32, 16, -1, 2 * 3600 + 60)
    const result = cloneOf({ trips, bars: new Map([['ABC', market]]), hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS, key: 'top' })
    expect(result.verdict).toBe('PARTLY')
    expect(result.rule?.holdBars).toBe(9)
    expect(result.outOfTime?.interval?.low as number).toBeGreaterThan(0.6)
    expect(result.reasons).toEqual(["the clone's mean net reaches 0 or below"])
    expect(result.trades?.meanNetPct as number).toBeLessThan(0)
  })

  it('calls a trader who trades by a coin toss NOT REPLICABLE', () => {
    const steps = noise(13, 0.003)
    const market = series(120, (k) => steps(k))
    const rng = rngOf(17)
    const trips = Array.from({ length: 240 }, (_, k) => trip('ABC', START + k * 11 * 3600 + Math.floor(rng() * 3600), 2 * 3600, rng() < 0.5 ? 'long' : 'short', market))
    const result = cloneOf({ trips, bars: new Map([['ABC', market]]), hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS, key: 'toss' })
    expect(result.verdict).toBe('NOT REPLICABLE')
    expect(result.reasons).toHaveLength(2)
    expect(result.reasons[0]).toBe("the last third's AUC reaches 0.6 or below")
  })

  it('calls a short record TOO FEW: too few entries a side to fit, or too few of the rule\'s side to test', () => {
    const { market, trips } = cycles(90)
    const bars = new Map([['ABC', market]])
    const few = cloneOf({ trips: trips.slice(0, 20), bars, hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS, key: 'few' })
    expect(few).toMatchObject({ verdict: 'TOO FEW', rule: null, reasons: ['no side has 10 entries in the first two thirds to fit a rule on'] })
    // Longs only, 86 of them: 57 fit the rule, and 29 are left to test it.
    const longs = trips.filter((entry) => entry.side === 'long').slice(0, 86)
    const tested = cloneOf({ trips: longs, bars, hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS, key: 'longs' })
    expect(tested).toMatchObject({ verdict: 'TOO FEW', trainEntries: 57, testEntries: 29, outOfTime: null, trades: null })
    expect(tested.rule?.side).toBe('long')
    expect(tested.reasons).toEqual(['29 long entries in the last third, under 30'])
    // A trip on a coin without bars, or before a day of bars, is not read.
    const early = { ...trips[0], openedAtMs: (market.startSec + 10 * BAR) * 1000 }
    const lost = { ...trips[1], coin: 'XYZ' }
    expect(cloneOf({ trips: [...trips, early, lost], bars, hourly: new Map([['BTC', BTC_HOURLY]]), costs: COSTS, key: 'k' }).withoutFeatures).toBe(2)
  })
})
