import { describe, expect, it } from 'vitest'
import { runExecutorSimulation } from '../src/executors/engine'
import { executorPnlFromState, executorRealizedPnl } from '../src/executors/executorPnl'
import { roundTripFee } from '../shared/fees'
import type { Candle, ExecutorConfig, GridExecutorParams } from '../shared/ipc'

// A stop with "keep position" books only the cash that bought the position, because the position
// itself becomes an Inventory row valued on its own. Anything the executor had already banked has
// no row anywhere, so collapsing the two into one figure threw the banked half away.

const M15 = 900
const START = Date.UTC(2025, 0, 1) / 1000

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]
    return { time: START + i * M15, open: prev, high: Math.max(c, prev), low: Math.min(c, prev), close: c, volume: 1 }
  })
}

const GRID: GridExecutorParams = {
  side: 'buy',
  startPrice: 90,
  endPrice: 110,
  levelSpreadPct: 2,
  takeProfitPct: 2,
  totalAmountQuote: 1_000,
  maxOpenOrders: 10,
  limitPrice: null
}

function gridExecutor(params: GridExecutorParams = GRID): ExecutorConfig {
  return { type: 'grid', params, createdAt: START } as unknown as ExecutorConfig
}

/** Starts at the top of the band, saws down and back up several times so rungs fill and take
 * profit, then finishes part-way down so a lot is still open at the end. */
const SAW = series([
  110, 104, 110, 104, 110, 104, 110, 104, 110, 104, 110, 100
])

describe('the profit an executor has already banked', () => {
  it('is a real figure for a grid that is still holding a lot', () => {
    const state = runExecutorSimulation(SAW, gridExecutor(), SAW[0].close)
    if (state.kind !== 'grid') throw new Error('expected a grid')

    // Both halves present at once -- the case that was being mishandled.
    expect(state.closedLevels).toBeGreaterThan(0)
    expect(state.levels.filter((l) => l.status === 'filled')).not.toHaveLength(0)
    expect(executorRealizedPnl(state)).toBeGreaterThan(0)
  })

  it('is the banked part only, with nothing marked to market', () => {
    const last = SAW[SAW.length - 1]
    const state = runExecutorSimulation(SAW, gridExecutor(), SAW[0].close)
    const realized = executorRealizedPnl(state)
    const total = executorPnlFromState(state, GRID, last.close, last.time)

    // The open lots are under water at the finish, so the total is the smaller number. If
    // realized silently included them the two would be equal.
    expect(total).toBeLessThan(realized)
    expect(realized).not.toBeCloseTo(total, 6)
  })

  it('is exactly the total less what the open lots are worth', () => {
    // The identity that has to hold, worked out from the levels rather than read back off the
    // same field the code uses: banked + marked-to-market = the whole P&L. Asserting only
    // "greater than zero" let a figure that was off by a fixed amount pass.
    const last = SAW[SAW.length - 1]
    const state = runExecutorSimulation(SAW, gridExecutor(), SAW[0].close)
    if (state.kind !== 'grid') throw new Error('expected a grid')

    const openValue = state.levels
      .filter((l) => l.status === 'filled' && l.entryPrice !== null)
      .reduce((sum, l) => {
        const entry = l.entryPrice as number
        const qty = state.amountPerLevel / entry
        return sum + qty * (last.close - entry) - roundTripFee(qty, entry, last.close)
      }, 0)
    const total = executorPnlFromState(state, GRID, last.close, last.time)

    expect(openValue).not.toBe(0)
    expect(executorRealizedPnl(state)).toBeCloseTo(total - openValue, 10)
  })

  it('matches the total once nothing is left open', () => {
    // Runs clear above the band and stays there, so every rung has taken its profit and none
    // re-fills on the way -- the last candle never trades back down to a rung.
    const roundTrip = series([110, 104, 110, 104, 120, 118])
    const last = roundTrip[roundTrip.length - 1]
    const state = runExecutorSimulation(roundTrip, gridExecutor(), roundTrip[0].close)

    expect(state.kind === 'grid' && state.levels.every((l) => l.status === 'pending')).toBe(true)
    expect(executorRealizedPnl(state)).toBeCloseTo(executorPnlFromState(state, GRID, last.close, last.time), 10)
  })

  it('is zero for a position that is still open, which has banked nothing', () => {
    const executor = {
      type: 'position',
      createdAt: START,
      params: { side: 'buy', amountQuote: 1_000, entryPrice: 110, takeProfitPct: 1_000, stopLossPct: null, timeLimitSec: null, trailingStop: null }
    } as unknown as ExecutorConfig
    const state = runExecutorSimulation(SAW, executor, SAW[0].close)

    expect(state.kind === 'position' && state.status).toBe('open')
    expect(executorRealizedPnl(state)).toBe(0)
  })

  it('is zero for an order, which banks nothing until it is closed out', () => {
    const executor = {
      type: 'order',
      createdAt: START,
      params: { side: 'buy', amountQuote: 1_000, limitPrice: 110, executionStrategy: 'limit' }
    } as unknown as ExecutorConfig

    expect(executorRealizedPnl(runExecutorSimulation(SAW, executor, SAW[0].close))).toBe(0)
  })

  it('is zero for a DCA still accumulating, which has closed nothing', () => {
    const executor = {
      type: 'dca',
      createdAt: START,
      params: { side: 'buy', levels: [{ priceOffsetPct: 0, amountQuote: 500 }], takeProfitPct: 1_000, stopLossPct: null, timeLimitSec: null }
    } as unknown as ExecutorConfig
    const state = runExecutorSimulation(SAW, executor, SAW[0].close)

    expect(state.kind === 'dca' && state.status).toBe('accumulating')
    expect(executorRealizedPnl(state)).toBe(0)
  })
})
