import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { LiveOrder } from '../shared/ipc'
import { USER_STREAM_KEEPALIVE_MS } from '../shared/userStream'

// The account's own stream in the main process (electron/services/liveUserStreamService.ts; the V5
// document, §101), against a real local WebSocket server with the listen key, the credentials, the
// ledgers and the one resolution function faked: when it opens and closes, what a fill frame does
// within a second, what a balances frame does, and what it ignores.

const rig = vi.hoisted(() => ({
  keyStored: true,
  armed: false,
  orders: [] as LiveOrder[],
  positions: [] as { exchange: string }[],
  listenKeys: { created: 0, kept: 0, closed: 0 },
  wsBase: '',
  cache: [] as unknown[],
  resolved: [] as { order: LiveOrder; result: { status: string; filledQty: number; avgFillPrice: number; cummulativeQuoteQty: number; commissions: Record<string, number> }; at: number }[]
}))

vi.mock('../electron/services/credentialsService', () => ({
  listCredentialStatus: async () => [{ exchange: 'binance', configured: rig.keyStored, lastTestOk: true }],
  getDecryptedCredential: async () => ({ apiKey: 'key', apiSecret: 'secret' }),
  updateBalanceCache: (_exchange: string, rows: unknown[]) => void rig.cache.push(rows)
}))
vi.mock('../electron/services/exchanges/binanceUserStream', () => ({
  createListenKey: async () => {
    rig.listenKeys.created += 1
    return `lk${rig.listenKeys.created}`
  },
  keepAliveListenKey: async () => void (rig.listenKeys.kept += 1),
  closeListenKey: async () => void (rig.listenKeys.closed += 1),
  userStreamAddress: async (key: string) => `${rig.wsBase}/ws/${key}`
}))
vi.mock('../electron/services/liveExecutionService', () => ({
  resolveOrderFromExchange: async (order: LiveOrder, result: (typeof rig.resolved)[number]['result']) => {
    rig.resolved.push({ order, result, at: Date.now() })
    return result.status === 'FILLED' ? { executorId: order.executorId, liveOrderId: order.id, liveOrder: { ...result, orderId: order.orderId, placedAt: order.placedAt }, status: 'filled' } : null
  }
}))
vi.mock('../electron/services/liveOrdersService', () => ({ listOpenLiveOrders: async () => rig.orders }))
vi.mock('../electron/services/livePositionsService', () => ({ listOpenLivePositions: async () => rig.positions }))
vi.mock('../electron/services/liveTradingService', () => ({ getLiveTradingStatus: async () => ({ sessionArmed: rig.armed }) }))

import { drainStreamResolutions, getUserStreamState, handleUserStreamFrame, lookAtUserStream, resetLiveUserStream } from '../electron/services/liveUserStreamService'

const ORDER: LiveOrder = {
  id: 'lo1',
  executorId: 'ex1',
  exchange: 'binance',
  symbol: 'ETHUSDT',
  baseAsset: 'ETH',
  quoteAsset: 'USDT',
  side: 'buy',
  orderId: 77,
  limitPrice: 4000,
  quantity: 1,
  status: 'open',
  filledQty: 0,
  avgFillPrice: null,
  placedAt: 1_791_500_000,
  resolvedAt: null
}

let servers: WebSocketServer[] = []
const sockets: WsSocket[] = []
const paths: string[] = []

async function startServer(): Promise<string> {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  server.on('connection', (socket: WsSocket, request) => {
    sockets.push(socket)
    paths.push(request.url ?? '')
  })
  const port = (server.address() as { port: number }).port
  return `ws://127.0.0.1:${port}`
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(20)
  }
  return predicate()
}

const report = (status: string, z: string, Z: string, commission: { n: string; N: string } | null = null): string =>
  JSON.stringify({ e: 'executionReport', E: 1_791_500_100_000, s: 'ETHUSDT', i: 77, S: 'BUY', X: status, z, Z, L: '4000', l: '0.5', n: commission?.n ?? '0', N: commission?.N ?? null })

beforeEach(async () => {
  await resetLiveUserStream()
  rig.keyStored = true
  rig.armed = false
  rig.orders = []
  rig.positions = []
  rig.listenKeys = { created: 0, kept: 0, closed: 0 }
  rig.cache = []
  rig.resolved = []
  sockets.length = 0
  paths.length = 0
  rig.wsBase = await startServer()
})

afterEach(async () => {
  vi.useRealTimers()
  await resetLiveUserStream()
  for (const server of servers) server.close()
  servers = []
})

describe('when the stream is open', () => {
  it('stays closed with nothing to hear, and opens with a listen key once the session is armed', async () => {
    expect((await lookAtUserStream()).wanted).toBe(false)
    expect(rig.listenKeys.created).toBe(0)
    expect(paths).toEqual([])

    rig.armed = true
    await lookAtUserStream()
    expect(await waitFor(() => getUserStreamState().open)).toBe(true)
    expect(rig.listenKeys.created).toBe(1)
    expect(paths).toEqual(['/ws/lk1'])
    expect(getUserStreamState()).toMatchObject({ wanted: true, open: true, connects: 1, drops: 0, error: null })
  })

  it('does not open without a key, armed or not, and does open for an order of the app\'s own while disarmed', async () => {
    rig.keyStored = false
    rig.armed = true
    expect((await lookAtUserStream()).wanted).toBe(false)
    rig.keyStored = true
    rig.armed = false
    rig.orders = [ORDER]
    expect((await lookAtUserStream()).wanted).toBe(true)
    expect(await waitFor(() => getUserStreamState().open)).toBe(true)
  })

  it('opens nothing more at a look while the stream is open', async () => {
    rig.armed = true
    await lookAtUserStream()
    expect(await waitFor(() => getUserStreamState().open)).toBe(true)
    await lookAtUserStream()
    await lookAtUserStream()
    await wait(100)
    expect(rig.listenKeys.created).toBe(1)
    expect(paths).toEqual(['/ws/lk1'])
    expect(getUserStreamState()).toMatchObject({ open: true, connects: 1 })
  })

  it('keeps the key alive every thirty minutes, and closes the key with the stream when nothing is left to hear', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    rig.armed = true
    await lookAtUserStream()
    expect(await waitFor(() => getUserStreamState().open)).toBe(true)
    await vi.advanceTimersByTimeAsync(USER_STREAM_KEEPALIVE_MS - 1)
    expect(rig.listenKeys.kept).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(rig.listenKeys.kept).toBe(1)
    expect(getUserStreamState().keepAlives).toBe(1)

    rig.armed = false
    await lookAtUserStream()
    expect(getUserStreamState()).toMatchObject({ wanted: false, open: false })
    expect(rig.listenKeys.closed).toBe(1)
    expect(await waitFor(() => sockets[0].readyState === sockets[0].CLOSED)).toBe(true)
  })
})

describe('what a frame does', () => {
  it('reads a fill into the ledgers within a second, with the commissions of every report added up, and hands the resolution to the poll once', async () => {
    rig.orders = [ORDER]
    await lookAtUserStream()
    expect(await waitFor(() => getUserStreamState().open && sockets.length === 1)).toBe(true)

    sockets[0].send(report('PARTIALLY_FILLED', '0.5', '2000', { n: '0.0005', N: 'ETH' }))
    expect(await waitFor(() => rig.resolved.length === 1)).toBe(true)
    expect(rig.resolved[0].result).toEqual({ orderId: 77, status: 'PARTIALLY_FILLED', filledQty: 0.5, avgFillPrice: 4000, cummulativeQuoteQty: 2000, commissions: { ETH: 0.0005 } })
    expect(drainStreamResolutions()).toEqual([])

    const sentAt = Date.now()
    sockets[0].send(report('FILLED', '1', '4000', { n: '0.0005', N: 'ETH' }))
    expect(await waitFor(() => rig.resolved.length === 2)).toBe(true)
    expect(rig.resolved[1].at - sentAt).toBeLessThan(1000)
    expect(rig.resolved[1].order).toBe(ORDER)
    expect(rig.resolved[1].result).toEqual({ orderId: 77, status: 'FILLED', filledQty: 1, avgFillPrice: 4000, cummulativeQuoteQty: 4000, commissions: { ETH: 0.001 } })
    const handed = drainStreamResolutions()
    expect(handed).toHaveLength(1)
    expect(handed[0]).toMatchObject({ executorId: 'ex1', liveOrderId: 'lo1', status: 'filled' })
    expect(drainStreamResolutions()).toEqual([])
    expect(getUserStreamState()).toMatchObject({ orders: 2, balances: 0 })
    expect(getUserStreamState().lastFrameAt).not.toBeNull()
  })

  it('refreshes the balance cache from a balances frame', async () => {
    rig.armed = true
    await lookAtUserStream()
    expect(await waitFor(() => getUserStreamState().open && sockets.length === 1)).toBe(true)
    sockets[0].send(JSON.stringify({ e: 'outboundAccountPosition', E: 1_791_500_100_000, B: [{ a: 'ETH', f: '1.5', l: '0.5' }, { a: 'USDT', f: '100', l: '0' }] }))
    expect(await waitFor(() => rig.cache.length === 1)).toBe(true)
    expect(rig.cache[0]).toEqual([
      { asset: 'ETH', free: 1.5, locked: 0.5 },
      { asset: 'USDT', free: 100, locked: 0 }
    ])
    expect(getUserStreamState()).toMatchObject({ orders: 0, balances: 1 })
  })

  it('ignores a report for an order the ledger does not know, and a frame that is not one', async () => {
    rig.orders = []
    await handleUserStreamFrame(report('FILLED', '1', '4000'))
    expect(rig.resolved).toEqual([])
    expect(getUserStreamState().orders).toBe(1)
    await handleUserStreamFrame('not json')
    await handleUserStreamFrame(JSON.stringify({ e: 'listenKeyExpired', E: 1_791_500_100_000 }))
    expect(getUserStreamState()).toMatchObject({ orders: 1, balances: 0 })
    expect(rig.cache).toEqual([])
  })
})
