import WebSocket from 'ws'

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 15000
// A TCP connection can go half-open — the peer is gone but nothing tells this side, so the
// socket sits in OPEN forever and simply never delivers another frame. Laptop sleep, a NAT
// timeout and a dropped Wi-Fi link all do it. Message traffic can't detect it, because silence
// is also what a genuinely quiet market looks like (a thin Korean pair can go minutes without a
// trade), so this probes with a protocol-level ping and reconnects only if no pong comes back.
const PING_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 10_000

interface SocketHandlers {
  onOpen?: (socket: WebSocket) => void
  onMessage: (data: Buffer) => void
  onError?: (error: Error) => void
  /** A connect that failed: the socket closed without ever opening. `consecutive` counts these
   * since the last open, so a caller can tell a dead host (1, 2, 3, ...) from a dropped link (an
   * open, then one). Called before the retry is scheduled; stopping the socket inside it is fine. */
  onConnectFailed?: (consecutive: number) => void
}

export interface SocketTimings {
  pingIntervalMs?: number
  pongTimeoutMs?: number
}

/** Opens a WebSocket that automatically reconnects with exponential backoff if the connection
 * drops or stops answering pings, and keeps reconnecting until the returned function is called.
 * Returns an unsubscribe function that stops the socket for good.
 *
 * `timings` exists so the heartbeat can be driven fast in tests; adapters use the defaults. */
export function createReconnectingSocket(url: string, handlers: SocketHandlers, timings: SocketTimings = {}): () => void {
  const pingIntervalMs = timings.pingIntervalMs ?? PING_INTERVAL_MS
  const pongTimeoutMs = timings.pongTimeoutMs ?? PONG_TIMEOUT_MS

  let socket: WebSocket | null = null
  let attempt = 0
  let failedConnects = 0
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let clearHeartbeat: () => void = () => {}

  function connect(): void {
    if (stopped) return
    const current = new WebSocket(url)
    socket = current
    let opened = false

    let pingTimer: ReturnType<typeof setInterval> | null = null
    let pongTimer: ReturnType<typeof setTimeout> | null = null
    // Local, and deliberately not read through the outer `clearHeartbeat` binding: that binding
    // is reassigned by the next connect(), so a socket closing after a reconnect would otherwise
    // clear the *new* socket's timers and leave its own interval running forever — pinging a
    // dead socket and eventually firing a stray terminate at the live one.
    const stopHeartbeat = (): void => {
      if (pingTimer) clearInterval(pingTimer)
      if (pongTimer) clearTimeout(pongTimer)
      pingTimer = null
      pongTimer = null
    }
    clearHeartbeat = stopHeartbeat

    current.on('open', () => {
      opened = true
      attempt = 0
      failedConnects = 0
      pingTimer = setInterval(() => {
        if (current.readyState !== WebSocket.OPEN) return
        // A probe is already outstanding — let its own timeout decide, rather than stacking
        // pings and shortening the effective deadline every interval.
        if (pongTimer) return
        pongTimer = setTimeout(() => {
          pongTimer = null
          // terminate(), not close(): a half-open socket will never complete a closing
          // handshake, so close() would hang exactly when a reconnect is most needed.
          current.terminate()
        }, pongTimeoutMs)
        current.ping()
      }, pingIntervalMs)
      handlers.onOpen?.(current)
    })

    current.on('pong', () => {
      if (pongTimer) clearTimeout(pongTimer)
      pongTimer = null
    })

    current.on('message', (raw: Buffer) => handlers.onMessage(raw))

    current.on('error', (error) => handlers.onError?.(error))

    current.on('close', () => {
      stopHeartbeat()
      if (stopped || socket !== current) return
      // Delay first, increment after, so the first retry really is BASE_DELAY_MS. Incrementing
      // first made 2s the shortest gap this could ever wait and left BASE_DELAY_MS unreachable.
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
      attempt += 1
      if (!opened) {
        failedConnects += 1
        handlers.onConnectFailed?.(failedConnects)
        // The handler may have stopped this socket for good, to open one elsewhere.
        if (stopped) return
      }
      reconnectTimer = setTimeout(connect, delay)
    })
  }

  connect()

  return () => {
    stopped = true
    clearHeartbeat()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    if (socket) {
      const current = socket
      socket = null
      // close() on a still-connecting socket emits an async 'error' internally
      // (WebSocket was closed before the connection was established); swallow it
      // since we just removed all real listeners and this is an expected no-op close.
      current.removeAllListeners()
      current.on('error', () => {})
      current.close()
    }
  }
}
