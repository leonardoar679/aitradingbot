import { describe, expect, it } from 'vitest'
import type { ForecastBar } from '../shared/forecast/bars'
import { ROUND_TRIP_PCT } from '../shared/forecast/edge'
import type { HorizonLine, OutcomeLine, PredictionLine } from '../shared/forecast/forecastRecord'
import {
  LAB_VERSION,
  errorsOfCase,
  eventsOf,
  isEarly,
  labDrift,
  labMetrics,
  leaderboardOf,
  liveLab,
  replayTrades,
  tradeOf,
  traderStats,
  variantLevels,
  type LabCase,
  type LabTrade
} from '../shared/forecast/lab'
import { compactJson, parseLab, parseReplay, serializeLab, serializeReplay, type LabFile } from '../shared/forecast/labFile'
import { aroundOf, kindsAt, walkForwardLab } from '../shared/forecast/labWalkForward'
import { meanPinball } from '../shared/forecast/ml/quantile'
import { promoted, recordOf } from './forecastRecords'

// THE FORECAST LAB (shared/forecast/{lab,labWalkForward,labFile}.ts; the V6 document, §27-28, §42-43,
// §49-50, §90-105): each figure on cases whose answers are known, the kinds of error with EARLY, events
// and drift by their lines, the forecast trader's entries and exits -- the stop first where the path
// touched both -- the live record's variants on the same moments, the leaderboard, the walk forward's
// calls made from the weeks before alone, and the files read back.

const T = Date.parse('2026-10-01T12:00:00Z') / 1000

function labCase(patch: Partial<LabCase> = {}): LabCase {
  return {
    pair: 'SOLUSDT',
    t: T,
    horizon: 'hour1',
    cls: 'large',
    q: [-2, -1, 0.5, 2, 3],
    dir: 'NEUTRAL',
    pUp: 0.55,
    uncertain: false,
    width: 5,
    usualWidth: 4,
    move: 1,
    best: 1.5,
    worst: -0.5,
    ...patch
  }
}

describe('the figures', () => {
  it('reads coverage, the median\'s error, the pinball, the width, the levels and the tails', () => {
    const cases = [labCase({ move: 1 }), labCase({ move: -3 }), labCase({ move: 0.5 }), labCase({ move: 2.5 })]
    const metrics = labMetrics(cases)
    expect(metrics.n).toBe(4)
    // Inside P25-P75 (-1..2): 1 and 0.5; inside P10-P90 (-2..3): all but -3.
    expect(metrics.coverage50).toBe(0.5)
    expect(metrics.coverage80).toBe(0.75)
    // The median 0.5: errors 0.5, -3.5, 0, 2.
    expect(metrics.mae).toBeCloseTo((0.5 + 3.5 + 0 + 2) / 4, 12)
    expect(metrics.rmse).toBeCloseTo(Math.sqrt((0.25 + 12.25 + 0 + 4) / 4), 12)
    expect(metrics.bias).toBeCloseTo((0.5 - 3.5 + 0 + 2) / 4, 12)
    expect(metrics.pinball).toBeCloseTo(cases.reduce((sum, entry) => sum + meanPinball(entry.move, entry.q), 0) / 4, 12)
    expect(metrics.width80).toBe(5)
    // At or below each level: -3 under all; 0.5 at the median; 1 under P75; 2.5 under P90.
    expect(metrics.levels).toEqual([0.25, 0.25, 0.5, 0.75, 1])
    expect(metrics.tailLow).toBe(0.25)
    expect(metrics.tailHigh).toBe(0)
    // Of the four, three went the median's way (up), one did not.
    expect(metrics.direction).toBe(0.75)
    expect(metrics.calls).toBe(0)
    expect(metrics.callsRight).toBeNull()
    // No persistence beside them: no skill.
    expect(metrics.skill).toBeNull()
    expect(labMetrics([])).toMatchObject({ n: 0, coverage80: null, mae: null, rmse: null, skill: null })
    // A move at P10 or at P90 is inside the range, not in its tail.
    expect(labMetrics([labCase({ move: -2 }), labCase({ move: 3 })])).toMatchObject({ tailLow: 0, tailHigh: 0, coverage80: 1 })
  })

  it('counts a move or a median of zero out of the median\'s way, and reads calls by their own way', () => {
    const metrics = labMetrics([
      labCase({ move: 0 }),
      labCase({ q: [-1, -0.5, 0, 0.5, 1], move: 1 }),
      labCase({ dir: 'BULLISH', move: 1 }),
      labCase({ dir: 'BEARISH', move: 1 }),
      labCase({ dir: 'BEARISH', move: -1, q: [-3, -2, -1, 0, 1] }),
      // A call on a move of nothing is neither right nor wrong.
      labCase({ dir: 'BULLISH', move: 0 })
    ])
    // The median's way: the three that moved with a median not zero all went its way.
    expect(metrics.direction).toBe(1)
    // The calls: the bull right, the bear against a rise wrong, the bear on a fall right.
    expect(metrics.calls).toBe(3)
    expect(metrics.callsRight).toBeCloseTo(2 / 3, 12)
  })

  it('reads skill over persistence only where every case has persistence beside it', () => {
    expect(labMetrics([labCase({ pinballZ: 0.3, floorPinballZ: 0.4 }), labCase({ pinballZ: 0.5, floorPinballZ: 0.4 })]).skill).toBeCloseTo(1 - 0.8 / 0.8 + 0, 12)
    expect(labMetrics([labCase({ pinballZ: 0.3, floorPinballZ: 0.5 })]).skill).toBeCloseTo(0.4, 12)
    expect(labMetrics([labCase({ pinballZ: 0.3, floorPinballZ: 0.5 }), labCase()]).skill).toBeNull()
  })

  it('names §43\'s kinds of error with EARLY: a call whose move had not come by the horizon and came by twice it', () => {
    expect(isEarly(labCase({ dir: 'BULLISH', move: 0.2, after: 0.6 }))).toBe(true)
    expect(isEarly(labCase({ dir: 'BULLISH', move: 0.2, after: 0.4 }))).toBe(false)
    expect(isEarly(labCase({ dir: 'BULLISH', move: 0.6, after: 1 }))).toBe(false)
    expect(isEarly(labCase({ dir: 'BULLISH', move: 0.2, after: null }))).toBe(false)
    expect(isEarly(labCase({ dir: 'BEARISH', q: [-3, -2, -1, 0, 1], move: 0, after: -1 }))).toBe(true)
    // The bear's move had come by the horizon: not early.
    expect(isEarly(labCase({ dir: 'BEARISH', q: [-3, -2, -1, 0, 1], move: -1.5, after: -2 }))).toBe(false)
    expect(isEarly(labCase({ dir: 'NEUTRAL', move: 0.2, after: 2 }))).toBe(false)
    expect(errorsOfCase(labCase({ dir: 'BULLISH', move: -3, best: 0.6, worst: -3.2 }))).toEqual(['WRONG_DIRECTION', 'TOO_NARROW', 'LATE', 'MARKET_MISREAD'])
    expect(errorsOfCase(labCase({ dir: 'BULLISH', move: 0.2, after: 0.9 }))).toEqual(['CORRECT_DIRECTION', 'RIGHT_RANGE', 'EARLY'])
    expect(labMetrics([labCase({ dir: 'BULLISH', move: 0.2, after: 0.9 }), labCase({ move: 5 })]).errors).toEqual({ CORRECT_DIRECTION: 1, RIGHT_RANGE: 1, EARLY: 1, TOO_NARROW: 1 })
  })
})

describe('events and drift', () => {
  it('falls under a pump or a dump at two usual moves, a break, and a story by its kind', () => {
    expect(eventsOf({ prior: 2 })).toEqual(['all', 'pump'])
    expect(eventsOf({ prior: 1.99 })).toEqual(['all'])
    expect(eventsOf({ prior: -2 })).toEqual(['all', 'dump'])
    expect(eventsOf({ prior: null, breakout: true })).toEqual(['all', 'breakout'])
    expect(eventsOf({ kinds: ['EXPLOIT', 'HACK', 'ETF'] })).toEqual(['all', 'news', 'hack', 'etf'])
    expect(eventsOf({ kinds: ['LISTING', 'MACRO'] })).toEqual(['all', 'news', 'listing', 'macro'])
    expect(eventsOf({ kinds: [], newsShift: 0.3 })).toEqual(['all', 'news'])
    expect(eventsOf({ kinds: ['PARTNERSHIP'] })).toEqual(['all', 'news'])
    expect(eventsOf({ kinds: ['EXPLOIT'] })).toEqual(['all', 'news', 'hack'])
  })

  it('reads over-reacting as a median that followed a shock that turned, under-reacting as one that did not follow one that went on', () => {
    const drift = labDrift([
      // Followed a pump (median up), the move turned down: over-reacting.
      labCase({ prior: 2.5, move: -0.5 }),
      // Followed it and the move went on: neither.
      labCase({ prior: 2.5, move: 1 }),
      // Did not follow a pump (median down) and the move went on past P75: under-reacting.
      labCase({ prior: 3, q: [-3, -2, -0.5, 1, 2], move: 1.5 }),
      // A dump, the median not following (up), the move on below P25: under-reacting.
      labCase({ prior: -2.2, move: -1.5 }),
      // Not following a pump, the move inside the likely range: neither.
      labCase({ prior: 2.5, q: [-3, -2, -0.5, 1, 2], move: 0.5 }),
      // No shock.
      labCase({ prior: 1.5, move: -3 }),
      labCase({ prior: null })
    ])
    expect(drift).toEqual({ shocks: 5, overReacting: 1, underReacting: 2 })
  })
})

describe('the forecast trader (§97)', () => {
  // An edge after costs: 0.3 x -1 + 0.4 x 1.5 + 0.3 x 4 = 1.5, and most of the mass above 0.24.
  const bull = (patch: Partial<LabCase> = {}): LabCase => labCase({ dir: 'BULLISH', q: [-1, 0.5, 1.5, 2.5, 4], ...patch })

  it('trades a called way with an edge after costs and a likely profit, and nothing else as the rules stand', () => {
    expect(tradeOf(labCase(), 'rules')).toBeNull()
    expect(tradeOf(bull({ uncertain: true }), 'rules')).toBeNull()
    // Called, but the mean less costs is under zero.
    expect(tradeOf(labCase({ dir: 'BULLISH', q: [-3, -0.5, 0.1, 0.3, 1] }), 'rules')).toBeNull()
    // Likely to clear the cost, but a fat tail against it puts the mean less costs under zero.
    expect(tradeOf(labCase({ dir: 'BULLISH', q: [-6, 0.3, 0.5, 0.7, 0.9] }), 'rules')).toBeNull()
    // An edge, but less likely than 55 in a hundred to clear the cost.
    expect(tradeOf(labCase({ dir: 'BULLISH', q: [-0.5, -0.2, 0.2, 2, 8] }), 'rules')).toBeNull()
    expect(tradeOf(bull(), 'rules')?.side).toBe('BUY')
    // Each trade's opportunity class (V6 Stage 12): its coin, horizon and setup.
    expect(tradeOf(bull(), 'rules')?.classKey).toBe('large/hour1/other')
    expect(tradeOf(bull({ kinds: ['LISTING'] }), 'rules')?.classKey).toBe('large/hour1/news')
    expect(tradeOf(bull({ breakout: true }), 'rules')?.classKey).toBe('large/hour1/breakout')
    expect(tradeOf(bull({ prior: -2.5 }), 'rules')?.classKey).toBe('large/hour1/reversal')
    expect(tradeOf(bull({ regime: 'bull' }), 'rules')?.classKey).toBe('large/hour1/trend')
  })

  it('takes the stop first where the path touched both, then the target, else the close, all net of the round trip', () => {
    // Stop at P10 (-1), target at P75 (2.5).
    expect(tradeOf(bull({ best: 3, worst: -1.2, move: 2 }), 'rules')).toMatchObject({ exit: 'stop', grossPct: -1, netPct: -1 - ROUND_TRIP_PCT })
    expect(tradeOf(bull({ best: 3, worst: -0.5, move: 2 }), 'rules')).toMatchObject({ exit: 'target', grossPct: 2.5 })
    expect(tradeOf(bull({ best: 1, worst: -0.5, move: 0.8 }), 'rules')).toMatchObject({ exit: 'close', grossPct: 0.8, netPct: 0.8 - ROUND_TRIP_PCT })
    // A sell, mirrored: stopped at P90 (+1), taken at P25 (-2.5).
    const bear = labCase({ dir: 'BEARISH', q: [-4, -2.5, -1.5, -0.5, 1] })
    expect(tradeOf({ ...bear, best: 1.1, worst: -3, move: -2 }, 'rules')).toMatchObject({ side: 'SELL', exit: 'stop', grossPct: -1 })
    expect(tradeOf({ ...bear, best: 0.5, worst: -3, move: -2 }, 'rules')).toMatchObject({ exit: 'target', grossPct: 2.5 })
    expect(tradeOf({ ...bear, best: 0.5, worst: -1, move: -0.7 }, 'rules')).toMatchObject({ exit: 'close', grossPct: 0.7 })
    // A P10 above zero stops at the entry.
    expect(tradeOf(bull({ q: [0.2, 1, 2, 3, 4], best: 0.5, worst: -0.1, move: 0.3 }), 'rules')).toMatchObject({ exit: 'stop', grossPct: 0 })
  })

  it('on the median alone, trades its way where it clears the round trip, with no direction gate', () => {
    expect(tradeOf(labCase({ q: [-2, -1, ROUND_TRIP_PCT, 2, 3] }), 'medians')).toBeNull()
    expect(tradeOf(labCase({ q: [-2, -1, 0.3, 2, 3], best: 0.5, worst: -0.5, move: 0.4 }), 'medians')).toMatchObject({ side: 'BUY', exit: 'close' })
    expect(tradeOf(labCase({ q: [-3, -2, -0.3, 1, 2], best: 0.5, worst: -0.5, move: 0.4 }), 'medians')).toMatchObject({ side: 'SELL', grossPct: -0.4 })
  })

  it('holds one trade a pair at a time, and reads its figures in exit order', () => {
    const cases = [bull({ t: T }), bull({ t: T + 1800 }), bull({ t: T + 3600 }), bull({ t: T + 900, pair: 'ETHUSDT' })]
    const trades = replayTrades(cases, 'rules')
    expect(trades.map((trade) => `${trade.pair}@${trade.t - T}`)).toEqual(['SOLUSDT@0', 'ETHUSDT@900', 'SOLUSDT@3600'])
    const mk = (t: number, netPct: number): LabTrade => ({ pair: 'X', t, horizon: 'hour1', side: 'BUY', exit: 'close', grossPct: netPct + ROUND_TRIP_PCT, netPct })
    const stats = traderStats([mk(T + 7200, -1), mk(T, 2), mk(T + 3600, -1.5), mk(T + 10_800, 0.5)])
    expect(stats.trades).toBe(4)
    expect(stats.wins).toBe(2)
    expect(stats.winRate).toBe(0.5)
    expect(stats.profitFactor).toBeCloseTo(2.5 / 2.5, 12)
    expect(stats.expectancyPct).toBeCloseTo(0, 12)
    expect(stats.netPct).toBeCloseTo(0, 12)
    // In exit order: +2, -1.5, -1, +0.5: from the high of 2 down to -0.5.
    expect(stats.maxDrawdownPct).toBeCloseTo(2.5, 12)
    expect(stats.costPct).toBeCloseTo(4 * ROUND_TRIP_PCT, 12)
    expect(traderStats([mk(T, 1)]).profitFactor).toBeNull()
    // In exit order, not entry order: a day's win entered between two losses closes after both.
    const day: LabTrade = { ...mk(T + 1800, 5), horizon: 'hours24' }
    expect(traderStats([mk(T, -2), day, mk(T + 3600, -2)]).maxDrawdownPct).toBeCloseTo(4, 12)
    expect(traderStats([])).toMatchObject({ trades: 0, winRate: null, expectancyPct: null, netPct: 0, maxDrawdownPct: 0 })
  })
})

describe('the live record (§49)', () => {
  const horizonLine = (patch: Partial<HorizonLine> = {}): HorizonLine => ({
    q: [-2, -1, 0.5, 2, 3],
    pUp: 0.55,
    dir: 'NEUTRAL',
    strong: false,
    uncertain: false,
    rel: 'HIGH',
    width: 5,
    usualWidth: 4,
    skill: 0.01,
    dirSkill: -0.01,
    cell: 'large',
    v1: [-2.2, -1.1, 0.4, 1.9, 2.9],
    v1pUp: 0.54,
    parts: [],
    ...patch
  })
  const prediction = (id: string, t: number, hour: HorizonLine, patch: Partial<PredictionLine> = {}): PredictionLine => ({
    v: 'forecast-record-v1',
    id,
    pair: 'SOLUSDT',
    t,
    at: t * 1000,
    price: 180,
    cls: 'large',
    regime: 'sideways',
    best: 'hour1',
    run: 'r',
    foldsRun: 'f',
    why: 'grid',
    h: { hour1: hour },
    ...patch
  })
  const outcome = (id: string, t: number, move: number): OutcomeLine => ({ v: 'forecast-record-v1', id, pair: 'SOLUSDT', h: 'hour1', t, due: t + 3600, move, best: Math.max(0, move), worst: Math.min(0, move), below: '', v1below: '', in80: true, in50: true, up: move > 0, dir: 'NEUTRAL', pUp: 0.55, cell: 'large', cls: 'large', errors: [] })

  it('reads V1, V2, V3 and V4 on the same moments, V2 its own where a story moved the shown forecast', () => {
    const story = { q: [-3, -2, -1, 1, 2], pUpMapped: 0.4, story: 's', kind: 'HACK', impact: 80, shift: -1.5, widen: 0.5, widenShare: 0, fromLibrary: true }
    const moved = horizonLine({ q: [-3.5, -2.5, -1, 1, 2], news: { v3: story, v4: { ...story, q: [-3.5, -2.5, -1, 1, 2] } }, v2: [-2, -1, 0.5, 2, 3] })
    expect(variantLevels(moved)).toEqual({ v1: moved.v1, v2: [-2, -1, 0.5, 2, 3], v3: story.q, v4: moved.q })
    const plain = horizonLine()
    expect(variantLevels(plain)).toEqual({ v1: plain.v1, v2: plain.q, v3: plain.q, v4: plain.q })
    const lines = [prediction('a', T, moved, { z1h: 2.4 }), prediction('b', T + 900, plain), prediction('c', T + 1800, plain, { why: 'refresh', previous: 'b', reasons: ['NEWS'], h: { hour1: horizonLine({ q: [-2, -1, 0.9, 2, 3] }) } })]
    const live = liveLab(lines, [outcome('a', T, -2.2), outcome('b', T + 900, 0.3), outcome('missing-forecast', T, 1)])
    const hour = live.horizons.hour1!
    expect(hour.outcomes).toBe(2)
    expect(hour.variants.v4.n).toBe(2)
    // -2.2 is outside V2's 80% range (-2..3) and inside V4's (-3.5..2).
    expect(hour.variants.v2.coverage80).toBe(0.5)
    expect(hour.variants.v4.coverage80).toBe(1)
    expect(hour.news.moved.n).toBe(1)
    expect(hour.news.unmoved.n).toBe(1)
    // The story's forecast followed the pump the hour before it? No: its median is down; the move went on down.
    expect(live.events.pump?.n).toBe(1)
    expect(live.events.hack?.n).toBe(1)
    expect(live.drift.refreshes).toBe(1)
    expect(live.drift.byReason).toEqual({ NEWS: 1 })
    expect(live.drift.meanChangePct).toBeCloseTo(0.4, 12)
    expect([live.from, live.to]).toEqual([T, T + 900])
    // None widened for Bitcoin's move: no such part.
    expect(hour.shock).toBeUndefined()
  })

  // V6.1: the forecasts Bitcoin's sharp move widened, as shown, and by V2's own levels beside them.
  it("reads the forecasts Bitcoin's sharp move widened, and how V2's own levels would have held them", () => {
    const widened = horizonLine({ q: [-4, -2, 0.5, 3, 5], v2: [-2, -1, 0.5, 2, 3], shock: [-3.1, 1.6, 1.4] })
    const lines = [prediction('a', T, widened), prediction('b', T + 900, widened), prediction('c', T + 1800, horizonLine())]
    // -3 inside the widened 80% range, outside V2's; 1 inside both; 0.3 on the unwidened forecast.
    const hour = liveLab(lines, [outcome('a', T, -3), outcome('b', T + 900, 1), outcome('c', T + 1800, 0.3)]).horizons.hour1!
    expect(hour.outcomes).toBe(3)
    expect(hour.shock!.widened.n).toBe(2)
    expect(hour.shock!.widened.coverage80).toBe(1)
    expect(hour.shock!.unwidened.n).toBe(2)
    expect(hour.shock!.unwidened.coverage80).toBe(0.5)
  })
})

describe('the leaderboard (§103-105)', () => {
  it('sets every model beside persistence, with its weight, its promotion and its last week', () => {
    const score = (pinball: number): { n: number; pinball: number; coverage80: number; coverage50: number; direction: number; bias: number; width80: number } => ({ n: 9000, pinball, coverage80: 0.79, coverage50: 0.5, direction: 0.51, bias: 0, width80: 2 })
    const rows = leaderboardOf(
      [
        { horizon: 'hours4', scores: [{ model: 'persistence', overall: score(0.4) }, { model: 'gbt', overall: score(0.41) }] },
        { horizon: 'hour1', scores: [{ model: 'persistence', overall: score(0.4) }, { model: 'gbt', overall: score(0.38) }] }
      ],
      [{ horizon: 'hour1', model: 'gbt', promoted: true, lines: [] }],
      { hour1: [{ model: 'gbt', weight: 0.7 }, { model: 'persistence', weight: 0.3 }] },
      ['gbt:hours4']
    )
    expect(rows.map((row) => `${row.horizon}:${row.model}`)).toEqual(['hour1:gbt', 'hour1:persistence', 'hours4:persistence', 'hours4:gbt'])
    expect(rows[0]).toMatchObject({ weight: 0.7, promoted: true, degraded: false })
    expect(rows[0].skill).toBeCloseTo(1 - 0.38 / 0.4, 12)
    expect(rows[3]).toMatchObject({ weight: 0, promoted: null, degraded: true })
    expect(rows[3].skill).toBeCloseTo(1 - 0.41 / 0.4, 12)
  })
})

describe('the walk forward', () => {
  const bar = (time: number, close: number, high = close, low = close): ForecastBar => ({ time, open: close, high, low, close, volume: 1, quoteVolume: close, takerBuyVolume: 0.5, trades: 1 })

  it('reads the hour before, a break of the day before, and the move to twice the horizon from the bars', () => {
    // A day of flat bars at 100, then the hour to T rising to 101.
    const bars: ForecastBar[] = []
    for (let time = T - 300 - 86_400; time < T - 300 - 3600; time += 300) bars.push(bar(time, 100, 100.5, 99.5))
    for (let k = 0; k <= 12; k++) bars.push(bar(T - 300 - 3600 + k * 300, 100 + k / 12, 100 + k / 12 + 0.05, 100 + k / 12 - 0.05))
    for (let k = 1; k <= 24; k++) bars.push(bar(T - 300 + k * 300, 101 + k * 0.01))
    const read = aroundOf(bars, T, 0.03, 24)
    expect(read.prior).toBeCloseTo(Math.log(101 / 100) / (0.03 * Math.sqrt(12 / 288)), 9)
    expect(read.breakout).toBe(true)
    expect(read.after).toBeCloseTo((101.24 / 101 - 1) * 100, 9)
    expect(aroundOf(bars, T, 0.03, 500).after).toBeNull()
    expect(aroundOf(undefined, T, 0.03, 24)).toEqual({ prior: null, breakout: false, after: null })
    expect(aroundOf(bars, T + 7, 0.03, 24)).toEqual({ prior: null, breakout: false, after: null })
  })

  it('takes a coin\'s stories of the four hours before a forecast, the moment itself included', () => {
    const stories = [
      { publishedAt: T - 4 * 3600, tickers: ['SOL'], eventType: 'HACK' },
      { publishedAt: T - 4 * 3600 + 1, tickers: ['SOL'], eventType: 'LISTING' },
      { publishedAt: T, tickers: ['SOL'], eventType: 'ETF' },
      { publishedAt: T + 1, tickers: ['SOL'], eventType: 'MACRO' },
      { publishedAt: T - 60, tickers: ['SOL'], eventType: 'LISTING' }
    ]
    expect(kindsAt(stories, T)).toEqual(['LISTING', 'ETF'])
    expect(kindsAt(undefined, T)).toEqual([])
  })

  it('calls each tested hour from the weeks before it alone: its own week\'s outcomes change none of its calls', () => {
    const record = recordOf({ rows: 12_000, seed: 31, drift: 0.8 })
    const promotions = promoted('hour1', ['persistence', 'gbt'])
    const made = walkForwardLab(record, promotions, new Map(), [])
    const shown = made.cases.v2
    expect(made.lab.rows).toBe(shown.length)
    expect(made.replay).toHaveLength(shown.length)
    expect(made.lab.weeks).toEqual([1, 2, 3])
    // Week 1 has no P(up) map, week 2 no skill read from a week before it: only week 3 calls.
    const lastWeek = record.time[Math.floor((3 * record.rows) / 4)]
    expect(shown.filter((entry) => entry.dir !== 'NEUTRAL').every((entry) => entry.t >= lastWeek)).toBe(true)
    expect(shown.filter((entry) => entry.dir !== 'NEUTRAL').length).toBeGreaterThan(100)
    // gbt knew the drift's sign: its calls were mostly right, and the trader as the rules stand traded them.
    expect(made.lab.variants.v2.pooled.callsRight).toBeGreaterThan(0.6)
    expect(made.lab.trader.rules.trades).toBeGreaterThan(0)
    // Every outcome of the last week turned around: not one call of that week changes.
    const flipped = { ...record, z: Float32Array.from(record.z, (value, row) => (record.time[row] >= lastWeek ? -value : value)), y: Float32Array.from(record.y, (value, row) => (record.time[row] >= lastWeek ? -value : value)) }
    const again = walkForwardLab(flipped, promotions, new Map(), []).cases.v2
    const calls = (cases: LabCase[]): string[] => cases.filter((entry) => entry.t >= lastWeek).map((entry) => `${entry.t}:${entry.dir}:${entry.q.map((level) => level.toFixed(6)).join(',')}`)
    expect(calls(again)).toEqual(calls(shown))
    // And the price-only variant and its classes are read beside it.
    expect(made.lab.variants.v1.pooled.n).toBe(made.cases.v1.length)
    expect(Object.keys(made.lab.variants.v2.byClass).length).toBeGreaterThan(1)
  })
})

describe('the Lab on file', () => {
  it('writes figures at four decimals and missing ones as null, and reads back only its own version', () => {
    expect(compactJson({ a: 1.234567, b: Number.NaN, c: [0.00001, -2.5] })).toBe('{"a":1.2346,"b":null,"c":[0,-2.5]}')
    const file: LabFile = { version: LAB_VERSION, runId: 'run-x', madeAt: T, span: { from: T, to: T + 3600 }, pairs: ['BTCUSDT'], horizons: {} }
    expect(parseLab(serializeLab(file))).toEqual(file)
    expect(parseLab(serializeLab({ ...file, version: 'forecast-lab-v0' }))).toBeNull()
    expect(parseLab('{not json')).toBeNull()
    expect(parseLab(JSON.stringify({ ...file, horizons: { hour2: {} } }))).toBeNull()
    const rows = [
      { t: T, pair: 'SOLUSDT', q: [-2, -1, 0.5, 2, 3], pUp: 0.55, dir: 'BULLISH' as const, move: 1, best: 1.5, worst: -0.5 },
      { t: T + 3600, pair: 'BTCUSDT', q: [-1, -0.5, 0, 0.5, 1], pUp: null, dir: 'NEUTRAL' as const, move: -0.2, best: 0.1, worst: -0.3 }
    ]
    expect(parseReplay(serializeReplay('hour1', rows))).toEqual({ horizon: 'hour1', rows })
    expect(parseReplay(serializeReplay('hour1', rows).replace(LAB_VERSION, 'other'))).toBeNull()
  })
})
