import type { Candle, ExecutorConfig, DcaLevel, GridExecutorParams, DcaExecutorParams, TwapExecutorParams } from '../../shared/ipc'
import type { GridExecutorState, DcaExecutorState, TwapExecutorState, ExecutorRuntimeState, GridLevelState } from './types'

const MAX_GRID_LEVELS = 40

// Pure, deterministic — mirrors backtest/engine.ts's runBacktest: replay candles from the
// executor's creation time through its rules, recomputing state from scratch every call. Nothing
// about "which levels filled" is ever persisted; it's derived from config + candle history, same
// honesty tradeoff as the bots' dry-run.

function buildGridLevels(params: GridExecutorParams): number[] {
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
  const isBuy = params.side === 'buy'

  for (const candle of candles) {
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
        realizedPnl += isBuy ? qty * (target - level.entryPrice) : qty * (level.entryPrice - target)
        level.status = 'pending'
        level.entryPrice = null
        level.filledAt = null
        closedLevels++
        openCount--
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
    closedLevels
  }
}

function dcaLevelPrice(basePrice: number, level: DcaLevel, side: 'buy' | 'sell'): number {
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
      const exitPrice = tpHit ? tpTarget : slHit ? (slTarget as number) : candle.close
      const totalQty = fills.reduce((sum, f) => sum + f.amountQuote / f.price, 0)
      realizedPnl = isBuy ? totalQty * (exitPrice - avg) : totalQty * (avg - exitPrice)
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

export function simulateTwap(candles: Candle[], params: TwapExecutorParams, createdAt: number): TwapExecutorState {
  const numOrders = Math.max(1, Math.floor(params.totalDurationSec / params.orderIntervalSec))
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

export function runExecutorSimulation(candles: Candle[], config: ExecutorConfig, basePrice: number): ExecutorRuntimeState {
  if (config.type === 'grid') return simulateGrid(candles, config.params as GridExecutorParams)
  if (config.type === 'dca') return simulateDca(candles, config.params as DcaExecutorParams, basePrice)
  return simulateTwap(candles, config.params as TwapExecutorParams, config.createdAt)
}
