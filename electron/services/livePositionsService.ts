import { app } from 'electron'
import { join } from 'path'
import { readFile, mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import type { Exchange, ExecutorSide, LivePosition, TradingBook } from '../../shared/ipc'
import { netRealizedPnl } from '../../shared/fees'
import { commissionInQuote, observedFeeRate, type Commissions } from '../../shared/observedFee'

// The live-position ledger — separate from liveTrading.json (safety gates) and settings.json
// (paper HeldPosition inventory). This is main-process-owned because it feeds the daily
// realized-loss gate in liveTradingService.ts: the ledger has to be trustworthy independent of
// whatever the renderer thinks happened.
//
// TWO BOOKS (V7.1 Stage 8, 16 October 2026): the real account's ledger, livePositions.json, as it
// always was; and the demo book's, demoPositions.json, for positions on an exchange's demo account
// (shared/ipc.ts TradingBook). Every reader and writer names its book, the real one by default, so
// a demo fill can never land in the ledger the loss gate reads, and a demo position is never priced
// or closed as a real one.

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
  /** The fee rate the exchange really charged on the most recent fill it could be derived from.
   * Recorded, never acted on: it feeds a note on Risk & Safety telling the user what FEE_RATE ought to
   * be, and deliberately changes no P&L figure and no gate by itself. Null until a live fill has
   * reported a commission this app can value -- a BNB-denominated one cannot be valued without a
   * rate table, so it leaves this alone rather than writing a wrong number. */
  lastObservedFeeRate?: number | null
}

/** A fresh state each time: two books must never share an array. */
const emptyState = (): LivePositionsState => ({ positions: [], realizedEvents: [] })
const FILE_OF: Record<TradingBook, string> = { real: 'livePositions.json', demo: 'demoPositions.json' }

const caches: Record<TradingBook, LivePositionsState | null> = { real: null, demo: null }

function livePositionsPath(book: TradingBook): string {
  return join(app.getPath('userData'), FILE_OF[book])
}

async function load(book: TradingBook): Promise<LivePositionsState> {
  const cached = caches[book]
  if (cached) return cached
  let state: LivePositionsState
  try {
    const raw = await readFile(livePositionsPath(book), 'utf-8')
    state = { ...emptyState(), ...(JSON.parse(raw) as Partial<LivePositionsState>) }
  } catch {
    state = emptyState()
  }
  caches[book] = state
  return state
}

async function persist(book: TradingBook): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(livePositionsPath(book), caches[book])
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function listOpenLivePositions(book: TradingBook = 'real'): Promise<LivePosition[]> {
  const state = await load(book)
  return state.positions.filter((p) => p.closedAt === null)
}

export async function getLivePosition(id: string, book: TradingBook = 'real'): Promise<LivePosition | null> {
  const state = await load(book)
  return state.positions.find((p) => p.id === id) ?? null
}

/** History view — every fully-closed live position, most recent first. Read-only; feeds no
 * gate (that's getRealizedPnlToday, backed by the separate realizedEvents log). */
export async function listClosedLivePositions(book: TradingBook = 'real'): Promise<LivePosition[]> {
  const state = await load(book)
  return state.positions.filter((p) => p.closedAt !== null).sort((a, b) => (b.closedAt as number) - (a.closedAt as number))
}

/** The real book's: the daily loss gate reads it, and a demo loss is no loss. */
export async function getRealizedPnlToday(): Promise<number> {
  const state = await load('real')
  const today = todayUtc()
  return state.realizedEvents
    .filter((e) => new Date(e.at * 1000).toISOString().slice(0, 10) === today)
    .reduce((sum, e) => sum + e.amountQuote, 0)
}

/** The fee rate most recently seen on a real fill, or null if none has been observed yet. */
export async function getLastObservedFeeRate(): Promise<number | null> {
  const state = await load('real')
  return state.lastObservedFeeRate ?? null
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
  avgFillPrice: number,
  commissions?: Commissions,
  /** The smallest quantity this symbol can be traded in. A closing sell is FLOORED onto that
   * step, so selling a whole position almost always leaves a sub-step remainder behind -- 0.0003333
   * BTC floors to 0.00033333 and leaves 3.3e-9. Against a fixed 1e-9 threshold that residue kept
   * the position "open" forever: too small for any exchange to sell, too large to be called flat.
   * Passing the real step makes untradable dust count as closed, which is what it is. */
  flatBelowQty?: number,
  book: TradingBook = 'real'
): Promise<LivePosition | null> {
  // This ledger feeds the daily realized-loss gate, and that gate is a `<=` comparison -- false
  // for NaN. A single unusable fill quantity or price would not skew the limit, it would switch
  // it off (and the auto-disarm with it) for the rest of the day, then vanish on restart because
  // JSON stores NaN as null and null sums as zero. The fill numbers arrive from Number() over an
  // exchange response field, so nothing upstream guarantees they are usable.
  //
  // Refusing here means the caller sees an error for an order that really did execute, which is
  // why the message says so: an untracked real fill the user can reconcile is recoverable, a
  // silently disabled loss limit is not.
  if (!Number.isFinite(filledQty) || filledQty < 0 || !Number.isFinite(avgFillPrice) || avgFillPrice < 0) {
    throw new Error(
      `The ${side} order on ${symbol} executed on the exchange, but came back with an unusable ` +
        `quantity (${filledQty}) or price (${avgFillPrice}), so it was not recorded. Check the ` +
        `position on the exchange directly — this app's ${book === 'demo' ? 'demo' : 'live'} ledger does not include it.`
    )
  }

  const state = await load(book)
  const now = Math.floor(Date.now() / 1000)

  if (commissions !== undefined && book === 'real') {
    const feeQuote = commissionInQuote(commissions, baseAsset, quoteAsset, avgFillPrice)
    const rate = feeQuote === null ? null : observedFeeRate(feeQuote, filledQty * avgFillPrice)
    if (rate !== null) state.lastObservedFeeRate = rate
  }
  const open = state.positions.find((p) => p.symbol === symbol && p.exchange === exchange && p.closedAt === null)

  if (side === 'buy') {
    if (open) {
      const newQty = open.qty + filledQty
      open.avgCost = (open.avgCost * open.qty + avgFillPrice * filledQty) / newQty
      open.qty = newQty
      await persist(book)
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
    await persist(book)
    return created
  }

  // side === 'sell'
  if (!open) return null
  const closeQty = Math.min(filledQty, open.qty)
  // Net of the fees on both fills, not gross. avgCost stays the plain average fill price so it
  // still matches what the exchange shows for the position; the cost of trading is taken here,
  // where it decides both the reported P&L and whether the daily loss limit has been breached.
  const realizedFromThisFill = netRealizedPnl(closeQty, open.avgCost, avgFillPrice)
  open.qty -= closeQty
  open.realizedPnl = (open.realizedPnl ?? 0) + realizedFromThisFill
  // Flat when the remainder cannot be traded at all. The 1e-9 floor stays as the backstop for
  // callers that do not know the symbol's step, and anything unusable falls back to it rather
  // than widening the definition of "closed" by accident.
  const flatBelow = Number.isFinite(flatBelowQty) && (flatBelowQty as number) > 0 ? (flatBelowQty as number) : 0
  if (open.qty <= 1e-9 || open.qty < flatBelow) {
    open.qty = 0
    open.closedAt = now
    open.exitPrice = avgFillPrice
  }
  state.realizedEvents.push({ at: now, amountQuote: realizedFromThisFill })
  await persist(book)
  return open
}
