import { describe, expect, it } from 'vitest'
import { simulatePosition } from '../src/executors/engine'
import { ASSUMED_FUNDING_RATE, liquidationPrice } from '../shared/perp'
import { roundTripFee } from '../shared/fees'
import type { Candle, PositionExecutorParams } from '../shared/ipc'

// Leverage exists here only as a simulation, and its whole job is to show a beginner the thing
// that actually happens: the position is closed for them and the deposit is gone. So the tests
// that matter most are the ones asserting it does NOT quietly report a survivable outcome.

const H = 3600
const T = 1_700_000_000

function candles(rows: { o: number; h: number; l: number; c: number }[]): Candle[] {
  return rows.map((r, i) => ({ time: T + i * H, open: r.o, high: r.h, low: r.l, close: r.c, volume: 1 }))
}

/** A flat candle at `price`, for holding a position open without triggering anything. */
const flat = (price: number) => ({ o: price, h: price, l: price, c: price })

const params = (over: Partial<PositionExecutorParams> = {}): PositionExecutorParams => ({
  side: 'buy',
  entryPrice: null,
  amountQuote: 1_000,
  takeProfitPct: null,
  stopLossPct: null,
  timeLimitSec: null,
  trailingStop: null,
  ...over
})

describe('a position without leverage is exactly what it always was', () => {
  it('reports 1x, no liquidation price and no funding when leverage is absent', () => {
    // Every Position executor stored before leverage existed has no such field. It must load and
    // behave identically, not acquire a liquidation level it never had.
    const state = simulatePosition(candles([flat(100), { o: 100, h: 111, l: 100, c: 111 }]), params({ takeProfitPct: 10 }))

    expect(state.leverage).toBe(1)
    expect(state.liquidationPrice).toBeNull()
    expect(state.fundingPaid).toBe(0)
    expect(state.exitReason).toBe('take_profit')
  })

  it('books the same P&L at 1x as it did before leverage was introduced', () => {
    const state = simulatePosition(candles([flat(100), { o: 100, h: 111, l: 100, c: 111 }]), params({ takeProfitPct: 10 }))
    // Quantity is the deposit divided by the entry -- unlevered, exactly as it was. Read the exit
    // off the state rather than assuming 110: the target is entry * (1 + pct/100), which in binary
    // floating point is 110.00000000000001, and hard-coding the round number would be asserting
    // something the engine has never done.
    const qty = 1_000 / 100
    const exit = state.exitPrice as number

    expect(state.exitReason).toBe('take_profit')
    expect(state.realizedPnl).toBeCloseTo(qty * (exit - 100) - roundTripFee(qty, 100, exit), 9)
  })

  it('cannot be liquidated however far the price falls', () => {
    // Spot goes to zero and no further. A 1x position that reported a liquidation would be
    // inventing a loss the holder never took.
    const state = simulatePosition(candles([flat(100), flat(1)]), params())

    expect(state.exitReason).toBeNull()
    expect(state.status).toBe('open')
  })

  it('treats an unusable leverage as 1x rather than as no liquidation level', () => {
    // A NaN reaching the liquidation maths produces a NaN price, and no comparison against NaN is
    // ever true -- so the position would never be liquidated at all. Falling back to 1x is the
    // only safe direction for this particular value to fail in.
    const state = simulatePosition(candles([flat(100), flat(1)]), params({ leverage: Number.NaN }))

    expect(state.leverage).toBe(1)
    expect(state.liquidationPrice).toBeNull()
  })
})

describe('a leveraged position', () => {
  it('scales the profit with leverage', () => {
    const at1 = simulatePosition(candles([flat(100), { o: 100, h: 105, l: 100, c: 105 }]), params({ takeProfitPct: 5 }))
    const at10 = simulatePosition(
      candles([flat(100), { o: 100, h: 105, l: 100, c: 105 }]),
      params({ takeProfitPct: 5, leverage: 10 })
    )

    expect(at10.exitReason).toBe('take_profit')
    // Exactly ten times, and that is the point: the gross profit scales by ten and so does the fee
    // deducted from it, so the net lands on ten as well. If the fee were left at the unlevered
    // size the ratio would come out ABOVE ten -- leverage would look better than it is -- which is
    // what this equality is standing guard over.
    expect(at10.realizedPnl!).toBeCloseTo(at1.realizedPnl! * 10, 9)
  })

  it('scales the fee with leverage, which is the half nobody expects', () => {
    // 10x leverage is 10x the trading cost on the same deposit. A simulation that leveraged the
    // profit but not the cost would make leverage look strictly better than it is.
    const flatExit = simulatePosition(candles([flat(100), flat(100)]), params({ leverage: 10, timeLimitSec: H }))

    expect(flatExit.exitReason).toBe('time_limit')
    // No price movement at all, so the entire loss is cost.
    expect(flatExit.realizedPnl!).toBeCloseTo(-roundTripFee((1_000 * 10) / 100, 100, 100), 9)
  })

  it('reports the liquidation price it will actually be judged against', () => {
    const state = simulatePosition(candles([flat(100), flat(100)]), params({ leverage: 10 }))

    expect(state.liquidationPrice).toBeCloseTo(
      liquidationPrice({ entryPrice: 100, leverage: 10, side: 'buy' })!,
      9
    )
  })
})

describe('liquidation', () => {
  it('closes the position and takes the whole deposit', () => {
    // The lesson. Not a large loss -- all of it.
    const state = simulatePosition(candles([flat(100), { o: 100, h: 100, l: 89, c: 89 }]), params({ leverage: 10 }))

    expect(state.exitReason).toBe('liquidation')
    expect(state.realizedPnl).toBe(-1_000)
    expect(state.status).toBe('closed')
  })

  it('exits at the liquidation level, not wherever the candle happened to close', () => {
    // The exit price is what the card and the chart show. A liquidation reported at the close
    // would draw the exit somewhere the position was never closed -- often far below the level,
    // making it look as though the loss kept running after the exchange had already taken it.
    const liq = liquidationPrice({ entryPrice: 100, leverage: 10, side: 'buy' }) as number
    const state = simulatePosition(candles([flat(100), { o: 100, h: 100, l: 85, c: 86 }]), params({ leverage: 10 }))

    expect(state.exitReason).toBe('liquidation')
    expect(state.exitPrice).toBeCloseTo(liq, 9)
  })

  it('happens when the price merely touches the level, not only when it goes through', () => {
    // The boundary. At exactly the liquidation price the margin is exactly gone, and the exchange
    // closes the position -- it does not wait for one more tick. Requiring a strict crossing would
    // let a candle that bottomed precisely on the level report a position still open.
    const liq = liquidationPrice({ entryPrice: 100, leverage: 10, side: 'buy' }) as number
    const state = simulatePosition(candles([flat(100), { o: 100, h: 100, l: liq, c: 100 }]), params({ leverage: 10 }))

    expect(state.exitReason).toBe('liquidation')
  })

  it('touching the level counts on the short side too, where the price rises onto it', () => {
    // The same boundary mirrored. Asserted separately because the two sides are two comparisons,
    // and getting one of them right says nothing about the other.
    const liq = liquidationPrice({ entryPrice: 100, leverage: 10, side: 'sell' }) as number
    const state = simulatePosition(
      candles([flat(100), { o: 100, h: liq, l: 100, c: 100 }]),
      params({ side: 'sell', leverage: 10 })
    )

    expect(state.exitReason).toBe('liquidation')
  })

  it('is not rescued by a stop that fills exactly at the liquidation level', () => {
    // The other boundary, and the one that decides between losing part of the deposit and losing
    // all of it. A stop whose fill lands exactly on the level did not get there first -- the
    // margin is gone at that price. Only a fill strictly better than the level is protection.
    const liq = liquidationPrice({ entryPrice: 100, leverage: 10, side: 'buy' }) as number
    // Opening at the level makes the stop gap-fill there: stopFillPrice returns the open when the
    // market has already passed the stop, so protectiveFill lands exactly on liq.
    const state = simulatePosition(
      candles([flat(100), { o: liq, h: liq, l: liq, c: liq }]),
      params({ leverage: 10, stopLossPct: 5 })
    )

    expect(state.exitReason).toBe('liquidation')
    expect(state.realizedPnl).toBe(-1_000)
  })

  it('happens on a move of roughly 100/L percent, not on a large one', () => {
    // At 10x, a 10% dip. BTC does that in a day, and the position is not merely down -- it is over.
    const survives = simulatePosition(candles([flat(100), { o: 100, h: 100, l: 95, c: 95 }]), params({ leverage: 10 }))
    const dies = simulatePosition(candles([flat(100), { o: 100, h: 100, l: 90, c: 90 }]), params({ leverage: 10 }))

    expect(survives.exitReason).toBeNull()
    expect(dies.exitReason).toBe('liquidation')
  })

  it('comes far sooner at higher leverage', () => {
    const at5 = simulatePosition(candles([flat(100), { o: 100, h: 100, l: 97, c: 97 }]), params({ leverage: 5 }))
    const at50 = simulatePosition(candles([flat(100), { o: 100, h: 100, l: 97, c: 97 }]), params({ leverage: 50 }))

    expect(at5.exitReason).toBeNull()
    expect(at50.exitReason).toBe('liquidation')
  })

  it('works on the short side, where the price rises against the position', () => {
    const state = simulatePosition(
      candles([flat(100), { o: 100, h: 111, l: 100, c: 111 }]),
      params({ side: 'sell', leverage: 10 })
    )

    expect(state.exitReason).toBe('liquidation')
    expect(state.realizedPnl).toBe(-1_000)
  })

  it('outranks a take-profit reached in the same candle', () => {
    // OHLC cannot say which the market touched first. Of the two assumptions, only one can cost
    // someone real money by being wrong -- reporting the winning exit teaches a beginner the trade
    // was survivable when it may not have been.
    const state = simulatePosition(
      candles([flat(100), { o: 100, h: 120, l: 88, c: 100 }]),
      params({ leverage: 10, takeProfitPct: 5 })
    )

    expect(state.exitReason).toBe('liquidation')
  })

  it('does not happen when a stop would have filled first on the way down', () => {
    // A stop set inside the liquidation level is exactly what it is for. Price passes it first, so
    // the position exits there and never reaches liquidation -- and reporting a liquidation anyway
    // would tell the user their stop does not work.
    const state = simulatePosition(
      candles([flat(100), { o: 100, h: 100, l: 88, c: 88 }]),
      params({ leverage: 10, stopLossPct: 5 })
    )

    expect(state.exitReason).toBe('stop_loss')
    expect(state.realizedPnl!).toBeGreaterThan(-1_000)
  })

  it('happens anyway when the candle gaps straight past the stop and the liquidation together', () => {
    // The case that makes a stop no protection at all: the market reopens below both, so the stop
    // fills at the open -- which is already past the level where the position was closed out.
    const state = simulatePosition(
      candles([flat(100), { o: 80, h: 80, l: 80, c: 80 }]),
      params({ leverage: 10, stopLossPct: 5 })
    )

    expect(state.exitReason).toBe('liquidation')
    expect(state.realizedPnl).toBe(-1_000)
  })

  it('charges no funding on a liquidation, because the deposit is already all of it', () => {
    // Adding funding on top would report a loss larger than the money that existed.
    const state = simulatePosition(
      candles([flat(100), ...Array.from({ length: 30 }, () => flat(100)), { o: 100, h: 100, l: 85, c: 85 }]),
      params({ leverage: 10 })
    )

    expect(state.exitReason).toBe('liquidation')
    expect(state.fundingPaid).toBe(0)
    expect(state.realizedPnl).toBe(-1_000)
  })
})

describe('funding', () => {
  it('is charged on a leveraged position held past an eight-hour boundary', () => {
    // Nine hourly candles: one whole funding period.
    const rows = [flat(100), ...Array.from({ length: 9 }, () => flat(100))]
    const state = simulatePosition(candles(rows), params({ leverage: 10, timeLimitSec: 9 * H }))

    expect(state.exitReason).toBe('time_limit')
    expect(state.fundingPaid).toBeCloseTo(1_000 * 10 * ASSUMED_FUNDING_RATE, 9)
  })

  it('is not charged on a position closed before the first boundary', () => {
    // Funding happens at fixed times. Charging a fraction would make every short trade look
    // slightly worse than it was.
    const rows = [flat(100), flat(100), flat(100)]
    const state = simulatePosition(candles(rows), params({ leverage: 10, timeLimitSec: 2 * H }))

    expect(state.fundingPaid).toBe(0)
  })

  it('is never charged at 1x, because spot has no funding', () => {
    const rows = [flat(100), ...Array.from({ length: 30 }, () => flat(100))]
    const state = simulatePosition(candles(rows), params({ timeLimitSec: 30 * H }))

    expect(state.fundingPaid).toBe(0)
  })

  it('is paid by the long and received by the short', () => {
    const rows = [flat(100), ...Array.from({ length: 9 }, () => flat(100))]
    const long = simulatePosition(candles(rows), params({ leverage: 10, timeLimitSec: 9 * H }))
    const short = simulatePosition(candles(rows), params({ side: 'sell', leverage: 10, timeLimitSec: 9 * H }))

    expect(long.fundingPaid).toBeGreaterThan(0)
    expect(short.fundingPaid).toBe(-long.fundingPaid)
  })

  it('comes out of the realized P&L rather than being reported beside it', () => {
    // A funding figure shown next to a P&L that does not include it is a number the user has to
    // subtract themselves, and will not.
    const rows = [flat(100), ...Array.from({ length: 9 }, () => flat(100))]
    const state = simulatePosition(candles(rows), params({ leverage: 10, timeLimitSec: 9 * H }))
    const qty = (1_000 * 10) / 100

    expect(state.realizedPnl!).toBeCloseTo(-roundTripFee(qty, 100, 100) - state.fundingPaid, 9)
  })
})
