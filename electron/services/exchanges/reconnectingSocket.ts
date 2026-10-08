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
// Binance closes every stream connection after 24 hours, whatever its state. Left to that, the cut
// is a drop: the frames in flight are lost, and the prices on screen are a reconnect's backoff
// behind. So a connection is renewed before then: a second socket is opened to the same address,
// and only once it is open is the first closed. Nothing is missed in between -- both deliver for
// the moment they overlap, and a frame taken twice does no harm to the caller's state.
const LIFETIME_MS = 23.5 * 60 * 60 * 1000
/** A renewal that could not open (the host refused the second connection) is tried again this much
 * later; the socket already open keeps delivering meanwhile. */
const ROTATE_RETRY_MS = 15_000

interface SocketHandlers {
  /** A socket opened and is the one in use. `renewed` says it replaced one that was still open
   * (a planned renewal, below) rather than one that dropped or never connected. */
  onOpen?: (socket: WebSocket, renewed: boolean) => void
  onMessage: (data: Buffer) => void
  onError?: (error: Error) => void
  /** A connect that failed: the socket closed without ever opening. `consecutive` counts these
   * since the last open, so a caller can tell a dead host (1, 2, 3, ...) from a dropped link (an
   * open, then one). Called before the retry is scheduled; stopping the socket inside it is fine.
   * A renewal that could not open is not counted: the socket in use is still delivering. */
  onConnectFailed?: (consecutive: number) => void
}

export interface SocketTimings {
  pingIntervalMs?: number
  pongTimeoutMs?: number
  /** How long one connection is kept before it is renewed. Binance allows 24 hours. */
  lifetimeMs?: number
  /** How long after a renewal that could not open the next one is tried. */
  rotateRetryMs?: number
}

/** Opens a WebSocket that automatically reconnects with exponential backoff if the connection
 * drops or stops answering pings, renews itself before its lifetime runs out, and keeps
 * reconnecting until the returned function is called. Returns an unsubscribe function that stops
 * the socket for good.
 *
 * `timings` exists so the heartbeat and the lifetime can be driven fast in tests and checks;
 * adapters use the defaults. */
export function createReconnectingSocket(url: string, handlers: SocketHandlers, timings: SocketTimings = {}): () => void {
  const pingIntervalMs = timings.pingIntervalMs ?? PING_INTERVAL_MS
  const pongTimeoutMs = timings.pongTimeoutMs ?? PONG_TIMEOUT_MS
  const lifetimeMs = timings.lifetimeMs ?? LIFETIME_MS
  const rotateRetryMs = timings.rotateRetryMs ?? ROTATE_RETRY_MS

  /** The socket in use: the one whose frames are delivered and whose close is a drop. */
  let socket: WebSocket | null = null
  /** A renewal still connecting. The socket above stays in use until this one opens. */
  let pending: WebSocket | null = null
  let attempt = 0
  let failedConnects = 0
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  let rotateTimer: ReturnType<typeof setTimeout> | null = null
  let clearHeartbeat: () => void = () => {}

  function clearLifetime(): void {
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
    lifetimeTimer = null
  }

  /** `renewal`: open a second socket beside the one in use, and take over only once it is open. */
  function connect(renewal = false): void {
    if (stopped) return
    const current = new WebSocket(url)
    if (renewal) pending = current
    else socket = current
    let opened = false

    let pingTimer: ReturnType<typeof setInterval> | null = null
    let pongTimer: ReturnType<typeof setTimeout> | null = null
    // Local, and deliberately not read through the outer `clearHeartbeat` binding: that binding
    // is reassigned by the next socket to open, so a socket closing after a reconnect would
    // otherwise clear the *new* socket's timers and leave its own interval running forever —
    // pinging a dead socket and eventually firing a stray terminate at the live one.
    const stopHeartbeat = (): void => {
      if (pingTimer) clearInterval(pingTimer)
      if (pongTimer) clearTimeout(pongTimer)
      pingTimer = null
      pongTimer = null
    }

    current.on('open', () => {
      opened = true
      attempt = 0
      failedConnects = 0
      const previous = renewal ? socket : null
      socket = current
      pending = null
      clearHeartbeat = stopHeartbeat
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
      handlers.onOpen?.(current, previous !== null)
      if (previous !== null) {
        // The old socket's frames are not wanted twice. Its close is ignored below, since it is no
        // longer the socket in use; its own heartbeat stops with it.
        previous.removeAllListeners('message')
        previous.close()
      }
      // This connection's own lifetime, from its opening.
      clearLifetime()
      lifetimeTimer = setTimeout(() => {
        lifetimeTimer = null
        connect(true)
      }, lifetimeMs)
    })

    current.on('pong', () => {
      if (pongTimer) clearTimeout(pongTimer)
      pongTimer = null
    })

    current.on('message', (raw: Buffer) => handlers.onMessage(raw))

    current.on('error', (error) => handlers.onError?.(error))

    current.on('close', () => {
      stopHeartbeat()
      if (stopped) return
      if (socket !== current) {
        // An old socket closed by its renewal, or a renewal that never opened. The socket in use
        // stays; a renewal that failed is tried again later, while the host answers at all.
        if (renewal && !opened) {
          pending = null
          rotateTimer = setTimeout(() => {
            rotateTimer = null
            connect(true)
          }, rotateRetryMs)
        }
        return
      }
      // The socket in use is gone: its lifetime with it, and the next to open starts its own.
      clearLifetime()
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
      reconnectTimer = setTimeout(() => connect(), delay)
    })
  }

  connect()

  return () => {
    stopped = true
    clearHeartbeat()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    clearLifetime()
    if (rotateTimer) clearTimeout(rotateTimer)
    rotateTimer = null
    for (const current of [socket, pending]) {
      if (current === null) continue
      // close() on a still-connecting socket emits an async 'error' internally
      // (WebSocket was closed before the connection was established); swallow it
      // since we just removed all real listeners and this is an expected no-op close.
      current.removeAllListeners()
      current.on('error', () => {})
      current.close()
    }
    socket = null
    pending = null
  }
}
