import { describe, expect, it } from 'vitest'
import { describeLivePlanShortfall, describeLiveShortfall } from '../shared/liveBalances'

// This one runs immediately before real money leaves the account. Its job is not to be the last
// line of defence -- the exchange refuses an order there is no money for regardless -- but to say
// WHICH asset, HOW much was needed, and how much there actually is, instead of Binance's
// "Account has insufficient balance for requested action". So the failure that matters most here
// is the opposite one: blocking an order the user could have afforded.

const ask = (over: Partial<Parameters<typeof describeLiveShortfall>[0]> = {}): string | null =>
  describeLiveShortfall({
    side: 'buy',
    quoteAsset: 'USDT',
    quoteAmount: 25,
    free: 100,
    exchangeLabel: 'Binance',
    ...over
  })

describe('describeLiveShortfall — when it blocks', () => {
  it('blocks a buy the free balance cannot cover', () => {
    const why = ask({ free: 12.4 })

    expect(why).not.toBeNull()
    expect(why).toContain('USDT')
    expect(why).toContain('Binance')
  })

  it('names the amount needed, the amount free, and the difference', () => {
    // All three, because any one alone leaves the reader doing arithmetic to find out what to do.
    const why = ask({ quoteAmount: 25, free: 12 })!

    expect(why).toContain('25')
    expect(why).toContain('12')
    expect(why).toContain('13')
  })

  it('says that funds in resting orders do not count', () => {
    // The most likely reason a balance the user believes they have is not spendable, and nothing
    // else on screen would tell them.
    expect(ask({ free: 0 })).toContain('resting orders')
  })

  it('blocks when the account holds none of the asset at all', () => {
    expect(ask({ free: 0 })).not.toBeNull()
  })
})

describe('describeLiveShortfall — when it must not block', () => {
  it('allows a buy the balance exactly covers', () => {
    // Off by one in the other direction would block an order for the full balance, which is a
    // perfectly ordinary thing to want to do.
    expect(ask({ quoteAmount: 25, free: 25 })).toBeNull()
  })

  it('allows a buy with money to spare', () => {
    expect(ask({ quoteAmount: 25, free: 25.01 })).toBeNull()
  })

  it('never blocks a sell, which it cannot judge without a price', () => {
    // A market sell here is sized in quote currency too, so the base-asset amount the exchange
    // will need depends on a price this code would have to guess. Blocking a real order on a
    // guessed price is worse than letting the exchange answer exactly.
    expect(ask({ side: 'sell', free: 0, quoteAmount: 1_000_000 })).toBeNull()
  })

  it('does not block when the balance could not be read', () => {
    // freeBalance answers 0 for an unreadable asset and the caller skips the check entirely on a
    // failed read, but a NaN arriving from anywhere must fall the same way: an exchange that
    // cannot be reached is not an account with no money in it.
    expect(ask({ free: Number.NaN })).toBeNull()
  })

  it('leaves an unusable order size to the gate that reports it properly', () => {
    // canPlaceLiveOrder already refuses NaN, zero and negative sizes, and names that as the
    // reason. Reporting them here as a funding problem would send the user looking for money
    // when the amount itself is the fault.
    expect(ask({ quoteAmount: Number.NaN, free: 0 })).toBeNull()
    expect(ask({ quoteAmount: 0, free: 0 })).toBeNull()
    expect(ask({ quoteAmount: -5, free: 0 })).toBeNull()
  })

  it('does not block an order larger than any balance when the size is Infinity', () => {
    // Infinity is not a usable order size either, and belongs to the same gate.
    expect(ask({ quoteAmount: Number.POSITIVE_INFINITY, free: 0 })).toBeNull()
  })

  it('still leaves an unusable size to its own gate when the balance is negative', () => {
    // Only reachable because readableBalances deliberately keeps a negative balance visible
    // rather than filtering it away as dust. A negative free balance is the one case where
    // `free < quoteAmount` is true for a zero or negative order size, so without the size guard
    // this would report "this order spends 0 and only -10 is free" -- a funding message for an
    // order whose real fault is its size.
    expect(ask({ quoteAmount: 0, free: -10 })).toBeNull()
    expect(ask({ quoteAmount: -5, free: -10 })).toBeNull()
  })
})

// A ladder is a different question from a single order. Its money only has to be there when each
// order fires, so falling short on the total is a heads-up rather than a refusal -- but a silent
// one is the worst of both: the strategy runs, does real work, and then stops being able to.

const plan = (over: Partial<Parameters<typeof describeLivePlanShortfall>[0]> = {}): string | null =>
  describeLivePlanShortfall({ quoteAsset: 'USDT', planTotal: 100, free: 40, exchangeLabel: 'Binance', ...over })

describe('describeLivePlanShortfall', () => {
  it('warns when the whole plan costs more than is free', () => {
    const why = plan()!

    expect(why).toContain('100')
    expect(why).toContain('40')
    expect(why).toContain('USDT')
  })

  it('says the strategy will start and then stop, which is the part that is not obvious', () => {
    // Without this the user reads it as "this will not run" and looks for a different problem
    // when it does run.
    expect(plan()).toMatch(/start.*stop/i)
  })

  it('says nothing when the plan fits', () => {
    expect(plan({ planTotal: 100, free: 100 })).toBeNull()
    expect(plan({ planTotal: 100, free: 250 })).toBeNull()
  })

  it('says nothing when the balance could not be read', () => {
    expect(plan({ free: Number.NaN })).toBeNull()
  })

  it('says nothing about a total that is not a usable number', () => {
    expect(plan({ planTotal: Number.NaN })).toBeNull()
    expect(plan({ planTotal: 0 })).toBeNull()
    expect(plan({ planTotal: -10 })).toBeNull()
  })

  it('does not warn about an infinite plan total, which no balance can cover', () => {
    // The case that makes the finiteness guard do real work. Without it, `free < Infinity` holds
    // for any real balance and the warning reads "This plan places Infinity USDT of orders".
    expect(plan({ planTotal: Number.POSITIVE_INFINITY, free: 1_000_000 })).toBeNull()
  })

  it('still says nothing about a zero or negative total when the balance is negative', () => {
    // The only situation where a non-positive total is even reachable past the comparison, and
    // reachable at all because readableBalances deliberately keeps a negative balance visible
    // instead of filtering it away. Without the guard this warns that a plan placing 0 USDT of
    // orders cannot be afforded.
    expect(plan({ planTotal: 0, free: -10 })).toBeNull()
    expect(plan({ planTotal: -5, free: -10 })).toBeNull()
  })

  it('is a different message from the single-order refusal, not a rewording of it', () => {
    // They appear in the same place in the same dialog and mean different things: one says this
    // cannot be done, the other says it can be started but not finished.
    const refusal = describeLiveShortfall({
      side: 'buy',
      quoteAsset: 'USDT',
      quoteAmount: 100,
      free: 40,
      exchangeLabel: 'Binance'
    })!

    expect(plan()).not.toBe(refusal)
    expect(refusal).toContain('Not enough')
    expect(plan()).not.toContain('Not enough')
  })
})
