import { describe, expect, it } from 'vitest'
import { validateOpportunityAnswer } from '../shared/aiOpportunity'
import {
  REPLAY_ASK_DELAY_SEC,
  dailyQuoteVolumeOf,
  describeLiquidityTier,
  liquidityTierOf,
  opportunityCallOf,
  replayAnsweredAt,
  scoreOpportunity,
  slippageRateFor,
  slippageRateForEvent,
  type OpportunityCall,
  type OpportunityCosts
} from '../shared/aiOpportunityOutcome'
import type { AiSignalDecision } from '../shared/aiSignal'
import { FEE_RATE, SLIPPAGE_RATE } from '../shared/fees'
import type { Candle } from '../shared/ipc'

const T = Date.parse('2026-09-10T12:00:00Z') / 1000
const LATER = T + 10 * 86_400
const FREE: OpportunityCosts = { feeRate: 0, slippageRate: 0 }

/** A long around 100: in at 99.8 to 100.2 for fifteen minutes, wrong at 98.5, done at 103, held
 * an hour at most, answered twenty seconds after the event. */
function long(overrides: Partial<OpportunityCall> = {}): OpportunityCall {
  return { time: T, side: 'long', entryMin: 99.8, entryMax: 100.2, stopLoss: 98.5, takeProfit: 103, expiresAt: T + 900, holdSeconds: 3600, answeredAt: T + 20, ...overrides }
}

function short(overrides: Partial<OpportunityCall> = {}): OpportunityCall {
  return long({ side: 'short', stopLoss: 101.5, takeProfit: 97, ...overrides })
}

/** Minute n after the event: [open, high, low, close]. Minutes not given are flat at `flat`. */
function minutes(given: Record<number, [number, number, number, number]>, count = 80, flat = 100): Candle[] {
  return Array.from({ length: count }, (_, n) => {
    const [open, high, low, close] = given[n] ?? [flat, flat, flat, flat]
    return { time: T + n * 60, open, high, low, close, volume: 1 }
  })
}

describe('scoreOpportunity: the entry', () => {
  it('fills at the open of the first bar after the answer, when that open is inside the range', () => {
    const outcome = scoreOpportunity(long(), minutes({ 1: [100.1, 100.3, 100, 100.2], 5: [100.2, 103.5, 100.1, 103.2] }), LATER, FREE)
    expect(outcome).toMatchObject({ status: 'closed', entryTime: T + 60, entryPrice: 100.1, exit: 'take_profit', exitTime: T + 300, exitPrice: 103 })
    expect(outcome.netPct).toBeCloseTo((103 / 100.1 - 1) * 100, 10)
    expect(outcome.heldMinutes).toBe(5)
  })

  it('cannot use the bar that opened before the answer arrived, whatever that bar did', () => {
    // The event's own minute runs straight to the target. The answer came twenty seconds into it.
    const outcome = scoreOpportunity(long(), minutes({ 0: [100, 104, 100, 103.5] }, 80, 103.5), LATER, FREE)
    // After it the price is at 103.5, above the range for the whole fifteen minutes.
    expect(outcome.status).toBe('expired')
  })

  it('makes a slower model enter later', () => {
    const bars = minutes({ 1: [100, 100, 100, 100], 2: [100.15, 100.15, 100.1, 100.1] })
    expect(scoreOpportunity(long({ answeredAt: T + 20 }), bars, LATER, FREE).entryTime).toBe(T + 60)
    const slow = scoreOpportunity(long({ answeredAt: T + 95 }), bars, LATER, FREE)
    expect(slow.entryTime).toBe(T + 120)
    expect(slow.entryPrice).toBe(100.15)
    // An answer that lands exactly on a minute can use that minute.
    expect(scoreOpportunity(long({ answeredAt: T + 120 }), bars, LATER, FREE).entryTime).toBe(T + 120)
  })

  it('fills at the nearer edge when the bar opens outside the range and trades into it', () => {
    const above = scoreOpportunity(long(), minutes({ 1: [100.6, 100.7, 100.1, 100.4] }, 80, 100.4), LATER, FREE)
    expect(above).toMatchObject({ entryTime: T + 60, entryPrice: 100.2 })
    const below = scoreOpportunity(long(), minutes({ 1: [99.5, 99.9, 99.4, 99.9] }, 80, 99.9), LATER, FREE)
    expect(below).toMatchObject({ entryTime: T + 60, entryPrice: 99.8 })
  })

  it('waits while the range is still valid, and expires when it is not', () => {
    const away = minutes({}, 80, 101)
    expect(scoreOpportunity(long(), away, T + 600, FREE).status).toBe('waiting')
    expect(scoreOpportunity(long(), away, T + 900, FREE)).toMatchObject({ status: 'expired', entryTime: null, netPct: null })
  })

  it('does not call an entry expired on candles that stop short of its expiry', () => {
    // Long after, with no candles at all: a fetch that failed says nothing about the price.
    expect(scoreOpportunity(long(), [], LATER, FREE).status).toBe('waiting')
    // Ten minutes of candles for a fifteen-minute entry: it may have filled in the other five.
    expect(scoreOpportunity(long(), minutes({}, 10, 101), LATER, FREE).status).toBe('waiting')
    // Fifteen minutes of them, none in range: now it is known.
    expect(scoreOpportunity(long(), minutes({}, 15, 101), LATER, FREE).status).toBe('expired')
    // An answer that arrived after its own entry had expired never could be taken.
    expect(scoreOpportunity(long({ answeredAt: T + 2000 }), minutes({}, 80), LATER, FREE).status).toBe('expired')
  })

  it('does not enter on a touch that comes after the entry expired', () => {
    // Fifteen minutes at 101, then back into the range in the sixteenth.
    const late = minutes({ 15: [100.1, 100.2, 100, 100.1] }, 80, 101)
    expect(scoreOpportunity(long(), late, LATER, FREE).status).toBe('expired')
    // The same touch one minute earlier is taken.
    const inTime = minutes({ 14: [100.1, 100.2, 100, 100.1] }, 80, 101)
    expect(scoreOpportunity(long(), inTime, LATER, FREE).entryTime).toBe(T + 14 * 60)
  })

  it('reads no bar that is still forming', () => {
    const bars = minutes({ 1: [100.1, 100.2, 100, 100.1] })
    // At T+119 the bar that opened at T+60 has not closed.
    expect(scoreOpportunity(long(), bars, T + 119, FREE).status).toBe('waiting')
    expect(scoreOpportunity(long(), bars, T + 120, FREE).status).toBe('open')
  })

  it('ignores bars from before the event', () => {
    const before = [{ time: T - 60, open: 100, high: 104, low: 98, close: 100, volume: 1 }, ...minutes({}, 80, 101)]
    expect(scoreOpportunity(long(), before, LATER, FREE).status).toBe('expired')
  })
})

describe('scoreOpportunity: the exit', () => {
  it('counts a bar that touches both levels as the stop', () => {
    const outcome = scoreOpportunity(long(), minutes({ 3: [100, 103.5, 98, 100] }), LATER, FREE)
    expect(outcome).toMatchObject({ exit: 'stop_loss', exitPrice: 98.5, exitTime: T + 180 })
    expect(outcome.netPct).toBeCloseTo((98.5 / 100 - 1) * 100, 10)
  })

  it('fills a stop at the open of a bar that opens beyond it', () => {
    const outcome = scoreOpportunity(long(), minutes({ 3: [97, 97.5, 96.8, 97.2] }), LATER, FREE)
    expect(outcome).toMatchObject({ exit: 'stop_loss', exitPrice: 97 })
  })

  it('pays only the target when a bar opens beyond it', () => {
    const outcome = scoreOpportunity(long(), minutes({ 3: [104, 104.5, 103.8, 104.2] }), LATER, FREE)
    expect(outcome).toMatchObject({ exit: 'take_profit', exitPrice: 103 })
  })

  it('does not credit a target reached in the bar an edge entry filled in', () => {
    // Opens above the range, dips into it, and prints the target in the same minute: which came
    // first is not in the candle.
    const bars = minutes({ 1: [100.6, 103.2, 100.1, 100.4] }, 80, 100.4)
    const outcome = scoreOpportunity(long(), bars, LATER, FREE)
    expect(outcome.entryPrice).toBe(100.2)
    expect(outcome.exit).toBe('time')
    // Entered at the open, the same bar's target counts: the high came after the fill.
    const atOpen = scoreOpportunity(long(), minutes({ 1: [100.1, 103.2, 100, 100.4] }, 80, 100.4), LATER, FREE)
    expect(atOpen).toMatchObject({ exit: 'take_profit', exitTime: T + 60 })
  })

  it('stops an edge entry on the bar it filled in, when that bar went through the stop', () => {
    const outcome = scoreOpportunity(long(), minutes({ 1: [100.6, 100.7, 98.2, 99] }, 80, 99), LATER, FREE)
    expect(outcome).toMatchObject({ entryPrice: 100.2, exit: 'stop_loss', exitPrice: 98.5, exitTime: T + 60 })
  })

  it('leaves at the close when the holding time runs out', () => {
    // In at minute 1 with an hour to hold: out at the close of the minute that ends the hour.
    const bars = minutes({ 60: [100, 100.6, 99.9, 100.5] })
    const outcome = scoreOpportunity(long(), bars, LATER, FREE)
    expect(outcome).toMatchObject({ exit: 'time', exitTime: T + 60 * 60, exitPrice: 100.5, heldMinutes: 60 })
    expect(outcome.netPct).toBeCloseTo(0.5, 10)
  })

  it('is still open when the candles run out before anything ends it', () => {
    const outcome = scoreOpportunity(long(), minutes({ 2: [100, 100.9, 99.4, 100] }, 10), LATER, FREE)
    expect(outcome).toMatchObject({ status: 'open', entryTime: T + 60, exit: null, netPct: null })
    expect(outcome.bestPct).toBeCloseTo(0.9, 10)
    expect(outcome.worstPct).toBeCloseTo(-0.6, 10)
  })

  it('reports how far it went each way while it was held', () => {
    const outcome = scoreOpportunity(long(), minutes({ 2: [100, 101.5, 99.2, 100], 6: [100, 103.4, 100, 103.1] }), LATER, FREE)
    expect(outcome.exit).toBe('take_profit')
    expect(outcome.bestPct).toBeCloseTo(3, 10)
    expect(outcome.worstPct).toBeCloseTo(-0.8, 10)
  })
})

describe('scoreOpportunity: a short is the same walk, mirrored', () => {
  it('earns from a fall to its target', () => {
    const outcome = scoreOpportunity(short(), minutes({ 4: [100, 100.1, 96.5, 96.8] }), LATER, FREE)
    expect(outcome).toMatchObject({ status: 'closed', entryPrice: 100, exit: 'take_profit', exitPrice: 97 })
    expect(outcome.netPct).toBeCloseTo(3, 10)
    expect(outcome.bestPct).toBeCloseTo(3, 10)
  })

  it('is stopped by a rise, and a bar touching both levels is the stop', () => {
    expect(scoreOpportunity(short(), minutes({ 4: [100, 101.8, 99.9, 101.6] }), LATER, FREE)).toMatchObject({ exit: 'stop_loss', exitPrice: 101.5 })
    const both = scoreOpportunity(short(), minutes({ 4: [100, 102, 96, 100] }), LATER, FREE)
    expect(both.exit).toBe('stop_loss')
    expect(both.netPct).toBeCloseTo(-1.5, 10)
    // A bar opening above the stop fills there.
    expect(scoreOpportunity(short(), minutes({ 4: [103, 103.2, 102.8, 103] }), LATER, FREE).exitPrice).toBe(103)
  })

  it('fills at the nearer edge from either side', () => {
    expect(scoreOpportunity(short(), minutes({ 1: [99.4, 99.9, 99.3, 99.5] }, 80, 99.5), LATER, FREE).entryPrice).toBe(99.8)
    expect(scoreOpportunity(short(), minutes({ 1: [100.6, 100.7, 100.1, 100.5] }, 80, 100.5), LATER, FREE).entryPrice).toBe(100.2)
  })
})

describe('scoreOpportunity: costs', () => {
  it('pays slippage on the entry and on a stop or a timed exit, and none on a target', () => {
    const costs: OpportunityCosts = { feeRate: 0, slippageRate: 0.001 }
    const target = scoreOpportunity(long(), minutes({ 5: [100, 103.5, 100, 103.2] }), LATER, costs)
    expect(target.entryPrice).toBeCloseTo(100.1, 10)
    expect(target.exitPrice).toBe(103)
    const stop = scoreOpportunity(long(), minutes({ 5: [100, 100, 98, 98.2] }), LATER, costs)
    expect(stop.exitPrice).toBeCloseTo(98.5 * 0.999, 10)
    const timed = scoreOpportunity(long(), minutes({}), LATER, costs)
    expect(timed.exitPrice).toBeCloseTo(100 * 0.999, 10)
    // A short sells lower to get in and buys higher to get out.
    const shorted = scoreOpportunity(short(), minutes({ 5: [100, 102, 100, 101.8] }), LATER, costs)
    expect(shorted.entryPrice).toBeCloseTo(99.9, 10)
    expect(shorted.exitPrice).toBeCloseTo(101.5 * 1.001, 10)
  })

  it('charges the fee on both fills', () => {
    const costs: OpportunityCosts = { feeRate: 0.001, slippageRate: 0 }
    const outcome = scoreOpportunity(long(), minutes({ 5: [100, 103.5, 100, 103.2] }), LATER, costs)
    expect(outcome.netPct).toBeCloseTo(3 - 0.1 * (1 + 1.03), 10)
  })

  it('loses a round trip on a trade that goes nowhere, at the usual costs', () => {
    const outcome = scoreOpportunity(long(), minutes({}), LATER)
    expect(outcome.exit).toBe('time')
    expect(outcome.netPct).toBeCloseTo(-(FEE_RATE * 2 + SLIPPAGE_RATE * 2) * 100, 2)
  })
})

describe('the pieces around it', () => {
  it('charges more slippage on a thinner pair, and the middle rate when it does not know', () => {
    expect(slippageRateFor(200_000_000)).toBe(SLIPPAGE_RATE)
    expect(slippageRateFor(50_000_000)).toBe(SLIPPAGE_RATE)
    expect(slippageRateFor(20_000_000)).toBe(SLIPPAGE_RATE * 2.5)
    expect(slippageRateFor(1_000_000)).toBe(SLIPPAGE_RATE * 5)
    expect(slippageRateFor(null)).toBe(SLIPPAGE_RATE * 2.5)
  })

  it('names how much a pair trades by the same two lines', () => {
    expect([200_000_000, 50_000_000, 49_999_999, 5_000_000, 4_999_999, 0].map(liquidityTierOf)).toEqual(['deep', 'deep', 'middle', 'middle', 'thin', 'thin'])
    expect([null, undefined, NaN, Infinity].map(liquidityTierOf)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    // The line between two rates of slippage is the line between two tiers.
    for (const volume of [50_000_000, 49_999_999, 5_000_000, 4_999_999]) {
      const sameRate = (other: number): boolean => slippageRateFor(other) === slippageRateFor(volume)
      const sameTier = (other: number): boolean => liquidityTierOf(other) === liquidityTierOf(volume)
      for (const other of [200_000_000, 20_000_000, 1_000_000]) expect(sameTier(other)).toBe(sameRate(other))
    }
    expect(describeLiquidityTier('deep')).toBe('$50M a day or more')
    expect(describeLiquidityTier('unknown')).toBe('not known')
  })

  it('charges a live event half the spread the scanner saw, when that is more than the rate for its liquidity', () => {
    const live = (spreadPct: number | null, quoteVolume24h: number | null = 200_000_000): Parameters<typeof slippageRateForEvent>[0] => ({
      live: { detectedAt: T + 8, quoteVolume24h, spreadPct, candidateScore: 90, rank: 1 }
    })
    // Half of a hundredth of a percent is less than the rate; half of half a percent is not.
    expect(slippageRateForEvent(live(0.01))).toBe(SLIPPAGE_RATE)
    expect(slippageRateForEvent(live(0.5))).toBeCloseTo(0.0025, 12)
    // A book with a side missing says nothing, and neither does a spread that is not a number.
    expect(slippageRateForEvent(live(null))).toBe(SLIPPAGE_RATE)
    expect(slippageRateForEvent(live(Number.NaN))).toBe(SLIPPAGE_RATE)
    expect(slippageRateForEvent(live(0.01, 1_000_000))).toBe(SLIPPAGE_RATE * 5)
    expect(slippageRateForEvent(live(0.01, null))).toBe(SLIPPAGE_RATE * 2.5)
    // An event found in history has no book: the rate for what its own candles say it traded.
    expect(slippageRateForEvent({ live: null })).toBe(SLIPPAGE_RATE * 2.5)
    expect(slippageRateForEvent({ live: null }, 200_000_000)).toBe(SLIPPAGE_RATE)
    // Where the candles' figure is given, it is the one used.
    expect(slippageRateForEvent(live(0.01, 200_000_000), 1_000_000)).toBe(SLIPPAGE_RATE * 5)
  })

  it("scales a window's traded value to a day", () => {
    const halfDay = Array.from({ length: 720 }, (_, i) => ({ time: T + i * 60, open: 10, high: 10, low: 10, close: 10, volume: 100 }))
    expect(dailyQuoteVolumeOf(halfDay)).toBeCloseTo(100 * 10 * 1440, 6)
    expect(dailyQuoteVolumeOf([])).toBeNull()
  })

  it('takes a replayed answer to have arrived after the ask delay and the time the model took', () => {
    expect(replayAnsweredAt(T, 14_000)).toBe(T + REPLAY_ASK_DELAY_SEC + 14)
    expect(replayAnsweredAt(T, null)).toBe(T + REPLAY_ASK_DELAY_SEC)
  })

  it('turns a recommendation into the call it makes, and no trade into none', () => {
    const made = (overrides: Record<string, unknown>): AiSignalDecision => {
      const verdict = validateOpportunityAnswer(
        {
          recommendation: 'sell',
          confidence: 0.7,
          entryMin: 99.8,
          entryMax: 100.2,
          validMinutes: 30,
          stopLoss: 101.5,
          takeProfit: 97,
          horizonBars: 16,
          marketRegime: 'bear',
          riskLevel: 'high',
          reasonCodes: ['breakdown'],
          rationale: '',
          ...overrides
        },
        100
      )
      if (!verdict.ok) throw new Error(verdict.reason)
      return { candleTime: T, ...verdict.signal, model: 'a/model', cached: false, error: null, rejected: null, detail: verdict.detail }
    }
    expect(opportunityCallOf(T, made({}), T + 12)).toEqual({
      time: T,
      side: 'short',
      entryMin: 99.8,
      entryMax: 100.2,
      stopLoss: 101.5,
      takeProfit: 97,
      expiresAt: T + 30 * 60,
      holdSeconds: 16 * 900,
      answeredAt: T + 12
    })
    expect(opportunityCallOf(T, made({ recommendation: 'hold', entryMin: null, entryMax: null, stopLoss: null, takeProfit: null }), T + 12)).toBeNull()
    expect(opportunityCallOf(T, { ...made({}), rejected: 'refused' }, T + 12)).toBeNull()
    expect(opportunityCallOf(T, null, T + 12)).toBeNull()
  })
})

describe('scoreOpportunity: in R', () => {
  const COSTS: OpportunityCosts = { feeRate: FEE_RATE, slippageRate: SLIPPAGE_RATE }

  it('is -1 at the call\'s own stop, on either side, whatever the costs', () => {
    for (const costs of [FREE, COSTS, { feeRate: 0.002, slippageRate: 0.003 }]) {
      const stopped = scoreOpportunity(long(), minutes({ 1: [100, 100.1, 99.9, 100], 3: [99.5, 99.6, 98.4, 98.6] }), LATER, costs)
      expect(stopped).toMatchObject({ status: 'closed', exit: 'stop_loss' })
      expect(stopped.r).toBeCloseTo(-1, 10)
      const covered = scoreOpportunity(short(), minutes({ 1: [100, 100.1, 99.9, 100], 3: [100.5, 101.6, 100.4, 101.4] }), LATER, costs)
      expect(covered).toMatchObject({ status: 'closed', exit: 'stop_loss' })
      expect(covered.r).toBeCloseTo(-1, 10)
    }
  })

  it('is worse than -1 when the stop is gapped through, and the net over the stop\'s loss at the target', () => {
    const gapped = scoreOpportunity(long(), minutes({ 1: [100, 100.1, 99.9, 100], 3: [97, 97.5, 96.8, 97.2] }), LATER, FREE)
    expect(gapped).toMatchObject({ exit: 'stop_loss', exitPrice: 97 })
    // In at 100, stopped at 97 where the stop was 98.5: 3% lost against 1.5% allowed.
    expect(gapped.r).toBeCloseTo(-2, 10)
    const won = scoreOpportunity(long(), minutes({ 1: [100, 100.1, 99.9, 100], 4: [100.5, 103.2, 100.4, 103.1] }), LATER, FREE)
    expect(won).toMatchObject({ exit: 'take_profit', exitPrice: 103 })
    // +3% against the 1.5% its stop allowed.
    expect(won.r).toBeCloseTo(2, 10)
    // With costs, the target's net shrinks and the stop's loss grows: R falls on both counts.
    const costly = scoreOpportunity(long(), minutes({ 1: [100, 100.1, 99.9, 100], 4: [100.5, 103.2, 100.4, 103.1] }), LATER, COSTS)
    expect(costly.r).toBeLessThan(2)
    expect(costly.r).toBeCloseTo((costly.netPct as number) / -(((98.5 * (1 - SLIPPAGE_RATE)) / (costly.entryPrice as number) - 1) * 100 - FEE_RATE * (1 + (98.5 * (1 - SLIPPAGE_RATE)) / (costly.entryPrice as number)) * 100), 10)
  })

  it('is nothing until the call has closed', () => {
    expect(scoreOpportunity(long(), minutes({}, 80, 103.5), LATER, FREE)).toMatchObject({ status: 'expired', r: null })
    expect(scoreOpportunity(long(), minutes({ 1: [100, 100.1, 99.9, 100] }, 3), T + 3 * 60, FREE)).toMatchObject({ status: 'open', r: null })
  })
})
