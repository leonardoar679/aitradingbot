import { describe, expect, it } from 'vitest'
import { describeLiveShortfall } from '../shared/liveBalances'

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
