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
import { roundTripFee } from '../../shared/fees'

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

    // Fill pending levels the candle's range touched, up to maxOpenOrders concurrently open.
    for (const level of levels) {
      if (openCount >= params.maxOpenOrders) break
      if (level.status !== 'pending') continue
      if (candle.low <= level.price && level.price <= candle.high) {
        level.status = 'filled'
        level.entryPrice = level.price
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
      const price = levelPrices[i]
      if (candle.low <= price && price <= candle.high) {
        filledFlags[i] = true
        fills.push({ price, amountQuote: params.levels[i].amountQuote, time: candle.time })
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
 * trailing-stop, and time-limit in that priority — the first barrier crossed closes the position. */
export function simulatePosition(candles: Candle[], params: PositionExecutorParams): PositionExecutorState {
  const isBuy = params.side === 'buy'
  let status: PositionExecutorState['status'] = 'pending'
  let entryPrice: number | null = null
  let enteredAt: number | null = null
  let trailingPeakPrice: number | null = null
  let exitReason: PositionExecutorState['exitReason'] = null
  let exitPrice: number | null = null
  let closedAt: number | null = null
  let realizedPnl: number | null = null

  for (const candle of candles) {
    if (status === 'pending') {
      if (params.entryPrice === null) {
        entryPrice = candle.open
        status = 'open'
        enteredAt = candle.time
        trailingPeakPrice = entryPrice
      } else if (candle.low <= params.entryPrice && params.entryPrice <= candle.high) {
        entryPrice = params.entryPrice
        status = 'open'
        enteredAt = candle.time
        trailingPeakPrice = entryPrice
      }
      if (status === 'pending') continue
    }

    if (status !== 'open' || entryPrice === null || enteredAt === null) continue

    if (trailingPeakPrice === null) trailingPeakPrice = entryPrice
    trailingPeakPrice = isBuy ? Math.max(trailingPeakPrice, candle.high) : Math.min(trailingPeakPrice, candle.low)

    const slTarget = params.stopLossPct !== null ? (isBuy ? entryPrice * (1 - params.stopLossPct / 100) : entryPrice * (1 + params.stopLossPct / 100)) : null
    const slHit = slTarget !== null && (isBuy ? candle.low <= slTarget : candle.high >= slTarget)

    const tpTarget = params.takeProfitPct !== null ? (isBuy ? entryPrice * (1 + params.takeProfitPct / 100) : entryPrice * (1 - params.takeProfitPct / 100)) : null
    const tpHit = tpTarget !== null && (isBuy ? candle.high >= tpTarget : candle.low <= tpTarget)

    let trailHit = false
    let trailTarget: number | null = null
    if (params.trailingStop !== null) {
      const activationTarget = isBuy
        ? entryPrice * (1 + params.trailingStop.activationPct / 100)
        : entryPrice * (1 - params.trailingStop.activationPct / 100)
      const activated = isBuy ? trailingPeakPrice >= activationTarget : trailingPeakPrice <= activationTarget
      if (activated) {
        trailTarget = isBuy
          ? trailingPeakPrice * (1 - params.trailingStop.trailPct / 100)
          : trailingPeakPrice * (1 + params.trailingStop.trailPct / 100)
        trailHit = isBuy ? candle.low <= trailTarget : candle.high >= trailTarget
      }
    }

    const timeUp = params.timeLimitSec !== null && candle.time - enteredAt >= params.timeLimitSec

    if (slHit || tpHit || trailHit || timeUp) {
      exitReason = slHit ? 'stop_loss' : tpHit ? 'take_profit' : trailHit ? 'trailing_stop' : 'time_limit'
      exitPrice = slHit
        ? stopFillPrice(candle.open, slTarget as number, isBuy)
        : tpHit
          ? (tpTarget as number)
          : trailHit
            ? stopFillPrice(candle.open, trailTarget as number, isBuy)
            : candle.close
      const posQty = params.amountQuote / entryPrice
      const grossPos = isBuy ? posQty * (exitPrice - entryPrice) : posQty * (entryPrice - exitPrice)
      realizedPnl = grossPos - roundTripFee(posQty, entryPrice, exitPrice)
      status = 'closed'
      closedAt = candle.time
      break
    }
  }

  return { kind: 'position', side: params.side, status, entryPrice, enteredAt, trailingPeakPrice, exitReason, exitPrice, closedAt, realizedPnl }
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
