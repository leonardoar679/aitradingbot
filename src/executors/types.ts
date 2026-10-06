export type {
  ExecutorType,
  ExecutorSide,
  ExecutorStatus,
  ExecutorConfig,
  GridExecutorParams,
  DcaExecutorParams,
  DcaLevel,
  TwapExecutorParams,
  PositionExecutorParams,
  OrderExecutorParams,
  OrderExecutionStrategy,
  XemmExecutorParams,
  ArbitrageExecutorParams,
  SpreadMarket,
  MarketMakingExecutorParams,
  PositionExitReason
} from '../../shared/ipc'
import type { PositionExitReason } from '../../shared/ipc'

export interface GridLevelState {
  price: number
  status: 'pending' | 'filled'
  filledAt: number | null
  entryPrice: number | null
}

export interface GridExecutorState {
  kind: 'grid'
  levels: GridLevelState[]
  amountPerLevel: number
  filledCount: number
  realizedPnl: number
  closedLevels: number
  /** Set once Stop Price is crossed -- every filled level is closed at that price and the grid
   * never fills another level again, even if price re-enters the range. Null while armed/unset. */
  stoppedAt: number | null
}

export interface DcaFill {
  price: number
  amountQuote: number
  time: number
}

export interface DcaExecutorState {
  kind: 'dca'
  fills: DcaFill[]
  levelPrices: number[]
  avgEntryPrice: number | null
  totalFilledQuote: number
  status: 'accumulating' | 'closed'
  closedAt: number | null
  closePrice: number | null
  realizedPnl: number | null
}

export interface TwapFill {
  price: number
  amountQuote: number
  time: number
}

export interface TwapExecutorState {
  kind: 'twap'
  fills: TwapFill[]
  numOrders: number
  amountPerOrder: number
  vwap: number | null
  progressPct: number
  done: boolean
}

export interface PositionExecutorState {
  kind: 'position'
  side: 'buy' | 'sell'
  status: 'pending' | 'open' | 'closed'
  /** What the entry filled at (for a short, what it sold at), slippage included when the position
   * carries a rate (PositionExecutorParams.slippageRate). `exitPrice` likewise. */
  entryPrice: number | null
  /** What its stop, its target and its trailing stop are measured from: the price the entry filled at
   * before slippage. The same as `entryPrice` for a position that carries no rate. */
  levelPrice: number | null
  enteredAt: number | null
  /** High-water (buy) / low-water (sell) price since entry — drives the trailing-stop exit. */
  trailingPeakPrice: number | null
  /** `entry_expired` is the one that is not an exit: the entry was never filled before its expiry
   * (PositionExecutorParams.entryExpiresAt), so the position closed having bought nothing. */
  exitReason: PositionExitReason | null
  exitPrice: number | null
  closedAt: number | null
  realizedPnl: number | null
  /** Simulated leverage. 1 for every position that predates the field, and for spot. */
  leverage: number
  /** Where the margin runs out, or null at 1x where there is nothing to liquidate. It depends on
   * the entry price, so it stays null until the position actually opens. */
  liquidationPrice: number | null
  /** Funding paid (positive) or received (negative) over the position's life. Always 0 at 1x:
   * spot has no funding. */
  fundingPaid: number
}

export interface OrderExecutorState {
  kind: 'order'
  status: 'pending' | 'filled'
  fillPrice: number | null
  filledAt: number | null
}

export interface SpreadCapture {
  time: number
  spreadPct: number
  profitQuote: number
}

export interface SpreadExecutorState {
  kind: 'xemm' | 'arbitrage'
  captures: SpreadCapture[]
  realizedPnl: number
  lastSpreadPct: number | null
}

export interface MarketMakingExecutorState {
  kind: 'marketmaking'
  bidPrice: number | null
  askPrice: number | null
  inventoryBaseQty: number
  inventoryPct: number | null
  /** Average cost basis of the current net inventory — null when flat. */
  avgCost: number | null
  filledBuys: number
  filledSells: number
  realizedPnl: number
  refreshedAt: number | null
}

/** What runExecutorSimulation (the single-market dispatcher) can actually return — excludes
 * SpreadExecutorState, which only ever comes from useSpreadExecutorSimulation. */
export type SingleMarketExecutorState =
  | GridExecutorState
  | DcaExecutorState
  | TwapExecutorState
  | PositionExecutorState
  | OrderExecutorState
  | MarketMakingExecutorState

export type ExecutorRuntimeState = SingleMarketExecutorState | SpreadExecutorState
