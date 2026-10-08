import { describe, expect, it } from 'vitest'
import { evaluateWatcher, type WatcherBarriers } from '../electron/services/watcherEvaluation'
import type { Candle, PositionExecutorParams } from '../shared/ipc'
import { simulatePosition } from '../src/executors/engine'

// PAPER AND LIVE LEAVE A POSITION ALIKE (the V3 document, "paper/live parity").
//
// A paper position is judged on minute bars (src/executors/engine.ts simulatePosition); a real one
// on the last price, tick by tick (electron/services/watcherEvaluation.ts evaluateWatcher, ported
// from the engine). On the same bars, fed to the watcher as the prices each bar holds, the two must
// leave on the same bar, for the same reason, at the same level -- or a paper result says nothing
// about what real money would have done.
//
// A bar does not say in which order its prices came. Where that matters, the engine assumes the
// order that costs the most: the stop before the target, the peak before the fall. The tests that
// depend on it feed the watcher that order, and say so.

type Order = 'low-first' | 'high-first'

const c = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 1 })

const PARAMS: PositionExecutorParams = { side: 'buy', entryPrice: null, amountQuote: 100, takeProfitPct: 3, stopLossPct: 2, timeLimitSec: 600, trailingStop: null }

const TRAILING: PositionExecutorParams = { ...PARAMS, takeProfitPct: null, stopLossPct: 5, trailingStop: { activationPct: 2, trailPct: 1 } }

interface Exit {
  reason: string | null
  time: number | null
  /** The level the exit was taken at, for an exit that has one. A time limit leaves at whatever
   * the market is: paper takes the bar's close, the watcher its next tick, and neither is a level. */
  level: number | null
}

/** The watcher, run over the bars as ticks: each bar's low and high in the given order, then its
 * close, at the bar's time, with the peak carried from tick to tick as the live service keeps it.
 * The first exit, if any. */
function watchBars(candles: Candle[], params: PositionExecutorParams, order: Order): Exit {
  const entryPrice = candles[0].open
  let barriers: WatcherBarriers = {
    entryPrice,
    takeProfitPct: params.takeProfitPct,
    stopLossPct: params.stopLossPct,
    timeLimitSec: params.timeLimitSec,
    trailingStop: params.trailingStop,
    trailingPeakPrice: entryPrice,
    enteredAt: candles[0].time
  }
  for (const bar of candles) {
    const ticks = order === 'low-first' ? [bar.low, bar.high, bar.close] : [bar.high, bar.low, bar.close]
    for (const price of ticks) {
      const decision = evaluateWatcher(barriers, price, bar.time)
      barriers = { ...barriers, trailingPeakPrice: decision.newPeak }
      if (decision.reason === null) continue
      const level =
        decision.reason === 'stop_loss'
          ? entryPrice * (1 - (params.stopLossPct ?? 0) / 100)
          : decision.reason === 'take_profit'
            ? entryPrice * (1 + (params.takeProfitPct ?? 0) / 100)
            : decision.reason === 'trailing_stop'
              ? decision.newPeak * (1 - (params.trailingStop?.trailPct ?? 0) / 100)
              : null
      return { reason: decision.reason, time: bar.time, level }
    }
  }
  return { reason: null, time: null, level: null }
}

function agree(candles: Candle[], params: PositionExecutorParams = PARAMS, order: Order = 'low-first'): void {
  const paper = simulatePosition(candles, params)
  const live = watchBars(candles, params, order)
  expect(paper.status === 'closed' ? paper.exitReason : null).toBe(live.reason)
  expect(paper.closedAt).toBe(live.time)
  if (live.level !== null) expect(paper.exitPrice).toBeCloseTo(live.level, 8)
}

describe('paper and live leave a position alike', () => {
  it('on the stop, on the bar whose low touches it, at the stop', () => {
    agree([c(0, 100, 100.5, 99.5, 100), c(60, 100, 100.8, 99.1, 99.4), c(120, 99.4, 99.6, 98, 98.2)])
  })

  it('on the target, on the bar whose high touches it, at the target', () => {
    agree([c(0, 100, 101, 99.5, 100.8), c(60, 100.8, 102.2, 100.5, 102), c(120, 102, 103, 101.8, 102.9)])
  })

  it('on the stop where one bar reaches both, the stop being assumed first', () => {
    agree([c(0, 100, 103.5, 97.5, 100)])
  })

  it('on the stop where one fall reaches the stop and an armed trail, the stop first', () => {
    agree([c(0, 100, 101.8, 99.5, 101.8), c(60, 101.8, 102, 101.7, 101.9), c(120, 101.9, 101.95, 94.5, 95.2)], TRAILING)
  })

  it('on the time limit, on the bar that ends it', () => {
    agree([c(0, 100, 100.5, 99.5, 100.2), c(300, 100.2, 100.6, 99.8, 100.1), c(600, 100.1, 100.4, 99.9, 100.3)])
  })

  it('on a trailing stop armed by an earlier bar, from the peak that bar made', () => {
    agree([c(0, 100, 100.5, 99.5, 100.2), c(60, 100.2, 101.9, 100.1, 101.8), c(120, 101.8, 102, 101.7, 101.9), c(180, 101.9, 101.95, 100.9, 101.2)], TRAILING)
  })

  it('on a trailing stop the same bar armed and hit, the peak being assumed first', () => {
    const bars = [c(0, 100, 101.8, 99.5, 101.8), c(60, 101.8, 102.6, 101.2, 101.6)]
    agree(bars, TRAILING, 'high-first')
    // Had the low come first, the live position would still be open: the assumption is the
    // engine's, and it is the one that costs the most.
    expect(watchBars(bars, TRAILING, 'low-first').reason).toBeNull()
  })

  it('and both stay in a position nothing has ended', () => {
    agree([c(0, 100, 100.5, 99.5, 100.2), c(60, 100.2, 101, 99.9, 100.6)])
  })
})
