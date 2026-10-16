import { describe, expect, it } from 'vitest'
import { FORECAST_BAR_SECONDS, coarseBars, type ForecastBar } from '../shared/forecast/bars'
import { FEATURE_NAMES, quickAt, type PairSeries } from '../shared/forecast/features'
import {
  MARKET_SHOCK_LINES,
  MARKET_SHOCK_STATES,
  STATE_UNKNOWN,
  WIDENED_STATES,
  btcReadingAt,
  btcBeforeOf,
  btcTimelineOf,
  chooseWidening,
  latestShockBefore,
  marketShockByTime,
  marketShockRulesOf,
  marketShockStateOf,
  marketWidening,
  noMarketShockRecord,
  shockMomentsOf,
  shockWayOf,
  type MarketReading,
  type MarketShockRow,
  type ShockMoment
} from '../shared/forecast/marketShock'
import { SHOCK_LINES, crossFittedFactors, liveBtcMove, noShockRecord, pastShockLine, scoreShock, shockRuleFrom, shockRuleOf, type ShockRule } from '../shared/forecast/shock'
import { usualMove } from '../shared/forecast/targets'
import { gaussOf, rng } from './forecastRecords'

// THE MARKET'S SHOCK STATES (shared/forecast/marketShock.ts; V7.1 Stage 11, 16 October 2026): six states
// told apart from what is known at the moment, by lines fixed before anything was measured; the shock
// moments read from Bitcoin's bars at every five-minute close; a widening fitted per state and judged as
// V6.1's; the horizon's choice among the widenings; and what widens a range at a moment.

const reading = (patch: Partial<MarketReading> = {}): MarketReading => ({ t: 1_000_000, btc15: 0, btc1h: 0, breadth15: 0.5, volAcc15: 1, ...patch })

describe('the states', () => {
  it('are six, their lines pinned', () => {
    expect(MARKET_SHOCK_STATES).toEqual(['NORMAL', 'PRE_EVENT', 'POST_EVENT_SHOCK', 'TRENDING_SHOCK', 'LIQUIDATION_SHOCK', 'RECOVERY'])
    expect(WIDENED_STATES).toEqual(['PRE_EVENT', 'POST_EVENT_SHOCK', 'TRENDING_SHOCK', 'LIQUIDATION_SHOCK', 'RECOVERY'])
    expect(MARKET_SHOCK_LINES).toEqual({ line: SHOCK_LINES.line, trendLine: 2.5, liquidationBreadth: 0.2, liquidationVolume: 3, recoveryHours: 4, recoveryLine: 1, preEventMinutes: 60 })
    expect(STATE_UNKNOWN).toBe(255)
  })

  it("reads a shock's way from Bitcoin's fifteen minutes at or past the line, and nothing from its hour alone", () => {
    expect(shockWayOf({ btc15: 2.5 })).toBe(1)
    expect(shockWayOf({ btc15: -2.5 })).toBe(-1)
    expect(shockWayOf({ btc15: 2.49 })).toBe(0)
    expect(shockWayOf({ btc15: -2.49 })).toBe(0)
    expect(shockWayOf({ btc15: Number.NaN })).toBe(0)
    // The forty-five minutes before the last fifteen, from the hour's and the fifteen minutes' figures: an
    // hour of 3 usual hourly moves whose last fifteen minutes were 3 usual fifteen-minute moves left
    // 3 x sqrt(12/9) - 3 x sqrt(3/9) of their own usual move to the forty-five before.
    expect(btcBeforeOf({ btc15: 3, btc1h: 3 })).toBeCloseTo(3 * Math.sqrt(12 / 9) - 3 * Math.sqrt(3 / 9), 12)
    // A flat hour whose last fifteen minutes jumped: the forty-five before went the other way by as much.
    expect(btcBeforeOf({ btc15: 4, btc1h: 0 })).toBeCloseTo(-4 * Math.sqrt(3 / 9), 12)
    expect(btcBeforeOf({ btc15: 0, btc1h: 0 })).toBe(0)
  })

  it('is POST_EVENT_SHOCK past the line, TRENDING_SHOCK where the forty-five minutes before already trended the same way, LIQUIDATION_SHOCK on a broad, heavy fall', () => {
    expect(marketShockStateOf(reading({ btc15: 2.5 }), [])).toBe('POST_EVENT_SHOCK')
    expect(marketShockStateOf(reading({ btc15: -2.5 }), [])).toBe('POST_EVENT_SHOCK')
    // A 3% fall in fifteen minutes from a flat hour (its hour at half the fifteen minutes' figure): a break.
    expect(marketShockStateOf(reading({ btc15: -8, btc1h: -4 }), [])).toBe('POST_EVENT_SHOCK')
    // The forty-five minutes before at 2.5 of their usual moves the same way: the trend continues.
    const trending = (btc15: number, before: number): number => (before + btc15 * Math.sqrt(3 / 9)) / Math.sqrt(12 / 9)
    expect(btcBeforeOf({ btc15: 2.6, btc1h: trending(2.6, 2.5) })).toBeCloseTo(2.5, 12)
    expect(marketShockStateOf(reading({ btc15: 2.6, btc1h: trending(2.6, 2.5) }), [])).toBe('TRENDING_SHOCK')
    expect(marketShockStateOf(reading({ btc15: 2.6, btc1h: trending(2.6, 2.49) }), [])).toBe('POST_EVENT_SHOCK')
    expect(marketShockStateOf(reading({ btc15: -2.6, btc1h: trending(-2.6, -2.5) }), [])).toBe('TRENDING_SHOCK')
    // A sharp move against a trending forty-five minutes is a break, not the trend; a trend without the sharp
    // fifteen minutes is no shock.
    expect(marketShockStateOf(reading({ btc15: -2.6, btc1h: trending(-2.6, 3) }), [])).toBe('POST_EVENT_SHOCK')
    expect(marketShockStateOf(reading({ btc15: 0.2, btc1h: trending(0.2, 3) }), [])).toBe('NORMAL')
    expect(marketShockStateOf(reading({ btc15: -2.6, btc1h: Number.NaN }), [])).toBe('POST_EVENT_SHOCK')
    // A liquidation: a sharp fall, the breadth at or under a fifth, the volume at three times or more.
    expect(marketShockStateOf(reading({ btc15: -2.5, breadth15: 0.2, volAcc15: 3 }), [])).toBe('LIQUIDATION_SHOCK')
    expect(marketShockStateOf(reading({ btc15: -2.5, btc1h: -3, breadth15: 0.2, volAcc15: 3 }), [])).toBe('LIQUIDATION_SHOCK')
    expect(marketShockStateOf(reading({ btc15: -2.5, breadth15: 0.21, volAcc15: 3 }), [])).toBe('POST_EVENT_SHOCK')
    expect(marketShockStateOf(reading({ btc15: -2.5, breadth15: 0.2, volAcc15: 2.99 }), [])).toBe('POST_EVENT_SHOCK')
    // A sharp rise is never a liquidation, however thin the breadth.
    expect(marketShockStateOf(reading({ btc15: 2.5, breadth15: 0.1, volAcc15: 5 }), [])).toBe('POST_EVENT_SHOCK')
    expect(marketShockStateOf(reading({ btc15: -2.49, breadth15: 0.1, volAcc15: 5 }), [])).toBe('NORMAL')
  })

  it('is RECOVERY within four hours after a shock, the hour at least one usual move against it, and PRE_EVENT before that', () => {
    const t = 1_000_000
    const down: ShockMoment[] = [{ t: t - 3 * 3600, way: -1 }]
    expect(marketShockStateOf(reading({ t, btc1h: 1 }), down)).toBe('RECOVERY')
    expect(marketShockStateOf(reading({ t, btc1h: 0.99 }), down)).toBe('NORMAL')
    expect(marketShockStateOf(reading({ t, btc1h: -1.5 }), down)).toBe('NORMAL')
    expect(marketShockStateOf(reading({ t, btc1h: -1.5 }), [{ t: t - 3 * 3600, way: 1 }])).toBe('RECOVERY')
    // Exactly four hours after: still within; a second past: not.
    expect(marketShockStateOf(reading({ t, btc1h: 1 }), [{ t: t - 4 * 3600, way: -1 }])).toBe('RECOVERY')
    expect(marketShockStateOf(reading({ t, btc1h: 1 }), [{ t: t - 4 * 3600 - 1, way: -1 }])).toBe('NORMAL')
    // The latest shock's way counts: a fall, then a rise an hour ago; the hour down is recovering from the rise.
    expect(marketShockStateOf(reading({ t, btc1h: -1.2 }), [{ t: t - 3 * 3600, way: -1 }, { t: t - 3600, way: 1 }])).toBe('RECOVERY')
    expect(marketShockStateOf(reading({ t, btc1h: 1.2 }), [{ t: t - 3 * 3600, way: -1 }, { t: t - 3600, way: 1 }])).toBe('NORMAL')
    // A shock now is a shock, whatever came before; a shock at the moment itself is not before it.
    expect(marketShockStateOf(reading({ t, btc15: 3, btc1h: 1 }), down)).toBe('POST_EVENT_SHOCK')
    expect(latestShockBefore([{ t, way: 1 }], t)).toBeNull()
    expect(latestShockBefore([{ t: t - 60, way: 1 }, { t: t + 60, way: -1 }], t)).toEqual({ t: t - 60, way: 1 })
    // Before a scheduled release: told by the caller, since the calendar is Stage 12's; a shock outranks it,
    // and it outranks a recovery.
    expect(marketShockStateOf(reading({ t }), [], { preEvent: true })).toBe('PRE_EVENT')
    expect(marketShockStateOf(reading({ t, btc15: 3 }), [], { preEvent: true })).toBe('POST_EVENT_SHOCK')
    expect(marketShockStateOf(reading({ t, btc1h: 1.5 }), down, { preEvent: true })).toBe('PRE_EVENT')
    expect(marketShockStateOf(reading({ t, btc1h: 1.5 }), down, { preEvent: false })).toBe('RECOVERY')
  })

  it('lists the shock moments of a timeline, oldest first, and leaves calm moments out', () => {
    const moments = shockMomentsOf([
      { t: 300, btc15: 0.1, btc1h: 0.2 },
      { t: 900, btc15: -2.7, btc1h: -1 },
      { t: 600, btc15: 2.5, btc1h: 2.6 },
      { t: 1200, btc15: 1, btc1h: 4 }
    ])
    expect(moments).toEqual([
      { t: 600, way: 1 },
      { t: 900, way: -1 }
    ])
  })
})

// Bitcoin's bars: a flat walk, its last fifteen minutes and its hour set as asked.
const T0 = Date.parse('2026-10-01T00:00:00Z') / 1000
function btcSeries(options: { moveFifteen?: number; moveHour?: number; at?: number } = {}): PairSeries {
  const random = rng(3)
  const m5: ForecastBar[] = []
  let price = 60_000
  const at = options.at ?? T0 + 3 * 86_400
  for (let index = 0; index < 4 * 288; index++) {
    const time = T0 + index * FORECAST_BAR_SECONDS
    const open = price
    price = price * Math.exp(0.001 * (random() - 0.5))
    // The hour before `at` moved by moveHour, its last fifteen minutes by moveFifteen on top.
    const close = time + FORECAST_BAR_SECONDS
    if (close > at - 3600 && close <= at && options.moveHour !== undefined) price = price * Math.exp(options.moveHour / 12)
    if (close > at - 900 && close <= at && options.moveFifteen !== undefined) price = price * Math.exp(options.moveFifteen / 3)
    const volume = 10
    m5.push({ time, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume, quoteVolume: volume * price, takerBuyVolume: 5, trades: 10 })
  }
  return { m5, h1: coarseBars(m5, '1h', Number.POSITIVE_INFINITY) }
}

describe("Bitcoin's readings from its bars", () => {
  it("are its row's own z_15m and z_1h figures, at every five-minute close, and none before a day of bars", () => {
    const at = T0 + 3 * 86_400
    const series = btcSeries({ moveFifteen: 0.02, moveHour: 0.01 })
    const read = btcReadingAt(series, at)!
    const quick = quickAt(series, at)!
    expect(read.t).toBe(at)
    expect(read.btc15).toBeCloseTo(quick.r15m / usualMove(quick.rv24h, 3), 12)
    expect(read.btc1h).toBeCloseTo(quick.r1h / usualMove(quick.rv24h, 12), 12)
    expect(read.btc15).toBeGreaterThan(2.5)
    expect(btcReadingAt(series, at + 60)).toBeNull()
    expect(btcReadingAt(series, T0 + 3600)).toBeNull()
    const timeline = btcTimelineOf(series, at - 3600 + 1, at)
    expect(timeline.map((entry) => entry.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((k) => at - 3600 + k * 300))
    expect(timeline[timeline.length - 1]).toEqual(read)
    expect(btcTimelineOf(series, T0, T0 + 3600)).toEqual([])
    // The same way live, from the minutes: the minute forming against the close an hour and a minute before it.
    const rv24h = quick.rv24h
    const minutes = Array.from({ length: 80 }, (_, k) => ({ time: 6000 + k * 60, close: 100 }))
    minutes[minutes.length - 1] = { ...minutes[minutes.length - 1], close: 103 }
    expect(liveBtcMove(minutes, rv24h, 12)).toBeCloseTo(Math.log(1.03) / usualMove(rv24h, 12), 9)
    expect(liveBtcMove(minutes, rv24h, 3)).toBeCloseTo(Math.log(1.03) / usualMove(rv24h, 3), 9)
    expect(liveBtcMove(minutes.slice(-60), rv24h, 12)).toBeNull()
  })

  it("reads each moment of a panel's grid from Bitcoin's row there, with the shock moments before it", () => {
    const cols = FEATURE_NAMES.length
    const Z15 = FEATURE_NAMES.indexOf('z_15m')
    const Z1H = FEATURE_NAMES.indexOf('z_1h')
    const B15 = FEATURE_NAMES.indexOf('breadth_15m')
    const VOL = FEATURE_NAMES.indexOf('market_vol_acc')
    const t = 1_000_000
    // Four moments of Bitcoin's and one of ether's: a fall, a calm quarter, a recovering hour three hours on,
    // and a liquidation; ether's row is not read.
    const rows = [
      { pair: 0, t, z15: -3, z1h: -1.5, b15: 0.4, vol: 1.5 },
      { pair: 1, t, z15: 0.1, z1h: 0.2, b15: 0.4, vol: 1.5 },
      { pair: 0, t: t + 900, z15: 0.1, z1h: -2.6, b15: 0.5, vol: 1 },
      { pair: 0, t: t + 3 * 3600, z15: 0.2, z1h: 1.4, b15: 0.7, vol: 1 },
      { pair: 0, t: t + 5 * 3600, z15: -2.7, z1h: -1, b15: 0.1, vol: 4 }
    ]
    const x = new Float32Array(rows.length * cols)
    rows.forEach((row, index) => {
      x[index * cols + Z15] = row.z15
      x[index * cols + Z1H] = row.z1h
      x[index * cols + B15] = row.b15
      x[index * cols + VOL] = row.vol
    })
    const panel = { rows: rows.length, cols, x, time: Uint32Array.from(rows, (row) => row.t), pair: Uint16Array.from(rows, (row) => row.pair), symbols: ['BTCUSDT', 'ETHUSDT'] }
    // The moments from Bitcoin's bars at every five minutes: the fall at t, and nothing else.
    const moments: ShockMoment[] = [{ t, way: -1 }]
    expect([...marketShockByTime(panel, moments).entries()]).toEqual([
      [t, 'POST_EVENT_SHOCK'],
      [t + 900, 'NORMAL'],
      [t + 3 * 3600, 'RECOVERY'],
      [t + 5 * 3600, 'LIQUIDATION_SHOCK']
    ])
    // Before a release, as the caller says (Stage 12).
    expect(marketShockByTime(panel, moments, (at) => at === t + 900).get(t + 900)).toBe('PRE_EVENT')
    expect(marketShockByTime({ ...panel, symbols: ['ETHUSDT', 'SOLUSDT'] }, moments).size).toBe(0)
  })
})

// A walk forward's rows: the world of tests/forecastShock.test.ts, each moment in a state.
const levels = (mu = 0, sigma = 1): number[] => [-1.2816, -0.6745, 0, 0.6745, 1.2816].map((z) => mu + sigma * z)

function world(options: { weeks?: number; moments?: number; pairs?: number; spread?: Partial<Record<MarketShockRow['state'], number>>; seed?: number; oneState?: boolean } = {}): MarketShockRow[] {
  const gauss = gaussOf(rng(options.seed ?? 7))
  const rows: MarketShockRow[] = []
  const weeks = options.weeks ?? 3
  const pairs = options.pairs ?? 20
  const spread = { NORMAL: 1, POST_EVENT_SHOCK: 2, TRENDING_SHOCK: 2, RECOVERY: 1.7, ...options.spread }
  for (let week = 1; week <= weeks; week++) {
    for (let moment = 0; moment < (options.moments ?? 5); moment++) {
      const t = week * 604_800 + moment * 3600
      for (let pair = 0; pair < pairs; pair++) {
        // A moment past the line, after an event or in a trend by turns (or every one after an event); a calm
        // one; and a recovering one.
        const state = moment % 2 === 0 || options.oneState === true ? 'POST_EVENT_SHOCK' : 'TRENDING_SHOCK'
        rows.push({ z: spread[state]! * gauss(), q: levels(), week, t, btc15: moment % 2 === 0 ? 2.6 : -3.1, state })
        rows.push({ z: spread.NORMAL * gauss(), q: levels(), week, t: t + 1800, btc15: 0.4, state: 'NORMAL' })
        rows.push({ z: spread.RECOVERY * gauss(), q: levels(), week, t: t + 2400, btc15: 0.2, state: 'RECOVERY' })
      }
    }
  }
  return rows
}

describe('the rules by state', () => {
  it('fits each state its own rule the way V6.1 fits the line\'s, from the rows in it', () => {
    const rows = world()
    const line = shockRuleOf(rows)
    const rules = marketShockRulesOf(rows, line)
    expect(rules.version).toBe('market-shock-v1')
    expect(Object.keys(rules.byState).sort()).toEqual(['POST_EVENT_SHOCK', 'RECOVERY', 'TRENDING_SHOCK'])
    expect(rules.byState.POST_EVENT_SHOCK).toEqual(shockRuleFrom(rows.filter((row) => row.state === 'POST_EVENT_SHOCK')))
    expect(rules.byState.RECOVERY).toMatchObject({ adopted: true, refusal: null, moments: 15, rows: 300 })
    expect(rules.byState.RECOVERY!.k80).toBeGreaterThan(1.3)
    expect(rules.byState.RECOVERY!.k80).toBeLessThan(2)
    // The line's rule, on every row past the line, is the two shock states' rows together.
    expect(line.rows).toBe(rules.byState.POST_EVENT_SHOCK!.rows + rules.byState.TRENDING_SHOCK!.rows)
    expect(rows.filter(pastShockLine)).toHaveLength(line.rows)
  })

  it("chooses the states' rules where they lose less on every row either would widen, the line's where it does, neither where neither passed", () => {
    const rows = world()
    const line = shockRuleOf(rows)
    expect(line.adopted).toBe(true)
    const rules = marketShockRulesOf(rows, line)
    // The compared rows: every one past the line or in a state, the calm ones left out.
    expect(rules.compared!.rows).toBe(rows.filter((row) => row.state !== 'NORMAL').length)
    expect(rules.compared!.before).toEqual(scoreShock(rows.filter((row) => row.state !== 'NORMAL')))
    // The recovering rows, which the line never touches, make the states' widening the better.
    expect(rules.compared!.states.pinball).toBeLessThan(rules.compared!.line.pinball)
    expect(rules.compared!.line.pinball).toBeLessThan(rules.compared!.before.pinball)
    expect(rules.chosen).toBe('states')
    // The recovering rows held as forecast: their rule refused, and the choice is by the loss on the rows left
    // -- the two shock states each by their own factors against the line's one set on both.
    const held = world({ spread: { RECOVERY: 0.9 } })
    const judged = marketShockRulesOf(held, shockRuleOf(held))
    expect(judged.byState.RECOVERY!.adopted).toBe(false)
    expect(judged.compared!.states.pinball).not.toBeCloseTo(judged.compared!.line.pinball, 6)
    expect(judged.chosen).toBe(judged.compared!.states.pinball < judged.compared!.line.pinball ? 'states' : 'line')
    // Every shock moment after an event and the recovery refused: the state's rows are the line's rows, its
    // factors the line's, the losses equal to the digit, and the line wins the tie as the simpler.
    const one = world({ spread: { RECOVERY: 0.9 }, oneState: true })
    const tied = marketShockRulesOf(one, shockRuleOf(one))
    expect(tied.byState.TRENDING_SHOCK).toBeUndefined()
    expect(tied.byState.POST_EVENT_SHOCK!.k80).toBe(shockRuleOf(one).k80)
    expect(tied.compared!.states.pinball).toBeCloseTo(tied.compared!.line.pinball, 12)
    expect(tied.chosen).toBe('line')
    // Nothing past the line nor in a state: nothing compared, nothing chosen.
    const calm = world().filter((row) => row.state === 'NORMAL')
    expect(marketShockRulesOf(calm, shockRuleOf(calm))).toEqual({ version: 'market-shock-v1', byState: {}, compared: null, chosen: 'none' })
    // Every state's rule refused and the line's too: none.
    const narrow = world({ spread: { POST_EVENT_SHOCK: 0.9, TRENDING_SHOCK: 0.9, RECOVERY: 0.9 } })
    const none = marketShockRulesOf(narrow, shockRuleOf(narrow))
    expect(none.chosen).toBe('none')
    expect(none.compared!.states).toEqual(none.compared!.before)
    expect(none.compared!.line).toEqual(none.compared!.before)
    // The line's rule as handed in decides whether the line widens in the comparison: refused, it widens
    // nothing there, whatever factors its rows would have given.
    const refusedLine = marketShockRulesOf(rows, { ...line, adopted: false, refusal: 'pinball' })
    expect(refusedLine.compared!.line).toEqual(refusedLine.compared!.before)
    expect(refusedLine.chosen).toBe('states')
    // The choice itself, line by line.
    const better = { in80: 0.8, in50: 0.5, pinball: 0.4 }
    const worse = { in80: 0.75, in50: 0.45, pinball: 0.41 }
    expect(chooseWidening({ lineAdopted: true, statesAdopted: true, line: worse, states: better })).toBe('states')
    expect(chooseWidening({ lineAdopted: true, statesAdopted: true, line: better, states: worse })).toBe('line')
    expect(chooseWidening({ lineAdopted: true, statesAdopted: true, line: better, states: better })).toBe('line')
    expect(chooseWidening({ lineAdopted: false, statesAdopted: true, line: better, states: worse })).toBe('states')
    expect(chooseWidening({ lineAdopted: true, statesAdopted: false, line: worse, states: better })).toBe('line')
    expect(chooseWidening({ lineAdopted: false, statesAdopted: false, line: better, states: better })).toBe('none')
  })

  it("widens each week's rows by factors fitted on the other weeks alone, in every state", () => {
    const rows = world()
    const mine = rows.filter((row) => row.state === 'RECOVERY')
    const factors = crossFittedFactors(mine)
    expect([...factors.keys()]).toEqual([1, 2, 3])
    for (const week of [1, 2, 3]) {
      const others = mine.filter((row) => row.week !== week)
      expect(factors.get(week)!.k80).toBeGreaterThan(1)
      // Fitted without the week's own rows: the week's own distance has no part in it.
      const own = mine.filter((row) => row.week === week).map((row) => ({ ...row, z: row.z * 10 }))
      expect(crossFittedFactors([...others, ...own]).get(week)).toEqual(factors.get(week))
    }
    // Too few other rows: no widening for the week. Week 1's sixty rows beside forty of week 2's: week 1 is
    // fitted from forty, under the fifty wanted, and takes 1; week 2 from sixty, and takes its factors.
    const few = [...mine.filter((row) => row.week === 1).slice(0, 60), ...mine.filter((row) => row.week === 2).slice(0, 40)]
    expect(crossFittedFactors(few).get(1)).toEqual({ k80: 1, k50: 1 })
    expect(crossFittedFactors(few).get(2)!.k80).toBeGreaterThan(1)
  })

  it('is told to be none on a record from before the states, the line deciding', () => {
    expect(noMarketShockRecord()).toEqual({ version: 'market-shock-v1', byState: {}, compared: null, chosen: 'line' })
  })
})

describe('what widens a range at a moment', () => {
  const line: ShockRule = { ...noShockRecord(), adopted: true, refusal: null, k80: 1.5, k50: 1.25, moments: 12, rows: 400, before: { in80: 0.6, in50: 0.35, pinball: 0.5 }, after: { in80: 0.79, in50: 0.49, pinball: 0.47 } }
  const recovery: ShockRule = { ...line, k80: 1.3, k50: 1.1, before: { in80: 0.7, in50: 0.4, pinball: 0.45 }, after: { in80: 0.81, in50: 0.5, pinball: 0.44 } }
  const refused: ShockRule = { ...line, adopted: false, refusal: 'coverage' }
  const rules = { version: 'market-shock-v1', byState: { RECOVERY: recovery, POST_EVENT_SHOCK: refused }, compared: null, chosen: 'states' as const }

  it("is the state's adopted rule where the horizon chose the states', whatever Bitcoin's fifteen minutes", () => {
    expect(marketWidening({ shock: line, marketShock: rules }, 0.3, 'RECOVERY')).toEqual({ k80: 1.3, k50: 1.1, held: { before: 0.7, after: 0.81 }, state: 'RECOVERY' })
    expect(marketWidening({ shock: line, marketShock: rules }, -3, 'RECOVERY')!.state).toBe('RECOVERY')
    expect(marketWidening({ shock: line, marketShock: rules }, -3, 'POST_EVENT_SHOCK')).toBeNull()
    expect(marketWidening({ shock: line, marketShock: rules }, -3, 'TRENDING_SHOCK')).toBeNull()
    expect(marketWidening({ shock: line, marketShock: rules }, -3, 'NORMAL')).toBeNull()
    expect(marketWidening({ shock: line, marketShock: rules }, -3, null)).toBeNull()
    expect(marketWidening({ shock: line, marketShock: rules }, -3, undefined)).toBeNull()
    // A rule without the scores: held unknown.
    expect(marketWidening({ shock: line, marketShock: { ...rules, byState: { RECOVERY: { ...recovery, before: null, after: null } } } }, 0.3, 'RECOVERY')!.held).toBeNull()
  })

  it("is the line's rule where the horizon chose the line or holds no choice, and nothing where it chose none", () => {
    expect(marketWidening({ shock: line, marketShock: { ...rules, chosen: 'line' } }, -3, 'RECOVERY')).toEqual({ k80: 1.5, k50: 1.25, held: { before: 0.6, after: 0.79 }, state: null })
    expect(marketWidening({ shock: line }, -3, 'RECOVERY')).toEqual({ k80: 1.5, k50: 1.25, held: { before: 0.6, after: 0.79 }, state: null })
    expect(marketWidening({ shock: line }, -2.4, 'RECOVERY')).toBeNull()
    expect(marketWidening({ shock: refused }, -3, 'POST_EVENT_SHOCK')).toBeNull()
    expect(marketWidening({}, -3, 'POST_EVENT_SHOCK')).toBeNull()
    expect(marketWidening({ shock: line, marketShock: { ...rules, chosen: 'none' } }, -3, 'RECOVERY')).toBeNull()
    expect(marketWidening({ shock: { ...line, before: null, after: null } }, -3, null)!.held).toBeNull()
  })
})
