import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import type { Exchange, ExecutorSide, LivePosition } from '../../shared/ipc'

// The live-position ledger — separate from liveTrading.json (safety gates) and settings.json
// (paper HeldPosition inventory). This is main-process-owned because it feeds the daily
// realized-loss gate in liveTradingService.ts: the ledger has to be trustworthy independent of
// whatever the renderer thinks happened.

interface RealizedEvent {
  at: number
  amountQuote: number
}

interface LivePositionsState {
  positions: LivePosition[]
  // Append-only log of realized P&L, one entry per reducing/closing fill — kept separate from
  // the position records so the daily loss limit can sum "P&L realized today" correctly even
  // when a fill only partially reduces a position that stays open (a position's own `closedAt`
  // only tells you when it was fully exited, not every date a partial realize happened on it).
  realizedEvents: RealizedEvent[]
}

const DEFAULT_STATE: LivePositionsState = { positions: [], realizedEvents: [] }

let cache: LivePositionsState | null = null

function livePositionsPath(): string {
  return join(app.getPath('userData'), 'livePositions.json')
}

async function load(): Promise<LivePositionsState> {
  if (cache) return cache
  try {
    const raw = await readFile(livePositionsPath(), 'utf-8')
    cache = { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<LivePositionsState>) }
  } catch {
    cache = { ...DEFAULT_STATE }
  }
  return cache
}

async function persist(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(livePositionsPath(), JSON.stringify(cache, null, 2), 'utf-8')
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function listOpenLivePositions(): Promise<LivePosition[]> {
  const state = await load()
  return state.positions.filter((p) => p.closedAt === null)
}

export async function getLivePosition(id: string): Promise<LivePosition | null> {
  const state = await load()
  return state.positions.find((p) => p.id === id) ?? null
}

/** History view — every fully-closed live position, most recent first. Read-only; feeds no
 * gate (that's getRealizedPnlToday, backed by the separate realizedEvents log). */
export async function listClosedLivePositions(): Promise<LivePosition[]> {
  const state = await load()
  return state.positions.filter((p) => p.closedAt !== null).sort((a, b) => (b.closedAt as number) - (a.closedAt as number))
}

export async function getRealizedPnlToday(): Promise<number> {
  const state = await load()
  const today = todayUtc()
  return state.realizedEvents
    .filter((e) => new Date(e.at * 1000).toISOString().slice(0, 10) === today)
    .reduce((sum, e) => sum + e.amountQuote, 0)
}

/** Called after every real fill. BUY opens or adds to a position (weighted-average cost basis).
 * SELL reduces or closes one. A SELL with no open position for that symbol is a no-op here —
 * there's nothing to close (e.g. a live Order executor selling exchange balance this app never
 * tracked as a live buy) — the order itself already happened; only ledger bookkeeping is
 * skipped. Same average-cost-basis math as simulateMarketMaking() in src/executors/engine.ts,
 * simplified for spot (long-only, no short side). */
export async function recordLiveFill(
  exchange: Exchange,
  symbol: string,
  baseAsset: string,
  quoteAsset: string,
  side: ExecutorSide,
  filledQty: number,
  avgFillPrice: number
): Promise<LivePosition | null> {
  const state = await load()
  const now = Math.floor(Date.now() / 1000)
  const open = state.positions.find((p) => p.symbol === symbol && p.exchange === exchange && p.closedAt === null)

  if (side === 'buy') {
    if (open) {
      const newQty = open.qty + filledQty
      open.avgCost = (open.avgCost * open.qty + avgFillPrice * filledQty) / newQty
      open.qty = newQty
      await persist()
      return open
    }
    const created: LivePosition = {
      id: crypto.randomUUID(),
      exchange,
      symbol,
      baseAsset,
      quoteAsset,
      qty: filledQty,
      avgCost: avgFillPrice,
      openedAt: now,
      closedAt: null,
      exitPrice: null,
      realizedPnl: null
    }
    state.positions.push(created)
    await persist()
    return created
  }

  // side === 'sell'
  if (!open) return null
  const closeQty = Math.min(filledQty, open.qty)
  const realizedFromThisFill = closeQty * (avgFillPrice - open.avgCost)
  open.qty -= closeQty
  open.realizedPnl = (open.realizedPnl ?? 0) + realizedFromThisFill
  if (open.qty <= 1e-9) {
    open.qty = 0
    open.closedAt = now
    open.exitPrice = avgFillPrice
  }
  state.realizedEvents.push({ at: now, amountQuote: realizedFromThisFill })
  await persist()
  return open
}
