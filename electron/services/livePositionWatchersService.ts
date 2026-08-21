import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import type { Exchange, LiveExitResult } from '../../shared/ipc'
import { fetchTicker24h } from './marketService'
import { getLivePosition } from './livePositionsService'
import { executeLiveClose, cancelSiblingLiveOrders } from './liveExecutionService'

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

const DEFAULT_STATE: State = { watchers: [], resolvedEvents: [] }
const POLL_MS = 5_000

let cache: State | null = null
let loopStarted = false

function watchersPath(): string {
  return join(app.getPath('userData'), 'livePositionWatchers.json')
}

async function load(): Promise<State> {
  if (cache) return cache
  try {
    const raw = await readFile(watchersPath(), 'utf-8')
    cache = { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<State>) }
  } catch {
    cache = { ...DEFAULT_STATE }
  }
  return cache
}

async function persist(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(watchersPath(), JSON.stringify(cache, null, 2), 'utf-8')
}

export async function listActiveWatchers(): Promise<LivePositionWatcher[]> {
  const state = await load()
  return state.watchers.filter((w) => w.active)
}

/** Only one active watcher per symbol+exchange — see the file-level comment on why. */
export async function createWatcher(input: {
  executorId: string
  livePositionId: string
  exchange: Exchange
  symbol: string
  entryPrice: number
  takeProfitPct: number | null
  stopLossPct: number | null
  timeLimitSec: number | null
  trailingStop: { activationPct: number; trailPct: number } | null
}): Promise<LivePositionWatcher> {
  const state = await load()
  const conflict = state.watchers.some((w) => w.active && w.exchange === input.exchange && w.symbol === input.symbol)
  if (conflict) throw new Error(`Already watching a live position on ${input.symbol} — only one at a time is supported`)

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
  await persist()
  return watcher
}

export async function deactivateWatcher(id: string): Promise<void> {
  const state = await load()
  const watcher = state.watchers.find((w) => w.id === id)
  if (watcher) watcher.active = false
  await persist()
}

/** Live DCA only: each new level fill shifts the position's true weighted-average cost basis, so
 * a watcher created on the first fill and never touched again would silently drift from it —
 * paper DCA always evaluates TP/SL/time-limit against the CURRENT average (recomputed fresh every
 * candle), so the live watcher has to track that too, not just the entry-price snapshot. No-op
 * for Position (which never calls this — its entry price never changes after creation). */
export async function updateWatcherEntryPrice(id: string, entryPrice: number): Promise<void> {
  const state = await load()
  const watcher = state.watchers.find((w) => w.id === id)
  if (watcher) watcher.entryPrice = entryPrice
  await persist()
}

export async function drainResolvedWatcherEvents(): Promise<ResolvedEvent[]> {
  const state = await load()
  const events = state.resolvedEvents
  state.resolvedEvents = []
  await persist()
  return events
}

/** Pure — ported from simulatePosition (src/executors/engine.ts), buy-only (live spot can't
 * short), adapted from "candle wick touches a target" to "last-traded price crosses a target."
 * Same stop-loss > take-profit > trailing-stop > time-limit priority as the paper engine. Always
 * returns the updated trailing peak so the caller persists it even on a tick with no exit. */
export function evaluateWatcher(
  watcher: Pick<LivePositionWatcher, 'entryPrice' | 'takeProfitPct' | 'stopLossPct' | 'timeLimitSec' | 'trailingStop' | 'trailingPeakPrice' | 'enteredAt'>,
  currentPrice: number,
  nowSec: number
): { reason: LiveExitResult['exitReason'] | null; newPeak: number } {
  const newPeak = Math.max(watcher.trailingPeakPrice, currentPrice)

  const slTarget = watcher.stopLossPct !== null ? watcher.entryPrice * (1 - watcher.stopLossPct / 100) : null
  const slHit = slTarget !== null && currentPrice <= slTarget

  const tpTarget = watcher.takeProfitPct !== null ? watcher.entryPrice * (1 + watcher.takeProfitPct / 100) : null
  const tpHit = tpTarget !== null && currentPrice >= tpTarget

  let trailHit = false
  if (watcher.trailingStop !== null) {
    const activationTarget = watcher.entryPrice * (1 + watcher.trailingStop.activationPct / 100)
    if (newPeak >= activationTarget) {
      const trailTarget = newPeak * (1 - watcher.trailingStop.trailPct / 100)
      trailHit = currentPrice <= trailTarget
    }
  }

  const timeUp = watcher.timeLimitSec !== null && nowSec - watcher.enteredAt >= watcher.timeLimitSec

  const reason = slHit ? 'stop_loss' : tpHit ? 'take_profit' : trailHit ? 'trailing_stop' : timeUp ? 'time_limit' : null
  return { reason, newPeak }
}

async function tick(): Promise<void> {
  const state = await load()
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
        price = ticker.lastPrice
        priceCache.set(key, price)
      }

      const { reason, newPeak } = evaluateWatcher(watcher, price, nowSec)
      watcher.trailingPeakPrice = newPeak

      if (reason) {
        const position = await getLivePosition(watcher.livePositionId)
        if (!position || position.closedAt !== null || position.qty <= 0) {
          watcher.active = false
        } else {
          await executeLiveClose(position, position.qty)
          // A live DCA executor can still have unfilled ladder levels resting when its watched
          // position exits -- cancel them now (no-op for Order/Position, which never have any).
          await cancelSiblingLiveOrders(watcher.executorId)
          const closedPosition = await getLivePosition(watcher.livePositionId)
          watcher.active = false
          if (closedPosition && closedPosition.exitPrice !== null && closedPosition.realizedPnl !== null) {
            state.resolvedEvents.push({
              executorId: watcher.executorId,
              liveExitResult: {
                entryPrice: watcher.entryPrice,
                exitReason: reason,
                exitPrice: closedPosition.exitPrice,
                realizedPnl: closedPosition.realizedPnl,
                closedAt: closedPosition.closedAt ?? nowSec
              }
            })
          }
        }
      }
      watcher.consecutiveFailures = 0
      watcher.lastError = null
      await persist()
    } catch (error) {
      watcher.consecutiveFailures++
      watcher.lastError = error instanceof Error ? error.message : String(error)
      console.error(
        `Failed to evaluate live position watcher ${watcher.id} (${watcher.consecutiveFailures} consecutive):`,
        error
      )
      await persist()
    }
  }
}

/** Started once from electron/main.ts, independent of any BrowserWindow — this is what actually
 * protects real money, so it keeps running whether or not a window is focused or even open. */
export function startLivePositionWatcherLoop(): void {
  if (loopStarted) return
  loopStarted = true
  // Guard against re-entry: tick() awaits real network calls (endpoint resolution, /time, the
  // order itself) that can easily outlast POLL_MS -- notably on the first live call after launch,
  // when resolveEndpoint probes the geo-blocked primary host before failing over. Without this,
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
