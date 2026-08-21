import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import type { Exchange, LiveTwapRunSummary, LiveTwapResolution } from '../../shared/ipc'
import { placeLiveMarketOrder } from './liveExecutionService'

// The live TWAP executor's slice-placement loop — the one live-trading concern that has to place
// NEW real orders on a timer, independent of any renderer being open, rather than just reconcile
// or watch state that already exists. Modeled directly on livePositionWatchersService.ts: its own
// file/ledger (liveTwapRuns.json), same "keeps running whether or not a window is open" reasoning.
//
// Slice 0 always resolves synchronously in ExecutorsPage.handleCreate (same call Order/Position's
// entry uses) — a run here only ever covers the REMAINING slices (sliceIndex starts at 1). See the
// LiveTwapRunSummary doc comment in shared/ipc.ts for why the two sources are combined for display
// rather than merged into one record.

export interface LiveTwapRun {
  id: string
  executorId: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  side: 'buy' | 'sell'
  amountPerOrder: number
  numOrders: number
  orderIntervalSec: number
  sliceIndex: number
  ordersPlaced: number
  totalQuoteFilled: number
  totalBaseFilled: number
  failedSlices: number
  lastError: string | null
  nextSliceAt: number
  status: 'active' | 'done' | 'stopped'
}

interface State {
  runs: LiveTwapRun[]
  resolvedEvents: LiveTwapResolution[]
}

const DEFAULT_STATE: State = { runs: [], resolvedEvents: [] }
const POLL_MS = 5_000

let cache: State | null = null
let loopStarted = false

function runsPath(): string {
  return join(app.getPath('userData'), 'liveTwapRuns.json')
}

async function load(): Promise<State> {
  if (cache) return cache
  try {
    const raw = await readFile(runsPath(), 'utf-8')
    cache = { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<State>) }
  } catch {
    cache = { ...DEFAULT_STATE }
  }
  return cache
}

async function persist(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(runsPath(), JSON.stringify(cache, null, 2), 'utf-8')
}

export async function createTwapRun(input: {
  executorId: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  side: 'buy' | 'sell'
  amountPerOrder: number
  numOrders: number
  orderIntervalSec: number
}): Promise<LiveTwapRun> {
  const state = await load()
  const run: LiveTwapRun = {
    id: crypto.randomUUID(),
    executorId: input.executorId,
    exchange: input.exchange,
    symbol: input.symbol,
    baseAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    side: input.side,
    amountPerOrder: input.amountPerOrder,
    numOrders: input.numOrders,
    orderIntervalSec: input.orderIntervalSec,
    sliceIndex: 1,
    ordersPlaced: 0,
    totalQuoteFilled: 0,
    totalBaseFilled: 0,
    failedSlices: 0,
    lastError: null,
    nextSliceAt: Math.floor(Date.now() / 1000) + input.orderIntervalSec,
    status: 'active'
  }
  state.runs.push(run)
  await persist()
  return run
}

function toSummary(run: LiveTwapRun): LiveTwapRunSummary {
  return {
    id: run.id,
    executorId: run.executorId,
    ordersPlaced: run.ordersPlaced,
    numOrders: run.numOrders,
    totalQuoteFilled: run.totalQuoteFilled,
    totalBaseFilled: run.totalBaseFilled,
    failedSlices: run.failedSlices,
    lastError: run.lastError
  }
}

export async function listActiveTwapRuns(): Promise<LiveTwapRunSummary[]> {
  const state = await load()
  return state.runs.filter((r) => r.status === 'active').map(toSummary)
}

function pushResolution(state: State, run: LiveTwapRun): void {
  state.resolvedEvents.push({
    executorId: run.executorId,
    runId: run.id,
    status: run.status === 'stopped' ? 'stopped' : 'done',
    ordersPlaced: run.ordersPlaced,
    numOrders: run.numOrders,
    totalQuoteFilled: run.totalQuoteFilled,
    totalBaseFilled: run.totalBaseFilled,
    failedSlices: run.failedSlices
  })
}

// Returns the resolution directly to the caller (mirrors stopWatcher's LiveExitResult return),
// rather than going through the resolvedEvents queue — that queue exists only so
// LiveOrderScheduler can learn about an AUTOMATIC done transition it wasn't waiting on; a manual
// Stop already gets its result synchronously from this call, so pushing here too would deliver it
// twice.
export async function stopTwapRun(id: string): Promise<LiveTwapResolution | null> {
  const state = await load()
  const run = state.runs.find((r) => r.id === id)
  if (!run || run.status !== 'active') return null
  run.status = 'stopped'
  await persist()
  return {
    executorId: run.executorId,
    runId: run.id,
    status: 'stopped',
    ordersPlaced: run.ordersPlaced,
    numOrders: run.numOrders,
    totalQuoteFilled: run.totalQuoteFilled,
    totalBaseFilled: run.totalBaseFilled,
    failedSlices: run.failedSlices
  }
}

export async function drainResolvedTwapEvents(): Promise<LiveTwapResolution[]> {
  const state = await load()
  const events = state.resolvedEvents
  state.resolvedEvents = []
  await persist()
  return events
}

async function tick(): Promise<void> {
  const state = await load()
  const active = state.runs.filter((r) => r.status === 'active')
  if (active.length === 0) return

  const nowSec = Math.floor(Date.now() / 1000)

  for (const run of active) {
    if (nowSec < run.nextSliceAt) continue

    try {
      const result = await placeLiveMarketOrder(run.exchange, run.symbol, run.baseAsset, run.quoteAsset, run.side, run.amountPerOrder)
      run.ordersPlaced++
      run.totalQuoteFilled += result.cummulativeQuoteQty
      run.totalBaseFilled += result.filledQty
      run.lastError = null
    } catch (error) {
      run.failedSlices++
      run.lastError = error instanceof Error ? error.message : String(error)
      console.error(`Live TWAP slice failed for run ${run.id} (executor ${run.executorId}):`, error)
    }

    // Always advance, success or failure — a persistently blocked run (e.g. kill switch engaged)
    // just skips slices at the normal cadence instead of retrying every tick or hanging forever.
    run.sliceIndex++
    if (run.sliceIndex >= run.numOrders) {
      run.status = 'done'
      pushResolution(state, run)
    } else {
      // Fixed cadence off the original schedule (matches paper's sliceTime = createdAt + i *
      // orderIntervalSec) rather than nowSec + interval, so a late tick doesn't compound drift.
      run.nextSliceAt += run.orderIntervalSec
      if (run.nextSliceAt <= nowSec) {
        // ...but if the schedule fell behind real time -- the app was closed, or the machine slept,
        // for longer than an interval -- resume the cadence from now instead. Without this the
        // whole backlog is "due" at once and, since tick() runs every few seconds, every remaining
        // slice fires seconds apart: a real market buy for the entire remaining notional in under
        // a minute, which is precisely what a TWAP exists to avoid. Finishing late is the correct
        // failure mode here; finishing all at once is not.
        run.nextSliceAt = nowSec + run.orderIntervalSec
      }
    }
    await persist()
  }
}

/** Started once from electron/main.ts, independent of any BrowserWindow — a live TWAP run has to
 * keep placing its remaining slices whether or not a window is focused or even open. */
export function startLiveTwapLoop(): void {
  if (loopStarted) return
  loopStarted = true
  // Guard against re-entry: tick() awaits real network calls (endpoint resolution, /time, the
  // order itself) that can easily outlast POLL_MS -- notably on the first live call after launch,
  // when resolveEndpoint probes the geo-blocked primary host before failing over. Without this,
  // a second timer fire would enter tick() while the first is still awaiting, read the same
  // not-yet-advanced state, and place a slice a second time. Skipping a tick is harmless; the next
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
