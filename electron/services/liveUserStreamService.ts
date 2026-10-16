import type { Commissions } from '../../shared/observedFee'
import type { TradingBook } from '../../shared/ipc'
import { USER_STREAM_KEEPALIVE_MS, USER_STREAM_LOOK_MS, emptyUserStreamState, parseUserStreamFrame, userStreamWanted, type UserStreamState } from '../../shared/userStream'
import { getDecryptedCredential, listCredentialStatus, updateBalanceCache } from './credentialsService'
import { closeListenKey, createListenKey, keepAliveListenKey, userStreamAddress } from './exchanges/binanceUserStream'
import { createReconnectingSocket } from './exchanges/reconnectingSocket'
import { resolveOrderFromExchange, type LiveOrderResolution } from './liveExecutionService'
import { listOpenLiveOrders } from './liveOrdersService'
import { listOpenLivePositions } from './livePositionsService'
import { getLiveTradingStatus } from './liveTradingService'

// THE USER-DATA STREAM IN THE MAIN PROCESS (the V5 document, §101; V5 Stage 11, 8 October 2026).
// While a Binance key is stored and there is something to hear -- the session armed, or an order or
// position of the app's own open -- one authenticated socket is kept open with a listen key, kept
// alive every thirty minutes and renewed before Binance's day is up through the same helper the
// public stream uses. Each order report is read into the ledgers at once, through the one function
// the 5-second poll uses too, so a fill is booked once whichever hears it first; each balances
// frame refreshes the balance cache. The poll stays, and is the check. Nothing here places,
// cancels or sizes an order.

let state: UserStreamState = emptyUserStreamState()
let stop: (() => void) | null = null
let keepAlive: ReturnType<typeof setInterval> | null = null
let looker: ReturnType<typeof setInterval> | null = null
let listenKey: string | null = null
let looking = false
/** Resolutions the stream (and the reconciliation) made, for the renderer's next poll. */
const resolutions: LiveOrderResolution[] = []
/** What each resting order's fills have cost so far, by order, across its reports. */
const commissionsByOrder = new Map<string, Commissions>()

export function getUserStreamState(): UserStreamState {
  return { ...state }
}

/** The demo book's, queued by its reconciliation alone (the stream is Binance's, real): drained by
 * the demo poll, never by the real one (V7.1 Stage 8). */
const demoResolutions: LiveOrderResolution[] = []

/** The resolutions made since the last poll, handed to it: the renderer patches its executors from
 * them as it does from the poll's own. */
export function drainStreamResolutions(book: TradingBook = 'real'): LiveOrderResolution[] {
  return (book === 'demo' ? demoResolutions : resolutions).splice(0)
}

export function queueStreamResolution(resolution: LiveOrderResolution, book: TradingBook = 'real'): void {
  ;(book === 'demo' ? demoResolutions : resolutions).push(resolution)
}

async function wanted(): Promise<boolean> {
  const keys = await listCredentialStatus()
  const keyStored = keys.some((key) => key.exchange === 'binance' && key.configured)
  if (!keyStored) return false
  const [status, orders, positions] = await Promise.all([getLiveTradingStatus(), listOpenLiveOrders(), listOpenLivePositions()])
  return userStreamWanted({ keyStored, armed: status.sessionArmed, openOrders: orders.length, openPositions: positions.filter((position) => position.exchange === 'binance').length })
}

/** One frame: an order's report into the ledgers, a balances frame into the cache. */
export async function handleUserStreamFrame(raw: string): Promise<void> {
  const frame = parseUserStreamFrame(raw)
  if (frame === null) return
  state = { ...state, lastFrameAt: Date.now() }
  if (frame.kind === 'balances') {
    updateBalanceCache('binance', frame.rows)
    state = { ...state, balances: state.balances + 1 }
    return
  }
  state = { ...state, orders: state.orders + 1 }
  const key = `${frame.symbol}:${frame.orderId}`
  if (frame.commission !== null) {
    const held = commissionsByOrder.get(key) ?? {}
    held[frame.commission.asset] = (held[frame.commission.asset] ?? 0) + frame.commission.amount
    commissionsByOrder.set(key, held)
  }
  const order = (await listOpenLiveOrders()).find((entry) => entry.exchange === 'binance' && entry.orderId === frame.orderId && entry.symbol === frame.symbol)
  if (order === undefined) return
  const resolution = await resolveOrderFromExchange(order, {
    orderId: frame.orderId,
    status: frame.status,
    filledQty: frame.filledQty,
    avgFillPrice: frame.filledQty > 0 ? frame.cumulativeQuote / frame.filledQty : 0,
    cummulativeQuoteQty: frame.cumulativeQuote,
    commissions: commissionsByOrder.get(key) ?? {}
  })
  if (resolution !== null) {
    commissionsByOrder.delete(key)
    resolutions.push(resolution)
  }
}

function timings(): { lifetimeMs?: number; pingIntervalMs?: number } {
  const lifetime = Number(process.env.USER_STREAM_LIFETIME_MS)
  return Number.isFinite(lifetime) && lifetime > 0 ? { lifetimeMs: lifetime } : {}
}

async function open(): Promise<void> {
  const { apiKey } = await getDecryptedCredential('binance')
  const key = await createListenKey(apiKey)
  listenKey = key
  const url = await userStreamAddress(key)
  stop = createReconnectingSocket(
    url,
    {
      onOpen: (socket) => {
        state = { ...state, open: true, connects: state.connects + 1, error: null }
        socket.on('close', () => {
          state = { ...state, open: false, drops: state.drops + 1 }
        })
      },
      onMessage: (raw) => {
        void handleUserStreamFrame(raw.toString()).catch((error: unknown) => {
          state = { ...state, error: error instanceof Error ? error.message : String(error) }
        })
      },
      onError: (error) => {
        state = { ...state, error: error.message }
      }
    },
    timings()
  )
  keepAlive = setInterval(() => {
    void keepAliveListenKey(apiKey, key)
      .then(() => {
        state = { ...state, keepAlives: state.keepAlives + 1 }
      })
      .catch((error: unknown) => {
        state = { ...state, error: error instanceof Error ? error.message : String(error) }
      })
  }, USER_STREAM_KEEPALIVE_MS)
}

async function close(): Promise<void> {
  if (stop !== null) stop()
  stop = null
  if (keepAlive !== null) clearInterval(keepAlive)
  keepAlive = null
  const key = listenKey
  listenKey = null
  state = { ...state, open: false }
  if (key !== null) {
    try {
      const { apiKey } = await getDecryptedCredential('binance')
      await closeListenKey(apiKey, key)
    } catch {
      // A key that cannot be closed expires on its own within the hour.
    }
  }
}

/** Opens or closes the stream as it is wanted now. Exported for its test and the check. */
export async function lookAtUserStream(): Promise<UserStreamState> {
  if (looking) return getUserStreamState()
  looking = true
  try {
    const want = await wanted()
    state = { ...state, wanted: want }
    if (want && stop === null) await open()
    else if (!want && stop !== null) await close()
  } catch (error) {
    state = { ...state, error: error instanceof Error ? error.message : String(error) }
  } finally {
    looking = false
  }
  return getUserStreamState()
}

export function startLiveUserStream(): void {
  if (looker === null) looker = setInterval(() => void lookAtUserStream(), USER_STREAM_LOOK_MS)
  void lookAtUserStream()
}

/** Test seam: the stream closed and everything forgotten. */
export async function resetLiveUserStream(): Promise<void> {
  if (looker !== null) clearInterval(looker)
  looker = null
  if (stop !== null) stop()
  stop = null
  if (keepAlive !== null) clearInterval(keepAlive)
  keepAlive = null
  listenKey = null
  looking = false
  resolutions.length = 0
  commissionsByOrder.clear()
  state = emptyUserStreamState()
}
