export type {
  ExecutorType,
  ExecutorSide,
  ExecutorStatus,
  ExecutorConfig,
  GridExecutorParams,
  DcaExecutorParams,
  DcaLevel,
  TwapExecutorParams
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

export type ExecutorRuntimeState = GridExecutorState | DcaExecutorState | TwapExecutorState
