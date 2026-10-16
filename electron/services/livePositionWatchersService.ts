import { app } from 'electron'
import { join } from 'path'
import { readFile, mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import type { Exchange, LiveExitResult, LivePosition, TradingBook } from '../../shared/ipc'
import { fetchTicker24h } from './marketService'
import { getLivePosition } from './livePositionsService'
import { executeLiveClose, cancelSiblingLiveOrders } from './liveExecutionService'
import { evaluateWatcher } from './watcherEvaluation'
import { describeIncompleteExit } from './watcherExit'
import { demoExitNotice, liveExitNotice } from '../../shared/notices'
import { tell } from './noticeService'

export { evaluateWatcher } from './watcherEvaluation'

// The live Position Executor's Triple Barrier watcher — the one piece of this app that has to
// keep running unattended, watching a real position, and reliably trigger a real exit with no
// per-exit confirmation. Its own file/ledger (livePositionWatchers.json), same reasoning as
// every other live-trading concern: a bug in one can't weaken another's guarantee.
//
// KNOWN LIMITATION, stated plainly rather than hidden: livePositionsService.ts tracks one open
// position per symbol+exchange, not per executor (inherited from Phase 2b, which only ever had
// user-initiated closes to worry about). A watcher's exit closes "the live position for this
// symbol" as the shared ledger sees it. To keep that from silently closing out shares another
// executor contributed, only one active watcher per symbol+exchange is allowed at a time (see
// createWatcher) — but if a live Order executor separately trades that same symbol while a
// watcher is active, the watcher still acts on the combined ledger position. Full per-executor
// isolation would need a bigger redesign of the position ledger and is out of scope here.
//
// TWO BOOKS (V7.1 Stage 8): the demo book's watchers live in demoPositionWatchers.json and guard
// demo positions, closing them with demo sells; the loop looks at both books each tick, and every
// call names its book, the real one by default.

export interface LivePositionWatcher {
  id: string
  executorId: string
  livePositionId: string
  exchange: Exchange
  symbol: string
  entryPrice: number
  takeProfitPct: number | null
  stopLossPct: number | null
  timeLimitSec: number | null
  trailingStop: { activationPct: number; trailPct: number } | null
  trailingPeakPrice: number
  enteredAt: number
  active: boolean
  /** Consecutive failed evaluation attempts. A watcher that cannot fetch a price is NOT
   * protecting anything -- the barriers simply are not being checked -- so this is surfaced to
   * the UI rather than only logged, otherwise the position reads as "watched" while unguarded. */
  consecutiveFailures: number
  lastError: string | null
}

interface ResolvedEvent {
  executorId: string
  liveExitResult: LiveExitResult
}

interface State {
  watchers: LivePositionWatcher[]
  resolvedEvents: ResolvedEvent[]
}

/** A fresh state each time: two books must never share an array. */
const emptyState = (): State => ({ watchers: [], resolvedEvents: [] })
const FILE_OF: Record<TradingBook, string> = { real: 'livePositionWatchers.json', demo: 'demoPositionWatchers.json' }
const BOOKS: TradingBook[] = ['real', 'demo']
const POLL_MS = 5_000

const caches: Record<TradingBook, State | null> = { real: null, demo: null }
let loopStarted = false

function watchersPath(book: TradingBook): string {
  return join(app.getPath('userData'), FILE_OF[book])
}

async function load(book: TradingBook): Promise<State> {
  const cached = caches[book]
  if (cached) return cached
  let state: State
  try {
    const raw = await readFile(watchersPath(book), 'utf-8')
    state = { ...emptyState(), ...(JSON.parse(raw) as Partial<State>) }
  } catch {
    state = emptyState()
  }
  caches[book] = state
  return state
}

async function persist(book: TradingBook): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(watchersPath(book), caches[book])
}

export async function listActiveWatchers(book: TradingBook = 'real'): Promise<LivePositionWatcher[]> {
  const state = await load(book)
  return state.watchers.filter((w) => w.active)
}

/** Only one active watcher per symbol+exchange — see the file-level comment on why. */
export async function createWatcher(
  input: {
    executorId: string
    livePositionId: string
    exchange: Exchange
    symbol: string
    entryPrice: number
    takeProfitPct: number | null
    stopLossPct: number | null
    timeLimitSec: number | null
    trailingStop: { activationPct: number; trailPct: number } | null
  },
  book: TradingBook = 'real'
): Promise<LivePositionWatcher> {
  const state = await load(book)
  const conflict = state.watchers.some((w) => w.active && w.exchange === input.exchange && w.symbol === input.symbol)
  if (conflict) throw new Error(`Already watching a ${book === 'demo' ? 'demo' : 'live'} position on ${input.symbol} — only one at a time is supported`)

  const watcher: LivePositionWatcher = {
    id: crypto.randomUUID(),
    executorId: input.executorId,
    livePositionId: input.livePositionId,
    exchange: input.exchange,
    symbol: input.symbol,
    entryPrice: input.entryPrice,
    takeProfitPct: input.takeProfitPct,
    stopLossPct: input.stopLossPct,
    timeLimitSec: input.timeLimitSec,
    trailingStop: input.trailingStop,
    trailingPeakPrice: input.entryPrice,
    enteredAt: Math.floor(Date.now() / 1000),
    active: true,
    consecutiveFailures: 0,
    lastError: null
  }
  state.watchers.push(watcher)
  await persist(book)
  return watcher
}

export async function deactivateWatcher(id: string, book: TradingBook = 'real'): Promise<void> {
  const state = await load(book)
  const watcher = state.watchers.find((w) => w.id === id)
  if (watcher) watcher.active = false
  await persist(book)
}

/** Live DCA only: each new level fill shifts the position's true weighted-average cost basis, so
 * a watcher created on the first fill and never touched again would silently drift from it —
 * paper DCA always evaluates TP/SL/time-limit against the CURRENT average (recomputed fresh every
 * candle), so the live watcher has to track that too, not just the entry-price snapshot. No-op
 * for Position (which never calls this — its entry price never changes after creation). */
export async function updateWatcherEntryPrice(id: string, entryPrice: number, book: TradingBook = 'real'): Promise<void> {
  const state = await load(book)
  const watcher = state.watchers.find((w) => w.id === id)
  if (watcher) watcher.entryPrice = entryPrice
  await persist(book)
}

export async function drainResolvedWatcherEvents(book: TradingBook = 'real'): Promise<ResolvedEvent[]> {
  const state = await load(book)
  const events = state.resolvedEvents
  state.resolvedEvents = []
  await persist(book)
  return events
}

async function tickBook(book: TradingBook): Promise<void> {
  const state = await load(book)
  const active = state.watchers.filter((w) => w.active)
  if (active.length === 0) return

  const priceCache = new Map<string, number>()
  const nowSec = Math.floor(Date.now() / 1000)

  for (const watcher of active) {
    try {
      const key = `${watcher.exchange}:${watcher.symbol}`
      let price = priceCache.get(key)
      if (price === undefined) {
        const ticker = await fetchTicker24h(watcher.exchange, watcher.symbol)
        // Two adapters pass the exchange's raw field straight through and the rest run it
        // through Number(), so a malformed response arrives here as NaN rather than as a
        // thrown error. Left alone it would score as a clean tick: every barrier comparison
        // is false against NaN, consecutiveFailures would reset to 0, and the position would
        // report as watched and healthy while nothing was actually being checked.
        if (!Number.isFinite(ticker.lastPrice) || ticker.lastPrice <= 0) {
          throw new Error(`${watcher.symbol} returned an unusable price (${ticker.lastPrice}) — barriers were not checked this tick`)
        }
        price = ticker.lastPrice
        priceCache.set(key, price)
      }

      const { reason, newPeak } = evaluateWatcher(watcher, price, nowSec)
      watcher.trailingPeakPrice = newPeak

      // Re-read after the awaits above. `watcher` is the live object in the shared state, so a
      // Stop the user pressed while this tick was waiting on the network has already flipped it
      // -- acting on the decision made before that would place a real sell for a position the
      // user has just taken control of themselves.
      if (reason && watcher.active) {
        const position = await getLivePosition(watcher.livePositionId, book)
        if (!position || position.closedAt !== null || position.qty <= 0) {
          watcher.active = false
        } else {
          await executeLiveClose(position, position.qty, book)
          // A live DCA executor can still have unfilled ladder levels resting when its watched
          // position exits -- cancel them now (no-op for Order/Position, which never have any).
          await cancelSiblingLiveOrders(watcher.executorId, book)
          const closedPosition = await getLivePosition(watcher.livePositionId, book)

          // Deactivation is decided on the ledger, not on the order having been sent. A partial
          // fill leaves real exposure open, and standing down here would switch off the only
          // barriers guarding it -- see watcherExit.ts.
          const incomplete = describeIncompleteExit(closedPosition, watcher.symbol)
          if (incomplete !== null) throw new Error(incomplete)

          const settled = closedPosition as LivePosition
          watcher.active = false
          state.resolvedEvents.push({
            executorId: watcher.executorId,
            liveExitResult: {
              entryPrice: watcher.entryPrice,
              exitReason: reason,
              exitPrice: settled.exitPrice as number,
              realizedPnl: settled.realizedPnl as number,
              closedAt: settled.closedAt ?? nowSec
            }
          })
          // Told as its kind: the target reached, the stop triggered, or the time run out; a demo
          // exit said to be play money.
          const exit = { executorId: watcher.executorId, symbol: watcher.symbol, exitReason: reason, exitPrice: settled.exitPrice as number, realizedPnl: settled.realizedPnl as number, quoteAsset: settled.quoteAsset }
          tell((i18n) => (book === 'demo' ? demoExitNotice(exit, i18n) : liveExitNotice(exit, i18n)))
        }
      }
      watcher.consecutiveFailures = 0
      watcher.lastError = null
      await persist(book)
    } catch (error) {
      watcher.consecutiveFailures++
      watcher.lastError = error instanceof Error ? error.message : String(error)
      console.error(
        `Failed to evaluate ${book} position watcher ${watcher.id} (${watcher.consecutiveFailures} consecutive):`,
        error
      )
      await persist(book)
    }
  }
}

async function tick(): Promise<void> {
  for (const book of BOOKS) await tickBook(book)
}

/** Started once from electron/main.ts, independent of any BrowserWindow — this is what actually
 * protects real money, so it keeps running whether or not a window is focused or even open. */
export function startLivePositionWatcherLoop(): void {
  if (loopStarted) return
  loopStarted = true
  // Guard against re-entry: tick() awaits real network calls (endpoint resolution, /time, the
  // order itself) that can easily outlast POLL_MS -- notably on the first live call after launch,
  // when resolveTradingEndpoint probes the geo-blocked primary host before failing over. Without this,
  // a second timer fire would enter tick() while the first is still awaiting, read the same
  // not-yet-advanced state, and place an exit a second time. Skipping a tick is harmless; the next
  // one is only seconds away.
  let ticking = false
  setInterval(() => {
    if (ticking) return
    ticking = true
    void tick().finally(() => {
      ticking = false
    })
  }, POLL_MS)
}
