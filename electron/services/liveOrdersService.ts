import { app } from 'electron'
import { join } from 'path'
import { readFile, mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import type { Exchange, ExecutorSide, LiveOrder, TradingBook } from '../../shared/ipc'

// The live-order ledger — separate from liveTrading.json (safety gates) and livePositions.json
// (net holdings). This is the source of truth for every resting live order: it survives app
// restarts independent of any renderer state, so an order still open when the app closes is
// picked up correctly next launch just by polling every 'open' record, no reconciliation logic
// needed beyond that.
//
// Two books since V7.1 Stage 8: the real account's, liveOrders.json, and the demo book's,
// demoOrders.json (shared/ipc.ts TradingBook); every call names its book, the real one by default.

interface LiveOrdersState {
  orders: LiveOrder[]
}

/** A fresh state each time: two books must never share an array. */
const emptyState = (): LiveOrdersState => ({ orders: [] })
const FILE_OF: Record<TradingBook, string> = { real: 'liveOrders.json', demo: 'demoOrders.json' }

const caches: Record<TradingBook, LiveOrdersState | null> = { real: null, demo: null }

function liveOrdersPath(book: TradingBook): string {
  return join(app.getPath('userData'), FILE_OF[book])
}

async function load(book: TradingBook): Promise<LiveOrdersState> {
  const cached = caches[book]
  if (cached) return cached
  let state: LiveOrdersState
  try {
    const raw = await readFile(liveOrdersPath(book), 'utf-8')
    state = { ...emptyState(), ...(JSON.parse(raw) as Partial<LiveOrdersState>) }
  } catch {
    state = emptyState()
  }
  caches[book] = state
  return state
}

async function persist(book: TradingBook): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(liveOrdersPath(book), caches[book])
}

export async function createLiveOrder(
  input: {
    executorId: string
    exchange: Exchange
    symbol: string
    baseAsset: string
    quoteAsset: string
    side: ExecutorSide
    orderId: number | string
    limitPrice: number
    quantity: number
  },
  book: TradingBook = 'real'
): Promise<LiveOrder> {
  const state = await load(book)
  const order: LiveOrder = {
    id: crypto.randomUUID(),
    executorId: input.executorId,
    exchange: input.exchange,
    symbol: input.symbol,
    baseAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    side: input.side,
    orderId: input.orderId,
    limitPrice: input.limitPrice,
    quantity: input.quantity,
    status: 'open',
    filledQty: 0,
    avgFillPrice: null,
    placedAt: Math.floor(Date.now() / 1000),
    resolvedAt: null
  }
  state.orders.push(order)
  await persist(book)
  return order
}

export async function listOpenLiveOrders(book: TradingBook = 'real'): Promise<LiveOrder[]> {
  const state = await load(book)
  return state.orders.filter((o) => o.status === 'open')
}

export async function getLiveOrder(id: string, book: TradingBook = 'real'): Promise<LiveOrder | null> {
  const state = await load(book)
  return state.orders.find((o) => o.id === id) ?? null
}

export async function resolveLiveOrder(
  id: string,
  status: 'filled' | 'cancelled' | 'expired',
  filledQty: number,
  avgFillPrice: number | null,
  book: TradingBook = 'real'
): Promise<LiveOrder | null> {
  const state = await load(book)
  const order = state.orders.find((o) => o.id === id)
  if (!order) return null
  order.status = status
  order.filledQty = filledQty
  order.avgFillPrice = avgFillPrice
  order.resolvedAt = Math.floor(Date.now() / 1000)
  await persist(book)
  return order
}
