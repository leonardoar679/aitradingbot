import { FOLLOW_LINES } from '../../shared/traders/follow'
import { createReconnectingSocket } from './exchanges/reconnectingSocket'

// HYPERLIQUID'S FILLS AS THEY HAPPEN (V8 Stage 8, 27 October 2026): one public WebSocket to Hyperliquid carrying the
// fills of up to five followed addresses. Each subscription answers first with a snapshot of the address's recent
// fills, marked as such -- what a reconnect re-sends, so nothing made while the socket was down is lost -- then each
// fill as it is made. Hyperliquid closes a connection quiet for a minute: a ping of its own goes every fifty seconds,
// beside the socket's protocol ping (exchanges/reconnectingSocket.ts). Keyless reads; nothing is sent but subscriptions
// and pings.

export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws'

export interface FillStreamHandlers {
  /** An address's fills: its snapshot on (re)subscribing, or fills as they are made. Addresses in lower case. */
  onFills: (user: string, fills: unknown[], snapshot: boolean) => void
  /** The socket opened, its subscriptions sent. */
  onOpen: () => void
  /** A connect that failed, and how many in a row. */
  onConnectFailed: (consecutive: number) => void
}

/** A message of the stream's, as far as it is read. */
interface StreamMessage {
  channel?: unknown
  data?: { user?: unknown; fills?: unknown; isSnapshot?: unknown }
}

/** What the stream opens through: a test hands in its own. */
export const hyperliquidStreamSeam = {
  open: createReconnectingSocket,
  setInterval: (run: () => void, ms: number): ReturnType<typeof setInterval> => setInterval(run, ms),
  clearInterval: (timer: ReturnType<typeof setInterval>): void => clearInterval(timer)
}

/** One socket for the fills of up to five addresses; the stop function closes it for good. */
export function streamHyperliquidFills(users: readonly string[], handlers: FillStreamHandlers): () => void {
  const watched = users.slice(0, FOLLOW_LINES.maxStreams)
  let pinger: ReturnType<typeof setInterval> | null = null
  const stopPinging = (): void => {
    if (pinger !== null) hyperliquidStreamSeam.clearInterval(pinger)
    pinger = null
  }
  const stop = hyperliquidStreamSeam.open(HYPERLIQUID_WS_URL, {
    onOpen: (socket) => {
      for (const user of watched) socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'userFills', user } }))
      stopPinging()
      pinger = hyperliquidStreamSeam.setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ method: 'ping' }))
      }, FOLLOW_LINES.pingSec * 1000)
      handlers.onOpen()
    },
    onMessage: (raw) => {
      let body: StreamMessage | null = null
      try {
        body = JSON.parse(raw.toString()) as StreamMessage | null
      } catch {
        return
      }
      if (body?.channel !== 'userFills' || typeof body.data?.user !== 'string' || !Array.isArray(body.data.fills)) return
      handlers.onFills(body.data.user.toLowerCase(), body.data.fills, body.data.isSnapshot === true)
    },
    onConnectFailed: (consecutive) => handlers.onConnectFailed(consecutive)
  })
  return () => {
    stopPinging()
    stop()
  }
}
