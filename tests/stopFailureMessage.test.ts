import { describe, it, expect } from 'vitest'
import { describeIncompleteStop } from '../src/executors/stopFailureMessage'

describe('describeIncompleteStop', () => {
  it('says nothing when the teardown fully succeeded', () => {
    expect(
      describeIncompleteStop({ restingOrders: 0, watcherStillActive: false, cancelError: null, watcherError: null })
    ).toBeNull()
  })

  it('names a single still-resting order in the singular', () => {
    const msg = describeIncompleteStop({
      restingOrders: 1,
      watcherStillActive: false,
      cancelError: 'timestamp ahead of server',
      watcherError: null
    })
    expect(msg).toContain('1 real resting order is still live on the exchange')
    expect(msg).toContain('timestamp ahead of server')
    expect(msg).not.toContain('orders are')
  })

  it('pluralises several still-resting orders', () => {
    const msg = describeIncompleteStop({
      restingOrders: 3,
      watcherStillActive: false,
      cancelError: 'network down',
      watcherError: null
    })
    expect(msg).toContain('3 real resting orders are still live on the exchange')
  })

  it('reports an unclosed watched position on its own', () => {
    const msg = describeIncompleteStop({
      restingOrders: 0,
      watcherStillActive: true,
      cancelError: null,
      watcherError: 'insufficient balance'
    })
    expect(msg).toContain('the open position is still being watched and was NOT closed')
    expect(msg).toContain('insufficient balance')
    expect(msg).not.toContain('resting order')
  })

  // A live DCA or Grid executor can genuinely have both at once, so the message has to carry both
  // rather than reporting whichever failure it noticed first.
  it('reports both failures together when a ladder has orders AND a position', () => {
    const msg = describeIncompleteStop({
      restingOrders: 2,
      watcherStillActive: true,
      cancelError: 'cancel rejected',
      watcherError: 'sell rejected'
    })
    expect(msg).toContain('2 real resting orders are still live')
    expect(msg).toContain('still being watched and was NOT closed')
    expect(msg).toContain(', and ')
    expect(msg).toContain('cancel rejected')
    expect(msg).toContain('sell rejected')
  })

  it('always tells the user Stop can be pressed again', () => {
    for (const [orders, watcher] of [
      [1, false],
      [0, true],
      [4, true]
    ] as const) {
      const msg = describeIncompleteStop({
        restingOrders: orders,
        watcherStillActive: watcher,
        cancelError: null,
        watcherError: null
      })
      expect(msg, `orders=${orders} watcher=${watcher}`).toContain('press Stop again')
      expect(msg, `orders=${orders} watcher=${watcher}`).toContain('left active')
    }
  })

  it('still produces a message when the failure had no readable reason', () => {
    const msg = describeIncompleteStop({
      restingOrders: 1,
      watcherStillActive: false,
      cancelError: null,
      watcherError: null
    })
    expect(msg).toContain('cancel failed')
  })

  it('treats a negative or zero order count as nothing resting', () => {
    expect(
      describeIncompleteStop({ restingOrders: -1, watcherStillActive: false, cancelError: null, watcherError: null })
    ).toBeNull()
  })
})
