import { describe, expect, it } from 'vitest'
import {
  EVENT_BASELINE_FADE,
  EVENT_BASELINE_FOLLOW,
  EVENT_BENCHMARK_SETTLE_SEC,
  EVENT_BUY_AND_HOLD,
  EVENT_BENCHMARK_STAKE_USD,
  EVENT_RULE_MAJORITY,
  EVENT_RULE_UNANIMOUS,
  EVENT_RULE_WEIGHTED,
  eventBenchmarkWindow,
  eventScoring,
  hybridName,
  quantRuleName,
  rollingResults,
  sampleEvents,
  summarizeEventBenchmark,
  type EventBenchmarkInput,
  type EventQuantStates,
  type EventTrade,
  type QuantSide
} from '../shared/aiEventBenchmark'
import { validateOpportunityAnswer } from '../shared/aiOpportunity'
import { opportunityCallOf, replayAnsweredAt, scoreOpportunity, slippageRateFor } from '../shared/aiOpportunityOutcome'
import type { AiSignalDecision } from '../shared/aiSignal'
import { FEE_RATE } from '../shared/fees'
import type { Candle } from '../shared/ipc'
import type { MarketEvent, MarketEventType } from '../shared/marketEvent'

const DAY = 86_400
const T0 = Date.parse('2026-09-01T00:00:00Z') / 1000
const NOW = T0 + 60 * DAY

function event(n: number, overrides: Partial<MarketEvent> = {}): MarketEvent {
  const time = T0 + n * 3600
  const symbol = overrides.symbol ?? 'SOLUSDT'
  return {
    id: `binance:${symbol}:${time}`,
    exchange: 'binance',
    symbol,
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    time,
    type: 'breakout',
    direction: 'up',
    band: 'urgent',
    score: 90,
    components: { price: 90, volume: 90, volatility: 90, pressure: 90, breakout: 90 },
    price: 100,
    // A 3% move that was six of its usual ones: the usual fifteen-minute move here is 0.5%.
    returnsPct: { m1: 0.2, m5: 1, m15: 3, h1: 3, h4: 3 },
    moveSigmas: 6,
    volumeRatio: 8,
    rangeRatio: 4,
    live: null,
    ...overrides
  }
}

/** Minute bars from an event on: flat at 100 for three minutes, then to `end` and flat there. */
function path(time: number, end: number, count = 120): Candle[] {
  return Array.from({ length: count }, (_, n) => {
    const moved = n >= 3
    const open = n > 3 ? end : 100
    const close = moved ? end : 100
    return { time: time + n * 60, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 }
  })
}

const RISE = 103
const FALL = 97

function answer(overrides: Record<string, unknown> = {}, latencyMs = 1000, costUsd = 0.003): AiSignalDecision {
  const verdict = validateOpportunityAnswer(
    {
      recommendation: 'buy',
      confidence: 0.8,
      entryMin: 99.8,
      entryMax: 100.2,
      validMinutes: 15,
      stopLoss: 98.5,
      takeProfit: 102,
      horizonBars: 4,
      marketRegime: 'bull',
      riskLevel: 'medium',
      reasonCodes: ['breakout'],
      rationale: '',
      ...overrides
    },
    100
  )
  if (!verdict.ok) throw new Error(verdict.reason)
  return {
    candleTime: 0,
    ...verdict.signal,
    model: 'm',
    cached: true,
    error: null,
    rejected: null,
    detail: verdict.detail,
    usage: { promptTokens: 4000, completionTokens: 500, costUsd, latencyMs }
  }
}

const LONG = answer()
const SHORT = answer({ recommendation: 'sell', stopLoss: 101.5, takeProfit: 98 })
const NONE = answer({ recommendation: 'hold', entryMin: null, entryMax: null, stopLoss: null, takeProfit: null, confidence: 0.5 })
const TIMID = answer({ confidence: 0.6 })
const REFUSED: AiSignalDecision = { ...LONG, recommendation: 'hold', confidence: 0, rejected: 'bad shape', detail: null }
const UNREACHED: AiSignalDecision = { ...LONG, error: 'down' }

/** A benchmark of `ends.length` events, hourly: event i's price goes to ends[i]. */
function benchmark(ends: number[], answers: Record<string, (AiSignalDecision | null)[]>, overrides: Partial<EventBenchmarkInput> = {}): EventBenchmarkInput {
  const events = ends.map((_, i) => event(i))
  const bars: Record<string, Candle[]> = {}
  events.forEach((entry, i) => {
    bars[entry.id] = path(entry.time, ends[i])
  })
  return { events, models: Object.keys(answers), answers, bars, nowSec: NOW, ...overrides }
}

describe('eventBenchmarkWindow', () => {
  it('ends at the last UTC midnight early enough for every recommendation to have run its course', () => {
    const now = Date.parse('2026-10-04T10:00:00Z') / 1000
    const window = eventBenchmarkWindow(now, 14)
    // A day and an hour and ten minutes before 10:00 on the 4th is 08:50 on the 3rd.
    expect(new Date(window.endSec * 1000).toISOString()).toBe('2026-10-03T00:00:00.000Z')
    expect(window.endSec - window.startSec).toBe(14 * DAY)
    expect(now - window.endSec).toBeGreaterThanOrEqual(EVENT_BENCHMARK_SETTLE_SEC)
    // Later the same day, the same window: what was bought is asked for again.
    expect(eventBenchmarkWindow(now + 6 * 3600, 14)).toEqual(window)
  })
})

describe('sampleEvents', () => {
  const types: MarketEventType[] = ['breakout', 'breakout', 'breakout', 'breakdown']
  const many = Array.from({ length: 200 }, (_, i) => event(i, { type: types[i % 4], direction: types[i % 4] === 'breakout' ? 'up' : 'down' }))

  it('returns everything, oldest first, when there is no more than it may take', () => {
    const few = [event(3), event(1), event(2)]
    expect(sampleEvents(few, 10).map((entry) => entry.time)).toEqual([event(1).time, event(2).time, event(3).time])
  })

  it('takes each type in proportion, and the same events whatever order they arrive in', () => {
    const sample = sampleEvents(many, 40)
    expect(sample).toHaveLength(40)
    expect(sample.filter((entry) => entry.type === 'breakout')).toHaveLength(30)
    expect(sample.filter((entry) => entry.type === 'breakdown')).toHaveLength(10)
    expect(sample.map((entry) => entry.time)).toEqual([...sample.map((entry) => entry.time)].sort((a, b) => a - b))
    expect(sampleEvents([...many].reverse(), 40).map((entry) => entry.id)).toEqual(sample.map((entry) => entry.id))
  })

  it('keeps most of a sample when the period grows, so its answers come from the cache', () => {
    const before = new Set(sampleEvents(many.slice(0, 160), 40).map((entry) => entry.id))
    const after = sampleEvents(many, 50).map((entry) => entry.id)
    const kept = after.filter((id) => before.has(id)).length
    // Forty of 160 and fifty of 200 are the same quarter: the hash keeps the same events in it.
    expect(kept).toBeGreaterThanOrEqual(36)
  })
})

describe('summarizeEventBenchmark: what is compared', () => {
  it('compares only the events every model answered, and says how many each has answered', () => {
    const summary = summarizeEventBenchmark(benchmark([RISE, RISE, FALL, RISE], { a: [LONG, LONG, LONG, LONG], b: [LONG, null, UNREACHED, NONE] }))
    expect(summary.sampled).toBe(4)
    expect(summary.compared).toBe(2)
    expect(summary.models.map((row) => [row.name, row.answered])).toEqual([
      ['a', 4],
      ['b', 2]
    ])
    // Model a is scored on the two compared events, not on its four.
    expect(summary.models[0].actionable).toBe(2)
  })

  it('counts each kind of answer, and acts only on a side at 65% or more', () => {
    const summary = summarizeEventBenchmark(benchmark([RISE, RISE, RISE, RISE, RISE], { a: [LONG, SHORT, NONE, TIMID, REFUSED] }))
    expect(summary.models[0]).toMatchObject({ longs: 2, shorts: 1, noTrades: 1, refused: 1, actionable: 2 })
  })

  it('has nothing to compare with no model, and no rules with one', () => {
    expect(summarizeEventBenchmark(benchmark([RISE], {})).compared).toBe(0)
    expect(summarizeEventBenchmark(benchmark([RISE], { a: [LONG] })).rules).toEqual([])
  })
})

describe('summarizeEventBenchmark: a model row', () => {
  // Forty events: a long on each; the price rises on three in four.
  const ends = Array.from({ length: 40 }, (_, i) => (i % 4 === 3 ? FALL : RISE))
  const input = benchmark(ends, { a: ends.map(() => LONG) })
  const row = summarizeEventBenchmark(input).models[0]
  /** What following one of those longs gives, worked out by the scorer itself. */
  const net = (end: number): number => {
    const call = opportunityCallOf(T0, LONG, replayAnsweredAt(T0, 1000))
    if (!call) throw new Error('no call')
    return scoreOpportunity(call, path(T0, end), NOW, { feeRate: FEE_RATE, slippageRate: slippageRateFor(null) }).netPct ?? NaN
  }

  it('follows every recommendation through its own entry, levels and clocks', () => {
    expect(row).toMatchObject({ actionable: 40, closed: 40, expired: 0, unsettled: 0, wins: 30 })
    expect(row.netSumPct).toBeCloseTo(30 * net(RISE) + 10 * net(FALL), 8)
    // In R as well: each trade's own, added up.
    expect(row.rSum).toBeCloseTo(row.trades.reduce((sum, trade) => sum + (trade.outcome.r ?? 0), 0), 8)
    expect(row.trades.every((trade) => trade.outcome.r !== null)).toBe(true)
    expect(row.rSum).not.toBe(0)
    expect(row.meanNetPct).toBeCloseTo((30 * net(RISE) + 10 * net(FALL)) / 40, 8)
    expect(net(RISE)).toBeGreaterThan(1.5)
    expect(net(FALL)).toBeLessThan(-1.5)
  })

  it('gives a win rate with its margin, a profit factor and the size of a win and a loss', () => {
    expect(row.winRatePct).toBeCloseTo(75, 10)
    expect(row.winRateMarginPct).toBeCloseTo(1.96 * Math.sqrt((0.75 * 0.25) / 40) * 100, 8)
    expect(row.profitFactor).toBeCloseTo((30 * net(RISE)) / (10 * -net(FALL)), 8)
    expect(row.meanWinPct).toBeCloseTo(net(RISE), 8)
    expect(row.meanLossPct).toBeCloseTo(net(FALL), 8)
  })

  it('measures the deepest fall of the running total', () => {
    // Three wins and a loss, ten times over: the total never falls further than one loss.
    expect(row.maxDrawdownPct).toBeCloseTo(-net(FALL), 8)
  })

  it('sets the result against what the answers cost', () => {
    expect(row.costUsd).toBeCloseTo(40 * 0.003, 10)
    const usd = (row.netSumPct / 100) * EVENT_BENCHMARK_STAKE_USD
    expect(row.netAfterAiCostUsd).toBeCloseTo(usd - 0.12, 8)
    expect(row.perAiDollarUsd).toBeCloseTo(usd / 0.12, 6)
    expect(row.medianLatencyMs).toBe(1000)
  })

  it('shows the period in three parts', () => {
    expect(row.segments.map((segment) => segment.trades)).toEqual([14, 13, 13])
    expect(row.segments.reduce((sum, segment) => sum + segment.netSumPct, 0)).toBeCloseTo(row.netSumPct, 8)
    expect(row.segments.reduce((sum, segment) => sum + segment.wins, 0)).toBe(30)
  })

  it('slices by type, side, hold and confidence, and withholds a mean under ten trades', () => {
    const find = (by: string, key: string) => row.slices.find((slice) => slice.by === by && slice.key === key)
    expect(find('type', 'breakout')).toMatchObject({ trades: 40, wins: 30 })
    expect(find('side', 'long')?.meanNetPct).toBeCloseTo(row.meanNetPct ?? NaN, 8)
    expect(find('hold', '1h')?.trades).toBe(40)
    expect(find('confidence', '80–90%')?.trades).toBe(40)
    const few = summarizeEventBenchmark(benchmark([RISE, FALL], { a: [LONG, LONG] })).models[0]
    expect(few.slices.every((slice) => slice.meanNetPct === null)).toBe(true)
  })

  it("cuts by how much the pair trades, by the lines its slippage is charged by", () => {
    const four = benchmark([RISE, RISE, FALL, RISE], { a: [LONG, LONG, LONG, LONG] })
    const [deep, middle, thin, unknown] = four.events.map((event) => event.id)
    const cut = summarizeEventBenchmark({ ...four, dailyVolume: { [deep]: 50_000_000, [middle]: 49_999_999, [thin]: 4_999_999, [unknown]: null } }).models[0]
    const sizes = cut.slices.filter((slice) => slice.by === 'size')
    expect(Object.fromEntries(sizes.map((slice) => [slice.key, slice.trades]))).toEqual({
      '$50M a day or more': 1,
      '$5M to $50M a day': 1,
      'under $5M a day': 1,
      'not known': 1
    })
    // The thin pair's trade is the one that fell.
    expect(sizes.find((slice) => slice.key === 'under $5M a day')?.wins).toBe(0)
    // An event raised live, with no candles' figure, goes by what the scanner read of the pair.
    const live = benchmark([RISE], { a: [LONG] })
    live.events[0] = { ...live.events[0], live: { detectedAt: live.events[0].time + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 90, rank: 1 } }
    const liveSizes = summarizeEventBenchmark(live).models[0].slices.filter((slice) => slice.by === 'size')
    expect(liveSizes.map((slice) => slice.key)).toEqual(['$50M a day or more'])
    // With no market around the events, nothing is cut by it.
    expect(cut.slices.some((slice) => slice.by === 'btc' || slice.by === 'company')).toBe(false)
  })

  it("cuts by Bitcoin's four hours and by the move's company where they are known, and says where they are not", () => {
    const four = benchmark([RISE, RISE, FALL, RISE], { a: [LONG, LONG, LONG, LONG] })
    const [first, second, third] = four.events.map((event) => event.id)
    const summary = summarizeEventBenchmark({
      ...four,
      labels: {
        [first]: { btcRegime: 'rising', company: 'with the market' },
        [second]: { btcRegime: 'rising', company: 'on its own' },
        [third]: { btcRegime: 'falling', company: 'on its own' }
      }
    })
    const slices = (by: string): [string, number, number][] =>
      summary.models[0].slices.filter((slice) => slice.by === by).map((slice) => [slice.key, slice.trades, slice.wins])
    expect(slices('btc')).toEqual([
      ['Bitcoin falling', 1, 0],
      ['Bitcoin rising', 2, 2],
      ['not known', 1, 1]
    ])
    expect(slices('company')).toEqual([
      ['not known', 1, 1],
      ['on its own', 2, 1],
      ['with the market', 1, 1]
    ])
    // The rows that are not models are cut the same way, over the same events.
    expect(summary.baselines[0].slices.filter((slice) => slice.by === 'btc').reduce((sum, slice) => sum + slice.trades, 0)).toBe(summary.baselines[0].closed)
  })

  it('withholds every rate under thirty closed trades', () => {
    const few = summarizeEventBenchmark(benchmark(ends.slice(0, 29), { a: ends.slice(0, 29).map(() => LONG) })).models[0]
    expect(few).toMatchObject({ closed: 29, winRatePct: null, winRateMarginPct: null, meanNetPct: null, profitFactor: null, meanWinPct: null })
    // The totals are still facts.
    expect(few.wins).toBe(22)
    expect(few.netSumPct).not.toBe(0)
  })

  it('counts an entry that never filled as expired, and one with no candles as unsettled, not as losses', () => {
    const input2 = benchmark([RISE, RISE, RISE], { a: [answer({ entryMin: 95, entryMax: 95.5, stopLoss: 94, takeProfit: 99 }), LONG, LONG] })
    delete input2.bars[input2.events[2].id]
    const row2 = summarizeEventBenchmark(input2).models[0]
    expect(row2).toMatchObject({ actionable: 3, expired: 1, unsettled: 1, closed: 1, wins: 1 })
  })

  it('charges a thinner pair more slippage', () => {
    const one = benchmark([RISE], { a: [LONG] })
    const deep = summarizeEventBenchmark({ ...one, dailyVolume: { [one.events[0].id]: 500_000_000 } }).models[0].netSumPct
    const thin = summarizeEventBenchmark({ ...one, dailyVolume: { [one.events[0].id]: 1_000_000 } }).models[0].netSumPct
    expect(deep).toBeGreaterThan(thin)
  })

  it('makes a slower model enter later', () => {
    // The price is in range for the first three minutes only, then gone.
    const one = benchmark([RISE], { fast: [answer({}, 2000)], slow: [answer({}, 200_000)] })
    const summary = summarizeEventBenchmark(one)
    expect(summary.models[0]).toMatchObject({ closed: 1, wins: 1 })
    // Two hundred seconds: the first minute it can use opens at 103, above its range for good.
    expect(summary.models[1]).toMatchObject({ closed: 0, expired: 1 })
  })

  it('scores an answer bought live from the second it arrived, whatever its latency says', () => {
    // Replayed, a one-second model enters while the price is still in its range.
    const one = benchmark([RISE], { a: [LONG] })
    expect(summarizeEventBenchmark(one).models[0]).toMatchObject({ closed: 1, wins: 1 })
    // Live, that same answer came two hundred seconds after the event, and the price had gone.
    const late = summarizeEventBenchmark({ ...one, answeredAt: { a: [one.events[0].time + 200] } })
    expect(late.models[0]).toMatchObject({ closed: 0, expired: 1 })
    // Where the arrival is not known, the answer is a replayed one.
    expect(summarizeEventBenchmark({ ...one, answeredAt: { a: [null] } }).models[0]).toMatchObject({ closed: 1 })
    expect(summarizeEventBenchmark({ ...one, answeredAt: {} }).models[0]).toMatchObject({ closed: 1 })
  })

  it('charges a live event the spread the scanner saw, when that is more than the rate for its liquidity', () => {
    const one = benchmark([RISE], { a: [LONG] })
    const raisedLive = (spreadPct: number | null): EventBenchmarkInput => ({
      ...one,
      events: [{ ...one.events[0], live: { detectedAt: one.events[0].time + 8, quoteVolume24h: 500_000_000, spreadPct, candidateScore: 90, rank: 1 } }]
    })
    const net = (input: EventBenchmarkInput): number => summarizeEventBenchmark(input).models[0].netSumPct
    const deep = net({ ...one, dailyVolume: { [one.events[0].id]: 500_000_000 } })
    // A hundredth of a percent of spread is less than the rate, and changes nothing.
    expect(net(raisedLive(0.01))).toBeCloseTo(deep, 10)
    expect(net(raisedLive(null))).toBeCloseTo(deep, 10)
    // Half a percent of spread is a quarter of a percent given up on the way in.
    expect(net(raisedLive(0.5))).toBeLessThan(deep - 0.2)
  })
})

describe('summarizeEventBenchmark: the rows that are not models', () => {
  it('follows and fades every event with one fixed bracket', () => {
    const summary = summarizeEventBenchmark(benchmark([RISE, FALL], { a: [NONE, NONE] }))
    const [follow, fade] = summary.baselines
    expect(follow.name).toBe(EVENT_BASELINE_FOLLOW)
    expect(fade.name).toBe(EVENT_BASELINE_FADE)
    // Both events were rises. Following buys them: stop 0.75% away, target 1.5%, the usual move
    // being 0.5%. The first goes up 3% and the second down 3%.
    expect(follow).toMatchObject({ actionable: 2, closed: 2, wins: 1, longs: 2, shorts: 0, noTrades: 0, costUsd: null, answered: null })
    expect(follow.trades[0].outcome).toMatchObject({ exit: 'take_profit', exitPrice: 100 * 1.015 })
    expect(follow.trades[1].outcome.exit).toBe('stop_loss')
    // Fading shorts them, and gets the opposite.
    expect(fade).toMatchObject({ closed: 2, wins: 1, shorts: 2 })
    expect(fade.trades[0].outcome.exit).toBe('stop_loss')
    expect(fade.trades[1].outcome.exit).toBe('take_profit')
  })

  it('shows what the events did with no model before any model has answered, and says which events', () => {
    // Nothing compared yet: one model, and it has answered none of the three.
    const before = summarizeEventBenchmark(benchmark([RISE, FALL, RISE], { a: [null, null, null] }))
    expect(before.compared).toBe(0)
    expect(before.baselinesOver).toBe('sampled')
    expect(before.baselines[0]).toMatchObject({ actionable: 3, closed: 3, wins: 2 })
    expect(before.models[0]).toMatchObject({ actionable: 0, closed: 0 })
    // Once there is something to compare, the no-model rows cover exactly those events.
    const after = summarizeEventBenchmark(benchmark([RISE, FALL, RISE], { a: [LONG, null, null] }))
    expect(after.compared).toBe(1)
    expect(after.baselinesOver).toBe('compared')
    expect(after.baselines[0]).toMatchObject({ actionable: 1, closed: 1, wins: 1 })
  })

  it('mirrors both for a fall', () => {
    const down = benchmark([FALL], { a: [NONE] })
    down.events[0] = { ...down.events[0], type: 'breakdown', direction: 'down', returnsPct: { ...down.events[0].returnsPct, m15: -3 }, moveSigmas: -6 }
    down.bars[down.events[0].id] = path(down.events[0].time, FALL)
    const summary = summarizeEventBenchmark(down)
    expect(summary.baselines[0].trades[0]).toMatchObject({ side: 'short' })
    expect(summary.baselines[0].trades[0].outcome.exit).toBe('take_profit')
    expect(summary.baselines[1].trades[0]).toMatchObject({ side: 'long' })
  })

  it('trades a majority only when more than half take a side and none takes the other', () => {
    const summary = summarizeEventBenchmark(
      benchmark([RISE, RISE, RISE, RISE], {
        a: [LONG, LONG, LONG, LONG],
        b: [LONG, NONE, SHORT, TIMID],
        c: [NONE, NONE, LONG, LONG]
      })
    )
    const majority = summary.rules.find((row) => row.name === EVENT_RULE_MAJORITY)
    // Event 0: two of three long. Event 1: one of three. Event 2: a long and a short. Event 3:
    // two of three at 65% or more (the timid one does not count as a side).
    expect(majority?.trades.map((trade) => trade.index)).toEqual([0, 3])
    expect(majority).toMatchObject({ longs: 2, shorts: 0, noTrades: 2, answered: null, costUsd: null })
  })

  it('does not call exactly half of the models a majority, on either side', () => {
    const summary = summarizeEventBenchmark(benchmark([RISE, FALL, RISE, FALL], { a: [LONG, SHORT, LONG, SHORT], b: [NONE, NONE, LONG, SHORT] }))
    const majority = summary.rules.find((row) => row.name === EVENT_RULE_MAJORITY)
    // One of two is half, not more than half. Two of two is.
    expect(majority?.trades.map((trade) => [trade.index, trade.side])).toEqual([
      [2, 'long'],
      [3, 'short']
    ])
  })

  it('trades unanimity only when every model takes the same side', () => {
    const summary = summarizeEventBenchmark(benchmark([RISE, RISE, FALL], { a: [LONG, LONG, SHORT], b: [LONG, NONE, SHORT] }))
    const unanimous = summary.rules.find((row) => row.name === EVENT_RULE_UNANIMOUS)
    expect(unanimous?.trades.map((trade) => [trade.index, trade.side])).toEqual([
      [0, 'long'],
      [2, 'short']
    ])
  })

  it('weighs each answer by its confidence', () => {
    const sure = answer({ confidence: 0.95 })
    const summary = summarizeEventBenchmark(benchmark([RISE, RISE], { a: [sure, LONG], b: [NONE, answer({ recommendation: 'hold', entryMin: null, entryMax: null, stopLoss: null, takeProfit: null, confidence: 0.9 })] }))
    const weighted = summary.rules.find((row) => row.name === EVENT_RULE_WEIGHTED)
    // 0.95 long against 0.5 abstaining; then 0.8 long against 0.9 abstaining.
    expect(weighted?.trades.map((trade) => trade.index)).toEqual([0])
  })

  it('waits for the last answer to arrive, when the answers were bought live', () => {
    const one = benchmark([RISE], { a: [LONG], b: [LONG] })
    const at = one.events[0].time
    const summary = summarizeEventBenchmark({ ...one, answeredAt: { a: [at + 5], b: [at + 200] } })
    expect(summary.models[0]).toMatchObject({ closed: 1 })
    expect(summary.models[1]).toMatchObject({ expired: 1 })
    // Both are long, so every rule would trade -- once the second answer is in, which is too late.
    for (const row of summary.rules) expect(row.trades.map((trade) => trade.outcome.status)).toEqual(['expired'])
    const prompt = summarizeEventBenchmark({ ...one, answeredAt: { a: [at + 5], b: [at + 30] } })
    for (const row of prompt.rules) expect(row.trades.map((trade) => trade.outcome.status)).toEqual(['closed'])
  })

  it('borrows the levels of the model surest of that side, and waits for the slowest answer', () => {
    const tight = answer({ confidence: 0.9, takeProfit: 101 }, 2000)
    const summary = summarizeEventBenchmark(benchmark([RISE], { a: [LONG], b: [tight], c: [answer({}, 200_000)] }))
    // All three are long, so every rule would trade -- on the 0.9 model's target of 101. But the
    // third model took two hundred seconds, and by then the price had left the range.
    for (const row of summary.rules) {
      expect(row.trades).toHaveLength(1)
      expect(row.trades[0].confidence).toBe(0.9)
      expect(row.trades[0].outcome.status).toBe('expired')
    }
    const prompt = summarizeEventBenchmark(benchmark([RISE], { a: [LONG], b: [tight] }))
    expect(prompt.rules[0].trades[0].outcome).toMatchObject({ exit: 'take_profit', exitPrice: 101 })
  })
})

describe('summarizeEventBenchmark: what a model changed about the rule', () => {
  // Sixty rises raised as events. The price goes on up after the even ones and comes back after
  // the odd ones, and the model buys exactly the even ones: its choice of events is perfect.
  const ends = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? RISE : FALL))
  const summary = summarizeEventBenchmark(benchmark(ends, { a: ends.map((_, i) => (i % 2 === 0 ? LONG : NONE)) }))
  const [own] = summary.models
  const [follow] = summary.baselines
  const [changed] = summary.contributions
  const meanOf = (indices: (index: number) => boolean): number => {
    const nets = follow.trades.filter((trade) => indices(trade.index)).map((trade) => trade.outcome.netPct ?? NaN)
    return nets.reduce((sum, net) => sum + net, 0) / nets.length
  }

  it('trades the fixed bracket on the calls the model made, and the rule on the events it left', () => {
    expect(changed).toMatchObject({ model: 'a', withTheMove: 30, againstTheMove: 0 })
    expect(changed.bracket).toMatchObject({ actionable: 30, closed: 30, wins: 30, costUsd: null })
    expect(changed.left).toMatchObject({ actionable: 30, closed: 30, wins: 0 })
    // The same trades the rule's own row holds for those events, not ones scored some other way.
    expect(changed.bracket.trades.map((trade) => trade.outcome.netPct)).toEqual(follow.trades.filter((trade) => trade.index % 2 === 0).map((trade) => trade.outcome.netPct))
    expect(changed.left.meanNetPct).toBeCloseTo(meanOf((index) => index % 2 === 1), 10)
  })

  it('splits the model against the rule into its choice of events and its levels', () => {
    const rule = follow.meanNetPct ?? NaN
    const bracket = meanOf((index) => index % 2 === 0)
    expect(changed.choicePct).toBeCloseTo(bracket - rule, 10)
    expect(changed.levelsPct).toBeCloseTo((own.meanNetPct ?? NaN) - bracket, 10)
    expect(changed.againstRulePct).toBeCloseTo((own.meanNetPct ?? NaN) - rule, 10)
    expect((changed.choicePct ?? NaN) + (changed.levelsPct ?? NaN)).toBeCloseTo(changed.againstRulePct ?? NaN, 10)
    // It chose only the events that went on, and that is where its advantage came from: the
    // bracket's target of 1.5% against its stop of 0.75%, half of each over all sixty.
    expect(changed.choicePct).toBeCloseTo((1.5 + 0.75) / 2, 1)
    // Its own target was further away than the bracket's, and the price reached it.
    expect(changed.levelsPct).toBeGreaterThan(0.3)
  })

  it('puts the fixed bracket on the side the model took, when that is against the move', () => {
    const against = summarizeEventBenchmark(benchmark([FALL, RISE], { a: [SHORT, LONG] }))
    const [entry] = against.contributions
    expect(entry).toMatchObject({ withTheMove: 1, againstTheMove: 1 })
    expect(entry.bracket.trades.map((trade) => trade.side)).toEqual(['short', 'long'])
    // The short is the fade row's trade on that event, and the long the follow row's on the other.
    expect(entry.bracket.trades[0].outcome).toEqual(against.baselines[1].trades[0].outcome)
    expect(entry.bracket.trades[1].outcome).toEqual(against.baselines[0].trades[1].outcome)
    expect(entry.left.actionable).toBe(0)
  })

  it('counts a call it would not act on, and an answer that was refused, as events it left', () => {
    const [entry] = summarizeEventBenchmark(benchmark([RISE, RISE, RISE], { a: [TIMID, REFUSED, LONG] })).contributions
    expect(entry.bracket.actionable).toBe(1)
    expect(entry.left.actionable).toBe(2)
    expect(entry.left.trades.map((trade) => trade.index)).toEqual([0, 1])
  })

  it('leaves an event with no direction out of both, since the rule has no side to take on it', () => {
    const input = benchmark([RISE, RISE], { a: [LONG, LONG] })
    input.events[0] = { ...input.events[0], direction: 'none' }
    const [entry] = summarizeEventBenchmark(input).contributions
    expect(entry).toMatchObject({ withTheMove: 1, againstTheMove: 0 })
    expect(entry.bracket.actionable).toBe(1)
    expect(entry.left.actionable).toBe(0)
  })

  it('withholds the split under thirty closed trades, and has none while nothing is compared', () => {
    const [few] = summarizeEventBenchmark(benchmark([RISE, FALL], { a: [LONG, LONG] })).contributions
    expect(few).toMatchObject({ againstRulePct: null, choicePct: null, levelsPct: null })
    expect(few.bracket.netSumPct).not.toBe(0)
    expect(summarizeEventBenchmark(benchmark([RISE], { a: [null] })).contributions).toEqual([])
  })

  it('says how the trades ended', () => {
    expect(own.exits).toEqual({ target: 30, stop: 0, time: 0 })
    expect(follow.exits).toEqual({ target: 30, stop: 30, time: 0 })
    // A price that goes nowhere reaches neither level, and the holding time ends the trade.
    const flat = summarizeEventBenchmark(benchmark([100.5], { a: [LONG] }))
    expect(flat.models[0].exits).toEqual({ target: 0, stop: 0, time: 1 })
  })
})

describe('the quant rows, the hybrids, and holding the same hours', () => {
  /** Each event's two states, in order: [Trend Regime 4h, Short-Term Channel 15m]. */
  function withStates(input: EventBenchmarkInput, states: [QuantSide | null, QuantSide | null][]): EventBenchmarkInput {
    const quant: Record<string, EventQuantStates> = {}
    input.events.forEach((entry, i) => {
      quant[entry.id] = { trend4h: states[i][0], channel15m: states[i][1] }
    })
    return { ...input, quant }
  }
  const STATES: [QuantSide | null, QuantSide | null][] = [
    ['long', 'none'],
    ['short', 'long'],
    ['none', 'long'],
    [null, 'short']
  ]

  it('follows the move only where the strategy is on its side', () => {
    const summary = summarizeEventBenchmark(withStates(benchmark([RISE, RISE, RISE, RISE], { a: [LONG, SHORT, LONG, NONE] }), STATES))
    const [trend, channel] = summary.quant
    expect(trend.name).toBe(quantRuleName('trend4h'))
    expect(channel.name).toBe('Follow when Short-Term Channel 15m agrees (no model)')
    // Every event rose, so the rule goes long: with Trend Regime long only at the first; with the
    // channel at the second and third. Neither, unread or against, is no trade.
    expect(trend.trades.map((trade) => [trade.index, trade.side])).toEqual([[0, 'long']])
    expect(channel.trades.map((trade) => [trade.index, trade.side])).toEqual([
      [1, 'long'],
      [2, 'long']
    ])
    expect(trend.noTrades).toBe(3)
  })

  it("keeps a model's own trades only where the strategy agrees with its side", () => {
    const summary = summarizeEventBenchmark(withStates(benchmark([RISE, FALL, RISE, RISE], { a: [LONG, SHORT, LONG, NONE] }), STATES))
    const row = (quant: 'trend4h' | 'channel15m'): EventTrade[] => summary.hybrids.find((entry) => entry.model === 'a' && entry.quant === quant)?.row.trades ?? []
    // The model's long at 0 and short at 1 sit with Trend Regime; its long at 2 does not.
    expect(row('trend4h').map((trade) => [trade.index, trade.side])).toEqual([
      [0, 'long'],
      [1, 'short']
    ])
    expect(row('channel15m').map((trade) => [trade.index, trade.side])).toEqual([[2, 'long']])
    expect(summary.hybrids.map((entry) => entry.row.name)).toEqual([hybridName('a', 'trend4h'), hybridName('a', 'channel15m')])
    // The model's own trades as they are, by its own levels.
    expect(row('trend4h')[0].outcome).toEqual(summary.models[0].trades[0].outcome)
  })

  it('works out neither without the states', () => {
    const summary = summarizeEventBenchmark(benchmark([RISE], { a: [LONG] }))
    expect(summary.quant).toEqual([])
    expect(summary.hybrids).toEqual([])
  })

  it("buys every event's pair at the follow rule's entry and holds it an hour, whatever the move, with no R", () => {
    const input = benchmark([RISE, FALL, FALL], { a: [LONG, LONG, LONG] })
    input.events[1] = { ...input.events[1], direction: 'none' }
    input.events[2] = { ...input.events[2], direction: 'down' }
    input.bars = { [input.events[0].id]: path(input.events[0].time, RISE), [input.events[1].id]: path(input.events[1].time, FALL), [input.events[2].id]: path(input.events[2].time, FALL) }
    const hold = summarizeEventBenchmark(input).buyAndHold
    expect(hold.name).toBe(EVENT_BUY_AND_HOLD)
    // Bought whatever the move: up, none, and down alike.
    expect(hold.trades.map((trade) => [trade.side, trade.outcome.status, trade.outcome.exit, trade.outcome.r])).toEqual([
      ['long', 'closed', 'time', null],
      ['long', 'closed', 'time', null],
      ['long', 'closed', 'time', null]
    ])
    // In at the open of the first minute after the question, 100, and out an hour on at the close.
    const costs = { feeRate: FEE_RATE, slippageRate: slippageRateFor(null) }
    const net = (end: number): number => ((end * (1 - costs.slippageRate) * (1 - costs.feeRate)) / (100 * (1 + costs.slippageRate) * (1 + costs.feeRate)) - 1) * 100
    expect(hold.trades[0].outcome.netPct).toBeCloseTo(net(RISE), 1)
    expect(hold.trades[1].outcome.netPct).toBeCloseTo(net(FALL), 1)
    expect(hold.meanR).toBeNull()
  })

  it("gives a trade's Sharpe, Sortino and R from thirty closed trades, and none before", () => {
    const ends = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? FALL : RISE))
    const row = summarizeEventBenchmark(benchmark(ends, { a: ends.map(() => LONG) })).models[0]
    const nets = row.trades.filter((trade) => trade.outcome.status === 'closed').map((trade) => trade.outcome.netPct as number)
    expect(nets).toHaveLength(40)
    const mean = nets.reduce((sum, net) => sum + net, 0) / nets.length
    const spread = Math.sqrt(nets.reduce((sum, net) => sum + (net - mean) ** 2, 0) / (nets.length - 1))
    const downside = Math.sqrt(nets.reduce((sum, net) => sum + Math.min(net, 0) ** 2, 0) / nets.length)
    expect(row.sharpe).toBeCloseTo(mean / spread, 10)
    expect(row.sortino).toBeCloseTo(mean / downside, 10)
    expect(row.meanR).toBeCloseTo(row.rSum / 40, 10)
    const few = summarizeEventBenchmark(benchmark(ends.slice(0, 29), { a: ends.slice(0, 29).map(() => LONG) })).models[0]
    expect([few.sharpe, few.sortino, few.meanR]).toEqual([null, null, null])
    // With nothing lost there is no downside to divide by.
    const allWon = summarizeEventBenchmark(benchmark(ends.map(() => RISE), { a: ends.map(() => LONG) })).models[0]
    expect(allWon.sortino).toBeNull()
  })
})

describe('eventScoring', () => {
  it('states what a result rests on besides the answers and the candles', () => {
    // Written on every recorded experiment. A change to any of these is a change to how a run
    // already made is read, and this is where it has to be made on purpose.
    expect(eventScoring()).toEqual({
      feeRate: 0.001,
      slippageRates: [0.0002, 0.0005, 0.001],
      askDelaySec: 10,
      minConfidence: 0.65,
      baseline: { stopSigmas: 1.5, targetSigmas: 3, holdSeconds: 3600 }
    })
  })

  it('is the same after a trip through a file', () => {
    expect(JSON.parse(JSON.stringify(eventScoring()))).toEqual(eventScoring())
  })
})

describe('rollingResults', () => {
  const NOW_SEC = T0 + 40 * DAY
  /** A closed trade on an event `daysAgo` days back, returning `netPct`. */
  const closed = (index: number, daysAgo: number, netPct: number): EventTrade => ({
    index,
    time: NOW_SEC - daysAgo * DAY,
    type: 'breakout',
    side: 'long',
    confidence: 0.8,
    holdSeconds: 3600,
    // Each as if its stop had been 2% away: its R is half its net.
    outcome: { status: 'closed', entryTime: 1, entryPrice: 100, exit: 'time', exitTime: 2, exitPrice: 100, netPct, r: netPct / 2, bestPct: 0, worstPct: 0, heldMinutes: 60 }
  })
  const pending = (index: number, status: 'waiting' | 'expired' | 'open'): EventTrade => ({
    ...closed(index, 0.1, 99),
    outcome: { status, entryTime: null, entryPrice: null, exit: null, exitTime: null, exitPrice: null, netPct: null, bestPct: null, worstPct: null, heldMinutes: null }
  })

  it('adds up the last ten, fifty and hundred closed trades, newest first', () => {
    // Sixty trades, one a half day: the newest is +1, and each older one is 0.1 less.
    const trades = Array.from({ length: 60 }, (_, i) => closed(i, i / 2, 1 - i * 0.1))
    const { lastTrades } = rollingResults(trades, NOW_SEC)
    expect(lastTrades.map((window) => window.count)).toEqual([10, 50, 100])
    expect(lastTrades[0]).toMatchObject({ trades: 10, wins: 10 })
    expect(lastTrades[0].netSumPct).toBeCloseTo(10 * 1 - 0.1 * 45, 9)
    expect(lastTrades[1].trades).toBe(50)
    // There are only sixty: the last hundred is all of them, and says so by its count.
    expect(lastTrades[2].trades).toBe(60)
    expect(lastTrades[2].netSumPct).toBeCloseTo(60 - 0.1 * ((59 * 60) / 2), 9)
  })

  it('does not depend on the order it is handed the trades in', () => {
    const trades = Array.from({ length: 30 }, (_, i) => closed(i, i, i < 10 ? 1 : -1))
    const shuffled = [...trades].sort((a, b) => ((a.index * 7) % 11) - ((b.index * 7) % 11))
    expect(rollingResults(shuffled, NOW_SEC)).toEqual(rollingResults(trades, NOW_SEC))
    expect(rollingResults(shuffled, NOW_SEC).lastTrades[0]).toMatchObject({ trades: 10, wins: 10, netSumPct: 10 })
  })

  it('adds up the last seven and thirty days by the event\'s own time', () => {
    const trades = [closed(0, 1, 2), closed(1, 6.9, -1), closed(2, 7.1, 5), closed(3, 29, 0.5), closed(4, 31, 100)]
    const { lastDays } = rollingResults(trades, NOW_SEC)
    expect(lastDays.map((window) => window.days)).toEqual([7, 30])
    expect(lastDays[0]).toEqual({ days: 7, trades: 2, wins: 1, netSumPct: 1, rSum: 0.5 })
    expect(lastDays[1]).toEqual({ days: 30, trades: 4, wins: 3, netSumPct: 6.5, rSum: 3.25 })
  })

  it('counts only trades that have closed, and a trade that broke even as not won', () => {
    const trades = [closed(0, 1, 0), closed(1, 2, 0.4), pending(2, 'waiting'), pending(3, 'expired'), pending(4, 'open')]
    const rolling = rollingResults(trades, NOW_SEC)
    expect(rolling.lastTrades[0]).toMatchObject({ trades: 2, wins: 1, netSumPct: 0.4 })
    expect(rolling.lastDays[0]).toMatchObject({ trades: 2, wins: 1 })
  })

  it('is empty, not a row of zeros dressed as results, with nothing closed', () => {
    const rolling = rollingResults([pending(0, 'open')], NOW_SEC)
    expect(rolling.lastTrades.every((window) => window.trades === 0 && window.netSumPct === 0)).toBe(true)
    expect(rolling.lastDays.every((window) => window.trades === 0)).toBe(true)
  })
})
