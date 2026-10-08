import { describe, expect, it } from 'vitest'
import { validateOpportunityAnswer } from '../shared/aiOpportunity'
import type { OpportunityOutcome } from '../shared/aiOpportunityOutcome'
import { GPT_MIN_CONFIDENCE } from '../shared/aiSignal'
import type { AiSignalDecision } from '../shared/aiSignal'
import type { Candle, ExecutorConfig } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import { SIGNAL_WEIGHTS, type SignalScore } from '../shared/opportunityScore'
import type { StoryReaction } from '../shared/newsFeed'
import { RESEARCH_MIN_SLICE, RESEARCH_MIN_TRADES, csvOf, figure, researchCalls, tradeStats, type ResearchInput } from '../shared/research/common'
import { EXIT_RULES, atr15m, exitCheckRow, exitRuleRows, quarterBars, trailingOutcome } from '../shared/research/exitRules'
import { ENTRY_TIMINGS, confirmingBarEnd, entryTimingRows } from '../shared/research/entryTiming'
import { holdingRows } from '../shared/research/holdingByType'
import { falseOpportunityRows } from '../shared/research/falseOpportunities'
import { excursionAnswers, excursionOf, excursionTrades } from '../shared/research/excursions'
import { newsFollowOutcome, newsTimingRows } from '../shared/research/newsTiming'
import { ablatedScore, ablationRows } from '../shared/research/scoreAblation'
import { captureSummary, missedMoves, truthMoves } from '../shared/research/captureRate'

// shared/research/*: the tables the Research tab builds over the record (the V4 document, §57-72),
// on fixtures shaped as the benchmark's: an event an hour, a path that moves three minutes in, an
// answer this app would act on. Everything is arithmetic on what is given; nothing asks or acts.

const DAY = 86_400
const T0 = Date.parse('2026-09-01T00:00:00Z') / 1000
const NOW = T0 + 60 * DAY
const M = 'openai/gpt-5-mini'

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

function answer(overrides: Record<string, unknown> = {}): AiSignalDecision {
  const verdict = validateOpportunityAnswer(
    { recommendation: 'buy', confidence: 0.8, entryMin: 99.8, entryMax: 100.2, validMinutes: 15, stopLoss: 98.5, takeProfit: 102, horizonBars: 4, marketRegime: 'bull', riskLevel: 'medium', reasonCodes: ['breakout'], rationale: '', ...overrides },
    100
  )
  if (!verdict.ok) throw new Error(verdict.reason)
  return { candleTime: 0, ...verdict.signal, model: M, cached: true, error: null, rejected: null, detail: verdict.detail, usage: { promptTokens: 4000, completionTokens: 500, costUsd: 0.003, latencyMs: 1000 } }
}
const LONG = answer()
const NONE = answer({ recommendation: 'hold', entryMin: null, entryMax: null, stopLoss: null, takeProfit: null, confidence: 0.5 })
/** A BUY with a bracket, under the confidence this app acts on anywhere: not acted on, so not a call. */
const TIMID = answer({ confidence: GPT_MIN_CONFIDENCE - 0.05 })

/** `ends.length` events, hourly, each answered BUY and each going to its end. */
function input(ends: number[], answers: (AiSignalDecision | null)[] = ends.map(() => LONG)): ResearchInput {
  const events = ends.map((_, i) => event(i))
  const bars: Record<string, Candle[]> = {}
  events.forEach((entry, i) => {
    bars[entry.id] = path(entry.time, ends[i])
  })
  return { events, models: [M], answers: { [M]: answers }, bars, nowSec: NOW }
}
const MIXED = [...Array.from({ length: 25 }, () => 103), ...Array.from({ length: 10 }, () => 97)]

describe('the common figures', () => {
  it('counts a set of outcomes from thirty closed, and says not enough below', () => {
    const outcome = (netPct: number): OpportunityOutcome => ({ status: 'closed', entryTime: 0, entryPrice: 100, exit: netPct > 0 ? 'take_profit' : 'stop_loss', exitTime: 1, exitPrice: 100 + netPct, netPct, r: netPct / 1.5, bestPct: 2, worstPct: -0.3, heldMinutes: 10 })
    const thirtyFive = Array.from({ length: 35 }, () => outcome(1.8))
    const stats = tradeStats(thirtyFive)
    expect(stats).toMatchObject({ trades: 35, closed: 35, wins: 35, winRatePct: 100, profitFactor: null, expectancyPct: expect.closeTo(1.8, 10), meanR: expect.closeTo(1.2, 10), enough: true })
    // Twenty-nine closed is one short of the line, and no figure is printed; thirty is on it. A slice's line is ten.
    expect(tradeStats(thirtyFive.slice(0, 29))).toMatchObject({ closed: 29, enough: false, winRatePct: null, profitFactor: null, expectancyPct: null, meanR: null, meanBestPct: null, meanWorstPct: null })
    expect(tradeStats(thirtyFive.slice(0, 30)).enough).toBe(true)
    expect(tradeStats(thirtyFive.slice(0, 9), RESEARCH_MIN_SLICE).enough).toBe(false)
    expect(tradeStats(thirtyFive.slice(0, 10), RESEARCH_MIN_SLICE).enough).toBe(true)
    expect(tradeStats([], RESEARCH_MIN_SLICE).enough).toBe(false)
    // A trade that made nothing is not a win; it is among the losses the profit factor divides by, adding nothing.
    const mixed = tradeStats([...thirtyFive.slice(0, 28), outcome(0), outcome(-1.8)])
    expect(mixed).toMatchObject({ closed: 30, wins: 28, enough: true })
    expect(mixed.winRatePct).toBeCloseTo((28 / 30) * 100, 10)
    expect(mixed.profitFactor).toBeCloseTo(28, 10)
    expect(figure(null)).toBe('not enough')
    expect(figure(1.234)).toBe('+1.23%')
    expect(figure(0.5, 'r')).toBe('+0.50 R')
    expect(figure(1.5, 'ratio')).toBe('1.50')
    expect(csvOf(['a', 'b'], [['x, y', 1.23456], ['"q"', null]])).toBe('a,b\n"x, y",1.2346\n"""q""",\n')
    expect(RESEARCH_MIN_TRADES).toBe(30)
  })

  it('takes every answer this app would act on as a call, and nothing else', () => {
    const calls = researchCalls(input([103, 103, 103, 103], [LONG, NONE, null, TIMID]))
    expect(calls.map((call) => call.index)).toEqual([0])
    expect(calls[0].call).toMatchObject({ side: 'long', entryMin: 99.8, entryMax: 100.2, stopLoss: 98.5, takeProfit: 102, answeredAt: event(0).time + 11 })
  })
})

describe('exit rules on identical entries', () => {
  it('builds fifteen-minute bars from whole quarters only, and an ATR from fourteen of them', () => {
    const minutes: Candle[] = []
    for (let k = 0; k < 15 * 16; k++) minutes.push({ time: T0 + k * 60, open: 100, high: 101, low: 99, close: 100, volume: 1 })
    const quarters = quarterBars(minutes)
    expect(quarters).toHaveLength(16)
    expect(quarters[0]).toMatchObject({ time: T0, high: 101, low: 99, volume: 15 })
    expect(quarterBars(minutes.slice(1))).toHaveLength(15)
    expect(atr15m(minutes, T0 + 15 * 16 * 60)).toBeCloseTo(2, 10)
    expect(atr15m(minutes.slice(0, 15 * 14), T0 + 15 * 16 * 60)).toBeNull()
  })

  it('scores the four ways out on the same calls, and counts the calls an ATR could not be read for', () => {
    const base = input(MIXED)
    const lead: Record<string, Candle[]> = {}
    base.events.forEach((entry, i) => {
      // Four hours of quarters with a range of one before every event but the first.
      if (i === 0) return
      lead[entry.id] = Array.from({ length: 240 }, (_, k) => ({ time: entry.time - 240 * 60 + k * 60, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 }))
    })
    const rows = exitRuleRows(base, lead)
    expect(rows.map((row) => row.rule)).toEqual([...EXIT_RULES])
    const plan = rows[0].stats
    expect(plan).toMatchObject({ trades: 35, closed: 35, wins: 25, enough: true })
    expect(plan.expectancyPct).toBeGreaterThan(0)
    // An ATR of one: a stop 1.5 under the entry's floor, at 98.3, is hit on the way to 97 like the plan's. The
    // first event, a winner, has no bars before it to read an ATR from.
    expect(rows[1]).toMatchObject({ rule: 'atr', unmeasured: 1 })
    expect(rows[1].stats).toMatchObject({ trades: 34, wins: 24 })
    // The time stop rides every move to the horizon: the winners make more, the losers lose more.
    expect(rows[3].stats.wins).toBe(25)
    expect(rows[3].stats.expectancyPct).toBeGreaterThan(plan.expectancyPct ?? 0)
    expect(rows[2].rule).toBe('trailing')
    expect(rows[2].stats.closed).toBe(35)
  })

  it("puts the ATR stop one and a half ATRs under the entry's floor, so a dip of one ATR and a bit is held through", () => {
    const base = input([103])
    const entry = base.events[0]
    // A dip to 98.6 in the fourth minute, then on to 103: through a stop one ATR under the floor (98.8), not one
    // and a half under it (98.3); the call's own stop at 98.5 holds too.
    base.bars[entry.id] = base.bars[entry.id].map((bar, n) => (n === 3 ? { ...bar, open: 100, high: 100, low: 98.6, close: 98.6 } : bar))
    const lead = { [entry.id]: Array.from({ length: 240 }, (_, k) => ({ time: entry.time - 240 * 60 + k * 60, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 })) }
    const rows = exitRuleRows(base, lead)
    expect(rows[0].stats).toMatchObject({ closed: 1, wins: 1 })
    expect(rows[1]).toMatchObject({ rule: 'atr', unmeasured: 0 })
    expect(rows[1].stats).toMatchObject({ closed: 1, wins: 1 })
    // Half the range before the event, half the ATR: a stop at 99.05, which the dip goes through.
    const tighter = { [entry.id]: lead[entry.id].map((bar) => ({ ...bar, high: 100.25, low: 99.75 })) }
    expect(exitRuleRows(base, tighter)[1].stats).toMatchObject({ closed: 1, wins: 0 })
  })

  it("trails: the call's stop until a percent in favour, then half a percent behind the best, and out at the horizon otherwise", () => {
    const time = T0
    // Up to 102 by the fourth minute, on to 102.5, then back to 101.9: the trail from 102.5 is at 101.9875.
    const bars: Candle[] = [
      { time, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: time + 60, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: time + 120, open: 100, high: 102, low: 100, close: 102, volume: 1 },
      { time: time + 180, open: 102, high: 102.5, low: 102, close: 102.5, volume: 1 },
      { time: time + 240, open: 102.5, high: 102.5, low: 101.9, close: 101.9, volume: 1 },
      { time: time + 300, open: 101.9, high: 101.9, low: 101.9, close: 101.9, volume: 1 }
    ]
    const call = { time, side: 'long' as const, entryMin: 99.8, entryMax: 100.2, stopLoss: 98.5, takeProfit: 110, expiresAt: time + 900, holdSeconds: 3600, answeredAt: time + 11 }
    const outcome = trailingOutcome(call, bars, NOW, { feeRate: 0.001, slippageRate: 0 })
    expect(outcome).toMatchObject({ status: 'closed', exit: 'stop_loss', exitTime: time + 240 })
    expect(outcome.exitPrice).toBeCloseTo(102.5 * 0.995, 6)
    expect(outcome.netPct).toBeCloseTo((102.5 * 0.995 - 100) - 0.1 * (1 + (102.5 * 0.995) / 100), 6)
    // Never armed: the call's own stop, and the time stop at the horizon.
    const flat = bars.map((bar) => ({ ...bar, open: 100, high: 100.5, low: 100, close: 100.4 }))
    expect(trailingOutcome(call, flat, NOW, { feeRate: 0.001, slippageRate: 0 })).toMatchObject({ status: 'open' })
    const stopped = [bars[0], bars[1], { ...bars[2], open: 100, high: 100, low: 98, close: 98 }]
    expect(trailingOutcome(call, stopped, NOW, { feeRate: 0.001, slippageRate: 0 })).toMatchObject({ exit: 'stop_loss', exitPrice: 98.5 })
  })

  it("sets the exit check's own trades beside them, as they were settled", () => {
    const trade = (id: string, exit: 'ai_exit' | 'take_profit', pnlQuote: number): ExecutorConfig =>
      ({ id, mode: 'paper', type: 'position', params: { side: 'buy', amountQuote: 100, stopLossPct: 1.5, takeProfitPct: 3 }, watch: { eventId: 'e', eventTime: 1, model: M, confidence: 0.8, result: { exit, pnlQuote, closedAt: 2 } } }) as unknown as ExecutorConfig
    const few = exitCheckRow([trade('a', 'ai_exit', 1), trade('b', 'take_profit', 2)])
    expect(few).toMatchObject({ label: 'LIVE PAPER', closedByCheck: 1, closed: 2, meanPctByCheck: null, meanPctOthers: null, enough: false })
    const many = exitCheckRow([...Array.from({ length: 30 }, (_, k) => trade(`c${k}`, 'ai_exit', 0.5)), ...Array.from({ length: 30 }, (_, k) => trade(`o${k}`, 'take_profit', 2))])
    expect(many).toMatchObject({ closedByCheck: 30, closed: 60, meanPctByCheck: 0.5, meanPctOthers: 2, enough: true })
  })
})

describe('entry timing', () => {
  it('finds the first bar that closes the way of the side', () => {
    const bars = path(T0, 103)
    expect(confirmingBarEnd(bars, T0 + 11, 'long', NOW)).toBe(T0 + 240)
    expect(confirmingBarEnd(bars, T0 + 11, 'short', NOW)).toBeNull()
    expect(confirmingBarEnd(path(T0, 97), T0 + 11, 'short', NOW)).toBe(T0 + 240)
  })

  it('enters at the answer, later, or after a confirming bar, and counts the entries the move had left behind', () => {
    const rows = entryTimingRows(input(MIXED))
    expect(rows.map((row) => row.timing)).toEqual([...ENTRY_TIMINGS])
    expect(rows[0].stats).toMatchObject({ trades: 35, closed: 35, wins: 25 })
    // Five minutes on, the path has moved three percent out of its range: every entry expires.
    expect(rows[3]).toMatchObject({ expired: 35 })
    expect(rows[3].stats.closed).toBe(0)
    // After the confirming bar the same for the twenty-five that rose: it closes outside the range. The
    // ten that fell never close a bar upward, so there is nothing to confirm them.
    expect(rows[4]).toMatchObject({ expired: 25, unconfirmed: 10 })
  })
})

describe('holding time by event type', () => {
  it('follows each event its own way and holds it for each span, ten events a slice', () => {
    const rows = holdingRows(input(MIXED))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ eventType: 'breakout', events: 35, label: 'NET' })
    // Followed up: twenty-five to 103 and ten to 97, held five minutes.
    expect(rows[0].byHold.m5).toMatchObject({ trades: 35, closed: 35, wins: 25, enough: true })
    expect(rows[0].byHold.m5.expectancyPct).toBeGreaterThan(0)
    expect(rows[0].byHold.h4.closed).toBe(0)
    const few = holdingRows(input([103, 103]))
    expect(few[0].byHold.m5.enough).toBe(false)
    // Ten events of a kind are a slice.
    expect(holdingRows(input(Array.from({ length: 10 }, () => 103)))[0].byHold.m5.enough).toBe(true)
  })
})

describe('false opportunities', () => {
  it('counts the losses among the calls this app would act on, by kind', () => {
    const rows = falseOpportunityRows(input(MIXED))
    expect(rows[0]).toMatchObject({ eventType: 'breakout', calls: 35, closed: 35, losses: 10, label: 'NET' })
    expect(rows[0].lossSharePct).toBeCloseTo((10 / 35) * 100, 10)
    expect(falseOpportunityRows(input([103, 97]))[0].lossSharePct).toBeNull()
  })
})

describe('excursions on file', () => {
  it('measures how far the price went for a side and against it', () => {
    const bars = [{ high: 101, low: 99 }, { high: 103, low: 100 }]
    expect(excursionOf(bars, 100, 'buy')).toEqual({ bestPct: expect.closeTo(3, 10), worstPct: expect.closeTo(-1, 10) })
    expect(excursionOf(bars, 100, 'sell')).toEqual({ bestPct: expect.closeTo(1, 10), worstPct: expect.closeTo(-3, 10) })
    expect(excursionOf([], 100, 'buy')).toEqual({ bestPct: 0, worstPct: 0 })
  })

  it('answers the four questions from the trades that carry excursions, thirty of them', () => {
    const trade = (id: string, pnlQuote: number, bestPct: number, worstPct: number, exit = pnlQuote > 0 ? 'take_profit' : 'stop_loss'): ExecutorConfig =>
      ({ id, mode: 'paper', type: 'position', params: { side: 'buy', amountQuote: 100, stopLossPct: 2, takeProfitPct: 3 }, watch: { eventId: 'e', eventTime: 1, model: M, confidence: 0.8, result: { exit, pnlQuote, closedAt: 2, bestPct, worstPct } } }) as unknown as ExecutorConfig
    const winners = Array.from({ length: 20 }, (_, k) => trade(`w${k}`, 3, k < 5 ? 7 : 3.5, k < 10 ? -1.2 : -0.4))
    const losers = Array.from({ length: 10 }, (_, k) => trade(`l${k}`, -2, 0.5, -2.1))
    const plain = { ...trade('p', 1, 1, -1), watch: { eventId: 'e', eventTime: 1, model: M, confidence: 0.8, result: { exit: 'take_profit', pnlQuote: 1, closedAt: 2 } } } as unknown as ExecutorConfig
    const trades = excursionTrades([...winners, ...losers, plain])
    expect(trades).toHaveLength(30)
    const answers = excursionAnswers(trades)
    expect(answers).toMatchObject({ label: 'LIVE PAPER', trades: 30, winners: 20, enough: true })
    expect(answers.winnersFellFirstPct).toBeCloseTo(50, 10)
    expect(answers.medianWinnerBestPct).toBeCloseTo(3.5, 10)
    // A stop at 1% would have cut the ten winners that fell 1.2%: their 3% each lost.
    expect(answers.halfStopWouldCut).toEqual({ share: 50, netPctLost: 30 })
    // Five of the twenty that reached their 3% target went on to 7%: a target's width further.
    expect(answers.targetCutBiggerPct).toBeCloseTo(25, 10)
    expect(excursionAnswers(trades.slice(0, 29)).winnersFellFirstPct).toBeNull()
  })
})

describe('news timing', () => {
  const PUBLISHED = T0 + 20
  const MINUTE = T0
  const reaction = (eventType: StoryReaction['eventType'], storyId = 's1'): StoryReaction => ({ storyId, ticker: 'SOL', symbol: 'SOLUSDT', eventType, publishedAt: PUBLISHED, before15mPct: 0, after: { m5: 0, m15: 0, h1: 1, h4: 1 }, volumeRatio: 1, verdict: 'CONFIRMED', pricedIn: false, measuredAt: NOW })
  /** Minutes from the story's minute on, rising a hundredth each: at 100 then, 100.01 a minute later. */
  const bars = Array.from({ length: 80 }, (_, k) => {
    const close = 100 + k * 0.01
    return { time: MINUTE + k * 60, open: close, high: close, low: close, close, volume: 1 }
  })

  it("follows a story its kind's way from the next minute, or later, and holds an hour", () => {
    const now = newsFollowOutcome(reaction('LISTING'), bars, 0, NOW)
    expect(now).toMatchObject({ status: 'closed', exit: 'time', entryTime: MINUTE + 60, exitTime: MINUTE + 3600 })
    // From 100.01 to 100.60: 0.59%, less the fees on both fills.
    expect(now?.netPct).toBeCloseTo((100.6 / 100.01 - 1) * 100 - 0.1 * (1 + 100.6 / 100.01), 6)
    expect(newsFollowOutcome(reaction('LISTING'), bars, 5, NOW)?.entryTime).toBe(MINUTE + 360)
    // A hack is followed down, and loses here; a kind with no way is not followed; bars that stop short are nothing.
    expect(newsFollowOutcome(reaction('HACK'), bars, 0, NOW)?.netPct).toBeLessThan(0)
    expect(newsFollowOutcome(reaction('MACRO'), bars, 0, NOW)).toBeNull()
    expect(newsFollowOutcome(reaction('LISTING'), bars.slice(0, 30), 0, NOW)).toBeNull()
  })

  it('tables each kind by delay, ten stories a slice', () => {
    const reactions = Array.from({ length: 10 }, (_, k) => reaction('LISTING', `s${k}`))
    const storyBars = Object.fromEntries(reactions.map((entry) => [entry.storyId, bars]))
    const rows = newsTimingRows([...reactions, reaction('MACRO', 'm1')], storyBars, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ eventType: 'LISTING', direction: 'up', stories: 10, label: 'NET' })
    expect(rows[0].byDelay[0].enough).toBe(true)
    expect(rows[0].byDelay[5].expectancyPct).toBeLessThan(rows[0].byDelay[0].expectancyPct ?? 0)
  })
})

describe('the signal score with one input left out', () => {
  const score = (values: Partial<Record<keyof typeof SIGNAL_WEIGHTS, number>>): SignalScore => {
    const parts = (Object.keys(SIGNAL_WEIGHTS) as (keyof typeof SIGNAL_WEIGHTS)[]).map((id) => {
      const value = values[id] ?? 50
      return { id, label: id, value, fact: '', weight: SIGNAL_WEIGHTS[id], points: SIGNAL_WEIGHTS[id] * value }
    })
    return { version: 'opportunity-score-v1', score: Math.round(parts.reduce((sum, part) => sum + part.points, 0)), parts, penalties: [], story: null }
  }

  it('re-weighs the other inputs to the same whole, keeping the penalties', () => {
    const even = score({})
    expect(ablatedScore(even, null)).toBeCloseTo(50, 10)
    expect(ablatedScore(even, 'news')).toBeCloseTo(50, 10)
    const newsy = score({ news: 100 })
    expect(ablatedScore(newsy, null)).toBeGreaterThan(50)
    expect(ablatedScore(newsy, 'news')).toBeCloseTo(50, 10)
    const penalised = { ...even, penalties: [{ id: 'volatility' as const, label: 'Wild bars', points: 10, fact: '' }] }
    expect(ablatedScore(penalised, 'volume')).toBeCloseTo(40, 10)
  })

  it("picks each day's three strongest under each score and follows them an hour", () => {
    // Twelve days of three events each, one event an hour from midnight: thirty-six picks a row.
    const events: MarketEvent[] = []
    const bars: Record<string, Candle[]> = {}
    const scores: Record<string, SignalScore> = {}
    for (let day = 0; day < 12; day++) {
      for (let k = 0; k < 4; k++) {
        const entry = event(day * 24 + k)
        events.push(entry)
        bars[entry.id] = path(entry.time, k === 3 ? 97 : 103)
        // The fourth event each day scores highest on news alone: without the news it drops out.
        scores[entry.id] = score(k === 3 ? { news: 100, volume: 10 } : { news: 40, volume: 90 })
      }
    }
    const base: ResearchInput = { events, models: [M], answers: { [M]: events.map(() => LONG) }, bars, nowSec: NOW }
    const rows = ablationRows(base, scores)
    expect(rows.map((row) => row.name)).toEqual(['Everything', 'Everything − volume', 'Everything − breakout', 'Everything − liquidity', 'Everything − news', 'Everything − regime', 'Everything − models'])
    expect(rows[0]).toMatchObject({ days: 12, picks: 36 })
    expect(rows[0].stats.enough).toBe(true)
    // With everything, the news-only event is among each day's three and loses; without the news it is not.
    expect(rows[0].stats.wins).toBe(24)
    expect(rows[4].stats.wins).toBe(36)
    expect(rows[4].stats.expectancyPct).toBeGreaterThan(rows[0].stats.expectancyPct ?? 0)
  })
})

describe('capture and misses', () => {
  const scanned = [event(0, { returnsPct: { m1: 0, m5: 1, m15: 3.2, h1: 3, h4: 3 } }), event(1, { returnsPct: { m1: 0, m5: 1, m15: -3.5, h1: -3, h4: -3 } }), event(2, { returnsPct: { m1: 0, m5: 1, m15: 2.9, h1: 3, h4: 3 } })]
  const raised = [event(0, { id: 'live-0', time: event(0).time + 300 }), event(5)]

  it('keeps the moves of three percent or more, matched to what was raised live within fifteen minutes and to what was asked', () => {
    const moves = truthMoves(scanned, raised, new Set(['live-0']))
    expect(moves.map((move) => [move.symbol, move.m15Pct, move.direction, move.raisedBy, move.asked])).toEqual([
      ['SOLUSDT', -3.5, 'down', null, false],
      ['SOLUSDT', 3.2, 'up', 'live-0', true]
    ])
  })

  it('sums recall and decision precision, and lists the misses with what followed where the bars were read', () => {
    const moves = truthMoves(scanned, raised, new Set(['live-0']))
    const summary = captureSummary(moves, input(MIXED))
    expect(summary).toMatchObject({ moves: 2, raised: 1, asked: 1, recallPct: 50, closedAnswers: 35, label: 'NET' })
    expect(summary.decisionPrecisionPct).toBeCloseTo((25 / 35) * 100, 10)
    const missed = missedMoves(moves, { [`SOLUSDT:${event(1).time}`]: path(event(1).time, 97) }, NOW)
    expect(missed).toHaveLength(1)
    expect(missed[0]).toMatchObject({ why: 'never raised', direction: 'down' })
    // Followed down to 97 for an hour: a gain, less costs.
    expect(missed[0].followedNetPct).toBeGreaterThan(2.5)
    expect(missedMoves(moves, {}, NOW)[0].followedNetPct).toBeNull()
  })
})
