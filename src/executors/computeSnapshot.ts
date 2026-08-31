import type { ExecutorConfig, ExecutorSide, HistoricalRangeResult, GridExecutorParams, DcaExecutorParams, TwapExecutorParams, PositionExecutorParams, OrderExecutorParams, XemmExecutorParams, ArbitrageExecutorParams } from '../../shared/ipc'
import { executorPnlFromState, executorRealizedPnl } from './executorPnl'
import { runExecutorSimulation } from './engine'
import { alignByTime, simulateXemm, simulateArbitrage } from './spreadEngine'

// Imperative counterparts to useExecutorSimulation/useSpreadExecutorSimulation for call sites
// outside a component's render lifecycle (stopping an executor, a Controller's periodic
// snapshot) — same one-shot fetch + dispatch, just not tied to a hook's poll/subscribe cycle.

async function fetchSingleMarketCandles(executor: ExecutorConfig): Promise<HistoricalRangeResult> {
  const endSec = Math.floor(Date.now() / 1000)
  return window.api.market.fetchHistoricalRange(executor.exchange, executor.symbol, '1m', executor.createdAt, endSec)
}

export interface OpenPosition {
  side: ExecutorSide
  entryPrice: number
  /** The money at stake -- margin, not notional. At 1x they are the same thing; above it they
   * are not, and this stays the smaller one because it is what the holder can actually lose. */
  amountQuote: number
  /** 1 for everything that is not a leveraged Position. Callers marking a position to market
   * must scale the price move by this, or a 10x position reports a tenth of what happened. */
  leverage: number
}

/** Extracts "is there currently an open, unrealized position" for an executor about to be
 * stopped — used to hand it over to Positions → Inventory instead of silently discarding it.
 * Returns null for types with nothing to hand over (Grid/DCA/Market Making with no open
 * inventory, a Position not yet entered, an unfilled Order, or TWAP/XEMM/Arbitrage, which never
 * leave a lingering position at all). */
export async function computeExecutorPosition(executor: ExecutorConfig): Promise<OpenPosition | null> {
  return (await computeExecutorStopSnapshot(executor)).position
}

/** What a stop needs to know: the position to hand over, and the profit already banked.
 *
 * Both come out of one simulation run. They are returned together because settling a stop needs
 * both and they must describe the same moment -- fetching candles twice could put a closed cycle
 * on one side of the line and not the other.
 *
 * `realizedPnl` is deliberately NOT part of OpenPosition: it is not part of the position, and a
 * caller marking the position to market must not add it in. */
export interface ExecutorStopSnapshot {
  position: OpenPosition | null
  realizedPnl: number
}

export async function computeExecutorStopSnapshot(executor: ExecutorConfig): Promise<ExecutorStopSnapshot> {
  const nothing: ExecutorStopSnapshot = { position: null, realizedPnl: 0 }
  if (executor.type === 'twap' || executor.type === 'xemm' || executor.type === 'arbitrage') return nothing

  const { candles } = await fetchSingleMarketCandles(executor)
  if (candles.length === 0) return nothing
  const basePrice = candles[0].close
  const state = runExecutorSimulation(candles, executor, basePrice)
  const realizedPnl = executorRealizedPnl(state)
  const found = (position: OpenPosition | null): ExecutorStopSnapshot => ({ position, realizedPnl })

  if (state.kind === 'grid') {
    const filled = state.levels.filter((l) => l.status === 'filled' && l.entryPrice !== null)
    if (filled.length === 0) return found(null)
    const avgEntry = filled.reduce((sum, l) => sum + (l.entryPrice as number), 0) / filled.length
    const params = executor.params as GridExecutorParams
    return found({ side: params.side, entryPrice: avgEntry, amountQuote: filled.length * state.amountPerLevel, leverage: 1 })
  }

  if (state.kind === 'dca') {
    if (state.status !== 'accumulating' || state.avgEntryPrice === null) return found(null)
    const params = executor.params as DcaExecutorParams
    return found({ side: params.side, entryPrice: state.avgEntryPrice, amountQuote: state.totalFilledQuote, leverage: 1 })
  }

  if (state.kind === 'position') {
    if (state.status !== 'open' || state.entryPrice === null) return found(null)
    const params = executor.params as PositionExecutorParams
    return found({ side: state.side, entryPrice: state.entryPrice, amountQuote: params.amountQuote, leverage: state.leverage })
  }

  if (state.kind === 'order') {
    if (state.status !== 'filled' || state.fillPrice === null) return found(null)
    const params = executor.params as OrderExecutorParams
    return found({ side: params.side, entryPrice: state.fillPrice, amountQuote: params.amountQuote, leverage: 1 })
  }

  // marketmaking — was previously missing entirely, silently discarding any accumulated
  // inventory on Stop regardless of "Keep position when stopped" (the checkbox is enabled for
  // this type, unlike TWAP/XEMM/Arbitrage, so leaving this branch out was a real bug, not an
  // intentional exclusion). Inventory can be net long or net short in the paper simulation.
  if (state.kind === 'marketmaking') {
    if (state.inventoryBaseQty === 0 || state.avgCost === null) return found(null)
    const side: ExecutorSide = state.inventoryBaseQty > 0 ? 'buy' : 'sell'
    return found({ side, entryPrice: state.avgCost, amountQuote: Math.abs(state.inventoryBaseQty) * state.avgCost, leverage: 1 })
  }

  return found(null)
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
  const last = candles[candles.length - 1]
  const state = runExecutorSimulation(candles, executor, basePrice)
  // The arithmetic lives in executorPnl.ts so the same rules can value an executor at any moment,
  // not only at "now" -- which is what backtesting one over a past range needs.
  return executorPnlFromState(state, executor.params, last.close, last.time)
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
