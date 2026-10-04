import { describe, expect, it } from 'vitest'
import {
  AI_BENCHMARK_BASELINE,
  AI_BENCHMARK_DEFAULT_SPACING_BARS,
  benchmarkSampleTimes,
  heldPath,
  latestScorableTime,
  summarizeBenchmark,
  summarizeBenchmarkRoutes,
  usableBenchmarkTimes,
  type AiBenchmarkAnswers
} from '../shared/aiBenchmark'
import { AI_ROUND_TRIP_COST_PCT } from '../shared/aiContext'
import { benchmarkCostEstimate, describeAiBenchmarkCost, type AiBenchmarkCostModel } from '../shared/aiCost'
import { MIN_SCORED_CALLS, OUTCOME_HORIZON_BARS, OUTCOME_PRIMARY_BARS, type AiOutcome } from '../shared/aiOutcome'
import { GPT_LOOKBACK_BARS, GPT_MIN_CONFIDENCE, type AiSignalDecision } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'

// A benchmark is only worth its cost if the comparison it prints is fair and the sample it buys
// is the one it will ask for again tomorrow. These pin both: which candles are asked about, which
// answers are set side by side, and that "right" here is the same "right" as everywhere else.

const BAR = 900
const STEP = OUTCOME_PRIMARY_BARS
/** On a four-hour boundary, so sampled times here look like the ones the app produces. */
const T0 = 1_700_006_400

function bar(time: number, close: number, wick: { high?: number; low?: number } = {}): Candle {
  return { time, open: close, high: wick.high ?? close, low: wick.low ?? close, close, volume: 1 }
}

/** One sampled candle every sixteen bars. Sample k fills at its candle's close; sixteen bars later
 * price has moved by `moves[k]` percent, and that close is where sample k+1 fills. Between them
 * price does not move, so the whole of each move lands on the horizon's last bar. */
function market(moves: number[]): { candles: Candle[]; times: number[] } {
  const candles: Candle[] = []
  const times: number[] = []
  let price = 100
  for (let k = 0; k <= moves.length; k++) {
    if (k < moves.length) times.push(T0 + k * STEP * BAR)
    for (let j = 0; j < STEP; j++) candles.push(bar(T0 + (k * STEP + j) * BAR, price))
    price *= 1 + (moves[k] ?? 0) / 100
  }
  return { candles, times }
}

function said(
  recommendation: 'buy' | 'sell' | 'hold',
  confidence = 0.8,
  over: Partial<AiSignalDecision> = {}
): AiSignalDecision {
  return {
    candleTime: 0,
    recommendation,
    confidence,
    rationale: '',
    model: 'test/model',
    cached: false,
    error: null,
    rejected: null,
    detail: null,
    usage: { promptTokens: 1000, completionTokens: 200, costUsd: 0.002, latencyMs: 1500 },
    ...over
  }
}

const REFUSED = said('hold', 0, { rejected: 'marketRegime is not an allowed value' })

function outcome(returnPct: number | null, worstPct: number | null = returnPct === null ? null : Math.min(0, returnPct)): AiOutcome {
  return {
    referencePrice: 100,
    forward: OUTCOME_HORIZON_BARS.map((bars) => ({ bars, returnPct: bars === OUTCOME_PRIMARY_BARS ? returnPct : null })),
    bestPct: returnPct === null ? null : Math.max(0, returnPct),
    worstPct,
    barrier: 'no_levels',
    correct: null
  }
}

describe('which candles a benchmark asks about', () => {
  const now = T0 + 40 * 86_400 + 37 * 60

  it('asks about nothing whose outcome is not known yet', () => {
    const latest = latestScorableTime(now, '15m')
    // The candle sixteen bars after it has closed...
    expect(latest + OUTCOME_PRIMARY_BARS * BAR + BAR).toBeLessThanOrEqual(now)
    // ...and the same cannot be said of the next candle along.
    expect(latest + BAR + OUTCOME_PRIMARY_BARS * BAR + BAR).toBeGreaterThan(now)
    const times = benchmarkSampleTimes({ nowSec: now, days: 30, everyBars: 16, interval: '15m' })
    expect(times[times.length - 1]).toBeLessThanOrEqual(latest)
  })

  it('samples on the clock: every time is a multiple of the spacing, evenly apart, oldest first', () => {
    const times = benchmarkSampleTimes({ nowSec: now, days: 30, everyBars: 16, interval: '15m' })
    expect(times).toHaveLength(30 * 6)
    expect(times.every((time) => time % (16 * BAR) === 0)).toBe(true)
    expect(times.every((time, i) => i === 0 || time - times[i - 1] === 16 * BAR)).toBe(true)
    expect(benchmarkSampleTimes({ nowSec: now, days: 7, everyBars: 96, interval: '15m' }).every((time) => time % 86_400 === 0)).toBe(true)
  })

  it('asks about the same candles an hour later, so a rerun is served from the cache', () => {
    const at = (nowSec: number): number[] => benchmarkSampleTimes({ nowSec, days: 14, everyBars: 16, interval: '15m' })
    // `now` sits 37 minutes past a four-hour boundary plus the scoring lag: no new sample is due
    // for hours, and counting back from "now" instead would have moved every one of them.
    expect(at(now + 3600)).toEqual(at(now))
    // A day on, six new candles have come into range and six have left it; the rest are shared.
    const tomorrow = at(now + 86_400)
    expect(tomorrow.filter((time) => at(now).includes(time))).toHaveLength(at(now).length - 6)
  })

  it('defaults to a spacing at which no two calls are scored on the same candles', () => {
    expect(AI_BENCHMARK_DEFAULT_SPACING_BARS).toBe(OUTCOME_PRIMARY_BARS)
  })

  it('has nothing to ask for a period or a spacing that is not one', () => {
    expect(benchmarkSampleTimes({ nowSec: now, days: 0, everyBars: 16, interval: '15m' })).toEqual([])
    expect(benchmarkSampleTimes({ nowSec: now, days: 30, everyBars: 0, interval: '15m' })).toEqual([])
  })

  it('keeps only the candles the market can be asked about, and counts the rest', () => {
    const candles = Array.from({ length: GPT_LOOKBACK_BARS + 3 }, (_, i) => bar(T0 + i * BAR, 100))
    const enough = candles[GPT_LOOKBACK_BARS].time
    const oneShort = candles[GPT_LOOKBACK_BARS - 1].time
    const neverOpened = enough + BAR / 3
    expect(usableBenchmarkTimes(candles, [oneShort, enough, neverOpened])).toEqual({ times: [enough], missing: 2 })
  })
})

describe('holding every entry for the horizon', () => {
  it('pays the round trip on every trade and compounds what is left', () => {
    const path = heldPath([
      { index: 0, outcome: outcome(1) },
      { index: 16, outcome: outcome(1) }
    ])
    expect(path.trades).toBe(2)
    expect(path.wins).toBe(2)
    expect(path.returnPct).toBeCloseTo(((1 + (1 - AI_ROUND_TRIP_COST_PCT) / 100) ** 2 - 1) * 100, 10)
  })

  it('counts a move that does not clear the round trip as a loss', () => {
    const path = heldPath([{ index: 0, outcome: outcome(AI_ROUND_TRIP_COST_PCT / 2) }])
    expect(path.wins).toBe(0)
    expect(path.returnPct).toBeLessThan(0)
  })

  it('passes over an entry that arrives while the last one is still held, and takes one on the bar it ends', () => {
    const path = heldPath([
      { index: 0, outcome: outcome(1) },
      { index: 8, outcome: outcome(50) },
      { index: 15, outcome: outcome(50) },
      { index: 16, outcome: outcome(1) }
    ])
    expect(path.trades).toBe(2)
    expect(path.returnPct).toBeLessThan(3)
  })

  it('counts the worst price inside a hold in the drawdown, not only where the hold ended', () => {
    const path = heldPath([{ index: 0, outcome: outcome(2, -6) }])
    expect(path.returnPct).toBeGreaterThan(0)
    expect(path.maxDrawdownPct).toBeCloseTo(6, 10)
  })

  it('measures a drawdown from the peak, across trades', () => {
    const path = heldPath([
      { index: 0, outcome: outcome(10, 0) },
      { index: 16, outcome: outcome(-5, -5) },
      { index: 32, outcome: outcome(-5, -5) }
    ])
    const up = 1 + (10 - AI_ROUND_TRIP_COST_PCT) / 100
    const down = 1 + (-5 - AI_ROUND_TRIP_COST_PCT) / 100
    expect(path.maxDrawdownPct).toBeCloseTo((1 - down * down) * 100, 8)
    expect(path.returnPct).toBeCloseTo((up * down * down - 1) * 100, 8)
  })

  it('does not take, or wait on, an entry whose horizon has not closed', () => {
    const path = heldPath([
      { index: 0, outcome: outcome(null) },
      { index: 4, outcome: outcome(1) }
    ])
    expect(path.trades).toBe(1)
  })

  it('reads entries in time order whatever order it is handed them', () => {
    const forwards = heldPath([
      { index: 0, outcome: outcome(1) },
      { index: 8, outcome: outcome(-9) }
    ])
    const backwards = heldPath([
      { index: 8, outcome: outcome(-9) },
      { index: 0, outcome: outcome(1) }
    ])
    expect(backwards).toEqual(forwards)
  })
})

describe('the comparison', () => {
  it('is made only over the decisions every model answered', () => {
    const { candles, times } = market([1, 1, -1, 1])
    const answers: AiBenchmarkAnswers = {
      a: [said('buy'), said('buy'), said('buy'), said('buy')],
      b: [said('buy'), said('hold'), null, said('buy')]
    }
    const summary = summarizeBenchmark({ candles, times, models: ['a', 'b'], answers })
    expect(summary.sampled).toBe(4)
    expect(summary.compared).toBe(3)
    // `a` answered the losing candle too, and is not charged with it: `b` was never asked.
    expect(summary.models[0]).toMatchObject({ model: 'a', answered: 4, buys: 3, hits: 3 })
    expect(summary.models[1]).toMatchObject({ model: 'b', answered: 3, buys: 2, holds: 1 })
    expect(summary.decisions.map((row) => row.compared)).toEqual([true, true, false, true])
  })

  it('does not take a call that never reached a model for an answer', () => {
    const { candles, times } = market([1, 1])
    const answers: AiBenchmarkAnswers = {
      a: [said('buy'), said('buy')],
      b: [said('buy'), said('hold', 0, { error: 'timed out' })]
    }
    const summary = summarizeBenchmark({ candles, times, models: ['a', 'b'], answers })
    expect(summary.compared).toBe(1)
    expect(summary.models[1].answered).toBe(1)
    expect(summary.decisions[1].calls[1]).toBeNull()
  })

  it('counts a refused answer as answered, and as nothing else', () => {
    const { candles, times } = market([1, 1])
    const summary = summarizeBenchmark({ candles, times, models: ['a'], answers: { a: [REFUSED, said('buy')] } })
    expect(summary.compared).toBe(2)
    expect(summary.models[0]).toMatchObject({ answered: 2, refused: 1, buys: 1, sells: 0, holds: 0, entries: 1 })
  })

  it('scores a call the way the Signals tab does, and says how wide the margin on it is', () => {
    const moves = Array.from({ length: 64 }, (_, k) => (k % 2 === 0 ? 1 : -1))
    const { candles, times } = market(moves)
    const summary = summarizeBenchmark({ candles, times, models: ['a'], answers: { a: times.map(() => said('buy')) } })
    const row = summary.models[0]
    expect(row).toMatchObject({ buys: 64, scored: 64, hits: 32 })
    expect(row.hitRatePct).toBeCloseTo(50, 10)
    expect(row.hitRateMarginPct).toBeCloseTo(1.96 * Math.sqrt(0.25 / 64) * 100, 10)
    expect(row.meanBuyReturnPct).toBeCloseTo(0, 10)
    expect(row.meanBestPct).toBeCloseTo(0.5, 10)
    expect(row.meanWorstPct).toBeCloseTo(-0.5, 10)
  })

  it('needs a buy to clear the round trip, and a sell only to precede a fall', () => {
    const { candles, times } = market([AI_ROUND_TRIP_COST_PCT / 2, -0.01])
    const summary = summarizeBenchmark({ candles, times, models: ['a'], answers: { a: [said('buy'), said('sell')] } })
    expect(summary.models[0]).toMatchObject({ buys: 1, sells: 1, scored: 2, hits: 1 })
  })

  it('withholds a hit rate, and its margin, under the floor every hit rate here has', () => {
    const { candles, times } = market(new Array<number>(MIN_SCORED_CALLS - 1).fill(1))
    const row = summarizeBenchmark({ candles, times, models: ['a'], answers: { a: times.map(() => said('buy')) } }).models[0]
    expect(row).toMatchObject({ scored: MIN_SCORED_CALLS - 1, hits: MIN_SCORED_CALLS - 1, hitRatePct: null, hitRateMarginPct: null })
    expect(row.meanBuyReturnPct).toBeNull()
    expect(row.meanBestPct).toBeNull()
  })

  it('counts as an entry only what the bot would enter on', () => {
    const { candles, times } = market([1, 1, 1, 1])
    const answers = {
      a: [said('buy', GPT_MIN_CONFIDENCE), said('buy', GPT_MIN_CONFIDENCE - 0.01), said('sell', 0.9), said('hold', 0.9)]
    }
    const row = summarizeBenchmark({ candles, times, models: ['a'], answers }).models[0]
    expect(row).toMatchObject({ buys: 2, sells: 1, holds: 1, entries: 1 })
    expect(row.held.trades).toBe(1)
  })

  it('sets every model beside the market itself: a model that bought every time', () => {
    const { candles, times } = market([1, -1, 1, -1, 1, 1])
    const summary = summarizeBenchmark({ candles, times, models: ['a'], answers: { a: times.map(() => said('hold')) } })
    expect(summary.baseline).toMatchObject({ model: AI_BENCHMARK_BASELINE, buys: 6, entries: 6, scored: 6, hits: 4 })
    expect(summary.baseline.held.trades).toBe(6)
    // No model was asked for it, so it has neither a latency nor a price.
    expect(summary.baseline).toMatchObject({ medianLatencyMs: null, costUsd: null, costPerCallUsd: null })
    // And it is over the compared decisions only, like the rows it is read against.
    const partial = summarizeBenchmark({ candles, times, models: ['a'], answers: { a: [said('hold'), null, said('hold'), null, null, null] } })
    expect(partial.baseline).toMatchObject({ buys: 2, hits: 2 })
  })

  it('reports what the compared answers cost when they were first asked, cached or not', () => {
    const { candles, times } = market([1, 1, 1])
    const usage = (costUsd: number | null, latencyMs: number): AiSignalDecision['usage'] => ({ promptTokens: 1, completionTokens: 1, costUsd, latencyMs })
    const answers = {
      a: [
        said('buy', 0.8, { cached: true, usage: usage(0.01, 900) }),
        said('hold', 0.5, { usage: usage(0.03, 2100) }),
        said('hold', 0.5, { usage: usage(null, 1500) })
      ],
      b: [said('hold', 0.5, { usage: null }), said('hold', 0.5, { usage: null }), said('hold', 0.5, { usage: null })]
    }
    const summary = summarizeBenchmark({ candles, times, models: ['a', 'b'], answers })
    expect(summary.models[0].costUsd).toBeCloseTo(0.04, 10)
    expect(summary.models[0].costPerCallUsd).toBeCloseTo(0.02, 10)
    expect(summary.models[0].medianLatencyMs).toBe(1500)
    expect(summary.models[1]).toMatchObject({ costUsd: null, costPerCallUsd: null, medianLatencyMs: null })
  })

  it('says how often two models made the same call, over answers both could be read from', () => {
    const { candles, times } = market([1, 1, 1, 1])
    const answers = {
      a: [said('buy'), said('hold'), said('buy'), said('hold')],
      b: [said('buy'), said('hold'), said('hold'), REFUSED],
      c: [said('buy'), said('buy'), said('buy'), said('hold')]
    }
    const summary = summarizeBenchmark({ candles, times, models: ['a', 'b', 'c'], answers })
    expect(summary.agreement).toEqual([
      { a: 'a', b: 'b', both: 3, same: 2 },
      { a: 'a', b: 'c', both: 4, same: 3 },
      { a: 'b', b: 'c', both: 3, same: 1 }
    ])
    expect(summary.unanimous).toBe(1)
  })

  it('has no agreement to report for one model', () => {
    const { candles, times } = market([1])
    const summary = summarizeBenchmark({ candles, times, models: ['a'], answers: { a: [said('buy')] } })
    expect(summary.agreement).toEqual([])
    expect(summary.unanimous).toBeNull()
  })

  it('gives buy-and-hold over the compared stretch, after one round trip', () => {
    const { candles, times } = market([10, -5, 2, 50])
    // The last decision is not compared, so the stretch ends where the third one's horizon does.
    const answers = { a: [said('hold'), said('hold'), said('hold'), null] }
    const summary = summarizeBenchmark({ candles, times, models: ['a'], answers })
    expect(summary.buyAndHoldPct).toBeCloseTo((1.1 * 0.95 * 1.02 - 1) * 100 - AI_ROUND_TRIP_COST_PCT, 8)
  })

  it('lists every sampled candle with each model\'s call in the order the models were given', () => {
    const { candles, times } = market([1, -2])
    const answers = { b: [said('hold', 0.4), said('buy', 0.9)], a: [said('buy', 0.7), null] }
    const summary = summarizeBenchmark({ candles, times, models: ['a', 'b'], answers })
    expect(summary.decisions).toHaveLength(2)
    expect(summary.decisions[0]).toMatchObject({ time: times[0], compared: true, referencePrice: 100 })
    expect(summary.decisions[0].primaryReturnPct).toBeCloseTo(1, 10)
    expect(summary.decisions[0].calls.map((call) => call?.recommendation)).toEqual(['buy', 'hold'])
    expect(summary.decisions[1].calls.map((call) => call?.recommendation ?? null)).toEqual([null, 'buy'])
    expect(summary.decisions[1].primaryReturnPct).toBeCloseTo(-2, 10)
  })

  it('compares nothing when nothing is answered, or nobody was asked', () => {
    const { candles, times } = market([1, 1])
    const empty = summarizeBenchmark({ candles, times, models: ['a'], answers: {} })
    expect(empty).toMatchObject({ sampled: 2, compared: 0, buyAndHoldPct: null })
    expect(empty.models[0]).toMatchObject({ answered: 0, buys: 0, scored: 0, hitRatePct: null })
    expect(empty.baseline.buys).toBe(0)
    expect(summarizeBenchmark({ candles, times, models: [], answers: {} }).compared).toBe(0)
  })

  it('leaves a decision unscored when its candle is not among the candles', () => {
    const { candles, times } = market([1])
    const summary = summarizeBenchmark({ candles, times: [times[0] + 1], models: ['a'], answers: { a: [said('buy')] } })
    expect(summary.decisions[0]).toMatchObject({ referencePrice: null, primaryReturnPct: null })
    expect(summary.models[0]).toMatchObject({ buys: 1, scored: 0 })
    expect(summary.buyAndHoldPct).toBeNull()
  })
})

describe('what a benchmark says it will cost', () => {
  const models: AiBenchmarkCostModel[] = [
    { model: 'openai/gpt-5-mini', cached: 12, toAsk: 168, perCallCostUsd: 0.002, costBasis: 'history' },
    { model: 'anthropic/claude-sonnet-4.5', cached: 0, toAsk: 180, perCallCostUsd: 0.03, costBasis: 'pricing' }
  ]

  it('adds up what is still to ask, over the models whose price is known', () => {
    expect(benchmarkCostEstimate(models)).toEqual({ calls: 348, knownUsd: 168 * 0.002 + 180 * 0.03, unpriced: 0 })
    const withUnknown = [...models, { model: 'x/y', cached: 0, toAsk: 180, perCallCostUsd: null, costBasis: 'unknown' as const }]
    expect(benchmarkCostEstimate(withUnknown)).toMatchObject({ calls: 528, unpriced: 1 })
    // A model with nothing to ask is not an unknown cost: it costs nothing.
    const allHeld = [{ model: 'x/y', cached: 180, toAsk: 0, perCallCostUsd: null, costBasis: 'unknown' as const }]
    expect(benchmarkCostEstimate(allHeld)).toEqual({ calls: 0, knownUsd: 0, unpriced: 0 })
  })

  it('prices each model on its own line, and says where each figure came from', () => {
    const text = describeAiBenchmarkCost({ symbol: 'BTCUSDT', decisions: 180, models, budgetRemainingUsd: 10 })
    expect(text).toContain('Benchmark 180 decisions on BTCUSDT with 2 models through OpenRouter')
    expect(text).toContain('12 of the 360 answers are already cached')
    expect(text).toContain('At most 348 model calls may be made')
    expect(text).toContain('openai/gpt-5-mini: 168 calls, about $0.34 going by its recent calls here')
    expect(text).toContain('anthropic/claude-sonnet-4.5: 180 calls, about $5.40 going by its price list, an estimate')
    expect(text).toContain('About $5.74 in all.')
    expect(text).toContain("$10.00 of today's AI budget is left. If it runs out the run stops.")
    expect(text).toContain('asks only for what is missing')
    expect(text.trim().endsWith('Continue?')).toBe(true)
  })

  it('says outright when the run is expected to cost more than the budget has left', () => {
    const text = describeAiBenchmarkCost({ symbol: 'BTCUSDT', decisions: 180, models, budgetRemainingUsd: 1 })
    expect(text).toContain("$1.00 of today's AI budget is left, which is less than that: the run will stop when it runs out.")
  })

  it('names a model whose cost is not known, and keeps it out of a total that would read as the whole bill', () => {
    const unknown: AiBenchmarkCostModel = { model: 'x/y', cached: 0, toAsk: 180, perCallCostUsd: null, costBasis: 'unknown' }
    const text = describeAiBenchmarkCost({ symbol: 'ETHUSDT', decisions: 180, models: [models[0], unknown], budgetRemainingUsd: 10 })
    expect(text).toContain('x/y: 180 calls, cost not known')
    expect(text).toContain('About $0.34 for the one model with a known price; the rest is not known.')
    expect(text).not.toContain('in all.')
    const none = describeAiBenchmarkCost({ symbol: 'ETHUSDT', decisions: 180, models: [unknown], budgetRemainingUsd: 10 })
    expect(none).toContain('What that will cost in all is not known.')
  })

  it('says so when a model has nothing left to ask, and counts in the singular', () => {
    const text = describeAiBenchmarkCost({
      symbol: 'BTCUSDT',
      decisions: 1,
      models: [
        { model: 'a/held', cached: 1, toAsk: 0, perCallCostUsd: 0.002, costBasis: 'history' },
        { model: 'b/new', cached: 0, toAsk: 1, perCallCostUsd: 0.002, costBasis: 'history' }
      ],
      budgetRemainingUsd: 1
    })
    expect(text).toContain('Benchmark 1 decision on BTCUSDT with 2 models')
    expect(text).toContain('1 of the 2 answers is already cached')
    expect(text).toContain('At most 1 model call may be made')
    expect(text).toContain('a/held: nothing to ask, every answer is cached')
    expect(text).toContain('b/new: 1 call, about $0.002')
  })
})

// A route between two of a benchmark's models, worked out from the answers the benchmark already
// holds. It is the figure a route should be chosen on, so it has to be the decision the route
// would really have reached, scored on the very decisions the two models were scored on alone.
describe('a route between two of the models', () => {
  const dear = (recommendation: 'buy' | 'sell' | 'hold', confidence: number): AiSignalDecision =>
    said(recommendation, confidence, { model: 'dear', usage: { promptTokens: 1000, completionTokens: 200, costUsd: 0.02, latencyMs: 4000 } })
  const { candles, times } = market([1, -1, 1, 1])
  const answers: AiBenchmarkAnswers = {
    cheap: [said('buy', 0.8), said('buy', 0.8), said('hold', 0.9), said('buy', 0.5)],
    dear: [dear('buy', 0.9), dear('hold', 0.9), dear('buy', 0.9), dear('buy', 0.9)]
  }
  const input = { candles, times, models: ['cheap', 'dear'], answers }
  const routeBy = (when: 'acting' | 'unsure', from = input, first = 'cheap', second = 'dear') => {
    const route = summarizeBenchmarkRoutes(from, first, second).routes.find((entry) => entry.when === when)
    if (!route) throw new Error(`no ${when} route`)
    return route
  }

  it('passes on only the entries the first model wanted, and takes the second model\'s word on them', () => {
    const route = routeBy('acting')
    // The first model wanted in twice. The second agreed once.
    expect(route.escalated).toBe(2)
    expect(route.row).toMatchObject({ answered: 4, entries: 1, buys: 2, holds: 2, refused: 0 })
    expect(route.row.held).toMatchObject({ trades: 1, wins: 1 })
    // The entry it took was the winner; the one it passed up was the loser the first model took.
    expect(summarizeBenchmark(input).models[0].held).toMatchObject({ trades: 2, wins: 1 })
  })

  it('passes on only what the first model was unsure of, and lets its confident entries stand', () => {
    const route = routeBy('unsure')
    // One hesitant buy went to the second model, which was sure of it. Both confident entries
    // stood on the first model's word alone, the losing one included.
    expect(route.escalated).toBe(1)
    expect(route.row).toMatchObject({ entries: 3, buys: 3, holds: 1 })
    expect(route.row.held).toMatchObject({ trades: 3, wins: 2 })
  })

  it('costs the first model every time and the second only where the decision was passed on', () => {
    // Four first answers at $0.002, and the second model's $0.02 on the ones it was asked about.
    expect(routeBy('acting').row.costUsd).toBeCloseTo(4 * 0.002 + 2 * 0.02, 10)
    expect(routeBy('acting').row.costPerCallUsd).toBeCloseTo((4 * 0.002 + 2 * 0.02) / 4, 10)
    expect(routeBy('unsure').row.costPerCallUsd).toBeCloseTo((4 * 0.002 + 0.02) / 4, 10)
    // A passed-on decision waits for both calls, one after the other.
    expect(routeBy('acting').row.medianLatencyMs).toBe((5500 + 1500) / 2)
    expect(routeBy('unsure').row.medianLatencyMs).toBe(1500)
  })

  it('has no price at all when one of its answers has none, rather than the first model\'s price', () => {
    const unpriced: AiBenchmarkAnswers = {
      cheap: answers.cheap,
      dear: answers.dear.map((decision) => ({ ...decision, usage: { promptTokens: 1, completionTokens: 1, costUsd: null, latencyMs: 4000 } }))
    }
    const from = { ...input, answers: unpriced }
    // Left out of an average, the two unpriced decisions would make this route read $0.002 a decision.
    expect(routeBy('acting', from).row).toMatchObject({ costUsd: null, costPerCallUsd: null })
    // Nothing was passed on under this rule on a market where the first model is always sure.
    const sure = { ...from, answers: { cheap: times.map(() => said('hold', 0.9)), dear: unpriced.dear } }
    expect(routeBy('unsure', sure).row.costPerCallUsd).toBeCloseTo(0.002, 10)
  })

  it('is the first model\'s own row when nothing is passed on, and the second model\'s calls when everything is', () => {
    const quiet = { ...input, answers: { cheap: times.map(() => said('hold', 0.9)), dear: answers.dear } }
    const alone = summarizeBenchmark(quiet).models[0]
    for (const when of ['acting', 'unsure'] as const) {
      const route = routeBy(when, quiet)
      expect(route.escalated).toBe(0)
      expect({ ...route.row, model: '' }).toEqual({ ...alone, model: '' })
    }

    const eager = { ...input, answers: { cheap: times.map(() => said('buy', 0.9)), dear: answers.dear } }
    const second = summarizeBenchmark(eager).models[1]
    const route = routeBy('acting', eager)
    expect(route.escalated).toBe(4)
    expect(route.row).toMatchObject({ buys: second.buys, holds: second.holds, entries: second.entries, hits: second.hits, scored: second.scored })
    expect(route.row.held).toEqual(second.held)
  })

  it('treats an answer the validator refused as unsure, and never as a trade', () => {
    const refused = { ...input, answers: { cheap: [REFUSED, REFUSED, REFUSED, REFUSED], dear: answers.dear } }
    expect(routeBy('acting', refused)).toMatchObject({ escalated: 0, row: { refused: 4, entries: 0 } })
    expect(routeBy('unsure', refused)).toMatchObject({ escalated: 4, row: { refused: 0, entries: 3 } })
  })

  it('is drawn over the compared decisions and no others', () => {
    // The second model has not answered the last candle, so no model is scored on it -- and
    // neither is a route between them.
    const partial = { ...input, answers: { cheap: answers.cheap, dear: [dear('buy', 0.9), dear('hold', 0.9), dear('buy', 0.9), null] } }
    expect(summarizeBenchmark(partial).compared).toBe(3)
    expect(routeBy('acting', partial)).toMatchObject({ escalated: 2, row: { answered: 3, buys: 1, holds: 2 } })
    // A third model that answered only the first candle narrows it for the route as it does for them.
    const three = { ...input, models: ['cheap', 'dear', 'late'], answers: { ...answers, late: [said('hold'), null, null, null] } }
    expect(routeBy('acting', three)).toMatchObject({ escalated: 1, row: { answered: 1, entries: 1 } })
  })

  it('can be read the other way round, and is nothing for a model set beside itself or a stranger', () => {
    // The dear model first: it wanted in on three candles and the cheap one agreed on none of those
    // at the confidence a bot acts on -- except the first.
    expect(routeBy('acting', input, 'dear', 'cheap')).toMatchObject({ escalated: 3, row: { entries: 1 } })
    expect(summarizeBenchmarkRoutes(input, 'cheap', 'cheap').routes).toEqual([])
    expect(summarizeBenchmarkRoutes(input, 'cheap', 'unknown').routes).toEqual([])
    expect(summarizeBenchmarkRoutes(input, 'unknown', 'dear').routes).toEqual([])
  })
})

// A panel of agents ticked beside models. It is asked the same questions and scored by the same
// code -- it is an id like any other to everything in this file -- so what has to be pinned is the
// bill: four calls an answer, said per line and added up as calls rather than as answers.
describe('a benchmark with a panel of agents in it', () => {
  const models: AiBenchmarkCostModel[] = [
    { model: 'a/b', cached: 0, toAsk: 42, perCallCostUsd: 0.002, costBasis: 'history' },
    { model: 'panel:a/b', cached: 2, toAsk: 40, perCallCostUsd: 0.002, costBasis: 'pricing', callsPerAnswer: 4 }
  ]

  it('counts the calls a panel makes, not the answers it gives', () => {
    const estimate = benchmarkCostEstimate(models)
    expect(estimate.calls).toBe(42 + 160)
    expect(estimate.knownUsd).toBeCloseTo(42 * 0.002 + 160 * 0.002, 10)
    expect(estimate.unpriced).toBe(0)
  })

  it('names the panel as what it is and says why its count is four times its answers', () => {
    const text = describeAiBenchmarkCost({ symbol: 'BTCUSDT', decisions: 42, models, budgetRemainingUsd: 5 })
    expect(text).toContain('Benchmark 42 decisions on BTCUSDT with 1 model and 1 agent panel through OpenRouter. Each is asked the same questions.')
    expect(text).toContain('2 of the 84 answers are already cached.')
    expect(text).toContain('At most 202 model calls may be made:')
    expect(text).toContain('  a/b: 42 calls, about $0.084 going by its recent calls here')
    expect(text).toContain('  the agent panel on a/b: 160 calls (4 for each of 40 answers), about $0.32 going by its price list, an estimate')
    expect(text).toContain('About $0.40 in all.')
  })

  it('counts panels and models apart, whichever there are', () => {
    const only = describeAiBenchmarkCost({ symbol: 'BTCUSDT', decisions: 42, models: [models[1], { ...models[1], model: 'panel:c/d' }], budgetRemainingUsd: 5 })
    expect(only).toContain('with 2 agent panels through OpenRouter. Each is asked the same questions.')
    const none = describeAiBenchmarkCost({ symbol: 'BTCUSDT', decisions: 42, models: [models[0]], budgetRemainingUsd: 5 })
    expect(none).toContain('with 1 model through OpenRouter. Every model is asked the same questions.')
  })

  it('can be read as the second step of a route from its own model, for nothing', () => {
    // The model alone wanted in on three candles; its panel, asked the same three, agreed on one.
    const { candles, times } = market([1, -1, -1, 1])
    const panel = (recommendation: 'buy' | 'hold'): AiSignalDecision =>
      said(recommendation, 0.9, { model: 'panel:m', usage: { promptTokens: 4000, completionTokens: 800, costUsd: 0.008, latencyMs: 6000 } })
    const answers: AiBenchmarkAnswers = {
      m: [said('buy', 0.8), said('buy', 0.8), said('buy', 0.8), said('hold', 0.9)],
      'panel:m': [panel('buy'), panel('hold'), panel('hold'), panel('buy')]
    }
    const routed = summarizeBenchmarkRoutes({ candles, times, models: ['m', 'panel:m'], answers }, 'm', 'panel:m').routes.find((route) => route.when === 'acting')
    expect(routed).toMatchObject({ escalated: 3, row: { entries: 1 } })
    expect(routed?.row.held).toMatchObject({ trades: 1, wins: 1 })
    // One call a decision, and the panel's four on the three it was handed.
    expect(routed?.row.costPerCallUsd).toBeCloseTo((4 * 0.002 + 3 * 0.008) / 4, 10)
  })
})
