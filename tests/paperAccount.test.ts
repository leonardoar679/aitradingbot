import { describe, expect, it } from 'vitest'
import {
  MAX_LEDGER_ENTRIES,
  accountPnl,
  allocate,
  describeInsufficientFunds,
  emptyAccount,
  freeBalance,
  fund,
  fundedAssets,
  release
} from '../src/account/paperAccount'

// The account is what makes paper trading mean anything: before it, every executor invented its
// own money and two of them could each commit 10,000 USDT with nothing recording that only 10,000
// ever existed. So the rule that actually matters here is that money is conserved -- it cannot be
// created by opening a strategy, and it cannot go negative.

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
    expect(freeBalance(account, 'USDT')).toBe(0)
    expect(fundedAssets(account)).toEqual([])
  })

  it('records what was added, and remembers it as the starting point', () => {
    const account = funded()
    expect(freeBalance(account, 'USDT')).toBe(10_000)
    expect(account.initialBalances.USDT).toBe(10_000)
  })

  it('holds several assets independently', () => {
    const account = fund(funded(), move('BTC', 0.5))
    expect(freeBalance(account, 'USDT')).toBe(10_000)
    expect(freeBalance(account, 'BTC')).toBe(0.5)
    expect(fundedAssets(account).map((a) => a.asset)).toEqual(['USDT', 'BTC'])
  })

  it('does not treat later funding as profit', () => {
    // Raising the balance without raising the starting point would show a 5,000 gain for money
    // the user simply put in.
    const account = fund(funded(), move('USDT', 5_000))
    expect(accountPnl(account, 'USDT', 0)).toBe(0)
  })

  it('ignores a nonsense amount rather than storing it', () => {
    // JSON cannot hold NaN -- one that reached settings.json would come back as null and read as
    // zero, so the balance would silently change on the next launch.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -100]) {
      expect(freeBalance(fund(emptyAccount(T), move('USDT', bad)), 'USDT')).toBe(0)
    }
  })
})

describe('refusing to overspend', () => {
  it('allows an amount that fits', () => {
    expect(describeInsufficientFunds({ account: funded(), asset: 'USDT', amount: 600 })).toBeNull()
  })

  it('allows spending the balance exactly', () => {
    expect(describeInsufficientFunds({ account: funded(), asset: 'USDT', amount: 10_000 })).toBeNull()
  })

  it('says how much is short rather than just refusing', () => {
    const why = describeInsufficientFunds({ account: funded(), asset: 'USDT', amount: 12_000 })
    expect(why).toContain('2,000')
    expect(why).toContain('short')
  })

  it('says so plainly when the asset was never funded', () => {
    const why = describeInsufficientFunds({ account: funded(), asset: 'BTC', amount: 1 })
    expect(why).toContain('no BTC')
  })

  it('rejects a non-finite amount instead of comparing against it', () => {
    // NaN passes no comparison, so `amount > free` is false and a missing guard lets it straight
    // through -- the exact shape of bug this codebase has hit repeatedly.
    expect(describeInsufficientFunds({ account: funded(), asset: 'USDT', amount: Number.NaN })).not.toBeNull()
    expect(describeInsufficientFunds({ account: funded(), asset: 'USDT', amount: Number.POSITIVE_INFINITY })).not.toBeNull()
  })

  it('rejects zero and negative amounts', () => {
    expect(describeInsufficientFunds({ account: funded(), asset: 'USDT', amount: 0 })).not.toBeNull()
    expect(describeInsufficientFunds({ account: funded(), asset: 'USDT', amount: -5 })).not.toBeNull()
  })
})

describe('allocating to a strategy', () => {
  it('moves money out of the free balance', () => {
    const { account, error } = allocate(funded(), move('USDT', 600, { executorId: 'e1' }))
    expect(error).toBeNull()
    expect(freeBalance(account, 'USDT')).toBe(9_400)
  })

  it('refuses to overdraw, and changes nothing when it does', () => {
    const before = funded()
    const { account, error } = allocate(before, move('USDT', 12_000))
    expect(error).not.toBeNull()
    // The untouched account is the important half: a refused allocation that still moved money
    // would be worse than one that succeeded.
    expect(account).toBe(before)
    expect(freeBalance(account, 'USDT')).toBe(10_000)
  })

  it('cannot be overdrawn by several strategies in turn', () => {
    // The original bug: each executor was fine on its own, and nothing looked at the total.
    let account = funded()
    for (const amount of [4_000, 4_000]) {
      const step = allocate(account, move('USDT', amount))
      expect(step.error).toBeNull()
      account = step.account
    }
    const third = allocate(account, move('USDT', 4_000))
    expect(third.error).not.toBeNull()
    expect(freeBalance(account, 'USDT')).toBe(2_000)
  })

  it('keeps assets separate', () => {
    const account = fund(funded(), move('BTC', 0.5))
    const spent = allocate(account, move('USDT', 600)).account
    expect(freeBalance(spent, 'BTC')).toBe(0.5)
  })
})

describe('releasing from a strategy', () => {
  it('brings back more than went out when the strategy profited', () => {
    const account = allocate(funded(), move('USDT', 600, { executorId: 'e1' })).account
    const back = release(account, move('USDT', 612, { executorId: 'e1' }))
    expect(freeBalance(back, 'USDT')).toBe(10_012)
    expect(accountPnl(back, 'USDT', 0)).toBe(12)
  })

  it('brings back less when it lost', () => {
    const account = allocate(funded(), move('USDT', 600, { executorId: 'e1' })).account
    const back = release(account, move('USDT', 570, { executorId: 'e1' }))
    expect(freeBalance(back, 'USDT')).toBe(9_970)
    expect(accountPnl(back, 'USDT', 0)).toBe(-30)
  })

  it('ignores a negative return rather than draining untouched money', () => {
    // A paper strategy cannot lose more than it was handed. Letting a negative through would eat
    // into funds it never had access to.
    const account = allocate(funded(), move('USDT', 600)).account
    expect(freeBalance(release(account, move('USDT', -100)), 'USDT')).toBe(9_400)
  })

  it('ignores a non-finite return', () => {
    const account = allocate(funded(), move('USDT', 600)).account
    expect(freeBalance(release(account, move('USDT', Number.NaN)), 'USDT')).toBe(9_400)
  })

  it('conserves the money across a full round trip that broke even', () => {
    const account = allocate(funded(), move('USDT', 600, { executorId: 'e1' })).account
    const back = release(account, move('USDT', 600, { executorId: 'e1' }))
    expect(freeBalance(back, 'USDT')).toBe(10_000)
    expect(accountPnl(back, 'USDT', 0)).toBe(0)
  })
})

describe('the ledger explains the balance', () => {
  it('records every movement with its reason and owner', () => {
    const account = allocate(funded(), move('USDT', 600, { executorId: 'e1' })).account
    expect(account.ledger.map((l) => l.reason)).toEqual(['fund', 'allocate'])
    expect(account.ledger[1].delta).toBe(-600)
    expect(account.ledger[1].executorId).toBe('e1')
  })

  it('trims the oldest entries instead of growing without limit', () => {
    // The balance stays authoritative, so trimming loses explanation and never money.
    let account = fund(emptyAccount(T), move('USDT', 1_000_000))
    for (let i = 0; i < MAX_LEDGER_ENTRIES + 50; i++) {
      account = release(account, move('USDT', 1))
    }
    expect(account.ledger).toHaveLength(MAX_LEDGER_ENTRIES)
    expect(freeBalance(account, 'USDT')).toBe(1_000_000 + MAX_LEDGER_ENTRIES + 50)
  })
})

describe('account P&L counts committed money too', () => {
  it('reads flat while money is still out working', () => {
    // Mid-strategy the funds have left the balance. Ignoring what is committed would show the
    // account down by the whole allocation the moment a strategy starts.
    const account = allocate(funded(), move('USDT', 600, { executorId: 'e1' })).account
    expect(freeBalance(account, 'USDT')).toBe(9_400)
    expect(accountPnl(account, 'USDT', 600)).toBe(0)
  })

  it('shows the gain when the committed money is worth more', () => {
    const account = allocate(funded(), move('USDT', 600, { executorId: 'e1' })).account
    expect(accountPnl(account, 'USDT', 660)).toBe(60)
  })

  it('treats a non-finite committed figure as zero rather than poisoning the result', () => {
    const account = funded()
    expect(accountPnl(account, 'USDT', Number.NaN)).toBe(0)
  })
})

describe('the ledger keeps the entries that explain the balance now', () => {
  it('drops the OLDEST entries, not the newest', () => {
    // Keeping the ancient half would leave a ledger that explains a balance from months ago and
    // says nothing about the movements that produced the current one.
    let account = fund(emptyAccount(T), move('USDT', 1_000_000, { note: 'the very first entry' }))
    for (let i = 0; i < MAX_LEDGER_ENTRIES + 20; i++) {
      account = release(account, move('USDT', 1, { note: `release ${i}` }))
    }

    expect(account.ledger[account.ledger.length - 1].note).toBe(`release ${MAX_LEDGER_ENTRIES + 19}`)
    expect(account.ledger.some((l) => l.note === 'the very first entry')).toBe(false)
    expect(account.ledger[0].reason).toBe('release')
  })
})

describe('listing funded assets', () => {
  it('leaves out an asset that has been spent down to nothing', () => {
    // An Account page listing "BTC 0" alongside real holdings invites the question of where the
    // BTC went, when the answer is that there is none.
    const account = allocate(funded(), move('USDT', 10_000)).account
    expect(freeBalance(account, 'USDT')).toBe(0)
    expect(fundedAssets(account)).toEqual([])
  })

  it('still lists the assets that hold something', () => {
    const account = allocate(fund(funded(), move('BTC', 0.5)), move('USDT', 10_000)).account
    expect(fundedAssets(account)).toEqual([{ asset: 'BTC', amount: 0.5 }])
  })
})
