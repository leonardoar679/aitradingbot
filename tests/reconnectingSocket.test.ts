import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { createReconnectingSocket } from '../electron/services/exchanges/reconnectingSocket'

// Every live price in the app arrives through this. Run against a real local ws server rather
// than a mock, because the failure this guards against — a socket that stays OPEN while the peer
// is gone — only exists at the protocol level.

let servers: WebSocketServer[] = []
let stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
  for (const server of servers) server.close()
  servers = []
})

async function startServer(options: { autoPong?: boolean } = {}): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ port: 0, autoPong: options.autoPong ?? true })
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as { port: number }).port
  return { server, url: `ws://127.0.0.1:${port}` }
}

function track(stop: () => void): () => void {
  stops.push(stop)
  return stop
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(25)
  }
  return predicate()
}

describe('createReconnectingSocket', () => {
  it('connects and delivers messages', async () => {
    const { server, url } = await startServer()
    const received: string[] = []
    server.on('connection', (ws: WsSocket) => ws.send('hello'))

    track(createReconnectingSocket(url, { onMessage: (raw) => received.push(raw.toString()) }))

    expect(await waitFor(() => received.length > 0)).toBe(true)
    expect(received[0]).toBe('hello')
  })

  it('reconnects after the server drops the connection', async () => {
    const { server, url } = await startServer()
    let connections = 0
    server.on('connection', (ws: WsSocket) => {
      connections += 1
      if (connections === 1) ws.close()
    })

    const firstAt: number[] = []
    server.on('connection', () => firstAt.push(Date.now()))
    track(createReconnectingSocket(url, { onMessage: () => {} }))

    expect(await waitFor(() => connections >= 2, 4000)).toBe(true)
    // Assert the gap, not just that it happened: the first retry must wait BASE_DELAY_MS (1s).
    // Incrementing the attempt counter before computing the delay made 2s the shortest gap this
    // could ever wait, which a bare "did it reconnect" check cannot see.
    const gap = firstAt[1] - firstAt[0]
    expect(gap).toBeGreaterThan(700)
    expect(gap).toBeLessThan(1600)
  })

  it('reconnects when the peer stops answering pings but leaves the socket open', async () => {
    // autoPong off is the closest reproduction of a half-open connection: the socket stays OPEN
    // and never errors, it simply stops responding. Without the heartbeat, nothing here would
    // ever notice, and the price on screen would sit frozen indefinitely.
    const { server, url } = await startServer({ autoPong: false })
    let connections = 0
    server.on('connection', () => {
      connections += 1
    })

    track(createReconnectingSocket(url, { onMessage: () => {} }, { pingIntervalMs: 150, pongTimeoutMs: 150 }))

    expect(await waitFor(() => connections >= 2, 6000)).toBe(true)
  })

  it('stays connected while the peer answers pings', async () => {
    const { server, url } = await startServer({ autoPong: true })
    let connections = 0
    server.on('connection', () => {
      connections += 1
    })

    track(createReconnectingSocket(url, { onMessage: () => {} }, { pingIntervalMs: 100, pongTimeoutMs: 100 }))

    await waitFor(() => connections >= 1)
    // A healthy but quiet stream must not be torn down. Many pairs go minutes without a trade,
    // so churning them would be worse than the problem the heartbeat solves.
    //
    // Waited 1200ms originally, which was long enough for ~12 ping cycles but landed right on
    // top of the reconnect a broken pong handler would produce (terminate at ~200ms, then a
    // 1000ms backoff). The test passed by luck rather than by being right.
    await wait(2500)
    expect(connections).toBe(1)
  })

  it('stops reconnecting once unsubscribed', async () => {
    const { server, url } = await startServer()
    let connections = 0
    server.on('connection', (ws: WsSocket) => {
      connections += 1
      ws.close()
    })

    const stop = createReconnectingSocket(url, { onMessage: () => {} })
    await waitFor(() => connections >= 1)
    stop()
    const seen = connections

    await wait(1800)
    expect(connections).toBe(seen)
  })
})
