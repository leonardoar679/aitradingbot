import { describe, expect, it } from 'vitest'
import { ledgerHoldings, reconcileLivePositions, describeDiscrepancy } from '../shared/reconcileLive'
import { readableBalances } from '../shared/liveBalances'
import type { LivePosition } from '../shared/ipc'

// The live ledger prices the Positions page and Close sells the quantity it names, so a ledger
// out of step with the exchange misreports real money and produces a button that cannot work.
// The two failures here pull against each other: missing a real divergence, and crying wolf on
// every ordinary position until the panel is ignored.

const position = (over: Partial<LivePosition> = {}): LivePosition =>
  ({
    id: 'p1',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: 0.01,
    avgCost: 60_000,
    openedAt: 1_700_000_000,
    closedAt: null,
    exitPrice: null,
    realizedPnl: null,
    ...over
  }) as LivePosition

const balances = (rows: { asset: string; free: number; locked?: number }[]) =>
  readableBalances(rows.map((r) => ({ asset: r.asset, free: r.free, locked: r.locked ?? 0 })))

describe('ledgerHoldings', () => {
  it('totals per base asset, not per position', () => {
    // Two positions on different quote pairs are backed by ONE BTC balance. Checking either one
    // alone against the whole of it would call a real shortfall fine.
    const holdings = ledgerHoldings([
      position({ id: 'a', symbol: 'BTCUSDT', qty: 0.01 }),
      position({ id: 'b', symbol: 'BTCFDUSD', qty: 0.02 })
    ])

    expect(holdings).toHaveLength(1)
    expect(holdings[0].qty).toBeCloseTo(0.03, 12)
    expect(holdings[0].symbols).toEqual(['BTCUSDT', 'BTCFDUSD'])
  })

  it('ignores closed positions, which are not claims on anything', () => {
    // Both with and without a leftover quantity. In practice recordLiveFill zeroes qty when it
    // closes a position, so the two conditions overlap and a test using only the zeroed shape
    // proves nothing about the closedAt check -- the qty check catches it either way. A closed
    // position that still names a quantity is what actually distinguishes them.
    expect(ledgerHoldings([position({ closedAt: 1_700_000_100, qty: 0 })])).toEqual([])
    expect(ledgerHoldings([position({ closedAt: 1_700_000_100, qty: 0.5 })])).toEqual([])
  })

  it('ignores a position whose quantity is not a usable number', () => {
    // Nothing can be judged against it, and letting a NaN into the total would make every
    // comparison below false -- silently reporting no problem with the whole asset.
    expect(ledgerHoldings([position({ qty: Number.NaN })])).toEqual([])
    expect(ledgerHoldings([position({ qty: 0 })])).toEqual([])
  })

  it('lists a symbol once even when several positions share it', () => {
    const holdings = ledgerHoldings([position({ id: 'a' }), position({ id: 'b' })])

    expect(holdings[0].symbols).toEqual(['BTCUSDT'])
    expect(holdings[0].qty).toBeCloseTo(0.02, 12)
  })
})

describe('reconcileLivePositions — what it reports', () => {
  it('reports an asset the exchange no longer holds', () => {
    // The coin was sold on the exchange's own site. The position stays open here forever, priced
    // against coins that are gone.
    const { discrepancies } = reconcileLivePositions([position({ qty: 0.01 })], balances([{ asset: 'USDT', free: 500 }]))

    expect(discrepancies).toHaveLength(1)
    expect(discrepancies[0]).toMatchObject({ asset: 'BTC', ledgerQty: 0.01, exchangeQty: 0, shortfall: 0.01 })
  })

  it('reports a partial shortfall, with the amount that is actually missing', () => {
    const { discrepancies } = reconcileLivePositions(
      [position({ qty: 0.01 })],
      balances([{ asset: 'BTC', free: 0.004 }])
    )

    expect(discrepancies[0].shortfall).toBeCloseTo(0.006, 12)
  })

  it('counts funds locked in a resting order as held', () => {
    // They are still the user's coins and still back the position -- treating locked as missing
    // would report a discrepancy for every position with a sell order resting against it.
    const { discrepancies } = reconcileLivePositions(
      [position({ qty: 0.01 })],
      balances([{ asset: 'BTC', free: 0, locked: 0.01 }])
    )

    expect(discrepancies).toEqual([])
  })

  it('names every symbol involved so the user can find the positions', () => {
    const { discrepancies } = reconcileLivePositions(
      [position({ id: 'a', symbol: 'BTCUSDT', qty: 0.01 }), position({ id: 'b', symbol: 'BTCFDUSD', qty: 0.01 })],
      balances([{ asset: 'BTC', free: 0 }])
    )

    expect(discrepancies[0].symbols).toEqual(['BTCUSDT', 'BTCFDUSD'])
  })
})

describe('reconcileLivePositions — what it deliberately stays quiet about', () => {
  it('says nothing when the balance covers the ledger exactly', () => {
    expect(
      reconcileLivePositions([position({ qty: 0.01 })], balances([{ asset: 'BTC', free: 0.01 }])).discrepancies
    ).toEqual([])
  })

  it('says nothing about a base-asset commission, which shorts every ordinary buy', () => {
    // A BUY's fee is charged in the base asset unless the BNB discount is on, and the fill is
    // recorded at the exchange's executed quantity. So 0.01 BTC bought at 0.1% leaves 0.00999 in
    // the account -- on EVERY position. Reporting that would train the user to ignore the panel.
    const { discrepancies } = reconcileLivePositions(
      [position({ qty: 0.01 })],
      balances([{ asset: 'BTC', free: 0.01 * 0.999 }])
    )

    expect(discrepancies).toEqual([])
  })

  it('still reports a shortfall an order of magnitude past the fee', () => {
    // The counterpart to the above: tolerating the fee must not tolerate a real divergence.
    const { discrepancies } = reconcileLivePositions(
      [position({ qty: 0.01 })],
      balances([{ asset: 'BTC', free: 0.01 * 0.95 }])
    )

    expect(discrepancies).toHaveLength(1)
  })

  it('says nothing when the account holds more than the ledger claims', () => {
    // A manual buy, a deposit, staking rewards, a coin this app never traded. None of them is a
    // problem with the ledger, and reporting them would bury the one direction that is.
    expect(
      reconcileLivePositions([position({ qty: 0.01 })], balances([{ asset: 'BTC', free: 5 }])).discrepancies
    ).toEqual([])
  })

  it('says nothing at all when there are no open positions', () => {
    expect(reconcileLivePositions([], balances([{ asset: 'BTC', free: 0 }]))).toEqual({
      discrepancies: [],
      unchecked: []
    })
  })
})

describe('reconcileLivePositions — what it refuses to judge', () => {
  it('marks an asset unchecked when its balance could not be read', () => {
    // Reading it as zero would announce a total shortfall on a position that is probably fine.
    const readout = balances([{ asset: 'BTC', free: Number.NaN }])
    const { discrepancies, unchecked } = reconcileLivePositions([position({ qty: 0.01 })], readout)

    expect(discrepancies).toEqual([])
    expect(unchecked).toEqual(['BTC'])
  })

  it('marks an asset unchecked when a hand-built readout carries an unusable quantity', () => {
    // readableBalances never produces such a row -- it routes those to `unreadable` -- but this
    // function takes a plain BalanceReadout, so the guarantee lives with the other function and
    // not with this one. Without its own check, a NaN quantity makes `shortfall <= tolerance`
    // false and the app reports a total shortfall on a position that is very likely fine.
    const { discrepancies, unchecked } = reconcileLivePositions([position({ qty: 0.01 })], {
      rows: [{ asset: 'BTC', free: Number.NaN, locked: 0 }],
      unreadable: []
    })

    expect(discrepancies).toEqual([])
    expect(unchecked).toEqual(['BTC'])
  })

  it('does not let an unchecked asset hide a real shortfall on another one', () => {
    const readout = balances([
      { asset: 'BTC', free: Number.NaN },
      { asset: 'ETH', free: 0 }
    ])
    const { discrepancies, unchecked } = reconcileLivePositions(
      [position({ id: 'a', baseAsset: 'BTC', symbol: 'BTCUSDT' }), position({ id: 'b', baseAsset: 'ETH', symbol: 'ETHUSDT', qty: 2 })],
      readout
    )

    expect(unchecked).toEqual(['BTC'])
    expect(discrepancies.map((d) => d.asset)).toEqual(['ETH'])
  })
})

describe('describeDiscrepancy', () => {
  const [discrepancy] = reconcileLivePositions(
    [position({ qty: 0.01 })],
    balances([{ asset: 'BTC', free: 0 }])
  ).discrepancies

  it('states both numbers rather than only that they differ', () => {
    const text = describeDiscrepancy(discrepancy, 'Binance')

    expect(text).toContain('0.01')
    expect(text).toContain('BTCUSDT')
    expect(text).toContain('Binance')
  })

  it('says the Close button on this page would be rejected', () => {
    // The consequence the user is about to hit, and the only part of this they can act on
    // immediately.
    expect(describeDiscrepancy(discrepancy, 'Binance')).toMatch(/clos\w*.*reject/i)
  })

  it('says the app will not adjust the record itself', () => {
    // Otherwise the honest answer -- that a balance cannot say where it came from, so this is the
    // user's call -- reads as the app being broken.
    expect(describeDiscrepancy(discrepancy, 'Binance')).toMatch(/will not adjust/i)
  })
})
