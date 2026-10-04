import { describe, expect, it } from 'vitest'
import {
  EVENT_BASELINE_FADE,
  EVENT_BASELINE_FOLLOW,
  EVENT_BENCHMARK_SETTLE_SEC,
  EVENT_BENCHMARK_STAKE_USD,
  EVENT_RULE_MAJORITY,
  EVENT_RULE_UNANIMOUS,
  EVENT_RULE_WEIGHTED,
  eventBenchmarkWindow,
  sampleEvents,
  summarizeEventBenchmark,
  type EventBenchmarkInput
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
