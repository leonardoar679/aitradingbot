import type {
  Candle,
  ExecutorConfig,
  DcaLevel,
  GridExecutorParams,
  DcaExecutorParams,
  TwapExecutorParams,
  PositionExecutorParams,
  OrderExecutorParams,
  MarketMakingExecutorParams
} from '../../shared/ipc'
import type {
  GridExecutorState,
  DcaExecutorState,
  TwapExecutorState,
  PositionExecutorState,
  OrderExecutorState,
  MarketMakingExecutorState,
  SingleMarketExecutorState,
  GridLevelState
} from './types'
import { positionSlippageRate, roundTripFee } from '../../shared/fees'
import {
  ASSUMED_FUNDING_RATE,
  fundingCost,
  fundingPeriodsBetween,
  liquidationPrice,
  notionalFor,
  resolveLeverage
} from '../../shared/perp'

const MAX_GRID_LEVELS = 40

// Pure, deterministic — mirrors backtest/engine.ts's runBacktest: replay candles from the
// executor's creation time through its rules, recomputing state from scratch every call. Nothing
// about "which levels filled" is ever persisted; it's derived from config + candle history, same
// honesty tradeoff as the bots' dry-run.

// Exported for reuse by the live Grid executor path (ExecutorsPage.tsx) and its chart rendering
// (ExecutorDetailView.tsx) — unlike DCA, Grid's level prices are already absolute values sitting
// in params (startPrice/endPrice/levelSpreadPct), so there's no reference-price capture needed;
// this can be recomputed directly from an executor's params at any time.
export function buildGridLevels(params: GridExecutorParams): number[] {
  const { startPrice, endPrice, levelSpreadPct } = params
  const lo = Math.min(startPrice, endPrice)
  const hi = Math.max(startPrice, endPrice)
  if (hi <= lo || levelSpreadPct <= 0) return [lo, hi]

  const stepCount = Math.round(Math.log(hi / lo) / Math.log(1 + levelSpreadPct / 100))
  const count = Math.min(MAX_GRID_LEVELS, Math.max(2, stepCount))
  const levels: number[] = []
  for (let i = 0; i <= count; i++) {
    levels.push(lo + ((hi - lo) * i) / count)
  }
  return levels
}

/** Fill price for a stop that the candle traded through. A stop order becomes a market order
 * when triggered, so a candle that *opens* beyond the stop never trades at the stop price at all
 * — the fill is the open, and it is worse. Reporting the stop price there invents protection the
 * position did not have, and it does so only on losing exits.
 *
 * src/backtest/engine.ts has always modelled this (Math.min(open, stopPrice) on its ATR stop);
 * the executor simulations did not, so the same gap produced two different answers depending on
 * which engine you asked. Measured on live 1m data: Binance BTCUSDT opens ≥0.1% from the prior
 * close on 1.8% of candles, but thin Korean pairs are far worse — GOPAX BTC-KRW had 16 of 23
 * slots missing entirely, 18% of candles opening ≥0.1% away and 4.5% opening ≥0.5% away. */
export function stopFillPrice(candleOpen: number, stopPrice: number, isBuy: boolean): number {
  return isBuy ? Math.min(candleOpen, stopPrice) : Math.max(candleOpen, stopPrice)
}

/** What a resting limit order at `price` fills at on this candle, or null if it does not fill.
 *
 * A limit order is not "did this candle print exactly at my price". It is a standing bid or offer,
 * and the straddle test `low <= price && price <= high` gets two cases wrong -- both of which
 * leave the order pending for good:
 *
 *   marketable on arrival   a buy limit above the market is filled at once, at the market
 *   gapped clean through    a buy at 95 and a candle spanning 88-91 is taken at 95 on the way past
 *
 * simulateOrder was fixed for exactly this and says so at length. Grid levels, DCA levels and a
 * position's entry price all still required the straddle, so the same order filled or sat pending
 * depending on which executor was holding it -- and a Position whose entry price was above the
 * market reported "the entry price was never reached" forever.
 *
 * The fill is the limit price whenever the candle reaches it from the correct side, and the
 * candle's open when the order was already marketable as the candle opened: you are filled at the
 * market, not at a price you were merely willing to pay. That is the opposite of a stop, which
 * triggers into a market order and takes whatever the gap leaves (see stopFillPrice). */
export function limitFillPrice(candle: Candle, price: number, isBuy: boolean): number | null {
  const reached = isBuy ? candle.low <= price : candle.high >= price
  if (!reached) return null
  const marketableAtOpen = isBuy ? candle.open <= price : candle.open >= price
  return marketableAtOpen ? candle.open : price
}

export function simulateGrid(candles: Candle[], params: GridExecutorParams): GridExecutorState {
  const levelPrices = buildGridLevels(params)
  const amountPerLevel = params.totalAmountQuote / levelPrices.length
  const levels: GridLevelState[] = levelPrices.map((price) => ({
    price,
    status: 'pending',
    filledAt: null,
    entryPrice: null
  }))

  let realizedPnl = 0
  let closedLevels = 0
  let stoppedAt: number | null = null
  const isBuy = params.side === 'buy'

  /** A grid level is a recurring rung, not a one-shot order: it re-arms after every take profit
   * and buys again each time the price comes back to it. So it is only a resting order once the
   * market has actually been on the far side of it -- a buy grid does not put bids ABOVE the
   * market. Without this, treating a level as an ordinary limit order fills every rung above the
   * price at once and collapses the whole grid into a single bulk buy at the open.
   *
   * Armed off the candle's open rather than its high, so a rung is never armed and filled by the
   * same spike that first reached it: the grid would not have had an order resting there yet. */
  const armed = levels.map(() => false)

  for (const candle of candles) {
    // Stop Price already hit on a prior candle -- the grid is frozen for good, nothing left to do.
    if (stoppedAt !== null) break

    // Close filled levels whose take-profit target was reached this candle.
    let openCount = levels.filter((l) => l.status === 'filled').length
    for (const level of levels) {
      if (level.status !== 'filled' || level.entryPrice === null) continue
      const target = isBuy
        ? level.entryPrice * (1 + params.takeProfitPct / 100)
        : level.entryPrice * (1 - params.takeProfitPct / 100)
      const hit = isBuy ? candle.high >= target : candle.low <= target
      if (hit) {
        const qty = amountPerLevel / level.entryPrice
        const grossTp = isBuy ? qty * (target - level.entryPrice) : qty * (level.entryPrice - target)
        realizedPnl += grossTp - roundTripFee(qty, level.entryPrice, target)
        level.status = 'pending'
        level.entryPrice = null
        level.filledAt = null
        closedLevels++
        openCount--
      }
    }

    // Stop Price: closes every currently-filled level at once and freezes the grid permanently --
    // unlike take-profit, this isn't a per-level exit a level can cycle back through.
    if (params.limitPrice !== null) {
      const stopHit = isBuy ? candle.low <= params.limitPrice : candle.high >= params.limitPrice
      if (stopHit) {
        for (const level of levels) {
          if (level.status !== 'filled' || level.entryPrice === null) continue
          const qty = amountPerLevel / level.entryPrice
          const fill = stopFillPrice(candle.open, params.limitPrice, isBuy)
          const grossStop = isBuy ? qty * (fill - level.entryPrice) : qty * (level.entryPrice - fill)
          realizedPnl += grossStop - roundTripFee(qty, level.entryPrice, fill)
          level.status = 'pending'
          level.entryPrice = null
          level.filledAt = null
          closedLevels++
        }
        stoppedAt = candle.time
        continue
      }
    }

    for (const [i, level] of levels.entries()) {
      if (!armed[i]) armed[i] = isBuy ? candle.open >= level.price : candle.open <= level.price
    }

    // Fill armed levels the candle reached, up to maxOpenOrders concurrently open.
    for (const [i, level] of levels.entries()) {
      if (openCount >= params.maxOpenOrders) break
      if (level.status !== 'pending' || !armed[i]) continue
      const fill = limitFillPrice(candle, level.price, isBuy)
      if (fill !== null) {
        level.status = 'filled'
        level.entryPrice = fill
        level.filledAt = candle.time
        openCount++
      }
    }
  }

  return {
    kind: 'grid',
    levels,
    amountPerLevel,
    filledCount: levels.filter((l) => l.status === 'filled').length,
    realizedPnl,
    closedLevels,
    stoppedAt
  }
}

// Exported for reuse by the live DCA executor path (ExecutorsPage.tsx), which needs the exact
// same offset-from-reference-price formula to compute each level's real limit price -- there's
// no candle replay live, so the "reference price" is a real ticker snapshot captured once at
// creation (ExecutorConfig.liveDcaBasePrice) instead of candles[0].close.
export function dcaLevelPrice(basePrice: number, level: DcaLevel, side: 'buy' | 'sell'): number {
  const sign = side === 'buy' ? -1 : 1
  return basePrice * (1 + (sign * level.priceOffsetPct) / 100)
}

export function simulateDca(candles: Candle[], params: DcaExecutorParams, basePrice: number): DcaExecutorState {
  const levelPrices = params.levels.map((l) => dcaLevelPrice(basePrice, l, params.side))
  const filledFlags = new Array(params.levels.length).fill(false)
  const fills: DcaExecutorState['fills'] = []
  const isBuy = params.side === 'buy'

  let status: DcaExecutorState['status'] = 'accumulating'
  let closedAt: number | null = null
  let closePrice: number | null = null
  let realizedPnl: number | null = null
  let firstFillTime: number | null = null

  function avgEntryPrice(): number | null {
    if (fills.length === 0) return null
    const totalQuote = fills.reduce((sum, f) => sum + f.amountQuote, 0)
    const totalQty = fills.reduce((sum, f) => sum + f.amountQuote / f.price, 0)
    return totalQty > 0 ? totalQuote / totalQty : null
  }

  outer: for (const candle of candles) {
    for (let i = 0; i < params.levels.length; i++) {
      if (filledFlags[i]) continue
      const fill = limitFillPrice(candle, levelPrices[i], isBuy)
      if (fill !== null) {
        filledFlags[i] = true
        fills.push({ price: fill, amountQuote: params.levels[i].amountQuote, time: candle.time })
        if (firstFillTime === null) firstFillTime = candle.time
      }
    }

    if (fills.length === 0) continue

    const avg = avgEntryPrice()
    if (avg === null) continue

    const tpTarget = isBuy ? avg * (1 + params.takeProfitPct / 100) : avg * (1 - params.takeProfitPct / 100)
    const tpHit = isBuy ? candle.high >= tpTarget : candle.low <= tpTarget

    const slTarget =
      params.stopLossPct !== null ? (isBuy ? avg * (1 - params.stopLossPct / 100) : avg * (1 + params.stopLossPct / 100)) : null
    const slHit = slTarget !== null && (isBuy ? candle.low <= slTarget : candle.high >= slTarget)

    const timeUp = params.timeLimitSec !== null && firstFillTime !== null && candle.time - firstFillTime >= params.timeLimitSec

    if (tpHit || slHit || timeUp) {
      // Stop-loss resolves before take-profit when one candle hits both. The path inside a
      // candle is unknowable, so the losing one is assumed first — the same order simulatePosition
      // and the backtest engine already use. DCA alone read it the other way, turning an ambiguous
      // candle into a win here and a loss there for the same price action.
      const exitPrice = slHit
        ? stopFillPrice(candle.open, slTarget as number, isBuy)
        : tpHit
          ? tpTarget
          : candle.close
      const totalQty = fills.reduce((sum, f) => sum + f.amountQuote / f.price, 0)
      const grossDca = isBuy ? totalQty * (exitPrice - avg) : totalQty * (avg - exitPrice)
      realizedPnl = grossDca - roundTripFee(totalQty, avg, exitPrice)
      status = 'closed'
      closedAt = candle.time
      closePrice = exitPrice
      break outer
    }
  }

  return {
    kind: 'dca',
    fills,
    levelPrices,
    avgEntryPrice: avgEntryPrice(),
    totalFilledQuote: fills.reduce((sum, f) => sum + f.amountQuote, 0),
    status,
    closedAt,
    closePrice,
    realizedPnl
  }
}

/** Shared with the live TWAP creation path (ExecutorsPage.tsx) so paper and live can never
 * disagree on how many slices a given duration/interval works out to. */
export function twapNumOrders(params: TwapExecutorParams): number {
  return Math.max(1, Math.floor(params.totalDurationSec / params.orderIntervalSec))
}

export function simulateTwap(candles: Candle[], params: TwapExecutorParams, createdAt: number): TwapExecutorState {
  const numOrders = twapNumOrders(params)
  const amountPerOrder = params.totalAmountQuote / numOrders
  const fills: TwapExecutorState['fills'] = []

  let candleIdx = 0
  for (let i = 0; i < numOrders; i++) {
    const sliceTime = createdAt + i * params.orderIntervalSec
    while (candleIdx < candles.length - 1 && candles[candleIdx].time < sliceTime) candleIdx++
    const candle = candles[candleIdx]
    if (!candle || candle.time < sliceTime) break // hasn't reached this slice yet
    fills.push({ price: candle.close, amountQuote: amountPerOrder, time: candle.time })
  }

  const totalQuote = fills.reduce((sum, f) => sum + f.amountQuote, 0)
  const totalQty = fills.reduce((sum, f) => sum + f.amountQuote / f.price, 0)
  const vwap = totalQty > 0 ? totalQuote / totalQty : null

  return {
    kind: 'twap',
    fills,
    numOrders,
    amountPerOrder,
    vwap,
    progressPct: (fills.length / numOrders) * 100,
    done: fills.length >= numOrders
  }
}

/** Triple Barrier Method: enters at `entryPrice` when touched (or the first candle's open when
 * `entryPrice` is null, i.e. a market entry), then each candle checks stop-loss, take-profit,
 * trailing-stop, and time-limit in that priority — the first barrier crossed closes the position.
 *
 * An entry with an expiry (`entryExpiresAt`) is abandoned at the first candle that opens at or
 * after it with nothing filled: the position closes with no entry, no exit and no P&L. A candle
 * that opens before the expiry can still fill it, whenever inside that candle the price got there.
 *
 * An entry with a range (`entryRange`) is a recommendation's: it is taken in the first candle that
 * trades inside the range, at the open when that is inside it and otherwise at the edge the price
 * came in by. Neither of the two rules above it is the same thing. A market entry takes the next
 * open wherever the price has gone, and a limit above the market is filled at once: both would
 * enter a position the recommendation never asked for.
 *
 * A position that carries a slippage rate (`slippageRate`) pays it on every market fill: its entry,
 * a stop, a trailing stop and the time limit each fill that much worse than their price, whichever
 * way the order goes; a take-profit is a resting limit and is paid exactly. Its levels stay where
 * the market price put them (`levelPrice`, the fill before slippage), so what the entry gave up is
 * lost whichever level ends it, as it would be against a recommendation's own levels. That is how a
 * recommendation is scored (shared/aiOpportunityOutcome.ts), every entry included, so a paper trade
 * made from one costs what its score says. Without a rate a position fills at its prices, and its
 * levels are measured from its entry, as they always were.
 *
 * A position that carries a fill already taken (`entryFill`, the streamed price the second it was
 * made) is in the market from the minute containing it, at that price plus its slippage, and the
 * three entry rules above are not consulted. That minute can stop it and cannot pay its target:
 * its high may have come before the fill, which is the rule a recommendation's score keeps for an
 * entry inside a bar. Candles before that minute are not read. */
export function simulatePosition(candles: Candle[], params: PositionExecutorParams): PositionExecutorState {
  const isBuy = params.side === 'buy'
  const leverage = resolveLeverage(params.leverage)
  const slippage = positionSlippageRate(params)
  /** `buying` is true for a long's entry and a short's exit. */
  const marketFill = (price: number, buying: boolean): number => price * (buying ? 1 + slippage : 1 - slippage)
  let status: PositionExecutorState['status'] = 'pending'
  let entryPrice: number | null = null
  let levelPrice: number | null = null
  let enteredAt: number | null = null
  let trailingPeakPrice: number | null = null
  let exitReason: PositionExecutorState['exitReason'] = null
  let exitPrice: number | null = null
  let closedAt: number | null = null
  let realizedPnl: number | null = null
  let liqPrice: number | null = null
  let fundingPaid = 0

  const fill = params.entryFill ?? null
  const filled = fill !== null && Number.isFinite(fill.price) && fill.price > 0 && Number.isFinite(fill.at)
  if (filled) {
    levelPrice = fill.price
    entryPrice = marketFill(fill.price, isBuy)
    status = 'open'
    enteredAt = Math.floor(fill.at / 60) * 60
    trailingPeakPrice = fill.price
    liqPrice = liquidationPrice({ entryPrice, leverage, side: params.side })
  }

  for (const candle of candles) {
    if (filled && enteredAt !== null && candle.time < enteredAt) continue
    const entryMinute = filled && candle.time === enteredAt
    if (status === 'pending') {
      if (params.entryExpiresAt != null && candle.time >= params.entryExpiresAt) {
        status = 'closed'
        exitReason = 'entry_expired'
        closedAt = candle.time
        realizedPnl = 0
        break
      }
      if (params.entryRange != null) {
        // A recommendation's entry: the first candle that trades inside the range, from either
        // side. The rule it is scored by, so that the position and its score agree on whether and
        // where it entered.
        const { min, max } = params.entryRange
        if (candle.low <= max && candle.high >= min) {
          levelPrice = candle.open >= min && candle.open <= max ? candle.open : candle.open > max ? max : min
        }
      } else if (params.entryPrice === null) {
        levelPrice = candle.open
      } else {
        levelPrice = limitFillPrice(candle, params.entryPrice, isBuy)
      }
      if (levelPrice === null) continue
      entryPrice = marketFill(levelPrice, isBuy)
      status = 'open'
      enteredAt = candle.time
      trailingPeakPrice = levelPrice
      liqPrice = liquidationPrice({ entryPrice: entryPrice as number, leverage, side: params.side })
    }

    if (status !== 'open' || entryPrice === null || levelPrice === null || enteredAt === null) continue

    if (trailingPeakPrice === null) trailingPeakPrice = levelPrice
    if (!entryMinute) trailingPeakPrice = isBuy ? Math.max(trailingPeakPrice, candle.high) : Math.min(trailingPeakPrice, candle.low)

    const slTarget = params.stopLossPct !== null ? (isBuy ? levelPrice * (1 - params.stopLossPct / 100) : levelPrice * (1 + params.stopLossPct / 100)) : null
    const slHit = slTarget !== null && (isBuy ? candle.low <= slTarget : candle.high >= slTarget)

    const tpTarget = params.takeProfitPct !== null ? (isBuy ? levelPrice * (1 + params.takeProfitPct / 100) : levelPrice * (1 - params.takeProfitPct / 100)) : null
    const tpHit = !entryMinute && tpTarget !== null && (isBuy ? candle.high >= tpTarget : candle.low <= tpTarget)

    let trailHit = false
    let trailTarget: number | null = null
    if (params.trailingStop !== null) {
      const activationTarget = isBuy
        ? levelPrice * (1 + params.trailingStop.activationPct / 100)
        : levelPrice * (1 - params.trailingStop.activationPct / 100)
      const activated = isBuy ? trailingPeakPrice >= activationTarget : trailingPeakPrice <= activationTarget
      if (activated) {
        trailTarget = isBuy
          ? trailingPeakPrice * (1 - params.trailingStop.trailPct / 100)
          : trailingPeakPrice * (1 + params.trailingStop.trailPct / 100)
        trailHit = !entryMinute && (isBuy ? candle.low <= trailTarget : candle.high >= trailTarget)
      }
    }

    const timeUp = params.timeLimitSec !== null && candle.time - enteredAt >= params.timeLimitSec

    const liqHit = liqPrice !== null && (isBuy ? candle.low <= liqPrice : candle.high >= liqPrice)

    if (slHit || tpHit || trailHit || timeUp || liqHit) {
      // The price a stop would actually have filled at, worked out before anything else, because
      // it decides whether the stop saved the position or arrived too late. A stop set inside the
      // liquidation level normally fills first -- price passes it on the way down -- but a candle
      // that GAPS straight through both fills the stop at the open, and if that open is already
      // past the liquidation level the position was gone before the stop could execute.
      const protectiveFill = slHit
        ? stopFillPrice(candle.open, slTarget as number, isBuy)
        : trailHit
          ? stopFillPrice(candle.open, trailTarget as number, isBuy)
          : null
      const savedByStop =
        protectiveFill !== null && liqPrice !== null && (isBuy ? protectiveFill > liqPrice : protectiveFill < liqPrice)

      // Liquidation outranks a take-profit in the same candle. OHLC cannot say which the market
      // reached first, and of the two assumptions only one can cost someone real money by being
      // wrong -- a simulation that quietly reports the winning exit teaches a beginner that the
      // trade was survivable when it may not have been.
      if (liqHit && !savedByStop) {
        exitReason = 'liquidation'
        exitPrice = liqPrice as number
        // The whole margin, and no more: an isolated-margin position cannot lose past what was
        // put into it. The exchange also keeps the maintenance margin and a liquidation fee, so
        // the true outcome is this bad and occasionally slightly worse -- never better.
        realizedPnl = -params.amountQuote
        // No funding is added on top. Not because a liquidated position owes none -- it owes every
        // period it was open for -- but because the margin is already gone in full and there is
        // nothing left for it to come out of. (fundingPaid is still 0 here; this branch breaks
        // before the funding calculation below ever runs.)
        status = 'closed'
        closedAt = candle.time
        break
      }

      exitReason = slHit ? 'stop_loss' : tpHit ? 'take_profit' : trailHit ? 'trailing_stop' : 'time_limit'
      exitPrice = slHit
        ? marketFill(protectiveFill as number, !isBuy)
        : tpHit
          ? (tpTarget as number)
          : trailHit
            ? marketFill(protectiveFill as number, !isBuy)
            : marketFill(candle.close, !isBuy)
      // Sized on the NOTIONAL, so both the profit and the fee scale with leverage. The fee part
      // is the half nobody expects: 10x leverage is 10x the trading cost on the same deposit.
      const posQty = notionalFor(params.amountQuote, leverage) / entryPrice
      const grossPos = isBuy ? posQty * (exitPrice - entryPrice) : posQty * (entryPrice - exitPrice)
      status = 'closed'
      closedAt = candle.time
      fundingPaid =
        leverage === 1
          ? 0
          : fundingCost({
              notionalQuote: notionalFor(params.amountQuote, leverage),
              fundingRate: ASSUMED_FUNDING_RATE,
              periods: fundingPeriodsBetween(enteredAt, candle.time),
              side: params.side
            })
      realizedPnl = grossPos - roundTripFee(posQty, entryPrice, exitPrice) - fundingPaid
      break
    }
  }

  return {
    kind: 'position',
    side: params.side,
    status,
    entryPrice,
    levelPrice,
    enteredAt,
    trailingPeakPrice,
    exitReason,
    exitPrice,
    closedAt,
    realizedPnl,
    leverage,
    liquidationPrice: liqPrice,
    fundingPaid
  }
}

/** `market`/`limit_chaser` fill at the first candle's open — without a real order book,
 * "chasing" the best price isn't modelable, so it's treated as an immediate market fill.
 * `limit`/`limit_maker` fill the first time a candle's range touches `limitPrice`. */
export function simulateOrder(candles: Candle[], params: OrderExecutorParams): OrderExecutorState {
  if (candles.length === 0) return { kind: 'order', status: 'pending', fillPrice: null, filledAt: null }

  if (params.executionStrategy === 'market' || params.executionStrategy === 'limit_chaser') {
    const first = candles[0]
    return { kind: 'order', status: 'filled', fillPrice: first.open, filledAt: first.time }
  }

  const limitPrice = params.limitPrice
  if (limitPrice === null) return { kind: 'order', status: 'pending', fillPrice: null, filledAt: null }

  const isBuy = params.side === 'buy'
  const first = candles[0]
  // Placement. A plain limit order priced through the market is marketable and executes straight
  // away at the market, not at the limit — the same rule the Trade page's classifyPaperOrder
  // already applies. limit_maker is post-only: an exchange rejects it outright rather than
  // letting it take, so it never fills here on placement. (That rejection has no state of its
  // own yet, so it shows as never filling.)
  const marketableNow = isBuy ? limitPrice >= first.open : limitPrice <= first.open
  if (marketableNow) {
    return params.executionStrategy === 'limit'
      ? { kind: 'order', status: 'filled', fillPrice: first.open, filledAt: first.time }
      : // Rejected outright — it never reaches the book, so it cannot fill later either.
        { kind: 'order', status: 'pending', fillPrice: null, filledAt: null }
  }

  for (const candle of candles) {
    // Once resting, the order fills whenever price reaches it — including a candle that gaps
    // clean through without ever printing inside its range. Requiring limitPrice to sit within
    // [low, high] missed exactly that: a buy limit at 95 and a candle spanning 88-91 left the
    // order pending forever, when sellers sweeping down the book would have taken the 95 bid on
    // the way past. The fill is at the limit price, not the open: a resting order holds its own
    // price and is hit there. That is the opposite of a stop, which triggers into a market order
    // and takes whatever the gap leaves (see stopFillPrice).
    const reached = isBuy ? candle.low <= limitPrice : candle.high >= limitPrice
    if (reached) {
      return { kind: 'order', status: 'filled', fillPrice: limitPrice, filledAt: candle.time }
    }
  }
  return { kind: 'order', status: 'pending', fillPrice: null, filledAt: null }
}

/** Classic two-sided market making: quotes a bid/ask around the live price at a fixed spread,
 * refreshed on an interval. Fills use exactly the standing bid/ask when a candle's range touches
 * them (no order-book depth/partial fills, same simplification every other executor makes).
 * Inventory is tracked with a running average-cost basis so P&L splits correctly into realized
 * (closed/reduced exposure) and the caller can derive unrealized from `inventoryBaseQty` and the
 * latest price — the standard accounting method, not specific to any one platform. Optional
 * inventory-skew shifts the quoted mid price to bias fills back toward a target inventory. */
export function simulateMarketMaking(candles: Candle[], params: MarketMakingExecutorParams): MarketMakingExecutorState {
  let bidPrice: number | null = null
  let askPrice: number | null = null
  let standingQty = 0
  let nextRefreshTime = candles.length > 0 ? candles[0].time : 0
  let inventoryBaseQty = 0
  let avgCost: number | null = null
  let realizedPnl = 0
  let filledBuys = 0
  let filledSells = 0
  let refreshedAt: number | null = null
  // A quote that has been hit is gone until it is requoted. Without this, the same standing
  // order re-filled on every candle its price stayed crossed: with orderRefreshSec 300 on 1m
  // candles one order could fill five times, each adding a full orderAmountQuote of inventory
  // and paying a full round trip. A three-day run that quotes 864 times reported 2094 buys and
  // 2094 sells, and the fees on trades that never happened dominated its P&L.
  let bidFilled = false
  let askFilled = false

  const allowBuy = params.side === 'both' || params.side === 'buy'
  const allowSell = params.side === 'both' || params.side === 'sell'

  for (const candle of candles) {
    if (bidPrice === null || candle.time >= nextRefreshTime) {
      standingQty = candle.close > 0 ? params.orderAmountQuote / candle.close : 0
      let skew = 0
      if (params.inventoryTargetPct !== null && standingQty > 0) {
        const targetQty = (params.inventoryTargetPct / 100) * standingQty
        const rawSkew = (inventoryBaseQty - targetQty) / standingQty
        skew = Math.max(-1, Math.min(1, rawSkew)) * params.inventorySkewIntensity
      }
      const skewedMid = candle.close * (1 - skew * (params.spreadPct / 100))
      const halfSpreadFrac = params.spreadPct / 200
      bidPrice = skewedMid * (1 - halfSpreadFrac)
      askPrice = skewedMid * (1 + halfSpreadFrac)
      refreshedAt = candle.time
      nextRefreshTime = candle.time + Math.max(1, params.orderRefreshSec)
      bidFilled = false
      askFilled = false
    }

    if (allowBuy && !bidFilled && bidPrice !== null && candle.low <= bidPrice) {
      filledBuys++
      bidFilled = true
      if (inventoryBaseQty >= 0) {
        const newQty = inventoryBaseQty + standingQty
        avgCost = avgCost === null ? bidPrice : (avgCost * inventoryBaseQty + bidPrice * standingQty) / newQty
        inventoryBaseQty = newQty
      } else {
        const coverQty = Math.min(standingQty, -inventoryBaseQty)
        realizedPnl += coverQty * ((avgCost as number) - bidPrice) - roundTripFee(coverQty, avgCost as number, bidPrice)
        inventoryBaseQty += standingQty
        avgCost = inventoryBaseQty > 0 ? bidPrice : inventoryBaseQty === 0 ? null : avgCost
      }
    }

    if (allowSell && !askFilled && askPrice !== null && candle.high >= askPrice) {
      filledSells++
      askFilled = true
      if (inventoryBaseQty <= 0) {
        const newQty = inventoryBaseQty - standingQty
        avgCost = avgCost === null ? askPrice : (avgCost * -inventoryBaseQty + askPrice * standingQty) / -newQty
        inventoryBaseQty = newQty
      } else {
        const closeQty = Math.min(standingQty, inventoryBaseQty)
        realizedPnl += closeQty * (askPrice - (avgCost as number)) - roundTripFee(closeQty, avgCost as number, askPrice)
        inventoryBaseQty -= standingQty
        avgCost = inventoryBaseQty < 0 ? askPrice : inventoryBaseQty === 0 ? null : avgCost
      }
    }
  }

  const inventoryPct = standingQty > 0 ? (inventoryBaseQty / standingQty) * 100 : null

  return { kind: 'marketmaking', bidPrice, askPrice, inventoryBaseQty, inventoryPct, avgCost, filledBuys, filledSells, realizedPnl, refreshedAt }
}

/** Dispatches the single-market executor types only — xemm/arbitrage need two candle series at
 * once and are simulated separately via spreadEngine.ts + useSpreadExecutorSimulation. */
export function runExecutorSimulation(candles: Candle[], config: ExecutorConfig, basePrice: number): SingleMarketExecutorState {
  if (config.type === 'grid') return simulateGrid(candles, config.params as GridExecutorParams)
  if (config.type === 'dca') return simulateDca(candles, config.params as DcaExecutorParams, basePrice)
  if (config.type === 'twap') return simulateTwap(candles, config.params as TwapExecutorParams, config.createdAt)
  if (config.type === 'position') return simulatePosition(candles, config.params as PositionExecutorParams)
  if (config.type === 'order') return simulateOrder(candles, config.params as OrderExecutorParams)
  if (config.type === 'marketmaking') return simulateMarketMaking(candles, config.params as MarketMakingExecutorParams)
  throw new Error(`${config.type} executors are simulated via useSpreadExecutorSimulation, not runExecutorSimulation`)
}
