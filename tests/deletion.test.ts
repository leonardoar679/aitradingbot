import { describe, expect, it } from 'vitest'
import {
  describeExecutorDeletionBlock,
  describeExecutorDeletionEffects,
  detachExecutorFromControllers
} from '../src/executors/deletion'
import { describeControllerDeletionEffects } from '../src/controllers/deletion'
import type { ControllerConfig, ExecutorConfig } from '../shared/ipc'

// Deleting is the only action here that destroys a record rather than changing one, and an
// executor's record is not just a row: a live one owns resting orders on a real exchange and an
// armed watcher in the main process. Deleting cancels none of that -- it only removes the screen
// that says it exists.

function executor(overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    id: 'e1',
    name: 'My Grid',
    type: 'grid',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    status: 'stopped',
    mode: 'paper',
    keepPosition: false,
    createdAt: 1,
    stoppedAt: 2,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveTwapRunId: null,
    params: { side: 'buy', startPrice: 100, endPrice: 110, levelSpreadPct: 2, takeProfitPct: 1, totalAmountQuote: 1000, maxOpenOrders: 5, limitPrice: null },
    ...overrides
  } as ExecutorConfig
}

function controller(overrides: Partial<ControllerConfig> = {}): ControllerConfig {
  return {
    id: 'c1',
    name: 'Risk Group',
    executorIds: ['e1'],
    riskControls: { globalStopLossPct: 10, globalTakeProfitPct: null, maxDrawdownPct: null },
    status: 'active',
    createdAt: 1,
    ...overrides
  }
}

describe('refusing to delete an executor that still owns something', () => {
  it('allows deleting one that is stopped and holds nothing', () => {
    expect(describeExecutorDeletionBlock(executor())).toBeNull()
  })

  it('refuses one that is still running, and says stopping is what tears it down', () => {
    const block = describeExecutorDeletionBlock(executor({ status: 'active' }))

    expect(block).toMatch(/still running/)
    expect(block).toMatch(/Stop it first/)
  })

  it('refuses one still holding live orders on the exchange', () => {
    // The exchange has never heard of this app's settings file. Deleting the row cancels nothing
    // and takes away the only button that would have.
    const block = describeExecutorDeletionBlock(executor({ pendingLiveOrderIds: ['o1', 'o2'] }))

    expect(block).toMatch(/2 live orders resting on the exchange/)
  })

  it('refuses one whose live exit watcher is still armed', () => {
    expect(describeExecutorDeletionBlock(executor({ liveWatcherId: 'w1' }))).toMatch(/watcher is still armed/)
  })

  it('refuses one whose live TWAP run is still placing slices', () => {
    expect(describeExecutorDeletionBlock(executor({ liveTwapRunId: 'r1' }))).toMatch(/still placing slices/)
  })

  it('refuses a stopped executor that somehow kept a live handle', () => {
    // A stop that only partly succeeded leaves the executor active on purpose. This is the belt
    // and braces for a future change to that path: stopped is not on its own proof of nothing
    // left running.
    expect(describeExecutorDeletionBlock(executor({ status: 'stopped', liveWatcherId: 'w1' }))).not.toBeNull()
  })
})

describe('saying what else a deletion changes', () => {
  it('names the controller the executor will be detached from', () => {
    const effects = describeExecutorDeletionEffects(executor(), [controller()])

    expect(effects.some((e) => e.includes('detached from the controller "Risk Group"'))).toBe(true)
  })

  it('warns when a controller is left supervising nothing', () => {
    const effects = describeExecutorDeletionEffects(executor(), [controller()])

    expect(effects.some((e) => /supervising nothing/.test(e))).toBe(true)
  })

  it('does not claim a controller is emptied when it still holds others', () => {
    const effects = describeExecutorDeletionEffects(executor(), [controller({ executorIds: ['e1', 'e2'] })])

    expect(effects.some((e) => e.includes('detached'))).toBe(true)
    expect(effects.some((e) => /supervising nothing/.test(e))).toBe(false)
  })

  it('says a handed-over position is not closed by deleting the strategy', () => {
    const effects = describeExecutorDeletionEffects(executor({ keepPosition: true }), [])

    expect(effects.some((e) => /Inventory stays there/.test(e))).toBe(true)
  })

  it('always says the money already made or lost is not undone', () => {
    // The account ledger keeps an entry per executor. Deleting the strategy must not read as
    // rewinding the balance it moved.
    expect(describeExecutorDeletionEffects(executor(), []).some((e) => /does not undo the money/.test(e))).toBe(true)
  })
})

describe('detaching a deleted executor from its controllers', () => {
  it('removes the id everywhere it appears', () => {
    const controllers = [controller({ executorIds: ['e1', 'e2'] }), controller({ id: 'c2', executorIds: ['e1'] })]
    const next = detachExecutorFromControllers(controllers, 'e1')

    expect(next[0].executorIds).toEqual(['e2'])
    expect(next[1].executorIds).toEqual([])
  })

  it('leaves the array untouched when nothing referenced it', () => {
    // Same reference, so a delete that changes no controller does not rewrite the list.
    const controllers = [controller({ executorIds: ['e2'] })]

    expect(detachExecutorFromControllers(controllers, 'e1')).toBe(controllers)
  })

  it('never deletes the controller itself, even when it is emptied', () => {
    const next = detachExecutorFromControllers([controller()], 'e1')

    expect(next).toHaveLength(1)
    expect(next[0].executorIds).toEqual([])
  })
})

describe('deleting a controller', () => {
  it('warns that running executors keep running, because it stops nothing', () => {
    const effects = describeControllerDeletionEffects(controller(), [executor({ status: 'active' })])

    expect(effects.some((e) => /will keep running/.test(e))).toBe(true)
    expect(effects.some((e) => /A 10% stop loss will no longer be watched for/.test(e))).toBe(true)
  })

  it('names every limit that stops being watched', () => {
    const effects = describeControllerDeletionEffects(
      controller({ riskControls: { globalStopLossPct: 10, globalTakeProfitPct: 25, maxDrawdownPct: -15 } }),
      [executor({ status: 'active' })]
    )

    expect(effects.some((e) => /A 10% stop loss, a 25% take profit, a 15% max drawdown/.test(e))).toBe(true)
  })

  it('does not raise an alarm when nothing under it is running', () => {
    const effects = describeControllerDeletionEffects(controller(), [executor({ status: 'stopped' })])

    expect(effects.some((e) => /keep running/.test(e))).toBe(false)
    expect(effects.some((e) => /already stopped and will not be touched/.test(e))).toBe(true)
  })

  it('always says the executors survive', () => {
    expect(describeControllerDeletionEffects(controller(), []).some((e) => /not deleted/.test(e))).toBe(true)
  })
})
