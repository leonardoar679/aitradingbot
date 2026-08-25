import { describe, expect, it } from 'vitest'
import {
  MAINTENANCE_MARGIN_RATE,
  MAX_LEVERAGE,
  fundingCost,
  fundingPeriodsBetween,
  isUsableLeverage,
  liquidationDistancePct,
  liquidationPrice,
  notionalFor
} from '../shared/perp'

// Leverage is the fastest way a beginner loses everything, so the numbers this app shows about it
// have to be right in the direction that protects them: a liquidation price shown as further away
// than it really is, or a funding cost shown as smaller, teaches exactly the wrong lesson.

describe('isUsableLeverage', () => {
  it('accepts 1, which is spot', () => {
    expect(isUsableLeverage(1)).toBe(true)
  })

  it('rejects anything below 1 — a position cannot be less than the money in it', () => {
    expect(isUsableLeverage(0)).toBe(false)
    expect(isUsableLeverage(0.5)).toBe(false)
    expect(isUsableLeverage(-10)).toBe(false)
  })

  it('rejects a non-number, which would otherwise pass every comparison downstream', () => {
    // The recurring failure in this app: NaN loses every comparison, so a check written the
    // obvious way lets it through rather than catching it.
    expect(isUsableLeverage(Number.NaN)).toBe(false)
    expect(isUsableLeverage(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('rejects leverage past the cap', () => {
    expect(isUsableLeverage(MAX_LEVERAGE)).toBe(true)
    expect(isUsableLeverage(MAX_LEVERAGE + 1)).toBe(false)
  })
})

describe('notionalFor', () => {
  it('is what the position controls, not what it cost', () => {
    // The distinction every risk limit in this app currently misses: 25 at 10x is 250 of BTC.
    expect(notionalFor(25, 10)).toBe(250)
  })

  it('is the margin itself at 1x', () => {
    expect(notionalFor(25, 1)).toBe(25)
  })
})

describe('liquidationPrice', () => {
  it('is below the entry for a long and above it for a short', () => {
    const long = liquidationPrice({ entryPrice: 60_000, leverage: 10, side: 'buy' })!
    const short = liquidationPrice({ entryPrice: 60_000, leverage: 10, side: 'sell' })!

    expect(long).toBeLessThan(60_000)
    expect(short).toBeGreaterThan(60_000)
  })

  it('matches the isolated-margin formula', () => {
    // Pinned against the arithmetic rather than a remembered number, so a change to the
    // maintenance rate cannot silently move it.
    expect(liquidationPrice({ entryPrice: 60_000, leverage: 10, side: 'buy' })).toBeCloseTo(
      60_000 * (1 - 1 / 10 + MAINTENANCE_MARGIN_RATE),
      6
    )
    expect(liquidationPrice({ entryPrice: 60_000, leverage: 10, side: 'sell' })).toBeCloseTo(
      60_000 * (1 + 1 / 10 - MAINTENANCE_MARGIN_RATE),
      6
    )
  })

  it('moves closer to the entry as leverage rises', () => {
    // The whole lesson, in one assertion.
    const at5 = liquidationPrice({ entryPrice: 60_000, leverage: 5, side: 'buy' })!
    const at20 = liquidationPrice({ entryPrice: 60_000, leverage: 20, side: 'buy' })!
    const at100 = liquidationPrice({ entryPrice: 60_000, leverage: 100, side: 'buy' })!

    expect(at20).toBeGreaterThan(at5)
    expect(at100).toBeGreaterThan(at20)
    expect(60_000 - at100).toBeLessThan(60_000 * 0.01)
  })

  it('liquidates no later than the naive 100/L figure, never later', () => {
    // The maintenance margin makes the real liquidation EARLIER than "you can lose 1/L of it".
    // Being wrong the other way would show a beginner more room than they have.
    const naive = 60_000 * (1 - 1 / 10)
    expect(liquidationPrice({ entryPrice: 60_000, leverage: 10, side: 'buy' })!).toBeGreaterThan(naive)
  })

  it('has none at 1x, because a spot position is not liquidated', () => {
    // Returning a price here would draw a "you get liquidated here" line on an ordinary spot
    // position, which is simply false.
    expect(liquidationPrice({ entryPrice: 60_000, leverage: 1, side: 'buy' })).toBeNull()
  })

  it('has none for an unusable leverage or entry price', () => {
    expect(liquidationPrice({ entryPrice: 60_000, leverage: Number.NaN, side: 'buy' })).toBeNull()
    expect(liquidationPrice({ entryPrice: Number.NaN, leverage: 10, side: 'buy' })).toBeNull()
    expect(liquidationPrice({ entryPrice: 0, leverage: 10, side: 'buy' })).toBeNull()
    expect(liquidationPrice({ entryPrice: -100, leverage: 10, side: 'buy' })).toBeNull()
  })

  it('still has one just above 1x, very close to zero', () => {
    // Worth pinning because it is the opposite of what it looks like. At 1.0001x the liquidation
    // is not impossible or negative -- it sits at a fraction of a percent of the entry, which is
    // the correct answer: a barely-levered long survives almost the entire way to zero.
    expect(liquidationPrice({ entryPrice: 60_000, leverage: 1.0001, side: 'buy' })!).toBeGreaterThan(0)
    expect(liquidationPrice({ entryPrice: 60_000, leverage: 1.0001, side: 'buy' })!).toBeLessThan(600)
  })

  it('has none when a maintenance rate puts the level at or below zero', () => {
    // Only reachable through the maintenance-rate parameter, which exists because Binance tiers
    // it by position size. With the default rate and the leverage cap the branch cannot be hit --
    // 1/125 is still twice 0.004 -- so this is what keeps it honest rather than untestable
    // decoration. A level at or below zero is one nothing can cross, and drawing it would mark a
    // "you get liquidated here" price that means nothing.
    expect(liquidationPrice({ entryPrice: 60_000, leverage: 10, side: 'sell', maintenanceMarginRate: 2 })).toBeNull()
  })
})

describe('liquidationDistancePct', () => {
  it('is roughly 100/L', () => {
    expect(liquidationDistancePct(10)!).toBeCloseTo(100 / 10 - MAINTENANCE_MARGIN_RATE * 100, 9)
    expect(liquidationDistancePct(20)!).toBeCloseTo(5 - 0.4, 9)
  })

  it('is null at 1x, where there is no such distance', () => {
    expect(liquidationDistancePct(1)).toBeNull()
  })

  it('still leaves room at the leverage cap, so the cap and the rate do not collide', () => {
    // 1/125 is 0.8%, twice the 0.4% maintenance rate. Worth asserting rather than assuming:
    // raising MAX_LEVERAGE past 1/MAINTENANCE_MARGIN_RATE would make every position at the cap
    // liquidated on open, and this is the test that would say so.
    expect(liquidationDistancePct(MAX_LEVERAGE)!).toBeGreaterThan(0)
    expect(MAX_LEVERAGE).toBeLessThan(1 / MAINTENANCE_MARGIN_RATE)
  })

  it('is null when the maintenance margin leaves no room at all', () => {
    // Reachable only through the maintenance-rate parameter, for the same reason as the
    // liquidation-price guard above. A negative distance would render as a percentage that reads
    // like room to move.
    expect(liquidationDistancePct(10, 0.5)).toBeNull()
  })
})

describe('fundingCost', () => {
  it('is charged on the notional, not on the margin', () => {
    // The part that surprises people: at 10x, a 0.01% rate costs 0.1% of the margin per payment.
    expect(fundingCost({ notionalQuote: 2_500, fundingRate: 0.0001, periods: 1, side: 'buy' })).toBeCloseTo(0.25, 9)
  })

  it('is paid by longs and received by shorts when the rate is positive', () => {
    const long = fundingCost({ notionalQuote: 1_000, fundingRate: 0.0001, periods: 3, side: 'buy' })
    const short = fundingCost({ notionalQuote: 1_000, fundingRate: 0.0001, periods: 3, side: 'sell' })

    expect(long).toBeGreaterThan(0)
    expect(short).toBe(-long)
  })

  it('reverses when the rate is negative', () => {
    expect(fundingCost({ notionalQuote: 1_000, fundingRate: -0.0001, periods: 1, side: 'buy' })).toBeLessThan(0)
  })

  it('is nothing for a position that spanned no funding period', () => {
    expect(fundingCost({ notionalQuote: 1_000, fundingRate: 0.0001, periods: 0, side: 'buy' })).toBe(0)
    // The sell side too: without the zero guard this returns -0, and -0 is not 0 to anything that
    // checks properly. A "-0.00" funding line on a position that paid no funding is nonsense on
    // screen and a sign of a real one being computed the same way.
    expect(fundingCost({ notionalQuote: 1_000, fundingRate: 0.0001, periods: 0, side: 'sell' })).toBe(0)
  })

  it('never turns a negative period count into a refund', () => {
    // fundingPeriodsBetween cannot produce one, but this function is exported separately and a
    // negative count would pay the position money for being open backwards.
    expect(fundingCost({ notionalQuote: 1_000, fundingRate: 0.0001, periods: -3, side: 'buy' })).toBe(0)
    expect(fundingCost({ notionalQuote: 1_000, fundingRate: 0.0001, periods: -3, side: 'sell' })).toBe(0)
  })

  it('refuses to invent a cost from an unusable input', () => {
    // A NaN here would flow into realized P&L and, from there, into a balance that JSON stores
    // as null and reads back as zero.
    expect(fundingCost({ notionalQuote: Number.NaN, fundingRate: 0.0001, periods: 1, side: 'buy' })).toBe(0)
    expect(fundingCost({ notionalQuote: 1_000, fundingRate: Number.NaN, periods: 1, side: 'buy' })).toBe(0)
    expect(fundingCost({ notionalQuote: 1_000, fundingRate: 0.0001, periods: Number.NaN, side: 'buy' })).toBe(0)
  })
})

describe('fundingPeriodsBetween', () => {
  const T = 1_700_000_000

  it('counts whole eight-hour periods only', () => {
    expect(fundingPeriodsBetween(T, T + 8 * 3600)).toBe(1)
    expect(fundingPeriodsBetween(T, T + 24 * 3600)).toBe(3)
  })

  it('charges nothing for a position closed before the first one', () => {
    // Funding happens at fixed times. A position opened and closed in between pays nothing, and
    // counting a fraction would make every short simulated trade look worse than it was.
    expect(fundingPeriodsBetween(T, T + 7 * 3600)).toBe(0)
    expect(fundingPeriodsBetween(T, T + 8 * 3600 - 1)).toBe(0)
  })

  it('counts nothing for a position that closed before it opened', () => {
    expect(fundingPeriodsBetween(T, T - 100)).toBe(0)
    expect(fundingPeriodsBetween(T, T)).toBe(0)
  })

  it('counts nothing when a timestamp is unusable', () => {
    expect(fundingPeriodsBetween(Number.NaN, T)).toBe(0)
    expect(fundingPeriodsBetween(T, Number.NaN)).toBe(0)
  })
})
