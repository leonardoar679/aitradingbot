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

/** A server whose own sockets and listener never throw: a client the app terminates resets the
 * connection under it (ECONNRESET on Windows), and an 'error' with no listener would take the test
 * worker down with it -- seen on 13 October 2026 as "Worker exited unexpectedly" under a heavy run. */
function quiet(server: WebSocketServer): WebSocketServer {
  server.on('error', () => undefined)
  server.on('connection', (ws: WsSocket) => ws.on('error', () => undefined))
  return server
}

async function startServer(options: { autoPong?: boolean } = {}): Promise<{ server: WebSocketServer; url: string }> {
  const server = quiet(new WebSocketServer({ port: 0, autoPong: options.autoPong ?? true }))
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

  // Unsubscribe is guarded twice over: `stopped` short-circuits connect(), and the pending
  // backoff timer is cleared. Either alone is sufficient, so a mutation run will report each as
  // surviving — they are equivalent mutants, not a coverage gap. Verified by removing them one
  // at a time (both pass) and then together (this test fails). Leave both in: they are cheap,
  // and a future async path into connect() would need the flag.
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

  it(
    'says each connect that failed, counting them in a row, and counts again from one after an open',
    async () => {
      // A port with nothing listening: a server is started for its number and closed again.
      const { server, url } = await startServer()
      const port = (server.address() as { port: number }).port
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const failed: number[] = []
      track(createReconnectingSocket(url, { onMessage: () => {}, onConnectFailed: (consecutive) => failed.push(consecutive) }))

      // 1, 2, 3: a dead host, which a caller can tell from a dropped link by the count.
      expect(await waitFor(() => failed.length >= 3, 9000)).toBe(true)
      expect(failed.slice(0, 3)).toEqual([1, 2, 3])

      // The host comes back: the socket opens, and the count is forgotten with it. It is then
      // dropped and the host is gone again, and the next failed connect is the first of a new run.
      const again = quiet(new WebSocketServer({ port }))
      servers.push(again)
      await new Promise<void>((resolve) => again.once('listening', resolve))
      let opened = 0
      again.on('connection', (ws: WsSocket) => {
        opened += 1
        ws.close()
        again.close()
      })
      expect(await waitFor(() => opened >= 1, 20000)).toBe(true)
      const seen = failed.length
      expect(await waitFor(() => failed.length > seen, 9000)).toBe(true)
      expect(failed[seen]).toBe(1)
    },
    40_000
  )
})

// BINANCE CLOSES A STREAM AFTER 24 HOURS. Left to that, the cut is a drop with a backoff behind it.
// A connection is renewed before then: a second socket is opened beside the first, and the first is
// closed only once the second is open.
describe('a connection renewed before its lifetime runs out', () => {
  it('opens the second socket before it closes the first, and counts neither a drop nor a failed connect', async () => {
    const { server, url } = await startServer()
    const connections: WsSocket[] = []
    let firstStateAtSecond: number | null = null
    server.on('connection', (ws: WsSocket) => {
      if (connections.length === 1) firstStateAtSecond = connections[0].readyState
      connections.push(ws)
    })
    const opened: boolean[] = []
    const failed: number[] = []
    track(
      createReconnectingSocket(
        url,
        { onMessage: () => {}, onOpen: (_socket, renewed) => opened.push(renewed), onConnectFailed: (consecutive) => failed.push(consecutive) },
        { lifetimeMs: 300 }
      )
    )

    expect(await waitFor(() => connections.length >= 2, 4000)).toBe(true)
    // At the moment the second connection arrived, the first was still open: nothing is missed
    // between them.
    expect(firstStateAtSecond).toBe(connections[0].OPEN)
    expect(await waitFor(() => connections[0].readyState === connections[0].CLOSED, 4000)).toBe(true)
    expect(opened.slice(0, 2)).toEqual([false, true])
    expect(failed).toEqual([])
    // Each connection has a lifetime of its own: a third follows the second.
    expect(await waitFor(() => connections.length >= 3, 4000)).toBe(true)
  })

  it('keeps the socket in use when the renewal cannot open, and tries again', async () => {
    let handshakes = 0
    // The second handshake is refused; every other is accepted.
    const server = quiet(new WebSocketServer({ port: 0, verifyClient: () => handshakes++ !== 1 }))
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`
    const connections: WsSocket[] = []
    server.on('connection', (ws: WsSocket) => connections.push(ws))
    const opened: boolean[] = []
    const failed: number[] = []
    track(
      createReconnectingSocket(
        url,
        { onMessage: () => {}, onOpen: (_socket, renewed) => opened.push(renewed), onConnectFailed: (consecutive) => failed.push(consecutive), onError: () => {} },
        { lifetimeMs: 300, rotateRetryMs: 200 }
      )
    )

    expect(await waitFor(() => connections.length >= 2, 6000)).toBe(true)
    expect(handshakes).toBeGreaterThanOrEqual(3)
    expect(opened.slice(0, 2)).toEqual([false, true])
    // The refused renewal was not a failed connect of the socket in use, which stayed open until
    // its renewal was.
    expect(failed).toEqual([])
  })
})
