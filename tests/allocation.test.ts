import { describe, expect, it } from 'vitest'
import {
  allocationRemainingQuote,
  committedAllocationQuote,
  describeAllocationBreach,
  describeAllocationPlanShortfall,
  positionCostQuote,
  restingOrderReservedQuote
} from '../shared/allocation'
import type { LiveOrder, LivePosition } from '../shared/ipc'

// An allocation is the only gate in this app that bounds the total rather than the flow, so the
// tests that matter are the ones where something is committed and the gate has to notice.

const position = (over: Partial<LivePosition> = {}): LivePosition =>
  ({
    id: 'p1', exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
    qty: 0.001, avgCost: 60_000, openedAt: 1, closedAt: null, exitPrice: null, realizedPnl: null,
    ...over
  }) as LivePosition

const order = (over: Partial<LiveOrder> = {}): LiveOrder =>
  ({
    id: 'o1', executorId: 'e1', exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC',
    quoteAsset: 'USDT', side: 'buy', orderId: 1, limitPrice: 50_000, quantity: 0.001,
    status: 'open', filledQty: 0, avgFillPrice: null, placedAt: 1, resolvedAt: null,
    ...over
  }) as LiveOrder

describe('what counts as committed', () => {
  it('values a position at what it cost, not at what it is worth now', () => {
    // An allocation is permission to deploy an amount. A position that doubled has not consumed
    // more of that permission than the day it opened -- and marking to market would mean a rising
    // market quietly revoking permission the user never withdrew.
    expect(positionCostQuote(position({ qty: 0.001, avgCost: 60_000 }))).toBe(60)
  })

  it('ignores a position that is already closed', () => {
    const committed = committedAllocationQuote([position({ closedAt: 123, exitPrice: 61_000 })], [])

    expect(committed).toBe(0)
  })

  it('counts a resting buy order in full from the moment it is placed', () => {
    // The money is spoken for as soon as the order is on the book. Counting it only on fill would
    // let someone commit the same funds twice by placing orders faster than they fill.
    expect(restingOrderReservedQuote(order({ quantity: 0.002, limitPrice: 50_000 }))).toBe(100)
  })

  it('counts only the unfilled remainder of a partly-filled order', () => {
    // The filled part is already a position and counted there. Counting both charges the
    // allocation twice for one order.
    expect(restingOrderReservedQuote(order({ quantity: 0.002, filledQty: 0.0015, limitPrice: 50_000 }))).toBe(25)
  })

  it('ignores an order that is no longer resting', () => {
    for (const status of ['filled', 'cancelled', 'expired'] as const) {
      expect(restingOrderReservedQuote(order({ status }))).toBe(0)
    }
  })

  it('ignores a resting SELL, which returns capital rather than consuming it', () => {
    // A gate counting sells as commitment could trap someone inside an allocation they are
    // trying to exit.
    expect(restingOrderReservedQuote(order({ side: 'sell' }))).toBe(0)
  })

  it('adds positions and resting orders together', () => {
    const committed = committedAllocationQuote(
      [position({ qty: 0.001, avgCost: 60_000 }), position({ id: 'p2', qty: 0.0005, avgCost: 60_000 })],
      [order({ quantity: 0.001, limitPrice: 50_000 })]
    )

    expect(committed).toBe(60 + 30 + 50)
  })

  it('treats an unreadable cost as nothing rather than as NaN', () => {
    // One bad row must not turn the whole committed figure into NaN: every comparison against NaN
    // is false, so the gate below would pass everything through instead of refusing.
    const committed = committedAllocationQuote(
      [position({ qty: Number.NaN }), position({ id: 'p2', qty: 0.001, avgCost: 60_000 })],
      []
    )

    expect(committed).toBe(60)
  })
})

describe('what is left', () => {
  it('is the allocation minus what is committed', () => {
    expect(allocationRemainingQuote(200, 60)).toBe(140)
  })

  it('is nothing, not a negative, when the allocation was lowered below what is committed', () => {
    // A negative remaining would read as debt, and any arithmetic downstream of it would be wrong
    // in the permissive direction.
    expect(allocationRemainingQuote(50, 200)).toBe(0)
  })
})

describe('the gate', () => {
  const base = { committedQuote: 60, orderQuote: 10, quoteAsset: 'USDT' }

  it('does not apply at all when no allocation is configured', () => {
    // Null is "not using an allocation", and the app's other gates still do their job. It is not
    // the same as 0, which is an allocation of nothing.
    expect(describeAllocationBreach({ ...base, allocationQuote: null })).toBeNull()
  })

  it('blocks everything at an allocation of zero', () => {
    expect(describeAllocationBreach({ ...base, allocationQuote: 0 })).not.toBeNull()
  })

  it('allows an order that fits in what is left', () => {
    expect(describeAllocationBreach({ ...base, allocationQuote: 200 })).toBeNull()
  })

  it('allows an order that fills the allocation exactly', () => {
    // The boundary belongs to the user: they allocated 70 and this uses 70. Refusing here would
    // make the number they typed unreachable.
    expect(describeAllocationBreach({ ...base, allocationQuote: 70 })).toBeNull()
  })

  it('blocks the order one unit past the allocation', () => {
    expect(describeAllocationBreach({ ...base, allocationQuote: 69.99 })).not.toBeNull()
  })

  it('says what is committed and what is left, not just that it refused', () => {
    // This sentence is the only thing the user sees when a real order is refused. "Blocked by
    // allocation" tells them nothing about what to change.
    const reason = describeAllocationBreach({ ...base, allocationQuote: 65 }) as string

    expect(reason).toContain('60.00')
    expect(reason).toContain('65.00')
    expect(reason).toContain('5.00')
    expect(reason).toContain('USDT')
  })

  it('refuses when the allocation itself cannot be read, and says so rather than quoting it', () => {
    // NaN loses every comparison, so a one-sided check would let it through and disable the gate.
    // An allocation that cannot be read has to block, because the alternative is treating an
    // unreadable number as permission.
    //
    // The message matters as much as the refusal. Without its own branch the ordinary breach
    // sentence still refuses -- the remaining-capital arithmetic collapses to 0 on a NaN -- but it
    // refuses by telling the user they are "past the NaN USDT you allocated", which sends them
    // looking for a limit they have hit instead of a setting they need to re-enter.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const reason = describeAllocationBreach({ ...base, allocationQuote: bad }) as string

      expect(reason).toContain('could not be read')
      expect(reason).not.toContain('NaN')
    }
  })

  it('refuses when the committed figure cannot be read', () => {
    expect(describeAllocationBreach({ ...base, allocationQuote: 200, committedQuote: Number.NaN })).not.toBeNull()
    expect(describeAllocationBreach({ ...base, allocationQuote: 200, committedQuote: -5 })).not.toBeNull()
  })

  it('refuses an unusable order size', () => {
    for (const bad of [Number.NaN, 0, -10, Number.POSITIVE_INFINITY]) {
      expect(describeAllocationBreach({ ...base, allocationQuote: 200, orderQuote: bad })).not.toBeNull()
    }
  })
})

describe('warning about a whole strategy before it is created', () => {
  const base = { committedQuote: 30, planTotal: 50, quoteAsset: 'USDT' }

  it('says nothing when no allocation is configured', () => {
    expect(describeAllocationPlanShortfall({ ...base, allocationQuote: null })).toBeNull()
  })

  it('says nothing when the whole plan fits', () => {
    expect(describeAllocationPlanShortfall({ ...base, allocationQuote: 100 })).toBeNull()
  })

  it('says nothing when the plan fits exactly', () => {
    // 30 committed of 80 leaves 50, and the plan is 50.
    expect(describeAllocationPlanShortfall({ ...base, allocationQuote: 80 })).toBeNull()
  })

  it('warns when the orders add up to more than is free, which a ladder only finds out level by level', () => {
    // The failure this prevents: a DCA half-fills, then its later levels start being refused, and
    // the user is left with a strategy that is neither finished nor undone.
    const warning = describeAllocationPlanShortfall({ ...base, allocationQuote: 60 }) as string

    expect(warning).toContain('50.00')
    expect(warning).toContain('30.00')
    expect(warning).toContain('60.00')
    expect(warning).toContain('refused')
  })

  it('stays quiet on a plan total that is not a usable number', () => {
    // Unlike the order gate, this one is a warning and not a refusal, so an unreadable number has
    // to fall silent rather than raise an alarm nobody can act on. The refusal that actually
    // protects the user runs in the main process and does not depend on this.
    for (const bad of [Number.NaN, 0, -5]) {
      expect(describeAllocationPlanShortfall({ ...base, allocationQuote: 60, planTotal: bad })).toBeNull()
    }
  })

  it('stays quiet when the allocation or the committed figure cannot be read', () => {
    expect(describeAllocationPlanShortfall({ ...base, allocationQuote: Number.NaN })).toBeNull()
    expect(describeAllocationPlanShortfall({ ...base, allocationQuote: 60, committedQuote: Number.NaN })).toBeNull()
  })
})
