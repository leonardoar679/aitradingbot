import { describe, expect, it } from 'vitest'
import { readableBalances, freeBalance, type ExchangeBalance } from '../shared/liveBalances'

// This is the first thing in the app that reports REAL money. Everything else on the Account page
// is simulated and a wrong number is a wrong simulation; here a wrong number is a wrong statement
// about what the user owns. The two failures that matter are showing money that is not there and
// hiding money that is.

const row = (asset: string, free: number, locked = 0): ExchangeBalance => ({ asset, free, locked })

describe('readableBalances', () => {
  it('drops the zero rows an exchange pads its answer with', () => {
    // Binance answers /account with every asset it has ever listed -- roughly 400 rows. Showing
    // them raw buries the two the user holds, which is the only reason to show the list.
    const { rows } = readableBalances([row('BTC', 0.5), row('ETH', 0), row('DOGE', 0), row('USDT', 1200)])

    expect(rows.map((r) => r.asset)).toEqual(['USDT', 'BTC'])
  })

  it('keeps an asset held entirely in resting orders', () => {
    // Free is 0, so a filter on spendable money would delete it. It is still the user's money and
    // its absence from their own balance list would be unexplainable.
    const { rows } = readableBalances([row('BTC', 0, 0.25)])

    expect(rows).toEqual([{ asset: 'BTC', free: 0, locked: 0.25 }])
  })

  it('orders by total held, not by what happens to be spendable', () => {
    const { rows } = readableBalances([row('A', 5, 0), row('B', 1, 90), row('C', 20, 0)])

    expect(rows.map((r) => r.asset)).toEqual(['B', 'C', 'A'])
  })

  it('breaks ties on the name so a refresh that changed nothing does not reshuffle the list', () => {
    const first = readableBalances([row('ZZZ', 10), row('AAA', 10), row('MMM', 10)])
    const second = readableBalances([row('MMM', 10), row('ZZZ', 10), row('AAA', 10)])

    expect(first.rows.map((r) => r.asset)).toEqual(['AAA', 'MMM', 'ZZZ'])
    expect(second.rows.map((r) => r.asset)).toEqual(first.rows.map((r) => r.asset))
  })

  it('reports an unparseable amount instead of showing it or silently dropping it', () => {
    // Amounts arrive as decimal strings and become NaN if they will not parse. Rendering that
    // prints "NaN" beside real figures; dropping it quietly tells the user they hold nothing of
    // an asset they may hold plenty of, with nothing on screen to suggest anything is missing.
    const { rows, unreadable } = readableBalances([row('BTC', Number.NaN), row('USDT', 100)])

    expect(rows.map((r) => r.asset)).toEqual(['USDT'])
    expect(unreadable).toEqual(['BTC'])
  })

  it('treats an unreadable locked amount the same as an unreadable free one', () => {
    // The total shown is free + locked, so a NaN in either half makes the row's total a lie.
    const { rows, unreadable } = readableBalances([{ asset: 'ETH', free: 2, locked: Number.NaN }])

    expect(rows).toEqual([])
    expect(unreadable).toEqual(['ETH'])
  })

  it('treats Infinity as unreadable rather than as the largest holding', () => {
    // It would otherwise sort to the top and be presented as the user's main asset.
    const { rows, unreadable } = readableBalances([row('BTC', Number.POSITIVE_INFINITY), row('USDT', 100)])

    expect(rows.map((r) => r.asset)).toEqual(['USDT'])
    expect(unreadable).toEqual(['BTC'])
  })

  it('keeps a negative balance visible rather than filtering it away as dust', () => {
    // No exchange should report one. If one does, it is not nothing, and silently discarding it
    // hides exactly the kind of anomaly a person needs to see on their own account.
    const { rows } = readableBalances([row('USDT', -5)])

    expect(rows).toEqual([{ asset: 'USDT', free: -5, locked: 0 }])
  })

  it('skips a row with no asset name, which cannot be shown or reported', () => {
    const { rows, unreadable } = readableBalances([row('', 10), row('  ', Number.NaN), row('BTC', 1)])

    expect(rows.map((r) => r.asset)).toEqual(['BTC'])
    expect(unreadable).toEqual([])
  })

  it('trims the asset name so lookups match what is displayed', () => {
    const readout = readableBalances([{ asset: ' USDT ', free: 100, locked: 0 }])

    expect(readout.rows[0].asset).toBe('USDT')
    expect(freeBalance(readout, 'USDT')).toBe(100)
  })

  it('returns an empty readout for an account holding nothing', () => {
    expect(readableBalances([])).toEqual({ rows: [], unreadable: [] })
  })

  it('does not mutate what it was given', () => {
    const input = [row('A', 1), row('B', 2)]
    readableBalances(input)

    expect(input.map((r) => r.asset)).toEqual(['A', 'B'])
  })
})

describe('freeBalance', () => {
  it('reports what is spendable, not what is held', () => {
    // The number a pre-flight check needs. Counting locked funds is how a check passes and the
    // exchange then rejects the order for insufficient balance.
    const readout = readableBalances([row('USDT', 40, 1_000)])

    expect(freeBalance(readout, 'USDT')).toBe(40)
  })

  it('reports zero for an asset the account does not hold', () => {
    expect(freeBalance(readableBalances([row('BTC', 1)]), 'USDT')).toBe(0)
  })

  it('reports zero for an asset that could not be read, rather than a NaN a check would pass', () => {
    // NaN loses every comparison, so `cost <= freeBalance(...)` would be false and `freeBalance
    // (...) < cost` would also be false -- whichever way a caller writes the guard, an unreadable
    // balance must not be the value it reasons about.
    const readout = readableBalances([row('USDT', Number.NaN)])

    expect(freeBalance(readout, 'USDT')).toBe(0)
  })
})
