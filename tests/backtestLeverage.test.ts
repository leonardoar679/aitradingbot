import { describe, expect, it } from 'vitest'
import { runBacktest, type BacktestResult } from '../src/backtest/engine'
import { ASSUMED_FUNDING_RATE, FUNDING_INTERVAL_SEC, liquidationPrice } from '../shared/perp'
import { FEE_RATE } from '../shared/fees'
import type { Candle } from '../shared/ipc'

// A backtest is where someone finds out what leverage does to a strategy before it does it to
// their money, so the results that matter most here are the discouraging ones: the run that ends
// at zero, and the trade list that stops because there is nothing left to trade with.

const H4 = 4 * 3600
const START = 1_700_000_000

const candles = (closes: number[]): Candle[] =>
  closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]
    return {
      time: START + i * H4,
      open: prev,
      high: Math.max(c, prev) * 1.002,
      low: Math.min(c, prev) * 0.998,
      close: c,
      volume: 1
    }
  })

/** A deterministic wobble, so the indicators have real movement to read and the entries below
 * happen for the strategy's own reasons rather than because the data was built to force them. */
const wobble = (n: number, base: number, amp: number, from = 0): number[] =>
  Array.from({ length: n }, (_, i) => base + amp * Math.sin((i + from) / 3))

// The default strategy warms up over a 200-bar regime EMA, which is longer than any series worth
// writing out here; Bollinger Breakout warms up in 20 and trades on all three of these.
const STRATEGY = 'bollinger-breakout'
const CAPITAL = 10_000

const RISE = candles([...wobble(40, 100, 2), ...wobble(30, 112, 2, 40), ...wobble(40, 130, 2, 70)])
const FALL = candles([...wobble(40, 100, 2), ...wobble(30, 112, 2, 40), ...wobble(40, 80, 2, 70)])
const run = (series: Candle[], leverage?: number) =>
  runBacktest(series, STRATEGY, { startingBalance: CAPITAL, leverage })

describe('a backtest without leverage is the backtest it always was', () => {
  it('produces identical results at 1x and with no leverage asked for', () => {
    const plain = run(RISE)
    const oneX = run(RISE, 1)

    expect(oneX.stats).toEqual(plain.stats)
    expect(oneX.trades).toEqual(plain.trades)
    expect(oneX.equityCurve).toEqual(plain.equityCurve)
  })

  it('cannot be liquidated by any fall, because spot goes to zero and no further', () => {
    expect(run(FALL).trades.every((t) => t.exitReason !== 'liquidation')).toBe(true)
  })

  it('treats an unusable leverage as 1x rather than as no liquidation level', () => {
    // A NaN reaching the liquidation maths gives a NaN level, and no comparison against NaN is
    // ever true -- the run would simply never be liquidated. Falling back to 1x is the only safe
    // direction for this value to fail in.
    expect(run(FALL, Number.NaN).stats).toEqual(run(FALL).stats)
    expect(run(FALL, 1_000).stats).toEqual(run(FALL).stats)
  })

  it('charges no funding, so a trade costs exactly its two fees', () => {
    const trade = run(RISE).trades[0]
    const gross = trade.qty * (trade.exitPrice - trade.entryPrice)
    // Spot's own convention, unchanged: the entry fee comes out of the cash before it buys
    // anything, so it is charged on the capital rather than on what the capital ended up holding.
    const entryFee = CAPITAL * FEE_RATE
    const exitFee = trade.qty * trade.exitPrice * FEE_RATE

    expect(trade.pnl).toBeCloseTo(gross - entryFee - exitFee, 9)
  })
})

describe('a leveraged backtest', () => {
  it('sizes the position on the notional, and pays the fee on it', () => {
    const t1 = run(RISE).trades[0]
    const t5 = run(RISE, 5).trades[0]

    // 5x controls five times the market on the same capital -- and is charged five times the fee
    // for the privilege, which is the half that makes leverage worse rather than better.
    expect(t5.qty * t5.entryPrice).toBeCloseTo(CAPITAL * 5, 6)
    expect(t5.qty * t5.entryPrice * FEE_RATE).toBeCloseTo(CAPITAL * 5 * FEE_RATE, 9)

    // Spot is deliberately not the same shape and is left exactly as it was: there the fee is
    // taken out of the cash first and the remainder buys the position, so the position is very
    // slightly smaller than the capital rather than equal to it. It is a real difference between
    // holding an asset and posting margin against one, not a rounding artefact.
    expect(t1.qty * t1.entryPrice).toBeCloseTo(CAPITAL * (1 - FEE_RATE), 6)
  })

  it('turns a survivable loss into a bigger one at the same prices', () => {
    // Same series, same trades, same exits -- only the size differs.
    const at1 = run(FALL)
    const at10 = run(FALL, 10)

    expect(at10.trades[0].exitReason).toBe(at1.trades[0].exitReason)
    expect(at10.trades[0].pnl).toBeLessThan(at1.trades[0].pnl * 9)
  })

  it('charges funding for every whole period a position was held', () => {
    const trade = run(RISE, 10).trades[0]
    const gross = trade.qty * (trade.exitPrice - trade.entryPrice)
    const fees = trade.qty * (trade.entryPrice + trade.exitPrice) * FEE_RATE
    const periods = Math.floor((trade.exitTime - trade.entryTime) / FUNDING_INTERVAL_SEC)
    const funding = trade.qty * trade.entryPrice * ASSUMED_FUNDING_RATE * periods

    expect(periods).toBeGreaterThan(0)
    expect(trade.pnl).toBeCloseTo(gross - fees - funding, 9)
  })
})

describe('being liquidated', () => {
  // 50x puts the liquidation level about 1.6% below the entry -- inside the strategy's own stop,
  // which is what makes the stop no protection at all.
  const wiped = run(FALL, 50)
  const killer = wiped.trades.find((t) => t.exitReason === 'liquidation')

  it('happens, where the same fall at the same prices only bruised a spot run', () => {
    expect(killer).toBeDefined()
    expect(run(FALL).trades.every((t) => t.exitReason !== 'liquidation')).toBe(true)
  })

  it('costs the whole account, not the part the liquidation price implies', () => {
    // Priced at the level, the position still nominally holds the maintenance margin back -- at
    // 50x that is a fifth of the deposit. Nobody is handed a fifth of their money back for being
    // wiped out, and the paper Position executor books -amountQuote for the same reason.
    expect(killer?.pnl).toBe(-CAPITAL)
    expect(killer?.returnPct).toBe(-100)
  })

  it('exits at the liquidation level, not at whatever the candle closed at', () => {
    const expected = liquidationPrice({ entryPrice: killer!.entryPrice, leverage: 50, side: 'buy' })

    expect(killer?.exitPrice).toBeCloseTo(expected as number, 9)
  })

  it('ends the run at zero and never below it', () => {
    // An equity curve that went negative would be describing a debt the account never took on.
    expect(wiped.equityCurve[wiped.equityCurve.length - 1].value).toBe(0)
    expect(Math.min(...wiped.equityCurve.map((p) => p.value))).toBe(0)
  })

  it('stops the run trading, rather than filling the list with empty round trips', () => {
    // RISE rather than FALL, because the strategy really does signal another entry in the climb
    // that follows: without the guard that entry opens a zero-sized position on a zero balance,
    // and the win rate is then computed over round trips that moved no money at all.
    const afterWipe = run(RISE, 50)
    const kill = afterWipe.trades.findIndex((t) => t.exitReason === 'liquidation')

    expect(kill).toBeGreaterThanOrEqual(0)
    expect(afterWipe.trades.slice(kill + 1)).toHaveLength(0)
  })

  it('leaves a lower leverage on the same prices still alive', () => {
    // The other half of the lesson: the fall itself did not have to be fatal. The leverage was.
    const survived = run(FALL, 5)

    expect(survived.trades.every((t) => t.exitReason !== 'liquidation')).toBe(true)
    expect(survived.stats.finishingBalance).toBeGreaterThan(0)
  })
})

// A steady climb after the entry, so the strategy neither exits on a signal nor is stopped out --
// the position is simply still open when the data runs out. Every case below appends one final
// candle to it, which is the only way to put the stop and the liquidation level in the same
// candle: the strategy sets its own stop from ATR, so the levels have to be read back out of a
// run rather than chosen.
const CLIMB = candles([...wobble(40, 100, 2), ...Array.from({ length: 20 }, (_, i) => 112 + i * 0.5)])
const CLIMB_OPEN = runBacktest(CLIMB, STRATEGY, {
  startingBalance: CAPITAL,
  leverage: 10,
  forceCloseAtEnd: false
}).openPositionAtEnd

/** CLIMB plus one final candle, for putting a chosen price inside the open position's range. */
function withFinalCandle(low: number, close: number): Candle[] {
  const last = CLIMB[CLIMB.length - 1]
  return [...CLIMB, { time: last.time + H4, open: last.close, high: last.close, low, close, volume: 1 }]
}

/** The leverage whose liquidation level lands exactly on `price`, for the boundary cases. */
const leverageWhoseLiquidationIs = (price: number, entryPrice: number): number =>
  1 / (1 + 0.004 - price / entryPrice)

describe('a stop and a liquidation reached in the same candle', () => {
  const entry = CLIMB_OPEN!.entryPrice
  const stop = CLIMB_OPEN!.stopPrice
  // A collapse far below both levels.
  const COLLAPSE = withFinalCandle(entry * 0.7, entry * 0.7)

  it('exits at the stop when the stop is inside the liquidation level', () => {
    // What a stop is for. At 10x the level is about 9.6% below the entry and this stop is nearer
    // than that, so price reaches it first and the position leaves there -- reporting a
    // liquidation anyway would tell the holder their stop does not work.
    const r = runBacktest(COLLAPSE, STRATEGY, { startingBalance: CAPITAL, leverage: 10 })
    const last = r.trades[r.trades.length - 1]

    expect(last.exitReason).toBe('stop_loss')
    expect(last.exitPrice).toBeCloseTo(stop, 9)
    expect(last.pnl).toBeGreaterThan(-CAPITAL)
  })

  it('is liquidated anyway when the level is nearer than the stop', () => {
    // At 50x the level sits about 1.6% below the entry -- inside the stop, which makes the stop
    // no protection at all. This is the case that turns a bad trade into the end of the account.
    const r = runBacktest(COLLAPSE, STRATEGY, { startingBalance: CAPITAL, leverage: 50 })
    const last = r.trades[r.trades.length - 1]

    expect(last.exitReason).toBe('liquidation')
    expect(last.pnl).toBe(-CAPITAL)
  })

  it('is liquidated when the stop would have filled exactly at the level, not one tick better', () => {
    // The boundary between losing part of the account and losing all of it. A fill landing exactly
    // on the level did not get there first: the margin is already gone at that price.
    const exact = leverageWhoseLiquidationIs(stop, entry)
    const r = runBacktest(COLLAPSE, STRATEGY, { startingBalance: CAPITAL, leverage: exact })
    const last = r.trades[r.trades.length - 1]

    expect(exact).toBeGreaterThan(10)
    expect(last.exitReason).toBe('liquidation')
    expect(last.pnl).toBe(-CAPITAL)
  })
})

describe('the liquidation level itself', () => {
  const entry = CLIMB_OPEN!.entryPrice

  it('is crossed by a price that merely touches it', () => {
    // At exactly the level the margin is exactly gone, and the exchange closes the position -- it
    // does not wait for one more tick. A wick down to the level and straight back up still ends
    // the position, which is precisely the way real liquidations catch people out.
    const liq = entry * (1 - 1 / 50 + 0.004)
    const wick = withFinalCandle(liq, entry * 1.1)
    const r = runBacktest(wick, STRATEGY, { startingBalance: CAPITAL, leverage: 50 })

    expect(r.trades[r.trades.length - 1].exitReason).toBe('liquidation')
  })

  it('is not crossed by a price that stops just above it', () => {
    const liq = entry * (1 - 1 / 50 + 0.004)
    const nearMiss = withFinalCandle(liq * 1.0001, entry * 1.1)
    const r = runBacktest(nearMiss, STRATEGY, { startingBalance: CAPITAL, leverage: 50 })

    expect(r.trades.every((t) => t.exitReason !== 'liquidation')).toBe(true)
  })
})

describe('the cost of simply holding a leveraged position', () => {
  it('is subtracted from the equity curve as it accrues, not all at the exit', () => {
    // A curve that ignored funding would draw the position as though holding it were free, then
    // drop by the whole accumulated amount at the close -- a cliff that never happened.
    const r = runBacktest(CLIMB, STRATEGY, { startingBalance: CAPITAL, leverage: 10, forceCloseAtEnd: false })
    const open = r.openPositionAtEnd as NonNullable<typeof r.openPositionAtEnd>
    const lastCandle = CLIMB[CLIMB.length - 1]
    const periods = Math.floor((lastCandle.time - open.entryTime) / FUNDING_INTERVAL_SEC)
    const funding = open.qty * open.entryPrice * ASSUMED_FUNDING_RATE * periods
    const withoutCosts = CAPITAL + open.qty * (lastCandle.close - open.entryPrice)

    expect(periods).toBeGreaterThan(0)
    expect(r.equityCurve[r.equityCurve.length - 1].value).toBeCloseTo(
      withoutCosts - CAPITAL * 10 * FEE_RATE - funding,
      6
    )
  })

  it('can finish the account on its own, on a chart that never went against it', () => {
    // The case the liquidation level cannot see: at 100x the entry fee is a tenth of the margin
    // and funding takes another 1% of it every eight hours, so a position held long enough is
    // over without the price ever falling to the level. Left unchecked the run reports an open
    // position with less than nothing behind it for the rest of the history.
    const creep = candles([...wobble(40, 100, 2), ...Array.from({ length: 400 }, (_, i) => 112 + i * 0.001)])
    const r = runBacktest(creep, STRATEGY, { startingBalance: CAPITAL, leverage: 100, forceCloseAtEnd: false })
    const killer = r.trades.find((t) => t.exitReason === 'liquidation')

    expect(killer).toBeDefined()
    expect(killer?.pnl).toBe(-CAPITAL)
    expect(Math.min(...r.equityCurve.map((p) => p.value))).toBe(0)
  })
})
describe('the most a single trade can cost', () => {
  it('is the whole account, even when the exit was a stop rather than a liquidation', () => {
    // The awkward case, and worth being explicit about. The liquidation level in shared/perp.ts
    // is priced off the entry alone; it cannot see the fees and funding already taken out of the
    // margin, which is why that file says the real level is always at least as close as the one
    // it reports. Held long enough at high leverage those costs are most of the margin, so a stop
    // that fills just ABOVE the modelled level still adds up to more than the account holds --
    // and reality would have liquidated the position before the stop was ever reached.
    //
    // The label here is the optimistic one. The money is not: this is what stops the run
    // reporting a loss bigger than the money that existed.
    const climb = candles([...wobble(40, 100, 2), ...Array.from({ length: 60 }, (_, i) => 112 + i * 0.5)])
    const open = runBacktest(climb, STRATEGY, {
      startingBalance: CAPITAL,
      leverage: 10,
      forceCloseAtEnd: false
    }).openPositionAtEnd as NonNullable<BacktestResult['openPositionAtEnd']>
    const last = climb[climb.length - 1]
    const collapse: Candle[] = [
      ...climb,
      { time: last.time + H4, open: last.close, high: last.close, low: open.entryPrice * 0.7, close: open.entryPrice * 0.7, volume: 1 }
    ]
    // Just inside the level, so the stop is reached first and the exit really is a stop.
    const justInside = leverageWhoseLiquidationIs(open.stopPrice, open.entryPrice) * 0.999
    const r = runBacktest(collapse, STRATEGY, { startingBalance: CAPITAL, leverage: justInside })
    const trade = r.trades[r.trades.length - 1]

    expect(trade.exitReason).toBe('stop_loss')
    expect(trade.pnl).toBe(-CAPITAL)
    expect(r.stats.finishingBalance).toBe(0)
  })
})
