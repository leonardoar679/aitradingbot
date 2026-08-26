import { describe, expect, it } from 'vitest'
import { describeControllerOutcome, replayController } from '../src/backtest/controllerReplay'
import type { Candle, ControllerConfig, ExecutorConfig } from '../shared/ipc'

// Controllers could not be backtested at all: the Backtest page knew signal strategies and (since
// the last change) single executors, but nothing could answer "would these risk limits have fired,
// and would the group have been better off".

const H1 = 3600
const M1 = 60
const START = Date.UTC(2025, 0, 1) / 1000

function series(closes: number[], step = H1): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]
    return { time: START + i * step, open: prev, high: Math.max(c, prev), low: Math.min(c, prev), close: c, volume: 1 }
  })
}

/** A long that just holds: no take profit or stop of its own, so what it is worth tracks the
 * price and the controller is the only thing that can end it. */
function holdingLong(overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    id: 'e1',
    name: 'Holder',
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
    params: { side: 'buy', amountQuote: 1_000, entryPrice: 100, takeProfitPct: 1_000, stopLossPct: null, timeLimitSec: null, trailingStop: null },
    ...overrides
  } as ExecutorConfig
}

function controller(overrides: Partial<ControllerConfig> = {}): ControllerConfig {
  return {
    id: 'c1',
    name: 'Group',
    executorIds: ['e1'],
    riskControls: { globalStopLossPct: null, globalTakeProfitPct: null, maxDrawdownPct: null },
    status: 'active',
    createdAt: START,
    ...overrides
  }
}

/** 100 down to 80 over 200 hours: a long entered at 100 is 20% down by the end. */
const SLIDE = series(Array.from({ length: 200 }, (_, i) => 100 - i * 0.1))
/** 100 up to 120. */
const CLIMB = series(Array.from({ length: 200 }, (_, i) => 100 + i * 0.1))

describe('replaying a controller over a historical range', () => {
  it('measures against allocated capital, the way the live controller does', () => {
    // Not against the Backtest page's Starting Capital field: the running controller compares its
    // limits with P&L over allocated capital, and a backtest using a different denominator would
    // report percentages that cannot be compared with what it will actually do.
    const result = replayController(controller(), [holdingLong()], { BTCUSDT: SLIDE })

    expect(result?.allocatedQuote).toBe(1_000)
    // The curve starts just under the allocated capital, not on it: the position is already in
    // the market on the first candle, so it has paid the 0.2% round trip on 1,000.
    expect(result?.equityCurve[0].value).toBeCloseTo(998, 6)
    expect(result?.finalPnlPct).toBeCloseTo(((result?.finalPnlQuote ?? 0) / 1_000) * 100, 8)
  })

  it('adds up the executors it supervises', () => {
    const two = [holdingLong(), holdingLong({ id: 'e2', name: 'Second' })]
    const both = replayController(controller({ executorIds: ['e1', 'e2'] }), two, { BTCUSDT: SLIDE })
    const one = replayController(controller(), [holdingLong()], { BTCUSDT: SLIDE })

    expect(both?.allocatedQuote).toBe(2_000)
    expect(both?.finalPnlQuote).toBeCloseTo((one?.finalPnlQuote ?? 0) * 2, 6)
  })

  it('leaves everything running when no limit is configured', () => {
    const result = replayController(controller(), [holdingLong()], { BTCUSDT: SLIDE })

    expect(result?.breach).toBeNull()
    expect(result?.finalPnlQuote).toBeCloseTo(result?.uncontrolledPnlQuote ?? 0, 8)
    expect(describeControllerOutcome(result!)).toMatch(/No limit was ever crossed/)
  })

  it('refuses a controller with nothing it can replay rather than reporting a flat zero', () => {
    expect(replayController(controller({ executorIds: [] }), [holdingLong()], { BTCUSDT: SLIDE })).toBeNull()
    expect(replayController(controller(), [holdingLong()], {})).toBeNull()
  })
})

describe('when a limit is crossed', () => {
  it('stops at the loss limit instead of riding the fall to the end', () => {
    const result = replayController(controller({ riskControls: { globalStopLossPct: 10, globalTakeProfitPct: null, maxDrawdownPct: null } }), [holdingLong()], {
      BTCUSDT: SLIDE
    })

    expect(result?.breach?.breach.kind).toBe('stop-loss')
    expect(result?.finalPnlPct).toBeLessThanOrEqual(-10)
    // The whole point: a 10% stop must not end 20% down like the unmanaged run does.
    expect(result?.finalPnlPct).toBeGreaterThan(-12)
    expect(result?.uncontrolledPnlPct).toBeLessThan(-19)
  })

  it('holds the equity flat afterwards, because everything was closed', () => {
    const result = replayController(controller({ riskControls: { globalStopLossPct: 10, globalTakeProfitPct: null, maxDrawdownPct: null } }), [holdingLong()], {
      BTCUSDT: SLIDE
    })
    const after = result!.equityCurve.filter((p) => p.time >= result!.breach!.atTime)

    expect(after.length).toBeGreaterThan(1)
    expect(new Set(after.map((p) => p.value.toFixed(8))).size).toBe(1)
    expect(result?.finalPnlQuote).toBeCloseTo(result!.breach!.pnlQuote, 8)
  })

  it('keeps running the unmanaged comparison to the end of the range', () => {
    // Without this a user cannot tell whether the limit helped or cost them.
    const result = replayController(controller({ riskControls: { globalStopLossPct: 10, globalTakeProfitPct: null, maxDrawdownPct: null } }), [holdingLong()], {
      BTCUSDT: SLIDE
    })

    expect(result?.uncontrolledCurve.length).toBe(result?.equityCurve.length)
    expect(result?.uncontrolledCurve[result.uncontrolledCurve.length - 1].time).toBe(SLIDE[SLIDE.length - 1].time)
    expect(describeControllerOutcome(result!)).toMatch(/worth [\d.]+ more than letting them run/)
  })

  it('says plainly when the limit cost the group money', () => {
    // Up 12%, taken off the table at 10%, and the market kept climbing.
    const result = replayController(controller({ riskControls: { globalStopLossPct: null, globalTakeProfitPct: 10, maxDrawdownPct: null } }), [holdingLong()], {
      BTCUSDT: CLIMB
    })

    expect(result?.breach?.breach.kind).toBe('take-profit')
    expect(describeControllerOutcome(result!)).toMatch(/cost [\d.]+ against letting them run/)
  })

  it('reports each executor as the controller left it, not as it would have ended', () => {
    // Per-executor figures that ran past the stop would not add up to the total above it.
    const result = replayController(controller({ riskControls: { globalStopLossPct: 10, globalTakeProfitPct: null, maxDrawdownPct: null } }), [holdingLong()], {
      BTCUSDT: SLIDE
    })
    const summed = result!.executorOutcomes.reduce((sum, o) => sum + o.pnlQuote, 0)

    expect(summed).toBeCloseTo(result!.finalPnlQuote, 6)
    expect(result?.executorOutcomes[0].outcome).toMatch(/still open at the end/)
  })
})

describe('how often the limits are checked', () => {
  it('never checks more often than the running app does', () => {
    // The live scheduler snapshots every 5 minutes. Checking every 1-minute candle would report
    // stops on dips the real controller sleeps straight through -- a backtest that flatters the
    // risk controls is worse than none.
    const minutes = series(Array.from({ length: 240 }, (_, i) => 100 - i * 0.02), M1)
    const result = replayController(controller(), [holdingLong()], { BTCUSDT: minutes })
    const gaps = result!.equityCurve.slice(1, -1).map((p, i) => p.time - result!.equityCurve[i].time)

    expect(result?.candles).toBe(240)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(300)
  })

  it('checks the end of the range whatever the spacing, so the final figure is the range end', () => {
    const minutes = series(Array.from({ length: 242 }, (_, i) => 100 - i * 0.02), M1)
    const result = replayController(controller(), [holdingLong()], { BTCUSDT: minutes })

    expect(result?.equityCurve[result.equityCurve.length - 1].time).toBe(minutes[minutes.length - 1].time)
  })

  it('stays affordable on a long range with several executors', () => {
    const long = series(Array.from({ length: 9_000 }, (_, i) => 100 + Math.sin(i / 100) * 5))
    const three = [holdingLong(), holdingLong({ id: 'e2' }), holdingLong({ id: 'e3' })]
    const result = replayController(controller({ executorIds: ['e1', 'e2', 'e3'] }), three, { BTCUSDT: long })

    expect(result?.checks).toBeLessThanOrEqual(400)
    expect(result?.checks).toBeGreaterThanOrEqual(60)
    expect(result?.checkIntervalSec).toBeGreaterThan(H1)
  })
})

describe('executors the replay cannot cover', () => {
  it('names an executor whose market was not fetched instead of dropping it', () => {
    const mixed = [holdingLong(), holdingLong({ id: 'e2', name: 'Ether holder', symbol: 'ETHUSDT' })]
    const result = replayController(controller({ executorIds: ['e1', 'e2'] }), mixed, { BTCUSDT: SLIDE })

    expect(result?.skipped).toEqual([{ name: 'Ether holder', reason: 'No ETHUSDT candles in that range.' }])
    // Allocated capital counts only what was actually replayed, or every percentage would be
    // measured against capital the run never simulated.
    expect(result?.allocatedQuote).toBe(1_000)
  })

  it('names a spread executor rather than throwing halfway through the run', () => {
    const xemm = holdingLong({
      id: 'e2',
      name: 'Cross exchange',
      type: 'xemm',
      params: { makerExchange: 'binance', takerExchange: 'bybit', side: 'buy', orderAmountQuote: 500, minSpreadPct: 0.1, maxSpreadPct: 1, refreshIntervalSec: 10 }
    } as Partial<ExecutorConfig>)
    const result = replayController(controller({ executorIds: ['e1', 'e2'] }), [holdingLong(), xemm], { BTCUSDT: SLIDE })

    expect(result?.skipped[0].name).toBe('Cross exchange')
    expect(result?.skipped[0].reason).toMatch(/two markets at once/)
    expect(result?.executorOutcomes).toHaveLength(1)
  })
})
