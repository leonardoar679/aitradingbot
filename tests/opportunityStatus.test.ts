import { describe, expect, it } from 'vitest'
import { OPPORTUNITY_STATUSES, describeOpportunityStatus, opportunityStatusOf, type OpportunityStatusInput } from '../shared/opportunityStatus'
import { levelReadings, usualMoveOf } from '../shared/planReadings'

// ONE STATUS, AND THE LEVELS READ (shared/opportunityStatus.ts, shared/planReadings.ts; the V5
// document, §42 and §55; V5 Stage 6).

const input = (over: Partial<OpportunityStatusInput> = {}): OpportunityStatusInput => ({
  answered: 2,
  asking: false,
  feed: 'valid',
  live: 'enterable',
  liveReasons: [],
  refused: false,
  traded: false,
  ...over
})

describe('the status', () => {
  it("is executed whatever else is true once a paper trade of the app's own is, or was, open on it", () => {
    expect(opportunityStatusOf(input({ traded: true, feed: 'open', asking: true }))).toBe('executed')
    expect(opportunityStatusOf(input({ traded: true, feed: 'expired', live: null, answered: 0 }))).toBe('executed')
  })

  it('is missed when the price came into the range and the app opened nothing, refused or not', () => {
    // The feed scores the answer as a trade that ran; none of the app's own is on the event.
    expect(opportunityStatusOf(input({ feed: 'open', live: null, refused: true }))).toBe('missed')
    expect(opportunityStatusOf(input({ feed: 'closed', live: null, refused: false }))).toBe('missed')
  })

  it('is analysing with a call in the air, discovered with nothing answered, and no trade when the models would not act', () => {
    expect(opportunityStatusOf(input({ asking: true, answered: 0, feed: 'waiting', live: null }))).toBe('analysing')
    expect(opportunityStatusOf(input({ asking: true, answered: 1, feed: 'valid' }))).toBe('analysing')
    expect(opportunityStatusOf(input({ answered: 0, feed: 'waiting', live: null }))).toBe('discovered')
    expect(opportunityStatusOf(input({ feed: 'asked', live: null }))).toBe('no_trade')
  })

  it('is missed when the entry ran out behind a refusal, and expired when the price never came', () => {
    expect(opportunityStatusOf(input({ feed: 'expired', live: null, refused: true }))).toBe('missed')
    expect(opportunityStatusOf(input({ feed: 'expired', live: null, refused: false }))).toBe('expired')
  })

  it('is ready at the live price inside the range, qualified while waiting for it or before the stream is read, and ended by the live check', () => {
    expect(opportunityStatusOf(input({ live: 'enterable' }))).toBe('ready')
    expect(opportunityStatusOf(input({ live: 'waiting' }))).toBe('qualified')
    expect(opportunityStatusOf(input({ live: null }))).toBe('qualified')
    expect(opportunityStatusOf(input({ feed: null, live: null }))).toBe('qualified')
    expect(opportunityStatusOf(input({ live: 'invalidated', liveReasons: ['its entry expired at 12:15 UTC'] }))).toBe('expired')
    expect(opportunityStatusOf(input({ live: 'invalidated', liveReasons: ['Bitcoin fell 1.20% since the event'] }))).toBe('invalidated')
    expect(opportunityStatusOf(input({ live: 'invalidated', liveReasons: ['the spread is 0.150%, over the 0.1% a trade is entered at'] }))).toBe('invalidated')
  })

  it('has nine words, each with a tone and a line', () => {
    expect(OPPORTUNITY_STATUSES).toHaveLength(9)
    for (const status of OPPORTUNITY_STATUSES) {
      const shown = describeOpportunityStatus(status)
      expect(shown.word).toBe(status === 'no_trade' ? 'NO TRADE' : status.toUpperCase())
      expect(shown.detail.length).toBeGreaterThan(10)
    }
    expect(describeOpportunityStatus('ready').tone).toBe('up')
    expect(describeOpportunityStatus('missed').tone).toBe('down')
  })
})

describe('the levels read against the record', () => {
  const event = { price: 100, returnsPct: { m1: 0.2, m5: 1, m15: 3, h1: 3, h4: 3 }, moveSigmas: 6 }

  it('reads the usual fifteen-minute move from the move and how many of them it was', () => {
    expect(usualMoveOf(event)).toBeCloseTo(0.5, 10)
    expect(usualMoveOf({ ...event, moveSigmas: 0 })).toBeNull()
    expect(usualMoveOf({ ...event, returnsPct: { ...event.returnsPct, m15: -3 } })).toBeCloseTo(0.5, 10)
  })

  it('says where the entry sits, how far the stop and the target are in percent, in usual moves and in R', () => {
    const read = levelReadings({ event, side: 'buy', entryMin: 99.8, entryMax: 100.2, stopLoss: 98.5, takeProfit: 103, livePrice: 100.1 })
    expect(read.entry).toBe("Between 99.8 and 100.2, 0.40% wide, its middle +0.00% from the event's price 100; the live price 100.1 is inside it.")
    expect(read.stopPct).toBeCloseTo(1.5, 10)
    expect(read.stop).toBe("98.5: 1.50% below the entry's middle, 3.0 of its usual fifteen-minute moves.")
    expect(read.targetPct).toBeCloseTo(3, 10)
    expect(read.rewardToRisk).toBeCloseTo(2, 10)
    expect(read.target).toBe("103: 3.00% above the entry's middle, 6.0 of its usual fifteen-minute moves, 2.0 R against the stop.")
  })

  it('says a price under or over the range, a short the other way up, and nothing it cannot read', () => {
    const under = levelReadings({ event, side: 'sell', entryMin: 99.8, entryMax: 100.2, stopLoss: 101.5, takeProfit: 97, livePrice: 99 })
    expect(under.entry).toContain('the live price 99 is 0.80% under it')
    expect(under.stop).toBe("101.5: 1.50% above the entry's middle, 3.0 of its usual fifteen-minute moves.")
    expect(under.target).toContain('below the entry\'s middle')
    const over = levelReadings({ event, side: 'buy', entryMin: 99.8, entryMax: 100.2, stopLoss: null, takeProfit: null, livePrice: 101 })
    expect(over.entry).toContain('the live price 101 is 0.80% over it')
    expect(over.stop).toBe('No stop named.')
    expect(over.target).toBe('No target named.')
    expect(over.rewardToRisk).toBeNull()
    const unread = levelReadings({ event: { ...event, moveSigmas: 0 }, side: 'buy', entryMin: 99.8, entryMax: 100.2, stopLoss: 98.5, takeProfit: 103, livePrice: null })
    expect(unread.entry).toContain('the live price is not read yet')
    expect(unread.stop).toBe("98.5: 1.50% below the entry's middle.")
    expect(unread.usualMovePct).toBeNull()
  })
})
