import { describe, expect, it } from 'vitest'
import {
  MAX_LEDGER_ENTRIES,
  accountPnl,
  availableBalance,
  describeInsufficientFunds,
  emptyAccount,
  fund,
  fundedAssets,
  settle,
  totalBalance
} from '../src/account/paperAccount'

// The account is what makes paper trading mean anything: before it, every executor invented its
// own money and two of them could each commit 10,000 USDT with nothing recording that only 10,000
// ever existed.
//
// The rule that matters most here is that committing money is NOT earning it. `balances` is total
// holdings; what strategies have taken is derived from the executors themselves and subtracted to
// get what is available. An earlier version of this file deducted on allocation instead, and
// showed +1,300 profit the moment a strategy started, because the committed amount was added back
// on top of a balance it had never left.

const T = 1_700_000_000
const move = (asset: string, amount: number, over: Record<string, unknown> = {}) => ({
  asset,
  amount,
  now: T,
  id: `m-${Math.random()}`,
  ...over
})

const funded = (asset = 'USDT', amount = 10_000) => fund(emptyAccount(T), move(asset, amount))

describe('funding an account', () => {
  it('starts with nothing', () => {
    const account = emptyAccount(T)
    expect(totalBalance(account, 'USDT')).toBe(0)
    expect(fundedAssets(account)).toEqual([])
  })

  it('records what was added, and remembers it as the starting point', () => {
    const account = funded()
    expect(totalBalance(account, 'USDT')).toBe(10_000)
    expect(account.initialBalances.USDT).toBe(10_000)
  })

  it('holds several assets independently', () => {
    const account = fund(funded(), move('BTC', 0.5))
    expect(totalBalance(account, 'USDT')).toBe(10_000)
    expect(totalBalance(account, 'BTC')).toBe(0.5)
    expect(fundedAssets(account).map((a) => a.asset)).toEqual(['USDT', 'BTC'])
  })

  it('does not treat later funding as profit', () => {
    // Raising the balance without raising the starting point would show a 5,000 gain for money
    // the user simply put in.
    const account = fund(funded(), move('USDT', 5_000))
    expect(accountPnl(account, 'USDT')).toBe(0)
  })

  it('ignores a nonsense amount rather than storing it', () => {
    // JSON cannot hold NaN -- one that reached settings.json would come back as null and read as
    // zero, so the balance would silently change on the next launch.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -100]) {
      expect(totalBalance(fund(emptyAccount(T), move('USDT', bad)), 'USDT')).toBe(0)
    }
  })
})

describe('committing money is not earning it', () => {
  it('leaves the total alone while a strategy holds funds', () => {
    // The bug this design exists to prevent: a strategy merely holding 1,300 must not read as
    // 1,300 of profit.
    const account = funded()
    expect(totalBalance(account, 'USDT')).toBe(10_000)
    expect(accountPnl(account, 'USDT')).toBe(0)
  })

  it('subtracts committed money from what is available to start something new', () => {
    expect(availableBalance(funded(), 'USDT', 1_300)).toBe(8_700)
  })

  it('reports a real shortfall when strategies hold more than the account has', () => {
    // Honest rather than clamped: this is what someone sees if they fund an account after
    // already running strategies, and hiding it would not make it less true.
    expect(availableBalance(funded(), 'USDT', 12_000)).toBe(-2_000)
  })

  it('treats a non-finite committed figure as zero rather than poisoning the result', () => {
    expect(availableBalance(funded(), 'USDT', Number.NaN)).toBe(10_000)
  })
})

describe('refusing to overcommit', () => {
  const ok = (amount: number, committed = 0) =>
    describeInsufficientFunds({ account: funded(), asset: 'USDT', amount, committed })

  it('allows an amount that fits', () => {
    expect(ok(600)).toBeNull()
  })

  it('allows spending the balance exactly', () => {
    expect(ok(10_000)).toBeNull()
  })

  it('counts what other strategies already hold', () => {
    // 6,000 is fine on its own and not fine alongside 5,000 already committed. Checking the
    // amount in isolation is the original bug.
    expect(ok(6_000)).toBeNull()
    expect(ok(6_000, 5_000)).not.toBeNull()
  })

  it('says how much is short rather than just refusing', () => {
    const why = ok(12_000)
    expect(why).toContain('2,000')
    expect(why).toContain('short')
  })

  it('does not report a negative amount as free when already overcommitted', () => {
    // available is -2,000 here; saying "only -2,000 is free" would be nonsense.
    const why = ok(1_000, 12_000)
    // Substring checks are treacherous here: '-2,000 is free' also contains '0 is free', so
    // the negative form has to be ruled out explicitly.
    expect(why).not.toContain('-2,000')
    expect(why).toContain('only 0 is free')
    expect(why).toContain('3,000 short')
  })

  it('says so plainly when the asset was never funded', () => {
    expect(describeInsufficientFunds({ account: funded(), asset: 'BTC', amount: 1, committed: 0 })).toContain('no BTC')
  })

  it('rejects a non-finite amount instead of comparing against it', () => {
    // NaN passes no comparison, so `amount > available` is false and a missing guard lets it
    // straight through -- the exact shape of bug this codebase has hit repeatedly.
    expect(ok(Number.NaN)).not.toBeNull()
    expect(ok(Number.POSITIVE_INFINITY)).not.toBeNull()
  })

  it('rejects zero and negative amounts', () => {
    expect(ok(0)).not.toBeNull()
    expect(ok(-5)).not.toBeNull()
  })
})

describe('settling a finished strategy', () => {
  it('adds a profit to the total', () => {
    const account = settle(funded(), move('USDT', 12, { executorId: 'e1' }))
    expect(totalBalance(account, 'USDT')).toBe(10_012)
    expect(accountPnl(account, 'USDT')).toBe(12)
  })

  it('subtracts a loss', () => {
    // Unlike funding, this one has to accept a negative -- a strategy that lost money must
    // reduce the balance, or the account only ever goes up.
    const account = settle(funded(), move('USDT', -30, { executorId: 'e1' }))
    expect(totalBalance(account, 'USDT')).toBe(9_970)
    expect(accountPnl(account, 'USDT')).toBe(-30)
  })

  it('files a loss under a different reason than a profit', () => {
    expect(settle(funded(), move('USDT', -30)).ledger.at(-1)!.reason).toBe('adjust')
    expect(settle(funded(), move('USDT', 30)).ledger.at(-1)!.reason).toBe('release')
  })

  it('ignores a non-finite result', () => {
    expect(totalBalance(settle(funded(), move('USDT', Number.NaN)), 'USDT')).toBe(10_000)
  })

  it('does nothing for a strategy that broke even exactly', () => {
    const account = settle(funded(), move('USDT', 0))
    expect(account.ledger).toHaveLength(1)
  })

  it('accumulates across several strategies', () => {
    let account = funded()
    for (const pnl of [12, -30, 45]) account = settle(account, move('USDT', pnl))
    expect(accountPnl(account, 'USDT')).toBe(27)
  })
})

describe('the ledger explains the balance', () => {
  it('records every movement with its reason and owner', () => {
    const account = settle(funded(), move('USDT', -30, { executorId: 'e1' }))
    expect(account.ledger.map((l) => l.reason)).toEqual(['fund', 'adjust'])
    expect(account.ledger[1].delta).toBe(-30)
    expect(account.ledger[1].executorId).toBe('e1')
  })

  it('trims the oldest entries instead of growing without limit', () => {
    // The balance stays authoritative, so trimming loses explanation and never money.
    let account = fund(emptyAccount(T), move('USDT', 1_000_000))
    for (let i = 0; i < MAX_LEDGER_ENTRIES + 50; i++) account = settle(account, move('USDT', 1))
    expect(account.ledger).toHaveLength(MAX_LEDGER_ENTRIES)
    expect(totalBalance(account, 'USDT')).toBe(1_000_000 + MAX_LEDGER_ENTRIES + 50)
  })

  it('drops the OLDEST entries, not the newest', () => {
    // Keeping the ancient half would leave a ledger that explains a balance from months ago and
    // says nothing about the movements that produced the current one.
    let account = fund(emptyAccount(T), move('USDT', 1_000_000, { note: 'the very first entry' }))
    for (let i = 0; i < MAX_LEDGER_ENTRIES + 20; i++) {
      account = settle(account, move('USDT', 1, { note: `settle ${i}` }))
    }
    expect(account.ledger.at(-1)!.note).toBe(`settle ${MAX_LEDGER_ENTRIES + 19}`)
    expect(account.ledger.some((l) => l.note === 'the very first entry')).toBe(false)
  })
})

describe('listing funded assets', () => {
  it('leaves out an asset that has been settled down to nothing', () => {
    // An Account page listing "BTC 0" alongside real holdings invites the question of where the
    // BTC went, when the answer is that there is none.
    const account = settle(funded(), move('USDT', -10_000))
    expect(totalBalance(account, 'USDT')).toBe(0)
    expect(fundedAssets(account)).toEqual([])
  })

  it('still lists the assets that hold something', () => {
    const account = settle(fund(funded(), move('BTC', 0.5)), move('USDT', -10_000))
    expect(fundedAssets(account)).toEqual([{ asset: 'BTC', amount: 0.5 }])
  })
})
