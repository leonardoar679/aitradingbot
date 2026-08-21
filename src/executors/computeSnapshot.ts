import type { ExecutorConfig, ExecutorSide, GridExecutorParams, DcaExecutorParams, TwapExecutorParams, PositionExecutorParams, OrderExecutorParams, XemmExecutorParams, ArbitrageExecutorParams } from '../../shared/ipc'
import { runExecutorSimulation } from './engine'
import { roundTripFee } from '../../shared/fees'
import { alignByTime, simulateXemm, simulateArbitrage } from './spreadEngine'

// Imperative counterparts to useExecutorSimulation/useSpreadExecutorSimulation for call sites
// outside a component's render lifecycle (stopping an executor, a Controller's periodic
// snapshot) — same one-shot fetch + dispatch, just not tied to a hook's poll/subscribe cycle.

async function fetchSingleMarketCandles(executor: ExecutorConfig) {
  const endSec = Math.floor(Date.now() / 1000)
  return window.api.market.fetchHistoricalRange(executor.exchange, executor.symbol, '1m', executor.createdAt, endSec)
}

export interface OpenPosition {
  side: ExecutorSide
  entryPrice: number
  amountQuote: number
}

/** Extracts "is there currently an open, unrealized position" for an executor about to be
 * stopped — used to hand it over to Positions → Inventory instead of silently discarding it.
 * Returns null for types with nothing to hand over (Grid/DCA/Market Making with no open
 * inventory, a Position not yet entered, an unfilled Order, or TWAP/XEMM/Arbitrage, which never
 * leave a lingering position at all). */
export async function computeExecutorPosition(executor: ExecutorConfig): Promise<OpenPosition | null> {
  if (executor.type === 'twap' || executor.type === 'xemm' || executor.type === 'arbitrage') return null

  const { candles } = await fetchSingleMarketCandles(executor)
  if (candles.length === 0) return null
  const basePrice = candles[0].close
  const state = runExecutorSimulation(candles, executor, basePrice)

  if (state.kind === 'grid') {
    const filled = state.levels.filter((l) => l.status === 'filled' && l.entryPrice !== null)
    if (filled.length === 0) return null
    const avgEntry = filled.reduce((sum, l) => sum + (l.entryPrice as number), 0) / filled.length
    const params = executor.params as GridExecutorParams
    return { side: params.side, entryPrice: avgEntry, amountQuote: filled.length * state.amountPerLevel }
  }

  if (state.kind === 'dca') {
    if (state.status !== 'accumulating' || state.avgEntryPrice === null) return null
    const params = executor.params as DcaExecutorParams
    return { side: params.side, entryPrice: state.avgEntryPrice, amountQuote: state.totalFilledQuote }
  }

  if (state.kind === 'position') {
    if (state.status !== 'open' || state.entryPrice === null) return null
    const params = executor.params as PositionExecutorParams
    return { side: state.side, entryPrice: state.entryPrice, amountQuote: params.amountQuote }
  }

  if (state.kind === 'order') {
    if (state.status !== 'filled' || state.fillPrice === null) return null
    const params = executor.params as OrderExecutorParams
    return { side: params.side, entryPrice: state.fillPrice, amountQuote: params.amountQuote }
  }

  // marketmaking — was previously missing entirely, silently discarding any accumulated
  // inventory on Stop regardless of "Keep position when stopped" (the checkbox is enabled for
  // this type, unlike TWAP/XEMM/Arbitrage, so leaving this branch out was a real bug, not an
  // intentional exclusion). Inventory can be net long or net short in the paper simulation.
  if (state.kind === 'marketmaking') {
    if (state.inventoryBaseQty === 0 || state.avgCost === null) return null
    const side: ExecutorSide = state.inventoryBaseQty > 0 ? 'buy' : 'sell'
    return { side, entryPrice: state.avgCost, amountQuote: Math.abs(state.inventoryBaseQty) * state.avgCost }
  }

  return null
}

/** Total realized + unrealized P&L for one executor, in its own quote asset — used by
 * ControllerScheduler to aggregate P&L across a group of executors on each snapshot tick. */
export async function computeExecutorPnl(executor: ExecutorConfig): Promise<number> {
  if (executor.type === 'xemm' || executor.type === 'arbitrage') {
    const params = executor.params as XemmExecutorParams | ArbitrageExecutorParams
    const endSec = Math.floor(Date.now() / 1000)
    const [a, b] = await Promise.all([
      window.api.market.fetchHistoricalRange(params.buyingMarket.exchange, params.buyingMarket.symbol, '1m', executor.createdAt, endSec),
      window.api.market.fetchHistoricalRange(params.sellingMarket.exchange, params.sellingMarket.symbol, '1m', executor.createdAt, endSec)
    ])
    const aligned = alignByTime(a.candles, b.candles)
    if (aligned.length === 0) return 0
    const state = executor.type === 'xemm' ? simulateXemm(aligned, params as XemmExecutorParams) : simulateArbitrage(aligned, params as ArbitrageExecutorParams)
    return state.realizedPnl
  }

  const { candles } = await fetchSingleMarketCandles(executor)
  if (candles.length === 0) return 0
  const basePrice = candles[0].close
  const current = candles[candles.length - 1].close
  const state = runExecutorSimulation(candles, executor, basePrice)

  if (state.kind === 'grid') {
    const params = executor.params as GridExecutorParams
    const isBuy = params.side === 'buy'
    const unrealized = state.levels
      .filter((l) => l.status === 'filled' && l.entryPrice !== null)
      .reduce((sum, l) => {
        const qty = state.amountPerLevel / (l.entryPrice as number)
        const grossLot = isBuy ? qty * (current - (l.entryPrice as number)) : qty * ((l.entryPrice as number) - current)
        return sum + grossLot - roundTripFee(qty, l.entryPrice as number, current)
      }, 0)
    return state.realizedPnl + unrealized
  }

  if (state.kind === 'dca') {
    if (state.realizedPnl !== null) return state.realizedPnl
    if (state.avgEntryPrice === null) return 0
    const params = executor.params as DcaExecutorParams
    const isBuy = params.side === 'buy'
    const totalQty = state.totalFilledQuote / state.avgEntryPrice
    const grossDca = isBuy ? totalQty * (current - state.avgEntryPrice) : totalQty * (state.avgEntryPrice - current)
    return grossDca - roundTripFee(totalQty, state.avgEntryPrice, current)
  }

  if (state.kind === 'twap') {
    if (state.vwap === null) return 0
    const params = executor.params as { side: ExecutorSide; totalAmountQuote: number }
    const isBuy = params.side === 'buy'
    const totalQty = state.fills.reduce((sum, f) => sum + f.amountQuote / f.price, 0)
    const grossTwap = isBuy ? totalQty * (current - state.vwap) : totalQty * (state.vwap - current)
    return grossTwap - roundTripFee(totalQty, state.vwap, current)
  }

  if (state.kind === 'position') {
    if (state.status === 'closed') return state.realizedPnl ?? 0
    if (state.status === 'open' && state.entryPrice !== null) {
      const params = executor.params as PositionExecutorParams
      const isBuy = state.side === 'buy'
      const qty = params.amountQuote / state.entryPrice
      const grossPos = isBuy ? qty * (current - state.entryPrice) : qty * (state.entryPrice - current)
      return grossPos - roundTripFee(qty, state.entryPrice, current)
    }
    return 0
  }

  if (state.kind === 'order') {
    if (state.status === 'filled' && state.fillPrice !== null) {
      const params = executor.params as OrderExecutorParams
      const isBuy = params.side === 'buy'
      const qty = params.amountQuote / state.fillPrice
      const grossOrder = isBuy ? qty * (current - state.fillPrice) : qty * (state.fillPrice - current)
      return grossOrder - roundTripFee(qty, state.fillPrice, current)
    }
    return 0
  }

  // marketmaking: realized P&L from closed round trips, plus unrealized on any net inventory
  // still held, marked against its average cost basis.
  const unrealized =
    state.inventoryBaseQty !== 0 && state.avgCost !== null
      ? state.inventoryBaseQty * (current - state.avgCost) - roundTripFee(Math.abs(state.inventoryBaseQty), state.avgCost, current)
      : 0
  return state.realizedPnl + unrealized
}

/** The quote-currency size an executor is configured to commit — used as the capital basis for
 * a Controller's risk controls (e.g. "stop at -5%" means -5% of this, not of the raw P&L number,
 * which has no natural zero-point to take a percentage of). */
export function executorAllocatedQuote(executor: ExecutorConfig): number {
  if (executor.type === 'grid') return (executor.params as GridExecutorParams).totalAmountQuote
  if (executor.type === 'dca') return (executor.params as DcaExecutorParams).levels.reduce((sum, l) => sum + l.amountQuote, 0)
  if (executor.type === 'twap') return (executor.params as TwapExecutorParams).totalAmountQuote
  if (executor.type === 'position') return (executor.params as PositionExecutorParams).amountQuote
  if (executor.type === 'order') return (executor.params as OrderExecutorParams).amountQuote
  return (executor.params as XemmExecutorParams | ArbitrageExecutorParams).orderAmountQuote
}
