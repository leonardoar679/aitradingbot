import WebSocket from 'ws'

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 15000

interface SocketHandlers {
  onOpen?: (socket: WebSocket) => void
  onMessage: (data: Buffer) => void
  onError?: (error: Error) => void
}

/** Opens a WebSocket that automatically reconnects with exponential backoff if the
 * connection drops, and keeps reconnecting until the returned function is called.
 * Returns an unsubscribe function that stops the socket for good. */
export function createReconnectingSocket(url: string, handlers: SocketHandlers): () => void {
  let socket: WebSocket | null = null
  let attempt = 0
  let stopped = false

  function connect(): void {
    if (stopped) return
    const current = new WebSocket(url)
    socket = current

    current.on('open', () => {
      attempt = 0
      handlers.onOpen?.(current)
    })

    current.on('message', (raw: Buffer) => handlers.onMessage(raw))

    current.on('error', (error) => handlers.onError?.(error))

    current.on('close', () => {
      if (stopped || socket !== current) return
      attempt += 1
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
      setTimeout(connect, delay)
    })
  }

  connect()

  return () => {
    stopped = true
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
