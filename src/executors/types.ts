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
  MarketMakingExecutorParams
} from '../../shared/ipc'

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

export type PositionExitReason = 'take_profit' | 'stop_loss' | 'time_limit' | 'trailing_stop'

export interface PositionExecutorState {
  kind: 'position'
  side: 'buy' | 'sell'
  status: 'pending' | 'open' | 'closed'
  entryPrice: number | null
  enteredAt: number | null
  /** High-water (buy) / low-water (sell) price since entry — drives the trailing-stop exit. */
  trailingPeakPrice: number | null
  exitReason: PositionExitReason | null
  exitPrice: number | null
  closedAt: number | null
  realizedPnl: number | null
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
