// THE USER-DATA STREAM (the V5 document, §101-102; V5 Stage 11, 8 October 2026). Binance pushes
// what happens to the account over one authenticated socket: each order's report as it rests,
// fills, is cancelled or expires, and the balances after each change. The main process keeps that
// socket open while there is something to hear -- a key stored, and the session armed or an order
// or position of the app's own open -- and reads each frame into the ledgers the 5-second poll
// used to fill alone. The poll stays, and becomes the check. Everything here is arithmetic on a
// frame; nothing opens a socket, signs a request or changes a ledger.

/** A listen key is kept alive this often (Binance closes an idle one after sixty minutes). */
export const USER_STREAM_KEEPALIVE_MS = 30 * 60_000
/** How often the service asks whether the stream is wanted. */
export const USER_STREAM_LOOK_MS = 30_000

export interface OrderFrame {
  kind: 'order'
  symbol: string
  orderId: number
  side: 'buy' | 'sell'
  /** Binance's own word: NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, REJECTED. */
  status: string
  /** Filled so far, and what it cost so far, in the quote. */
  filledQty: number
  cumulativeQuote: number
  /** The last execution, where the frame reports one. */
  lastPrice: number | null
  lastQty: number | null
  commission: { asset: string; amount: number } | null
  /** Seconds. */
  eventTime: number
}

export interface BalancesFrame {
  kind: 'balances'
  rows: { asset: string; free: number; locked: number }[]
  eventTime: number
}

export type UserStreamFrame = OrderFrame | BalancesFrame

const finite = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

/** One frame of the stream, read as an order's report or the balances; null for anything else
 * (a deposit, a listen key expiring, a frame that is not JSON). A field that cannot be read makes
 * the frame unreadable: a fill with no quantity is not a fill. */
export function parseUserStreamFrame(raw: string): UserStreamFrame | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const frame = data as Record<string, unknown>
  const eventTime = finite(frame.E)
  if (eventTime === null) return null
  if (frame.e === 'executionReport') {
    const orderId = finite(frame.i)
    const filledQty = finite(frame.z)
    const cumulativeQuote = finite(frame.Z)
    if (typeof frame.s !== 'string' || orderId === null || filledQty === null || cumulativeQuote === null || typeof frame.X !== 'string') return null
    if (frame.S !== 'BUY' && frame.S !== 'SELL') return null
    const amount = finite(frame.n)
    return {
      kind: 'order',
      symbol: frame.s,
      orderId,
      side: frame.S === 'BUY' ? 'buy' : 'sell',
      status: frame.X,
      filledQty,
      cumulativeQuote,
      lastPrice: finite(frame.L),
      lastQty: finite(frame.l),
      commission: typeof frame.N === 'string' && amount !== null && amount > 0 ? { asset: frame.N, amount } : null,
      eventTime: Math.floor(eventTime / 1000)
    }
  }
  if (frame.e === 'outboundAccountPosition') {
    if (!Array.isArray(frame.B)) return null
    const rows: BalancesFrame['rows'] = []
    for (const entry of frame.B) {
      const row = entry as Record<string, unknown>
      const free = finite(row.f)
      const locked = finite(row.l)
      if (typeof row.a !== 'string' || free === null || locked === null) return null
      rows.push({ asset: row.a, free, locked })
    }
    return { kind: 'balances', rows, eventTime: Math.floor(eventTime / 1000) }
  }
  return null
}

/** Binance's status, read as the three-way resolution the ledger keeps; null while the order
 * still rests (NEW, PARTIALLY_FILLED, PENDING_CANCEL). */
export function resolvedOrderStatus(binanceStatus: string): 'filled' | 'cancelled' | 'expired' | null {
  if (binanceStatus === 'FILLED') return 'filled'
  if (binanceStatus === 'CANCELED') return 'cancelled'
  if (binanceStatus === 'EXPIRED' || binanceStatus === 'REJECTED' || binanceStatus === 'EXPIRED_IN_MATCH') return 'expired'
  return null
}

/** Whether the stream should be open: a key stored, and something to hear -- the session armed
 * (an order may be placed at any moment), or an order or position of the app's own open. With
 * nothing of the app's own at stake and the session disarmed, nothing is listened for. */
export function userStreamWanted(input: { keyStored: boolean; armed: boolean; openOrders: number; openPositions: number }): boolean {
  if (!input.keyStored) return false
  return input.armed || input.openOrders > 0 || input.openPositions > 0
}

/** The stream's address: the trading host's socket base and the listen key. `base` comes from the
 * endpoint resolver (wss://…/ws) or, for a check against a local server, from USER_STREAM_URL. */
export function userStreamUrl(base: string, listenKey: string): string {
  const root = base.replace(/\/+$/, '')
  return `${root.endsWith('/ws') ? root : `${root}/ws`}/${listenKey}`
}

export interface UserStreamState {
  /** Whether the stream is wanted now, and whether its socket is open. */
  wanted: boolean
  open: boolean
  connects: number
  drops: number
  /** Milliseconds; null before the first frame. */
  lastFrameAt: number | null
  /** Frames read into the ledgers since the app started. */
  orders: number
  balances: number
  keepAlives: number
  /** The last thing that went wrong, or null. */
  error: string | null
}

export function emptyUserStreamState(): UserStreamState {
  return { wanted: false, open: false, connects: 0, drops: 0, lastFrameAt: null, orders: 0, balances: 0, keepAlives: 0, error: null }
}

/** One line for the stream's state, for Live Trading. */
export function describeUserStream(state: UserStreamState, nowMs: number): { line: string; tone: 'up' | 'down' | 'muted' } {
  if (!state.wanted) {
    return { line: 'Closed: nothing to hear. It opens while a Binance key is stored and the session is armed or an order or position of this app is open.', tone: 'muted' }
  }
  if (!state.open) return { line: state.error === null ? 'Opening...' : `Not open: ${state.error}`, tone: 'down' }
  const heard = `${state.orders} order report${state.orders === 1 ? '' : 's'} and ${state.balances} balance frame${state.balances === 1 ? '' : 's'} since the start`
  const last = state.lastFrameAt === null ? 'no frame yet' : `the last ${Math.max(0, Math.round((nowMs - state.lastFrameAt) / 1000))} s ago`
  const drops = state.drops > 0 ? `; ${state.drops} drop${state.drops === 1 ? '' : 's'}, reconnected` : ''
  return { line: `Open: ${heard}, ${last}${drops}.`, tone: 'up' }
}
