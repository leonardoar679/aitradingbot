import { describe, expect, it } from 'vitest'
import { describeExecutorOutcome, replayExecutor } from '../src/backtest/executorReplay'
import { runExecutorSimulation } from '../src/executors/engine'
import { executorPnlFromState } from '../src/executors/executorPnl'
import type { Candle, ExecutorConfig } from '../shared/ipc'

// Executors could not be backtested at all: the Backtest page only knew the three signal
// strategies, and the executor simulators return a final state with no equity curve to draw.

const H1 = 3600
const START = Date.UTC(2025, 0, 1) / 1000

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]
    return { time: START + i * H1, open: prev, high: Math.max(c, prev), low: Math.min(c, prev), close: c, volume: 1 }
  })
}

function executor(overrides: Partial<ExecutorConfig>): ExecutorConfig {
  return {
    id: 'e1',
    name: 'test',
    type: 'position',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    status: 'active',
    mode: 'paper',
    keepPosition: false,
    createdAt: START,
    stoppedAt: null,
    params: { side: 'buy', amountQuote: 1_000, entryPrice: 100, takeProfitPct: 10, stopLossPct: 5, timeLimitSec: null, trailingStop: null },
    ...overrides
  } as ExecutorConfig
}

/** Climbs from 100 to 130, so a long entered at 100 takes its +10% target. */
const CLIMB = series(Array.from({ length: 400 }, (_, i) => 100 + i * 0.075))

describe('replaying a saved executor over a historical range', () => {
  it('produces an equity curve that starts at the capital and ends at the result', () => {
    const result = replayExecutor(CLIMB, executor({}), 10_000)

    expect(result).not.toBeNull()
    // Slightly BELOW the capital at the first point, not exactly on it: this executor's entry
    // price is touched by the opening candle, so it is already in the market and has already
    // paid the round-trip fee. A curve that started at exactly the capital would mean the
    // simulation was pricing the entry as free.
    expect(result?.equityCurve[0].value).toBeLessThan(10_000)
    expect(result?.equityCurve[0].value).toBeGreaterThan(9_990)
    expect(result?.equityCurve[result.equityCurve.length - 1].value).toBeCloseTo(result.finishingBalance, 6)
  })

  it('agrees with the executor simulator it is built on', () => {
    // The whole point of running the real simulators rather than reimplementing them as signals:
    // a backtest of an executor and the executor's own paper result must not disagree.
    const config = executor({})
    const result = replayExecutor(CLIMB, config, 10_000)
    const scoped = { ...config, createdAt: CLIMB[0].time }
    const state = runExecutorSimulation(CLIMB, scoped, CLIMB[0].close)
    const last = CLIMB[CLIMB.length - 1]

    expect(result?.netProfit).toBeCloseTo(executorPnlFromState(state, scoped.params, last.close, last.time), 8)
  })

  it('samples the curve instead of computing every candle', () => {
    // Each point costs a full replay, so a point per candle is quadratic. The cap is what keeps a
    // 90-day range instant.
    const result = replayExecutor(CLIMB, executor({}), 10_000)

    expect(result?.candles).toBe(400)
    expect(result?.samples).toBeLessThanOrEqual(200)
    expect(result?.samples).toBeGreaterThan(50)
  })

  it('always includes the final candle, so the reported result is exact', () => {
    const result = replayExecutor(CLIMB, executor({}), 10_000)

    expect(result?.equityCurve[result.equityCurve.length - 1].time).toBe(CLIMB[CLIMB.length - 1].time)
  })

  it('reports a drawdown as a fall from the running peak', () => {
    // Up then down: the curve has a real peak to fall from.
    const humped = series([...Array.from({ length: 200 }, (_, i) => 100 + i * 0.1), ...Array.from({ length: 200 }, (_, i) => 120 - i * 0.15)])
    const result = replayExecutor(humped, executor({ params: { side: 'buy', amountQuote: 1_000, entryPrice: 100, takeProfitPct: 500, stopLossPct: null, timeLimitSec: null, trailingStop: null } as ExecutorConfig['params'] }), 10_000)

    expect(result?.maxDrawdownPct).toBeLessThan(0)
  })

  it('refuses a range with no candles rather than inventing a flat result', () => {
    expect(replayExecutor([], executor({}), 10_000)).toBeNull()
  })
})

describe('running an executor whose schedule is relative to its creation', () => {
  it('starts a TWAP at the beginning of the range, not at its real creation date', () => {
    // A TWAP schedules slices from createdAt. Replaying a saved executor over a past window with
    // its real creation date would put every slice outside the window and report that it did
    // nothing at all.
    const twap = executor({
      type: 'twap',
      createdAt: START + 10_000 * H1,
      params: { side: 'buy', totalAmountQuote: 1_000, totalDurationSec: 100 * H1, orderIntervalSec: 10 * H1 }
    })
    const result = replayExecutor(CLIMB, twap, 10_000)

    expect(result?.finalState.kind).toBe('twap')
    expect(describeExecutorOutcome(result!.finalState)).toMatch(/[1-9]\d* of \d+ slices executed/)
  })
})

describe('saying what the executor did, in its own terms', () => {
  it('describes a grid by its level round trips', () => {
    const grid = executor({
      type: 'grid',
      params: { side: 'buy', startPrice: 100, endPrice: 130, levelSpreadPct: 2, takeProfitPct: 1, totalAmountQuote: 1_000, maxOpenOrders: 10, limitPrice: null }
    })
    const result = replayExecutor(CLIMB, grid, 10_000)

    expect(describeExecutorOutcome(result!.finalState)).toMatch(/level round trip/)
  })

  it('says plainly when nothing was ever bought', () => {
    // An entry price the range never reaches. "0.00%" alone would read as a strategy that traded
    // and broke even -- the same confusion the comparison table had.
    const never = executor({ params: { side: 'buy', amountQuote: 1_000, entryPrice: 1, takeProfitPct: 10, stopLossPct: 5, timeLimitSec: null, trailingStop: null } as ExecutorConfig['params'] })
    const result = replayExecutor(CLIMB, never, 10_000)

    expect(describeExecutorOutcome(result!.finalState)).toContain('never reached')
    expect(result?.netProfit).toBe(0)
  })

  it('describes a position that closed by naming the exit', () => {
    const result = replayExecutor(CLIMB, executor({}), 10_000)

    expect(describeExecutorOutcome(result!.finalState)).toMatch(/Entered and closed — take_profit/)
  })
})
