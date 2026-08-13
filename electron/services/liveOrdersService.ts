import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import type { Exchange, ExecutorSide, LiveOrder } from '../../shared/ipc'

// The live-order ledger — separate from liveTrading.json (safety gates) and livePositions.json
// (net holdings). This is the source of truth for every resting live order: it survives app
// restarts independent of any renderer state, so an order still open when the app closes is
// picked up correctly next launch just by polling every 'open' record, no reconciliation logic
// needed beyond that.

interface LiveOrdersState {
  orders: LiveOrder[]
}

const DEFAULT_STATE: LiveOrdersState = { orders: [] }

let cache: LiveOrdersState | null = null

function liveOrdersPath(): string {
  return join(app.getPath('userData'), 'liveOrders.json')
}

async function load(): Promise<LiveOrdersState> {
  if (cache) return cache
  try {
    const raw = await readFile(liveOrdersPath(), 'utf-8')
    cache = { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<LiveOrdersState>) }
  } catch {
    cache = { ...DEFAULT_STATE }
  }
  return cache
}

async function persist(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(liveOrdersPath(), JSON.stringify(cache, null, 2), 'utf-8')
}

export async function createLiveOrder(input: {
  executorId: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  side: ExecutorSide
  orderId: number
  limitPrice: number
  quantity: number
}): Promise<LiveOrder> {
  const state = await load()
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
  await persist()
  return order
}

export async function listOpenLiveOrders(): Promise<LiveOrder[]> {
  const state = await load()
  return state.orders.filter((o) => o.status === 'open')
}

export async function getLiveOrder(id: string): Promise<LiveOrder | null> {
  const state = await load()
  return state.orders.find((o) => o.id === id) ?? null
}

export async function resolveLiveOrder(
  id: string,
  status: 'filled' | 'cancelled' | 'expired',
  filledQty: number,
  avgFillPrice: number | null
): Promise<LiveOrder | null> {
  const state = await load()
  const order = state.orders.find((o) => o.id === id)
  if (!order) return null
  order.status = status
  order.filledQty = filledQty
  order.avgFillPrice = avgFillPrice
  order.resolvedAt = Math.floor(Date.now() / 1000)
  await persist()
  return order
}
