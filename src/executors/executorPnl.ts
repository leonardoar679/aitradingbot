import { roundTripFee } from '../../shared/fees'
import { ASSUMED_FUNDING_RATE, fundingCost, fundingPeriodsBetween, notionalFor } from '../../shared/perp'
import type { SingleMarketExecutorState } from './types'
import type {
  DcaExecutorParams,
  ExecutorSide,
  GridExecutorParams,
  OrderExecutorParams,
  PositionExecutorParams
} from '../../shared/ipc'

/** What a simulated executor is worth right now: realized P&L plus whatever is still open, marked
 * to `currentPrice`.
 *
 * Lifted out of computeExecutorPnl, which mixed this arithmetic with fetching its own candles
 * over IPC. That made it impossible to ask "what was this executor worth at that moment" for any
 * moment other than now -- which is exactly what backtesting one requires. The rules are
 * unchanged; they just no longer need a network to be applied.
 *
 * `atTime` is the timestamp being valued at, and only leveraged positions read it: funding
 * accrues while a position is open, so charging it only at exit would make an open position look
 * better than it is for as long as it stays open. */
/** The part of an executor's P&L that is already banked -- profit from cycles it has closed, with
 * nothing marked to market.
 *
 * Needed apart from the total because of how a stop with "keep position" settles. The still-open
 * part becomes an Inventory row valued on its own, so the account books only the cash that bought
 * it; the banked part has no row anywhere and has to reach the balance, or a grid that turned
 * over forty round trips at a profit and happened to be holding a lot when it stopped loses every
 * penny it earned. Measured on real BTCUSDT candles: 47 round trips, 14.44 banked, all of it
 * dropped.
 *
 * Only Grid and Market Making can reach a stop with both a banked profit and something still
 * open. A DCA still accumulating has closed nothing, and a Position or Order that is open has by
 * definition not realised anything. */
export function executorRealizedPnl(state: SingleMarketExecutorState): number {
  if (state.kind === 'grid' || state.kind === 'marketmaking') return state.realizedPnl
  if (state.kind === 'dca') return state.realizedPnl ?? 0
  if (state.kind === 'position') return state.status === 'closed' ? (state.realizedPnl ?? 0) : 0
  // order and twap bank nothing until they are closed out, and neither closes itself.
  return 0
}

export function executorPnlFromState(
  state: SingleMarketExecutorState,
  params: unknown,
  currentPrice: number,
  atTime: number
): number {
  if (state.kind === 'grid') {
    const grid = params as GridExecutorParams
    const isBuy = grid.side === 'buy'
    const unrealized = state.levels
      .filter((l) => l.status === 'filled' && l.entryPrice !== null)
      .reduce((sum, l) => {
        const qty = state.amountPerLevel / (l.entryPrice as number)
        const grossLot = isBuy ? qty * (currentPrice - (l.entryPrice as number)) : qty * ((l.entryPrice as number) - currentPrice)
        return sum + grossLot - roundTripFee(qty, l.entryPrice as number, currentPrice)
      }, 0)
    return state.realizedPnl + unrealized
  }

  if (state.kind === 'dca') {
    if (state.realizedPnl !== null) return state.realizedPnl
    if (state.avgEntryPrice === null) return 0
    const dca = params as DcaExecutorParams
    const isBuy = dca.side === 'buy'
    const totalQty = state.totalFilledQuote / state.avgEntryPrice
    const grossDca = isBuy ? totalQty * (currentPrice - state.avgEntryPrice) : totalQty * (state.avgEntryPrice - currentPrice)
    return grossDca - roundTripFee(totalQty, state.avgEntryPrice, currentPrice)
  }

  if (state.kind === 'twap') {
    if (state.vwap === null) return 0
    const twap = params as { side: ExecutorSide; totalAmountQuote: number }
    const isBuy = twap.side === 'buy'
    const totalQty = state.fills.reduce((sum, f) => sum + f.amountQuote / f.price, 0)
    const grossTwap = isBuy ? totalQty * (currentPrice - state.vwap) : totalQty * (state.vwap - currentPrice)
    return grossTwap - roundTripFee(totalQty, state.vwap, currentPrice)
  }

  if (state.kind === 'position') {
    if (state.status === 'closed') return state.realizedPnl ?? 0
    if (state.status === 'open' && state.entryPrice !== null) {
      const position = params as PositionExecutorParams
      const isBuy = state.side === 'buy'
      // Sized on notional. This figure settles the paper account when the executor stops and is
      // what a Controller's loss limit is compared against, so an unlevered quantity here would
      // hand a 10x position back a tenth of its loss and let a breach go unnoticed.
      const qty = notionalFor(position.amountQuote, state.leverage) / state.entryPrice
      const grossPos = isBuy ? qty * (currentPrice - state.entryPrice) : qty * (state.entryPrice - currentPrice)
      const funding =
        state.leverage === 1 || state.enteredAt === null
          ? 0
          : fundingCost({
              notionalQuote: notionalFor(position.amountQuote, state.leverage),
              fundingRate: ASSUMED_FUNDING_RATE,
              periods: fundingPeriodsBetween(state.enteredAt, atTime),
              side: state.side
            })
      return grossPos - roundTripFee(qty, state.entryPrice, currentPrice) - funding
    }
    return 0
  }

  if (state.kind === 'order') {
    if (state.status === 'filled' && state.fillPrice !== null) {
      const order = params as OrderExecutorParams
      const isBuy = order.side === 'buy'
      const qty = order.amountQuote / state.fillPrice
      const grossOrder = isBuy ? qty * (currentPrice - state.fillPrice) : qty * (state.fillPrice - currentPrice)
      return grossOrder - roundTripFee(qty, state.fillPrice, currentPrice)
    }
    return 0
  }

  // marketmaking: realized P&L from closed round trips, plus unrealized on any net inventory
  // still held, marked against its average cost basis.
  const unrealized =
    state.inventoryBaseQty !== 0 && state.avgCost !== null
      ? state.inventoryBaseQty * (currentPrice - state.avgCost) -
        roundTripFee(Math.abs(state.inventoryBaseQty), state.avgCost, currentPrice)
      : 0
  return state.realizedPnl + unrealized
}
