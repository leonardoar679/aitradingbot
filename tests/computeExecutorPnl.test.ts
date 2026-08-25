import { beforeEach, describe, expect, it } from 'vitest'
import type { Candle, ExecutorConfig } from '../shared/ipc'
import { computeExecutorPnl } from '../src/executors/computeSnapshot'
import { roundTripFee } from '../shared/fees'
import { ASSUMED_FUNDING_RATE } from '../shared/perp'

// computeExecutorPnl is the number ControllerScheduler checks its risk controls against -- global
// stop-loss, take-profit and max-drawdown all read it. Nothing tested it. Flipping the sign of
// any of the five per-type P&L formulas, or dropping any of the five fee subtractions, left the
// whole suite green, so a controller could have fired its stop-loss on a WINNER and let a loser
// run without a single test noticing.
//
// Entry is 100 and the position is 100 quote throughout, so qty is exactly 1 and every
// expectation reads as gross-minus-fee at the 0.1%-per-side rate in shared/fees.ts.

const T = 1_700_000_000
const candle = (i: number, open: number, high: number, low: number, close: number): Candle => ({
  time: T + i * 60, open, high, low, close, volume: 1
})

// Flat at 100, then up to 110: a long is +10 gross here and a short is -10.
const FLAT_THEN_UP = [candle(0, 100, 100.5, 99.5, 100), candle(1, 100, 110.5, 100, 110)]

let series: Candle[] = FLAT_THEN_UP

function installWindowApi(): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { market: { fetchHistoricalRange: async () => ({ candles: series }) } }
  }
}

beforeEach(() => {
  series = FLAT_THEN_UP
  installWindowApi()
})

const base = {
  id: 'e1', name: 'E', exchange: 'binance', symbol: 'BTCUSDT',
  baseAsset: 'BTC', quoteAsset: 'USDT', createdAt: T, status: 'running',
  stoppedAt: null, keepPosition: false, mode: 'paper', liveOrder: null,
  pendingLiveOrderIds: [], liveWatcherId: null, liveExitResult: null,
  liveTwapRunId: null, liveTwapResult: null
}
const exec = (type: string, params: unknown): ExecutorConfig =>
  ({ ...base, type, params }) as unknown as ExecutorConfig

// A long entered at 100 and marked at 110: +10 gross, fee (100 + 110) x 0.001 = 0.21.
const LONG = 9.79
// The same position short: -10 gross, and the identical fee -- both legs are charged either way.
const SHORT = -10.21

describe('computeExecutorPnl marks an open position both ways', () => {
  const position = (side: string) =>
    exec('position', { side, entryPrice: null, amountQuote: 100, takeProfitPct: null, stopLossPct: null, timeLimitSec: null, trailingStop: null })

  it('nets the fee off a long', async () => {
    expect(await computeExecutorPnl(position('buy'))).toBeCloseTo(LONG, 10)
  })

  it('inverts the move for a short, and still charges both legs', async () => {
    expect(await computeExecutorPnl(position('sell'))).toBeCloseTo(SHORT, 10)
  })
})

describe('computeExecutorPnl marks a filled order', () => {
  const order = (side: string) => exec('order', { side, amountQuote: 100, executionStrategy: 'market', limitPrice: null })

  it('nets the fee off a long', async () => {
    expect(await computeExecutorPnl(order('buy'))).toBeCloseTo(LONG, 10)
  })

  it('inverts the move for a short', async () => {
    expect(await computeExecutorPnl(order('sell'))).toBeCloseTo(SHORT, 10)
  })
})

describe('computeExecutorPnl marks an accumulating DCA', () => {
  // takeProfitPct is set far out of reach so the ladder stays open and the number under test is
  // the UNREALIZED mark rather than a closed result.
  const dca = (side: string) =>
    exec('dca', { side, levels: [{ priceOffsetPct: 0, amountQuote: 100 }], takeProfitPct: 1000, stopLossPct: null, timeLimitSec: null })

  it('nets the fee off a long', async () => {
    expect(await computeExecutorPnl(dca('buy'))).toBeCloseTo(LONG, 10)
  })

  it('inverts the move for a short', async () => {
    expect(await computeExecutorPnl(dca('sell'))).toBeCloseTo(SHORT, 10)
  })
})

describe('computeExecutorPnl marks a TWAP against its VWAP', () => {
  // One slice, so the VWAP is just the first candle's close.
  const twap = (side: string) => exec('twap', { side, totalAmountQuote: 100, totalDurationSec: 60, orderIntervalSec: 60 })

  it('nets the fee off a long', async () => {
    expect(await computeExecutorPnl(twap('buy'))).toBeCloseTo(LONG, 10)
  })

  it('inverts the move for a short', async () => {
    expect(await computeExecutorPnl(twap('sell'))).toBeCloseTo(SHORT, 10)
  })
})

describe('computeExecutorPnl adds a grid realized and unrealized', () => {
  // Levels [100, 105, 110] carrying 100 quote each.
  const grid = (side: string) =>
    exec('grid', { side, startPrice: 100, endPrice: 110, totalAmountQuote: 300, maxOpenOrders: 10, levelSpreadPct: 5, takeProfitPct: 5, limitPrice: null })

  // Candle 0 fills level 100. Candle 1 runs to 106, which takes that level's +5% profit AND
  // re-fills 100 and 105 on the way, so the grid ends with realized profit and two open lots.
  const GRID_SERIES = [candle(0, 100, 100.5, 99.5, 100), candle(1, 100, 106, 100, 106)]

  it('reports the closed profit plus the mark on both open lots', async () => {
    series = GRID_SERIES
    // realized  1 x (105 - 100) - (100 + 105) x 0.001                = 4.795
    // lot @100  1 x (106 - 100) - (100 + 106) x 0.001                = 5.794
    // lot @105  (100/105) x (106 - 105) - (100/105) x 211 x 0.001    = 0.7514285714...
    expect(await computeExecutorPnl(grid('buy'))).toBeCloseTo(11.340428571428571, 10)
  })

  it('marks a short grid the other way', async () => {
    series = GRID_SERIES
    // No level takes profit (a sell grid's target is BELOW the fill), so both lots are open and
    // both are underwater at 106: -6.206 and -1.1533333333...
    expect(await computeExecutorPnl(grid('sell'))).toBeCloseTo(-7.359333333333333, 10)
  })

  it('does not silently drop the realized half', async () => {
    series = GRID_SERIES
    const total = await computeExecutorPnl(grid('buy'))
    // The unrealized half alone is 6.5454...; returning only that would look plausible.
    expect(total).toBeGreaterThan(7)
  })
})
describe('computeExecutorPnl on a leveraged position', () => {
  // This number settles the paper account when an executor stops, and is what a Controller's
  // stop-loss is compared against. Reporting a tenth of a 10x position's loss would let a breach
  // that should have stopped a whole group of executors go unnoticed.
  const levered = (side: string, leverage: number, amountQuote = 100) =>
    exec('position', {
      side,
      entryPrice: null,
      amountQuote,
      takeProfitPct: null,
      stopLossPct: null,
      timeLimitSec: null,
      trailingStop: null,
      leverage
    })

  it('scales a gain by the leverage, fee included', async () => {
    // Same +10 gross and 0.21 fee as the 1x case, times five.
    expect(await computeExecutorPnl(levered('buy', 5))).toBeCloseTo(LONG * 5, 10)
  })

  it('scales a loss by the leverage', async () => {
    expect(await computeExecutorPnl(levered('sell', 5))).toBeCloseTo(SHORT * 5, 10)
  })

  it('is unchanged when leverage is absent, as it is on every position saved before it existed', async () => {
    expect(await computeExecutorPnl(levered('buy', undefined as unknown as number))).toBeCloseTo(LONG, 10)
  })

  it('reports a liquidation as the whole deposit and no worse', async () => {
    // A 50x short is liquidated by a 2% rally, and this series is a 10% one. The figure that goes
    // back to the account has to be exactly the margin: an isolated-margin position cannot lose
    // past what was put into it, and reporting the raw -510 would take money the account never
    // staked. No floor is applied here to achieve that -- the replay closes the position itself.
    const pnl = await computeExecutorPnl(levered('sell', 50))

    expect(pnl).toBe(-100)
  })

  it('charges funding on a leveraged position that has been open past a funding boundary', async () => {
    // The 1-minute candles above never reach one. A day of them does.
    series = [
      candle(0, 100, 100.5, 99.5, 100),
      { time: T + 24 * 3600, open: 100, high: 100, low: 100, close: 100, volume: 1 }
    ]
    const flatPnl = await computeExecutorPnl(levered('buy', 10, 1_000))
    // No price move at all, so the entire figure is cost: the round-trip fee plus three funding
    // periods on 10,000 of notional.
    const fee = roundTripFee(100, 100, 100)
    const funding = 10_000 * ASSUMED_FUNDING_RATE * 3

    expect(flatPnl).toBeCloseTo(-fee - funding, 9)
    expect(funding).toBeGreaterThan(0)
  })

  it('charges no funding at 1x, where there is none', async () => {
    series = [
      candle(0, 100, 100.5, 99.5, 100),
      { time: T + 24 * 3600, open: 100, high: 100, low: 100, close: 100, volume: 1 }
    ]

    expect(await computeExecutorPnl(levered('buy', 1, 1_000))).toBeCloseTo(-roundTripFee(10, 100, 100), 9)
  })
})
